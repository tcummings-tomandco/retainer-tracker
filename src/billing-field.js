'use strict';
// Dynamic Billing dropdown map — fetched live from the ClickUp field API.
//
// ClickUp prepends new billing months at position 0 in the dropdown each time
// one is added, shifting every existing month's index by 1.  Hardcoding
// BILLING_TO_IDX in config.js therefore breaks every query the moment a new
// month is added.  This module fetches the live option list, builds the index
// maps in memory, and refreshes them hourly so new months are picked up
// automatically without a code deploy.
//
// Seeded from config as a fallback so queries work immediately on cold start
// even before the first successful ClickUp fetch.

const { CF, BILLING_TO_IDX, IDX_TO_BILLING } = require('./config');

const TTL_MS = 60 * 60 * 1000; // 1 hour

const state = {
  toIdx:     Object.assign({}, BILLING_TO_IDX),   // 'May 26' -> 0
  toMonth:   Object.assign({}, IDX_TO_BILLING),   // '0' -> 'May 26'
  fetchedAt: null,     // timestamp of last successful fetch
  pending:   null,     // in-flight Promise (deduplicates concurrent calls)
  listId:    null,     // billing list used for the fetch (any client will do)
};

async function _doRefresh(billingListId) {
  const token = process.env.CLICKUP_API_TOKEN;
  if (!token) throw new Error('CLICKUP_API_TOKEN not set');

  const r = await fetch(
    `https://api.clickup.com/api/v2/list/${billingListId}/field`,
    { headers: { Authorization: token } }
  );
  if (!r.ok) throw new Error(`ClickUp field fetch returned ${r.status}`);

  const data = await r.json();
  const field = (data.fields || []).find(f => f.id === CF.BILLING);
  if (!field) throw new Error('Billing CF not found in list field response');

  const opts = (field.type_config || {}).options || [];
  if (!opts.length) throw new Error('Billing CF has no options');

  const toIdx = {}, toMonth = {};
  opts.forEach((opt, i) => {
    toIdx[opt.name]    = i;
    toMonth[String(i)] = opt.name;
  });

  state.toIdx     = toIdx;
  state.toMonth   = toMonth;
  state.fetchedAt = Date.now();
  state.listId    = billingListId;

  const newest = opts[0] ? opts[0].name : '?';
  const oldest = opts[opts.length - 1] ? opts[opts.length - 1].name : '?';
  console.log(`Billing field map refreshed: ${opts.length} options [${newest} … ${oldest}]`);
}

// Ensures the billing field map is current (fetched within TTL).
// Concurrent callers share a single in-flight promise to avoid hammering the API.
async function ensureFresh(billingListId) {
  const now = Date.now();
  if (state.fetchedAt && (now - state.fetchedAt) < TTL_MS) return; // still fresh

  if (!state.pending) {
    state.pending = _doRefresh(billingListId || state.listId)
      .catch(e => console.error('Billing field map refresh failed (using cached/config values):', e.message))
      .finally(() => { state.pending = null; });
  }
  await state.pending;
}

// Force an immediate refresh regardless of TTL (called by the cron and Refresh button).
async function forceRefresh(billingListId) {
  state.fetchedAt = null; // invalidate so ensureFresh triggers
  await ensureFresh(billingListId || state.listId);
}

module.exports = { state, ensureFresh, forceRefresh };
