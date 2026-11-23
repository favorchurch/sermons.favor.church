import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fixture, ids, origin } from './helpers/library-fixture.mjs';
import { handleRequest } from '../src/auth/app.ts';
import { sha256, randomToken, SESSION_COOKIE } from '../src/auth/security.ts';
import { DatabaseMock } from './helpers/d1.mjs';

const cookieValue = response => response.headers.get('set-cookie');
const expectedLayoutCookie = value => `sb_layout=${value}; Path=/; Secure; SameSite=Lax; Max-Age=31536000`;

test('GET /api/me returns each account layout and writes only the preference cookie', async () => {
  const f = await fixture();
  try {
    const owner = await f.call('GET', '/api/me', 'owner');
    assert.equal(owner.status, 200);
    assert.equal(owner.json.account.layout, 'original');
    assert.equal(cookieValue(owner), expectedLayoutCookie('original'));
    assert.ok(!cookieValue(owner).includes(ids.owner));
    const outsider = await f.call('GET', '/api/me', 'outsider');
    assert.equal(outsider.json.account.layout, 'original');
    assert.equal(cookieValue(outsider), expectedLayoutCookie('original'));
  } finally { f.db.close(); }
});

test('PATCH /api/me validates exact shape and value, uses CSRF, and changes only the caller', async () => {
  const f = await fixture();
  try {
    for (const body of [{ layout: 'bad' }, { layout: null }, { layout: 'a', extra: true }, { other: 'c' }, {}]) {
      assert.equal((await f.call('PATCH', '/api/me', 'owner', body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await f.call('PATCH', '/api/me', 'owner', { layout: 'c' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await f.call('PATCH', '/api/me', null, { layout: 'c' })).status, 401);
    for (const layout of ['a', 'c', 'original']) {
      const accepted = await f.call('PATCH', '/api/me', 'owner', { layout });
      assert.equal(accepted.status, 200);
      assert.equal(accepted.json.account.layout, layout);
      assert.equal(cookieValue(accepted), expectedLayoutCookie(layout));
    }
    const patched = await f.call('PATCH', '/api/me', 'owner', { layout: 'c' });
    assert.equal(patched.status, 200);
    assert.equal(patched.json.account.layout, 'c');
    assert.equal(cookieValue(patched), expectedLayoutCookie('c'));
    assert.equal((await f.call('GET', '/api/me', 'owner')).json.account.layout, 'c');
    assert.equal((await f.call('GET', '/api/me', 'outsider')).json.account.layout, 'original');
    assert.equal(f.db.query('SELECT layout_theme FROM user_accounts WHERE id=?', [ids.outsider])[0].layout_theme, 'original');
    const second = await f.call('PATCH', '/api/me', 'outsider', { layout: 'a' });
    assert.equal(second.json.account.layout, 'a');
    assert.equal((await f.call('GET', '/api/me', 'owner')).json.account.layout, 'c');
  } finally { f.db.close(); }
});

// Real /auth/google/start + signed fake id_token callback, so default-layout tests go through the production sign-in path.
let signingKeys;
async function googleSignIn(f, { sub, email }) {
  const start = await handleRequest(f.request('GET', '/auth/google/start'), f.env);
  assert.equal(start.status, 303);
  const state = start.headers.get('set-cookie').match(/__Secure-sb_flow=([^;]+)/)?.[1];
  assert.ok(state);
  const { nonce } = f.db.connection.prepare('SELECT nonce FROM oauth_login_attempts ORDER BY rowid DESC').get();
  signingKeys ??= await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...await crypto.subtle.exportKey('jwk', signingKeys.publicKey), kid: 'layout-key-2026', use: 'sig', alg: 'RS256' };
  const encode = x => Buffer.from(JSON.stringify(x)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = encode({ alg: 'RS256', typ: 'JWT', kid: jwk.kid }) + '.' + encode({ iss: 'https://accounts.google.com', aud: f.env.GOOGLE_CLIENT_ID, iat: now, exp: now + 3600, nonce, sub, email, email_verified: true, name: 'Layout Fixture' });
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signingKeys.privateKey, new TextEncoder().encode(unsigned));
  const idToken = unsigned + '.' + Buffer.from(signature).toString('base64url');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url).includes('/token')) return new Response(JSON.stringify({ id_token: idToken }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (String(url).includes('/certs')) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'max-age=60' } });
    throw Error('Unexpected network request');
  };
  try {
    const complete = await handleRequest(new Request(origin + '/auth/google/callback?code=fictional-code&state=' + state, { headers: { cookie: '__Secure-sb_flow=' + state } }), f.env);
    assert.equal(complete.status, 303);
    const session = complete.headers.get('set-cookie')?.match(/__Host-sb_session=([^;]+)/)?.[1];
    assert.ok(session);
    return session;
  } finally { globalThis.fetch = originalFetch; }
}
const meWith = async (f, session, cookie) => handleRequest(new Request(origin + '/api/me', { headers: { cookie: '__Host-sb_session=' + session + (cookie ? '; ' + cookie : '') } }), f.env);
const savedLayout = (f, id) => f.db.query('SELECT layout_theme FROM user_accounts WHERE id=?', [id])[0].layout_theme;

