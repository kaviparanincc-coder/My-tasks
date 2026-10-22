// Pure task logic: validation, selectors, ordering, calendar, backup/import, CSV.
// No DOM and no storage access here, so everything is unit-testable in Node.
import {
  addDays, calendarGrid, diffDays, formatLong, isValidIso, isValidKey, isValidTime, pad,
} from './dates.js';

export const APP_ID = 'my-assistant';
export const BACKUP_FORMAT = 'my-assistant-backup';
export const BACKUP_VERSION = 2;
export const PRIORITIES = ['high', 'medium', 'low'];
export const PRIORITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };
export const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
export const MAX_TASKS = 20000;

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

export function newId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && c.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- tasks

export function byOrder(a, b) {
  return (a.order - b.order) || a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Create a brand-new task. `order` should come from nextOrder(). */
export function makeTask(fields, order, now = new Date(), id = newId()) {
  const iso = now.toISOString();
  const title = String(fields.title ?? '').trim();
  if (!title) throw new Error('A task needs a title.');
  const dueDate = fields.dueDate || null;
  if (dueDate && !isValidKey(dueDate)) throw new Error('That due date is not valid.');
  const dueTime = dueDate && fields.dueTime ? fields.dueTime : null;
  if (dueTime && !isValidTime(dueTime)) throw new Error('That time is not valid.');
  const priority = fields.priority || 'medium';
  if (!PRIORITIES.includes(priority)) throw new Error('Priority must be High, Medium or Low.');
  return {
    id, title: title.slice(0, 500), notes: String(fields.notes ?? '').trim().slice(0, 20000),
    dueDate, dueTime, priority, done: false, completedAt: null,
    createdAt: iso, updatedAt: iso, order,
  };
}

/** Apply user edits to an existing task, keeping id / createdAt / order / completion. */
export function applyEdit(task, fields, now = new Date()) {
  const next = makeTask({ ...task, ...fields }, task.order, now, task.id);
  return { ...next, done: task.done, completedAt: task.completedAt, createdAt: task.createdAt };
}

export function setDone(task, done, now = new Date()) {
  const iso = now.toISOString();
  return { ...task, done, completedAt: done ? iso : null, updatedAt: iso };
}

export function nextOrder(tasks) {
  let max = -1;
  for (const t of tasks) if (t.order > max) max = t.order;
  return max + 1;
}

/**
 * Validate and normalise one stored/imported task. Throws Error(message) when the
 * record cannot be trusted; pushes soft problems onto `warnings`.
 */
export function normalizeTask(raw, index = 0, warnings = [], nowIso = new Date().toISOString()) {
  const where = `Task ${index + 1}`;
  if (!isRecord(raw)) throw new Error(`${where} is not a task record.`);
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id || id.length > 200) throw new Error(`${where} has a missing or invalid id.`);
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) throw new Error(`${where} has no title.`);
  if (typeof raw.done !== 'boolean') throw new Error(`"${title}" has an invalid completion status.`);
  const priority = raw.priority === undefined ? 'medium' : raw.priority;
  if (!PRIORITIES.includes(priority)) throw new Error(`"${title}" has an invalid priority.`);

  const dueDate = raw.dueDate === undefined || raw.dueDate === null || raw.dueDate === '' ? null : raw.dueDate;
  if (dueDate !== null && !isValidKey(dueDate)) throw new Error(`"${title}" has an invalid due date.`);
  let dueTime = raw.dueTime === undefined || raw.dueTime === null || raw.dueTime === '' ? null : raw.dueTime;
  if (dueTime !== null && !isValidTime(dueTime)) throw new Error(`"${title}" has an invalid due time.`);
  if (dueTime !== null && dueDate === null) {
    warnings.push(`"${title}" had a time but no date; the time was dropped.`);
    dueTime = null;
  }
  if (raw.notes !== undefined && raw.notes !== null && typeof raw.notes !== 'string') {
    throw new Error(`"${title}" has invalid notes.`);
  }
  const createdAt = raw.createdAt === undefined ? nowIso : raw.createdAt;
  const updatedAt = raw.updatedAt === undefined ? createdAt : raw.updatedAt;
  if (!isValidIso(createdAt) || !isValidIso(updatedAt)) throw new Error(`"${title}" has an invalid timestamp.`);
  let completedAt = raw.completedAt === undefined ? null : raw.completedAt;
  if (completedAt !== null && !isValidIso(completedAt)) throw new Error(`"${title}" has an invalid completion date.`);
  if (!raw.done) completedAt = null;
  const order = raw.order === undefined ? index : raw.order;
  if (typeof order !== 'number' || !Number.isFinite(order)) throw new Error(`"${title}" has an invalid order value.`);

  return {
    id, title: title.slice(0, 500), notes: (raw.notes ?? '').slice(0, 20000), dueDate, dueTime,
    priority, done: raw.done, completedAt, createdAt, updatedAt, order,
  };
}

