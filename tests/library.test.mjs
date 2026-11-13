import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fixture, ids, ROLES, origin } from './helpers/library-fixture.mjs';
import { normalizeWhen } from '../src/api/events.ts';
import { handleRequest } from '../src/auth/app.ts';
import { planDevSession, DevSessionRefusal, parseArgs } from '../scripts/dev-session.mjs';
import { DatabaseMock } from './helpers/d1.mjs';

const TABLES = ['sermons', 'sermon_scripture_refs', 'sermon_versions', 'preaching_events', 'places', 'place_aliases', 'place_merges', 'audit_events'];
const snapshot = db => JSON.stringify(TABLES.map(name => db.query(`SELECT * FROM ${name} ORDER BY rowid`)));

async function withFixture(run) {
  const f = await fixture();
  try { await run(f); } finally { f.db.close(); }
}

// ---------------------------------------------------------------------------------------
// Role matrix
// ---------------------------------------------------------------------------------------

/** Every mutating route. `setup` prepares state the call needs; `action` is the audit action it must write. */
const MUTATIONS = [
  { name: 'create sermon', method: 'POST', path: '/sermons', body: { title: 'New Sermon' }, status: 201, action: 'sermon.create' },
  { name: 'update sermon', method: 'PATCH', path: `/sermons/${ids.sermon1}`, body: { title: 'Renamed' }, status: 200, action: 'sermon.update' },
  { name: 'archive sermon', method: 'POST', path: `/sermons/${ids.sermon1}/archive`, status: 200, action: 'sermon.archive' },
  {
    name: 'restore sermon', method: 'POST', path: `/sermons/${ids.sermon1}/restore`, status: 200, action: 'sermon.restore',
    setup: db => db.execute('UPDATE sermons SET archived_at=CURRENT_TIMESTAMP WHERE id=?', [ids.sermon1])
  },
  { name: 'create version', method: 'POST', path: `/sermons/${ids.sermon1}/versions`, body: { label: 'Revised', source_type: 'pdf' }, status: 201, action: 'version.create' },
  { name: 'update version', method: 'PATCH', path: `/sermons/${ids.sermon1}/versions/${ids.version1}`, body: { label: 'Original (edited)' }, status: 200, action: 'version.update' },
  { name: 'create event', method: 'POST', path: `/sermons/${ids.sermon1}/events`, body: { preached_on: '2025-04-06' }, status: 201, action: 'event.create' },
  { name: 'update event', method: 'PATCH', path: `/events/${ids.event1}`, body: { occasion: 'Easter' }, status: 200, action: 'event.update' },
  { name: 'delete event', method: 'DELETE', path: `/events/${ids.event1}`, status: 200, action: 'event.delete' },
  { name: 'create place', method: 'POST', path: '/places', body: { display_name: 'Lakeside Hall' }, status: 201, action: 'place.create' },
  { name: 'rename place', method: 'PATCH', path: `/places/${ids.place1}`, body: { display_name: 'Harbor Church' }, status: 200, action: 'place.rename' },
  {
    name: 'merge place', method: 'POST', path: `/places/${ids.place1}/merge`, body: { target_place_id: '00000000-0000-4000-8000-0000000000aa' }, status: 200, action: 'place.merge',
    setup: db => db.execute('INSERT INTO places(id,workspace_id,display_name) VALUES (?,?,?)', ['00000000-0000-4000-8000-0000000000aa', ids.w1, 'Main Campus'])
  }
];

for (const role of ROLES) {
  test(`role matrix: ${role} ${role === 'viewer' ? 'is refused' : 'can mutate'} on every mutating route`, async () => {
    for (const mutation of MUTATIONS) {
      await withFixture(async f => {
        mutation.setup?.(f.db);
        const before = snapshot(f.db);
        const res = await f.call(mutation.method, f.w(mutation.path), role, mutation.body);
        if (role === 'viewer') {
          assert.equal(res.status, 403, `${mutation.name}: ${res.text}`);
          assert.deepEqual(res.json, { error: 'forbidden' });
          assert.equal(snapshot(f.db), before, `${mutation.name} must not change data for a viewer`);
        } else {
          assert.equal(res.status, mutation.status, `${mutation.name}: ${res.text}`);
          assert.deepEqual(f.auditActions(), [mutation.action], `${mutation.name} audit`);
          const audit = f.db.query('SELECT workspace_id, actor_account_id FROM audit_events')[0];
          assert.deepEqual({ ...audit }, { workspace_id: ids.w1, actor_account_id: ids[role] });
        }
      });
    }
  });
}

test('viewer can read every read route', async () => {
  await withFixture(async f => {
    for (const path of ['/sermons', `/sermons/${ids.sermon1}`, `/sermons/${ids.sermon1}/versions`, `/sermons/${ids.sermon1}/events`,
      '/events', '/events?year=2025', `/events/${ids.event1}`, '/places']) {
      const res = await f.call('GET', f.w(path), 'viewer');
      assert.equal(res.status, 200, path);
    }
    const target = '00000000-0000-4000-8000-0000000000aa';
    f.db.execute('INSERT INTO places(id,workspace_id,display_name) VALUES (?,?,?)', [target, ids.w1, 'Main Campus']);
    assert.equal((await f.call('GET', f.w(`/places/${ids.place1}/merge-preview?target=${target}`), 'viewer')).status, 200);
  });
});

test('viewer is refused before the body or target resource is inspected', async () => {
  await withFixture(async f => {
    const missing = '00000000-0000-4000-8000-0000000000ff';
    const res = await f.call('PATCH', f.w(`/sermons/${missing}`), 'viewer', { nonsense: true });
    assert.equal(res.status, 403);
  });
});

// ---------------------------------------------------------------------------------------
// Isolation: non-members and other workspaces
// ---------------------------------------------------------------------------------------

