/** Preaching events and the year/month calendar queries. Dates stay date-only strings, never timestamps. */
import { reply } from '../auth/security.ts';
import {
  Invalid, auditStatement, changes, intParam, notFound, optionalLine, readBody, uuidOrNull, uuidParam, type Ctx
} from './http.ts';

const PRECISIONS = ['exact', 'month', 'year', 'unknown', 'needs_review'] as const;
type Precision = typeof PRECISIONS[number];

type EventRow = {
  id: string; sermon_id: string; version_id: string | null; place_id: string | null;
  preached_on: string | null; raw_date: string | null; date_precision: Precision; occasion: string | null;
  created_at: string; updated_at: string | null;
  sermon_title: string; sermon_archived: number; place_name: string | null; version_label: string | null;
};

const EVENT_SELECT = `SELECT e.id, e.sermon_id, e.version_id, e.place_id, e.preached_on, e.raw_date,
    e.date_precision, e.occasion, e.created_at, e.updated_at,
    s.title AS sermon_title, s.archived_at IS NOT NULL AS sermon_archived,
    p.display_name AS place_name, v.label AS version_label
  FROM preaching_events e
  JOIN sermons s ON s.workspace_id = e.workspace_id AND s.id = e.sermon_id AND s.deleted_at IS NULL
  LEFT JOIN places p ON p.workspace_id = e.workspace_id AND p.id = e.place_id
  LEFT JOIN sermon_versions v ON v.workspace_id = e.workspace_id AND v.id = e.version_id`;

const ORDER = ' ORDER BY e.preached_on IS NULL, e.preached_on, e.created_at, e.id';

function eventDto(row: EventRow) {
  return { ...row, sermon_archived: Boolean(row.sermon_archived) };
}

