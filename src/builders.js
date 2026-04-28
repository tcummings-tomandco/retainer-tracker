'use strict';
const { ALL_MONTHS, CLIENTS } = require('./config');
const { effectiveHours, currentBillingMonth, reapplyDateFlags, applyProjectionsToYear } = require('./helpers');
const { fetchMonthlyTemplates, buildPaygDiscoveryCache, fetchTasksForMonth, fetchPipelineTasks } = require('./clickup');
const { getCache, setCache, deleteCache } = require('./cache');
const { getProjections } = require('./projections');

function teamId() {
  const v = process.env.CLICKUP_TEAM_ID;
  if (!v) throw new Error('Missing env: CLICKUP_TEAM_ID');
  return v;
}

// ── Core builders (no caching) ────────────────────────────────

async function buildYearView(clientIndex, budget, yearStart, externalPaygCache) {
  const client   = CLIENTS[parseInt(clientIndex, 10)];
  const tid      = teamId();
  const today    = currentBillingMonth();
  const todayIdx = ALL_MONTHS.indexOf(today);
  const startIdx = ALL_MONTHS.indexOf(yearStart || 'Jan 26');
  const endIdx   = Math.min(startIdx + 12, ALL_MONTHS.length);

  const templates     = await fetchMonthlyTemplates(tid, client.billingListId, budget);
  const creditTask    = templates.find(t => t.tag === 'retainer hours');
  const monthlyCredit = creditTask ? Math.abs(creditTask.retainerBalance || 150) : 150;
  const recurringCost = templates
    .filter(t => t.tag !== 'retainer hours' && t.tag !== 'retainer carried hours')
    .reduce((s, t) => s + effectiveHours(t), 0);

  const paygCache = externalPaygCache || await buildPaygDiscoveryCache(tid, client.spaceId);

  let runningBalance = 0;
  const months = [];
  const monthTasksMap = {};

  for (let i = startIdx; i < endIdx; i++) {
    const month     = ALL_MONTHS[i];
    const isFuture  = i > todayIdx;
    const isCurrent = i === todayIdx;
    let closingBalance, hoursOut = 0, taskCount = 0;

    let carriedIn = 0;
    if (!isFuture) {
      const tasks = await fetchTasksForMonth(tid, month, budget, client.spaceId, paygCache);
      monthTasksMap[month] = tasks;
      taskCount = tasks.length;
      hoursOut  = tasks.reduce((s, t) => s + effectiveHours(t), 0);
      const carriedTask = tasks.find(t => t.tag === 'retainer carried hours');
      carriedIn   = carriedTask ? (carriedTask.retainerBalance || 0) : 0;
      const credit      = tasks.reduce((s, t) =>
        s + (t.tag === 'retainer hours' && t.retainerBalance ? t.retainerBalance : 0), 0);
      closingBalance = carriedIn + credit - hoursOut;
    } else {
      const planned     = await fetchTasksForMonth(tid, month, budget, client.spaceId, paygCache);
      taskCount         = planned.length;
      const plannedCost = planned.reduce((s, t) => s + effectiveHours(t), 0);
      hoursOut          = recurringCost + plannedCost;
      carriedIn         = runningBalance;
      closingBalance    = runningBalance + monthlyCredit - hoursOut;
    }

    runningBalance = closingBalance;
    months.push({
      month, isFuture, isCurrent,
      closingBalance: Math.round(closingBalance * 10) / 10,
      hoursIn:        monthlyCredit,
      hoursOut,
      carriedIn:      Math.round(carriedIn * 10) / 10,
      taskCount,
      projectedHours: 0,
    });
  }

  return {
    ok:             true,
    months,
    monthTasksMap,
    monthlyCredit,
    recurringCost,
    openingBalance: months.length ? months[0].closingBalance : 0,
    budget,
    templates:      templates.map(t => ({ name: t.name, tag: t.tag, quoteHours: t.quoteHours })),
  };
}

