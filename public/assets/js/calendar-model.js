// Pure calendar maths and event bucketing. Mirrors the server's calendar rules: a month
// shows exact and needs_review events on their day and month-precision events as
// "month only"; year-precision and undated events never sit on a day.
import { parseDay } from './format.js';

export const MIN_YEAR = 1900;
export const MAX_YEAR = 2100;

export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const pad = n => String(n).padStart(2, '0');
export const dayKey = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
export const monthKey = (y, m) => `${y}-${pad(m)}`;

/** Weeks (Sunday first) of cells: null for padding, {date, day} for real days. */
export function monthGrid(y, m) {
  const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const cells = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= daysInMonth(y, m); d++) cells.push({ date: dayKey(y, m, d), day: d });
  while (cells.length % 7) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** Bucket events once; every calendar query below reads from this index. */
export function indexEvents(events) {
  const index = { byDay: new Map(), byMonth: new Map(), byYear: new Map(), undated: [], dated: [] };
  const push = (map, key, event) => {
    const list = map.get(key);
    if (list) list.push(event); else map.set(key, [event]);
  };
  for (const event of events) {
    const day = parseDay(event.preached_on);
    if (!day || event.date_precision === 'unknown') { index.undated.push(event); continue; }
    index.dated.push(event);
    if (event.date_precision === 'year') push(index.byYear, String(day.y), event);
    else if (event.date_precision === 'month') push(index.byMonth, monthKey(day.y, day.m), event);
    else push(index.byDay, event.preached_on, event);
  }
  return index;
}

/** Everything the month view shows: marked days, month-only events and the total. */
export function monthView(index, y, m) {
  const days = new Map();
  for (let d = 1; d <= daysInMonth(y, m); d++) {
    const events = index.byDay.get(dayKey(y, m, d));
    if (events) days.set(dayKey(y, m, d), events);
  }
  const monthOnly = index.byMonth.get(monthKey(y, m)) || [];
  let count = monthOnly.length;
  for (const events of days.values()) count += events.length;
  return { days, monthOnly, count };
}

/** Twelve month tiles with counts, a 0-1 level for the bar, and the year-only events. */
export function yearView(index, y) {
  const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, count: monthView(index, y, i + 1).count, level: 0 }));
  const busiest = Math.max(1, ...months.map(month => month.count));
  for (const month of months) month.level = month.count / busiest;
  const yearOnly = index.byYear.get(String(y)) || [];
  return { months, yearOnly, total: months.reduce((sum, month) => sum + month.count, 0) + yearOnly.length };
}

export const clampYear = y => Math.min(MAX_YEAR, Math.max(MIN_YEAR, y));

/** Move by whole months across year boundaries. Stays put at the supported range limits. */
export function shiftMonth(y, m, delta) {
  const total = y * 12 + (m - 1) + delta;
  const next = { y: Math.floor(total / 12), m: (total % 12 + 12) % 12 + 1 };
  return next.y < MIN_YEAR || next.y > MAX_YEAR ? { y, m } : next;
}

/** Start where the archive actually has history: this month if it has events, else the latest past event, else this month. */
export function defaultPosition(index, today) {
  const now = parseDay(today);
  const current = { y: now.y, m: now.m };
  if (monthView(index, current.y, current.m).count) return current;
  const past = [...index.byDay.keys(), ...[...index.byMonth.values()].map(events => events[0].preached_on)]
    .filter(date => date <= today).sort().at(-1);
  const day = parseDay(past);
  return day ? { y: day.y, m: day.m } : current;
}

/** The day the inspector opens on: the latest marked day of the month, if any. */
export function defaultDay(view) {
  return [...view.days.keys()].sort().at(-1) || null;
}
