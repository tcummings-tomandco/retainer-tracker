'use strict';
const fs   = require('fs');
const path = require('path');

// Stores projections in a local JSON file — mirrors GAS PropertiesService.
// Swap this module for a Firestore implementation when deploying to Cloud Run.
const FILE = path.join(__dirname, '..', 'data', 'projections.json');

function loadAll() {
  try {
    if (!fs.existsSync(FILE)) return {};
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch { return {}; }
}

function saveAll(data) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function getProjections(clientIndex) {
  return loadAll()[String(clientIndex)] || {};
}

function saveProjection(clientIndex, taskId, taskName, projectedHours, targetMonth) {
  const all  = loadAll();
  const key  = String(clientIndex);
  const data = all[key] || {};

  if (projectedHours === null || projectedHours === '' || isNaN(Number(projectedHours))) {
    delete data[taskId];
  } else {
    data[taskId] = { taskName: taskName || '', projectedHours: Number(projectedHours), targetMonth };
  }
  all[key] = data;
  saveAll(all);
  return data;
}

module.exports = { getProjections, saveProjection };
