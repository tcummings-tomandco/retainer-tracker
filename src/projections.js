'use strict';
// Firestore-backed projections — replaces the local JSON file.
// Same interface as before but functions are now async.
//
// Data model (per task entry):
//   { taskName, confirmedTotal, allocations: [{ hours, month }] }
//
// Backward compat: old entries with { projectedHours, targetMonth } are
// normalised to the new format on read.
const { db } = require('./firestore');

function normalise(raw) {
  const out = {};
  for (const id in raw) {
    const v = raw[id];
    if (v && v.allocations) {
      // already new format
      out[id] = v;
    } else if (v && (v.projectedHours != null || v.targetMonth)) {
      // legacy single-allocation format
      out[id] = {
        taskName:       v.taskName || '',
        confirmedTotal: null,
        allocations:    v.projectedHours && v.targetMonth
          ? [{ hours: Number(v.projectedHours), month: v.targetMonth }]
          : [],
      };
    }
  }
  return out;
}

// Doc key includes budget so Retail and Trade projections are stored separately.
// Clients without a split budget use 'all' (same behaviour as before).
function projDocKey(clientIndex, budget) {
  return `${clientIndex}_${budget || 'all'}`;
}

async function getProjections(clientIndex, budget) {
  try {
    const key = projDocKey(clientIndex, budget);
    const doc = await db.collection('projections').doc(key).get();
    if (doc.exists && Object.keys(doc.data() || {}).length > 0) {
      return normalise(doc.data() || {});
    }
    // Backward-compat fallback: old data was stored under clientIndex only (pre-budget-isolation).
    // That legacy data had no budget tag — it was entered on the Retail tab — so only fall back
    // for Retail.  Trade should be independent: if no Trade-specific doc exists, return empty
    // so legacy Retail projections don't bleed into the Trade balance.
    if (budget === 'Retail') {
      const legacyDoc = await db.collection('projections').doc(String(clientIndex)).get();
      if (legacyDoc.exists && Object.keys(legacyDoc.data() || {}).length > 0) {
        console.log(`Projections: falling back to legacy key "${clientIndex}" for client ${clientIndex} budget ${budget}`);
        return normalise(legacyDoc.data() || {});
      }
    }
    return {};
  } catch (e) {
    console.error('Projections read error:', e.message);
    return {};
  }
}

// allocations — array of { hours, month } or null/[] to clear the entry.
// confirmedTotal — the confirmed quote total (number) or null for estimates.
// barStart / barEnd — optional month strings ('May 26') for the visual Gantt bar span on
//   pre-work tasks.  These are independent of allocations and do not affect balance.
async function saveProjection(clientIndex, budget, taskId, taskName, confirmedTotal, allocations, barStart, barEnd) {
  try {
    const ref  = db.collection('projections').doc(projDocKey(clientIndex, budget));
    const doc  = await ref.get();
    let data = doc.exists ? (doc.data() || {}) : {};

    // If this is the first write to the Retail key, seed from the legacy clientIndex-only
    // key so existing Retail projections aren't lost.  Don't seed Trade — legacy data
    // was entered without a budget and is Retail-context; copying it into Trade would make
    // Retail roadmap items appear on the Trade balance.
    if (!doc.exists && budget === 'Retail') {
      try {
        const legacyDoc = await db.collection('projections').doc(String(clientIndex)).get();
        if (legacyDoc.exists && Object.keys(legacyDoc.data() || {}).length > 0) {
          console.log(`Projections: seeding new key "${projDocKey(clientIndex, budget)}" from legacy key "${clientIndex}"`);
          data = legacyDoc.data() || {};
        }
      } catch (e) { /* non-fatal — proceed with empty */ }
    }

    // Allow month-only allocations (hours may be null) — used for roadmap bar
    // placement without committing hours to the balance forecast.
    const validAllocs = Array.isArray(allocations)
      ? allocations.filter(a => a && a.month)
      : [];

    if (!validAllocs.length && !barStart && !barEnd) {
      delete data[taskId];
    } else {
      data[taskId] = {
        taskName:       taskName || '',
        confirmedTotal: confirmedTotal != null ? Number(confirmedTotal) : null,
        allocations:    validAllocs.map(a => ({ hours: Number(a.hours), month: a.month })),
      };
      // barStart / barEnd are purely visual — persist them alongside allocations
      // so the Gantt bar span survives page reloads.
      if (barStart) data[taskId].barStart = barStart;
      if (barEnd)   data[taskId].barEnd   = barEnd;
    }
    await ref.set(data);
    return normalise(data);
  } catch (e) {
    console.error('Projections write error:', e.message);
    throw e;
  }
}

module.exports = { getProjections, saveProjection };
