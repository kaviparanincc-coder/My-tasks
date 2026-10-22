// Date helpers. All dates are local calendar dates stored as "YYYY-MM-DD" strings;
// day arithmetic is done in UTC so daylight-saving changes can never shift a day.
export const pad = (n) => String(n).padStart(2, '0');

export function toKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function isValidKey(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (y < 1900 || y > 2200) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isValidTime(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

export function isValidIso(s) {
  return typeof s === 'string' && s.length >= 10 && s.length <= 40 && !Number.isNaN(Date.parse(s));
}

const utc = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};

export function addDays(key, n) {
  const dt = new Date(utc(key) + n * 86400000);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** whole days from a to b (b - a) */
export function diffDays(a, b) {
  return Math.round((utc(b) - utc(a)) / 86400000);
}

export function daysInMonth(year, month0) {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

export function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** 0 = Sunday … 6 = Saturday */
export function weekday(key) {
  return new Date(utc(key)).getUTCDay();
}

export function monthKey(year, month0, day = 1) {
  return `${year}-${pad(month0 + 1)}-${pad(day)}`;
}

export function shiftMonth({ y, m }, delta) {
  const idx = y * 12 + m + delta;
  return { y: Math.floor(idx / 12), m: ((idx % 12) + 12) % 12 };
}

/**
 * Month grid as rows of 7 cells. A cell is null (padding) or {key, day}.
 * weekStart: 0 = Sunday, 1 = Monday.
 */
export function calendarGrid(year, month0, weekStart = 0) {
  const first = monthKey(year, month0, 1);
  const offset = (weekday(first) - weekStart + 7) % 7;
  const dim = daysInMonth(year, month0);
  const cells = [];
  for (let i = 0; i < offset; i++) cells.push(null);
  for (let d = 1; d <= dim; d++) cells.push({ key: monthKey(year, month0, d), day: d });
  while (cells.length % 7 !== 0) cells.push(null);
  const rows = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  return rows;
}

const localDate = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};

export function formatLong(key) {
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(localDate(key));
}

export function formatFull(key) {
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(localDate(key));
}

export function formatShort(key, today) {
  const sameYear = !today || key.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat(undefined, sameYear
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' }).format(localDate(key));
}

export function formatMonth(year, month0) {
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date(year, month0, 1));
}

export function formatTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(2000, 0, 1, h, m));
}

export function weekdayLabels(weekStart = 0, style = 'short') {
  const base = new Date(2023, 0, 1); // a Sunday
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + ((i + weekStart) % 7));
    return new Intl.DateTimeFormat(undefined, { weekday: style }).format(d);
  });
}

export function formatDateTimeStamp(iso) {
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

export function nowKey(now = new Date()) { return toKey(now); }
export function nowTime(now = new Date()) { return `${pad(now.getHours())}:${pad(now.getMinutes())}`; }
