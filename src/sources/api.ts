/**
 * Private PDF versions: upload, Owner consent to index, revoke, download.
 *
 * A PDF is stored once per content hash and never overwritten. Its extracted text waits in
 * private storage (`awaiting_consent`) until an Owner consents; only then does it enter the
 * search index. Revoke deletes every derived copy. Responses never carry storage keys,
 * document text or consent identities, and audit details hold ids, counts and reason codes only.
 */
import { can, reply } from '../auth/security.ts';
import { Conflict, auditStatement, changes, notFound, type Ctx } from '../api/http.ts';
import { IndexRefused, indexVersion, purgeVersionIndex } from '../search/index.ts';
import { MAX_PDF_BYTES, extractPdfText, hasPdfMagic, pdfKey, readCapped, sha256Hex, textKey, type ExtractFailure } from './pdf.ts';

type VersionRow = { id: string; source_type: string; r2_object_key: string | null; indexing_state: string };

/** The version, only when its sermon is live and in this workspace. */
async function loadVersion(c: Ctx): Promise<VersionRow | null> {
  return c.env.DB.prepare(`SELECT v.id, v.source_type, v.r2_object_key, v.indexing_state FROM sermon_versions v
    JOIN sermons s ON s.workspace_id = v.workspace_id AND s.id = v.sermon_id
    WHERE v.workspace_id = ? AND v.sermon_id = ? AND v.id = ? AND s.deleted_at IS NULL`)
    .bind(c.workspaceId, c.params.sermonId, c.params.versionId).first<VersionRow>();
}

const forbidden = (): Response => reply(403, { error: 'forbidden' });

/** Move a version between states only from `from`, recording the audit row in the same batch. */
async function transition(
  c: Ctx, versionId: string, from: string, to: string, action: string, details: Record<string, unknown>, clearConsent = false
): Promise<boolean> {
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE sermon_versions SET indexing_state = ?, updated_at = CURRENT_TIMESTAMP${clearConsent ? ', index_consent_by = NULL, index_consent_at = NULL' : ''}
      WHERE workspace_id = ? AND id = ? AND indexing_state = ?`).bind(to, c.workspaceId, versionId, from),
    auditStatement(c, action, 'sermon_version', versionId, details, true)
  ]);
  return changes(results[0]) === 1;
}

/**
 * POST /sermons/:sermonId/versions/:versionId/pdf  (raw `application/pdf` body, Editor and above)
 * Stores the file, then extracts its text. Extraction failure leaves the PDF stored, the
 * version `failed` and no text anywhere. Success leaves the version `awaiting_consent`.
 */
export async function uploadPdf(c: Ctx): Promise<Response> {
  const version = await loadVersion(c);
  if (!version) return notFound();
  if (version.source_type !== 'pdf') throw new Conflict('not_pdf_version');
  if (version.r2_object_key !== null) throw new Conflict('pdf_already_uploaded');

  const type = (c.request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/pdf') return reply(415, { error: 'unsupported_media_type' });
  const bytes = await readCapped(c.request, MAX_PDF_BYTES);
  if (!bytes) return reply(413, { error: 'too_large', max_bytes: MAX_PDF_BYTES });
  if (!hasPdfMagic(bytes)) return reply(415, { error: 'not_a_pdf' });

  const bucket = c.env.PRIVATE_PDFS;
  const key = pdfKey(c.workspaceId, await sha256Hex(bytes));
  // Same bytes, same key: an existing object is already the right content and is left alone.
  if (!(await bucket.head(key))) {
    await bucket.put(key, bytes, { httpMetadata: { contentType: 'application/pdf' }, onlyIf: { etagDoesNotMatch: '*' } });
  }
  const set = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE sermon_versions SET r2_object_key = ?, updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ? AND id = ? AND r2_object_key IS NULL AND source_type = 'pdf' AND indexing_state = 'not_indexed'`)
      .bind(key, c.workspaceId, version.id),
    auditStatement(c, 'version.pdf_upload', 'sermon_version', version.id, { bytes: bytes.byteLength }, true)
  ]);
  if (changes(set[0]) !== 1) throw new Conflict('pdf_already_uploaded');

  const extracted = await extractPdfText(bytes);
  let failure: ExtractFailure | 'storage' | null = null, text = '';
  if ('failure' in extracted) failure = extracted.failure;
  else {
    text = extracted.text;
    try {
      await bucket.put(textKey(c.workspaceId, version.id), text, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } });
    } catch {
      failure = 'storage';
    }
  }
  if (failure) {
    await transition(c, version.id, 'not_indexed', 'failed', 'version.pdf_extract_failed', { reason: failure });
    return reply(201, { version_id: version.id, indexing_state: 'failed', reason: failure, bytes: bytes.byteLength });
  }
  // The text is already held. If the state cannot move to awaiting_consent (database error, or a revoke
  // landed first), delete the held text so no copy is left behind a state that cannot reach it.
  let held = false;
  try {
    held = await transition(c, version.id, 'not_indexed', 'awaiting_consent', 'version.pdf_extracted', { characters: text.length });
  } catch {
    held = false;
  }
  if (!held) {
    await dropHeldText(c, version.id);
    const state = await loadVersion(c);
    if (state?.indexing_state === 'revoked') return reply(409, { error: 'revoked' });
    await transition(c, version.id, 'not_indexed', 'failed', 'version.pdf_extract_failed', { reason: 'storage' }).catch(() => false);
    return reply(201, { version_id: version.id, indexing_state: 'failed', reason: 'storage', bytes: bytes.byteLength });
  }
  return reply(201, { version_id: version.id, indexing_state: 'awaiting_consent', bytes: bytes.byteLength, characters: text.length });
}

