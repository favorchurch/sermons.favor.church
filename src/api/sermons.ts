/** Sermon masters and version metadata. No source document bytes or storage keys pass through here. */
import { reply } from '../auth/security.ts';
import {
  Conflict, Invalid, auditStatement, changes, intParam, line, lineList, multiline, notFound,
  optionalLine, readBody, type Ctx
} from './http.ts';
import { eventsForSermon } from './events.ts';

type SermonRow = {
  id: string; title: string; series_name: string | null; description?: string | null;
  tags_json: string; refs_json: string; created_at: string; updated_at: string | null; archived_at: string | null;
};

const LIST_COLUMNS = `s.id, s.title, s.series_name, s.tags_json, s.created_at, s.updated_at, s.archived_at,
  (SELECT json_group_array(reference_text) FROM (SELECT r.reference_text FROM sermon_scripture_refs r
    WHERE r.workspace_id = s.workspace_id AND r.sermon_id = s.id ORDER BY r.position)) AS refs_json`;
const DETAIL_COLUMNS = LIST_COLUMNS + ', s.description';

function sermonDto(row: SermonRow) {
  const { refs_json, tags_json, ...rest } = row;
  return { ...rest, scripture_references: JSON.parse(refs_json) as string[], tags: JSON.parse(tags_json) as string[] };
}

async function loadSermon(c: Ctx, id: string): Promise<SermonRow | null> {
  return c.env.DB.prepare(`SELECT ${DETAIL_COLUMNS} FROM sermons s
    WHERE s.workspace_id = ? AND s.id = ? AND s.deleted_at IS NULL`)
    .bind(c.workspaceId, id).first<SermonRow>();
}

const SERMON_FIELDS = ['title', 'scripture_references', 'series_name', 'description', 'tags'] as const;

export async function listSermons(c: Ctx): Promise<Response> {
  const archived = c.url.searchParams.get('archived') ?? 'exclude';
  if (!['exclude', 'include', 'only'].includes(archived)) throw new Invalid('archived');
  const limit = intParam(c.url, 'limit', 50, 1, 100), offset = intParam(c.url, 'offset', 0, 0, 100000);
  const filter = archived === 'exclude' ? ' AND s.archived_at IS NULL' : archived === 'only' ? ' AND s.archived_at IS NOT NULL' : '';
  const rows = await c.env.DB.prepare(`SELECT ${LIST_COLUMNS} FROM sermons s
    WHERE s.workspace_id = ? AND s.deleted_at IS NULL${filter}
    ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`)
    .bind(c.workspaceId, limit, offset).all<SermonRow>();
  return reply(200, { sermons: (rows.results || []).map(sermonDto), limit, offset });
}

export async function getSermon(c: Ctx): Promise<Response> {
  const row = await loadSermon(c, c.params.sermonId);
  if (!row) return notFound();
  const versions = await c.env.DB.prepare(`SELECT ${VERSION_COLUMNS} FROM sermon_versions v
    WHERE v.workspace_id = ? AND v.sermon_id = ? ORDER BY v.created_at, v.id LIMIT 200`)
    .bind(c.workspaceId, row.id).all<VersionRow>();
  const events = await eventsForSermon(c, row.id);
  return reply(200, { ...sermonDto(row), versions: versions.results || [], preaching_events: events });
}

function refStatements(c: Ctx, sermonId: string, refs: string[]): D1PreparedStatement[] {
  return refs.map((text, position) => c.env.DB.prepare(`INSERT INTO sermon_scripture_refs
    (workspace_id, sermon_id, position, reference_text) VALUES (?, ?, ?, ?)`)
    .bind(c.workspaceId, sermonId, position, text));
}

export async function createSermon(c: Ctx): Promise<Response> {
  const body = await readBody(c.request, SERMON_FIELDS);
  const title = line(body.title, 'title', 200);
  const refs = lineList(body.scripture_references, 'scripture_references', 20, 120);
  const id = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO sermons(id, workspace_id, title, scripture_passage, series_name, description, tags_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, c.workspaceId, title, refs.join('; ') || null, optionalLine(body.series_name, 'series_name', 200),
        multiline(body.description, 'description', 4000), JSON.stringify(lineList(body.tags, 'tags', 20, 40, true))),
    ...refStatements(c, id, refs),
    auditStatement(c, 'sermon.create', 'sermon', id)
  ]);
  return reply(201, sermonDto((await loadSermon(c, id))!));
}

