/**
 * offlineDB.js
 *
 * Thin IndexedDB layer (via `idb`) for AfriPay offline mode.
 *
 * Stores:
 *  - "cache"   : last-known API snapshots  (balance, transaction history)
 *  - "queue"   : outgoing payment requests that failed while offline
 *
 * The service worker handles Background Sync replay automatically.
 * This module is used by React components to read cached data and
 * to let the UI display the pending-payment queue to the user.
 */

import { openDB } from 'idb';

/**
 * Generate a RFC-4122 v4 UUID.
 * Uses `crypto.randomUUID()` when available (all modern browsers), falling back
 * to a manual implementation so the module works in test environments.
 */
function generateUUID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Polyfill: manually assemble a v4 UUID from random bytes
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const DB_NAME    = 'afripay-offline';
const DB_VERSION = 1;

/** Lazily-opened singleton promise */
let _db = null;

function getDB() {
  if (_db) return _db;
  _db = openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      // Key-value store for API snapshots
      if (!db.objectStoreNames.contains('cache')) {
        db.createObjectStore('cache');
      }
      // Ordered store for queued payment requests
      if (!db.objectStoreNames.contains('queue')) {
        const store = db.createObjectStore('queue', {
          keyPath: 'id',
          autoIncrement: true,
        });
        store.createIndex('by_created', 'createdAt');
      }
    },
  });
  return _db;
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

/**
 * Persist an API response snapshot.
 * @param {string} key   - e.g. 'balance' | 'history'
 * @param {*}      value - serialisable JS value
 */
export async function setCacheEntry(key, value) {
  const db = await getDB();
  await db.put('cache', { data: value, savedAt: Date.now() }, key);
}

/**
 * Read a cached snapshot.
 * @param {string} key
 * @returns {{ data: *, savedAt: number } | undefined}
 */
export async function getCacheEntry(key) {
  const db = await getDB();
  return db.get('cache', key);
}

// ─── Payment queue helpers ────────────────────────────────────────────────────

/**
 * Add a payment to the offline queue.
 *
 * An idempotency key is generated **once** at queue time and stored alongside
 * the payload.  Every subsequent replay attempt (including resumptions after a
 * mid-replay connectivity drop) must reuse the same key so that the backend
 * idempotency middleware can deduplicate the request and prevent duplicate
 * payments.
 *
 * @param {{ recipient_address: string, amount: string, asset: string, memo?: string, memo_type?: string }} payload
 * @returns {Promise<IDBValidKey>} The auto-incremented id of the new queue entry
 */
export async function enqueuePayment(payload) {
  const db = await getDB();
  return db.add('queue', {
    payload,
    idempotencyKey: generateUUID(), // assigned once, never regenerated on replay
    createdAt: Date.now(),
    status: 'pending',   // 'pending' | 'syncing' | 'failed'
  });
}

/**
 * Update the status of a queued payment without replacing its idempotency key.
 * Used by the replay logic to mark items as 'syncing' or 'failed' between
 * connectivity changes so the key is never discarded mid-flight.
 *
 * @param {number} id - The auto-incremented queue entry id
 * @param {'pending'|'syncing'|'failed'} status
 */
export async function updateQueuedPaymentStatus(id, status) {
  const db = await getDB();
  const entry = await db.get('queue', id);
  if (!entry) return;
  await db.put('queue', { ...entry, status });
}

/**
 * Return all queued payments, oldest first.
 * @returns {Promise<Array>}
 */
export async function getQueuedPayments() {
  const db = await getDB();
  return db.getAllFromIndex('queue', 'by_created');
}

/**
 * Remove a queued payment by its auto-incremented id.
 * @param {number} id
 */
export async function removeQueuedPayment(id) {
  const db = await getDB();
  await db.delete('queue', id);
}

/**
 * Clear every entry in the payment queue (e.g. after a successful bulk sync).
 */
export async function clearPaymentQueue() {
  const db = await getDB();
  await db.clear('queue');
}

/**
 * Return the number of payments currently queued.
 * @returns {Promise<number>}
 */
export async function getQueueCount() {
  const db = await getDB();
  return db.count('queue');
}
