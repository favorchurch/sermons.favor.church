// Pure helpers that turn the raw sermon and event lists into what the library shows.
import { parseDay } from './format.js';

const PRECISION_RANK = { exact: 3, needs_review: 3, month: 2, year: 1 };

/** Attach preaching count and the latest dated preaching to each sermon. */
export function summarise(sermons, events) {
  const bySermon = new Map();
  for (const event of events) {
    const list = bySermon.get(event.sermon_id);
    if (list) list.push(event); else bySermon.set(event.sermon_id, [event]);
  }
  return sermons.map(sermon => {
    const own = bySermon.get(sermon.id) || [];
    let last = null;
    for (const event of own) {
      if (!parseDay(event.preached_on) || event.date_precision === 'unknown') continue;
      const better = !last || event.preached_on > last.date ||
        (event.preached_on === last.date && (PRECISION_RANK[event.date_precision] || 0) > (PRECISION_RANK[last.precision] || 0));
      if (better) last = { date: event.preached_on, precision: event.date_precision };
    }
    return { ...sermon, preachCount: own.length, last };
  });
}

const fold = text => String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function matchesQuery(sermon, query) {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const haystack = fold([sermon.title, sermon.series_name, ...(sermon.scripture_references || []), ...(sermon.tags || [])].join(' \n '));
  return terms.every(term => haystack.includes(term));
}

export const SORTS = [['recent', 'Recently preached'], ['title', 'Title A–Z'], ['added', 'Recently added']];

export function filterAndSort(items, { query = '', archive = 'active', sort = 'recent' } = {}) {
  const wantArchived = archive === 'archived';
  const shown = items.filter(item => Boolean(item.archived_at) === wantArchived && matchesQuery(item, query));
  const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);
  const byAdded = (a, b) => (b.created_at || '').localeCompare(a.created_at || '') || a.id.localeCompare(b.id);
  if (sort === 'title') return shown.sort(byTitle);
  if (sort === 'added') return shown.sort(byAdded);
  // Recently preached: dated sermons newest first, never-preached ones after, newest added first.
  return shown.sort((a, b) => {
    if (a.last && b.last) return b.last.date.localeCompare(a.last.date) || byTitle(a, b);
    if (a.last) return -1;
    if (b.last) return 1;
    return byAdded(a, b);
  });
}

export function libraryTotals(items) {
  const active = items.filter(item => !item.archived_at);
  const latest = active.map(item => item.last).filter(Boolean).sort((a, b) => b.date.localeCompare(a.date))[0] || null;
  return {
    sermons: active.length,
    archived: items.length - active.length,
    preachings: active.reduce((sum, item) => sum + item.preachCount, 0),
    latest
  };
}
