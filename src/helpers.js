'use strict';
const { CF, IDX_TO_BILLING, ALL_MONTHS } = require('./config');

// Mirrors GAS currentBillingMonth() exactly — BST-aware, UK locale
function currentBillingMonth() {
  const now      = new Date();
  const utcMonth = now.getUTCMonth();
  const utcYear  = now.getUTCFullYear();
  const utcDay   = now.getUTCDate();
  const utcHour  = now.getUTCHours();

  function lastSunday(year, month) {
    const d = new Date(Date.UTC(year, month + 1, 0));
    d.setUTCDate(d.getUTCDate() - d.getUTCDay());
    return d.getUTCDate();
  }

  const bstStart = lastSunday(utcYear, 2);
  const bstEnd   = lastSunday(utcYear, 9);
  const isBST = (utcMonth > 2 && utcMonth < 9)
    || (utcMonth === 2 && (utcDay > bstStart || (utcDay === bstStart && utcHour >= 1)))
    || (utcMonth === 9 && (utcDay < bstEnd   || (utcDay === bstEnd   && utcHour < 1)));

  const localMs = now.getTime() + (isBST ? 3600000 : 0);
  const local   = new Date(localMs);
  const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][local.getUTCMonth()];
  return m + ' ' + String(local.getUTCFullYear()).slice(2);
}

function effectiveHours(t) {
  if (t.tag === 'retainer hours' || t.tag === 'retainer carried hours') return 0;
  if (t.quoteHours != null) return t.quoteHours;
  if (t.retainerBalance != null && t.retainerBalance !== 0) return -t.retainerBalance;
  return 0;
}

function parseTask(t) {
  const cfMap = {};
  (t.custom_fields || []).forEach(f => { cfMap[f.id] = f; });

  const billingCF  = cfMap[CF.BILLING];
  let billingMonth = null;
  if (billingCF && billingCF.value != null)
    billingMonth = IDX_TO_BILLING[String(billingCF.value)] || null;

  const budgetCF = cfMap[CF.RETAINER_BUDGET];
  let budget = null;
  if (budgetCF && budgetCF.value != null)
    budget = Number(budgetCF.value) === 0 ? 'Retail' : 'Trade';

  const quoteCF    = cfMap[CF.QUOTE_HOURS];
  const quoteHours = (quoteCF && quoteCF.value != null) ? Number(quoteCF.value) : null;

  const balCF           = cfMap[CF.BALANCE];
  const retainerBalance = (balCF && balCF.value != null) ? Number(balCF.value) : null;

  const knownTags   = ['retainer hours','retainer am hours','retainer carried hours',
    'retainer recurring','additional support hours','payg hours used','discovery'];
  const allTagNames = (t.tags || []).map(tg => tg.name).filter(n => n && n !== 'undefined');
  let tag    = allTagNames.find(n => knownTags.includes(n)) || null;
  const labels = allTagNames.filter(n => !knownTags.includes(n));

  if (!tag && t.list && t.list.name === 'Billing') {
    const nm = (t.name || '').toLowerCase();
    if      (nm.includes('retainer hours'))     tag = 'retainer hours';
    else if (nm.includes('account management')) tag = 'retainer am hours';
    else if (nm.includes('carried'))            tag = 'retainer carried hours';
    else                                        tag = 'retainer recurring';
  }

  return {
    id:              t.id,
    name:            t.name,
    url:             t.url,
    parentId:        t.parent || null,
    status:          t.status ? t.status.status : '',
    tag,
    labels,
    billingMonth,
    budget,
    quoteHours,
    retainerBalance,
    listName:        t.list ? t.list.name : '',
  };
}

function parsePipelineTask(t) {
  const cfMap = {};
  (t.custom_fields || []).forEach(f => { cfMap[f.id] = f; });
  const quoteCF    = cfMap[CF.QUOTE_HOURS];
  const quoteHours = (quoteCF && quoteCF.value != null) ? Number(quoteCF.value) : null;

  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dueMsRaw = t.due_date   ? parseInt(t.due_date, 10)   : null;
  const stMsRaw  = t.start_date ? parseInt(t.start_date, 10) : null;
  let dueMonth = null, startMonth = null;
  let dueDay = null, dueDaysInMonth = null, startDay = null, startDaysInMonth = null;

  if (dueMsRaw) {
    const dd = new Date(dueMsRaw);
    dueMonth       = mo[dd.getUTCMonth()] + ' ' + String(dd.getUTCFullYear()).slice(-2);
    dueDay         = dd.getUTCDate();
    dueDaysInMonth = new Date(dd.getUTCFullYear(), dd.getUTCMonth() + 1, 0).getDate();
  }
  if (stMsRaw) {
    const sd = new Date(stMsRaw);
    startMonth       = mo[sd.getUTCMonth()] + ' ' + String(sd.getUTCFullYear()).slice(-2);
    startDay         = sd.getUTCDate();
    startDaysInMonth = new Date(sd.getUTCFullYear(), sd.getUTCMonth() + 1, 0).getDate();
  }

  return {
    id:               t.id,
    name:             t.name,
    url:              t.url,
    status:           t.status ? (t.status.status || '').toLowerCase() : '',
    priority:         t.priority ? (t.priority.priority || null) : null,
    quoteHours,
    startMonth, startDay, startDaysInMonth,
    dueMonth,   dueDay,   dueDaysInMonth,
  };
}

function reapplyDateFlags(data) {
  if (!data || !data.months) return data;
  const today = currentBillingMonth();
  const ti    = ALL_MONTHS.indexOf(today);
  data.months = data.months.map(m => {
    const mi    = ALL_MONTHS.indexOf(m.month);
    m.isCurrent = mi === ti;
    m.isFuture  = mi > ti;
    return m;
  });
  return data;
}

// projections is a plain object { taskId: { projectedHours, targetMonth } }
function applyProjectionsToYear(data, projections) {
  if (!data || !data.months) return data;

  const projByMonth = {};
  for (const tid in projections) {
    const p = projections[tid];
    if (!p.targetMonth || !p.projectedHours) continue;
    projByMonth[p.targetMonth] = (projByMonth[p.targetMonth] || 0) + p.projectedHours;
  }

  const credit = data.monthlyCredit || 0;
  let prevClosing = null;
  data.months = data.months.map(m => {
    if (!m.isFuture) { prevClosing = m.closingBalance; return m; }
    const projCost    = Math.round(projByMonth[m.month] || 0);
    const newHoursOut = (m.hoursOut || 0) + projCost;
    const carryIn     = prevClosing !== null ? prevClosing : m.closingBalance - credit + newHoursOut;
    const newClosing  = Math.round((carryIn + credit - newHoursOut) * 10) / 10;
    prevClosing = newClosing;
    return Object.assign({}, m, { hoursOut: newHoursOut, closingBalance: newClosing, projectedHours: projCost });
  });
  return data;
}

module.exports = { currentBillingMonth, effectiveHours, parseTask, parsePipelineTask, reapplyDateFlags, applyProjectionsToYear };
