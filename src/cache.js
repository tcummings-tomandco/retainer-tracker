'use strict';
const { CACHE_SECONDS } = require('./config');

// In-memory TTL cache — same semantics as GAS CacheService.
// Swap this module for a Firestore implementation when deploying to Cloud Run.
const store = new Map();

function getCache(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { store.delete(key); return null; }
  return JSON.parse(JSON.stringify(entry.data)); // return a copy, not a reference
}

function setCache(key, data, ttlSeconds = CACHE_SECONDS) {
  store.set(key, { data, expiresAt: Date.now() + ttlSeconds * 1000 });
}

function deleteCache(key) {
  store.delete(key);
}

module.exports = { getCache, setCache, deleteCache };
