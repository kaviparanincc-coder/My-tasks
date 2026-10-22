// Minimal, dependency-free IndexedDB layer.
// Schema v1: store "tasks" (keyPath id, index dueDate) and store "meta" (keyPath key).
// Every write is one transaction and resolves only when the transaction has committed.
// Future schema changes: bump DB_VERSION and add a step in upgrade() keyed on oldVersion;
// never delete the "tasks" store in an upgrade.
export const DB_NAME = 'my-assistant';
export const DB_VERSION = 1;

function upgrade(db, oldVersion) {
  if (oldVersion < 1) {
    const tasks = db.createObjectStore('tasks', { keyPath: 'id' });
    tasks.createIndex('dueDate', 'dueDate');
    db.createObjectStore('meta', { keyPath: 'key' });
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => upgrade(req.result, e.oldVersion);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Could not open the database.'));
    req.onblocked = () => reject(new Error('The database is blocked by another open tab. Close other copies of the app and reload.'));
  });
}

const req2p = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

function txDone(tx) {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error || new Error('Write failed.'));
    tx.onabort = () => rej(tx.error || new Error('Write was aborted.'));
  });
}

class IdbStorage {
  constructor(db) {
    this.db = db;
    this.volatile = false;
    db.onversionchange = () => { db.close(); this.onInvalidated?.(); };
    db.onclose = () => this.onInvalidated?.();
  }

  tx(stores, mode) {
    try { return this.db.transaction(stores, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined); }
    catch { return this.db.transaction(stores, mode); }
  }

  async getAllTasks() {
    const tx = this.tx(['tasks'], 'readonly');
    const out = await req2p(tx.objectStore('tasks').getAll());
    await txDone(tx);
    return out;
  }

  /** Atomically put/delete tasks and (optionally) write meta rows in ONE transaction. */
  async write({ put = [], del = [], meta = [], clear = false }) {
    const tx = this.tx(['tasks', 'meta'], 'readwrite');
    const done = txDone(tx);
    const tasks = tx.objectStore('tasks');
    if (clear) tasks.clear();
    for (const id of del) tasks.delete(id);
    for (const t of put) tasks.put(t);
    const m = tx.objectStore('meta');
    for (const [key, value] of meta) m.put({ key, value });
    await done;
  }

  async getMeta(key) {
    const tx = this.tx(['meta'], 'readonly');
    const row = await req2p(tx.objectStore('meta').get(key));
    await txDone(tx);
    return row ? row.value : undefined;
  }

  async setMeta(key, value) { await this.write({ meta: [[key, value]] }); }
}

class MemoryStorage {
  constructor() { this.tasks = new Map(); this.meta = new Map(); this.volatile = true; }
  async getAllTasks() { return structuredClone([...this.tasks.values()]); }
  async write({ put = [], del = [], meta = [], clear = false }) {
    if (clear) this.tasks.clear();
    for (const id of del) this.tasks.delete(id);
    for (const t of put) this.tasks.set(t.id, structuredClone(t));
    for (const [k, v] of meta) this.meta.set(k, structuredClone(v));
  }
  async getMeta(key) { return this.meta.has(key) ? structuredClone(this.meta.get(key)) : undefined; }
  async setMeta(key, value) { this.meta.set(key, structuredClone(value)); }
}

/** Opens IndexedDB, or falls back to an in-memory store (flagged volatile) if it is unavailable. */
export async function createStorage() {
  if (typeof indexedDB === 'undefined') return { storage: new MemoryStorage(), error: new Error('IndexedDB is not available in this browser.') };
  try {
    return { storage: new IdbStorage(await openDb()), error: null };
  } catch (error) {
    return { storage: new MemoryStorage(), error };
  }
}

export { MemoryStorage };
