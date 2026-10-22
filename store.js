// Application state + all data mutations. Every mutation is: write to the database first,
// then (only on success) update the in-memory copy and notify the UI. Writes are serialised.
import * as L from './logic.js';
import { createStorage } from './db.js';

export const APP_VERSION = '1.0.0';

export const DEFAULT_SETTINGS = {
  theme: 'system',        // system | light | dark
  weekStart: 0,           // 0 = Sunday, 1 = Monday
  reminders: false,       // in-app reminders (+ notifications if permission granted)
  lastBackupAt: null,
  lastBackupCount: null,
  backupNudgeSnoozedUntil: null,
};

let storage = null;
let tasks = [];
let settings = { ...DEFAULT_SETTINGS };
let queue = Promise.resolve();
const listeners = new Set();

export const status = {
  volatile: false,         // true => data is NOT being saved (storage unavailable)
  storageError: null,
  persisted: null,         // result of navigator.storage.persist(): true / false / null (unsupported)
  migration: null,         // { count, skipped, warnings } when a migration ran this session
  migrationError: null,
};

export const getTasks = () => tasks;
export const getSettings = () => settings;
export const getTask = (id) => tasks.find((t) => t.id === id);
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const notify = () => { for (const fn of listeners) fn(); };

function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function applyToCache({ put = [], del = [], clear = false }) {
  const map = clear ? new Map() : new Map(tasks.map((t) => [t.id, t]));
  for (const id of del) map.delete(id);
  for (const t of put) map.set(t.id, t);
  tasks = [...map.values()].sort(L.byOrder);
}

// Other open copies of the app (e.g. installed app + browser tab) are told to re-read the
// database after every write, so a stale copy can never overwrite newer data.
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('my-assistant-data');
const tell = () => { try { channel && channel.postMessage('changed'); } catch { /* ignore */ } };

async function commit(change) {
  await enqueue(() => storage.write(change));
  applyToCache(change);
  notify();
  tell();
}

async function reloadFromDb() {
  try {
    const raw = await storage.getAllTasks();
    const iso = new Date().toISOString();
    tasks = raw.flatMap((r, i) => { try { return [L.normalizeTask(r, i, [], iso)]; } catch { return [r]; } }).sort(L.byOrder);
    const saved = await storage.getMeta('settings');
    settings = { ...DEFAULT_SETTINGS, ...(saved || {}) };
    notify();
  } catch { /* keep what we have */ }
}
if (channel) channel.onmessage = () => { if (storage && !storage.volatile) enqueue(reloadFromDb); };

// ------------------------------------------------------------------ startup

async function migrateLegacy() {
  const done = await storage.getMeta('migration');
  if (done && done.done) return;
  let legacy = null;
  try {
    legacy = typeof localStorage === 'undefined' ? null : L.readLegacyLocalStorage(localStorage);
  } catch (err) {
    // Unreadable old data: leave it untouched, tell the user, and try again next launch.
    status.migrationError = `Your earlier tasks could not be read automatically (${err.message}). They have not been changed. Use Backup & restore to import an export from the old app.`;
    return;
  }
  if (!legacy) {
    await storage.setMeta('migration', { done: true, at: new Date().toISOString(), count: 0 });
    return;
  }
  const have = new Set(tasks.map((t) => t.id));
  const base = L.nextOrder(tasks);
  const toPut = legacy.tasks.filter((t) => !have.has(t.id)).map((t, i) => ({ ...t, order: base + i }));
  await storage.write({ put: toPut });
  // Verify by reading back before the migration is considered successful.
  const stored = new Map((await storage.getAllTasks()).map((t) => [t.id, t]));
  const ok = toPut.every((t) => {
    const s = stored.get(t.id);
    return s && s.title === t.title && s.done === t.done && s.dueDate === t.dueDate && s.priority === t.priority;
  });
  if (!ok) {
    status.migrationError = 'Importing your earlier tasks could not be verified, so it will be retried next launch. Your original data was not changed.';
    return;
  }
  await storage.setMeta('migration', {
    done: true, at: new Date().toISOString(), count: toPut.length, sources: legacy.found, warnings: legacy.warnings,
  });
  tasks = [...stored.values()].sort(L.byOrder);
  status.migration = { count: toPut.length, warnings: legacy.warnings };
  // The original localStorage records are intentionally left in place as a safety copy.
}

