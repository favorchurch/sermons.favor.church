/**
 * Notes index: consent-gated indexing of extracted note text, purge, and search over the
 * indexed text and its Bible reference tokens. Every read is scoped to one workspace and
 * only sees versions that are `indexed` with stored text.
 *
 * Offsets are UTF-16 code unit indexes (JavaScript string indexes) into the stored body.
 */
import { extractReferences, overlaps, parseReference, formatReference, type BibleReference } from './bible.ts';

export const MAX_NOTE_CHARS = 400_000;
const MAX_REFERENCES = 5000;
export const MAX_QUERY_CHARS = 200;
export const MAX_QUERY_WORDS = 12;
const EXCERPT_BEFORE = 80;
const EXCERPT_AFTER = 120;

export type RefusalCode = 'version_not_found' | 'consent_required' | 'empty_text' | 'text_too_large';

/** Thrown when indexing is refused. Never carries note text. */
export class IndexRefused extends Error {
  code: RefusalCode;
  constructor(code: RefusalCode) {
    super(code);
    this.code = code;
  }
}

/** Version row conditions that make indexing allowed: an active Owner consented, source not revoked. */
const CONSENTED = `v.index_consent_at IS NOT NULL AND v.indexing_state IN ('queued', 'indexed')
  AND EXISTS (SELECT 1 FROM workspace_memberships m WHERE m.workspace_id = v.workspace_id
    AND m.account_id = v.index_consent_by AND m.role = 'owner'
    AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL)
  AND EXISTS (SELECT 1 FROM sermons s WHERE s.workspace_id = v.workspace_id AND s.id = v.sermon_id AND s.deleted_at IS NULL)`;

const changed = (result: D1Result | undefined): number => result?.meta?.changes ?? 0;

/**
 * Replace the index for one version. Refuses unless the version exists in the workspace and
 * an active Owner consented. The consent check is repeated inside the write, so a consent
 * revoked between check and write stores nothing. Marks the version `indexed`.
 */
export async function indexVersion(db: D1Database, input: {
  workspaceId: string; versionId: string; text: string; actorId?: string | null;
}): Promise<{ characters: number; references: number }> {
  const { workspaceId, versionId } = input;
  const version = await db.prepare(`SELECT 1 AS found FROM sermon_versions v WHERE v.workspace_id = ? AND v.id = ?`)
    .bind(workspaceId, versionId).first();
  if (!version) throw new IndexRefused('version_not_found');
  const allowed = await db.prepare(`SELECT 1 AS found FROM sermon_versions v WHERE v.workspace_id = ? AND v.id = ? AND ${CONSENTED}`)
    .bind(workspaceId, versionId).first();
  if (!allowed) throw new IndexRefused('consent_required');

  const body = typeof input.text === 'string' ? input.text.normalize('NFC').replace(/\r\n?/g, '\n').trim() : '';
  if (!body) throw new IndexRefused('empty_text');
  if (body.length > MAX_NOTE_CHARS) throw new IndexRefused('text_too_large');

  const references = extractReferences(body).slice(0, MAX_REFERENCES).map(ref => ({
    book: ref.book, chapter: ref.chapter, verse_start: ref.verseStart, verse_end: ref.verseEnd,
    text_start: ref.start, text_end: ref.end
  }));

  const results = await db.batch([
    db.prepare(`DELETE FROM note_texts WHERE workspace_id = ? AND version_id = ?`).bind(workspaceId, versionId),
    db.prepare(`INSERT INTO note_texts(workspace_id, sermon_id, version_id, body, consent_at)
      SELECT v.workspace_id, v.sermon_id, v.id, ?, v.index_consent_at FROM sermon_versions v
      WHERE v.workspace_id = ? AND v.id = ? AND ${CONSENTED}`).bind(body, workspaceId, versionId),
    db.prepare(`INSERT INTO note_reference_tokens(workspace_id, version_id, book, chapter, verse_start, verse_end, text_start, text_end, consent_at)
      SELECT t.workspace_id, t.version_id, json_extract(j.value, '$.book'), json_extract(j.value, '$.chapter'),
        json_extract(j.value, '$.verse_start'), json_extract(j.value, '$.verse_end'),
        json_extract(j.value, '$.text_start'), json_extract(j.value, '$.text_end'), t.consent_at
      FROM note_texts t, json_each(?) j WHERE t.workspace_id = ? AND t.version_id = ?`)
      .bind(JSON.stringify(references), workspaceId, versionId),
    db.prepare(`UPDATE sermon_versions SET indexing_state = 'indexed', updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND id = ? AND EXISTS (SELECT 1 FROM note_texts t WHERE t.workspace_id = ? AND t.version_id = ?)`)
      .bind(workspaceId, versionId, workspaceId, versionId),
    db.prepare(`INSERT INTO audit_events(id, workspace_id, actor_account_id, action, target_type, target_id, details_json)
      SELECT ?, ?, ?, 'version.index', 'sermon_version', ?, ? WHERE changes() = 1`)
      .bind(crypto.randomUUID(), workspaceId, input.actorId ?? null, versionId,
        JSON.stringify({ characters: body.length, references: references.length }))
  ]);
  if (changed(results[1]) !== 1) throw new IndexRefused('consent_required');
  return { characters: body.length, references: references.length };
}

