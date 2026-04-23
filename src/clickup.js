'use strict';
const { CLICKUP_BASE, CF, BILLING_TO_IDX, PIPELINE_STATUSES } = require('./config');
const { parseTask, parsePipelineTask } = require('./helpers');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function cuFetch(url) {
  const token   = process.env.CLICKUP_API_TOKEN;
  const retries = 2;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const r    = await fetch(url, { headers: { Authorization: token } });
      const body = await r.text();
      if (r.status !== 200) {
        console.log(`ClickUp ${r.status}: ${body.substring(0, 300)}`);
        return {};
      }
      return JSON.parse(body);
    } catch (e) {
      console.log(`cuFetch error (attempt ${attempt}/${retries}): ${e} | ${url}`);
      if (attempt < retries) await sleep(1500);
    }
  }
  return {};
}

async function fetchMonthlyTemplates(teamId, billingListId, budget) {
  const idx     = BILLING_TO_IDX['Monthly'];
  const filters = [{ field_id: CF.BILLING, operator: '=', value: String(idx) }];
  if (budget === 'Retail') filters.push({ field_id: CF.RETAINER_BUDGET, operator: '=', value: '0' });
  if (budget === 'Trade')  filters.push({ field_id: CF.RETAINER_BUDGET, operator: '=', value: '1' });

  const data = await cuFetch(CLICKUP_BASE + '/team/' + teamId + '/task?'
    + 'custom_fields=' + encodeURIComponent(JSON.stringify(filters))
    + '&list_ids[]=' + billingListId
    + '&include_closed=true&subtasks=false');
  return (data.tasks || []).map(parseTask);
}

async function buildPaygDiscoveryCache(teamId, spaceId) {
  if (!spaceId) return { byMonth: {} };

  const seen = {}, rawCandidates = [];

  const paygData = await cuFetch(CLICKUP_BASE + '/team/' + teamId + '/task?'
    + 'tags[]=payg+hours+used&space_ids[]=' + spaceId
    + '&include_closed=true&subtasks=true');
  (paygData.tasks || []).forEach(t => {
    if (!seen[t.id]) { seen[t.id] = true; rawCandidates.push(t); }
  });

  const discData = await cuFetch(CLICKUP_BASE + '/team/' + teamId + '/task?'
    + 'tags[]=discovery&space_ids[]=' + spaceId
    + '&include_closed=true&subtasks=true');
  (discData.tasks || []).forEach(t => {
    if (!seen[t.id]) { seen[t.id] = true; rawCandidates.push(t); }
  });

  console.log(`PAYG+Discovery candidates for space ${spaceId}: ${rawCandidates.length}`);

  const withCF = rawCandidates.filter(t => {
    const cfMap = {};
    (t.custom_fields || []).forEach(f => { cfMap[f.id] = f; });
    return cfMap[CF.BILLING] && cfMap[CF.BILLING].value != null;
  }).length;
  console.log(`  Bulk CF coverage: ${withCF}/${rawCandidates.length} have billing month CF`);

  const byMonth = {};
  const needsFetch = [];

  rawCandidates.forEach(t => {
    const cfMap = {};
    (t.custom_fields || []).forEach(f => { cfMap[f.id] = f; });
    const billingFieldPresent = cfMap[CF.BILLING] !== undefined;
    const parsed = parseTask(t);
    if (parsed.billingMonth) {
      if (!byMonth[parsed.billingMonth]) byMonth[parsed.billingMonth] = [];
      byMonth[parsed.billingMonth].push(parsed);
    } else if (!billingFieldPresent) {
      needsFetch.push(t);
    }
  });

  if (needsFetch.length) {
    console.log(`  Fetching ${needsFetch.length} tasks individually (CF missing from bulk)`);
    for (const t of needsFetch) {
      try {
        const full   = await cuFetch(CLICKUP_BASE + '/task/' + t.id);
        const parsed = parseTask(full.id ? full : t);
        if (!parsed.billingMonth) continue;
        if (!byMonth[parsed.billingMonth]) byMonth[parsed.billingMonth] = [];
        byMonth[parsed.billingMonth].push(parsed);
      } catch (e) { console.log(`Failed candidate ${t.id}: ${e}`); }
      await sleep(100);
    }
  } else {
    console.log('  Full CF coverage — no individual fetches needed');
  }

  return { byMonth };
}

function fetchPaygSubtasks(billingMonthName, budget, paygCache) {
  if (!paygCache) return [];
  return (paygCache.byMonth[billingMonthName] || []).filter(parsed => {
    if (budget === 'Retail' && parsed.budget !== 'Retail') return false;
    if (budget === 'Trade'  && parsed.budget !== 'Trade')  return false;
    return true;
  });
}

