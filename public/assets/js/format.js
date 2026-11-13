// Date-only values are formatted from their parts. Nothing here builds a Date from a
// bare string, so a calendar day can never shift with the viewer's time zone.
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function parseDay(value) {
  const match = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null;
  return { y, m, d };
}

export function formatDay(value) {
  const day = parseDay(value);
  return day ? `${MONTHS[day.m - 1].slice(0, 3)} ${day.d}, ${day.y}` : 'Date unknown';
}

export function formatLongDay(value) {
  const day = parseDay(value);
  if (!day) return 'Date unknown';
  const weekday = WEEKDAYS[new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay()];
  return `${weekday}, ${MONTHS[day.m - 1]} ${day.d}, ${day.y}`;
}

export function formatMonth(y, m) {
  return `${MONTHS[m - 1]} ${y}`;
}

/** Human date for an event or a last-preached summary, honouring how precisely the date is known. */
export function formatWhen(date, precision) {
  const day = parseDay(date);
  if (!day || precision === 'unknown') return 'Date unknown';
  if (precision === 'year') return `${day.y} (year only)`;
  if (precision === 'month') return `${formatMonth(day.y, day.m)} (month only)`;
  return formatDay(date);
}

/** Shorter form for dense lists: no "(month only)" suffix. */
export function formatWhenShort(date, precision) {
  const day = parseDay(date);
  if (!day || precision === 'unknown') return 'Date unknown';
  if (precision === 'year') return String(day.y);
  if (precision === 'month') return formatMonth(day.y, day.m);
  return formatDay(date);
}

export function formatStamp(value) {
  // D1 timestamps look like "2026-10-04 09:30:00" (UTC). Only the day is shown.
  return typeof value === 'string' ? formatDay(value.slice(0, 10)) : '';
}

export function plural(count, one, many = one + 's') {
  return `${count} ${count === 1 ? one : many}`;
}

export const SOURCE_LABELS = { google_doc: 'Google Doc', pdf: 'PDF', external: 'External link' };

const INDEX_STATES = {
  not_indexed: ['Not indexed', 'neutral'],
  awaiting_consent: ['Awaiting owner consent', 'warn'],
  queued: ['Indexing queued', 'warn'],
  indexed: ['Indexed', 'good'],
  failed: ['Indexing failed', 'bad'],
  revoked: ['Access revoked', 'bad']
};
export function indexingStatus(state) {
  const [label, tone] = INDEX_STATES[state] || ['Unknown status', 'neutral'];
  return { label, tone };
}

export const PRECISION_OPTIONS = [
  ['exact', 'Exact day'],
  ['month', 'Month only'],
  ['year', 'Year only'],
  ['unknown', 'Date unknown']
];

/** Today as a local YYYY-MM-DD (the viewer's own calendar day). */
export function localToday(now = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