/**
 * Delete every stored word, token and full-text entry for a version. Callers that revoke
 * consent also set the version state; search ignores any version that is not `indexed`.
 */
export async function purgeVersionIndex(db: D1Database, workspaceId: string, versionId: string): Promise<boolean> {
  const results = await db.batch([
    db.prepare(`DELETE FROM note_reference_tokens WHERE workspace_id = ? AND version_id = ?`).bind(workspaceId, versionId),
    db.prepare(`DELETE FROM note_texts WHERE workspace_id = ? AND version_id = ?`).bind(workspaceId, versionId)
  ]);
  return changed(results[1]) > 0;
}

// ---- Query parsing ----

export type SearchQuery =
  | { kind: 'reference'; reference: BibleReference; label: string }
  | { kind: 'text'; terms: string[]; match: string; label: string };

// Mirrors the FTS5 unicode61 tokenizer: letters, numbers, private use and Latin combining marks.
const WORD = /[\p{L}\p{N}\p{Co}̀-ͯ]+/gu;
const fold = (word: string): string => word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

type Word = { term: string; start: number; end: number };

function wordsOf(text: string): Word[] {
  const out: Word[] = [];
  for (const m of text.matchAll(WORD)) {
    const term = fold(m[0]);
    // FTS5 skips tokens that fold to nothing (stray combining marks); so does phrase verification.
    if (term) out.push({ term, start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

/**
 * Turn user input into a search. A Bible reference ("Jn 3:16") searches by canonical
 * range. Anything else is one phrase of its words. Operators, quotes, prefix stars and
 * column filters are never passed to FTS5: each word is folded to letters and digits and
 * the whole phrase is double-quoted. Returns null when nothing searchable remains.
 */
export function parseSearchQuery(raw: string): SearchQuery | null {
  if (raw.length > MAX_QUERY_CHARS) return null;
  const text = raw.normalize('NFC').trim();
  const reference = parseReference(text);
  if (reference) return { kind: 'reference', reference, label: formatReference(reference) };
  const terms = wordsOf(text).map(word => word.term);
  if (!terms.length || terms.length > MAX_QUERY_WORDS) return null;
  // FTS5 gets the raw word runs so it folds them exactly as it folded the stored body; `terms`
  // (folded here) only verify phrases. Runs hold letters and digits, so they cannot contain a quote.
  const runs = [...text.matchAll(WORD)].map(m => m[0]).filter(run => fold(run));
  return { kind: 'text', terms, match: `"${runs.join(' ')}"`, label: terms.join(' ') };
}

// ---- Excerpts ----

export type Highlight = { start: number; end: number };
export type Excerpt = { text: string; text_offset: number; highlights: Highlight[] };
type Span = { start: number; end: number };

const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** Excerpt around `spans[index]`. Highlights are offsets within `text`, covering every span in the window. */
function excerptAround(body: string, spans: Span[], index: number): Excerpt {
  const focus = spans[index];
  let from = Math.max(0, focus.start - EXCERPT_BEFORE), to = Math.min(body.length, focus.end + EXCERPT_AFTER);
  if (from > 0 && isLowSurrogate(body.charCodeAt(from))) from--;
  if (to < body.length && isLowSurrogate(body.charCodeAt(to))) to++;
  const highlights = spans.filter(s => s.end > from && s.start < to)
    .map(s => ({ start: Math.max(s.start, from) - from, end: Math.min(s.end, to) - from }));
  return { text: body.slice(from, to), text_offset: from, highlights };
}

/** Occurrences of the phrase in `body`, as non-overlapping spans. */
function phraseSpans(body: string, terms: string[]): Span[] {
  const words = wordsOf(body), spans: Span[] = [];
  for (let i = 0; i + terms.length <= words.length; i++) {
    if (terms.every((term, k) => words[i + k].term === term)) {
      spans.push({ start: words[i].start, end: words[i + terms.length - 1].end });
      i += terms.length - 1;
    }
  }
  return spans;
}

// ---- Search ----

export type NoteHit = {
  sermon_id: string; sermon_title: string; version_id: string; version_label: string;
  source_type: string; match_count: number; offset: number; excerpts: Excerpt[];
};

export type NoteSearchOptions = { sermonId?: string; includeArchived?: boolean; limit: number; maxExcerpts: number };

type HitRow = {
  sermon_id: string; title: string; version_id: string; label: string; source_type: string; body: string; spans_json?: string;
};

/** A version is searchable only while indexed, consented and holding stored text. */
const SEARCHABLE = `v.indexing_state = 'indexed' AND t.consent_at IS NOT NULL AND s.deleted_at IS NULL`;

function scope(options: NoteSearchOptions): { sql: string; args: unknown[] } {
  let sql = options.includeArchived ? '' : ' AND s.archived_at IS NULL';
  const args: unknown[] = [];
  if (options.sermonId) { sql += ' AND t.sermon_id = ?'; args.push(options.sermonId); }
  return { sql, args };
}

const JOINS = `JOIN sermon_versions v ON v.workspace_id = t.workspace_id AND v.id = t.version_id
  JOIN sermons s ON s.workspace_id = t.workspace_id AND s.id = t.sermon_id`;
const COLUMNS = `t.sermon_id, s.title, t.version_id, v.label, v.source_type, t.body`;

function toHit(row: HitRow, spans: Span[], maxExcerpts: number): NoteHit | null {
  const valid = spans.filter(s => Number.isInteger(s.start) && Number.isInteger(s.end) && s.start >= 0 && s.end > s.start && s.end <= row.body.length)
    .sort((a, b) => a.start - b.start);
  if (!valid.length) return null;
  return {
    sermon_id: row.sermon_id, sermon_title: row.title, version_id: row.version_id, version_label: row.label,
    source_type: row.source_type, match_count: valid.length, offset: valid[0].start,
    excerpts: valid.slice(0, maxExcerpts).map((_, i) => excerptAround(row.body, valid, i))
  };
}

/**
 * Matches in indexed note text for one workspace. Text queries must contain the phrase's
 * words in order in the stored text (FTS5 finds candidates and the phrase is re-verified
 * against the body). Reference queries use the overlap of canonical ranges.
 */
export async function searchNotes(
  db: D1Database, workspaceId: string, query: SearchQuery, options: NoteSearchOptions
): Promise<NoteHit[]> {
  const { sql: scopeSql, args: scopeArgs } = scope(options);
  if (query.kind === 'text') {
    const rows = await db.prepare(`SELECT ${COLUMNS} FROM note_fts JOIN note_texts t ON t.id = note_fts.rowid ${JOINS}
      WHERE note_fts MATCH ? AND t.workspace_id = ? AND ${SEARCHABLE}${scopeSql}
      ORDER BY bm25(note_fts), t.id LIMIT ?`)
      .bind(query.match, workspaceId, ...scopeArgs, options.limit).all<HitRow>();
    return (rows.results || []).flatMap(row => toHit(row, phraseSpans(row.body, query.terms), options.maxExcerpts) ?? []);
  }
  const ref = query.reference;
  const start = ref.verseStart, end = ref.verseEnd ?? ref.verseStart;
  const rows = await db.prepare(`WITH hits AS (
      SELECT r.version_id, count(*) AS n, json_group_array(json_array(r.text_start, r.text_end)) AS spans_json
      FROM note_reference_tokens r
      WHERE r.workspace_id = ? AND r.book = ? AND r.chapter = ?
        AND (? IS NULL OR r.verse_start IS NULL OR (r.verse_start <= ? AND ? <= r.verse_end))
      GROUP BY r.version_id)
    SELECT ${COLUMNS}, h.spans_json FROM hits h
    JOIN note_texts t ON t.workspace_id = ? AND t.version_id = h.version_id ${JOINS}
    WHERE ${SEARCHABLE}${scopeSql}
    ORDER BY h.n DESC, t.id LIMIT ?`)
    .bind(workspaceId, ref.book, ref.chapter, start, end, start, workspaceId, ...scopeArgs, options.limit).all<HitRow>();
  return (rows.results || []).flatMap(row => {
    const pairs = JSON.parse(row.spans_json || '[]') as [number, number][];
    return toHit(row, pairs.map(([s, e]) => ({ start: s, end: e })), options.maxExcerpts) ?? [];
  });
}

export type PassageHit = { sermon_id: string; title: string; passage: string };

/** Sermons whose own scripture passage metadata overlaps the reference. Never reads note text. */
export async function searchPassages(
  db: D1Database, workspaceId: string, reference: BibleReference, options: { includeArchived?: boolean; limit: number }
): Promise<PassageHit[]> {
  const rows = await db.prepare(`SELECT s.id, s.title, r.reference_text FROM sermon_scripture_refs r
    JOIN sermons s ON s.workspace_id = r.workspace_id AND s.id = r.sermon_id
    WHERE r.workspace_id = ? AND s.deleted_at IS NULL${options.includeArchived ? '' : ' AND s.archived_at IS NULL'}
    ORDER BY s.created_at DESC, s.id DESC, r.position`)
    .bind(workspaceId).all<{ id: string; title: string; reference_text: string }>();
  const seen = new Set<string>(), hits: PassageHit[] = [];
  for (const row of rows.results || []) {
    if (hits.length >= options.limit) break;
    if (seen.has(row.id)) continue;
    if (!extractReferences(row.reference_text).some(found => overlaps(found, reference))) continue;
    seen.add(row.id);
    hits.push({ sermon_id: row.id, title: row.title, passage: row.reference_text });
  }
  return hits;
}

// ---- Per-version status ----

export type VersionStatus =
  | { status: 'matched'; match_count: number; excerpts: Excerpt[] }
  | { status: 'not_in_notes'; match_count: 0 }
  | { status: 'not_searchable'; reason: 'pending' | 'revoked' | 'unindexed' };

export type VersionReport = { version_id: string; label: string; source_type: string } & VersionStatus;

/** Why a version cannot be searched, or null when it can. */
function unsearchableReason(state: string, hasText: boolean): 'pending' | 'revoked' | 'unindexed' | null {
  if (state === 'revoked') return 'revoked';
  if (state === 'awaiting_consent' || state === 'queued') return 'pending';
  if (state === 'indexed' && hasText) return null;
  return 'unindexed';
}

/**
 * Find-in-notes for one sermon: every version reports matched, not_in_notes or
 * not_searchable. A version that is not searchable never carries an excerpt or count.
 */
export async function findInSermonNotes(
  db: D1Database, workspaceId: string, sermonId: string, query: SearchQuery, maxExcerpts: number
): Promise<VersionReport[]> {
  const versions = await db.prepare(`SELECT v.id, v.label, v.source_type, v.indexing_state,
      EXISTS (SELECT 1 FROM note_texts t WHERE t.workspace_id = v.workspace_id AND t.version_id = v.id AND t.consent_at IS NOT NULL) AS has_text
    FROM sermon_versions v WHERE v.workspace_id = ? AND v.sermon_id = ? ORDER BY v.created_at, v.id LIMIT 200`)
    .bind(workspaceId, sermonId).all<{ id: string; label: string; source_type: string; indexing_state: string; has_text: number }>();
  const rows = versions.results || [];
  const hits = new Map<string, NoteHit>();
  if (rows.some(row => unsearchableReason(row.indexing_state, !!row.has_text) === null)) {
    for (const hit of await searchNotes(db, workspaceId, query, { sermonId, includeArchived: true, limit: 200, maxExcerpts }))
      hits.set(hit.version_id, hit);
  }
  return rows.map(row => {
    const base = { version_id: row.id, label: row.label, source_type: row.source_type };
    const reason = unsearchableReason(row.indexing_state, !!row.has_text);
    if (reason) return { ...base, status: 'not_searchable' as const, reason };
    const hit = hits.get(row.id);
    return hit
      ? { ...base, status: 'matched' as const, match_count: hit.match_count, excerpts: hit.excerpts }
      : { ...base, status: 'not_in_notes' as const, match_count: 0 as const };
  });
}