test('a newly created account has layout a with no saved choice', async () => {
  const f = await fixture();
  try {
    const session = await googleSignIn(f, { sub: 'new-layout-subject', email: 'brand-new@example.test' });
    const row = f.db.query('SELECT id, layout_theme FROM user_accounts WHERE email_normalized=?', ['brand-new@example.test'])[0];
    assert.equal(row.layout_theme, 'a');
    const me = await meWith(f, session);
    assert.equal((await me.json()).account.layout, 'a');
    assert.equal(cookieValue(me), expectedLayoutCookie('a'));
  } finally { f.db.close(); }
});

test('an account row that existed before migration 0008 reads layout a, and the migration only adds the column', async () => {
  const files = readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort();
  const migration = '0008_account_layout.sql';
  assert.ok(files.includes(migration));
  const sql = name => readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8');
  assert.doesNotMatch(sql(migration).replace(/--.*$/gm, ''), /\b(?:UPDATE|DELETE|INSERT|DROP)\b/i);
  const f = await fixture();
  try {
    // Rebuild the database as it was before 0008: every earlier migration, then an account row without the column, then 0008.
    const db = Object.create(DatabaseMock.prototype);
    db.connection = new DatabaseSync(':memory:');
    db.connection.exec('PRAGMA foreign_keys=ON');
    for (const name of files.filter(name => name < migration)) db.connection.exec(sql(name));
    const before = db.connection.prepare("PRAGMA table_info('user_accounts')").all();
    assert.ok(!before.some(column => column.name === 'layout_theme'));
    const legacyId = 'a0000000-0000-4000-8000-0000000000aa';
    db.connection.prepare('INSERT INTO user_accounts(id,email_normalized,display_name) VALUES (?,?,?)').run(legacyId, 'legacy@example.test', 'legacy');
    const token = randomToken();
    db.connection.prepare('INSERT INTO auth_sessions(token_hash,account_id,expires_at) VALUES (?,?,?)').run(await sha256(token), legacyId, Math.floor(Date.now() / 1000) + 86400);
    for (const name of files.filter(name => name >= migration)) db.connection.exec(sql(name));
    const me = await handleRequest(new Request(origin + '/api/me', { headers: { cookie: SESSION_COOKIE + '=' + token } }), { ...f.env, DB: db });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).account.layout, 'a');
    assert.equal(cookieValue(me), expectedLayoutCookie('a'));
    assert.equal(db.connection.prepare('SELECT layout_theme FROM user_accounts WHERE id=?').get(legacyId).layout_theme, 'a');
    db.connection.close();
  } finally { f.db.close(); }
});