export async function init() {
  const { storage: s, error } = await createStorage();
  storage = s;
  status.volatile = s.volatile;
  status.storageError = error ? error.message : null;
  s.onInvalidated = () => { status.storageError = 'The database connection was closed. Reload the app.'; status.volatile = true; notify(); };

  try {
    const raw = await storage.getAllTasks();
    const warnings = [];
    const iso = new Date().toISOString();
    tasks = raw.flatMap((r, i) => {
      try { return [L.normalizeTask(r, i, warnings, iso)]; } catch { return [r]; } // never drop a record on load
    }).sort(L.byOrder);
    const saved = await storage.getMeta('settings');
    settings = { ...DEFAULT_SETTINGS, ...(saved || {}) };
    await migrateLegacy();
  } catch (err) {
    status.storageError = `Could not read saved data: ${err.message}`;
  }

  try {
    if (navigator.storage && navigator.storage.persisted) {
      status.persisted = await navigator.storage.persisted();
      if (!status.persisted && navigator.storage.persist) status.persisted = await navigator.storage.persist();
    }
  } catch { /* denial is fine */ }
  notify();
}

// ------------------------------------------------------------------ settings

export async function updateSettings(patch) {
  const next = { ...settings, ...patch };
  await enqueue(() => storage.setMeta('settings', next));
  settings = next;
  notify();
  tell();
}

export const getMeta = (k) => storage.getMeta(k);
export const setMeta = (k, v) => enqueue(() => storage.setMeta(k, v));

// ------------------------------------------------------------------ task actions

export async function addTask(fields) {
  const task = L.makeTask(fields, L.nextOrder(tasks));
  await commit({ put: [task] });
  return task;
}

export async function editTask(id, fields) {
  const cur = getTask(id);
  if (!cur) throw new Error('That task no longer exists.');
  const next = L.applyEdit(cur, fields);
  await commit({ put: [next] });
  return { before: cur, after: next };
}

export async function setTaskDone(id, done) {
  const cur = getTask(id);
  if (!cur) throw new Error('That task no longer exists.');
  const next = L.setDone(cur, done);
  await commit({ put: [next] });
  return { before: cur, after: next };
}

export async function deleteTask(id) {
  const cur = getTask(id);
  if (!cur) throw new Error('That task no longer exists.');
  await commit({ del: [id] });
  return cur;
}

/** Write exact task objects (used by Undo). */
export async function restoreTasks(list) { await commit({ put: list }); }

export async function reorder(orderedIds) {
  const changed = L.reorderSubset(tasks, orderedIds);
  if (!changed.length) return { before: [], after: [] };
  const before = changed.map((t) => getTask(t.id));
  await commit({ put: changed });
  return { before, after: changed };
}

// ------------------------------------------------------------------ backup / import / delete-all

export async function markBackedUp(count) {
  await updateSettings({ lastBackupAt: new Date().toISOString(), lastBackupCount: count });
}

async function snapshotBeforeImport() {
  await enqueue(() => storage.setMeta('preImportSnapshot', { at: new Date().toISOString(), tasks }));
}

export async function importMerge(incoming) {
  const r = L.mergeTasks(tasks, incoming);
  if (r.toPut.length) {
    await snapshotBeforeImport();
    await commit({ put: r.toPut });
  }
  return r;
}

export async function importReplace(incoming) {
  await snapshotBeforeImport();
  const next = L.replacementTasks(incoming);
  await commit({ clear: true, put: next });
  return next.length;
}

export async function getImportSnapshot() {
  const s = await storage.getMeta('preImportSnapshot');
  return s && Array.isArray(s.tasks) ? s : null;
}

export async function undoImport() {
  const s = await getImportSnapshot();
  if (!s) throw new Error('There is no earlier data to restore.');
  await commit({ clear: true, put: s.tasks });
  await enqueue(() => storage.setMeta('preImportSnapshot', null));
  return s.tasks.length;
}

export async function deleteAllData() {
  await enqueue(() => storage.write({ clear: true, meta: [['preImportSnapshot', null]] }));
  applyToCache({ clear: true });
  notify();
}