// ---------------------------------------------------------------- selectors

export const isOpen = (t) => !t.done;

export function tasksForDate(tasks, key) {
  return tasks.filter((t) => t.dueDate === key).sort(byOrder);
}

export function overdueTasks(tasks, today) {
  return tasks.filter((t) => !t.done && t.dueDate && t.dueDate < today)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || byOrder(a, b));
}

export function todayProgress(list) {
  const total = list.length;
  const done = list.filter((t) => t.done).length;
  return { total, done, pct: total ? Math.round((done / total) * 100) : 0 };
}

/**
 * "Needs attention": overdue tasks, plus open tasks due tomorrow, plus open
 * high-priority tasks due within 3 days. Anything due today is excluded because the
 * Today list already shows it. This never affects the manual order of Today.
 */
export function attentionItems(tasks, today) {
  const items = [];
  for (const t of tasks) {
    if (t.done || !t.dueDate) continue;
    const d = diffDays(today, t.dueDate);
    if (d < 0) items.push({ task: t, kind: 'overdue', days: d });
    else if (d === 1) items.push({ task: t, kind: 'soon', days: d });
    else if (d >= 2 && d <= 3 && t.priority === 'high') items.push({ task: t, kind: 'high', days: d });
  }
  const rank = { overdue: 0, soon: 1, high: 2 };
  return items.sort((a, b) =>
    rank[a.kind] - rank[b.kind]
    || a.task.dueDate.localeCompare(b.task.dueDate)
    || PRIORITY_RANK[a.task.priority] - PRIORITY_RANK[b.task.priority]
    || byOrder(a.task, b.task));
}

export function upcomingPreview(tasks, today, excludeIds = new Set(), limit = 3) {
  return tasks
    .filter((t) => !t.done && t.dueDate && t.dueDate > today && !excludeIds.has(t.id))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || byOrder(a, b))
    .slice(0, limit);
}

export const FILTERS = ['all', 'open', 'today', 'upcoming', 'overdue', 'unscheduled', 'completed'];

/** Filter + search + sort for the All Tasks screen. */
export function filterTasks(tasks, { filter = 'open', query = '' } = {}, today) {
  const q = query.trim().toLowerCase();
  let list = tasks.filter((t) => {
    switch (filter) {
      case 'open': return !t.done;
      case 'today': return t.dueDate === today;
      case 'upcoming': return !t.done && !!t.dueDate && t.dueDate > today;
      case 'overdue': return !t.done && !!t.dueDate && t.dueDate < today;
      case 'unscheduled': return !t.done && !t.dueDate;
      case 'completed': return t.done;
      default: return true;
    }
  });
  if (q) list = list.filter((t) => t.title.toLowerCase().includes(q) || t.notes.toLowerCase().includes(q));
  if (filter === 'completed') {
    return list.sort((a, b) => (b.completedAt || b.updatedAt).localeCompare(a.completedAt || a.updatedAt) || byOrder(a, b));
  }
  if (filter === 'today') return list.sort(byOrder); // manual order, never re-sorted
  return list.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.dueDate && !b.dueDate) return -1;
    if (!a.dueDate && b.dueDate) return 1;
    return (a.dueDate || '').localeCompare(b.dueDate || '') || byOrder(a, b);
  });
}

