'use strict';
// Orchestration + Firestore store for the weekly Client Updates report.
//
// For each client it pulls the early-stage ("scoping") tasks from ClickUp with
// full detail, enriches them with comments and (where present) live Jira status,
// asks the LLM for a client-safe blurb per task, and stores a draft report.
//
// Firestore: collection "scoping-reports", one doc per client index:
//   { clientIndex, generatedAt, status:'draft'|'sent', sentAt,
//     tasks:[{ id, name, url, status, statusAgeDays, jiraStatus, sprint,
//              quoteHours, blurb, internalNote, needsAttention, edited }] }
const { db } = require('./firestore');
const { CLIENTS, CF, CLICKUP_BASE } = require('./config');
const { cuFetch, fetchScopingTasksDetailed, fetchTaskComments } = require('./clickup');
const { fetchJiraIssue, fetchJiraComments } = require('./jira');
const { generateBlurb } = require('./blurbs');

const INTERNAL_DOMAIN = 'tomandco.co.uk';

function teamId() {
  const v = process.env.CLICKUP_TEAM_ID;
  if (!v) throw new Error('Missing env: CLICKUP_TEAM_ID');
  return v;
}

// ── Field extraction from a raw ClickUp task ──────────────────────────────────
function cfVal(raw, id) {
  const f = (raw.custom_fields || []).find(x => x.id === id);
  return f && f.value != null ? f.value : null;
}

function cfDropdownName(raw, id) {
  const f = (raw.custom_fields || []).find(x => x.id === id);
  if (!f || f.value == null) return null;
  const opts = (f.type_config && f.type_config.options) || [];
  const opt = opts.find(o => Number(o.orderindex) === Number(f.value) || o.id === f.value);
  return opt ? opt.name : null;
}

function statusAgeDays(raw) {
  const updated = raw.date_updated ? parseInt(raw.date_updated, 10) : null;
  if (!updated) return null;
  return Math.max(0, Math.round((Date.now() - updated) / 86400000));
}

function baseFields(raw) {
  const quote = cfVal(raw, CF.QUOTE_HOURS);
  const disc  = cfVal(raw, CF.DISCOVERY_HOURS);
  return {
    id:             raw.id,
    name:           raw.name || '',
    url:            raw.url || '',
    status:         raw.status ? (raw.status.status || '').toLowerCase() : '',
    statusAgeDays:  statusAgeDays(raw),
    jiraId:         cfVal(raw, CF.JIRA_ID),
    jiraStatus:     cfVal(raw, CF.JIRA_STATUS),
    sprint:         cfDropdownName(raw, CF.JIRA_SPRINT),
    quoteHours:     quote != null ? Number(quote) : null,
    discoveryHours: disc  != null ? Number(disc)  : null,
  };
}

// Build a full report entry (with blurb) for one raw ClickUp task.
async function buildTaskEntry(raw) {
  const base = baseFields(raw);

  // ClickUp returns comments newest-first; reverse to oldest-first for narrative.
  const rawComments = await fetchTaskComments(raw.id);
  const clickupComments = (rawComments || []).slice().reverse().map(c => ({
    author:     c.user ? c.user.username : null,
    isInternal: !!(c.user && c.user.email && c.user.email.toLowerCase().endsWith(INTERNAL_DOMAIN)),
    text:       c.comment_text || '',
    date:       c.date || null,
  }));

  // Live Jira enrichment (degrades to null/[] if unconfigured or missing).
  let jiraLive = null, jiraComments = [];
  if (base.jiraId) {
    jiraLive     = await fetchJiraIssue(base.jiraId);
    jiraComments = await fetchJiraComments(base.jiraId, 6);
  }

  const description = raw.markdown_description || raw.text_content || raw.description || '';
  const gen = await generateBlurb({
    name:           base.name,
    status:         base.status,
    statusAgeDays:  base.statusAgeDays,
    description,
    clickupComments,
    jiraStatus:     base.jiraStatus,
    sprint:         base.sprint,
    quoteHours:     base.quoteHours,
    discoveryHours: base.discoveryHours,
    jiraLive,
    jiraComments,
  });

  return {
    id:             base.id,
    name:           base.name,
    url:            base.url,
    status:         base.status,
    statusAgeDays:  base.statusAgeDays,
    jiraStatus:     base.jiraStatus,
    sprint:         base.sprint,
    quoteHours:     base.quoteHours,
    blurb:          gen.blurb,
    internalNote:   gen.internalNote,
    needsAttention: gen.needsAttention,
    edited:         false,
  };
}

// ── Build / persist ───────────────────────────────────────────────────────────
async function buildClientReport(clientIndex) {
  const client = CLIENTS[clientIndex];
  if (!client) throw new Error('Unknown client index ' + clientIndex);
  const raws = await fetchScopingTasksDetailed(teamId(), client.retainerTasksListId);
  const tasks = [];
  for (const raw of raws) {
    try {
      tasks.push(await buildTaskEntry(raw));
    } catch (e) {
      console.error('Scoping task build failed', raw && raw.id, e.message);
    }
  }
  return {
    clientIndex,
    generatedAt: new Date().toISOString(),
    status: 'draft',
    sentAt: null,
    tasks,
  };
}

async function getReport(clientIndex) {
  try {
    const doc = await db.collection('scoping-reports').doc(String(clientIndex)).get();
    return doc.exists ? (doc.data() || null) : null;
  } catch (e) {
    console.error('Scoping report read error:', e.message);
    return null;
  }
}

async function saveReport(report) {
  await db.collection('scoping-reports').doc(String(report.clientIndex)).set(report);
  return report;
}

// Build a fresh draft for a client and store it (used by the Generate button + cron).
async function generateReport(clientIndex) {
  const report = await buildClientReport(clientIndex);
  return saveReport(report);
}

// Save a PM-edited blurb for a single task without rebuilding the report.
async function saveBlurb(clientIndex, taskId, blurb) {
  const report = await getReport(clientIndex);
  if (!report) throw new Error('No report to edit — generate a draft first.');
  const t = (report.tasks || []).find(x => x.id === taskId);
  if (!t) throw new Error('Task not found in report.');
  t.blurb = blurb;
  t.edited = true;
  return saveReport(report);
}

// Re-roll a single task's blurb from fresh ClickUp/Jira data.
async function regenerateBlurb(clientIndex, taskId) {
  const report = await getReport(clientIndex) || { clientIndex, generatedAt: new Date().toISOString(), status: 'draft', sentAt: null, tasks: [] };
  const full = await cuFetch(CLICKUP_BASE + '/task/' + taskId + '?include_markdown_description=true');
  if (!full || !full.id) throw new Error('Could not fetch task ' + taskId);
  const entry = await buildTaskEntry(full);
  let found = false;
  report.tasks = (report.tasks || []).map(t => { if (t.id === taskId) { found = true; return entry; } return t; });
  if (!found) report.tasks.push(entry);
  return saveReport(report);
}

async function markSent(clientIndex) {
  const report = await getReport(clientIndex);
  if (!report) throw new Error('No report to send.');
  report.status = 'sent';
  report.sentAt = new Date().toISOString();
  return saveReport(report);
}

module.exports = { buildClientReport, generateReport, getReport, saveReport, saveBlurb, regenerateBlurb, markSent };
