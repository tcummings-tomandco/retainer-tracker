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

async function buildMonthData(clientIndex, budget, month, paygCache, precomputedTasks, externalProjections) {
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
    const projData = externalProjections || await getProjections(clientIndex);
    for (const pid in projData) {
      const p = projData[pid];
      if (p.targetMonth === month) {
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
  const cached   = await getCache(cacheKey);
  if (cached) {
    const proj = await getProjections(clientIndex);
    let out = reapplyDateFlags(cached);
    out = applyProjectionsToYear(out, proj);
    out.fromCache = true;
    return out;
  }
  const result = await buildYearView(clientIndex, budget, yearStart);
  result.cachedAt = new Date().toISOString();
  const toCache = Object.assign({}, result);
  delete toCache.monthTasksMap;
  await setCache(cacheKey, toCache);
  return applyProjectionsToYear(result, await getProjections(clientIndex));
}

async function getMonthData(clientIndex, budget, month) {
  const cacheKey = `month_${clientIndex}_${budget || 'all'}_${month}`;
  const cached   = await getCache(cacheKey);
  if (cached) { cached.fromCache = true; return cached; }
  const result = await buildMonthData(clientIndex, budget, month);
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
            const md = await buildMonthData(idx, budget, m, paygCache, yr.monthTasksMap && yr.monthTasksMap[m], clientProjections);
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

  console.log('Done.');
}

module.exports = { getYearView, getMonthData, getPipelineData, forceRefreshYearView, forceRefreshPipelineData, refreshAllCaches };