export function countByFilter(tasks, today) {
  const out = {};
  for (const f of FILTERS) out[f] = filterTasks(tasks, { filter: f }, today).length;
  return out;
}

// ---------------------------------------------------------------- manual ordering

/**
 * Reorder a subset of tasks (e.g. one day's list). The subset reuses its own existing
 * `order` values, so tasks outside the subset never move relative to anything.
 * Returns only the tasks whose order changed.
 */
export function reorderSubset(tasks, orderedIds, now = new Date()) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  if (new Set(orderedIds).size !== orderedIds.length) throw new Error('Duplicate ids in reorder.');
  const subset = orderedIds.map((id) => {
    const t = byId.get(id);
    if (!t) throw new Error('Unknown task in reorder.');
    return t;
  });
  const slots = subset.map((t) => t.order).sort((a, b) => a - b);
  const iso = now.toISOString();
  const changed = [];
  subset.forEach((t, i) => {
    if (t.order !== slots[i]) changed.push({ ...t, order: slots[i], updatedAt: iso });
  });
  return changed;
}

export function moveInList(ids, id, delta) {
  const i = ids.indexOf(id);
  const j = i + delta;
  if (i === -1 || j < 0 || j >= ids.length) return ids.slice();
  const next = ids.slice();
  next.splice(i, 1);
  next.splice(j, 0, id);
  return next;
}

// ---------------------------------------------------------------- calendar

export function tasksByDate(tasks) {
  const map = new Map();
  for (const t of tasks) {
    if (!t.dueDate) continue;
    if (!map.has(t.dueDate)) map.set(t.dueDate, []);
    map.get(t.dueDate).push(t);
  }
  for (const list of map.values()) list.sort(byOrder);
  return map;
}

/** Everything the calendar cell needs: dots (max 3), "+N", overdue flag, spoken label. */
export function dayIndicator(dayTasks, key, today) {
  const open = dayTasks.filter((t) => !t.done).sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  const done = dayTasks.filter((t) => t.done);
  const ordered = [...open, ...done];
  const dots = ordered.slice(0, 3).map((t) => ({ priority: t.priority, done: t.done }));
  const total = ordered.length;
  const overdue = key < today && open.length > 0;
  const parts = [];
  for (const p of PRIORITIES) {
    const n = open.filter((t) => t.priority === p).length;
    if (n) parts.push(`${n} ${p} priority`);
  }
  if (done.length) parts.push(`${done.length} completed`);
  if (overdue) parts.push('overdue');
  const label = total
    ? `${formatLong(key)}, ${total} task${total === 1 ? '' : 's'}: ${parts.join(', ')}`
    : `${formatLong(key)}, no tasks`;
  return { dots, extra: Math.max(0, total - 3), overdue, total, label };
}

export { calendarGrid };

// ---------------------------------------------------------------- reminders

/**
 * Tasks whose due time has just passed and that we have not yet announced.
 * Only used while the app is open (see README: a PWA cannot promise background alarms).
 */
export function dueReminders(tasks, now, notified = {}, windowMinutes = 120) {
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const out = [];
  for (const t of tasks) {
    if (t.done || !t.dueDate || !t.dueTime || t.dueDate > today) continue;
    const [y, m, d] = t.dueDate.split('-').map(Number);
    const [hh, mm] = t.dueTime.split(':').map(Number);
    const due = new Date(y, m - 1, d, hh, mm);
    const ageMin = (now - due) / 60000;
    const key = `${t.id}|${t.dueDate}|${t.dueTime}`;
    if (ageMin >= 0 && ageMin <= windowMinutes && !notified[key]) out.push({ task: t, key });
  }
  return out;
}

