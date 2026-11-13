import { reply, isUuid } from '../auth/security.ts';
import { Invalid, Conflict, notFound, readBody, auditStatement, changes, type Ctx } from '../api/http.ts';
import { inspectHistory } from './normalizer.mjs';

type Row = { id: string; status: string; parse_outcome: string; proposed_title: string | null; proposed_date: string | null; proposed_place: string | null; review_flags_json: string; source_row: number; source_sheet: string; source_hash: string; sermon_id: string | null; event_id: string | null; place_id: string | null };
const owner = (c: Ctx): Response | null => c.role === 'owner' ? null : reply(403, { error: 'forbidden' });
const batch = (c: Ctx) => c.env.DB.prepare('SELECT id FROM import_review_batches WHERE workspace_id = ? AND id = ?').bind(c.workspaceId, c.params.batchId).first();
const row = (c: Ctx) => c.env.DB.prepare('SELECT * FROM import_review_rows WHERE workspace_id = ? AND batch_id = ? AND id = ?').bind(c.workspaceId, c.params.batchId, c.params.rowId).first<Row>();

export async function upload(c: Ctx): Promise<Response> {
  const denied = owner(c); if (denied) return denied;
  if (!c.request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Invalid('body');
  const length = Number(c.request.headers.get('content-length') || 0);
  if (length > 10 * 1024 * 1024) throw new Invalid('body');
  const text = await c.request.text();
  if (text.length > 10 * 1024 * 1024) throw new Invalid('body');
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new Invalid('body', 'invalid_json'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Invalid('body');
  const data = body as Record<string, unknown>;
  if (Object.keys(data).some(k => !['csv', 'source_sheet'].includes(k)) || typeof data.csv !== 'string' || (data.source_sheet !== undefined && data.source_sheet !== 'All History')) throw new Invalid('body');
  let parsed: ReturnType<typeof inspectHistory>;
  try { parsed = inspectHistory(data.csv); } catch { throw new Invalid('csv'); }
  const existing = await c.env.DB.prepare('SELECT id FROM import_review_batches WHERE workspace_id = ? AND source_sheet = ? AND source_fingerprint = ?').bind(c.workspaceId, 'All History', parsed.summary.source_sha256).first<{id: string}>();
  if (existing) return reply(200, { id: existing.id, reused: true });
  const id = crypto.randomUUID();
  const statements = [c.env.DB.prepare('INSERT INTO import_review_batches(id,workspace_id,source_sheet,source_fingerprint,created_by) VALUES(?,?,?,?,?)').bind(id,c.workspaceId,'All History',parsed.summary.source_sha256,c.actorId)];
  const signatures = new Set<string>();
  for (const item of parsed.rows) {
    const flags = [...item.flags];
    if (!item.proposed_date) flags.push('undated');
    flags.push('unknown_owner');
    const place = item.proposed_place;
    if (place) {
      const alias = await c.env.DB.prepare('SELECT place_id FROM place_aliases WHERE workspace_id = ? AND alias = ? COLLATE NOCASE').bind(c.workspaceId, place).first();
      if (alias) flags.push('venue_alias');
    }
    const signature = [item.proposed_title?.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' '), item.proposed_date, place?.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')].join('|');
    if (item.proposed_title && item.proposed_date && place) {
      const duplicate = await c.env.DB.prepare(`SELECT e.id FROM preaching_events e JOIN sermons s ON s.workspace_id=e.workspace_id AND s.id=e.sermon_id JOIN places p ON p.workspace_id=e.workspace_id AND p.id=e.place_id WHERE e.workspace_id=? AND e.preached_on=? AND s.title=? COLLATE NOCASE AND (p.display_name=? COLLATE NOCASE OR EXISTS (SELECT 1 FROM place_aliases a WHERE a.workspace_id=p.workspace_id AND a.place_id=p.id AND a.alias=? COLLATE NOCASE)) LIMIT 1`).bind(c.workspaceId,item.proposed_date,item.proposed_title,place,place).first();
      if (signatures.has(signature) || duplicate) flags.push('suspected_duplicate_event');
      signatures.add(signature);
    }
    statements.push(c.env.DB.prepare(`INSERT INTO import_review_rows(id,workspace_id,batch_id,source_sheet,source_row,source_hash,original_values_json,proposed_title,proposed_date,proposed_place,parse_outcome,review_flags_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(),c.workspaceId,id,item.source_tab,item.source_row,item.id,JSON.stringify(item.raw),item.proposed_title,item.proposed_date,item.proposed_place,item.proposed_title ? 'parsed' : 'invalid',JSON.stringify(flags)));
  }
  statements.push(auditStatement(c,'import.upload','import_batch',id,{rows: parsed.rows.length}));
  try { await c.env.DB.batch(statements); } catch (error) {
    const raced = await c.env.DB.prepare('SELECT id FROM import_review_batches WHERE workspace_id=? AND source_sheet=? AND source_fingerprint=?').bind(c.workspaceId,'All History',parsed.summary.source_sha256).first<{id:string}>();
    if (raced) return reply(200,{id:raced.id,reused:true});
    throw error;
  }
  return reply(201,{id,reused:false});
}

export async function summary(c: Ctx): Promise<Response> {
  const denied = owner(c); if (denied) return denied;
  if (!await batch(c)) return notFound();
  const counts = await c.env.DB.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(parse_outcome='parsed'),0) AS parsed, COALESCE(SUM(parse_outcome='invalid'),0) AS invalid, COALESCE(SUM(json_array_length(review_flags_json)>0),0) AS flagged, COALESCE(SUM(attested_at IS NOT NULL),0) AS attested, COALESCE(SUM(status='approved'),0) AS approved FROM import_review_rows WHERE workspace_id=? AND batch_id=?`).bind(c.workspaceId,c.params.batchId).first();
  return reply(200, counts);
}

export async function rows(c: Ctx): Promise<Response> {
  const denied = owner(c); if (denied) return denied;
  if (!await batch(c)) return notFound();
  const result = await c.env.DB.prepare(`SELECT id,source_sheet,source_row,source_hash,proposed_title,proposed_date,proposed_place,parse_outcome,review_flags_json,status,attested_at FROM import_review_rows WHERE workspace_id=? AND batch_id=? ORDER BY source_row`).bind(c.workspaceId,c.params.batchId).all<Row>();
  return reply(200,{rows: result.results.map(r => ({...r, flags: JSON.parse(r.review_flags_json), review_flags_json: undefined}))});
}

export async function attest(c: Ctx): Promise<Response> {
  const denied = owner(c); if (denied) return denied;
  const body = await readBody(c.request,['row_ids']);
  if (!Array.isArray(body.row_ids) || !body.row_ids.length || body.row_ids.length > 500 || !body.row_ids.every(isUuid) || new Set(body.row_ids).size !== body.row_ids.length) throw new Invalid('row_ids');
  if (!await batch(c)) return notFound();
  const ids = body.row_ids as string[];
  const slots = ids.map(() => '?').join(',');
  const found = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM import_review_rows WHERE workspace_id=? AND batch_id=? AND id IN (${slots}) AND status IN ('unreviewed','attested')`).bind(c.workspaceId,c.params.batchId,...ids).first<{n:number}>();
  if (found?.n !== ids.length) throw new Conflict('invalid_row_state');
  const result = await c.env.DB.batch([c.env.DB.prepare(`UPDATE import_review_rows SET status='attested',attested_by=?,attested_at=CURRENT_TIMESTAMP WHERE workspace_id=? AND batch_id=? AND id IN (${slots}) AND status='unreviewed'`).bind(c.actorId,c.workspaceId,c.params.batchId,...ids),auditStatement(c,'import.attest','import_batch',c.params.batchId,{count:ids.length})]);
  return reply(200,{attested: changes(result[0])});
}

export async function ignore(c: Ctx): Promise<Response> {
  const denied = owner(c); if (denied) return denied;
  const r = await row(c); if (!r) return notFound();
  if (r.status === 'ignored') return reply(200,{ignored:true});
  if (!['unreviewed','attested'].includes(r.status)) throw new Conflict('invalid_row_state');
  await c.env.DB.batch([c.env.DB.prepare("UPDATE import_review_rows SET status='ignored' WHERE workspace_id=? AND id=? AND status IN ('unreviewed','attested')").bind(c.workspaceId,r.id),auditStatement(c,'import.ignore','import_row',r.id,{},true)]);
  return reply(200,{ignored:true});
}

export async function approve(c: Ctx): Promise<Response> {
  const denied = owner(c); if (denied) return denied;
  const r = await row(c); if (!r) return notFound();
  if (r.status === 'approved') return reply(200,{approved:true,created:false});
  if (r.status !== 'attested' || r.parse_outcome !== 'parsed' || !r.proposed_title) throw new Conflict('invalid_row_state');
  const sermon = crypto.randomUUID(), event = crypto.randomUUID(), place = crypto.randomUUID();
  const w = c.workspaceId;
  const stmts = [c.env.DB.prepare("UPDATE import_review_rows SET status='approved',sermon_id=?,event_id=? WHERE workspace_id=? AND id=? AND status='attested'").bind(sermon,event,w,r.id)];
  const claimed = "EXISTS (SELECT 1 FROM import_review_rows WHERE workspace_id=? AND id=? AND status='approved' AND sermon_id=?)";
  if (r.proposed_place) stmts.push(c.env.DB.prepare(`INSERT INTO places(id,workspace_id,display_name,source_import_row_id) SELECT ?,?,?,? WHERE ${claimed} AND NOT EXISTS (SELECT 1 FROM places WHERE workspace_id=? AND display_name=? COLLATE NOCASE) AND NOT EXISTS (SELECT 1 FROM place_aliases WHERE workspace_id=? AND alias=? COLLATE NOCASE)`).bind(place,w,r.proposed_place,r.id,w,r.id,sermon,w,r.proposed_place,w,r.proposed_place));
  stmts.push(c.env.DB.prepare(`INSERT INTO sermons(id,workspace_id,title,source_import_row_id) SELECT ?,?,?,? WHERE ${claimed}`).bind(sermon,w,r.proposed_title,r.id,w,r.id,sermon));
  stmts.push(c.env.DB.prepare(`UPDATE import_review_rows SET place_id=COALESCE((SELECT id FROM places WHERE workspace_id=? AND display_name=? COLLATE NOCASE),(SELECT place_id FROM place_aliases WHERE workspace_id=? AND alias=? COLLATE NOCASE)) WHERE workspace_id=? AND id=? AND sermon_id=?`).bind(w,r.proposed_place,w,r.proposed_place,w,r.id,sermon));
  stmts.push(c.env.DB.prepare(`INSERT INTO preaching_events(id,workspace_id,sermon_id,place_id,preached_on,raw_date,date_precision,source_import_row_id) SELECT ?,?,?,place_id,?,json_extract(original_values_json,'$[0]'),?,? FROM import_review_rows WHERE workspace_id=? AND id=? AND status='approved' AND sermon_id=?`).bind(event,w,sermon,r.proposed_date,r.proposed_date ? (r.proposed_date.endsWith('-01') ? 'needs_review' : 'exact') : 'unknown',r.id,w,r.id,sermon));
  stmts.push(auditStatement(c,'import.approve','import_row',r.id,{},true));
  const result = await c.env.DB.batch(stmts);
  if (!changes(result[0])) throw new Conflict('invalid_row_state');
  return reply(200,{approved:true,created:true});
}

export async function rollback(c: Ctx): Promise<Response> {
  const denied = owner(c); if (denied) return denied;
  const r = await row(c); if (!r) return notFound();
  if (r.status === 'rolled_back') return reply(200,{rolled_back:true});
  if (!['approved','rollback_conflict'].includes(r.status)) throw new Conflict('invalid_row_state');
  const w = c.workspaceId;
  const safe = `EXISTS (SELECT 1 FROM sermons s WHERE s.workspace_id=? AND s.id=? AND s.source_import_row_id=? AND s.updated_at IS NULL AND s.archived_at IS NULL AND s.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM sermon_versions v WHERE v.workspace_id=s.workspace_id AND v.sermon_id=s.id) AND NOT EXISTS (SELECT 1 FROM sermon_scripture_refs x WHERE x.workspace_id=s.workspace_id AND x.sermon_id=s.id) AND NOT EXISTS (SELECT 1 FROM preaching_events x WHERE x.workspace_id=s.workspace_id AND x.sermon_id=s.id AND x.id<>?)) AND EXISTS (SELECT 1 FROM preaching_events e WHERE e.workspace_id=? AND e.id=? AND e.source_import_row_id=? AND e.updated_at IS NULL) AND NOT EXISTS (SELECT 1 FROM places p WHERE p.workspace_id=? AND p.id=? AND p.source_import_row_id=? AND (p.updated_at IS NOT NULL OR EXISTS (SELECT 1 FROM place_aliases a WHERE a.workspace_id=p.workspace_id AND a.place_id=p.id) OR EXISTS (SELECT 1 FROM preaching_events e WHERE e.workspace_id=p.workspace_id AND e.place_id=p.id AND e.id<>?)))`;
  const result = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE import_review_rows SET status=CASE WHEN ${safe} THEN 'rolled_back' ELSE 'rollback_conflict' END WHERE workspace_id=? AND id=? AND status IN ('approved','rollback_conflict')`).bind(w,r.sermon_id,r.id,r.event_id,w,r.event_id,r.id,w,r.place_id,r.id,r.event_id,w,r.id),
    c.env.DB.prepare("DELETE FROM preaching_events WHERE workspace_id=? AND id=? AND EXISTS (SELECT 1 FROM import_review_rows WHERE id=? AND workspace_id=? AND status='rolled_back')").bind(w,r.event_id,r.id,w),
    c.env.DB.prepare("DELETE FROM sermons WHERE workspace_id=? AND id=? AND EXISTS (SELECT 1 FROM import_review_rows WHERE id=? AND workspace_id=? AND status='rolled_back')").bind(w,r.sermon_id,r.id,w),
    c.env.DB.prepare("DELETE FROM places WHERE workspace_id=? AND id=? AND source_import_row_id=? AND EXISTS (SELECT 1 FROM import_review_rows WHERE id=? AND workspace_id=? AND status='rolled_back')").bind(w,r.place_id,r.id,r.id,w),
    auditStatement(c,'import.rollback','import_row',r.id)
  ]);
  if (!changes(result[0])) throw new Conflict('invalid_row_state');
  const updated = await row(c);
  return reply(200,{rolled_back:updated?.status === 'rolled_back', conflict:updated?.status === 'rollback_conflict'});
}
