import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreviewServer } from '../scripts/theme-preview.mjs';

async function withPreview(options, run) {
  const preview = await createPreviewServer({ loadingDelayMs: 200, ...options });
  try {
    await new Promise(resolve => preview.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${preview.server.address().port}`;
    const jar = new Map();
    // A small cookie jar: it replays what the preview sets, the way a browser would.
    const get = async (path, init = {}) => {
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      const response = await fetch(base + path, { ...init, headers: { ...(cookie ? { cookie } : {}), ...init.headers } });
      for (const line of response.headers.getSetCookie()) {
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

test('the loading fixture holds the library list calls, then answers normally', async () => {
  await withPreview({ loadingDelayMs: 250 }, async ({ get }) => {
    const paths = await libraryPaths(get);
    await get('/?preview=loading');
    const quick = Date.now();
    assert.equal((await get('/api/me')).status, 200);
    assert.ok(Date.now() - quick < 200, 'only the library list is held');
    const started = Date.now();
    const response = await get(paths.sermons);
    assert.ok(Date.now() - started >= 230, 'the list was held');
    assert.equal(response.status, 200);
    assert.ok((await response.json()).sermons.length >= 5);
  });
});

test('an abandoned held request does not keep the server open', async () => {
  await withPreview({ loadingDelayMs: 60000 }, async ({ get }) => {
    const paths = await libraryPaths(get);
    await get('/?preview=loading');
    const controller = new AbortController();
    const held = get(paths.sermons, { signal: controller.signal }).catch(error => error.name);
    await new Promise(resolve => setTimeout(resolve, 50));
    controller.abort();
    assert.equal(await held, 'AbortError');
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
