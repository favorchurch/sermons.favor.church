// scripts/staging-qa.mjs run in-process: its HTTP goes to the real request handler and its SQL to an in-memory D1
// (the script's `transport` seam). Fictional data, no network, no wrangler, nothing remote.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseMock } from './helpers/d1.mjs';
import { handleRequest } from '../src/auth/app.ts';

const PUBLIC = new URL('../public/', import.meta.url);
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
const assets = { async fetch(request) {
  const path = new URL(request.url).pathname;
  const file = path === '/' ? 'index.html' : path.slice(1);
  try {
    return new Response(await readFile(new URL(file, PUBLIC)), { headers: { 'content-type': TYPES[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream' } });
  } catch { return new Response('missing', { status: 404 }); }
} };

/** Run the QA once. `mutate` may change the worker environment or database before it starts. */
async function runQa(t, { env: extraEnv = {}, strip = [] } = {}) {
  const qa = await import('../scripts/staging-qa.mjs');
  const db = new DatabaseMock();
  const env = { DB: db, ASSETS: assets, PUBLIC_ORIGIN: 'https://sermons-preview.favor.church', ...extraEnv };
  const traffic = [];
  qa.transport.send = async ({ method, url, headers, body }) => {
    const response = await handleRequest(new Request(url, { method, headers, body: method === 'GET' ? undefined : body }), env);
    const head = [`HTTP/1.1 ${response.status} X`, ...[...response.headers].filter(([k]) => k !== 'set-cookie' && !strip.includes(k)).map(([k, v]) => `${k}: ${v}`),
      ...response.headers.getSetCookie().map(c => `set-cookie: ${c}`)];
    traffic.push({ method, path: new URL(url).pathname, status: response.status });
    return { head, text: await response.text() };
  };
  qa.transport.sql = async sql => {
    if (/^\s*SELECT/i.test(sql)) return [{ results: db.connection.prepare(sql).all().map(row => ({ ...row })) }];
    db.connection.exec(sql);
    return [{ results: [] }];
  };
  qa.transport.tail = () => ({ child: { killed: true, exitCode: 0, kill() {} }, lines: [], isReady: () => true, failure: () => null, stop() {} });
  const lines = [];
  t.mock.method(console, 'log', (...args) => { lines.push(args.join(' ')); });
  await qa.main();
  const exitCode = process.exitCode;
  process.exitCode = 0;
  const rows = lines.join('\n').split('\n').map(line => /^(PASS|FAIL|SKIP|WARN)\s+(\S+)\s+(.*)$/.exec(line)).filter(Boolean).map(m => ({ status: m[1], id: m[2], text: m[3] }));
  return { rows, exitCode, traffic, db };
}

test('QA against the real handler: every check passes and every synthetic row is gone', { timeout: 120_000 }, async t => {
  const { rows, exitCode, traffic, db } = await runQa(t);
  const failed = rows.filter(r => r.status === 'FAIL');
  assert.deepEqual(failed, [], 'failing checks');
  assert.equal(exitCode, 0);
  const passed = new Set(rows.filter(r => r.status === 'PASS').map(r => r.id));
  for (const id of ['NEW-1', 'NEW-2', 'NEW-3', 'NEW-4', 'NEW-5', 'NEW-6', 'NEW-7', 'NEW-8', 'NEW-9', 'NEW-10',
    'SRCH-1', 'SRCH-2', 'SRCH-3', 'SRCH-4', 'SRCH-5', 'SRCH-6', 'SRCH-7', 'SRCH-8', 'SRCH-9', 'LEAK-1', 'CLEAN-1']) {
    assert.ok(passed.has(id), `${id} did not pass`);
  }
  // The Owner control of NEW-5 reaches the consent handler (409: the QA PDF version is not awaiting consent). Only the Owner gets 409.
  assert.ok(traffic.some(r => r.method === 'POST' && /\/versions\/[^/]+\/consent$/.test(r.path) && r.status === 409), 'owner never reached the consent handler');
  assert.ok(traffic.some(r => /\/imports\/[^/]+\/summary$/.test(r.path) && r.status === 403), 'no role refusal on imports');
  for (const table of ['user_accounts', 'workspaces', 'sermons', 'sermon_versions', 'places', 'preaching_events', 'note_texts', 'note_reference_tokens', 'audit_events']) {
    assert.equal(db.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, `${table} left rows behind`);
  }
  assert.equal(db.connection.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'protect_owner_membership_%'`).get().n, 2);
});

test('QA refuses before any request or write when the config or the origin is not the pinned staging', async () => {
  const qa = await import('../scripts/staging-qa.mjs');
  const calls = [];
  qa.transport.send = async () => { calls.push('send'); throw new Error('network is not allowed in tests'); };
  qa.transport.sql = async () => { calls.push('sql'); throw new Error('remote D1 is not allowed in tests'); };
  qa.transport.tail = () => { calls.push('tail'); throw new Error('tail is not allowed in tests'); };
  const other = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  other.env.staging.d1_databases[0].database_id = '11111111-2222-4333-8444-555555555555';
  await assert.rejects(qa.main({ readConfig: async () => JSON.stringify(other) }), /pinned/);
  await assert.rejects(qa.main({ origin: 'https://sermons.favor.church' }), /STAGING_ORIGIN must be/);
  await assert.rejects(qa.main({ origin: 'https://evil.example' }), /STAGING_ORIGIN must be/);
  assert.deepEqual(calls, []);
});

test('QA fails when the app shell is missing its assets binding (the checks can fail)', { timeout: 120_000 }, async t => {
  const { rows, exitCode } = await runQa(t, { env: { ASSETS: undefined } });
  assert.ok(rows.some(r => r.status === 'FAIL' && r.id === 'NEW-3'), 'NEW-3 should fail without ASSETS');
  assert.equal(exitCode, 1);
});

test('NEW-3 frame guard: CSP frame-ancestors is required, a missing X-Frame-Options only warns', async () => {
  const { frameGuard } = await import('../scripts/staging-qa.mjs');
  const csp = "default-src 'none'; frame-ancestors 'none'";
  const withBoth = frameGuard(new Headers({ 'content-security-policy': csp, 'x-frame-options': 'DENY' }));
  assert.deepEqual(withBoth, { ok: true, warning: '' });
  // The live edge strips X-Frame-Options: still ok, with a warning that names the edge.
  const stripped = frameGuard(new Headers({ 'content-security-policy': csp }));
  assert.equal(stripped.ok, true);
  assert.match(stripped.warning, /X-Frame-Options is absent.*edge/);
  // Without the CSP directive the check fails, whatever X-Frame-Options says.
  assert.equal(frameGuard(new Headers({ 'x-frame-options': 'DENY' })).ok, false);
  assert.equal(frameGuard(new Headers({ 'content-security-policy': "default-src 'none'; frame-ancestors 'self'", 'x-frame-options': 'DENY' })).ok, false);
  assert.equal(frameGuard(new Headers({ 'content-security-policy': "default-src 'none'; x-frame-ancestors 'none'" })).ok, false);
  assert.match(frameGuard(new Headers({ 'content-security-policy': csp, 'x-frame-options': 'SAMEORIGIN' })).warning, /SAMEORIGIN/);
});

test('QA passes NEW-3 with a WARN when the edge strips X-Frame-Options from the shell', { timeout: 120_000 }, async t => {
  const { rows, exitCode } = await runQa(t, { strip: ['x-frame-options'] });
  assert.equal(exitCode, 0);
  assert.ok(rows.some(r => r.status === 'PASS' && r.id === 'NEW-3'), 'NEW-3 should pass');
  assert.ok(rows.some(r => r.status === 'WARN' && r.id === 'NEW-3' && /edge/.test(r.text)), 'NEW-3 should warn naming the edge');
});
