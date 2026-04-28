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
    const doc = await db.collection('projections').doc(projDocKey(clientIndex, budget)).get();
    return doc.exists ? normalise(doc.data() || {}) : {};
  } catch (e) {
    console.error('Projections read error:', e.message);
    return {};
  }
}

// allocations — array of { hours, month } or null/[] to clear the entry.
// confirmedTotal — the confirmed quote total (number) or null for estimates.
async function saveProjection(clientIndex, budget, taskId, taskName, confirmedTotal, allocations) {
  try {
    const ref  = db.collection('projections').doc(projDocKey(clientIndex, budget));
    const doc  = await ref.get();
    const data = doc.exists ? (doc.data() || {}) : {};

    // Allow month-only allocations (hours may be null) — used for roadmap bar
    // placement without committing hours to the balance forecast.
    const validAllocs = Array.isArray(allocations)
      ? allocations.filter(a => a && a.month)
      : [];

    if (!validAllocs.length) {
      delete data[taskId];
    } else {
      data[taskId] = {
        taskName:       taskName || '',
        confirmedTotal: confirmedTotal != null ? Number(confirmedTotal) : null,
        allocations:    validAllocs.map(a => ({ hours: Number(a.hours), month: a.month })),
      };
    }
    await ref.set(data);
    return normalise(data);
  } catch (e) {
    console.error('Projections write error:', e.message);
    throw e;
  }
}

module.exports = { getProjections, saveProjection };
