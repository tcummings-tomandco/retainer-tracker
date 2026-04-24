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

// Generates a clean invite link pointing to our own set-password page.
// Firebase generates the link (to validate the email exists), we extract
// the oobCode from it and build our own URL so clients never see
// "firebaseapp.com" in the link they receive.
async function getInviteLink(email) {
  const appUrl = (process.env.APP_URL
    || 'https://retainer-tracker--retainer-tracker-3eb71.europe-west4.hosted.app')
    .replace(/\/$/, '');

  // Generate via Firebase (action URL is a no-op — we only need the oobCode)
  const firebaseLink = await admin.auth().generatePasswordResetLink(email);
  const oobCode      = new URL(firebaseLink).searchParams.get('oobCode');

  // Return our own branded URL
  return `${appUrl}/set-password.html?oobCode=${oobCode}`;
}

module.exports = { listUsers, createUser, updateUser, deleteUser, getInviteLink };
