'use strict';
const admin  = require('firebase-admin');
const { db } = require('./firestore');

async function listUsers() {
  const snap = await db.collection('users').orderBy('createdAt', 'desc').get();
  return snap.docs.map(d => ({ uid: d.id, ...d.data() }));
}

async function createUser(email, role, clientIndex) {
  let userRecord;
  try {
    userRecord = await admin.auth().createUser({ email, emailVerified: false });
  } catch (e) {
    // If the Firebase Auth account already exists, reuse it.
    if (e.code === 'auth/email-already-exists') {
      userRecord = await admin.auth().getUserByEmail(email);
    } else {
      throw e;
    }
  }

  await db.collection('users').doc(userRecord.uid).set({
    email,
    role,
    clientIndex: role === 'admin' ? null : (clientIndex != null ? parseInt(clientIndex, 10) : null),
    createdAt:   new Date().toISOString(),
  });

  return { uid: userRecord.uid, email, role, clientIndex };
}

async function updateUser(uid, { role, clientIndex }) {
  await db.collection('users').doc(uid).update({
    role,
    clientIndex: role === 'admin' ? null : (clientIndex != null ? parseInt(clientIndex, 10) : null),
  });
}

async function deleteUser(uid) {
  await Promise.all([
    admin.auth().deleteUser(uid).catch(() => {}), // ignore if already gone from Auth
    db.collection('users').doc(uid).delete(),
  ]);
}

// Generates a password-reset / first-login link for the given email.
// The link redirects back to /login.html after the user sets their password.
async function getInviteLink(email) {
  const appUrl = process.env.APP_URL
    || 'https://retainer-tracker--retainer-tracker-3eb71.europe-west4.hosted.app';
  return admin.auth().generatePasswordResetLink(email, { url: appUrl + '/login.html' });
}

module.exports = { listUsers, createUser, updateUser, deleteUser, getInviteLink };
