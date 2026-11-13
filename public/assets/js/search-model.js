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
 * Pick what a scope shows. Passage matches (metadata) only exist for Bible references and never
 * read note text. "Inside notes" hides them. "Bible verses" needs a reference.
 */
export function shapeResults(data, scope) {
  const metadata = Array.isArray(data?.metadataMatches) ? data.metadataMatches : [];
  const notes = Array.isArray(data?.notesMatches) ? data.notesMatches : [];
  const reference = data?.query?.kind === 'reference';
  if (scope === 'bible' && !reference) return { reference, needsReference: true, metadata: [], notes: [], showMetadata: false };
  const showMetadata = scope !== 'notes' && reference;
  return { reference, needsReference: false, showMetadata, metadata: showMetadata ? metadata : [], notes };
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

/** True when a group hit the server's cap, so there may be more than is shown. */
export function truncated(data) {
  const limit = Number.isInteger(data?.limit) ? data.limit : Infinity;
  return (data?.metadataMatches?.length ?? 0) >= limit || (data?.notesMatches?.length ?? 0) >= limit;
}
