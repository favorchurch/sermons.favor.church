import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreviewServer } from '../scripts/theme-preview.mjs';

async function withPreview(options, run, { secureCookies = true } = {}) {
  const preview = await createPreviewServer(options);
  try {
    await new Promise(resolve => preview.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${preview.server.address().port}`;
    const jar = new Map();
    // A small cookie jar: it replays what the preview sets, the way a browser would.
    const get = async (path, init = {}) => {
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      const response = await fetch(base + path, { ...init, headers: { ...(cookie ? { cookie } : {}), ...init.headers } });
      for (const line of response.headers.getSetCookie()) {
        // A browser on local http drops Secure cookies: secureCookies: false behaves like that browser.
        if (!secureCookies && /;\s*Secure\s*(;|$)/i.test(line)) continue;
        const [pair] = line.split(';');
        const [name, ...value] = pair.split('=');
        jar.set(name, value.join('='));
      }
      return response;
    };
    await run({ get, jar, preview });
  } finally { await new Promise(resolve => preview.server.close(resolve)); preview.db.close(); }
}

async function libraryPaths(get) {
  const [workspace] = (await (await get('/api/workspaces')).json()).workspaces;
  return { sermons: `/api/workspaces/${workspace.id}/sermons?archived=include`, events: `/api/workspaces/${workspace.id}/events` };
}

test('the preview cookie selects the empty fixture for later requests until changed', async () => {
  await withPreview({}, async ({ get, jar }) => {
    const paths = await libraryPaths(get);
    assert.ok((await (await get(paths.sermons)).json()).sermons.length >= 5);
    const page = await get('/?preview=empty');
    assert.equal(page.status, 200);
    assert.match(page.headers.getSetCookie().join('\n'), /sb_preview=empty; Path=\//);
    assert.equal(jar.get('sb_preview'), 'empty');
    assert.equal((await get('/api/workspaces')).status, 200);
    assert.deepEqual((await (await get(paths.sermons)).json()).sermons, []);
    await get('/?preview=default');
    assert.ok((await (await get(paths.sermons)).json()).sermons.length >= 5);
  });
});

test('the error fixture answers 500 to the library list calls only', async () => {
  await withPreview({}, async ({ get }) => {
    const paths = await libraryPaths(get);
    await get('/?preview=error');
    assert.equal((await get(paths.sermons)).status, 500);
    assert.equal((await get(paths.events)).status, 500);
    assert.equal((await get('/api/me')).status, 200);
    assert.equal((await get('/api/workspaces')).status, 200);
    assert.equal((await get('/')).status, 200);
    await get('/?preview=default');
    assert.equal((await get(paths.sermons)).status, 200);
  });
});

test('the loading fixture injects a client-side hold ahead of the app and keeps no server request open', async () => {
  await withPreview({}, async ({ get }) => {
    const paths = await libraryPaths(get);
    const normalPage = await (await get('/?preview=default')).text();
    assert.ok(!normalPage.includes('loading-stub'), 'other fixtures get no stub');

    const page = await get('/?preview=loading');
    const html = await page.text();
    const tag = '<script src="/__preview/loading-stub.js"></script>';
    assert.equal(html.split(tag).length - 1, 1);
    const later = html.indexOf('<script', html.indexOf(tag) + tag.length);
    assert.ok(later === -1 || html.indexOf(tag) < later, 'the stub runs before the app scripts');
    assert.match(page.headers.get('content-security-policy') || '', /script-src 'self'(?:;|$)/, 'the stub is a same-origin file, not inline');

    const stub = await get('/__preview/loading-stub.js');
    assert.equal(stub.status, 200);
    assert.match(stub.headers.get('content-type'), /^text\/javascript/);

    // The server answers the library list at once: nothing is held on the server side.
    const started = Date.now();
    const response = await get(paths.sermons);
    assert.equal(response.status, 200);
    assert.ok((await response.json()).sermons.length >= 5);
    assert.ok(Date.now() - started < 1000);
    assert.equal((await get(paths.events)).status, 200);
  });
});

test('the injected fetch never settles for GET library list calls and passes everything else through', async () => {
  await withPreview({}, async ({ get }) => {
    await get('/?preview=loading');
    const source = await (await get('/__preview/loading-stub.js')).text();
    const real = async (input, init) => ({ passedThrough: String(input instanceof Request ? input.url : input), method: init?.method });
    const window = { fetch: real };
    new Function('window', 'location', source)(window, { href: 'http://127.0.0.1:4181/' });
    assert.notEqual(window.fetch, real);

    const id = '11111111-1111-4111-8111-111111111111';
    const settles = promise => Promise.race([promise.then(() => true, () => true), new Promise(resolve => setTimeout(() => resolve(false), 150))]);
    assert.equal(await settles(window.fetch(`/api/workspaces/${id}/sermons?archived=include&limit=100&offset=0`)), false);
    assert.equal(await settles(window.fetch(`/api/workspaces/${id}/events?limit=1000&offset=0`)), false);
    assert.equal(await settles(window.fetch(new Request(`http://127.0.0.1:4181/api/workspaces/${id}/sermons`))), false);

    assert.equal((await window.fetch('/api/me')).passedThrough, '/api/me');
    assert.equal((await window.fetch(`/api/workspaces/${id}/places`)).passedThrough, `/api/workspaces/${id}/places`);
    assert.equal((await window.fetch(`/api/workspaces/${id}/sermons`, { method: 'POST' })).method, 'POST');
    assert.equal((await window.fetch(`/api/workspaces/${id}/sermons/${id}`)).passedThrough, `/api/workspaces/${id}/sermons/${id}`);
  });
});

