'use strict';
// Firestore-backed projections — replaces the local JSON file.
// Same interface as before but functions are now async.
const { db } = require('./firestore');

async function getProjections(clientIndex) {
  try {
    const doc = await db.collection('projections').doc(String(clientIndex)).get();
    return doc.exists ? (doc.data() || {}) : {};
  } catch (e) {
    console.error('Projections read error:', e.message);
    return {};
  }
}

async function saveProjection(clientIndex, taskId, taskName, projectedHours, targetMonth) {
  try {
    const ref  = db.collection('projections').doc(String(clientIndex));
    const doc  = await ref.get();
    const data = doc.exists ? (doc.data() || {}) : {};

    if (projectedHours === null || projectedHours === '' || isNaN(Number(projectedHours))) {
      delete data[taskId];
    } else {
      data[taskId] = { taskName: taskName || '', projectedHours: Number(projectedHours), targetMonth };
    }
    await ref.set(data);
    return data;
  } catch (e) {
    console.error('Projections write error:', e.message);
    throw e;
  }
}

module.exports = { getProjections, saveProjection };