const S = ids.sermon1, V = ids.version1, E = ids.event1, P = ids.place1;
const ALL_ROUTES = [
  ['GET', '/sermons'], ['POST', '/sermons', { title: 'x' }],
  ['GET', `/sermons/${S}`], ['PATCH', `/sermons/${S}`, { title: 'x' }],
  ['POST', `/sermons/${S}/archive`], ['POST', `/sermons/${S}/restore`],
  ['GET', `/sermons/${S}/versions`], ['POST', `/sermons/${S}/versions`, { label: 'x', source_type: 'pdf' }],
  ['PATCH', `/sermons/${S}/versions/${V}`, { label: 'x' }],
  ['GET', `/sermons/${S}/events`], ['POST', `/sermons/${S}/events`, { preached_on: '2025-01-05' }],
  ['GET', '/events'], ['GET', '/events?year=2025&month=3'], ['GET', `/events/${E}`], ['PATCH', `/events/${E}`, { occasion: 'x' }], ['DELETE', `/events/${E}`],
  ['GET', '/places'], ['POST', '/places', { display_name: 'x' }], ['PATCH', `/places/${P}`, { display_name: 'x' }],
  ['GET', `/places/${P}/merge-preview?target=${ids.place2}`], ['POST', `/places/${P}/merge`, { target_place_id: ids.place2 }]
];
const NOT_FOUND = { error: 'not_found' };

test('non-member, revoked member and other-workspace owner get a bare 404 on every route and change nothing', async () => {
  await withFixture(async f => {
    f.db.execute('UPDATE workspace_memberships SET revoked_at=CURRENT_TIMESTAMP WHERE account_id=?', [ids.viewer]);
    const before = snapshot(f.db);
    for (const actor of ['outsider', 'owner2', 'viewer']) {
      for (const [method, path, body] of ALL_ROUTES) {
        const res = await f.call(method, f.w(path), actor, body);
        assert.equal(res.status, 404, `${actor} ${method} ${path}`);
        assert.deepEqual(res.json, NOT_FOUND, `${actor} ${method} ${path} body: ${res.text}`);
      }
    }
    assert.equal(snapshot(f.db), before);
  });
});

test('no session returns 401 with no content on every route', async () => {
  await withFixture(async f => {
    for (const [method, path, body] of ALL_ROUTES) {
      const res = await f.call(method, f.w(path), null, body);
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.deepEqual(res.json, { error: 'unauthenticated' });
    }
  });
});

test("another workspace's ids under my workspace are 404, never leak titles or counts, and change nothing", async () => {
  await withFixture(async f => {
    const before = snapshot(f.db);
    const foreign = [
      ['GET', `/sermons/${ids.sermon2}`], ['PATCH', `/sermons/${ids.sermon2}`, { title: 'hijack' }],
      ['POST', `/sermons/${ids.sermon2}/archive`], ['POST', `/sermons/${ids.sermon2}/restore`],
      ['GET', `/sermons/${ids.sermon2}/versions`], ['POST', `/sermons/${ids.sermon2}/versions`, { label: 'x', source_type: 'pdf' }],
      ['PATCH', `/sermons/${ids.sermon2}/versions/${ids.version2}`, { label: 'x' }],
      ['PATCH', `/sermons/${ids.sermon1}/versions/${ids.version2}`, { label: 'x' }],
      ['GET', `/sermons/${ids.sermon2}/events`], ['POST', `/sermons/${ids.sermon2}/events`, { preached_on: '2025-01-05' }],
      ['GET', `/events/${ids.event2}`], ['PATCH', `/events/${ids.event2}`, { occasion: 'x' }], ['DELETE', `/events/${ids.event2}`],
      ['PATCH', `/places/${ids.place2}`, { display_name: 'hijack' }],
      ['GET', `/places/${ids.place2}/merge-preview?target=${ids.place1}`],
      ['GET', `/places/${ids.place1}/merge-preview?target=${ids.place2}`],
      ['POST', `/places/${ids.place2}/merge`, { target_place_id: ids.place1 }]
    ];
    for (const actor of ['owner', 'admin', 'editor']) {
      for (const [method, path, body] of foreign) {
        const res = await f.call(method, f.w(path), actor, body);
        assert.ok([400, 404].includes(res.status), `${actor} ${method} ${path} -> ${res.status}`);
        assert.ok(!/Beta|Secret|betaDoc/.test(res.text), `${method} ${path} leaked: ${res.text}`);
      }
    }
    assert.equal(snapshot(f.db), before);
  });
});

test('cross-workspace references in a body are rejected with the same answer as a missing id', async () => {
  await withFixture(async f => {
    const missing = '00000000-0000-4000-8000-0000000000ff';
    const create = (version_id, place_id) => f.call('POST', f.w(`/sermons/${S}/events`), 'owner', { preached_on: '2025-05-04', version_id, place_id });
    const foreignPlace = await create(null, ids.place2), missingPlace = await create(null, missing);
    assert.equal(foreignPlace.status, 400);
    assert.deepEqual(foreignPlace.json, missingPlace.json);
    const foreignVersion = await create(ids.version2, null), missingVersion = await create(missing, null);
    assert.equal(foreignVersion.status, 400);
    assert.deepEqual(foreignVersion.json, missingVersion.json);
    const merge = await f.call('POST', f.w(`/places/${P}/merge`), 'owner', { target_place_id: ids.place2 });
    const mergeMissing = await f.call('POST', f.w(`/places/${P}/merge`), 'owner', { target_place_id: missing });
    assert.equal(merge.status, 400);
    assert.deepEqual(merge.json, mergeMissing.json);
    assert.equal(f.db.query('SELECT COUNT(*) AS n FROM preaching_events WHERE workspace_id=?', [ids.w2])[0].n, 1);
  });
});

test('a version of another sermon in the same workspace cannot be attached to an event', async () => {
  await withFixture(async f => {
    f.db.execute('INSERT INTO sermons(id,workspace_id,title) VALUES (?,?,?)', ['c0000000-0000-4000-8000-0000000000a1', ids.w1, 'Second']);
    const res = await f.call('POST', f.w('/sermons/c0000000-0000-4000-8000-0000000000a1/events'), 'owner', { preached_on: '2025-05-04', version_id: ids.version1 });
    assert.equal(res.status, 400);
    assert.equal(res.json.field, 'version_id');
  });
});

test('malformed ids, trailing slashes and unknown routes are 404 without touching data', async () => {
  await withFixture(async f => {
    for (const path of ['/sermons/not-a-uuid', '/sermons/not-a-uuid/versions', '/events/123', '/places/x/merge-preview', '/sermons/', '/sermons/' + S + '/', '/nothing']) {
      const res = await f.call('GET', f.w(path), 'owner');
      assert.equal(res.status, 404, path);
    }
    assert.equal((await f.call('DELETE', f.w(`/sermons/${S}`), 'owner')).status, 404);
    assert.equal((await f.call('PUT', f.w(`/sermons/${S}`), 'owner', {})).status, 405);
  });
});

