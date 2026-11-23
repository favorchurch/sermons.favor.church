import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixture, ids, origin } from './helpers/library-fixture.mjs';

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
    assert.equal(createHash('sha256').update(original.text).digest('hex'), 'bc6fd0b9da1abed92c0656cfb0b2baf361d377f2a1b544b20379c684138d7d31');
  } finally { f.db.close(); }
});