test('the no-workspace fixture leaves the account in no workspace, which shows the join view', async () => {
  await withPreview({}, async ({ get }) => {
    assert.equal((await (await get('/api/workspaces')).json()).workspaces.length, 2);
    await get('/?preview=no-workspace');
    assert.deepEqual((await (await get('/api/workspaces')).json()).workspaces, []);
    const me = await get('/api/me');
    assert.equal(me.status, 200);
    assert.equal((await me.json()).account.email_normalized, 'preview@example.test');
  });
});

test('preview_layout sets sb_layout, works signed out, and keeps the account layout in step', async () => {
  await withPreview({ signedOut: true, layout: 'a' }, async ({ get, jar }) => {
    const designA = await (await get('/')).text();
    const original = await get('/?preview_layout=original');
    assert.match(original.headers.getSetCookie().join('\n'), /sb_layout=original; Path=\//);
    const originalHtml = await original.text();
    assert.match(originalHtml, /Sign in to open your workspace/);
    assert.notEqual(originalHtml, designA);
    assert.equal(jar.get('sb_layout'), 'original');
    assert.equal(await (await get('/')).text(), originalHtml);
    await get('/?preview_layout=c');
    assert.equal(jar.get('sb_layout'), 'c');
    assert.equal((await get('/api/me')).status, 401);
  });
  await withPreview({ layout: 'a' }, async ({ get }) => {
    await get('/?preview_layout=c');
    assert.equal((await (await get('/api/me')).json()).account.layout, 'c');
    await get('/?preview_layout=original');
    assert.equal((await (await get('/api/me')).json()).account.layout, 'original');
  });
});

test('a layout saved through PATCH /api/me survives a reload, even when the browser drops Secure cookies', async () => {
  await withPreview({ layout: 'a' }, async ({ get, jar }) => {
    const saved = await get('/api/me', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ layout: 'c' }) });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).account.layout, 'c');
    const layoutCookie = saved.headers.getSetCookie().find(line => line.startsWith('sb_layout='));
    assert.ok(layoutCookie, 'the app sets sb_layout on PATCH');
    assert.ok(!/Secure/i.test(layoutCookie), 'the proxy sends it without Secure for local http');
    // A browser that dropped the cookie, a stale one, and a normal reload all keep c.
    for (const stale of [undefined, 'sb_layout=a']) {
      const reloaded = await get('/', stale ? { headers: { cookie: stale } } : {});
      assert.equal(reloaded.status, 200);
      assert.equal((await (await get('/api/me', stale ? { headers: { cookie: stale } } : {})).json()).account.layout, 'c');
    }
    assert.equal(jar.get('sb_layout'), 'c');
    assert.equal((await (await get('/api/me')).json()).account.layout, 'c');
  });
  // Same flow with a browser that drops Secure cookies: the saved choice is still c after a fresh GET of / and GET /api/me.
  await withPreview({ layout: 'a' }, async ({ get, jar }) => {
    await get('/api/me', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ layout: 'c' }) });
    assert.equal(jar.get('sb_layout'), 'c', 'the cookie the proxy sent was kept');
    assert.equal((await get('/')).status, 200);
    assert.equal((await (await get('/api/me')).json()).account.layout, 'c');
  }, { secureCookies: false });
  // ?preview_layout still sets the layout explicitly.
  await withPreview({ layout: 'a' }, async ({ get }) => {
    await get('/api/me', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ layout: 'c' }) });
    await get('/?preview_layout=original');
    assert.equal((await (await get('/api/me')).json()).account.layout, 'original');
  });
});

test('unknown fixture or layout values are rejected and the cookie is not set', async () => {
  await withPreview({}, async ({ get, jar }) => {
    for (const path of ['/?preview=nope', '/?preview_layout=zzz', '/?preview=', '/?preview_layout=']) {
      const response = await get(path);
      assert.equal(response.status, 400, path);
      assert.deepEqual(response.headers.getSetCookie(), []);
    }
    assert.equal(jar.size, 0);
    await get('/', { headers: { cookie: 'sb_preview=bogus' } });
    assert.equal((await get('/api/workspaces')).status, 200);
  });
});