// ---------------------------------------------------------------------------------------
// Same-origin and audit
// ---------------------------------------------------------------------------------------

test('every mutation requires same-origin and writes nothing when the origin is wrong or missing', async () => {
  await withFixture(async f => {
    for (const mutation of MUTATIONS) {
      mutation.setup?.(f.db);
      const before = snapshot(f.db);
      const cross = await f.call(mutation.method, f.w(mutation.path), 'owner', mutation.body, { origin: 'https://attacker.invalid' });
      assert.equal(cross.status, 403, `${mutation.name} cross-origin`);
      assert.deepEqual(cross.json, { error: 'invalid_origin' });
      const sameOriginButCrossSite = await f.call(mutation.method, f.w(mutation.path), 'owner', mutation.body, { origin, 'sec-fetch-site': 'cross-site' });
      assert.equal(sameOriginButCrossSite.status, 403, `${mutation.name} cross-site`);
      const headers = { cookie: f.request('GET', '/x', 'owner').headers.get('cookie'), 'content-type': 'application/json' };
      const res = await handleRequest(new Request(origin + f.w(mutation.path), {
        method: mutation.method, headers, body: mutation.body ? JSON.stringify(mutation.body) : undefined
      }), f.env);
      assert.equal(res.status, 403, `${mutation.name} missing origin`);
      assert.equal(snapshot(f.db), before, mutation.name);
    }
  });
});

test('audit rows record actor and target without private titles', async () => {
  await withFixture(async f => {
    const created = await f.call('POST', f.w('/sermons'), 'editor', { title: 'Very Private Title', scripture_references: ['Romans 8'] });
    await f.call('PATCH', f.w(`/sermons/${created.json.id}`), 'editor', { description: 'Pastoral note text' });
    await f.call('POST', f.w(`/sermons/${created.json.id}/archive`), 'editor');
    const rows = f.db.query('SELECT action, target_type, target_id, actor_account_id, details_json FROM audit_events ORDER BY rowid');
    assert.deepEqual(rows.map(r => r.action), ['sermon.create', 'sermon.update', 'sermon.archive']);
    for (const row of rows) {
      assert.equal(row.target_id, created.json.id);
      assert.equal(row.actor_account_id, ids.editor);
      assert.ok(!/Private|Pastoral|Romans/.test(row.details_json));
    }
    assert.deepEqual(JSON.parse(rows[1].details_json), { fields: ['description'] });
  });
});

// ---------------------------------------------------------------------------------------
// Sermons
// ---------------------------------------------------------------------------------------

