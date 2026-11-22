// Pure helpers for search results: highlight ranges, scope filtering and plain-language reasons.

/**
 * Split `text` into plain and marked pieces. `highlights` are `{start, end}` offsets (UTF-16 code
 * units, so plain string indexes) inside `text`. Bad, empty or overlapping ranges are dropped or
 * merged, so a malformed response can never throw or repeat text.
 */
export function highlightParts(text, highlights) {
  const value = typeof text === 'string' ? text : '';
  const ranges = (Array.isArray(highlights) ? highlights : [])
    .filter(r => r && Number.isInteger(r.start) && Number.isInteger(r.end) && r.start >= 0 && r.end > r.start && r.start < value.length)
    .map(r => ({ start: r.start, end: Math.min(r.end, value.length) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  const parts = [];
  let at = 0;
  for (const { start, end } of merged) {
    if (start > at) parts.push({ text: value.slice(at, start), mark: false });
    parts.push({ text: value.slice(start, end), mark: true });
    at = end;
  }
  if (at < value.length) parts.push({ text: value.slice(at), mark: false });
  return parts;
}

/**
 * Which requests a scope needs. Everything and Bible verses ask for the quick sermon matches and the
 * deep note matches together. Inside notes needs only the deep pass.
 */
export const stagesFor = scope => ({ quick: scope !== 'notes', deep: true });

const ready = stage => stage?.phase === 'ready';
const waiting = stage => !stage || stage.phase === 'loading';
const items = (stage, key) => (ready(stage) && Array.isArray(stage.data?.[key]) ? stage.data[key] : []);

export const MATCH_FIELDS = { title: 'title', series: 'series', scripture: 'Scripture', tags: 'tags', passage: 'passage' };

/** "Matched in title and tags": the fields a quick result matched on, in plain words. */
export function matchedOn(fields) {
  const names = (Array.isArray(fields) ? fields : []).map(field => MATCH_FIELDS[field]).filter(Boolean);
  if (!names.length) return '';
  return 'Matched in ' + (names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0]);
}

/**
 * What the page shows for a scope, given each stage's state ({phase, data?, error?} or null when it was
 * not asked for). A stage that is loading or failed contributes nothing but never hides the other one.
 * "Bible verses" needs a reference, known from whichever stage answered first.
 */
export function shapeSearch({ scope, quick, deep, q = '' }) {
  const query = (ready(quick) ? quick : ready(deep) ? deep : null)?.data?.query;
  const reference = query?.kind === 'reference';
  const needsReference = scope === 'bible' && Boolean(query) && !reference;
  const showSermons = scope !== 'notes';
  const sermons = showSermons ? items(quick, 'matches') : [];
  const notes = items(deep, 'notesMatches');
  const pending = (showSermons && waiting(quick)) || waiting(deep);
  const label = reference ? `Bible reference ${query.label}` : `“${q}”`;
  const total = sermons.length + notes.length;
  const summary = `${total} ${total === 1 ? 'result' : 'results'}${pending ? ' so far' : ''} for ${label}`;
  const notice = needsReference ? `“${q}” is not a Bible reference. Try a reference like John 3:16, or switch to Everything.` : '';
  return { reference, needsReference, notice, showSermons, sermons, notes, pending, label, total, summary };
}

export const NOTE_REASONS = {
  pending: 'Waiting for an Owner to consent before this version can be searched.',
  revoked: 'Access was revoked, so its text has been removed from search.',
  unindexed: 'No searchable text yet. The text has not been indexed.'
};
export const noteReason = reason => NOTE_REASONS[reason] || 'This version cannot be searched.';

export const VERSION_STATUS = {
  matched: ['Found in notes', 'good'],
  not_in_notes: ['Not in notes', 'neutral'],
  not_searchable: ['Not searchable', 'warn']
};

/** True when a stage hit the server's cap, so there may be more than is shown. */
export function truncated(stage, key) {
  const limit = Number.isInteger(stage?.data?.limit) ? stage.data.limit : Infinity;
  return items(stage, key).length >= limit;
}