function validDay(year: number, month: number, day: number): boolean {
  return year >= 1900 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 &&
    day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Resolve a client date and optional precision into the stored pair. 'YYYY' and 'YYYY-MM'
 * are stored as the first day of the period so range queries stay plain string compares.
 * Without an explicit precision it is inferred from the shape of the date.
 */
export function normalizeWhen(preachedOn: unknown, precision: unknown): { preached_on: string | null; date_precision: Precision } {
  let stored: string | null = null;
  let shape: 'day' | 'month' | 'year' | null = null;
  let firstOfMonth = false, firstOfYear = false;
  if (preachedOn !== null && preachedOn !== undefined) {
    const match = typeof preachedOn === 'string' ? /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(preachedOn) : null;
    if (!match) throw new Invalid('preached_on');
    const year = Number(match[1]), month = match[2] ? Number(match[2]) : 1, day = match[3] ? Number(match[3]) : 1;
    if (!validDay(year, month, day)) throw new Invalid('preached_on');
    shape = match[3] ? 'day' : match[2] ? 'month' : 'year';
    firstOfMonth = day === 1;
    firstOfYear = month === 1 && day === 1;
    stored = `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  if (precision === undefined || precision === null) {
    const inferred: Precision = shape === null ? 'unknown' : shape === 'day' ? 'exact' : shape;
    return { preached_on: stored, date_precision: inferred };
  }
  if (!PRECISIONS.includes(precision as Precision)) throw new Invalid('date_precision');
  const chosen = precision as Precision;
  const consistent =
    chosen === 'unknown' ? shape === null :
    chosen === 'exact' ? shape === 'day' :
    chosen === 'month' ? shape === 'month' || (shape === 'day' && firstOfMonth) :
    chosen === 'year' ? shape === 'year' || (shape === 'day' && firstOfYear) :
    shape === null || shape === 'day';
  if (!consistent) throw new Invalid('date_precision', 'precision_mismatch');
  return { preached_on: stored, date_precision: chosen };
}

async function loadEvent(c: Ctx, id: string): Promise<EventRow | null> {
  return c.env.DB.prepare(`${EVENT_SELECT} WHERE e.workspace_id = ? AND e.id = ?`).bind(c.workspaceId, id).first<EventRow>();
}

export async function eventsForSermon(c: Ctx, sermonId: string): Promise<ReturnType<typeof eventDto>[]> {
  const rows = await c.env.DB.prepare(`${EVENT_SELECT} WHERE e.workspace_id = ? AND e.sermon_id = ?${ORDER} LIMIT 500`)
    .bind(c.workspaceId, sermonId).all<EventRow>();
  return (rows.results || []).map(eventDto);
}

/** Calendar and filtered list. `year` alone covers the year; with `month` it covers that month. */
export async function listEvents(c: Ctx): Promise<Response> {
  const year = c.url.searchParams.has('year') ? intParam(c.url, 'year', 0, 1900, 2100) : null;
  const month = c.url.searchParams.has('month') ? intParam(c.url, 'month', 0, 1, 12) : null;
  if (month !== null && year === null) throw new Invalid('year');
  const sermonId = uuidParam(c.url, 'sermon_id'), placeId = uuidParam(c.url, 'place_id');
  const limit = intParam(c.url, 'limit', 500, 1, 1000), offset = intParam(c.url, 'offset', 0, 0, 100000);
  // A filter id must resolve inside this workspace; missing and foreign ids both give the bare 404.
  if (sermonId && !(await c.env.DB.prepare(`SELECT 1 AS found FROM sermons WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`)
    .bind(c.workspaceId, sermonId).first())) return notFound();
  if (placeId && !(await c.env.DB.prepare(`SELECT 1 AS found FROM places WHERE workspace_id = ? AND id = ?`)
    .bind(c.workspaceId, placeId).first())) return notFound();
  const where = ['e.workspace_id = ?'], args: unknown[] = [c.workspaceId];
  if (year !== null) {
    const from = month === null ? `${year}-01-01` : `${year}-${String(month).padStart(2, '0')}-01`;
    const to = month === null ? `${year + 1}-01-01` : month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
    where.push('e.preached_on >= ?', 'e.preached_on < ?');
    args.push(from, to);
    // A year-only or undated event has no month, so it must not appear inside one.
    if (month !== null) where.push(`e.date_precision IN ('exact', 'month', 'needs_review')`);
  }
  if (sermonId) { where.push('e.sermon_id = ?'); args.push(sermonId); }
  if (placeId) { where.push('e.place_id = ?'); args.push(placeId); }
  const rows = await c.env.DB.prepare(`${EVENT_SELECT} WHERE ${where.join(' AND ')}${ORDER} LIMIT ? OFFSET ?`)
    .bind(...args, limit, offset).all<EventRow>();
  return reply(200, { events: (rows.results || []).map(eventDto), limit, offset });
}

export async function listSermonEvents(c: Ctx): Promise<Response> {
  const found = await c.env.DB.prepare(`SELECT id FROM sermons WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`)
    .bind(c.workspaceId, c.params.sermonId).first();
  if (!found) return notFound();
  return reply(200, { events: await eventsForSermon(c, c.params.sermonId) });
}

export async function getEvent(c: Ctx): Promise<Response> {
  const row = await loadEvent(c, c.params.eventId);
  return row ? reply(200, eventDto(row)) : notFound();
}

/**
 * Version and place references must live in this workspace. A missing or foreign id gives the
 * bare 404 (null return means all good). A version of another sermon in this workspace is a 400.
 */
async function checkReferences(c: Ctx, sermonId: string, versionId: string | null, placeId: string | null): Promise<Response | null> {
  if (versionId) {
    const version = await c.env.DB.prepare(`SELECT sermon_id FROM sermon_versions WHERE workspace_id = ? AND id = ?`)
      .bind(c.workspaceId, versionId).first<{ sermon_id: string }>();
    if (!version) return notFound();
    if (version.sermon_id !== sermonId) throw new Invalid('version_id', 'invalid_reference');
  }
  if (placeId) {
    const place = await c.env.DB.prepare(`SELECT 1 AS found FROM places WHERE workspace_id = ? AND id = ?`)
      .bind(c.workspaceId, placeId).first();
    if (!place) return notFound();
  }
  return null;
}

const EVENT_FIELDS = ['version_id', 'place_id', 'preached_on', 'raw_date', 'date_precision', 'occasion'] as const;

export async function createEvent(c: Ctx): Promise<Response> {
  const body = await readBody(c.request, EVENT_FIELDS);
  const when = normalizeWhen(body.preached_on, body.date_precision);
  const versionId = uuidOrNull(body.version_id, 'version_id'), placeId = uuidOrNull(body.place_id, 'place_id');
  const rawDate = optionalLine(body.raw_date, 'raw_date', 100), occasion = optionalLine(body.occasion, 'occasion', 200);
  const sermon = await c.env.DB.prepare(`SELECT id FROM sermons WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`)
    .bind(c.workspaceId, c.params.sermonId).first<{ id: string }>();
  if (!sermon) return notFound();
  const badReference = await checkReferences(c, sermon.id, versionId, placeId);
  if (badReference) return badReference;
  const id = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO preaching_events
      (id, workspace_id, sermon_id, version_id, place_id, preached_on, raw_date, date_precision, occasion)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, c.workspaceId, sermon.id, versionId, placeId, when.preached_on, rawDate, when.date_precision, occasion),
    auditStatement(c, 'event.create', 'preaching_event', id, { sermon_id: sermon.id })
  ]);
  return reply(201, eventDto((await loadEvent(c, id))!));
}

export async function updateEvent(c: Ctx): Promise<Response> {
  const body = await readBody(c.request, EVENT_FIELDS);
  const existing = await loadEvent(c, c.params.eventId);
  if (!existing) return notFound();
  const sets: string[] = [], args: unknown[] = [];
  if ('preached_on' in body || 'date_precision' in body) {
    // Changing only the precision re-validates the stored date; changing only the date infers precision.
    const when = normalizeWhen(
      'preached_on' in body ? body.preached_on : existing.preached_on,
      'date_precision' in body ? body.date_precision : ('preached_on' in body ? undefined : existing.date_precision));
    sets.push('preached_on = ?', 'date_precision = ?'); args.push(when.preached_on, when.date_precision);
  }
  let versionId = existing.version_id, placeId = existing.place_id;
  if ('version_id' in body) { versionId = uuidOrNull(body.version_id, 'version_id'); sets.push('version_id = ?'); args.push(versionId); }
  if ('place_id' in body) { placeId = uuidOrNull(body.place_id, 'place_id'); sets.push('place_id = ?'); args.push(placeId); }
  if ('raw_date' in body) { sets.push('raw_date = ?'); args.push(optionalLine(body.raw_date, 'raw_date', 100)); }
  if ('occasion' in body) { sets.push('occasion = ?'); args.push(optionalLine(body.occasion, 'occasion', 200)); }
  if (!sets.length) throw new Invalid('body', 'empty_update');
  const badReference = await checkReferences(c, existing.sermon_id, 'version_id' in body ? versionId : null, 'place_id' in body ? placeId : null);
  if (badReference) return badReference;
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE preaching_events SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND id = ?`).bind(...args, c.workspaceId, existing.id),
    auditStatement(c, 'event.update', 'preaching_event', existing.id, { sermon_id: existing.sermon_id, fields: Object.keys(body) }, true)
  ]);
  if (changes(results[0]) !== 1) return notFound();
  return reply(200, eventDto((await loadEvent(c, existing.id))!));
}

export async function deleteEvent(c: Ctx): Promise<Response> {
  const existing = await loadEvent(c, c.params.eventId);
  if (!existing) return notFound();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM preaching_events WHERE workspace_id = ? AND id = ?`).bind(c.workspaceId, existing.id),
    auditStatement(c, 'event.delete', 'preaching_event', existing.id,
      { sermon_id: existing.sermon_id, date_precision: existing.date_precision }, true)
  ]);
  if (changes(results[0]) !== 1) return notFound();
  return reply(200, { deleted: true, id: existing.id });
}