// ---------------------------------------------------------------- backup / import

export function createBackup(tasks, now = new Date(), appVersion = '1.0.0') {
  const sorted = tasks.slice().sort(byOrder);
  return JSON.stringify({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    app: APP_ID,
    appVersion,
    exportedAt: now.toISOString(),
    taskCount: sorted.length,
    tasks: sorted,
  }, null, 2);
}

// Sample tasks the previous version seeded into every new install. They are not the
// user's own data, so they are skipped on migration/import (and reported).
export const LEGACY_SEEDS = {
  email: 'Reply to Maya about Saturday',
  pharmacy: 'Pick up prescription',
  invoice: 'Send the studio invoice',
  walk: 'Take a proper lunch break',
};

function parseLegacyTime(text) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*(am|pm)?\s*$/i.exec(text);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ap = m[3] && m[3].toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}

/** Convert records from the previous app version ("my-assistant-tasks", v1). */
export function convertLegacyTasks(list, nowIso = new Date().toISOString()) {
  const warnings = [];
  const skipped = [];
  const tasks = [];
  list.forEach((raw, i) => {
    if (!isRecord(raw)) throw new Error(`Task ${i + 1} is not a task record.`);
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (typeof raw.id === 'string' && LEGACY_SEEDS[raw.id] === title) { skipped.push(title); return; }
    const noteLines = [];
    let dueTime = null;
    if (typeof raw.time === 'string' && raw.time.trim()) {
      dueTime = parseLegacyTime(raw.time);
      if (!dueTime) noteLines.push(`Time note: ${raw.time.trim()}`);
    }
    if (typeof raw.tag === 'string' && raw.tag.trim()) noteLines.push(`Tag: ${raw.tag.trim()}`);
    tasks.push(normalizeTask({
      id: raw.id, title: raw.title, done: raw.done, priority: raw.priority,
      dueDate: raw.dueDate, dueTime, notes: noteLines.join('\n'),
      createdAt: nowIso, updatedAt: nowIso, completedAt: null, order: tasks.length,
    }, i, warnings, nowIso));
  });
  if (skipped.length) warnings.push(`Skipped ${skipped.length} sample task${skipped.length === 1 ? '' : 's'} created by the old app: ${skipped.join('; ')}.`);
  return { tasks, warnings, skipped };
}

/**
 * Parse and fully validate a backup file's text. Never touches stored data.
 * Throws Error with a user-readable message when the file is unusable.
 */
export function parseBackup(text, nowIso = new Date().toISOString()) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('This file is not valid JSON, so it cannot be a My Assistant backup.');
  }
  const warnings = [];
  let tasks;
  let source;
  let exportedAt = null;
  if (Array.isArray(data) || (isRecord(data) && data.format === 'my-assistant-tasks')) {
    const list = Array.isArray(data) ? data : data.tasks;
    if (!Array.isArray(list)) throw new Error('This backup has no task list.');
    if (list.length > MAX_TASKS) throw new Error(`This backup has too many tasks (limit ${MAX_TASKS}).`);
    const conv = convertLegacyTasks(list, nowIso);
    tasks = conv.tasks;
    warnings.push(...conv.warnings);
    source = 'legacy';
    exportedAt = isRecord(data) && isValidIso(data.exportedAt) ? data.exportedAt : null;
  } else if (isRecord(data) && data.format === BACKUP_FORMAT) {
    if (typeof data.version !== 'number' || !Number.isInteger(data.version) || data.version < 1) {
      throw new Error('This backup has no valid version number.');
    }
    if (data.version > BACKUP_VERSION) {
      throw new Error(`This backup was made by a newer version of the app (format ${data.version}). Update My Assistant and try again.`);
    }
    if (!Array.isArray(data.tasks)) throw new Error('This backup has no task list.');
    if (data.tasks.length > MAX_TASKS) throw new Error(`This backup has too many tasks (limit ${MAX_TASKS}).`);
    tasks = data.tasks.map((t, i) => normalizeTask(t, i, warnings, nowIso));
    source = 'current';
    exportedAt = isValidIso(data.exportedAt) ? data.exportedAt : null;
  } else {
    throw new Error('This file is not a My Assistant backup (missing format marker).');
  }
  const ids = new Set();
  for (const t of tasks) {
    if (ids.has(t.id)) throw new Error(`The backup contains the same task id twice ("${t.title}").`);
    ids.add(t.id);
  }
  tasks.sort(byOrder);
  return { tasks, warnings, source, exportedAt };
}