export async function updateSermon(c: Ctx): Promise<Response> {
  const body = await readBody(c.request, SERMON_FIELDS);
  const sets: string[] = [], args: unknown[] = [];
  let refs: string[] | null = null;
  if ('title' in body) { sets.push('title = ?'); args.push(line(body.title, 'title', 200)); }
  if ('series_name' in body) { sets.push('series_name = ?'); args.push(optionalLine(body.series_name, 'series_name', 200)); }
  if ('description' in body) { sets.push('description = ?'); args.push(multiline(body.description, 'description', 4000)); }
  if ('tags' in body) { sets.push('tags_json = ?'); args.push(JSON.stringify(lineList(body.tags, 'tags', 20, 40, true))); }
  if ('scripture_references' in body) {
    refs = lineList(body.scripture_references, 'scripture_references', 20, 120);
    sets.push('scripture_passage = ?'); args.push(refs.join('; ') || null);
  }
  if (!sets.length) throw new Invalid('body', 'empty_update');
  const id = c.params.sermonId;
  if (!(await loadSermon(c, id))) return notFound();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE sermons SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`).bind(...args, c.workspaceId, id),
    auditStatement(c, 'sermon.update', 'sermon', id, { fields: Object.keys(body) }, true),
    ...(refs ? [
      c.env.DB.prepare(`DELETE FROM sermon_scripture_refs WHERE workspace_id = ? AND sermon_id = ?`).bind(c.workspaceId, id),
      ...refStatements(c, id, refs)
    ] : [])
  ]);
  if (changes(results[0]) !== 1) return notFound();
  return reply(200, sermonDto((await loadSermon(c, id))!));
}

async function setArchived(c: Ctx, archive: boolean): Promise<Response> {
  const id = c.params.sermonId;
  if (!(await loadSermon(c, id))) return notFound();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE sermons SET archived_at = ${archive ? 'CURRENT_TIMESTAMP' : 'NULL'}, updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL AND archived_at IS ${archive ? 'NULL' : 'NOT NULL'}`)
      .bind(c.workspaceId, id),
    auditStatement(c, archive ? 'sermon.archive' : 'sermon.restore', 'sermon', id, {}, true)
  ]);
  if (changes(results[0]) !== 1) throw new Conflict(archive ? 'already_archived' : 'not_archived');
  return reply(200, sermonDto((await loadSermon(c, id))!));
}

export const archiveSermon = (c: Ctx) => setArchived(c, true);
export const restoreSermon = (c: Ctx) => setArchived(c, false);

// ---- Versions: metadata only. Storage keys and consent identities are never exposed. ----

type VersionRow = {
  id: string; sermon_id: string; label: string; source_type: 'google_doc' | 'pdf' | 'external';
  source_url: string | null; google_document_id: string | null; indexing_state: string;
  created_at: string; updated_at: string | null;
};
const VERSION_COLUMNS = `v.id, v.sermon_id, v.label, v.source_type, v.source_url, v.google_document_id,
  v.indexing_state, v.created_at, v.updated_at`;
const GOOGLE_DOCUMENT_ID = /^[A-Za-z0-9_-]{10,128}$/;

function sourceUrl(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > 2048) throw new Invalid('source_url');
  let url: URL;
  try { url = new URL(value); } catch { throw new Invalid('source_url'); }
  if (url.protocol !== 'https:' || url.username || url.password || /[\u0000- \u007f]/.test(value)) throw new Invalid('source_url');
  return url.href;
}

function googleDocumentId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !GOOGLE_DOCUMENT_ID.test(value)) throw new Invalid('google_document_id');
  return value;
}

/** Source fields must match the version's source type. PDF bytes arrive by a separate upload flow. */
function checkSource(type: VersionRow['source_type'], url: string | null, documentId: string | null): void {
  if (type === 'google_doc' && !documentId) throw new Invalid('google_document_id');
  if (type !== 'google_doc' && documentId) throw new Invalid('google_document_id');
  if (type === 'external' && !url) throw new Invalid('source_url');
  if (type === 'pdf' && url) throw new Invalid('source_url');
}