test('a saved c or original is never overwritten by sign-in, a repeat sign-in, a layout cookie or a rejected PATCH', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call('PATCH', '/api/me', 'owner', { layout: 'c' })).status, 200);
    assert.equal(savedLayout(f, ids.owner), 'c');
    assert.equal(savedLayout(f, ids.outsider), 'original');
    // First sign-in links the Google subject by email, the second finds the account by subject.
    for (const [key, email, layout] of [['owner', 'owner@example.test', 'c'], ['outsider', 'outsider@example.test', 'original']]) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const session = await googleSignIn(f, { sub: key + '-layout-subject', email });
        for (const cookie of [undefined, 'sb_layout=a', 'sb_layout=' + layout, 'sb_layout=unknown']) {
          const me = await meWith(f, session, cookie);
          assert.equal((await me.json()).account.layout, layout, key + ' ' + cookie);
          assert.equal(cookieValue(me), expectedLayoutCookie(layout));
        }
        assert.equal(savedLayout(f, ids[key]), layout, key + ' after sign-in ' + attempt);
      }
    }
    for (const body of [{ layout: 'bad' }, { layout: 'a', extra: true }, {}]) assert.equal((await f.call('PATCH', '/api/me', 'owner', body)).status, 400);
    assert.equal((await f.call('PATCH', '/api/me', 'owner', { layout: 'a' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal(savedLayout(f, ids.owner), 'c');
  } finally { f.db.close(); }
});

test('sign-in defaults to prototype A except for the byte-identical Original page', async () => {
  const f = await fixture();
  try {
    const render = async cookie => {
      const response = await (await import('../src/auth/app.ts')).handleRequest(new Request(origin + '/', { headers: cookie ? { cookie } : {} }), f.env);
      assert.equal(response.status, 200);
      return { text: await response.text(), csp: response.headers.get('content-security-policy') };
    };
    const variant = await render('sb_layout=a');
    for (const cookie of [undefined, 'sb_layout=a', 'sb_layout=c', 'sb_layout=unknown']) {
      const page = cookie === 'sb_layout=a' ? variant : await render(cookie);
      assert.equal(page.text, variant.text);
      for (const copy of ['Sermon Bank', 'Sign in to open your workspace.', 'Continue with Google', 'If you were invited']) assert.ok(page.text.includes(copy));
      assert.match(page.text, /assets\/fonts\/inter-latin\.woff2/);
      assert.match(page.text, /assets\/fonts\/plus-jakarta-sans-latin\.woff2/);
      assert.match(page.text, /viewBox="0 0 108 44"/);
      assert.match(page.csp, /font-src 'self'/);
      assert.doesNotMatch(page.text, /fonts\.(googleapis|gstatic)\.com|<(?:link|script)[^>]+https?:\/\//i);
    }
    const original = await render('sb_layout=original');
    assert.notEqual(original.text, (await render(undefined)).text);
    assert.equal(createHash('sha256').update(original.text).digest('hex'), 'bc6fd0b9da1abed92c0656cfb0b2baf361d377f2a1b544b20379c684138d7d31');
  } finally { f.db.close(); }
});

// ---- view prefs (migration 0009) ----
const savedPrefs = (f, id) => f.db.query('SELECT view_prefs FROM user_accounts WHERE id=?', [id])[0].view_prefs;

test('migration 0009 adds view_prefs additively and existing rows read an empty object', async () => {
  const f = await fixture();
  try {
    const columns = f.db.query("SELECT name, type, \"notnull\" AS required, dflt_value FROM pragma_table_info('user_accounts') WHERE name='view_prefs'");
    assert.deepEqual(columns.map(c => ({ ...c })), [{ name: 'view_prefs', type: 'TEXT', required: 1, dflt_value: "'{}'" }]);
    assert.equal(savedPrefs(f, ids.owner), '{}');
    const me = await f.call('GET', '/api/me', 'owner');
    assert.deepEqual(me.json.account.prefs, {});
    assert.equal(me.json.account.layout, 'original');
    assert.equal(cookieValue(me), expectedLayoutCookie('original'));
  } finally { f.db.close(); }
});

test('PATCH /api/me prefs validates the closed allow-list and writes nothing on 400', async () => {
  const f = await fixture();
  try {
    const bad = [
      { prefs: { libraryView: 'grid' } }, { prefs: { sort: 'oldest' } }, { prefs: { archive: 'all' } },
      { prefs: { searchScope: 'web' } }, { prefs: { series: 'x'.repeat(201) } }, { prefs: { workspaceId: 'w'.repeat(65) } },
      { prefs: { series: 5 } }, { prefs: { libraryView: 'rows', unknown: 1 } }, { prefs: { __proto__x: 1 } }, { prefs: { constructor: 'x' } },
      { prefs: [] }, { prefs: 'rows' }, { prefs: null }, { prefs: { libraryView: 'rows' }, extra: true },
      { layout: 'bad', prefs: { libraryView: 'rows' } }, { layout: 'c', prefs: { libraryView: 'nope' } }
    ];
    for (const body of bad) assert.equal((await f.call('PATCH', '/api/me', 'owner', body)).status, 400, JSON.stringify(body));
    const raw = await handleRequest(f.request('PATCH', '/api/me', 'owner', undefined), f.env);
    assert.equal(raw.status, 400);
    assert.equal(savedPrefs(f, ids.owner), '{}');
    assert.equal(savedLayout(f, ids.owner), 'original');
    for (const prefs of [{ libraryView: 'covers' }, { libraryView: 'rows' }, { libraryView: 'table' }, { libraryView: 'calendar' }, { sort: 'recent' }, { sort: 'title' }, { sort: 'added' },
      { archive: 'active' }, { archive: 'archived' }, { searchScope: 'everything' }, { searchScope: 'bible' }, { searchScope: 'notes' }, { series: 'x'.repeat(200) }, { workspaceId: 'w'.repeat(64) }, {}]) {
      assert.equal((await f.call('PATCH', '/api/me', 'owner', { prefs })).status, 200, JSON.stringify(prefs).slice(0, 60));
    }
  } finally { f.db.close(); }
});

test('PATCH /api/me prefs merges into the stored object, null clears, layout is untouched', async () => {
  const f = await fixture();
  try {
    const first = await f.call('PATCH', '/api/me', 'owner', { prefs: { libraryView: 'table', sort: 'title', series: 'Romans' } });
    assert.equal(first.status, 200);
    assert.deepEqual(first.json.account.prefs, { libraryView: 'table', sort: 'title', series: 'Romans' });
    assert.equal(first.json.account.layout, 'original');
    assert.equal(cookieValue(first), expectedLayoutCookie('original'));
    const second = await f.call('PATCH', '/api/me', 'owner', { prefs: { sort: 'added', archive: 'archived' } });
    assert.deepEqual(second.json.account.prefs, { libraryView: 'table', sort: 'added', series: 'Romans', archive: 'archived' });
    const cleared = await f.call('PATCH', '/api/me', 'owner', { prefs: { series: null, archive: null, workspaceId: null } });
    assert.deepEqual(cleared.json.account.prefs, { libraryView: 'table', sort: 'added' });
    const read = await f.call('GET', '/api/me', 'owner');
    assert.deepEqual(read.json.account.prefs, { libraryView: 'table', sort: 'added' });
    assert.deepEqual(JSON.parse(savedPrefs(f, ids.owner)), { libraryView: 'table', sort: 'added' });
    const both = await f.call('PATCH', '/api/me', 'owner', { layout: 'c', prefs: { searchScope: 'bible' } });
    assert.equal(both.json.account.layout, 'c');
    assert.equal(cookieValue(both), expectedLayoutCookie('c'));
    assert.deepEqual(both.json.account.prefs, { libraryView: 'table', sort: 'added', searchScope: 'bible' });
    const layoutOnly = await f.call('PATCH', '/api/me', 'owner', { layout: 'a' });
    assert.deepEqual(layoutOnly.json.account.prefs, { libraryView: 'table', sort: 'added', searchScope: 'bible' });
    assert.equal(savedLayout(f, ids.owner), 'a');
  } finally { f.db.close(); }
});

test('stored prefs are capped at 2 KB and a rejected patch leaves them unchanged', async () => {
  const f = await fixture();
  try {
    const stored = JSON.stringify({ libraryView: 'rows', series: 'S'.repeat(200), workspaceId: 'w'.repeat(64) });
    assert.ok(stored.length < 2048);
    // A tampered or legacy row that is already near the cap: a further key must be refused, not truncated.
    const near = JSON.stringify({ legacy: 'z'.repeat(2030) });
    f.db.execute('UPDATE user_accounts SET view_prefs=? WHERE id=?', [near, ids.owner]);
    const refused = await f.call('PATCH', '/api/me', 'owner', { prefs: { series: 'Romans' } });
    assert.equal(refused.status, 400);
    assert.equal(refused.json.error, 'prefs_too_large');
    assert.equal(savedPrefs(f, ids.owner), near);
    f.db.execute('UPDATE user_accounts SET view_prefs=? WHERE id=?', ['{}', ids.owner]);
    const full = await f.call('PATCH', '/api/me', 'owner', { prefs: JSON.parse(stored) });
    assert.equal(full.status, 200);
    assert.ok(new TextEncoder().encode(savedPrefs(f, ids.owner)).length <= 2048);
  } finally { f.db.close(); }
});

test('an unreadable stored prefs value reads as empty and is replaced by the next patch', async () => {
  const f = await fixture();
  try {
    for (const junk of ['not json', '[1,2]', 'null', '"x"']) {
      f.db.execute('UPDATE user_accounts SET view_prefs=? WHERE id=?', [junk, ids.owner]);
      assert.deepEqual((await f.call('GET', '/api/me', 'owner')).json.account.prefs, {}, junk);
      const patched = await f.call('PATCH', '/api/me', 'owner', { prefs: { sort: 'title' } });
      assert.equal(patched.status, 200, junk);
      assert.deepEqual(JSON.parse(savedPrefs(f, ids.owner)), { sort: 'title' });
    }
  } finally { f.db.close(); }
});

test('PATCH prefs uses CSRF, needs a session, and changes only the caller', async () => {
  const f = await fixture();
  try {
    const body = { prefs: { libraryView: 'rows' } };
    assert.equal((await f.call('PATCH', '/api/me', 'owner', body, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await f.call('PATCH', '/api/me', null, body)).status, 401);
    assert.equal(savedPrefs(f, ids.owner), '{}');
    assert.equal((await f.call('PATCH', '/api/me', 'owner', body)).status, 200);
    assert.equal(savedPrefs(f, ids.outsider), '{}');
    assert.deepEqual((await f.call('GET', '/api/me', 'outsider')).json.account.prefs, {});
    assert.equal((await f.call('PATCH', '/api/me', 'outsider', { prefs: { sort: 'title' } })).status, 200);
    assert.deepEqual((await f.call('GET', '/api/me', 'owner')).json.account.prefs, { libraryView: 'rows' });
    assert.deepEqual(JSON.parse(savedPrefs(f, ids.outsider)), { sort: 'title' });
  } finally { f.db.close(); }
});

test('a disabled account cannot write prefs, even with a session that was valid a moment ago', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call('PATCH', '/api/me', 'editor', { prefs: { sort: 'title' } })).status, 200);
    f.db.execute('UPDATE user_accounts SET disabled_at=CURRENT_TIMESTAMP WHERE id=?', [ids.editor]);
    const denied = await f.call('PATCH', '/api/me', 'editor', { prefs: { sort: 'added' } });
    assert.equal(denied.status, 401);
    assert.deepEqual(JSON.parse(savedPrefs(f, ids.editor)), { sort: 'title' });
    assert.equal((await f.call('GET', '/api/me', 'editor')).status, 401);
  } finally { f.db.close(); }
});

test('a prefs write that lands between the read and the update is merged, not overwritten', async () => {
  const f = await fixture();
  try {
    const realPrepare = f.env.DB.prepare.bind(f.env.DB);
    let injected = false;
    f.env.DB.prepare = sql => {
      if (!injected && sql.startsWith('UPDATE user_accounts SET layout_theme')) {
        injected = true;
        f.db.execute('UPDATE user_accounts SET view_prefs=? WHERE id=?', [JSON.stringify({ sort: 'added' }), ids.owner]);
      }
      return realPrepare(sql);
    };
    const res = await f.call('PATCH', '/api/me', 'owner', { prefs: { archive: 'archived' } });
    assert.ok(injected);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.account.prefs, { sort: 'added', archive: 'archived' });
    assert.deepEqual(JSON.parse(savedPrefs(f, ids.owner)), { sort: 'added', archive: 'archived' });
  } finally { f.db.close(); }
});
