// Hash routes, so the server only ever needs to serve "/" and the app never needs a
// route table of its own on the Worker:
//   #/library/covers | rows | table | calendar?y=2026&m=10&d=2026-10-04
//   #/sermons/<uuid>
import { parseDay } from './format.js';
import { MAX_YEAR, MIN_YEAR } from './calendar-model.js';

export const VIEWS = ['covers', 'rows', 'table', 'calendar'];
export const VIEW_LABELS = { covers: 'Covers', rows: 'Quick rows', table: 'Table', calendar: 'Calendar' };
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
export const isUuid = value => typeof value === 'string' && UUID.test(value);

function intIn(value, min, max) {
  return /^\d{1,4}$/.test(value ?? '') && Number(value) >= min && Number(value) <= max ? Number(value) : null;
}

export function parseRoute(hash) {
  const raw = String(hash || '').replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  const params = new URLSearchParams(query);
  if (parts[0] === 'sermons') return isUuid(parts[1]) && parts.length === 2 ? { name: 'sermon', id: parts[1].toLowerCase() } : { name: 'missing' };
  if (parts.length === 0 || parts[0] === 'library') {
    const view = parts[1] === undefined ? 'covers' : parts[1];
    if (parts.length > 2 || !VIEWS.includes(view)) return { name: 'missing' };
    if (view !== 'calendar') return { name: 'library', view };
    const day = parseDay(params.get('d'));
    const y = day ? day.y : intIn(params.get('y'), MIN_YEAR, MAX_YEAR);
    const m = day ? day.m : intIn(params.get('m'), 1, 12);
    return { name: 'library', view, y: y !== null && m !== null ? y : null, m: y !== null && m !== null ? m : null, d: day ? params.get('d') : null };
  }
  return { name: 'missing' };
}

export function hrefFor(route) {
  if (route.name === 'sermon') return `#/sermons/${route.id}`;
  if (route.view !== 'calendar') return `#/library/${route.view || 'covers'}`;
  const params = new URLSearchParams();
  if (route.y && route.m) { params.set('y', String(route.y)); params.set('m', String(route.m)); }
  if (route.d) params.set('d', route.d);
  const query = params.toString();
  return `#/library/calendar${query ? '?' + query : ''}`;
}

export const sermonHref = id => hrefFor({ name: 'sermon', id });
