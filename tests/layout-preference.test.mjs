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