test('sermon create, get, update, scripture references and strict input', async () => {
  await withFixture(async f => {
    const created = await f.call('POST', f.w('/sermons'), 'owner', {
      title: '  Grace   Abounds ', scripture_references: ['Romans 5:20', 'Ephesians 2:8-9'], series_name: 'Grace', description: 'Line one\nLine two', tags: ['grace', 'Grace', 'hope']
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.title, 'Grace Abounds');
    assert.deepEqual(created.json.scripture_references, ['Romans 5:20', 'Ephesians 2:8-9']);
    assert.deepEqual(created.json.tags, ['grace', 'hope']);
    assert.equal(f.db.query('SELECT scripture_passage FROM sermons WHERE id=?', [created.json.id])[0].scripture_passage, 'Romans 5:20; Ephesians 2:8-9');
    const id = created.json.id;
    const updated = await f.call('PATCH', f.w(`/sermons/${id}`), 'editor', { scripture_references: ['John 1:1'], series_name: null });
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.json.scripture_references, ['John 1:1']);
    assert.equal(updated.json.series_name, null);
    assert.ok(updated.json.updated_at);
    assert.equal(f.db.query('SELECT COUNT(*) AS n FROM sermon_scripture_refs WHERE sermon_id=?', [id])[0].n, 1);
    const cleared = await f.call('PATCH', f.w(`/sermons/${id}`), 'editor', { scripture_references: [] });
    assert.deepEqual(cleared.json.scripture_references, []);
    assert.equal(f.db.query('SELECT scripture_passage FROM sermons WHERE id=?', [id])[0].scripture_passage, null);

    for (const body of [{}, { title: '' }, { title: 'x'.repeat(201) }, { title: 'ok', workspace_id: ids.w2 }, { title: 'ok', archived_at: 'now' },
      { title: 'ok', id: ids.sermon2 }, { title: 'ok', scripture_references: 'John 3' }, { title: 'ok', scripture_references: Array(21).fill('John 3') },
      { title: 'ok', tags: [1] }, { title: 'ok\u0000' }, { title: 'ok', __proto__: 1, deleted_at: 'x' }]) {
      const res = await f.call('POST', f.w('/sermons'), 'owner', body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal((await f.call('PATCH', f.w(`/sermons/${id}`), 'owner', {})).status, 400);
    assert.equal((await f.call('PATCH', f.w(`/sermons/${id}`), 'owner', { title: null })).status, 400);
    const notJson = await handle(f, 'POST', f.w('/sermons'), 'owner', 'title=x', 'application/x-www-form-urlencoded');
    assert.equal(notJson.status, 400);
    assert.equal(f.db.query('SELECT COUNT(*) AS n FROM sermons WHERE workspace_id=?', [ids.w1])[0].n, 2);
  });
});

async function handle(f, method, path, actor, rawBody, contentType) {
  return handleRequest(new Request(origin + path, {
    method, headers: { cookie: f.request('GET', '/x', actor).headers.get('cookie'), origin, 'content-type': contentType }, body: rawBody
  }), f.env);
}

test('sermon list filters archived, paginates, and lists scripture references', async () => {
  await withFixture(async f => {
    const list = await f.call('GET', f.w('/sermons'), 'viewer');
    assert.deepEqual(list.json.sermons.map(s => s.title), ['Alpha Hope Sermon']);
    assert.deepEqual(list.json.sermons[0].scripture_references, ['John 3:16']);
    assert.ok(!('description' in list.json.sermons[0]));
    const second = await f.call('POST', f.w('/sermons'), 'owner', { title: 'Second' });
    await f.call('POST', f.w(`/sermons/${second.json.id}/archive`), 'owner');
    const titles = async q => (await f.call('GET', f.w('/sermons' + q), 'viewer')).json.sermons.map(s => s.title);
    assert.deepEqual(await titles(''), ['Alpha Hope Sermon']);
    assert.deepEqual(await titles('?archived=only'), ['Second']);
    assert.equal((await titles('?archived=include')).length, 2);
    assert.equal((await titles('?archived=include&limit=1')).length, 1);
    assert.equal((await titles('?archived=include&limit=1&offset=1')).length, 1);
    for (const q of ['?archived=maybe', '?limit=0', '?limit=101', '?limit=abc', '?offset=-1']) {
      assert.equal((await f.call('GET', f.w('/sermons' + q), 'viewer')).status, 400, q);
    }
  });
});

test('migration 0004 backfills structured references from the legacy scripture_passage column', () => {
  const connection = new DatabaseSync(':memory:');
  try {
    connection.exec('PRAGMA foreign_keys=ON');
    const sql = name => readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8');
    for (const name of ['0001_initial.sql', '0002_auth.sql', '0003_single_personal_workspace.sql']) connection.exec(sql(name));
    connection.exec(`INSERT INTO user_accounts(id,email_normalized,display_name) VALUES ('u','u@example.test','U');
      INSERT INTO workspaces(id,name,owner_account_id) VALUES ('w','Archive','u');
      INSERT INTO sermons(id,workspace_id,title,scripture_passage) VALUES ('s1','w','One','John 3:16'),('s2','w','Two',NULL),('s3','w','Three','   '),('s4','w','Four','  ${'x'.repeat(250)}')`);
    connection.exec(sql('0004_library.sql'));
    const rows = connection.prepare('SELECT sermon_id, position, length(reference_text) AS n, reference_text FROM sermon_scripture_refs ORDER BY sermon_id').all();
    assert.deepEqual(rows.map(r => [r.sermon_id, r.position, r.n]), [['s1', 0, 9], ['s4', 0, 200]]);
    assert.equal(rows[0].reference_text, 'John 3:16');
  } finally { connection.close(); }
});

test('archive and restore are explicit state changes; repeating either is a conflict', async () => {
  await withFixture(async f => {
    assert.equal((await f.call('POST', f.w(`/sermons/${S}/restore`), 'owner')).status, 409);
    const archived = await f.call('POST', f.w(`/sermons/${S}/archive`), 'owner');
    assert.equal(archived.status, 200);
    assert.ok(archived.json.archived_at);
    assert.equal((await f.call('POST', f.w(`/sermons/${S}/archive`), 'owner')).status, 409);
    assert.equal((await f.call('GET', f.w(`/sermons/${S}`), 'viewer')).json.archived_at !== null, true);
    const restored = await f.call('POST', f.w(`/sermons/${S}/restore`), 'admin');
    assert.equal(restored.json.archived_at, null);
    assert.deepEqual(f.auditActions(), ['sermon.archive', 'sermon.restore']);
  });
});

test('sermon detail includes versions and preaching events but never storage keys or consent identities', async () => {
  await withFixture(async f => {
    f.db.execute(`UPDATE sermon_versions SET r2_object_key='private/key.pdf', index_consent_by=?, index_consent_at=CURRENT_TIMESTAMP, indexing_state='indexed' WHERE id=?`, [ids.owner, ids.version1]);
    const res = await f.call('GET', f.w(`/sermons/${S}`), 'viewer');
    assert.equal(res.status, 200);
    assert.equal(res.json.versions.length, 1);
    assert.equal(res.json.versions[0].indexing_state, 'indexed');
    assert.equal(res.json.preaching_events.length, 1);
    assert.equal(res.json.preaching_events[0].date_precision, 'exact');
    assert.ok(!/r2_object_key|private\/key|index_consent/.test(res.text));
    const versions = await f.call('GET', f.w(`/sermons/${S}/versions`), 'viewer');
    assert.ok(!/r2_object_key|private\/key|index_consent/.test(versions.text));
  });
});

// ---------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------

test('version create validates source fields per type and rejects client-set server fields', async () => {
  await withFixture(async f => {
    const post = body => f.call('POST', f.w(`/sermons/${S}/versions`), 'editor', body);
    const doc = await post({ label: 'Doc v2', source_type: 'google_doc', google_document_id: 'abcDEF1234567', source_url: 'https://docs.google.com/document/d/abcDEF1234567/edit' });
    assert.equal(doc.status, 201);
    assert.equal(doc.json.indexing_state, 'not_indexed');
    assert.equal((await post({ label: 'PDF v1', source_type: 'pdf' })).status, 201);
    assert.equal((await post({ label: 'Web', source_type: 'external', source_url: 'https://example.org/sermon' })).status, 201);
    for (const body of [
      { label: 'x', source_type: 'google_doc' }, { label: 'x', source_type: 'google_doc', google_document_id: 'short' },
      { label: 'x', source_type: 'pdf', source_url: 'https://example.org/a.pdf' }, { label: 'x', source_type: 'pdf', google_document_id: 'abcDEF1234567' },
      { label: 'x', source_type: 'external' }, { label: 'x', source_type: 'external', source_url: 'http://example.org/a' },
      { label: 'x', source_type: 'external', source_url: 'javascript:alert(1)' }, { label: 'x', source_type: 'external', source_url: 'https://user:pw@example.org/' },
      { label: 'x', source_type: 'external', source_url: 'https://example.org/a b' }, { label: 'x', source_type: 'docx' }, { label: '', source_type: 'pdf' },
      { label: 'x', source_type: 'pdf', r2_object_key: 'k' }, { label: 'x', source_type: 'pdf', indexing_state: 'indexed' },
      { label: 'x', source_type: 'pdf', index_consent_by: ids.owner }, { label: 'x', source_type: 'pdf', sermon_id: ids.sermon2 }
    ]) {
      const res = await post(body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(f.db.query('SELECT COUNT(*) AS n FROM sermon_versions WHERE r2_object_key IS NOT NULL')[0].n, 0);
  });
});

test('version labels are unique per sermon ignoring case and editable', async () => {
  await withFixture(async f => {
    const dup = await f.call('POST', f.w(`/sermons/${S}/versions`), 'owner', { label: 'ORIGINAL ALPHA', source_type: 'pdf' });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error, 'label_in_use');
    const other = await f.call('POST', f.w(`/sermons/${S}/versions`), 'owner', { label: 'Second', source_type: 'pdf' });
    const clash = await f.call('PATCH', f.w(`/sermons/${S}/versions/${other.json.id}`), 'owner', { label: 'original alpha' });
    assert.equal(clash.status, 409);
    const same = await f.call('PATCH', f.w(`/sermons/${S}/versions/${ids.version1}`), 'owner', { label: 'Original ALPHA' });
    assert.equal(same.status, 200, 'renaming to a case variant of its own label is allowed');
    assert.equal(same.json.label, 'Original ALPHA');
    assert.ok(same.json.updated_at);
  });
});

test('version source is locked once indexing has started and source_type is immutable', async () => {
  await withFixture(async f => {
    const url = `/sermons/${S}/versions/${ids.version1}`;
    assert.equal((await f.call('PATCH', f.w(url), 'owner', { source_type: 'pdf' })).status, 400);
    const ok = await f.call('PATCH', f.w(url), 'owner', { google_document_id: 'newDocId12345' });
    assert.equal(ok.json.google_document_id, 'newDocId12345');
    assert.equal((await f.call('PATCH', f.w(url), 'owner', { google_document_id: null })).status, 400, 'google_doc needs a document id');
    f.db.execute(`UPDATE sermon_versions SET indexing_state='queued' WHERE id=?`, [ids.version1]);
    const locked = await f.call('PATCH', f.w(url), 'owner', { google_document_id: 'anotherDoc1234' });
    assert.equal(locked.status, 409);
    assert.equal(locked.json.error, 'source_locked');
    assert.equal((await f.call('PATCH', f.w(url), 'owner', { label: 'Still editable' })).status, 200);
  });
});

// ---------------------------------------------------------------------------------------
// Preaching events and calendar
// ---------------------------------------------------------------------------------------

test('normalizeWhen stores period starts, infers precision and rejects inconsistent pairs', () => {
  assert.deepEqual(normalizeWhen('2025-03-09'), { preached_on: '2025-03-09', date_precision: 'exact' });
  assert.deepEqual(normalizeWhen('2025-03'), { preached_on: '2025-03-01', date_precision: 'month' });
  assert.deepEqual(normalizeWhen('2025'), { preached_on: '2025-01-01', date_precision: 'year' });
  assert.deepEqual(normalizeWhen(null), { preached_on: null, date_precision: 'unknown' });
  assert.deepEqual(normalizeWhen(undefined, undefined), { preached_on: null, date_precision: 'unknown' });
  assert.deepEqual(normalizeWhen('2025-03-01', 'month'), { preached_on: '2025-03-01', date_precision: 'month' });
  assert.deepEqual(normalizeWhen('2025-01-01', 'year'), { preached_on: '2025-01-01', date_precision: 'year' });
  assert.deepEqual(normalizeWhen('2025-03-01', 'needs_review'), { preached_on: '2025-03-01', date_precision: 'needs_review' });
  assert.deepEqual(normalizeWhen(null, 'needs_review'), { preached_on: null, date_precision: 'needs_review' });
  for (const [on, precision] of [['2025-02-30'], ['2023-02-29'], ['2025-13-01'], ['1899-01-01'], ['2101-01-01'], ['25-01-01'], ['2025-3-9'], ['2025/03/09'], [20250309], [''],
    ['2025-03-09', 'month'], ['2025-03-02', 'month'], ['2025-02-01', 'year'], ['2025-03', 'exact'], ['2025', 'month'], [null, 'exact'], ['2025-03-09', 'unknown'],
    ['2025-03', 'needs_review'], ['2025-03-09', 'bogus']]) {
    assert.throws(() => normalizeWhen(on, precision), { code: /invalid_request|precision_mismatch/ }, `${on} ${precision}`);
  }
  assert.deepEqual(normalizeWhen('2024-02-29'), { preached_on: '2024-02-29', date_precision: 'exact' });
});

test('event create, get, update and delete with raw_date and references', async () => {
  await withFixture(async f => {
    const created = await f.call('POST', f.w(`/sermons/${S}/events`), 'editor', {
      preached_on: '2019-04', raw_date: 'Easter 2019', occasion: 'Easter', place_id: P, version_id: V
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.preached_on, '2019-04-01');
    assert.equal(created.json.date_precision, 'month');
    assert.equal(created.json.raw_date, 'Easter 2019');
    assert.equal(created.json.place_name, 'Harbor Chapel');
    assert.equal(created.json.version_label, 'Original Alpha');
    assert.equal(created.json.sermon_title, 'Alpha Hope Sermon');
    assert.ok(!('source_import_row_id' in created.json));
    const id = created.json.id;
    // Changing only the date infers a new precision; only the precision re-validates the stored date.
    const exact = await f.call('PATCH', f.w(`/events/${id}`), 'editor', { preached_on: '2019-04-21' });
    assert.equal(exact.json.date_precision, 'exact');
    const review = await f.call('PATCH', f.w(`/events/${id}`), 'editor', { date_precision: 'needs_review' });
    assert.deepEqual([review.json.preached_on, review.json.date_precision], ['2019-04-21', 'needs_review']);
    assert.equal((await f.call('PATCH', f.w(`/events/${id}`), 'editor', { date_precision: 'month' })).status, 400);
    const unknown = await f.call('PATCH', f.w(`/events/${id}`), 'editor', { preached_on: null });
    assert.deepEqual([unknown.json.preached_on, unknown.json.date_precision], [null, 'unknown']);
    const cleared = await f.call('PATCH', f.w(`/events/${id}`), 'editor', { place_id: null, version_id: null, occasion: null });
    assert.deepEqual([cleared.json.place_id, cleared.json.version_id, cleared.json.occasion], [null, null, null]);
    assert.equal(cleared.json.raw_date, 'Easter 2019', 'untouched fields keep their value');
    assert.equal((await f.call('PATCH', f.w(`/events/${id}`), 'editor', {})).status, 400);
    assert.equal((await f.call('PATCH', f.w(`/events/${id}`), 'editor', { sermon_id: ids.sermon2 })).status, 400);
    const deleted = await f.call('DELETE', f.w(`/events/${id}`), 'editor');
    assert.deepEqual(deleted.json, { deleted: true, id });
    assert.equal((await f.call('GET', f.w(`/events/${id}`), 'editor')).status, 404);
    assert.equal((await f.call('DELETE', f.w(`/events/${id}`), 'editor')).status, 404);
    assert.deepEqual(f.auditActions(), ['event.create', 'event.update', 'event.update', 'event.update', 'event.update', 'event.delete']);
  });
});

test('event validation rejects bad dates, references and unknown fields without writing', async () => {
  await withFixture(async f => {
    const before = snapshot(f.db);
    for (const body of [{ preached_on: '2025-02-30' }, { preached_on: '2025-03-09', date_precision: 'month' }, { date_precision: 'exact' }, { preached_on: 5 },
      { version_id: 'nope' }, { place_id: 'nope' }, { occasion: 'x'.repeat(201) }, { raw_date: 'x'.repeat(101) }, { workspace_id: ids.w2 }, { source_import_row_id: 'r1' }]) {
      const res = await f.call('POST', f.w(`/sermons/${S}/events`), 'owner', body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(snapshot(f.db), before);
    assert.equal((await f.call('POST', f.w(`/sermons/${S}/events`), 'owner', {})).json.date_precision, 'unknown');
  });
});

test('calendar year and month queries return events with date_precision and stay inside the workspace', async () => {
  await withFixture(async f => {
    const add = async body => (await f.call('POST', f.w(`/sermons/${S}/events`), 'owner', body)).json.id;
    const feb28 = await add({ preached_on: '2024-02-29' });
    const jan1 = await add({ preached_on: '2025-01-01' });
    const marMonth = await add({ preached_on: '2025-03', raw_date: 'March 2025' });
    const marYearOnly = await add({ preached_on: '2025' });
    const review = await add({ preached_on: '2025-03-15', date_precision: 'needs_review' });
    const undated = await add({ raw_date: 'sometime' });
    const dec = await add({ preached_on: '2025-12-28' });
    const next = await add({ preached_on: '2026-01-04' });
    const events = async q => (await f.call('GET', f.w('/events' + q), 'viewer')).json.events;
    const idsOf = list => list.map(e => e.id);

    const march = await events('?year=2025&month=3');
    assert.deepEqual(idsOf(march).sort(), [ids.event1, marMonth, review].sort(), 'month view: exact, month and needs_review only');
    assert.ok(march.every(e => e.date_precision && e.preached_on.startsWith('2025-03')));
    assert.deepEqual(march.map(e => e.date_precision).sort(), ['exact', 'month', 'needs_review']);
    assert.ok(!idsOf(march).includes(marYearOnly), 'a year-only event has no month');

    const year = await events('?year=2025');
    assert.deepEqual(idsOf(year).sort(), [jan1, marMonth, marYearOnly, review, dec, ids.event1].sort());
    assert.ok(year.some(e => e.id === marYearOnly && e.date_precision === 'year'));
    assert.ok(!idsOf(year).includes(undated) && !idsOf(year).includes(next) && !idsOf(year).includes(feb28));
    assert.deepEqual(idsOf(await events('?year=2025&month=12')), [dec], 'December range ends at the new year');
    assert.deepEqual(idsOf(await events('?year=2024&month=2')), [feb28]);
    assert.deepEqual(idsOf(await events('?year=2025&month=4')), []);
    assert.equal((await events('')).length, 9, 'unfiltered list includes undated events');
    assert.deepEqual(idsOf(await events(`?year=2025&sermon_id=${ids.sermon2}`)), [], "other workspace's sermon id matches nothing");
    assert.deepEqual(idsOf(await events(`?year=2025&month=3&place_id=${P}`)), [ids.event1]);
    for (const e of march) assert.ok(!JSON.stringify(e).includes('Beta'));

    const ordered = year.map(e => e.preached_on);
    assert.deepEqual(ordered, [...ordered].sort());
    for (const q of ['?month=3', '?year=2025&month=0', '?year=2025&month=13', '?year=1899', '?year=abc', '?year=2025&place_id=x', '?limit=0', '?limit=1001']) {
      assert.equal((await f.call('GET', f.w('/events' + q), 'viewer')).status, 400, q);
    }
  });
});

test('calendar hides events of other workspaces and flags archived sermons', async () => {
  await withFixture(async f => {
    const other = await f.call('GET', `/api/workspaces/${ids.w2}/events?year=2025`, 'owner2');
    assert.deepEqual(other.json.events.map(e => e.id), [ids.event2]);
    const mine = await f.call('GET', f.w('/events?year=2025'), 'owner');
    assert.deepEqual(mine.json.events.map(e => e.id), [ids.event1]);
    assert.equal(mine.json.events[0].sermon_archived, false);
    await f.call('POST', f.w(`/sermons/${S}/archive`), 'owner');
    assert.equal((await f.call('GET', f.w('/events?year=2025'), 'owner')).json.events[0].sermon_archived, true);
    f.db.execute('UPDATE sermons SET deleted_at=CURRENT_TIMESTAMP WHERE id=?', [S]);
    assert.deepEqual((await f.call('GET', f.w('/events?year=2025'), 'owner')).json.events, []);
  });
});

// ---------------------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------------------

test('place create and rename enforce unique names and aliases ignoring case', async () => {
  await withFixture(async f => {
    const created = await f.call('POST', f.w('/places'), 'editor', { display_name: '  Lakeside   Hall ' });
    assert.equal(created.status, 201);
    assert.equal(created.json.display_name, 'Lakeside Hall');
    assert.deepEqual([created.json.aliases, created.json.event_count], [[], 0]);
    assert.equal((await f.call('POST', f.w('/places'), 'editor', { display_name: 'HARBOR chapel' })).status, 409);
    f.db.execute('INSERT INTO place_aliases(workspace_id,place_id,alias) VALUES (?,?,?)', [ids.w1, ids.place1, 'The Harbor']);
    const aliasClash = await f.call('POST', f.w('/places'), 'editor', { display_name: 'the harbor' });
    assert.equal(aliasClash.status, 409);
    assert.equal(aliasClash.json.error, 'name_in_use');
    assert.equal((await f.call('PATCH', f.w(`/places/${created.json.id}`), 'editor', { display_name: 'The HARBOR' })).status, 409);
    const rename = await f.call('PATCH', f.w(`/places/${ids.place1}`), 'editor', { display_name: 'harbor CHAPEL' });
    assert.equal(rename.status, 200, 'case-only rename of itself');
    assert.equal(rename.json.display_name, 'harbor CHAPEL');
    assert.deepEqual(rename.json.aliases, ['The Harbor']);
    assert.equal((await f.call('PATCH', f.w(`/places/${ids.place1}`), 'editor', { display_name: 'Lakeside Hall' })).status, 409);
    // Another workspace may reuse the same name.
    assert.equal((await f.call('POST', `/api/workspaces/${ids.w2}/places`, 'owner2', { display_name: 'Harbor Chapel' })).status, 201);
    for (const body of [{}, { display_name: '' }, { display_name: 'x'.repeat(121) }, { display_name: 'ok', workspace_id: ids.w2 }, { display_name: 7 }]) {
      assert.equal((await f.call('POST', f.w('/places'), 'editor', body)).status, 400, JSON.stringify(body));
    }
  });
});

test('place list shows aliases and event counts', async () => {
  await withFixture(async f => {
    f.db.execute('INSERT INTO place_aliases(workspace_id,place_id,alias) VALUES (?,?,?),(?,?,?)', [ids.w1, P, 'harbor', ids.w1, P, 'Chapel by the Harbor']);
    const list = await f.call('GET', f.w('/places'), 'viewer');
    assert.equal(list.json.places.length, 1);
    assert.deepEqual(list.json.places[0].aliases, ['Chapel by the Harbor', 'harbor']);
    assert.equal(list.json.places[0].event_count, 1);
  });
});

async function mergeFixture(f) {
  const main = '00000000-0000-4000-8000-0000000000aa';
  f.db.execute('INSERT INTO places(id,workspace_id,display_name) VALUES (?,?,?)', [main, ids.w1, 'Main Campus']);
  f.db.execute('INSERT INTO place_aliases(workspace_id,place_id,alias) VALUES (?,?,?)', [ids.w1, P, 'Harbor']);
  f.db.execute('INSERT INTO place_aliases(workspace_id,place_id,alias) VALUES (?,?,?)', [ids.w1, main, 'MC']);
  f.db.execute(`INSERT INTO preaching_events(id,workspace_id,sermon_id,place_id,preached_on,date_precision) VALUES (?,?,?,?,?,?)`,
    ['f0000000-0000-4000-8000-0000000000a1', ids.w1, S, main, '2025-06-01', 'exact']);
  return main;
}

test('merge preview reports the impact without changing anything', async () => {
  await withFixture(async f => {
    const main = await mergeFixture(f);
    const before = snapshot(f.db);
    const preview = await f.call('GET', f.w(`/places/${P}/merge-preview?target=${main}`), 'viewer');
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.json, {
      source: { id: P, display_name: 'Harbor Chapel' }, target: { id: main, display_name: 'Main Campus' },
      events_to_move: 1, aliases_to_move: ['Harbor'], new_alias: 'Harbor Chapel', resulting_event_count: 2
    });
    assert.equal(snapshot(f.db), before);
    for (const q of ['', '?target=x', `?target=${P}`, '?target=00000000-0000-4000-8000-0000000000ff']) {
      assert.equal((await f.call('GET', f.w(`/places/${P}/merge-preview${q}`), 'owner')).status, 400, q);
    }
  });
});

test('merge moves events and aliases, keeps the old name as an alias and records history', async () => {
  await withFixture(async f => {
    const main = await mergeFixture(f);
    const merged = await f.call('POST', f.w(`/places/${P}/merge`), 'admin', { target_place_id: main });
    assert.equal(merged.status, 200, merged.text);
    assert.equal(merged.json.place.id, main);
    assert.equal(merged.json.place.event_count, 2);
    assert.deepEqual(merged.json.place.aliases, ['Harbor', 'Harbor Chapel', 'MC']);
    assert.equal(f.db.query('SELECT COUNT(*) AS n FROM places WHERE id=?', [P])[0].n, 0);
    assert.equal(f.db.query('SELECT place_id FROM preaching_events WHERE id=?', [E])[0].place_id, main);
    const history = f.db.query('SELECT * FROM place_merges')[0];
    assert.deepEqual({
      workspace_id: history.workspace_id, source_place_id: history.source_place_id, source_display_name: history.source_display_name,
      target_place_id: history.target_place_id, merged_by_account_id: history.merged_by_account_id, moved_event_count: history.moved_event_count,
      moved_aliases_json: history.moved_aliases_json
    }, {
      workspace_id: ids.w1, source_place_id: P, source_display_name: 'Harbor Chapel', target_place_id: main, merged_by_account_id: ids.admin,
      moved_event_count: 1, moved_aliases_json: '["Harbor"]'
    });
    assert.deepEqual(f.auditActions(), ['place.merge']);
    assert.equal(JSON.parse(f.db.query('SELECT details_json FROM audit_events')[0].details_json).moved_events, 1);
    // The merged-away place no longer exists, so a repeat is a clean 404.
    assert.equal((await f.call('POST', f.w(`/places/${P}/merge`), 'admin', { target_place_id: main })).status, 404);
  });
});

test('merging into a place that is later merged keeps history pointing at a live place', async () => {
  await withFixture(async f => {
    const main = await mergeFixture(f);
    const third = '00000000-0000-4000-8000-0000000000bb';
    f.db.execute('INSERT INTO places(id,workspace_id,display_name) VALUES (?,?,?)', [third, ids.w1, 'Online']);
    assert.equal((await f.call('POST', f.w(`/places/${P}/merge`), 'owner', { target_place_id: main })).status, 200);
    assert.equal((await f.call('POST', f.w(`/places/${main}/merge`), 'owner', { target_place_id: third })).status, 200);
    const rows = f.db.query('SELECT source_place_id, target_place_id FROM place_merges ORDER BY rowid');
    assert.deepEqual(rows.map(r => [r.source_place_id, r.target_place_id]), [[P, third], [main, third]]);
    const online = (await f.call('GET', f.w('/places'), 'viewer')).json.places[0];
    assert.deepEqual(online.aliases, ['Harbor', 'Harbor Chapel', 'Main Campus', 'MC']);
    assert.equal(online.event_count, 2);
  });
});

test('merge input is validated and a failed merge leaves everything untouched', async () => {
  await withFixture(async f => {
    const main = await mergeFixture(f);
    const before = snapshot(f.db);
    for (const body of [{}, { target_place_id: 'x' }, { target_place_id: P }, { target_place_id: main, extra: 1 }, { target_place_id: ids.place2 }]) {
      assert.equal((await f.call('POST', f.w(`/places/${P}/merge`), 'owner', body)).status, 400, JSON.stringify(body));
    }
    assert.equal(snapshot(f.db), before);
    // A concurrent merge that already recorded this source rolls the whole batch back.
    f.db.execute(`INSERT INTO place_merges(id,workspace_id,source_place_id,source_display_name,target_place_id,moved_event_count) VALUES ('m1',?,?,'Harbor Chapel',?,0)`, [ids.w1, P, main]);
    const racing = snapshot(f.db);
    const res = await f.call('POST', f.w(`/places/${P}/merge`), 'owner', { target_place_id: main });
    assert.equal(res.status, 409);
    assert.equal(snapshot(f.db), racing, 'rolled back: place, events and aliases unchanged');
  });
});

// ---------------------------------------------------------------------------------------
// Existing behavior and the dev-session helper
// ---------------------------------------------------------------------------------------

test('existing sermon list route still serves members of a workspace', async () => {
  await withFixture(async f => {
    const res = await f.call('GET', f.w('/sermons'), 'viewer');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store, private');
    assert.equal(res.json.sermons[0].title, 'Alpha Hope Sermon');
  });
});

test('invitation and member routes are unaffected by library routing', async () => {
  await withFixture(async f => {
    const invite = await f.call('POST', f.w('/invitations'), 'owner', { email: 'new@example.test', role: 'viewer' });
    assert.equal(invite.status, 201);
    const patch = await f.call('PATCH', f.w(`/members/${ids.viewer}`), 'owner', { role: 'editor' });
    assert.equal(patch.status, 200);
    assert.equal((await f.call('GET', f.w('/members'), 'owner')).status, 404);
  });
});

test('dev-session refuses remote, environment and unknown targets', () => {
  for (const argv of [['--remote'], ['--email', 'a@example.test', '--remote'], ['--email', 'a@example.test', '--env', 'staging'], ['--email', 'a@example.test', '-e', 'staging'],
    ['--email', 'a@example.test', '--preview'], ['--email', 'a@example.test', '--db', 'sermon-bank-staging'], ['--email', 'a@example.test', '--database-id', 'x'],
    ['--email', 'a@example.test', '--config', 'x.json'], ['--email', 'a@example.test', '--local=false'], ['--email', 'a@example.test', 'extra']]) {
    assert.throws(() => parseArgs(argv), DevSessionRefusal, argv.join(' '));
  }
  assert.throws(() => parseArgs([]), DevSessionRefusal, 'email is required');
  assert.throws(() => parseArgs(['--email', 'not-an-email']), DevSessionRefusal);
  assert.throws(() => parseArgs(['--email', "x'; DROP TABLE users;--@example.test"]), DevSessionRefusal);
  assert.throws(() => parseArgs(['--email', 'a@example.test', '--workspace', "x'"]), DevSessionRefusal);
  assert.throws(() => parseArgs(['--email', 'a@example.test', '--ttl-hours', '0']), DevSessionRefusal);
  assert.equal(parseArgs(['--email', 'A@Example.test']).email, 'a@example.test');
});

test('dev-session SQL produces a session the Worker accepts, without any Worker bypass', async () => {
  const db = new DatabaseMock();
  try {
    const plan = planDevSession(['--email', 'Dev@Example.test', '--workspace', 'Dev Archive']);
    db.connection.exec(plan.sql);
    assert.match(plan.token, /^[A-Za-z0-9_-]{43}$/);
    const rows = db.query('SELECT token_hash FROM auth_sessions');
    assert.equal(rows.length, 1);
    assert.ok(!rows[0].token_hash.includes(plan.token), 'only the hash is stored');
    const env = { DB: db, PUBLIC_ORIGIN: origin };
    const cookie = `__Host-sb_session=${plan.token}`;
    const me = await handleRequest(new Request(origin + '/api/me', { headers: { cookie } }), env);
    assert.equal(me.status, 200);
    assert.equal((await me.json()).account.email_normalized, 'dev@example.test');
    const workspaces = await (await handleRequest(new Request(origin + '/api/workspaces', { headers: { cookie } }), env)).json();
    assert.deepEqual(workspaces.workspaces.map(w => [w.name, w.role]), [['Dev Archive', 'owner']]);
    const mutation = await handleRequest(new Request(`${origin}/api/workspaces/${workspaces.workspaces[0].id}/sermons`, {
      method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'From dev session' })
    }), env);
    assert.equal(mutation.status, 201);
    // Running it again reuses the account and workspace and adds one more session.
    db.connection.exec(planDevSession(['--email', 'dev@example.test', '--workspace', 'Dev Archive']).sql);
    assert.equal(db.query('SELECT COUNT(*) AS n FROM user_accounts')[0].n, 1);
    assert.equal(db.query('SELECT COUNT(*) AS n FROM workspaces')[0].n, 1);
    assert.equal(db.query('SELECT COUNT(*) AS n FROM auth_sessions')[0].n, 2);
    // No token, no session: a different token is rejected.
    const other = await handleRequest(new Request(origin + '/api/me', { headers: { cookie: '__Host-sb_session=' + 'A'.repeat(43) } }), env);
    assert.equal(other.status, 401);
  } finally { db.close(); }
});

test('dev-session does not create a session for a disabled account', async () => {
  const db = new DatabaseMock();
  try {
    db.execute(`INSERT INTO user_accounts(id,email_normalized,display_name,disabled_at) VALUES (?,?,?,CURRENT_TIMESTAMP)`, [ids.owner, 'off@example.test', 'Off']);
    db.connection.exec(planDevSession(['--email', 'off@example.test']).sql);
    assert.equal(db.query('SELECT COUNT(*) AS n FROM auth_sessions')[0].n, 0);
  } finally { db.close(); }
});
