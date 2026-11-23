import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import { createPreviewServer, parseArgs } from '../scripts/theme-preview.mjs';
import { PREVIEW_OWNER } from '../scripts/theme-preview-data.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));

test('preview flags are parsed and invalid values fail closed', () => {
  assert.equal(parseArgs([]).port, 4181);
  assert.deepEqual(parseArgs(['--port', '4321', '--signed-out', '--layout', 'c', '--empty']), { port: 4321, signedOut: true, layout: 'c', empty: true });
  for (const args of [['--port', '0'], ['--port', 'abc'], ['--layout', 'other'], ['--oops']]) assert.throws(() => parseArgs(args));
});

test('preview routes through the real handler, has prototype seed data, and rejects untrusted hosts', async () => {
  const { server, db } = await createPreviewServer({ layout: 'c' });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.equal(address.address, '127.0.0.1');
    const base = `http://127.0.0.1:${address.port}`;
    const account = await fetch(base + '/api/me');
    assert.equal(account.status, 200);
    const accountBody = await account.json();
    assert.equal(accountBody.account.email_normalized, PREVIEW_OWNER.email);
    assert.equal(accountBody.account.layout, 'c');
    const shell = await fetch(base + '/');
    assert.equal(shell.status, 200);
    assert.match(await shell.text(), /assets\/js\/main\.js/);
    assert.equal((await fetch(base + '/assets/fonts/inter-latin.woff2')).status, 200);
    assert.equal(db.query('SELECT COUNT(*) AS n FROM workspaces')[0].n, 2);
    assert.equal(db.query('SELECT COUNT(*) AS n FROM sermons')[0].n, 12);
    assert.ok(db.query("SELECT COUNT(DISTINCT substr(preached_on,1,7)) AS n FROM preaching_events WHERE preached_on LIKE '2026-%'")[0].n >= 4);
    assert.ok(db.query('SELECT COUNT(*) AS n FROM places')[0].n >= 4);
    assert.ok(db.query('SELECT COUNT(*) AS n FROM note_texts')[0].n >= 12);
    assert.ok(db.query('SELECT COUNT(*) AS n FROM sermon_scripture_refs')[0].n >= 12);
    const rejected = await new Promise((resolve, reject) => httpRequest({ hostname: '127.0.0.1', port: address.port, path: '/', headers: { host: `attacker.test:${address.port}` } }, response => { response.resume(); resolve(response); }).on('error', reject).end());
    assert.equal(rejected.statusCode, 421);
    assert.match(rejected.headers['content-type'], /text\/plain/);
  } finally { await new Promise(resolve => server.close(resolve)); db.close(); }
});

test('signed-out and empty preview modes work, and src never imports the preview server', async () => {
  const preview = await createPreviewServer({ signedOut: true, empty: true, layout: 'original' });
  try {
    await new Promise(resolve => preview.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${preview.server.address().port}`;
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Sign in to open your workspace/);
    assert.equal((await fetch(base + '/api/me')).status, 401);
    assert.equal(preview.db.query('SELECT COUNT(*) AS n FROM sermons')[0].n, 0);
  } finally { await new Promise(resolve => preview.server.close(resolve)); preview.db.close(); }

  async function walk(directory) {
    const paths = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      paths.push(...(entry.isDirectory() ? await walk(path) : [path]));
    }
    return paths;
  }
  const files = await walk(resolve(repo, 'src'));
  for (const path of files.filter(path => /\.(?:[cm]?js|tsx?)$/.test(path))) {
    assert.doesNotMatch(await readFile(path, 'utf8'), /theme-preview(?:-data)?\.mjs/, `${path.slice(repo.length + 1)} imports preview code`);
  }
});
