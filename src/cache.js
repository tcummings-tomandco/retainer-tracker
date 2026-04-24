'use strict';
// Firestore-backed cache — replaces the in-memory Map.
// Same interface as before but all functions are now async.
// Swap back to Map-based cache by reverting this file — nothing else changes.
const { db } = require('./firestore');
const { CACHE_SECONDS } = require('./config');

async function getCache(key) {
  try {
    const doc = await db.collection('cache').doc(key).get();
    if (!doc.exists) return null;
    const { data, expiresAt } = doc.data();
    if (Date.now() > expiresAt) {
      await db.collection('cache').doc(key).delete();
      return null;
    }
    return data;
  } catch (e) {
    console.error('Cache read error:', e.message);
    return null;
  }
}

async function setCache(key, data, ttlSeconds = CACHE_SECONDS) {
  try {
    await db.collection('cache').doc(key).set({
      data,
      expiresAt: Date.now() + ttlSeconds * 1000,
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('Cache write error:', e.message);
  }
}

async function deleteCache(key) {
  try {
    await db.collection('cache').doc(key).delete();
  } catch (e) {
    console.error('Cache delete error:', e.message);
  }
}

module.exports = { getCache, setCache, deleteCache };