async function fetchBillingSubtasks(teamId, billingMonthName, budget, cfRawTasks) {
  const results = [];
  const retainerTags = ['retainer hours','retainer am hours','retainer carried hours',
                        'retainer recurring','additional support hours'];

  const candidates = cfRawTasks.filter(t => {
    if (t.parent) return false;
    const tagNames = (t.tags || []).map(tg => tg.name);
    if (tagNames.some(n => retainerTags.includes(n))) return false;
    const cfMap = {};
    (t.custom_fields || []).forEach(f => { cfMap[f.id] = f; });
    return (cfMap[CF.QUOTE_HOURS] && cfMap[CF.QUOTE_HOURS].value != null)
        || (cfMap[CF.BALANCE]     && cfMap[CF.BALANCE].value != null);
  });

  if (!candidates.length) return results;
  console.log(`Checking ${candidates.length} project tasks for billing subtasks`);

  const replacedParentIds = {};
  for (const parent of candidates) {
    try {
      const data     = await cuFetch(CLICKUP_BASE + '/team/' + teamId + '/task?parent=' + parent.id
        + '&include_closed=true&subtasks=true');
      const subtasks = data.tasks || [];
      if (!subtasks.length) continue;
      console.log(`  Parent "${parent.name}" has ${subtasks.length} subtasks`);
      let foundOne = false;
      for (const st of subtasks) {
        try {
          let parsed;
          try {
            const full = await cuFetch(CLICKUP_BASE + '/task/' + st.id);
            parsed = parseTask(full.id ? full : st);
          } catch {
            console.log(`    Direct fetch failed for ${st.id}, using list data`);
            parsed = parseTask(st);
          }
          if (parsed.billingMonth !== billingMonthName) continue;
          if (budget === 'Retail' && parsed.budget !== 'Retail') continue;
          if (budget === 'Trade'  && parsed.budget !== 'Trade')  continue;
          if (parsed.tag === 'discovery' || parsed.tag === 'payg hours used') {
            console.log(`    ⚠ Skipping discovery/payg subtask: ${parsed.name}`);
            continue;
          }
          console.log(`    ✓ Billing subtask: ${parsed.name} | hrs:${parsed.quoteHours} | bal:${parsed.retainerBalance}`);
          results.push(parsed);
          foundOne = true;
        } catch (e) { console.log(`    Failed subtask ${st.id}: ${e}`); }
        await sleep(100);
      }
      if (foundOne) replacedParentIds[parent.id] = true;
    } catch (e) { console.log(`  Failed parent ${parent.id}: ${e}`); }
    await sleep(100);
  }

  results._replacedParentIds = replacedParentIds;
  return results;
}

async function fetchTasksForMonth(teamId, billingMonthName, budget, spaceId, paygCache) {
  const idx = BILLING_TO_IDX[billingMonthName];
  if (idx === undefined) return [];

  const filters = [{ field_id: CF.BILLING, operator: '=', value: String(idx) }];
  if (budget === 'Retail') filters.push({ field_id: CF.RETAINER_BUDGET, operator: '=', value: '0' });
  if (budget === 'Trade')  filters.push({ field_id: CF.RETAINER_BUDGET, operator: '=', value: '1' });

  const data = await cuFetch(CLICKUP_BASE + '/team/' + teamId + '/task?'
    + 'custom_fields=' + encodeURIComponent(JSON.stringify(filters))
    + (spaceId ? '&space_ids[]=' + spaceId : '')
    + '&include_closed=true&subtasks=true');

  // Exclude Billing Type = Project (value 1)
  const rawTasks = (data.tasks || []).filter(t => {
    const cfMap = {};
    (t.custom_fields || []).forEach(f => { cfMap[f.id] = f; });
    const bt = cfMap[CF.BILLING_TYPE];
    return !(bt && bt.value != null && Number(bt.value) === 1);
  });

  const billingSubtasks = await fetchBillingSubtasks(teamId, billingMonthName, budget, rawTasks);
  const replacedParents = billingSubtasks._replacedParentIds || {};

  const tasks = rawTasks.filter(t => !replacedParents[t.id]).map(parseTask);
  const seen  = {};
  tasks.forEach(t => { seen[t.id] = true; });
  billingSubtasks.forEach(t => { if (!seen[t.id]) { seen[t.id] = true; tasks.push(t); } });

  const livePaygCache = paygCache || await buildPaygDiscoveryCache(teamId, spaceId);
  fetchPaygSubtasks(billingMonthName, budget, livePaygCache)
    .forEach(t => { if (!seen[t.id]) { seen[t.id] = true; tasks.push(t); } });

  return tasks;
}

async function fetchPipelineTasks(teamId, listId) {
  if (!listId) return [];
  const statusQs = PIPELINE_STATUSES.map(s => 'statuses[]=' + encodeURIComponent(s)).join('&');
  const data = await cuFetch(CLICKUP_BASE + '/team/' + teamId + '/task?list_ids[]=' + listId
    + '&' + statusQs + '&subtasks=false&page=0');
  return (data.tasks || []).map(parsePipelineTask);
}

module.exports = { cuFetch, fetchMonthlyTemplates, buildPaygDiscoveryCache, fetchPaygSubtasks, fetchBillingSubtasks, fetchTasksForMonth, fetchPipelineTasks };