// externalPipelineTasks — pass the already-fetched pipeline task array to avoid an
// extra ClickUp call. If omitted the function fetches and caches pipeline data itself.
async function buildMonthData(clientIndex, budget, month, paygCache, precomputedTasks, externalProjections, externalPipelineTasks) {
  const client   = CLIENTS[parseInt(clientIndex, 10)];
  const tid      = teamId();
  const today    = currentBillingMonth();
  const isFuture = ALL_MONTHS.indexOf(month) > ALL_MONTHS.indexOf(today);
  let tasks = [];

  if (!isFuture) {
    tasks = precomputedTasks || await fetchTasksForMonth(tid, month, budget, client.spaceId, paygCache || null);
  } else {
    const templates = await fetchMonthlyTemplates(tid, client.billingListId, budget);
    const planned   = await fetchTasksForMonth(tid, month, budget, client.spaceId, paygCache || null);
    const seen      = {};
    planned.forEach(t => { seen[t.id] = true; });
    tasks = planned.concat(
      templates.filter(t => !seen[t.id]).map(t => Object.assign({}, t, { isForecast: true }))
    );

    // Confirmed pipeline tasks for this month (quoteHours confirmed + dueMonth matches)
    // These supersede any matching manual projection for the same task ID.
    let pipelineTasks = externalPipelineTasks;
    if (!pipelineTasks) {
      const pd = await getPipelineData(clientIndex); // uses cache
      pipelineTasks = pd.tasks || [];
    }
    const confirmedForMonth = pipelineTasks.filter(t => t.dueMonth === month && t.quoteHours != null);
    const confirmedIds = new Set(confirmedForMonth.map(t => t.id));
    confirmedForMonth.forEach(t => {
      if (!seen[t.id]) {
        tasks.push({
          id: t.id, name: t.name, url: t.url || null, parentId: null,
          status: t.status || '', tag: 'confirmed pipeline', labels: [],
          billingMonth: month, budget: null,
          quoteHours: t.quoteHours, retainerBalance: null,
          listName: 'Roadmap', isConfirmedPipeline: true,
        });
        seen[t.id] = true;
      }
    });

    // Manual projections — skip tasks that now have a confirmed pipeline quote
    const projData = externalProjections || await getProjections(clientIndex);
    for (const pid in projData) {
      const p = projData[pid];
      if (p.targetMonth === month && !confirmedIds.has(pid)) {
        tasks.push({
          id: pid, name: p.taskName || 'Projected Task', url: null, parentId: null,
          status: 'projected', tag: 'projected', labels: [],
          billingMonth: month, budget: null,
          quoteHours: p.projectedHours, retainerBalance: null,
          listName: 'Roadmap', isProjected: true,
        });
      }
    }
  }
  return { ok: true, month, isFuture, tasks };
}

async function buildPipelineData(clientIndex) {
  const client = CLIENTS[parseInt(clientIndex, 10)];
  const tasks  = await fetchPipelineTasks(teamId(), client.retainerTasksListId);
  const totalQuoted    = tasks.reduce((s, t) => s + (t.quoteHours || 0), 0);
  const scheduledTasks = tasks.filter(t => !!t.dueMonth).length;
  return { ok: true, tasks, totalTasks: tasks.length, scheduledTasks, totalQuoted: Math.round(totalQuoted) };
}

// ── Cached getters (used by API routes) ──────────────────────

async function getYearView(clientIndex, budget, yearStart) {
  const cacheKey = `year_${clientIndex}_${budget || 'all'}_${yearStart || 'Jan 26'}`;

  // Pipeline tasks are needed to overlay confirmed quotes onto future-month balances.
  // getPipelineData uses its own Firestore cache so this is a single fast read.
  const [pipelineResult, proj] = await Promise.all([
    getPipelineData(clientIndex),
    getProjections(clientIndex),
  ]);
  const pipelineTasks = (pipelineResult && pipelineResult.tasks) || [];

  const cached = await getCache(cacheKey);
  if (cached) {
    let out = reapplyDateFlags(cached);
    out = applyProjectionsToYear(out, proj, pipelineTasks);
    out.fromCache = true;
    return out;
  }
  const result = await buildYearView(clientIndex, budget, yearStart);
  result.cachedAt = new Date().toISOString();
  const toCache = Object.assign({}, result);
  delete toCache.monthTasksMap;
  await setCache(cacheKey, toCache);
  return applyProjectionsToYear(result, proj, pipelineTasks);
}

async function getMonthData(clientIndex, budget, month) {
  const cacheKey = `month_${clientIndex}_${budget || 'all'}_${month}`;
  const cached   = await getCache(cacheKey);
  if (cached) { cached.fromCache = true; return cached; }
  // Pass pipeline tasks so confirmed quotes appear in future-month drilldowns
  const pipelineResult = await getPipelineData(clientIndex);
  const pipelineTasks  = (pipelineResult && pipelineResult.tasks) || [];
  const result = await buildMonthData(clientIndex, budget, month, null, null, null, pipelineTasks);
  result.cachedAt = new Date().toISOString();
  await setCache(cacheKey, result);
  return result;
}

async function getPipelineData(clientIndex) {
  const cacheKey = `pipeline_${clientIndex}`;
  const cached   = await getCache(cacheKey);
  if (cached) { cached.fromCache = true; return cached; }
  const result = await buildPipelineData(clientIndex);
  result.cachedAt = new Date().toISOString();
  await setCache(cacheKey, result);
  return result;
}

