import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, ids, origin } from './helpers/library-fixture.mjs';
import { handleRequest } from '../src/auth/app.ts';
import { SESSION_COOKIE } from '../src/auth/security.ts';
import { MAX_PDF_BYTES } from '../src/sources/pdf.ts';

const pdfVersion = 'd2000000-0000-4000-8000-000000000001';
const pdfVersionB = 'd2000000-0000-4000-8000-000000000002';
const pdfVersionW2 = 'd2000000-0000-4000-8000-000000000003';

/** In-memory stand-in for the R2 bucket: head, get, put (with etagDoesNotMatch), delete, plus a put log. */
class BucketMock {
  objects = new Map();
  puts = [];
  async head(key) { return this.objects.has(key) ? { key } : null; }
  async get(key) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return { size: bytes.byteLength, body: new Blob([bytes]).stream(), text: async () => new TextDecoder().decode(bytes) };
  }
  async put(key, value, options = {}) {
    if (options.onlyIf?.etagDoesNotMatch === '*' && this.objects.has(key)) return null;
    this.puts.push(key);
    this.objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value));
    return { key };
  }
  async delete(key) { this.objects.delete(key); }
  keys(kind) { return [...this.objects.keys()].filter(key => key.includes(`/${kind}/`)); }
}

/** A small valid one-page PDF whose only text is `text` (no parentheses or backslashes). */
function makePdf(text) {
  const stream = text ? `BT /F1 12 Tf 72 700 Td (${text}) Tj ET` : '';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
const NOTES_PDF = makePdf('Grace upon grace as John 3:16 says');

async function withFixture(run) {
  const f = await fixture();
  f.bucket = new BucketMock();
  f.env.PRIVATE_PDFS = f.bucket;
  f.db.execute(`INSERT INTO sermon_versions(id,workspace_id,sermon_id,label,source_type) VALUES (?,?,?,?,?),(?,?,?,?,?),(?,?,?,?,?)`,
    [pdfVersion, ids.w1, ids.sermon1, 'Printed notes', 'pdf', pdfVersionB, ids.w1, ids.sermon1, 'Second print', 'pdf',
      pdfVersionW2, ids.w2, ids.sermon2, 'Beta print', 'pdf']);
  const base = (version = pdfVersion, sermon = ids.sermon1, workspace = ids.w1) => `/api/workspaces/${workspace}/sermons/${sermon}/versions/${version}`;
  f.upload = (actor, bytes = NOTES_PDF, { version, type = 'application/pdf', headers = {} } = {}) =>
    send(f, 'POST', base(version) + '/pdf', actor, bytes, { 'content-type': type, ...headers });
  f.download = (actor, version, sermon, workspace) => send(f, 'GET', base(version, sermon, workspace) + '/pdf', actor);
  f.consent = (actor, version) => f.call('POST', base(version) + '/consent', actor, {});
  f.revoke = (actor, version) => f.call('POST', base(version) + '/revoke', actor, {});
  f.state = (version = pdfVersion) => f.db.query('SELECT indexing_state, r2_object_key, index_consent_by FROM sermon_versions WHERE id=?', [version])[0];
  f.stored = () => ({
    texts: f.db.query('SELECT 1 FROM note_texts').length,
    tokens: f.db.query('SELECT 1 FROM note_reference_tokens').length,
    fts: f.db.query(`SELECT rowid FROM note_fts WHERE note_fts MATCH '"grace"'`).length
  });
  f.search = (q, actor = 'owner') => f.call('GET', f.w(`/search?q=${encodeURIComponent(q)}`), actor);
  try { await run(f); } finally { f.db.close(); }
}

async function send(f, method, path, actor, bytes, headers = {}) {
  const response = await handleRequest(new Request(origin + path, {
    method,
    headers: { ...(actor ? { cookie: SESSION_COOKIE + '=' + f.tokens[actor] } : {}), ...(method === 'GET' ? {} : { origin }), ...headers },
    body: method === 'GET' ? undefined : bytes
  }), f.env);
  const body = new Uint8Array(await response.arrayBuffer());
  let json = null;
  try { json = JSON.parse(new TextDecoder().decode(body)); } catch { /* binary */ }
  return { status: response.status, headers: response.headers, body, json };
}

const uploadAndConsent = async f => {
  assert.equal((await f.upload('editor')).status, 201);
  assert.equal((await f.consent('owner', pdfVersion)).status, 200);
};

// ---------------------------------------------------------------------------------------
// Upload access
// ---------------------------------------------------------------------------------------

test('upload is refused for Viewers, non-members, anonymous callers and other workspaces, storing nothing', async () => {
  await withFixture(async f => {
    assert.equal((await f.upload('viewer')).status, 403);
    assert.equal((await f.upload('outsider')).status, 404);
    assert.equal((await f.upload(null)).status, 401);
    // Owner of workspace 2 addressing workspace 1's version, and workspace 1's owner addressing workspace 2's.
    assert.equal((await send(f, 'POST', `/api/workspaces/${ids.w1}/sermons/${ids.sermon1}/versions/${pdfVersion}/pdf`, 'owner2', NOTES_PDF, { 'content-type': 'application/pdf' })).status, 404);
    assert.equal((await send(f, 'POST', `/api/workspaces/${ids.w1}/sermons/${ids.sermon2}/versions/${pdfVersionW2}/pdf`, 'owner', NOTES_PDF, { 'content-type': 'application/pdf' })).status, 404);
    assert.equal(f.bucket.objects.size, 0);
    assert.equal(f.state().r2_object_key, null);
    assert.equal(f.state().indexing_state, 'not_indexed');
  });
});

test('Editor, Admin and Owner may upload', async () => {
  for (const actor of ['editor', 'admin', 'owner']) {
    await withFixture(async f => {
      const response = await f.upload(actor);
      assert.equal(response.status, 201, actor);
      assert.equal(f.bucket.keys('pdfs').length, 1, actor);
    });
  }
});

// ---------------------------------------------------------------------------------------
// Upload validation and immutability
// ---------------------------------------------------------------------------------------

test('upload checks version type, content type, %PDF magic and size, storing nothing on refusal', async () => {
  await withFixture(async f => {
    const googleDoc = await send(f, 'POST', `/api/workspaces/${ids.w1}/sermons/${ids.sermon1}/versions/${ids.version1}/pdf`, 'editor', NOTES_PDF, { 'content-type': 'application/pdf' });
    assert.equal(googleDoc.status, 409);
    assert.equal(googleDoc.json.error, 'not_pdf_version');
    assert.equal((await f.upload('editor', NOTES_PDF, { type: 'text/plain' })).status, 415);
    assert.equal((await f.upload('editor', NOTES_PDF, { type: 'application/json' })).status, 415);
    assert.equal((await f.upload('editor', new TextEncoder().encode('<html>not a pdf</html>'))).status, 415);
    assert.equal((await f.upload('editor', new TextEncoder().encode('  %PDF-1.4 leading space'))).status, 415);
    assert.equal((await f.upload('editor', new Uint8Array(0))).status, 415);
    // Too large, whether the length is declared or only discovered while reading.
    const big = new Uint8Array(MAX_PDF_BYTES + 1);
    big.set(new TextEncoder().encode('%PDF-1.4'));
    assert.equal((await f.upload('editor', big)).status, 413);
    assert.equal((await f.upload('editor', NOTES_PDF, { headers: { 'content-length': String(MAX_PDF_BYTES + 1) } })).status, 413);
    assert.equal(f.bucket.objects.size, 0);
    assert.equal(f.state().r2_object_key, null);
    assert.equal(f.db.query("SELECT 1 FROM audit_events WHERE action LIKE 'version.pdf%'").length, 0);
  });
});

test('a version PDF is set once and an existing object is never overwritten', async () => {
  await withFixture(async f => {
    assert.equal((await f.upload('editor')).status, 201);
    const key = f.state().r2_object_key;
    assert.match(key, new RegExp(`^workspaces/${ids.w1}/pdfs/[0-9a-f]{64}\\.pdf$`));
    const before = [...f.bucket.objects.entries()];

    const again = await f.upload('editor', makePdf('A different file'));
    assert.equal(again.status, 409);
    assert.equal(again.json.error, 'pdf_already_uploaded');
    assert.equal((await f.upload('owner')).status, 409);
    assert.equal(f.state().r2_object_key, key);
    assert.deepEqual([...f.bucket.objects.entries()], before);

    // The same bytes for another version reuse the object and do not rewrite it.
    const putsBefore = f.bucket.puts.length;
    assert.equal((await f.upload('editor', NOTES_PDF, { version: pdfVersionB })).status, 201);
    assert.equal(f.state(pdfVersionB).r2_object_key, key);
    assert.equal(f.bucket.keys('pdfs').length, 1);
    assert.deepEqual(f.bucket.puts.slice(putsBefore).filter(k => k === key), []);
  });
});

test('an object already stored under the content-hash key is left untouched', async () => {
  await withFixture(async f => {
    assert.equal((await f.upload('editor')).status, 201);
    const key = f.state().r2_object_key;
    f.db.execute('UPDATE sermon_versions SET r2_object_key=NULL, indexing_state=? WHERE id=?', ['not_indexed', pdfVersion]);
    const sentinel = new TextEncoder().encode('%PDF-sentinel');
    f.bucket.objects.set(key, sentinel);
    f.bucket.puts.length = 0;
    assert.equal((await f.upload('editor')).status, 201);
    assert.deepEqual(f.bucket.objects.get(key), sentinel);
    assert.equal(f.bucket.puts.includes(key), false);
  });
});

test('identical files in different workspaces use different keys', async () => {
  await withFixture(async f => {
    assert.equal((await f.upload('editor')).status, 201);
    const second = await send(f, 'POST', `/api/workspaces/${ids.w2}/sermons/${ids.sermon2}/versions/${pdfVersionW2}/pdf`, 'owner2', NOTES_PDF, { 'content-type': 'application/pdf' });
    assert.equal(second.status, 201);
    assert.notEqual(f.state(pdfVersionW2).r2_object_key, f.state().r2_object_key);
    assert.equal(f.bucket.keys('pdfs').length, 2);
  });
});

// ---------------------------------------------------------------------------------------
// Extraction and the consent gate
// ---------------------------------------------------------------------------------------

test('extracted text is held unindexed and unsearchable until the Owner consents', async () => {
  await withFixture(async f => {
    const response = await f.upload('editor');
    assert.deepEqual(Object.keys(response.json).sort(), ['bytes', 'characters', 'indexing_state', 'version_id']);
    assert.equal(response.json.indexing_state, 'awaiting_consent');
    assert.equal(f.state().indexing_state, 'awaiting_consent');
    assert.equal(f.state().index_consent_by, null);
    assert.equal(JSON.stringify(response.json).includes('workspaces/'), false);
    const [held] = f.bucket.keys('extracted');
    assert.equal(held, `workspaces/${ids.w1}/extracted/${pdfVersion}.txt`);
    assert.equal(new TextDecoder().decode(f.bucket.objects.get(held)), 'Grace upon grace as John 3:16 says');
    assert.deepEqual(f.stored(), { texts: 0, tokens: 0, fts: 0 });
    for (const q of ['grace upon', 'John 3:16']) {
      const hits = (await f.search(q)).json;
      assert.deepEqual(hits.notesMatches, [], q);
    }
    const found = (await f.call('GET', f.w(`/sermons/${ids.sermon1}/find-in-notes?q=grace`), 'owner')).json;
    assert.deepEqual(found.versions.find(v => v.version_id === pdfVersion), {
      version_id: pdfVersion, label: 'Printed notes', source_type: 'pdf', status: 'not_searchable', reason: 'pending'
    });
  });
});

test('unreadable, text-free and corrupt PDFs fail with no stored text', async () => {
  const cases = {
    unreadable: new TextEncoder().encode('%PDF-1.4\nthis is not a real document'),
    no_text: makePdf('')
  };
  for (const [reason, bytes] of Object.entries(cases)) {
    await withFixture(async f => {
      const response = await f.upload('editor', bytes);
      assert.equal(response.status, 201, reason);
      assert.equal(response.json.indexing_state, 'failed', reason);
      assert.equal(response.json.reason, reason);
      assert.equal(f.state().indexing_state, 'failed', reason);
      assert.deepEqual(f.bucket.keys('extracted'), [], reason);
      assert.deepEqual(f.stored(), { texts: 0, tokens: 0, fts: 0 }, reason);
      assert.equal(JSON.parse(f.db.query("SELECT details_json FROM audit_events WHERE action='version.pdf_extract_failed'")[0].details_json).reason, reason);
      // A failed version cannot be consented into the index.
      assert.equal((await f.consent('owner', pdfVersion)).status, 409, reason);
      assert.deepEqual(f.stored(), { texts: 0, tokens: 0, fts: 0 }, reason);
    });
  }
});

test('a failure while holding the extracted text leaves the version failed and nothing stored', async () => {
  await withFixture(async f => {
    const put = f.bucket.put.bind(f.bucket);
    f.bucket.put = async (key, ...rest) => {
      if (key.includes('/extracted/')) throw new Error('r2 down');
      return put(key, ...rest);
    };
    const response = await f.upload('editor');
    assert.equal(response.json.indexing_state, 'failed');
    assert.equal(response.json.reason, 'storage');
    assert.deepEqual(f.bucket.keys('extracted'), []);
  });
});

test('a failed state transition after holding the text deletes the held text', async () => {
  await withFixture(async f => {
    const batch = f.env.DB.batch.bind(f.env.DB);
    let calls = 0;
    // Batch 1 stores the key; batch 2 is the move to awaiting_consent and fails; later ones work.
    f.env.DB.batch = async statements => {
      if (++calls === 2) throw new Error('d1 down');
      return batch(statements);
    };
    const response = await f.upload('editor');
    assert.equal(response.status, 201);
    assert.equal(response.json.indexing_state, 'failed');
    assert.equal(f.state().indexing_state, 'failed');
    assert.deepEqual(f.bucket.keys('extracted'), []);
    assert.equal((await f.consent('owner', pdfVersion)).status, 409);
  });
});

test('when the database stays down the held text is still deleted, and revoke recovers a stuck upload', async () => {
  await withFixture(async f => {
    const batch = f.env.DB.batch.bind(f.env.DB);
    let calls = 0;
    f.env.DB.batch = async statements => {
      if (++calls >= 2) throw new Error('d1 down');
      return batch(statements);
    };
    assert.equal((await f.upload('editor')).json.indexing_state, 'failed');
    assert.equal(f.state().indexing_state, 'not_indexed');
    assert.deepEqual(f.bucket.keys('extracted'), [], 'compensation removed the held text');
    f.env.DB.batch = batch;

    // A Worker that stopped after the text put leaves text behind a not_indexed version.
    await f.bucket.put(`workspaces/${ids.w1}/extracted/${pdfVersion}.txt`, 'Grace upon grace');
    assert.equal((await f.consent('owner', pdfVersion)).status, 409);
    assert.equal((await f.revoke('owner', pdfVersion)).status, 200);
    assert.equal(f.state().indexing_state, 'revoked');
    assert.deepEqual(f.bucket.keys('extracted'), []);
  });
});

test('only the Owner can consent; everyone else is refused and nothing is indexed', async () => {
  await withFixture(async f => {
    assert.equal((await f.upload('editor')).status, 201);
    for (const [actor, status] of [['viewer', 403], ['editor', 403], ['admin', 403], ['outsider', 404], [null, 401]]) {
      assert.equal((await f.consent(actor, pdfVersion)).status, status, String(actor));
    }
    assert.equal((await f.call('POST', `/api/workspaces/${ids.w1}/sermons/${ids.sermon1}/versions/${pdfVersionW2}/consent`, 'owner', {})).status, 404);
    assert.equal(f.state().indexing_state, 'awaiting_consent');
    assert.equal(f.state().index_consent_by, null);
    assert.deepEqual(f.stored(), { texts: 0, tokens: 0, fts: 0 });
    assert.equal(f.bucket.keys('extracted').length, 1);
  });
});

test('Owner consent indexes the held text, records the Owner and makes it searchable', async () => {
  await withFixture(async f => {
    assert.equal((await f.upload('editor')).status, 201);
    const consented = await f.consent('owner', pdfVersion);
    assert.equal(consented.status, 200);
    assert.equal(f.state().indexing_state, 'indexed');
    assert.equal(f.state().index_consent_by, ids.owner);
    assert.deepEqual(f.stored(), { texts: 1, tokens: 1, fts: 1 });
    assert.deepEqual(f.bucket.keys('extracted'), [], 'held text is dropped once indexed');
    const text = (await f.search('grace upon')).json;
    assert.equal(text.notesMatches.length, 1);
    assert.equal(text.notesMatches[0].version_id, pdfVersion);
    assert.equal((await f.search('John 3:16', 'viewer')).json.notesMatches[0].version_id, pdfVersion);
    assert.deepEqual(f.auditActions().filter(a => a.startsWith('version.')),
      ['version.pdf_upload', 'version.pdf_extracted', 'version.consent', 'version.index']);
    assert.equal(consented.json.held_text_deleted, true);
    // Repeating consent on an indexed version is a cleanup retry: no second index, no new audit rows.
    const again = await f.consent('owner', pdfVersion);
    assert.equal(again.status, 200);
    assert.equal(again.json.held_text_deleted, true);
    assert.deepEqual(f.stored(), { texts: 1, tokens: 1, fts: 1 });
    assert.equal(f.auditActions().filter(a => a === 'version.index').length, 1);
    assert.equal((await f.consent('editor', pdfVersion)).status, 403, 'cleanup retry is Owner only');
  });
});

test('a failed delete of the held text after indexing keeps the index and can be retried', async () => {
  await withFixture(async f => {
    assert.equal((await f.upload('editor')).status, 201);
    const del = f.bucket.delete.bind(f.bucket);
    f.bucket.delete = async () => { throw new Error('r2 down'); };
    const first = await f.consent('owner', pdfVersion);
    assert.equal(first.status, 200);
    assert.equal(first.json.indexing_state, 'indexed');
    assert.equal(first.json.held_text_deleted, false);
    assert.equal(f.state().indexing_state, 'indexed');
    assert.deepEqual(f.stored(), { texts: 1, tokens: 1, fts: 1 });
    assert.equal(f.bucket.keys('extracted').length, 1, 'held copy is still there');
    assert.equal((await f.search('grace upon')).json.notesMatches.length, 1);

    // Retry while storage is still down: still indexed, still reports the leftover copy.
    assert.equal((await f.consent('owner', pdfVersion)).json.held_text_deleted, false);
    f.bucket.delete = del;
    const retry = await f.consent('owner', pdfVersion);
    assert.equal(retry.status, 200);
    assert.equal(retry.json.held_text_deleted, true);
    assert.deepEqual(f.bucket.keys('extracted'), []);
    assert.deepEqual(f.stored(), { texts: 1, tokens: 1, fts: 1 });
    assert.equal(f.state().indexing_state, 'indexed');
    assert.equal(f.auditActions().filter(a => a === 'version.index').length, 1);
  });
});

test('consent is refused for a version with no extracted text to index', async () => {
  await withFixture(async f => {
    assert.equal((await f.consent('owner', pdfVersion)).status, 409, 'nothing uploaded yet');
    assert.equal(f.state().index_consent_by, null);
    // Held text lost: the consent cannot index anything and the version ends failed, not queued.
    assert.equal((await f.upload('editor')).status, 201);
    f.bucket.objects.delete(`workspaces/${ids.w1}/extracted/${pdfVersion}.txt`);
    assert.equal((await f.consent('owner', pdfVersion)).status, 409);
    assert.equal(f.state().indexing_state, 'failed');
    assert.equal(f.state().index_consent_by, null);
    assert.deepEqual(f.stored(), { texts: 0, tokens: 0, fts: 0 });
  });
});

test('a storage error during consent hands the decision back so it can be retried', async () => {
  await withFixture(async f => {
    assert.equal((await f.upload('editor')).status, 201);
    const get = f.bucket.get.bind(f.bucket);
    f.bucket.get = async () => { throw new Error('r2 down'); };
    assert.equal((await f.consent('owner', pdfVersion)).status, 503);
    assert.equal(f.state().indexing_state, 'awaiting_consent');
    assert.equal(f.state().index_consent_by, null);
    assert.deepEqual(f.stored(), { texts: 0, tokens: 0, fts: 0 });
    f.bucket.get = get;
    assert.equal((await f.consent('owner', pdfVersion)).status, 200);
    assert.equal(f.state().indexing_state, 'indexed');
  });
});

// ---------------------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------------------

test('revoke purges the index and stored text, and search and download honor it', async () => {
  await withFixture(async f => {
    await uploadAndConsent(f);
    assert.equal((await f.download('viewer', pdfVersion, ids.sermon1, ids.w1)).status, 200);
    assert.deepEqual(f.stored(), { texts: 1, tokens: 1, fts: 1 });

    for (const [actor, status] of [['editor', 403], ['admin', 403], ['viewer', 403], ['outsider', 404]]) {
      assert.equal((await f.revoke(actor, pdfVersion)).status, status, actor);
    }
    assert.equal(f.state().indexing_state, 'indexed', 'refused callers change nothing');
    assert.deepEqual(f.stored(), { texts: 1, tokens: 1, fts: 1 });

    const revoked = await f.revoke('owner', pdfVersion);
    assert.equal(revoked.status, 200);
    assert.equal(f.state().indexing_state, 'revoked');
    assert.deepEqual(f.stored(), { texts: 0, tokens: 0, fts: 0 });
    assert.deepEqual(f.bucket.keys('extracted'), []);
    assert.deepEqual((await f.search('grace upon')).json.notesMatches, []);
    assert.deepEqual((await f.search('John 3:16')).json.notesMatches, []);
    const found = (await f.call('GET', f.w(`/sermons/${ids.sermon1}/find-in-notes?q=grace`), 'owner')).json;
    assert.equal(found.versions.find(v => v.version_id === pdfVersion).reason, 'revoked');
    const download = await f.download('owner', pdfVersion, ids.sermon1, ids.w1);
    assert.equal(download.status, 410);
    assert.equal(download.body.byteLength < 100, true);
    assert.equal(f.auditActions().includes('version.revoke'), true);

    // Revoked is final: it cannot be consented back, re-uploaded or revoked into a different state.
    assert.equal((await f.consent('owner', pdfVersion)).status, 409);
    assert.equal((await f.upload('editor')).status, 409);
    assert.equal(f.state().indexing_state, 'revoked');
    assert.deepEqual(f.stored(), { texts: 0, tokens: 0, fts: 0 });
  });
});

test('revoking before consent deletes the held text, and revoking twice is safe', async () => {
  await withFixture(async f => {
    assert.equal((await f.upload('editor')).status, 201);
    assert.equal(f.bucket.keys('extracted').length, 1);
    assert.equal((await f.revoke('owner', pdfVersion)).status, 200);
    assert.deepEqual(f.bucket.keys('extracted'), []);
    assert.equal((await f.consent('owner', pdfVersion)).status, 409);
    assert.deepEqual(f.stored(), { texts: 0, tokens: 0, fts: 0 });
    assert.equal((await f.revoke('owner', pdfVersion)).status, 200);
    assert.equal(f.db.query("SELECT 1 FROM audit_events WHERE action='version.revoke'").length, 1);
  });
});

test('revoke finishes a purge that was left half done', async () => {
  await withFixture(async f => {
    await uploadAndConsent(f);
    f.db.execute("UPDATE sermon_versions SET indexing_state='revoked' WHERE id=?", [pdfVersion]);
    assert.deepEqual(f.stored(), { texts: 1, tokens: 1, fts: 1 });
    assert.equal((await f.revoke('owner', pdfVersion)).status, 200);
    assert.deepEqual(f.stored(), { texts: 0, tokens: 0, fts: 0 });
  });
});

test('revoke needs something to revoke and is scoped to its workspace', async () => {
  await withFixture(async f => {
    assert.equal((await f.revoke('owner', pdfVersion)).status, 409);
    assert.equal(f.state().indexing_state, 'not_indexed');
    // Another workspace's Owner cannot revoke this workspace's indexed version.
    await uploadAndConsent(f);
    const foreign = await f.call('POST', `/api/workspaces/${ids.w2}/sermons/${ids.sermon1}/versions/${pdfVersion}/revoke`, 'owner2', {});
    assert.equal(foreign.status, 404);
    assert.equal(f.state().indexing_state, 'indexed');
    assert.deepEqual(f.stored(), { texts: 1, tokens: 1, fts: 1 });
  });
});

// ---------------------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------------------

test('download needs membership and streams the stored bytes with no-store and attachment headers', async () => {
  await withFixture(async f => {
    assert.equal((await f.download('viewer', pdfVersion, ids.sermon1, ids.w1)).status, 404, 'nothing uploaded yet');
    assert.equal((await f.upload('editor')).status, 201);
    for (const actor of ['viewer', 'editor', 'admin', 'owner']) {
      const response = await f.download(actor, pdfVersion, ids.sermon1, ids.w1);
      assert.equal(response.status, 200, actor);
      assert.deepEqual(response.body, NOTES_PDF, actor);
      assert.equal(response.headers.get('content-type'), 'application/pdf');
      assert.match(response.headers.get('content-disposition'), /^attachment; filename="[A-Za-z0-9._-]+"$/);
      assert.match(response.headers.get('cache-control'), /no-store/);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    }
    assert.equal((await f.download('outsider', pdfVersion, ids.sermon1, ids.w1)).status, 404);
    assert.equal((await f.download(null, pdfVersion, ids.sermon1, ids.w1)).status, 401);
    // Workspace 2's owner, and a version from another workspace named in this one's path.
    assert.equal((await f.download('owner2', pdfVersion, ids.sermon1, ids.w1)).status, 404);
    assert.equal((await f.download('owner', pdfVersionW2, ids.sermon1, ids.w1)).status, 404);
    // A deleted sermon hides its files.
    f.db.execute('UPDATE sermons SET deleted_at=CURRENT_TIMESTAMP WHERE id=?', [ids.sermon1]);
    assert.equal((await f.download('owner', pdfVersion, ids.sermon1, ids.w1)).status, 404);
  });
});

test('version responses never expose storage keys', async () => {
  await withFixture(async f => {
    await uploadAndConsent(f);
    const detail = await f.call('GET', f.w(`/sermons/${ids.sermon1}`), 'viewer');
    assert.equal(detail.text.includes('workspaces/'), false);
    assert.equal(detail.text.includes('r2_object_key'), false);
  });
});

test('PDF routes accept only their own methods', async () => {
  await withFixture(async f => {
    for (const method of ['PATCH', 'DELETE']) {
      assert.equal((await f.call(method, `/api/workspaces/${ids.w1}/sermons/${ids.sermon1}/versions/${pdfVersion}/pdf`, 'owner', {})).status, 404, method);
    }
    assert.equal((await f.call('GET', `/api/workspaces/${ids.w1}/sermons/${ids.sermon1}/versions/${pdfVersion}/consent`, 'owner')).status, 404);
  });
});
