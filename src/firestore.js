'use strict';
const admin = require('firebase-admin');

// Initialise once — works automatically on Firebase App Hosting (ADC),
// and locally after: gcloud auth application-default login
if (!admin.apps.length) {
  admin.initializeApp({
    projectId: process.env.GOOGLE_CLOUD_PROJECT || 'retainer-tracker-492908',
  });
}

const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

module.exports = { db };
