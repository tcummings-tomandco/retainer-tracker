'use strict';
const admin                = require('firebase-admin');
const { getFirestore }     = require('firebase-admin/firestore');

// Initialise once — works automatically on Firebase App Hosting (ADC),
// and locally after: gcloud auth application-default login
if (!admin.apps.length) {
  admin.initializeApp({
    projectId: 'retainer-tracker-3eb71',
  });
}

// Connect to the named database 'cu-data' (not the default)
const db = getFirestore(admin.app(), 'cu-data');
db.settings({ ignoreUndefinedProperties: true });

module.exports = { db };
