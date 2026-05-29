'use strict';
// Firestore-backed custom task ordering for the Roadmap Gantt view.
// Stored per client index (pipeline tasks are shared across budgets).
//
// Data model (per client doc):
//   { pre: ['taskId1', 'taskId2', ...], active: [...], review: [...] }
//
// Groups not present in the doc use ClickUp's default sort (by due date).
const { db } = require('./firestore');

async function getTaskOrder(clientIndex) {
  try {
    const doc = await db.collection('task-order').doc(String(clientIndex)).get();
    return doc.exists ? (doc.data() || {}) : {};
  } catch (e) {
    console.error('Task order read error:', e.message);
    return {};
  }
}

// order — object with optional group keys { pre, active, review }, each an array of task IDs.
async function saveTaskOrder(clientIndex, order) {
  try {
    await db.collection('task-order').doc(String(clientIndex)).set(order || {});
  } catch (e) {
    console.error('Task order write error:', e.message);
    throw e;
  }
}

module.exports = { getTaskOrder, saveTaskOrder };
