'use strict';
// Firestore-backed "On Hold" state for pipeline tasks.
// App-managed (not from ClickUp): ticking a card's checkbox parks the task in
// the On Hold column and removes it from the roadmap; unticking restores it to
// its normal status column and back onto the roadmap.
//
// Data model (per client doc):
//   { taskIds: ['taskId1', 'taskId2', ...] }
const { db } = require('./firestore');

async function getOnHold(clientIndex) {
  try {
    const doc = await db.collection('on-hold').doc(String(clientIndex)).get();
    const data = doc.exists ? (doc.data() || {}) : {};
    return Array.isArray(data.taskIds) ? data.taskIds : [];
  } catch (e) {
    console.error('On-hold read error:', e.message);
    return [];
  }
}

// taskIds — array of task IDs currently on hold for this client.
async function saveOnHold(clientIndex, taskIds) {
  try {
    await db.collection('on-hold').doc(String(clientIndex)).set({
      taskIds: Array.isArray(taskIds) ? taskIds : [],
    });
  } catch (e) {
    console.error('On-hold write error:', e.message);
    throw e;
  }
}

module.exports = { getOnHold, saveOnHold };