async function forceRefreshYearView(clientIndex, budget, yearStart) {
  const cacheKey = `year_${clientIndex}_${budget || 'all'}_${yearStart || 'Jan 26'}`;
  await deleteCache(cacheKey);
  const result = await buildYearView(clientIndex, budget, yearStart);
  result.cachedAt = new Date().toISOString();
  const toCache = Object.assign({}, result);
  delete toCache.monthTasksMap;
  await setCache(cacheKey, toCache);
  return applyProjectionsToYear(result, await getProjections(clientIndex));
}

async function forceRefreshPipelineData(clientIndex) {
  const cacheKey = `pipeline_${clientIndex}`;
  await deleteCache(cacheKey);
  const result = await buildPipelineData(clientIndex);
  result.cachedAt = new Date().toISOString();
  await setCache(cacheKey, result);
  return result;
}

async function refreshAllCaches() {
  console.log('Cache refresh: ' + new Date().toISOString());
  const tid = teamId();

  for (let idx = 0; idx < CLIENTS.length; idx++) {
    const client = CLIENTS[idx];
    const clientProjections = await getProjections(idx);
    const paygCache = await buildPaygDiscoveryCache(tid, client.spaceId);
    const budgets = client.hasRetainerBudget ? ['Retail', 'Trade'] : [null];

    // Fetch pipeline tasks once per client — passed to buildMonthData so confirmed
    // quotes appear in future-month drilldown caches without extra ClickUp calls.
    const pipelineRaw = await buildPipelineData(idx);
    const pipelineTasks = (pipelineRaw && pipelineRaw.tasks) || [];

    for (const budget of budgets) {
      for (const ys of ['Jan 26']) {
        try {
          const yrKey = `year_${idx}_${budget || 'all'}_${ys}`;
          const yr    = await buildYearView(idx, budget, ys, paygCache);
          yr.cachedAt = new Date().toISOString();

          const si = ALL_MONTHS.indexOf(ys);
          for (let i = si; i <= Math.min(ALL_MONTHS.length - 1, si + 11); i++) {
            const m  = ALL_MONTHS[i];
            const mk = `month_${idx}_${budget || 'all'}_${m}`;
            const md = await buildMonthData(idx, budget, m, paygCache, yr.monthTasksMap && yr.monthTasksMap[m], clientProjections, pipelineTasks);
            md.cachedAt = new Date().toISOString();
            await setCache(mk, md);
          }

          const yrToCache = Object.assign({}, yr);
          delete yrToCache.monthTasksMap;
          await setCache(yrKey, yrToCache);
          console.log(`✓ ${client.name}${budget ? ` (${budget})` : ''} ${ys}`);
        } catch (e) { console.log(`✗ ${client.name} ${ys}: ${e}`); }
      }
    }
  }

  for (let idx = 0; idx < CLIENTS.length; idx++) {
    const client = CLIENTS[idx];
    try {
      const pk = `pipeline_${idx}`;
      const pd = await buildPipelineData(idx);
      pd.cachedAt = new Date().toISOString();
      await setCache(pk, pd);
      console.log(`✓ Pipeline ${client.name} (${pd.totalTasks || 0} tasks)`);
    } catch (e) { console.log(`✗ Pipeline ${client.name}: ${e}`); }
  }

  // Build and cache the assembled overview (re-uses already-warmed per-client caches)
  for (const ys of ['Jan 26']) {
    try {
      const overviewKey = `overview_${ys}`;
      await deleteCache(overviewKey);
      const results = await Promise.all(CLIENTS.map(async (client, idx) => {
        try {
          const budgets = client.hasRetainerBudget ? ['Retail', 'Trade'] : [null];
          const yearResults = await Promise.all(budgets.map(b => getYearView(idx, b, ys)));
          const pipeline    = await getPipelineData(idx);
          return { idx, name: client.name, budgets: budgets.map((b, i) => ({ budget: b, year: yearResults[i] })), pipeline };
        } catch (e) { return { idx, name: client.name, error: e.message }; }
      }));
      const overviewData = { ok: true, clients: results, cachedAt: new Date().toISOString() };
      await setCache(overviewKey, overviewData);
      console.log(`✓ Overview ${ys}`);
    } catch (e) { console.log(`✗ Overview: ${e}`); }
  }

  console.log('Done.');
}

module.exports = { getYearView, getMonthData, getPipelineData, forceRefreshYearView, forceRefreshPipelineData, refreshAllCaches };
