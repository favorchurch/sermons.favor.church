/**
 * Search routes. Read-only, so every active workspace member (Viewer included) may call
 * them. The workspace id comes from the verified Ctx and scopes every query; ids from
 * other workspaces resolve to 404 with no counts.
 */
import { reply } from '../auth/security.ts';
import { Invalid, intParam, notFound, type Ctx } from '../api/http.ts';
import {
  findInSermonNotes, parseSearchQuery, searchNotes, searchPassages, type SearchQuery
} from './index.ts';

function queryParam(c: Ctx): SearchQuery {
  const raw = c.url.searchParams.get('q');
  if (raw === null) throw new Invalid('q', 'missing_query');
  const parsed = parseSearchQuery(raw);
  if (!parsed) throw new Invalid('q');
  return parsed;
}

const queryInfo = (query: SearchQuery) => ({ kind: query.kind, label: query.label });

/**
 * GET /search?q=&archived=exclude|include&limit=
 * `metadataMatches`: sermons whose own scripture passage overlaps a reference query.
 * `notesMatches`: indexed versions whose note text contains the phrase or reference.
 * A sermon whose passage overlaps but whose notes do not appears only in metadataMatches.
 */
export async function search(c: Ctx): Promise<Response> {
  const query = queryParam(c);
  const archived = c.url.searchParams.get('archived') ?? 'exclude';
  if (archived !== 'exclude' && archived !== 'include') throw new Invalid('archived');
  const limit = intParam(c.url, 'limit', 20, 1, 50);
  const includeArchived = archived === 'include';

  const [metadata, notes] = await Promise.all([
    query.kind === 'reference'
      ? searchPassages(c.env.DB, c.workspaceId, query.reference, { includeArchived, limit })
      : Promise.resolve([]),
    searchNotes(c.env.DB, c.workspaceId, query, { includeArchived, limit, maxExcerpts: 1 })
  ]);
  return reply(200, {
    query: queryInfo(query),
    metadataMatches: metadata.map(hit => ({
      sermon_id: hit.sermon_id, sermon_title: hit.title, source: 'sermon_passage', label: 'Sermon passage', passage: hit.passage
    })),
    notesMatches: notes.map(hit => ({
      sermon_id: hit.sermon_id, sermon_title: hit.sermon_title, version_id: hit.version_id,
      version_label: hit.version_label, source_type: hit.source_type, match_count: hit.match_count,
      offset: hit.offset, excerpt: hit.excerpts[0]
    })),
    limit
  });
}

/** GET /sermons/:sermonId/find-in-notes?q= : per-version matched, not_in_notes or not_searchable. */
export async function findInNotes(c: Ctx): Promise<Response> {
  const query = queryParam(c);
  const sermon = await c.env.DB.prepare(`SELECT id FROM sermons WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`)
    .bind(c.workspaceId, c.params.sermonId).first<{ id: string }>();
  if (!sermon) return notFound();
  const versions = await findInSermonNotes(c.env.DB, c.workspaceId, sermon.id, query, 10);
  return reply(200, { sermon_id: sermon.id, query: queryInfo(query), versions });
}
