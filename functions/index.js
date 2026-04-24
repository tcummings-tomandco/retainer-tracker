'use strict';
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logger }     = require('firebase-functions');

// Triggers a cache refresh on the App Hosting backend every 4 hours.
// The endpoint responds immediately and runs the refresh in the background.
const APP_URL = 'https://retainer-tracker--retainer-tracker-3eb71.europe-west4.hosted.app';

exports.refreshCaches = onSchedule({
  schedule:        'every 4 hours',
  region:          'europe-west4',
  timeoutSeconds:  60,
  memory:          '256MiB',
}, async (event) => {
  try {
    const res  = await fetch(`${APP_URL}/api/cron/refresh`, { method: 'POST' });
    const data = await res.json();
    logger.info('Cache refresh triggered:', data);
  } catch (e) {
    logger.error('Cache refresh failed:', e.message);
    throw e;
  }
});
