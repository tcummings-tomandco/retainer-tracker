'use strict';
// Live Jira enrichment for the weekly Client Updates report.
//
// Server-side only — uses a dedicated API token (the interactive MCP/Atlassian
// connection is NOT available to the Cloud Run process). Every function degrades
// gracefully to null/[] so report generation still works ClickUp-only when Jira
// is unconfigured, down, or the issue is missing.
//
// Env: JIRA_EMAIL, JIRA_API_TOKEN, JIRA_CLOUD_ID (defaults to tomandco's site).

const DEFAULT_CLOUD_ID = '99a3615c-8f97-484e-a963-15d735307700'; // tomandco.atlassian.net

function jiraConfigured() {
  return !!(process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN);
}

function authHeader() {
  const token = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
  return 'Basic ' + token;
}

function cloudId() {
  return process.env.JIRA_CLOUD_ID || DEFAULT_CLOUD_ID;
}

async function jiraFetch(path) {
  if (!jiraConfigured()) return null;
  const url = `https://api.atlassian.com/ex/jira/${cloudId()}/rest/api/3${path}`;
  try {
    const r = await fetch(url, { headers: { Authorization: authHeader(), Accept: 'application/json' } });
    if (r.status !== 200) {
      console.log(`Jira ${r.status} for ${path}: ${(await r.text()).substring(0, 200)}`);
      return null;
    }
    return await r.json();
  } catch (e) {
    console.log(`Jira fetch error for ${path}: ${e}`);
    return null;
  }
}

// Flatten Atlassian Document Format (ADF) to plain text.
function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adfToText).join('');
  let out = '';
  if (node.type === 'text' && node.text) out += node.text;
  if (node.content) out += adfToText(node.content);
  if (node.type === 'paragraph' || node.type === 'heading') out += '\n';
  return out;
}

async function fetchJiraIssue(issueKey) {
  if (!issueKey) return null;
  const data = await jiraFetch(`/issue/${encodeURIComponent(issueKey)}?fields=status,assignee,updated,summary`);
  if (!data || !data.fields) return null;
  const f = data.fields;
  return {
    key:            data.key,
    status:         f.status ? f.status.name : null,
    statusCategory: f.status && f.status.statusCategory ? f.status.statusCategory.name : null, // To Do / In Progress / Done
    assignee:       f.assignee ? f.assignee.displayName : null,
    updated:        f.updated || null,
    summary:        f.summary || null,
  };
}

async function fetchJiraComments(issueKey, limit = 10) {
  if (!issueKey) return [];
  const data = await jiraFetch(`/issue/${encodeURIComponent(issueKey)}/comment?orderBy=-created&maxResults=${limit}`);
  if (!data || !Array.isArray(data.comments)) return [];
  return data.comments.map(c => ({
    author:  c.author ? c.author.displayName : null,
    created: c.created || null,
    text:    adfToText(c.body).trim(),
  })).filter(c => c.text);
}

module.exports = { jiraConfigured, fetchJiraIssue, fetchJiraComments };