/** Delete the held extracted text. Reports whether it worked instead of throwing: callers decide what a leftover copy means. */
async function dropHeldText(c: Ctx, versionId: string): Promise<boolean> {
  try {
    await c.env.PRIVATE_PDFS.delete(textKey(c.workspaceId, versionId));
    return true;
  } catch {
    return false;
  }
}

/**
 * POST /sermons/:sermonId/versions/:versionId/consent  (Owner only)
 * Records the Owner's consent, then indexes the held text. The consent update only applies
 * to a version still `awaiting_consent`, so it cannot revive a revoked version. On an
 * already `indexed` version it only retries deleting the held copy (cleanup), never reindexing.
 */
export async function consentToIndex(c: Ctx): Promise<Response> {
  if (!can(c.role, 'consent')) return forbidden();
  const version = await loadVersion(c);
  if (!version) return notFound();
  if (version.indexing_state === 'indexed') {
    return reply(200, { version_id: version.id, indexing_state: 'indexed', held_text_deleted: await dropHeldText(c, version.id) });
  }
  if (version.indexing_state !== 'awaiting_consent') throw new Conflict('not_awaiting_consent');

  const granted = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE sermon_versions SET indexing_state = 'queued', index_consent_by = ?, index_consent_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ? AND id = ? AND indexing_state = 'awaiting_consent'`)
      .bind(c.actorId, c.workspaceId, version.id),
    auditStatement(c, 'version.consent', 'sermon_version', version.id, {}, true)
  ]);
  if (changes(granted[0]) !== 1) throw new Conflict('not_awaiting_consent');

  const bucket = c.env.PRIVATE_PDFS;
  let result: { characters: number; references: number };
  try {
    const stored = await bucket.get(textKey(c.workspaceId, version.id));
    if (!stored) throw new IndexRefused('empty_text');
    result = await indexVersion(c.env.DB, { workspaceId: c.workspaceId, versionId: version.id, text: await stored.text(), actorId: c.actorId });
  } catch (error) {
    if (!(error instanceof IndexRefused)) {
      // Storage or database trouble: hand the decision back to the Owner so consent can be retried.
      await transition(c, version.id, 'queued', 'awaiting_consent', 'version.consent_reset', {}, true);
      throw error;
    }
    // Consent lost to a concurrent revoke changes nothing here; otherwise the text is unusable.
    if (error.code !== 'consent_required') {
      await transition(c, version.id, 'queued', 'failed', 'version.index_failed', { reason: error.code }, true);
      await dropHeldText(c, version.id);
    }
    throw new Conflict(error.code);
  }
  // Indexing is done; a failed delete is not an error. The response says so and the Owner can repeat consent to retry.
  return reply(200, { version_id: version.id, indexing_state: 'indexed', ...result, held_text_deleted: await dropHeldText(c, version.id) });
}

/**
 * POST /sermons/:sermonId/versions/:versionId/revoke  (Owner only)
 * Marks the version `revoked` first, so search and download stop at once, then deletes the
 * index rows and held text. Safe to repeat: a second call finishes any deletion that failed.
 */
export async function revokeIndexing(c: Ctx): Promise<Response> {
  if (!can(c.role, 'consent')) return forbidden();
  const version = await loadVersion(c);
  if (!version) return notFound();
  // A `not_indexed` version with a stored PDF is an upload that stopped before its state moved on.
  // It may hold extracted text, so revoke is its purge route.
  if (version.indexing_state === 'not_indexed' && version.r2_object_key === null) throw new Conflict('nothing_to_revoke');

  if (version.indexing_state !== 'revoked') {
    if (!(await transition(c, version.id, version.indexing_state, 'revoked', 'version.revoke', { from: version.indexing_state })))
      throw new Conflict('state_changed');
  }
  await purgeVersionIndex(c.env.DB, c.workspaceId, version.id);
  await c.env.PRIVATE_PDFS.delete(textKey(c.workspaceId, version.id));
  return reply(200, { version_id: version.id, indexing_state: 'revoked' });
}

/** GET /sermons/:sermonId/versions/:versionId/pdf  (any member). Streams the stored file as an attachment. */
export async function downloadPdf(c: Ctx): Promise<Response> {
  const version = await loadVersion(c);
  if (!version || !version.r2_object_key) return notFound();
  if (version.indexing_state === 'revoked') return reply(410, { error: 'revoked' });
  const object = await c.env.PRIVATE_PDFS.get(version.r2_object_key);
  if (!object) return notFound();
  return new Response(object.body, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-length': String(object.size),
      'content-disposition': `attachment; filename="sermon-version-${version.id}.pdf"`,
      'cache-control': 'no-store, private',
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'vary': 'Cookie'
    }
  });
}