async function requireSermon(c: Ctx): Promise<string | null> {
  const found = await c.env.DB.prepare(`SELECT id FROM sermons WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`)
    .bind(c.workspaceId, c.params.sermonId).first<{ id: string }>();
  return found?.id ?? null;
}

export async function listVersions(c: Ctx): Promise<Response> {
  const sermonId = await requireSermon(c);
  if (!sermonId) return notFound();
  const rows = await c.env.DB.prepare(`SELECT ${VERSION_COLUMNS} FROM sermon_versions v
    WHERE v.workspace_id = ? AND v.sermon_id = ? ORDER BY v.created_at, v.id LIMIT 200`)
    .bind(c.workspaceId, sermonId).all<VersionRow>();
  return reply(200, { versions: rows.results || [] });
}

async function loadVersion(c: Ctx, sermonId: string, id: string): Promise<VersionRow | null> {
  return c.env.DB.prepare(`SELECT ${VERSION_COLUMNS} FROM sermon_versions v
    WHERE v.workspace_id = ? AND v.sermon_id = ? AND v.id = ?`).bind(c.workspaceId, sermonId, id).first<VersionRow>();
}

export async function createVersion(c: Ctx): Promise<Response> {
  const body = await readBody(c.request, ['label', 'source_type', 'source_url', 'google_document_id']);
  const label = line(body.label, 'label', 120);
  const type = body.source_type;
  if (type !== 'google_doc' && type !== 'pdf' && type !== 'external') throw new Invalid('source_type');
  const url = sourceUrl(body.source_url), documentId = googleDocumentId(body.google_document_id);
  checkSource(type, url, documentId);
  const sermonId = await requireSermon(c);
  if (!sermonId) return notFound();
  const taken = await c.env.DB.prepare(`SELECT 1 AS found FROM sermon_versions
    WHERE workspace_id = ? AND sermon_id = ? AND label = ? COLLATE NOCASE`).bind(c.workspaceId, sermonId, label).first();
  if (taken) throw new Conflict('label_in_use');
  const id = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO sermon_versions(id, workspace_id, sermon_id, label, source_type, source_url, google_document_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id, c.workspaceId, sermonId, label, type, url, documentId),
    auditStatement(c, 'version.create', 'sermon_version', id, { sermon_id: sermonId, source_type: type })
  ]);
  return reply(201, (await loadVersion(c, sermonId, id))!);
}

export async function updateVersion(c: Ctx): Promise<Response> {
  const body = await readBody(c.request, ['label', 'source_url', 'google_document_id']);
  const sermonId = await requireSermon(c);
  const existing = sermonId ? await loadVersion(c, sermonId, c.params.versionId) : null;
  if (!sermonId || !existing) return notFound();
  const sets: string[] = [], args: unknown[] = [];
  if ('label' in body) {
    const label = line(body.label, 'label', 120);
    const taken = await c.env.DB.prepare(`SELECT 1 AS found FROM sermon_versions
      WHERE workspace_id = ? AND sermon_id = ? AND label = ? COLLATE NOCASE AND id <> ?`)
      .bind(c.workspaceId, sermonId, label, existing.id).first();
    if (taken) throw new Conflict('label_in_use');
    sets.push('label = ?'); args.push(label);
  }
  if ('source_url' in body || 'google_document_id' in body) {
    // Consent and indexed text belong to a specific source; repointing it needs the
    // later revoke flow, not a metadata edit.
    if (existing.indexing_state !== 'not_indexed') throw new Conflict('source_locked');
    const url = 'source_url' in body ? sourceUrl(body.source_url) : existing.source_url;
    const documentId = 'google_document_id' in body ? googleDocumentId(body.google_document_id) : existing.google_document_id;
    checkSource(existing.source_type, url, documentId);
    sets.push('source_url = ?', 'google_document_id = ?'); args.push(url, documentId);
  }
  if (!sets.length) throw new Invalid('body', 'empty_update');
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE sermon_versions SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND sermon_id = ? AND id = ?`).bind(...args, c.workspaceId, sermonId, existing.id),
    auditStatement(c, 'version.update', 'sermon_version', existing.id, { sermon_id: sermonId, fields: Object.keys(body) }, true)
  ]);
  if (changes(results[0]) !== 1) return notFound();
  return reply(200, (await loadVersion(c, sermonId, existing.id))!);
}