/** Merge: add new ids after the current list; for matching ids keep the newer edit. */
export function mergeTasks(existing, incoming) {
  const byId = new Map(existing.map((t) => [t.id, t]));
  let order = nextOrder(existing);
  const toPut = [];
  let added = 0, updated = 0, unchanged = 0;
  for (const t of incoming.slice().sort(byOrder)) {
    const cur = byId.get(t.id);
    if (!cur) { toPut.push({ ...t, order: order++ }); added++; }
    else if (t.updatedAt > cur.updatedAt) { toPut.push({ ...t, order: cur.order }); updated++; }
    else unchanged++;
  }
  return { toPut, added, updated, unchanged };
}

/** Replace: the backup becomes the whole list; order values are made sequential. */
export function replacementTasks(incoming) {
  return incoming.slice().sort(byOrder).map((t, i) => ({ ...t, order: i }));
}

export function summarize(tasks, today) {
  return {
    total: tasks.length,
    open: tasks.filter((t) => !t.done).length,
    done: tasks.filter((t) => t.done).length,
    overdue: tasks.filter((t) => !t.done && t.dueDate && t.dueDate < today).length,
  };
}

// ---------------------------------------------------------------- legacy browser data

export const LEGACY_STORAGE_KEYS = ['my-assistant-tasks', 'myAssistantTasks'];

/**
 * Read tasks the previous app kept in localStorage. Read-only: never writes or deletes.
 * Returns null when nothing is there. Throws if data exists but is unreadable.
 */
export function readLegacyLocalStorage(storage, nowIso = new Date().toISOString()) {
  const found = [];
  const warnings = [];
  const seen = new Set();
  const tasks = [];
  for (const key of LEGACY_STORAGE_KEYS) {
    let raw = null;
    try { raw = storage.getItem(key); } catch { raw = null; }
    if (!raw) continue;
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.tasks) ? parsed.tasks : null;
    if (!list) throw new Error(`Stored data under "${key}" is not a task list.`);
    const conv = convertLegacyTasks(list, nowIso);
    warnings.push(...conv.warnings);
    for (const t of conv.tasks) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      tasks.push({ ...t, order: tasks.length });
    }
    found.push({ key, count: list.length });
  }
  return found.length ? { tasks, warnings, found } : null;
}

// ---------------------------------------------------------------- CSV

const CSV_COLUMNS = ['title', 'notes', 'due_date', 'due_time', 'priority', 'status', 'completed_at', 'created_at', 'updated_at', 'order', 'id'];

function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  // Stop spreadsheet apps from running text such as "=1+1" as a formula.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(tasks) {
  const rows = [CSV_COLUMNS.join(',')];
  for (const t of tasks.slice().sort(byOrder)) {
    rows.push([
      t.title, t.notes, t.dueDate, t.dueTime, t.priority, t.done ? 'completed' : 'open',
      t.completedAt, t.createdAt, t.updatedAt, t.order, t.id,
    ].map(csvCell).join(','));
  }
  return '﻿' + rows.join('\r\n') + '\r\n'; // BOM so Excel reads UTF-8 (e.g. Tamil)
}

export { addDays, diffDays };
