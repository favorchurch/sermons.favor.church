/** Places, case-insensitive aliases, and merges with an impact preview and durable history. */
import { reply, isUuid } from '../auth/security.ts';
import {
  Conflict, Invalid, auditStatement, changes, line, notFound, readBody, uuidParam, type Ctx
} from './http.ts';

type PlaceRow = {
  id: string; display_name: string; created_at: string; updated_at: string | null;
  alias_json: string; event_count: number;
};

const PLACE_SELECT = `SELECT p.id, p.display_name, p.created_at, p.updated_at,
    (SELECT json_group_array(alias) FROM (SELECT a.alias FROM place_aliases a
      WHERE a.workspace_id = p.workspace_id AND a.place_id = p.id ORDER BY a.alias COLLATE NOCASE)) AS alias_json,
    (SELECT COUNT(*) FROM preaching_events e WHERE e.workspace_id = p.workspace_id AND e.place_id = p.id) AS event_count
  FROM places p`;

function placeDto(row: PlaceRow) {
  const { alias_json, ...rest } = row;
  return { ...rest, aliases: JSON.parse(alias_json) as string[] };
}

async function loadPlace(c: Ctx, id: string): Promise<PlaceRow | null> {
  return c.env.DB.prepare(`${PLACE_SELECT} WHERE p.workspace_id = ? AND p.id = ?`).bind(c.workspaceId, id).first<PlaceRow>();
}

export async function listPlaces(c: Ctx): Promise<Response> {
  const rows = await c.env.DB.prepare(`${PLACE_SELECT} WHERE p.workspace_id = ? ORDER BY p.display_name COLLATE NOCASE LIMIT 500`)
    .bind(c.workspaceId).all<PlaceRow>();
  return reply(200, { places: (rows.results || []).map(placeDto) });
}

/** A name must not collide with another place's name or alias (ignoring case). */
async function assertNameFree(c: Ctx, name: string, exceptPlaceId: string | null): Promise<void> {
  const taken = await c.env.DB.prepare(`SELECT 1 AS found FROM places
      WHERE workspace_id = ? AND display_name = ? COLLATE NOCASE AND id <> ?
    UNION ALL SELECT 1 FROM place_aliases
      WHERE workspace_id = ? AND alias = ? COLLATE NOCASE AND place_id <> ?`)
    .bind(c.workspaceId, name, exceptPlaceId ?? '', c.workspaceId, name, exceptPlaceId ?? '').first();
  if (taken) throw new Conflict('name_in_use');
}

export async function createPlace(c: Ctx): Promise<Response> {
  const body = await readBody(c.request, ['display_name']);
  const name = line(body.display_name, 'display_name', 120);
  await assertNameFree(c, name, null);
  const id = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO places(id, workspace_id, display_name) VALUES (?, ?, ?)`).bind(id, c.workspaceId, name),
    auditStatement(c, 'place.create', 'place', id)
  ]);
  return reply(201, placeDto((await loadPlace(c, id))!));
}

export async function renamePlace(c: Ctx): Promise<Response> {
  const body = await readBody(c.request, ['display_name']);
  const name = line(body.display_name, 'display_name', 120);
  const id = c.params.placeId;
  if (!(await loadPlace(c, id))) return notFound();
  await assertNameFree(c, name, id);
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE places SET display_name = ?, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ?`)
      .bind(name, c.workspaceId, id),
    auditStatement(c, 'place.rename', 'place', id, {}, true)
  ]);
  if (changes(results[0]) !== 1) return notFound();
  return reply(200, placeDto((await loadPlace(c, id))!));
}

/** Validates the target id shape, then loads it. Null (a bare 404) for a missing or foreign place. */
async function loadMergeTarget(c: Ctx, targetId: unknown): Promise<PlaceRow | null> {
  if (!isUuid(targetId)) throw new Invalid('target_place_id');
  if (targetId === c.params.placeId) throw new Invalid('target_place_id', 'same_place');
  return loadPlace(c, targetId);
}

function impact(source: PlaceRow, target: PlaceRow) {
  const aliases = placeDto(source).aliases;
  return {
    source: { id: source.id, display_name: source.display_name },
    target: { id: target.id, display_name: target.display_name },
    events_to_move: source.event_count,
    aliases_to_move: aliases,
    new_alias: source.display_name,
    resulting_event_count: target.event_count + source.event_count
  };
}

export async function previewPlaceMerge(c: Ctx): Promise<Response> {
  const source = await loadPlace(c, c.params.placeId);
  if (!source) return notFound();
  const targetId = uuidParam(c.url, 'target');
  const target = await loadMergeTarget(c, targetId);
  return target ? reply(200, impact(source, target)) : notFound();
}

export async function mergePlace(c: Ctx): Promise<Response> {
  const body = await readBody(c.request, ['target_place_id']);
  const source = await loadPlace(c, c.params.placeId);
  if (!source) return notFound();
  const target = await loadMergeTarget(c, body.target_place_id);
  if (!target) return notFound();
  const ws = c.workspaceId, from = source.id, to = target.id;
  // One transaction. A second merge of the same source violates UNIQUE(workspace_id,
  // source_place_id) and rolls everything back; a vanished target fails the event foreign key.
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO place_merges(id, workspace_id, source_place_id, source_display_name, target_place_id,
        merged_by_account_id, moved_event_count, moved_aliases_json)
      SELECT ?, p.workspace_id, p.id, p.display_name, ?, ?,
        (SELECT COUNT(*) FROM preaching_events e WHERE e.workspace_id = p.workspace_id AND e.place_id = p.id),
        (SELECT json_group_array(a.alias) FROM place_aliases a WHERE a.workspace_id = p.workspace_id AND a.place_id = p.id)
      FROM places p WHERE p.workspace_id = ? AND p.id = ?`).bind(crypto.randomUUID(), to, c.actorId, ws, from),
    auditStatement(c, 'place.merge', 'place', to, { source_place_id: from, moved_events: source.event_count }, true),
    c.env.DB.prepare(`UPDATE preaching_events SET place_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND place_id = ?`).bind(to, ws, from),
    c.env.DB.prepare(`UPDATE place_aliases SET place_id = ? WHERE workspace_id = ? AND place_id = ?`).bind(to, ws, from),
    c.env.DB.prepare(`INSERT OR IGNORE INTO place_aliases(workspace_id, place_id, alias)
      SELECT workspace_id, target_place_id, source_display_name FROM place_merges
      WHERE workspace_id = ? AND source_place_id = ?`).bind(ws, from),
    c.env.DB.prepare(`UPDATE place_merges SET target_place_id = ? WHERE workspace_id = ? AND target_place_id = ?`).bind(to, ws, from),
    c.env.DB.prepare(`DELETE FROM places WHERE workspace_id = ? AND id = ?`).bind(ws, from)
  ]);
  if (changes(results[0]) !== 1) throw new Conflict('place_changed');
  return reply(200, { merged: true, place: placeDto((await loadPlace(c, to))!) });
}
