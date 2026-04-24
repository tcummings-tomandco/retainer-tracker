'use strict';
const admin  = require('firebase-admin');
const { db } = require('./firestore');

// Verifies the Firebase ID token and attaches req.user from Firestore.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(header.slice(7));
    const snap    = await db.collection('users').doc(decoded.uid).get();
    if (!snap.exists) {
      return res.status(403).json({
        ok:    false,
        error: 'Access not set up. Contact Tom & Co to get access.',
      });
    }
    req.user = { uid: decoded.uid, ...snap.data() };
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'Session expired. Please log in again.' });
  }
}

// Guards a route to admin-role users only.
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Admin access required.' });
  }
  next();
}

// Checks that the requesting user may access data for requestedIdx.
// Returns true on success; sends a 403 and returns false on failure.
function assertClientAccess(req, res, requestedIdx) {
  if (req.user.role === 'admin') return true;
  if (req.user.clientIndex !== parseInt(requestedIdx, 10)) {
    res.status(403).json({ ok: false, error: 'Access denied.' });
    return false;
  }
  return true;
}

module.exports = { requireAuth, requireAdmin, assertClientAccess };
