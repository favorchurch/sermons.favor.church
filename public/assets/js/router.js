// Hash routes, so the server only ever needs to serve "/" and the app never needs a
// route table of its own on the Worker:
//   #/library/covers | rows | table | calendar?y=2026&m=10&d=2026-10-04
//   #/sermons/<uuid>[?tab=notes&q=grace]
//   #/search?q=grace&scope=everything|bible|notes[&archived=1]
//   #/settings/places | people | import[?batch=<uuid>] | docs[?sermon=<uuid>] | workspace
import { parseDay } from './format.js';
import { MAX_YEAR, MIN_YEAR } from './calendar-model.js';

export const VIEWS = ['covers', 'rows', 'table', 'calendar'];
export const VIEW_LABELS = { covers: 'Covers', rows: 'Quick rows', table: 'Table', calendar: 'Calendar' };
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
export const SCOPES = [['everything', 'Everything'], ['bible', 'Bible verses'], ['notes', 'Inside notes']];
export const SETTINGS_SECTIONS = [
  ['places', 'Places'], ['people', 'People & Access'], ['import', 'Import Review'], ['docs', 'Docs & Privacy'], ['workspace', 'Workspace']
];
export const MAX_QUERY = 200;
export const isUuid = value => typeof value === 'string' && UUID.test(value);

function intIn(value, min, max) {
  return /^\d{1,4}$/.test(value ?? '') && Number(value) >= min && Number(value) <= max ? Number(value) : null;
}

/** Search text from the address: single line, trimmed, bounded. */
export function cleanQuery(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY);
}

export function parseRoute(hash) {
  const raw = String(hash || '').replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  const params = new URLSearchParams(query);
  if (parts[0] === 'sermons') {
    if (!isUuid(parts[1]) || parts.length !== 2) return { name: 'missing' };
    const id = parts[1].toLowerCase();
    return params.get('tab') === 'notes' ? { name: 'sermon', id, tab: 'notes', q: cleanQuery(params.get('q')) } : { name: 'sermon', id };
  }
  if (parts[0] === 'search') {
    if (parts.length > 1) return { name: 'missing' };
    const scope = params.get('scope');
    return {
      name: 'search', q: cleanQuery(params.get('q')), scope: SCOPES.some(([key]) => key === scope) ? scope : 'everything',
      archived: params.get('archived') === '1'
    };
  }
  if (parts[0] === 'settings') {
    const section = parts[1] ?? 'places';
    if (parts.length > 2 || !SETTINGS_SECTIONS.some(([key]) => key === section)) return { name: 'missing' };
    const route = { name: 'settings', section };
    const uuid = params.get(section === 'import' ? 'batch' : 'sermon');
    if (section === 'import') route.batch = isUuid(uuid) ? uuid.toLowerCase() : null;
    if (section === 'docs') route.sermon = isUuid(uuid) ? uuid.toLowerCase() : null;
    return route;
  }
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
  if (route.name === 'sermon') {
    return route.tab === 'notes' ? `#/sermons/${route.id}?${new URLSearchParams({ tab: 'notes', q: route.q ?? '' })}` : `#/sermons/${route.id}`;
  }
  if (route.name === 'search') {
    const params = new URLSearchParams({ q: route.q ?? '', scope: route.scope || 'everything' });
    if (route.archived) params.set('archived', '1');
    return `#/search?${params}`;
  }
  if (route.name === 'settings') {
    const extra = route.section === 'import' && route.batch ? `?batch=${route.batch}` : route.section === 'docs' && route.sermon ? `?sermon=${route.sermon}` : '';
    return `#/settings/${route.section || 'places'}${extra}`;
  }
  if (route.view !== 'calendar') return `#/library/${route.view || 'covers'}`;
  const params = new URLSearchParams();
  if (route.y && route.m) { params.set('y', String(route.y)); params.set('m', String(route.m)); }
  if (route.d) params.set('d', route.d);
  const query = params.toString();
  return `#/library/calendar${query ? '?' + query : ''}`;
}

export const sermonHref = id => hrefFor({ name: 'sermon', id });
export const notesHref = (id, q) => hrefFor({ name: 'sermon', id, tab: 'notes', q });
