#!/usr/bin/env node
/**
 * Staging end-to-end auth QA. Run with `pnpm qa:staging`.
 *
 * - Seeds synthetic `*.test` accounts, workspaces, sessions and invitations in the
 *   STAGING D1 only (`wrangler d1 execute --env staging --remote`).
 * - Session and invite tokens are minted by inserting only their SHA-256 hashes
 *   (the scheme in src/auth). Raw tokens live in memory and are never printed.
 * - Exercises the deployed Worker over real HTTP, prints a PASS/FAIL/SKIP/WARN table,
 *   exits non-zero on any FAIL and removes every synthetic row it created.
 * - The real Google round trip (login, /api/me, logout) is out of scope: only the
 *   /auth/google/start redirect and state replay rejection are covered here.
 * - The library, search, import, PDF and app-shell routes are covered by qaNewRoutes*: unauthenticated 401/404 on
 *   every route, cross-workspace 404, Viewer 403 on every mutation (with a check that nothing changed),
 *   and search that never returns another workspace's titles, text or revoked text.
 */
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertStagingConfig, isStagingOrigin, STAGING_ORIGIN, SeedRefusal } from './seed-staging.mjs';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER = join(ROOT, 'node_modules', '.bin', 'wrangler');
const ORIGIN = (process.env.STAGING_ORIGIN || STAGING_ORIGIN).replace(/\/$/, '');
const DOH = process.env.QA_DOH_URL || 'https://1.1.1.1/dns-query';
const SESSION_COOKIE = '__Host-sb_session';
const FLOW_COOKIE = '__Secure-sb_flow';
const EMAIL_DOMAIN = 'sermon-qa.test';
const RUN = randomBytes(3).toString('hex');

const sha256 = text => createHash('sha256').update(text).digest('base64url'); // same encoding as src/auth/security.ts
const token = () => randomBytes(32).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
const uuid = () => randomUUID();
const email = name => `${name}-${RUN}@${EMAIL_DOMAIN}`;

const results = [];
const secrets = new Set(); // raw tokens and synthetic emails: must never appear in errors or logs
const observedErrors = []; // every non-2xx response (status, headers, body) for the leak scan

function record(id, status, name, detail = '') { results.push({ id, status, name, detail }); }
function check(id, name, ok, detail = '') { record(id, ok ? 'PASS' : 'FAIL', name, ok ? '' : detail); return ok; }
function skip(id, name, reason) { record(id, 'SKIP', name, reason); }
function warn(id, name, reason) { record(id, 'WARN', name, reason); }

/** Framing guard of the signed-in shell: the CSP must carry frame-ancestors 'none'. X-Frame-Options is only a
 *  legacy duplicate, and the live edge strips it from every response, so its absence warns without failing. */
export function frameGuard(headers) {
  const xfo = headers.get('x-frame-options');
  return {
    ok: /(?:^|;)\s*frame-ancestors 'none'\s*(?:;|$)/.test(headers.get('content-security-policy') || ''),
    warning: !xfo ? 'X-Frame-Options is absent; the edge in front of the Worker likely strips it (CSP frame-ancestors still blocks framing)' : xfo.toUpperCase() === 'DENY' ? '' : `X-Frame-Options is ${xfo}, expected DENY`
  };
}

function redact(text) {
  let out = String(text);
  for (const s of secrets) out = out.split(s).join('[redacted]');
  return out.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]').slice(0, 300);
}

// ---------- transport (real network and D1 by default; replaceable so the checks can run against a local Worker) ----------
async function curlSend({ method, url, headers, body }) {
  const args = ['-sS', '-i', '--max-time', '30', '--max-redirs', '0', '--doh-url', DOH, '-X', method];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body !== undefined) args.push('--data-binary', body);
  args.push(url);
  for (let attempt = 1; ; attempt++) { // retry transient network errors (DoH lookup, reset) only; HTTP statuses are never retried
    try {
      const { stdout } = await run('curl', args, { maxBuffer: 4 << 20 });
      const split = stdout.indexOf('\r\n\r\n');
      return { head: stdout.slice(0, split).split('\r\n'), text: stdout.slice(split + 4) };
    } catch (error) {
      if (attempt >= 3) throw new Error(`curl failed (exit ${error.code}) ${method} ${url.slice(ORIGIN.length)}: ${redact(String(error.stderr || '').trim().split('\n').pop())}`);
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}
async function wranglerSql(sql) {
  // --command rather than --file: wrangler 4.47's --file upload trips a FileHandle error on current Node.
  const { stdout } = await run(WRANGLER, ['d1', 'execute', 'DB', '--config', join(ROOT, 'wrangler.jsonc'), '--env', 'staging', '--remote', '--command', sql, '--json'],
    { cwd: ROOT, maxBuffer: 16 << 20, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' } });
  return JSON.parse(stdout);
}
function wranglerTail() {
  const lines = [];
  let ready = false;
  const child = spawn(WRANGLER, ['tail', '--config', join(ROOT, 'wrangler.jsonc'), '--env', 'staging', '--format', 'json'], { cwd: ROOT, env: { ...process.env, NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false' } });
  const onData = chunk => { ready = true; lines.push(chunk.toString()); };
  child.stdout.on('data', onData);
  child.stderr.on('data', chunk => { ready = true; lines.push(chunk.toString()); });
  let failed = null, stopping = false;
  child.on('error', error => { failed = error.message; });
  child.on('exit', code => { if (code && !failed && !stopping) failed = `exited ${code}`; });
  return { child, lines, isReady: () => ready, failure: () => failed, stop: () => { stopping = true; child.kill('SIGINT'); } };
}
export const transport = { send: curlSend, sql: wranglerSql, tail: wranglerTail };

// ---------- HTTP ----------
async function http(method, path, { cookie, headers = {}, body, origin = ORIGIN, json = true } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (method !== 'GET' && origin) h.origin = origin;
  if (body !== undefined) { if (json) h['content-type'] = 'application/json'; }
  const { head, text } = await transport.send({ method, url: ORIGIN + path, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const status = Number(head[0].split(' ')[1]);
  const resHeaders = new Map();
  const setCookies = [];
  for (const line of head.slice(1)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim();
    if (k === 'set-cookie') setCookies.push(v);
    resHeaders.set(k, v);
  }
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  const entry = { status, headers: head.join('\n'), text, expected: [] };
  if (status < 200 || status >= 300) observedErrors.push(entry);
  return { status, headers: resHeaders, setCookies, text, data, entry };
}
const asSession = tok => `${SESSION_COOKIE}=${tok}`;

// ---------- D1 (staging only) ----------
async function d1(sql) {
  try { return await transport.sql(sql); } catch (error) {
    throw new Error('wrangler d1 execute failed: ' + redact(`${error.stderr || ''}${error.stdout || ''}` || error.message));
  }
}
async function d1Rows(sql) {
  const out = await d1(sql);
  return out.flatMap(statement => statement.results || []);
}
const q = value => (value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replace(/'/g, "''")}'`);

// ---------- cleanup of every synthetic row (also removes leftovers from a crashed earlier run) ----------
let ownerTriggers = [];
async function loadOwnerTriggers() {
  const sql = await readFile(join(ROOT, 'migrations', '0002_auth.sql'), 'utf8');
  ownerTriggers = [...sql.matchAll(/CREATE TRIGGER protect_owner_membership_\w+[\s\S]*?END;/g)].map(m => m[0]);
  if (ownerTriggers.length !== 2) throw new Error('owner protection triggers not found in migrations/0002_auth.sql');
}
const SYN_ACCOUNTS = `(SELECT id FROM user_accounts WHERE email_normalized LIKE '%@${EMAIL_DOMAIN}')`;
const SYN_WORKSPACES = `(SELECT id FROM workspaces WHERE owner_account_id IN ${SYN_ACCOUNTS})`;
// Staging holds a real pilot workspace ("Favor Church") and pilot-qa.test accounts. This script may only touch
// rows reachable from the sermon-qa.test domain, and aborts before any write if that boundary is crossed.
const PROTECTED_WORKSPACE = 'Favor Church';
async function guardProtectedData() {
  if (EMAIL_DOMAIN !== 'sermon-qa.test') throw new Error('guard: QA email domain must be sermon-qa.test');
  const [g] = await d1Rows(`SELECT
    (SELECT COUNT(*) FROM workspaces WHERE id IN ${SYN_WORKSPACES} AND name = ${q(PROTECTED_WORKSPACE)}) AS named,
    (SELECT COUNT(*) FROM workspace_memberships WHERE workspace_id IN ${SYN_WORKSPACES}
       AND account_id NOT IN ${SYN_ACCOUNTS}) AS foreign_members,
    (SELECT COUNT(*) FROM workspace_memberships WHERE account_id IN ${SYN_ACCOUNTS}
       AND workspace_id NOT IN ${SYN_WORKSPACES}) AS joined_elsewhere`);
  if (g.named || g.foreign_members || g.joined_elsewhere) {
    throw new Error(`guard: synthetic rows touch non-QA data (named ${g.named}, foreign members ${g.foreign_members}, joined elsewhere ${g.joined_elsewhere}); aborting without writes`);
  }
}
async function cleanup({ requireTriggers = false } = {}) {
  await guardProtectedData();
  // The owner-protection triggers (correctly) block deleting owner memberships, so they are dropped and
  // recreated from the migration inside the same execution, then verified.
  const statements = [
    `DELETE FROM oauth_login_attempts WHERE code_verifier LIKE 'qa-${'%'}'`,
    `DELETE FROM auth_sessions WHERE account_id IN ${SYN_ACCOUNTS}`,
    `DELETE FROM audit_events WHERE workspace_id IN ${SYN_WORKSPACES} OR actor_account_id IN ${SYN_ACCOUNTS}`,
    `DELETE FROM workspace_invitations WHERE workspace_id IN ${SYN_WORKSPACES} OR email_normalized LIKE '%@${EMAIL_DOMAIN}'`,
    `DROP TRIGGER IF EXISTS protect_owner_membership_update`,
    `DROP TRIGGER IF EXISTS protect_owner_membership_delete`,
    `DELETE FROM workspace_memberships WHERE workspace_id IN ${SYN_WORKSPACES} OR account_id IN ${SYN_ACCOUNTS}`,
    `DELETE FROM sermons WHERE workspace_id IN ${SYN_WORKSPACES}`,
    `DELETE FROM workspaces WHERE owner_account_id IN ${SYN_ACCOUNTS} AND name <> ${q(PROTECTED_WORKSPACE)}`,
    `DELETE FROM google_identities WHERE account_id IN ${SYN_ACCOUNTS}`,
    `DELETE FROM user_accounts WHERE email_normalized LIKE '%@${EMAIL_DOMAIN}'`,
    ...ownerTriggers
  ];
  await d1(statements.join(';\n') + ';');
  const left = await d1Rows(`SELECT
    (SELECT COUNT(*) FROM user_accounts WHERE email_normalized LIKE '%@${EMAIL_DOMAIN}') AS accounts,
    (SELECT COUNT(*) FROM workspaces WHERE id IN (${q(W.alpha)}, ${q(W.beta)})) AS workspaces,
    (SELECT COUNT(*) FROM sermons WHERE workspace_id IN (${q(W.alpha)}, ${q(W.beta)})) + (SELECT COUNT(*) FROM sermon_versions WHERE workspace_id IN (${q(W.alpha)}, ${q(W.beta)})) +
      (SELECT COUNT(*) FROM preaching_events WHERE workspace_id IN (${q(W.alpha)}, ${q(W.beta)})) + (SELECT COUNT(*) FROM places WHERE workspace_id IN (${q(W.alpha)}, ${q(W.beta)})) +
      (SELECT COUNT(*) FROM audit_events WHERE workspace_id IN (${q(W.alpha)}, ${q(W.beta)})) AS library_rows,
    (SELECT COUNT(*) FROM note_texts WHERE body LIKE '%qa%marker${RUN}%') + (SELECT COUNT(*) FROM note_reference_tokens WHERE workspace_id IN (${q(W.alpha)}, ${q(W.beta)})) AS note_rows,
    (SELECT COUNT(*) FROM note_fts WHERE note_fts MATCH '${MARK.alpha} OR ${MARK.beta} OR ${MARK.revoked}') AS fts_rows,
    (SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'protect_owner_membership_%') AS triggers,
    (SELECT COUNT(*) FROM oauth_login_attempts WHERE code_verifier LIKE 'qa-%') AS attempts`);
  if (requireTriggers && left[0].triggers !== 2) {
    throw new Error(`ABORT: staging D1 has ${left[0].triggers} owner-protection triggers after cleanup (expected 2); restore them from migrations/0002_auth.sql before any further run`);
  }
  return left[0];
}

// ---------- fixtures ----------
const W = { alpha: uuid(), beta: uuid() };
const A = Object.fromEntries(['owner', 'admin', 'admin2', 'editor', 'viewer', 'outsider', 'invitee', 'inviteeWrong', 'expired', 'revoked', 'disabled', 'fresh']
  .map(name => [name, { id: uuid(), email: email(name), session: token() }]));
const INVITE_EXPIRED = { id: uuid(), raw: token() };
const INVITE_REVOKED = { id: uuid(), raw: token() };
const SERMON = { alpha: uuid(), beta: uuid() };
// Library fixtures: one sermon per workspace, so the older one-sermon checks above still hold.
const VERSION = { alpha: uuid(), alphaRevoked: uuid(), alphaPdf: uuid(), beta: uuid() };
const PLACE = { alpha: uuid(), alpha2: uuid(), beta: uuid() };
const EVENT = { alpha: uuid(), beta: uuid() };
const IMPORT = { batch: uuid(), row: uuid() }; // ids that exist nowhere: only used to prove the route exists and is gated
// Search markers: letters and digits only, so they survive the search tokenizer as one word.
const MARK = { alpha: `qaalphamarker${RUN}`, beta: `qabetamarker${RUN}`, revoked: `qarevokedmarker${RUN}` };
const NOTE = {
  alpha: `Grace notes for the alpha archive. ${MARK.alpha} appears here. Read John 3:16 aloud.`,
  beta: `Hope notes for the beta archive. ${MARK.beta} appears here. Read Romans 8:28 aloud.`,
  revoked: `Withdrawn notes that were never purged. ${MARK.revoked} appears here.`
};
const OAUTH = { state: token(), nonce: token(), verifier: 'qa-' + token() };
for (const a of Object.values(A)) { secrets.add(a.email); secrets.add(a.session); }
for (const t of [INVITE_EXPIRED.raw, INVITE_REVOKED.raw, OAUTH.state]) secrets.add(t);
const ALPHA_ONLY = [MARK.alpha, MARK.revoked, 'QA alpha', 'Alpha QA'], BETA_ONLY = [MARK.beta, 'QA beta', 'Beta QA'];

function seedSql() {
  const t = now();
  const s = [];
  for (const a of Object.values(A)) {
    s.push(`INSERT INTO user_accounts(id,email_normalized,display_name,disabled_at) VALUES(${q(a.id)},${q(a.email)},'QA Account',${a === A.disabled ? 'CURRENT_TIMESTAMP' : 'NULL'})`);
  }
  s.push(`INSERT INTO workspaces(id,name,owner_account_id) VALUES(${q(W.alpha)},'QA Alpha ${RUN}',${q(A.owner.id)})`);
  s.push(`INSERT INTO workspaces(id,name,owner_account_id) VALUES(${q(W.beta)},'QA Beta ${RUN}',${q(A.outsider.id)})`);
  const members = [[W.alpha, A.owner, 'owner'], [W.alpha, A.admin, 'admin'], [W.alpha, A.admin2, 'admin'], [W.alpha, A.editor, 'editor'],
    [W.alpha, A.viewer, 'viewer'], [W.beta, A.outsider, 'owner']];
  for (const [w, a, role] of members) {
    s.push(`INSERT INTO workspace_memberships(workspace_id,account_id,role,accepted_at) VALUES(${q(w)},${q(a.id)},${q(role)},CURRENT_TIMESTAMP)`);
  }
  s.push(`INSERT INTO sermons(id,workspace_id,title,scripture_passage) VALUES(${q(SERMON.alpha)},${q(W.alpha)},'QA alpha sermon ${RUN}','John 3:16')`);
  s.push(`INSERT INTO sermons(id,workspace_id,title,scripture_passage) VALUES(${q(SERMON.beta)},${q(W.beta)},'QA beta sermon ${RUN}','Romans 8:28')`);
  s.push(`INSERT INTO sermon_scripture_refs(workspace_id,sermon_id,position,reference_text) VALUES(${q(W.alpha)},${q(SERMON.alpha)},0,'John 3:16'),(${q(W.beta)},${q(SERMON.beta)},0,'Romans 8:28')`);
  s.push(...libraryFixtureSql());
  for (const a of Object.values(A)) {
    const expires = a === A.expired ? t - 60 : t + 3600;
    const revoked = a === A.revoked ? 'CURRENT_TIMESTAMP' : 'NULL';
    s.push(`INSERT INTO auth_sessions(token_hash,account_id,expires_at,revoked_at) VALUES(${q(sha256(a.session))},${q(a.id)},${expires},${revoked})`);
  }
  // Pre-existing invitations that must be refused: expired and revoked.
  s.push(`INSERT INTO workspace_invitations(id,workspace_id,email_normalized,invited_role,token_hash,invited_by_account_id,expires_at)
    VALUES(${q(INVITE_EXPIRED.id)},${q(W.alpha)},${q(A.fresh.email)},'viewer',${q(sha256(INVITE_EXPIRED.raw))},${q(A.owner.id)},${t - 60})`);
  s.push(`INSERT INTO workspace_invitations(id,workspace_id,email_normalized,invited_role,token_hash,invited_by_account_id,expires_at,revoked_at)
    VALUES(${q(INVITE_REVOKED.id)},${q(W.alpha)},${q(A.fresh.email)},'viewer',${q(sha256(INVITE_REVOKED.raw))},${q(A.owner.id)},${t + 3600},CURRENT_TIMESTAMP)`);
  // A login attempt for the state replay check (hash only; raw state is the callback parameter).
  s.push(`INSERT INTO oauth_login_attempts(state_hash,nonce,code_verifier,expires_at) VALUES(${q(sha256(OAUTH.state))},${q(OAUTH.nonce)},${q(OAUTH.verifier)},${t + 600})`);
  return s.join(';\n') + ';';
}

/**
 * Versions, places, an event and indexed note text for both QA workspaces, written the way the Worker stores them
 * (consent by the workspace Owner, text plus reference tokens), plus one REVOKED version whose text was never purged:
 * search must not show it even though the text is still in the table.
 */
function libraryFixtureSql() {
  const s = [];
  const version = (id, w, sermon, label, type, state, ownerId, doc) => s.push(`INSERT INTO sermon_versions(id,workspace_id,sermon_id,label,source_type,google_document_id,indexing_state,index_consent_by,index_consent_at)
    VALUES(${q(id)},${q(w)},${q(sermon)},${q(label)},${q(type)},${q(doc)},${q(state)},${state === 'not_indexed' ? 'NULL' : q(ownerId)},${state === 'not_indexed' ? 'NULL' : 'CURRENT_TIMESTAMP'})`);
  version(VERSION.alpha, W.alpha, SERMON.alpha, 'QA original', 'google_doc', 'indexed', A.owner.id, `qa-doc-alpha-${RUN}`);
  version(VERSION.alphaRevoked, W.alpha, SERMON.alpha, 'QA revoked copy', 'google_doc', 'revoked', A.owner.id, `qa-doc-revoked-${RUN}`);
  version(VERSION.alphaPdf, W.alpha, SERMON.alpha, 'QA pdf', 'pdf', 'not_indexed', null, null);
  version(VERSION.beta, W.beta, SERMON.beta, 'QA original', 'google_doc', 'indexed', A.outsider.id, `qa-doc-beta-${RUN}`);
  const note = (w, sermon, v, body) => s.push(`INSERT INTO note_texts(workspace_id,sermon_id,version_id,body,consent_at)
    SELECT workspace_id,sermon_id,id,${q(body)},index_consent_at FROM sermon_versions WHERE workspace_id=${q(w)} AND id=${q(v)}`);
  note(W.alpha, SERMON.alpha, VERSION.alpha, NOTE.alpha);
  note(W.alpha, SERMON.alpha, VERSION.alphaRevoked, NOTE.revoked);
  note(W.beta, SERMON.beta, VERSION.beta, NOTE.beta);
  const token = (w, v, book, chapter, verse, body, ref) => s.push(`INSERT INTO note_reference_tokens(workspace_id,version_id,book,chapter,verse_start,verse_end,text_start,text_end,consent_at)
    SELECT workspace_id,version_id,${q(book)},${chapter},${verse},${verse},${body.indexOf(ref)},${body.indexOf(ref) + ref.length},consent_at FROM note_texts WHERE workspace_id=${q(w)} AND version_id=${q(v)}`);
  token(W.alpha, VERSION.alpha, 'John', 3, 16, NOTE.alpha, 'John 3:16');
  token(W.beta, VERSION.beta, 'Romans', 8, 28, NOTE.beta, 'Romans 8:28');
  s.push(`INSERT INTO places(id,workspace_id,display_name) VALUES(${q(PLACE.alpha)},${q(W.alpha)},'QA alpha hall ${RUN}'),(${q(PLACE.alpha2)},${q(W.alpha)},'QA alpha annex ${RUN}'),(${q(PLACE.beta)},${q(W.beta)},'QA beta hall ${RUN}')`);
  s.push(`INSERT INTO preaching_events(id,workspace_id,sermon_id,version_id,place_id,preached_on,date_precision,occasion) VALUES
    (${q(EVENT.alpha)},${q(W.alpha)},${q(SERMON.alpha)},${q(VERSION.alpha)},${q(PLACE.alpha)},'2026-03-01','exact','QA alpha occasion'),
    (${q(EVENT.beta)},${q(W.beta)},${q(SERMON.beta)},${q(VERSION.beta)},${q(PLACE.beta)},'2026-03-01','exact','QA beta occasion')`);
  return s;
}

// ---------- QA items ----------
const has = (res, key) => JSON.stringify(res.data || {}).includes(key);

async function qaPublic() {
  const health = await http('GET', '/health');
  check('PUB-1', 'GET /health returns 200 ok', health.status === 200 && health.data?.status === 'ok', `status ${health.status}`);
  const page = await http('GET', '/');
  check('PUB-2', 'Sign-in page is no-store HTML with strict CSP', page.status === 200 &&
    /text\/html/.test(page.headers.get('content-type') || '') && /no-store/.test(page.headers.get('cache-control') || '') &&
    /default-src 'none'/.test(page.headers.get('content-security-policy') || ''), `status ${page.status}`);
  const unknown = await http('GET', '/nope');
  check('PUB-3', 'Unknown path returns 404 JSON', unknown.status === 404 && unknown.data?.error === 'not_found', `status ${unknown.status}`);
  const welcome = await http('GET', '/welcome');
  check('PUB-4', '/welcome redirects to /api/me without a session cookie', welcome.status === 303 && welcome.headers.get('location') === '/api/me', `status ${welcome.status}`);
}

let startConfigured = false;
async function qaOAuth() {
  const start = await http('GET', '/auth/google/start');
  if (start.status === 503) {
    skip('OAUTH-1', '/auth/google/start redirect parameters', 'returns 503 identity_provider_not_configured: Google secrets not set yet');
  } else {
    startConfigured = true;
    const loc = start.headers.get('location') || '';
    let url = null;
    try { url = new URL(loc); } catch { /* checked below */ }
    const p = url?.searchParams;
    const flow = start.setCookies.find(c => c.startsWith(FLOW_COOKIE + '='));
    const flowValue = flow?.split(';')[0].slice(FLOW_COOKIE.length + 1);
    if (flowValue) {
      secrets.add(flowValue);
      // The OAuth state legitimately appears in this one response's Location and flow Set-Cookie header lines.
      // Exempt it from those header lines only; the body is scanned unchanged.
      start.entry.expected.push(flowValue);
    }
    const ok = start.status === 303 && url?.origin === 'https://accounts.google.com' && url.pathname === '/o/oauth2/v2/auth' &&
      p.get('response_type') === 'code' && p.get('redirect_uri') === ORIGIN + '/auth/google/callback' &&
      p.get('code_challenge_method') === 'S256' && /^[A-Za-z0-9_-]{43}$/.test(p.get('code_challenge') || '') &&
      /^[A-Za-z0-9_-]{43}$/.test(p.get('nonce') || '') && p.get('state') === flowValue && !p.has('client_secret') &&
      (p.get('scope') || '').split(' ').sort().join(' ') === 'email openid profile' &&
      /HttpOnly/.test(flow || '') && /Secure/.test(flow || '') && /SameSite=Lax/.test(flow || '') && /Path=\/auth\/google\/callback/.test(flow || '');
    check('OAUTH-1', '/auth/google/start redirect: S256 PKCE, nonce, state==flow cookie, scopes, redirect_uri, cookie attrs', ok, `status ${start.status}`);
  }

  const cb = (state, cookieState, code = 'qa-fake-code') =>
    http('GET', `/auth/google/callback?state=${state}&code=${code}`, { cookie: cookieState ? `${FLOW_COOKIE}=${cookieState}` : undefined });
  const noCookie = await cb(OAUTH.state, null);
  check('OAUTH-2', 'Callback without flow cookie is rejected (401 login_failed)', noCookie.status === 401 && noCookie.data?.error === 'login_failed', `status ${noCookie.status}`);
  const mismatch = await cb(OAUTH.state, token());
  check('OAUTH-3', 'Callback with state != flow cookie is rejected', mismatch.status === 401, `status ${mismatch.status}`);
  const unknownState = token();
  secrets.add(unknownState);
  const unknown = await cb(unknownState, unknownState);
  check('OAUTH-4', 'Callback with never-issued state is rejected', unknown.status === 401, `status ${unknown.status}`);
  const malformed = await cb('short', 'short');
  check('OAUTH-5', 'Callback with malformed state is rejected', malformed.status === 401, `status ${malformed.status}`);
  const before = await d1Rows(`SELECT COUNT(*) AS n FROM oauth_login_attempts WHERE state_hash = ${q(sha256(OAUTH.state))}`);
  check('OAUTH-6', 'Failed callbacks above did not consume the seeded attempt', before[0]?.n === 1, 'attempt row missing');
  const first = await cb(OAUTH.state, OAUTH.state);
  check('OAUTH-7', 'Callback with valid state but bad code never creates a session (401)', first.status === 401 &&
    !first.setCookies.some(c => c.startsWith(SESSION_COOKIE + '=') && !/Max-Age=0/.test(c)), `status ${first.status}`);
  const replay = await cb(OAUTH.state, OAUTH.state);
  check('OAUTH-8', 'Replayed state is rejected (401)', replay.status === 401, `status ${replay.status}`);
  if (startConfigured) {
    const after = await d1Rows(`SELECT COUNT(*) AS n FROM oauth_login_attempts WHERE state_hash = ${q(sha256(OAUTH.state))}`);
    check('OAUTH-9', 'State is single-use: attempt row deleted by the first callback', after[0]?.n === 0, 'attempt row still present');
  } else {
    skip('OAUTH-9', 'State is single-use: attempt row deleted by first callback', 'needs Google secrets (callback is rejected before the attempt is consumed while unconfigured)');
  }
}

async function qaSessions() {
  const anon = await http('GET', '/api/me');
  check('SES-1', 'No cookie -> 401 unauthenticated', anon.status === 401 && anon.data?.error === 'unauthenticated', `status ${anon.status}`);
  const garbage = await http('GET', '/api/me', { cookie: asSession('not-a-token') });
  check('SES-2', 'Malformed session cookie -> 401', garbage.status === 401, `status ${garbage.status}`);
  const unknown = await http('GET', '/api/me', { cookie: asSession(token()) });
  check('SES-3', 'Well-formed unknown token -> 401', unknown.status === 401, `status ${unknown.status}`);
  const wrongName = await http('GET', '/api/me', { cookie: `sb_session=${A.owner.session}` });
  check('SES-4', 'Session token under a non-__Host- cookie name -> 401', wrongName.status === 401, `status ${wrongName.status}`);
  for (const [id, who, label] of [['SES-5', 'expired', 'Expired'], ['SES-6', 'revoked', 'Revoked'], ['SES-7', 'disabled', 'Disabled-account']]) {
    const res = await http('GET', '/api/me', { cookie: asSession(A[who].session) });
    check(id, `${label} session -> 401`, res.status === 401, `status ${res.status}`);
  }
  const ok = await http('GET', '/api/me', { cookie: asSession(A.owner.session) });
  check('SES-8', 'Valid session -> 200 with the account and no-store/nosniff headers', ok.status === 200 && ok.data?.account?.id === A.owner.id &&
    /no-store/.test(ok.headers.get('cache-control') || '') && ok.headers.get('x-content-type-options') === 'nosniff', `status ${ok.status}`);
  const welcome = await http('GET', '/welcome', { cookie: asSession(A.owner.session) });
  check('SES-9', '/welcome never carries session data itself (303 to /api/me)', welcome.status === 303 && welcome.headers.get('location') === '/api/me' && welcome.text === '', `status ${welcome.status}`);
}

async function qaTenancy() {
  const own = await http('GET', '/api/workspaces', { cookie: asSession(A.owner.session) });
  check('TEN-1', 'Owner lists only their own workspace', own.status === 200 && own.data?.workspaces?.length === 1 &&
    own.data.workspaces[0].id === W.alpha && own.data.workspaces[0].role === 'owner', `status ${own.status}`);
  const out = await http('GET', '/api/workspaces', { cookie: asSession(A.outsider.session) });
  check('TEN-2', 'Outsider lists only their own workspace', out.status === 200 && out.data?.workspaces?.length === 1 && out.data.workspaces[0].id === W.beta, `status ${out.status}`);
  const fresh = await http('GET', '/api/workspaces', { cookie: asSession(A.fresh.session) });
  check('TEN-3', 'Account with no membership lists zero workspaces', fresh.status === 200 && fresh.data?.workspaces?.length === 0, `status ${fresh.status}`);
  for (const [id, who] of [['TEN-4', 'owner'], ['TEN-5', 'admin'], ['TEN-6', 'editor'], ['TEN-7', 'viewer']]) {
    const res = await http('GET', `/api/workspaces/${W.alpha}/sermons`, { cookie: asSession(A[who].session) });
    const titles = (res.data?.sermons || []).map(s => s.title);
    check(id, `${who} reads only their workspace's sermons`, res.status === 200 && titles.length === 1 && titles[0].includes('alpha') && !has(res, 'beta'), `status ${res.status}`);
  }
  const cross = await http('GET', `/api/workspaces/${W.beta}/sermons`, { cookie: asSession(A.owner.session) });
  check('TEN-8', "Non-member direct URL to another workspace's sermons -> 404 with no data", cross.status === 404 && !cross.text.includes('beta') && !cross.text.includes('QA'), `status ${cross.status}`);
  const anon = await http('GET', `/api/workspaces/${W.alpha}/sermons`);
  check('TEN-9', 'Unauthenticated workspace URL -> 401', anon.status === 401, `status ${anon.status}`);
  const missing = await http('GET', `/api/workspaces/${uuid()}/sermons`, { cookie: asSession(A.owner.session) });
  const badId = await http('GET', '/api/workspaces/not-a-uuid/sermons', { cookie: asSession(A.owner.session) });
  check('TEN-10', 'Unknown and malformed workspace ids are indistinguishable from non-membership (404)', missing.status === 404 && badId.status === 404 &&
    missing.text === cross.text, `statuses ${missing.status}/${badId.status}`);
  const sql = await http('GET', `/api/workspaces/${"x%27--"}/sermons`, { cookie: asSession(A.owner.session) });
  check('TEN-11', 'Quote-bearing workspace id -> 404', sql.status === 404, `status ${sql.status}`);
  const post = await http('POST', `/api/workspaces/${W.alpha}/sermons`, { cookie: asSession(A.owner.session), body: {} });
  check('TEN-12', 'Sermon create rejects an empty body (400 with the field name, nothing created)', post.status === 400 && post.data?.field === 'title', `status ${post.status}`);
  const create = await http('POST', '/api/workspaces', { cookie: asSession(A.fresh.session), body: { name: 'QA self-registration' } });
  check('TEN-13', 'Non-pilot account cannot create a workspace (403 pilot_access_only)', create.status === 403 && create.data?.error === 'pilot_access_only', `status ${create.status}`);
  const after = await http('GET', '/api/workspaces', { cookie: asSession(A.fresh.session) });
  check('TEN-14', 'Rejected create left no workspace behind', after.data?.workspaces?.length === 0, 'workspace was created');
}

async function qaRequestRules() {
  const body = { name: 'QA origin check' };
  const cookie = asSession(A.owner.session);
  const noOrigin = await http('POST', '/api/workspaces', { cookie, body, origin: null });
  check('CSRF-1', 'POST without Origin -> 403 invalid_origin', noOrigin.status === 403 && noOrigin.data?.error === 'invalid_origin', `status ${noOrigin.status}`);
  const evil = await http('POST', '/api/workspaces', { cookie, body, origin: 'https://evil.example' });
  check('CSRF-2', 'POST with foreign Origin -> 403 invalid_origin', evil.status === 403, `status ${evil.status}`);
  const crossSite = await http('POST', '/api/workspaces', { cookie, body, headers: { 'sec-fetch-site': 'cross-site' } });
  check('CSRF-3', 'POST with Sec-Fetch-Site: cross-site -> 403', crossSite.status === 403, `status ${crossSite.status}`);
  const logoutNoOrigin = await http('POST', '/auth/logout', { cookie, origin: null });
  const still = await http('GET', '/api/me', { cookie });
  check('CSRF-4', 'Logout without Origin -> 403 and the session survives', logoutNoOrigin.status === 403 && still.status === 200, `status ${logoutNoOrigin.status}/${still.status}`);
  const put = await http('PUT', '/api/me', { cookie });
  check('CSRF-5', 'Unsupported method (PUT) -> 405', put.status === 405, `status ${put.status}`);
  const del = await http('DELETE', '/api/me', { cookie });
  check('CSRF-5b', 'DELETE on a route with no delete handler -> 404 and the session survives', del.status === 404 && (await http('GET', '/api/me', { cookie })).status === 200, `status ${del.status}`);
  const text = await http('POST', `/api/workspaces/${W.alpha}/invitations`, { cookie, body: 'email=x', json: false, headers: { 'content-type': 'text/plain' } });
  check('CSRF-6', 'Non-JSON invitation body -> 400', text.status === 400, `status ${text.status}`);
  const big = await http('POST', `/api/workspaces/${W.alpha}/invitations`, { cookie, body: { email: email('big'), role: 'viewer', pad: 'x'.repeat(9000) } });
  check('CSRF-7', 'Oversized JSON body (>8 KiB) -> 400', big.status === 400, `status ${big.status}`);
}

async function invite(who, workspace, targetEmail, role) {
  return http('POST', `/api/workspaces/${workspace}/invitations`, { cookie: asSession(A[who].session), body: { email: targetEmail, role } });
}
async function accept(who, raw) {
  return http('POST', '/api/invitations/accept', { cookie: asSession(A[who].session), body: { token: raw } });
}
const sermonsStatus = async who => (await http('GET', `/api/workspaces/${W.alpha}/sermons`, { cookie: asSession(A[who].session) })).status;

async function qaRoles() {
  const viewer = await invite('viewer', W.alpha, email('x1'), 'viewer');
  const editor = await invite('editor', W.alpha, email('x2'), 'viewer');
  check('ROLE-1', 'Viewer and Editor cannot invite (403)', viewer.status === 403 && editor.status === 403, `status ${viewer.status}/${editor.status}`);
  const adminOwner = await invite('admin', W.alpha, email('x3'), 'owner');
  const adminAdmin = await invite('admin', W.alpha, email('x4'), 'admin');
  const ownerOwner = await invite('owner', W.alpha, email('x5'), 'owner');
  const badRole = await invite('owner', W.alpha, email('x6'), 'superuser');
  const badEmail = await invite('owner', W.alpha, 'not-an-email', 'viewer');
  check('ROLE-2', 'Cannot invite an owner, Admin cannot invite an admin, unknown role/email rejected (400)',
    [adminOwner, adminAdmin, ownerOwner, badRole, badEmail].every(r => r.status === 400), `statuses ${[adminOwner, adminAdmin, ownerOwner, badRole, badEmail].map(r => r.status)}`);
  const existing = await invite('owner', W.alpha, A.viewer.email, 'viewer');
  check('ROLE-3', 'Inviting an existing member -> 409 member_exists', existing.status === 409, `status ${existing.status}`);
  const outsider = await invite('outsider', W.alpha, email('x7'), 'viewer');
  check('ROLE-4', 'Non-member inviting into another workspace -> 404', outsider.status === 404, `status ${outsider.status}`);

  const patch = (who, member, body) => http('PATCH', `/api/workspaces/${W.alpha}/members/${A[member].id}`, { cookie: asSession(A[who].session), body });
  check('ROLE-5', 'Viewer/Editor cannot change members (403)', (await patch('viewer', 'editor', { role: 'viewer' })).status === 403 &&
    (await patch('editor', 'viewer', { revoke: true })).status === 403, 'unexpected status');
  const ownerTarget = await patch('admin', 'owner', { revoke: true });
  const ownerSelf = await patch('owner', 'owner', { role: 'viewer' });
  const ownerDemote = await patch('owner', 'owner', { revoke: true });
  check('ROLE-6', 'Owner membership cannot be revoked or demoted, even by the owner (403)',
    ownerTarget.status === 403 && ownerSelf.status === 403 && ownerDemote.status === 403, `statuses ${ownerTarget.status}/${ownerSelf.status}/${ownerDemote.status}`);
  const adminOnAdmin = await patch('admin', 'admin2', { revoke: true });
  check('ROLE-7', 'Admin cannot revoke another admin (403)', adminOnAdmin.status === 403 && await sermonsStatus('admin2') === 200, `status ${adminOnAdmin.status}`);
  const promote = await patch('admin', 'viewer', { role: 'admin' });
  check('ROLE-8', 'Admin cannot promote anyone to admin or owner (403)', promote.status === 403 &&
    (await patch('admin', 'viewer', { role: 'owner' })).status === 403, `status ${promote.status}`);
  const invalid = await patch('owner', 'viewer', { role: 'god' });
  const unknownMember = await http('PATCH', `/api/workspaces/${W.alpha}/members/${uuid()}`, { cookie: asSession(A.owner.session), body: { revoke: true } });
  const crossMember = await http('PATCH', `/api/workspaces/${W.beta}/members/${A.outsider.id}`, { cookie: asSession(A.owner.session), body: { revoke: true } });
  check('ROLE-9', 'Invalid role 400, unknown member 404, cross-workspace member change 404', invalid.status === 400 && unknownMember.status === 404 && crossMember.status === 404 &&
    await http('GET', `/api/workspaces/${W.beta}/sermons`, { cookie: asSession(A.outsider.session) }).then(r => r.status === 200), `statuses ${invalid.status}/${unknownMember.status}/${crossMember.status}`);
}

async function qaInvitations() {
  // Pending invitation grants zero workspace access until accepted.
  const created = await invite('owner', W.alpha, A.invitee.email, 'viewer');
  const raw = created.data?.token;
  if (raw) secrets.add(raw);
  check('INV-1', 'Owner creates an invitation (201, token shown once)', created.status === 201 && typeof raw === 'string' && raw.length === 43, `status ${created.status}`);
  if (!raw) return;
  check('INV-2', 'Pending invitation grants zero workspace access', await sermonsStatus('invitee') === 404, 'invitee could read before accepting');
  const wrong = await accept('inviteeWrong', raw);
  check('INV-3', 'Another account cannot accept it (404)', wrong.status === 404, `status ${wrong.status}`);
  check('INV-4', 'Failed acceptance by another account grants no access', await sermonsStatus('inviteeWrong') === 404, 'access granted');
  const bad = await accept('invitee', 'short');
  const unknown = await accept('invitee', token());
  check('INV-5', 'Malformed token 400, unknown token 404', bad.status === 400 && unknown.status === 404, `statuses ${bad.status}/${unknown.status}`);
  const expired = await accept('fresh', INVITE_EXPIRED.raw);
  const revoked = await accept('fresh', INVITE_REVOKED.raw);
  check('INV-6', 'Expired and revoked invitations are refused (404) and grant nothing', expired.status === 404 && revoked.status === 404 && await sermonsStatus('fresh') === 404,
    `statuses ${expired.status}/${revoked.status}`);
  const ok = await accept('invitee', raw);
  check('INV-7', 'Intended account accepts (200, invited role)', ok.status === 200 && ok.data?.workspace_id === W.alpha && ok.data?.role === 'viewer', `status ${ok.status}`);
  check('INV-8', 'Accepted member can read the workspace', await sermonsStatus('invitee') === 200, 'no access after accepting');
  const replay = await accept('invitee', raw);
  const replayOther = await accept('inviteeWrong', raw);
  check('INV-9', 'Invitation token replay is refused (404/409)', [404, 409].includes(replay.status) && replayOther.status === 404, `statuses ${replay.status}/${replayOther.status}`);
  const rows = await d1Rows(`SELECT COUNT(*) AS n FROM workspace_memberships WHERE workspace_id = ${q(W.alpha)} AND account_id = ${q(A.invitee.id)}`);
  check('INV-10', 'Replay did not create a second membership', rows[0]?.n === 1, 'membership count != 1');
  const audit = await d1Rows(`SELECT action FROM audit_events WHERE workspace_id = ${q(W.alpha)} AND action IN ('invitation.create','invitation.accept')`);
  check('INV-11', 'Invitation create and accept are audited', audit.some(r => r.action === 'invitation.create') && audit.some(r => r.action === 'invitation.accept'), 'audit rows missing');
  // Admin can invite viewer/editor.
  const byAdmin = await invite('admin', W.alpha, email('byadmin'), 'editor');
  check('INV-12', 'Admin can invite an editor (201)', byAdmin.status === 201, `status ${byAdmin.status}`);
  if (byAdmin.data?.token) secrets.add(byAdmin.data.token);
}

async function qaRevocation() {
  const patch = (who, member, body) => http('PATCH', `/api/workspaces/${W.alpha}/members/${A[member].id}`, { cookie: asSession(A[who].session), body });
  check('REV-1', 'Viewer reads before revocation', await sermonsStatus('viewer') === 200, 'no access');
  const demote = await patch('admin', 'editor', { role: 'viewer' });
  check('REV-2', 'Admin demotes an editor (200)', demote.status === 200 && demote.data?.role === 'viewer', `status ${demote.status}`);
  const revoke = await patch('admin', 'viewer', { revoke: true });
  check('REV-3', 'Admin revokes a viewer (200)', revoke.status === 200, `status ${revoke.status}`);
  const viewerSession = await http('GET', '/api/me', { cookie: asSession(A.viewer.session) });
  check('REV-4', 'Revoked member loses workspace access immediately, session itself still valid', await sermonsStatus('viewer') === 404 && viewerSession.status === 200, 'access persisted');
  const list = await http('GET', '/api/workspaces', { cookie: asSession(A.viewer.session) });
  check('REV-5', 'Revoked member no longer lists the workspace', list.data?.workspaces?.length === 0, 'workspace still listed');
  const again = await patch('admin', 'viewer', { revoke: true });
  check('REV-6', 'Revoking an already revoked member -> 404', again.status === 404, `status ${again.status}`);
  const audit = await d1Rows(`SELECT action FROM audit_events WHERE workspace_id = ${q(W.alpha)} AND action LIKE 'membership.%'`);
  check('REV-7', 'Membership changes are audited', audit.some(r => r.action === 'membership.revoke') && audit.some(r => r.action === 'membership.role_change'), 'audit rows missing');
  // Disabled account / deleted workspace revoke access without touching sessions.
  await d1(`UPDATE user_accounts SET disabled_at = CURRENT_TIMESTAMP WHERE id = ${q(A.editor.id)}`);
  check('REV-8', 'Disabling an account kills its sessions immediately (401)', (await http('GET', '/api/me', { cookie: asSession(A.editor.session) })).status === 401, 'session still valid');
  await d1(`UPDATE workspaces SET deleted_at = CURRENT_TIMESTAMP WHERE id = ${q(W.beta)}`);
  check('REV-9', 'Soft-deleted workspace is inaccessible even to its owner (404)',
    (await http('GET', `/api/workspaces/${W.beta}/sermons`, { cookie: asSession(A.outsider.session) })).status === 404, 'still accessible');
}

async function qaLogout() {
  const cookie = asSession(A.admin2.session);
  check('OUT-1', 'Session valid before logout', (await http('GET', '/api/me', { cookie })).status === 200, 'not valid');
  const res = await http('POST', '/auth/logout', { cookie });
  const cleared = res.setCookies.find(c => c.startsWith(SESSION_COOKIE + '='));
  check('OUT-2', 'Logout -> 200 and clears the cookie', res.status === 200 && Boolean(cleared) && /Max-Age=0/.test(cleared) && /HttpOnly/.test(cleared) && /Secure/.test(cleared), `status ${res.status}`);
  check('OUT-3', 'The same token is rejected after logout (401)', (await http('GET', '/api/me', { cookie })).status === 401, 'token still valid');
  const rows = await d1Rows(`SELECT revoked_at FROM auth_sessions WHERE token_hash = ${q(sha256(A.admin2.session))}`);
  check('OUT-4', 'Session is revoked server-side', Boolean(rows[0]?.revoked_at), 'revoked_at not set');
  const second = await http('POST', '/auth/logout', { cookie });
  check('OUT-5', 'Logout is idempotent (200)', second.status === 200, `status ${second.status}`);
  const anon = await http('POST', '/auth/logout');
  check('OUT-6', 'Logout without a session -> 200 and a clearing cookie', anon.status === 200 && anon.setCookies.some(c => /Max-Age=0/.test(c)), `status ${anon.status}`);
  check('OUT-7', 'Logout of one session leaves other sessions alone', (await http('GET', '/api/me', { cookie: asSession(A.owner.session) })).status === 200, 'owner session affected');
}

// ---------- library, search, import, PDF and app-shell routes ----------
// [method, workspace-relative template, body, flag]. :s sermon, :v version, :vp PDF version, :e event, :p/:p2 places,
// :b/:r import batch and row (exist nowhere), :m a member. Flags: ownerOnly, adminOnly, noFile (a member sees 404 because
// the QA PDF version holds no file, so no 200 control exists for that GET).
const ROUTES = [
  ['GET', '/sermons'], ['GET', '/sermons/:s'], ['GET', '/sermons/:s/versions'], ['GET', '/sermons/:s/events'],
  ['GET', '/events?year=2026'], ['GET', '/events/:e'], ['GET', '/places'], ['GET', '/places/:p/merge-preview?target=:p2'],
  ['GET', '/search?q=grace'], ['GET', '/sermons/:s/find-in-notes?q=grace'], ['GET', '/sermons/:s/versions/:vp/pdf', null, 'noFile'],
  ['GET', '/imports/:b/summary', null, 'ownerOnly'], ['GET', '/imports/:b/rows', null, 'ownerOnly'], ['GET', '/members', null, 'adminOnly'],
  ['POST', '/sermons', { title: 'QA rejected write' }], ['PATCH', '/sermons/:s', { title: 'QA rejected rename' }],
  ['POST', '/sermons/:s/archive', {}], ['POST', '/sermons/:s/restore', {}],
  ['POST', '/sermons/:s/versions', { label: 'QA rejected version', source_type: 'google_doc', google_document_id: 'qa-doc-rejected-0123456789' }],
  ['PATCH', '/sermons/:s/versions/:v', { label: 'QA rejected relabel' }],
  ['POST', '/sermons/:s/events', { preached_on: '2026-05-05' }], ['PATCH', '/events/:e', { occasion: 'QA rejected edit' }], ['DELETE', '/events/:e'],
  ['POST', '/places', { display_name: 'QA rejected place' }], ['PATCH', '/places/:p', { display_name: 'QA rejected rename' }],
  ['POST', '/places/:p/merge', { target_place_id: '::p2' }],
  ['POST', '/imports', { csv: 'Title,Date\nQA,2026-01-01' }, 'ownerOnly'], ['POST', '/imports/:b/attest', { row_ids: ['::r'] }, 'ownerOnly'],
  ['POST', '/imports/:b/rows/:r/ignore', {}, 'ownerOnly'], ['POST', '/imports/:b/rows/:r/approve', {}, 'ownerOnly'], ['POST', '/imports/:b/rows/:r/rollback', {}, 'ownerOnly'],
  ['POST', '/sermons/:s/versions/:vp/pdf', '%PDF-1.4', 'raw'], ['POST', '/sermons/:s/versions/:vp/consent', {}, 'ownerOnly'], ['POST', '/sermons/:s/versions/:vp/revoke', {}, 'ownerOnly'],
  ['POST', '/invitations', { email: 'qa-sweep@sermon-qa.test', role: 'viewer' }, 'adminOnly'], ['PATCH', '/members/:m', { role: 'editor' }, 'adminOnly']
].map(([method, template, body, flag]) => ({ method, template, body, flag, write: method !== 'GET' }));

const IDS = {
  alpha: { w: W.alpha, s: SERMON.alpha, v: VERSION.alpha, vp: VERSION.alphaPdf, e: EVENT.alpha, p: PLACE.alpha, p2: PLACE.alpha2, b: IMPORT.batch, r: IMPORT.row, m: A.viewer.id },
  beta: { w: W.beta, s: SERMON.beta, v: VERSION.beta, vp: VERSION.beta, e: EVENT.beta, p: PLACE.beta, p2: PLACE.beta, b: IMPORT.batch, r: IMPORT.row, m: A.outsider.id }
};
const fillBody = (text, ids) => text.replace(/::(\w+)/g, (_, k) => ids[k]);
const fill = (text, ids) => text.replace(/:(\w+)\b/g, (m, k) => (k in ids && k !== 'w' ? ids[k] : m));
const asWho = who => (who ? asSession(A[who].session) : undefined);
const callRoute = (route, who, ids = IDS.alpha, workspace = ids.w) => {
  const body = route.body === null || route.body === undefined ? undefined : typeof route.body === 'string' ? route.body : JSON.parse(fillBody(JSON.stringify(route.body), ids));
  const raw = route.flag === 'raw';
  return http(route.method, `/api/workspaces/${workspace}${fill(route.template, ids)}`, {
    cookie: asWho(who), body, json: !raw, headers: raw ? { 'content-type': 'application/pdf' } : {}
  });
};
// Run requests a few at a time; results keep route order.
async function sweep(routes, who, ids, workspace) {
  const out = new Array(routes.length);
  let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < routes.length) { const i = next++; out[i] = { route: routes[i], res: await callRoute(routes[i], who, ids, workspace) }; }
  }));
  return out;
}
const wrong = (swept, want) => swept.filter(({ route, res }) => ![].concat(want(route)).includes(res.status))
  .map(({ route, res }) => `${route.method} ${route.template} -> ${res.status}`);
const leaked = (swept, forbidden) => swept.filter(({ res }) => forbidden.some(f => res.text.includes(f))).map(({ route }) => `${route.method} ${route.template}`);
const ALL_ALPHA_IDS = [W.alpha, SERMON.alpha, VERSION.alpha, VERSION.alphaRevoked, VERSION.alphaPdf, EVENT.alpha, PLACE.alpha, PLACE.alpha2];
const ALL_BETA_IDS = [W.beta, SERMON.beta, VERSION.beta, EVENT.beta, PLACE.beta];

const STATE_SQL = `SELECT
  (SELECT title FROM sermons WHERE id = ${q(SERMON.alpha)}) AS a_title, (SELECT archived_at IS NULL FROM sermons WHERE id = ${q(SERMON.alpha)}) AS a_active,
  (SELECT title FROM sermons WHERE id = ${q(SERMON.beta)}) AS b_title, (SELECT archived_at IS NULL FROM sermons WHERE id = ${q(SERMON.beta)}) AS b_active,
  (SELECT COUNT(*) FROM sermons WHERE workspace_id IN (${q(W.alpha)}, ${q(W.beta)})) AS sermons,
  (SELECT COUNT(*) FROM sermon_versions WHERE workspace_id IN (${q(W.alpha)}, ${q(W.beta)})) AS versions,
  (SELECT label FROM sermon_versions WHERE id = ${q(VERSION.alpha)}) AS a_label,
  (SELECT indexing_state || ':' || COALESCE(r2_object_key, '-') FROM sermon_versions WHERE id = ${q(VERSION.alphaPdf)}) AS pdf_state,
  (SELECT indexing_state FROM sermon_versions WHERE id = ${q(VERSION.alpha)}) AS a_state,
  (SELECT indexing_state FROM sermon_versions WHERE id = ${q(VERSION.beta)}) AS b_state,
  (SELECT COUNT(*) FROM preaching_events WHERE workspace_id IN (${q(W.alpha)}, ${q(W.beta)})) AS events,
  (SELECT occasion || '/' || place_id FROM preaching_events WHERE id = ${q(EVENT.alpha)}) AS a_event,
  (SELECT occasion || '/' || place_id FROM preaching_events WHERE id = ${q(EVENT.beta)}) AS b_event,
  (SELECT COUNT(*) FROM places WHERE workspace_id IN (${q(W.alpha)}, ${q(W.beta)})) AS places,
  (SELECT display_name FROM places WHERE id = ${q(PLACE.alpha)}) AS a_place, (SELECT display_name FROM places WHERE id = ${q(PLACE.beta)}) AS b_place,
  (SELECT COUNT(*) FROM place_merges WHERE workspace_id IN (${q(W.alpha)}, ${q(W.beta)})) AS merges,
  (SELECT COUNT(*) FROM import_review_batches WHERE workspace_id IN (${q(W.alpha)}, ${q(W.beta)})) AS imports,
  (SELECT COUNT(*) FROM note_texts WHERE workspace_id IN (${q(W.alpha)}, ${q(W.beta)})) AS notes,
  (SELECT COUNT(*) FROM audit_events WHERE workspace_id IN (${q(W.alpha)}, ${q(W.beta)})) AS audits`;
const expectedState = () => ({
  a_title: `QA alpha sermon ${RUN}`, a_active: 1, b_title: `QA beta sermon ${RUN}`, b_active: 1, sermons: 2, versions: 4, a_label: 'QA original',
  pdf_state: 'not_indexed:-', a_state: 'indexed', b_state: 'indexed', events: 2, a_event: `QA alpha occasion/${PLACE.alpha}`, b_event: `QA beta occasion/${PLACE.beta}`,
  places: 3, a_place: `QA alpha hall ${RUN}`, b_place: `QA beta hall ${RUN}`, merges: 0, imports: 0, notes: 3, audits: 0
});
async function stateDiff() {
  const [row] = await d1Rows(STATE_SQL), want = expectedState();
  return Object.keys(want).filter(k => row?.[k] !== want[k]).map(k => k);
}

async function qaNewRoutesAccess() {
  const total = ROUTES.length;
  // Unauthenticated: every route is 401 and says nothing else, whichever workspace the URL names.
  const anon = await sweep(ROUTES, null);
  const anonBad = wrong(anon, () => 401).concat(anon.filter(({ res }) => res.data?.error !== 'unauthenticated').map(({ route }) => `${route.method} ${route.template} body`));
  const other = await callRoute(ROUTES[0], null, IDS.alpha, uuid());
  check('NEW-1', `Unauthenticated requests get 401 unauthenticated on all ${total} routes, for any workspace id`, anonBad.length === 0 && other.status === 401 && other.text === anon[0].res.text, anonBad.slice(0, 3).join('; ') || `status ${other.status}`);

  // Signed-out app shell: only the sign-in page, never the shell, assets or index.html.
  const css = await http('GET', '/assets/app.css'), js = await http('GET', '/assets/js/'), index = await http('GET', '/index.html');
  const signedOutRoot = await http('GET', '/');
  check('NEW-2', 'Signed out: /assets/* and /index.html are 404 not_found and / is the sign-in page', [css, js, index].every(r => r.status === 404 && r.data?.error === 'not_found') &&
    signedOutRoot.status === 200 && signedOutRoot.text.includes('/auth/google/start'), `statuses ${css.status}/${js.status}/${index.status}/${signedOutRoot.status}`);

  // Signed in: the static shell with a strict CSP and no embedded data.
  const cookie = asSession(A.owner.session);
  const shell = await http('GET', '/', { cookie }), asset = await http('GET', '/assets/app.css', { cookie }), hidden = await http('GET', '/index.html', { cookie });
  const csp = shell.headers.get('content-security-policy') || '';
  const frame = frameGuard(shell.headers);
  check('NEW-3', 'Signed in: / serves the app shell (private, strict CSP, no embedded account or workspace data); /index.html is still 404', shell.status === 200 &&
    /text\/html/.test(shell.headers.get('content-type') || '') && /private/.test(shell.headers.get('cache-control') || '') && /script-src 'self'/.test(csp) && /default-src 'none'/.test(csp) &&
    frame.ok && shell.headers.get('x-content-type-options') === 'nosniff' &&
    ![A.owner.email, A.owner.id, W.alpha, 'QA alpha'].some(v => shell.text.includes(v)) &&
    asset.status === 200 && /text\/css/.test(asset.headers.get('content-type') || '') && hidden.status === 404, `statuses ${shell.status}/${asset.status}/${hidden.status}`);
  if (frame.warning) warn('NEW-3', 'Signed in: / X-Frame-Options header', frame.warning);

  // Viewer: reads work (the control that proves a 404 elsewhere is isolation, not a missing route), every mutation is 403.
  const viewer = await sweep(ROUTES, 'viewer');
  const viewerWant = r => r.flag === 'ownerOnly' || r.flag === 'adminOnly' || r.write ? 403 : r.flag === 'noFile' ? 404 : 200;
  const viewerBad = wrong(viewer, viewerWant);
  const writes = ROUTES.filter(r => r.write).length;
  check('NEW-4', `Viewer: reads return 200, all ${writes} mutations return 403 before the body is read (owner-only and admin-only reads are 403)`, viewerBad.length === 0, viewerBad.slice(0, 3).join('; '));

  // Owner-only routes refuse Editor and Admin too.
  const ownerOnly = ROUTES.filter(r => r.flag === 'ownerOnly');
  const editor = await sweep(ownerOnly, 'editor'), admin = await sweep(ownerOnly, 'admin');
  const membersEditor = await callRoute(ROUTES.find(r => r.template === '/members'), 'editor'), membersAdmin = await callRoute(ROUTES.find(r => r.template === '/members'), 'admin');
  // Control: the Owner is not refused on the same routes (the ids exist nowhere or the state does not fit, so 400/404/409).
  const owner = await sweep(ownerOnly, 'owner');
  const roleBad = wrong(editor, () => 403).map(x => 'editor ' + x).concat(wrong(admin, () => 403).map(x => 'admin ' + x))
    .concat(wrong(owner, () => [400, 404, 409]).map(x => 'owner ' + x));
  check('NEW-5', `Import review, consent and revoke are Owner-only: Editor and Admin get 403 on all ${ownerOnly.length} while the Owner is let through to the handler; the member list is Owner/Admin only`,
    roleBad.length === 0 && membersEditor.status === 403 && membersAdmin.status === 200 && Array.isArray(membersAdmin.data?.members), roleBad.slice(0, 3).join('; ') || `members ${membersEditor.status}/${membersAdmin.status}`);

  // Another workspace's member: 404 on every route, with nothing of this workspace in the response.
  const outsider = await sweep(ROUTES, 'outsider');
  const outsiderBad = wrong(outsider, () => 404).concat(leaked(outsider, [...ALPHA_ONLY, ...ALL_ALPHA_IDS.filter(id => id !== W.alpha)]).map(x => 'leak ' + x));
  const same = outsider.every(({ res }) => res.text === outsider[0].res.text);
  check('NEW-6', `A member of another workspace gets 404 not_found on all ${total} routes with no data, and one identical body`, outsiderBad.length === 0 && same, outsiderBad.slice(0, 3).join('; ') || 'bodies differ');
  const ownerElsewhere = await sweep(ROUTES, 'owner', IDS.beta);
  const elsewhereBad = wrong(ownerElsewhere, () => 404).concat(leaked(ownerElsewhere, [...BETA_ONLY, ...ALL_BETA_IDS.filter(id => id !== W.beta)]).map(x => 'leak ' + x));
  check('NEW-7', `The alpha Owner gets 404 on all ${total} routes under the beta workspace URL, with no beta data`, elsewhereBad.length === 0, elsewhereBad.slice(0, 3).join('; '));

  // A member naming another workspace's ids inside their own workspace: 404 (path ids) or a refusal (body ids), and no write lands.
  const betaIds = { ...IDS.alpha, ...IDS.beta, w: W.alpha };
  const crossRoutes = ROUTES.filter(r => /\/(sermons|events|places)\/:/.test(r.template));
  const cross = await sweep(crossRoutes, 'owner', betaIds, W.alpha);
  const crossBad = wrong(cross, () => 404).concat(leaked(cross, [...BETA_ONLY, ...ALL_BETA_IDS.filter(id => id !== W.beta)]).map(x => 'leak ' + x));
  const bodyIds = [
    { method: 'POST', template: '/places/:p/merge', body: { target_place_id: PLACE.beta } }, { method: 'GET', template: `/places/:p/merge-preview?target=${PLACE.beta}`, body: null },
    { method: 'POST', template: '/sermons/:s/events', body: { preached_on: '2026-05-05', version_id: VERSION.beta } }, { method: 'POST', template: '/sermons/:s/events', body: { preached_on: '2026-05-05', place_id: PLACE.beta } },
    { method: 'PATCH', template: '/events/:e', body: { place_id: PLACE.beta } }, { method: 'PATCH', template: '/events/:e', body: { version_id: VERSION.beta } }
  ];
  // Mixed paths: this workspace's sermon with the other workspace's version.
  const mixed = [['GET', '/pdf'], ['POST', '/pdf', '%PDF-1.4', 'raw'], ['POST', '/consent', {}], ['POST', '/revoke', {}], ['PATCH', '', { label: 'QA rejected relabel' }]]
    .map(([method, tail, body, flag]) => ({ method, template: `/sermons/${SERMON.alpha}/versions/${VERSION.beta}${tail}`, body, flag }));
  const bodySweep = [];
  for (const r of bodyIds) bodySweep.push({ route: r, res: await callRoute(r, 'owner'), want: [400, 404, 409] });
  for (const r of mixed) bodySweep.push({ route: r, res: await callRoute(r, 'owner'), want: [404] });
  const bodyBad = bodySweep.filter(({ res, want }) => !want.includes(res.status)).map(({ route, res }) => `${route.method} ${route.template} -> ${res.status}`);
  check('NEW-8', `Other-workspace ids inside the Owner's own workspace: 404 on all ${crossRoutes.length} id routes and ${mixed.length} mixed paths, and body ids (place, version, merge target) are refused`,
    crossBad.length === 0 && bodyBad.length === 0, crossBad.concat(bodyBad).slice(0, 3).join('; '));

  const diff = await stateDiff();
  check('NEW-9', 'After every refused request nothing changed: titles, archive state, versions, events, places, merges, imports, note text and audit log are as seeded', diff.length === 0, `changed: ${diff.join(', ')}`);

  // Positive control: the same mutation an Editor may make succeeds and is audited, so the refusals above are about roles.
  const made = await http('POST', `/api/workspaces/${W.alpha}/sermons`, { cookie: asSession(A.editor.session), body: { title: `QA editor sermon ${RUN}` } });
  const audit = await d1Rows(`SELECT action FROM audit_events WHERE workspace_id = ${q(W.alpha)} AND action = 'sermon.create'`);
  check('NEW-10', 'Control: an Editor can create a sermon (201) and it is audited', made.status === 201 && audit.length === 1, `status ${made.status}`);
}

async function qaSearchNoLeak() {
  const search = (who, workspace, term, extra = '') => http('GET', `/api/workspaces/${workspace}/search?q=${encodeURIComponent(term)}${extra}`, { cookie: asWho(who) });
  const find = (who, workspace, sermon, term) => http('GET', `/api/workspaces/${workspace}/sermons/${sermon}/find-in-notes?q=${encodeURIComponent(term)}`, { cookie: asWho(who) });
  // The response echoes the caller's own query text, so leaks are looked for in the result lists only.
  const results = res => JSON.stringify([res.data?.notesMatches, res.data?.metadataMatches]);
  const hasAlphaHit = res => (res.data?.notesMatches || []).some(m => m.sermon_id === SERMON.alpha && m.version_id === VERSION.alpha);

  const anon = await search(null, W.alpha, MARK.alpha), anonFind = await find(null, W.alpha, SERMON.alpha, MARK.alpha);
  check('SRCH-1', 'Unauthenticated search and find-in-notes -> 401 with no results', anon.status === 401 && anonFind.status === 401 && !anon.text.includes(MARK.alpha), `statuses ${anon.status}/${anonFind.status}`);

  const own = await search('viewer', W.alpha, MARK.alpha);
  check('SRCH-2', 'A Viewer finds indexed notes in their workspace (200, excerpt highlights the word)', own.status === 200 && hasAlphaHit(own) &&
    own.data.notesMatches[0].excerpt?.text?.includes(MARK.alpha) && own.data.notesMatches[0].excerpt.highlights.length >= 1, `status ${own.status}`);
  const ref = await search('viewer', W.alpha, 'John 3:16');
  check('SRCH-3', 'A Bible reference query returns the sermon passage and the indexed notes separately', ref.status === 200 &&
    (ref.data?.metadataMatches || []).some(m => m.sermon_id === SERMON.alpha) && hasAlphaHit(ref), `status ${ref.status}`);

  const betaForAlpha = await search('outsider', W.beta, MARK.alpha), betaRefAlpha = await search('outsider', W.beta, 'John 3:16');
  check('SRCH-4', "Another workspace's search for this workspace's word and reference returns nothing and none of its titles or ids",
    betaForAlpha.status === 200 && betaRefAlpha.status === 200 && [betaForAlpha, betaRefAlpha].every(r => !(r.data?.notesMatches || []).length && !(r.data?.metadataMatches || []).length &&
      ![...ALPHA_ONLY, ...ALL_ALPHA_IDS].some(v => results(r).includes(v))), `statuses ${betaForAlpha.status}/${betaRefAlpha.status}`);
  const alphaForBeta = await search('owner', W.alpha, MARK.beta), alphaRefBeta = await search('owner', W.alpha, 'Romans 8:28');
  check('SRCH-5', "The reverse holds: alpha searching the other workspace's word and reference finds nothing of it", [alphaForBeta, alphaRefBeta].every(r => r.status === 200 &&
    !(r.data?.notesMatches || []).length && !(r.data?.metadataMatches || []).length && ![...BETA_ONLY, ...ALL_BETA_IDS].some(v => results(r).includes(v))), `statuses ${alphaForBeta.status}/${alphaRefBeta.status}`);
  const viaAlpha = await search('outsider', W.alpha, MARK.alpha), findViaAlpha = await find('outsider', W.alpha, SERMON.alpha, MARK.alpha);
  const findCross = await find('owner', W.alpha, SERMON.beta, MARK.beta), findCrossBack = await find('outsider', W.beta, SERMON.alpha, MARK.alpha);
  check('SRCH-6', 'Non-members and cross-workspace sermon ids get 404 from search and find-in-notes, with no text', [viaAlpha, findViaAlpha, findCross, findCrossBack].every(r => r.status === 404 && r.data?.error === 'not_found') &&
    ![viaAlpha, findViaAlpha, findCross, findCrossBack].some(r => [...ALPHA_ONLY, ...BETA_ONLY].some(v => r.text.includes(v))), `statuses ${[viaAlpha, findViaAlpha, findCross, findCrossBack].map(r => r.status)}`);

  // FTS syntax in the query is plain words: no query below is a single exact word of either workspace, so none may match anything.
  const attempts = [`qabeta*`, `qaalpha*`, `${MARK.alpha} OR ${MARK.beta}`, `"${MARK.alpha}" OR "${MARK.beta}"`, `NEAR(${MARK.alpha} ${MARK.beta})`, `body:${MARK.beta}`, `${MARK.beta} -${MARK.alpha}`];
  const inj = [];
  for (const term of attempts) for (const [who, workspace, other] of [['outsider', W.beta, MARK.alpha], ['owner', W.alpha, MARK.beta]]) {
    const r = await search(who, workspace, term);
    if (r.status !== 200 || results(r).includes(other) || (r.data?.notesMatches || []).length || (r.data?.metadataMatches || []).length) inj.push(`${term.slice(0, 18)} ${r.status}`);
  }
  check('SRCH-7', `Search operators (prefix star, OR, quotes, NEAR, column filter, minus) never widen results: ${attempts.length} queries x 2 workspaces`, inj.length === 0, inj.slice(0, 3).join('; '));

  // A revoked version whose text was never purged stays invisible; find-in-notes reports it as revoked with no excerpt.
  const revoked = await search('viewer', W.alpha, MARK.revoked, '&archived=include'), revokedRef = await find('viewer', W.alpha, SERMON.alpha, MARK.revoked);
  const byLabel = Object.fromEntries((revokedRef.data?.versions || []).map(v => [v.label, v]));
  check('SRCH-8', 'Revoked-but-unpurged note text is never returned by search or find-in-notes (reported as not searchable: revoked)', revoked.status === 200 && !(revoked.data?.notesMatches || []).length &&
    !results(revoked).includes('Withdrawn') && !revokedRef.text.includes('Withdrawn') && byLabel['QA revoked copy']?.status === 'not_searchable' && byLabel['QA revoked copy']?.reason === 'revoked' &&
    !('excerpts' in (byLabel['QA revoked copy'] || {})) && byLabel['QA pdf']?.status === 'not_searchable' && byLabel['QA pdf']?.reason === 'unindexed', `status ${revoked.status}/${revokedRef.status}`);
  const found = await find('viewer', W.alpha, SERMON.alpha, MARK.alpha), foundBy = Object.fromEntries((found.data?.versions || []).map(v => [v.label, v]));
  check('SRCH-9', 'Find-in-notes marks the indexed version matched and the other versions not searchable', found.status === 200 && foundBy['QA original']?.status === 'matched' &&
    foundBy['QA original'].excerpts?.length >= 1 && foundBy['QA revoked copy']?.status === 'not_searchable', `status ${found.status}`);
}

// ---------- leak scan ----------
function scanForLeaks(label, { headers, text: body, expected = [] }) {
  const hits = [];
  const exempt = line => /^(location|set-cookie):/i.test(line) ? expected.reduce((l, s) => l.split(s).join(''), line) : line;
  const text = headers.split('\n').map(exempt).join('\n') + '\n' + body;
  for (const s of secrets) if (text.includes(s)) hits.push('a known token/email');
  if (/(\bat\s+\S+\s+\(|\.(ts|js|mjs):\d+|\bstack\b|D1_ERROR|SQLITE_|Error:)/i.test(text)) hits.push('stack/error internals');
  if (/\b(client_secret|GOOGLE_CLIENT_SECRET|PILOT_OWNER_EMAILS)\b/.test(text)) hits.push('secret name');
  if (/[\w.+-]+@[\w-]+(\.[\w-]+)+/.test(text)) hits.push('an email address');
  return hits.length ? `${label}: ${[...new Set(hits)].join(', ')}` : null;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------- main ----------
function printTable() {
  const width = Math.max(...results.map(r => r.id.length));
  console.log('\nResult   ' + 'ID'.padEnd(width) + '  Check');
  for (const r of results) {
    console.log(`${r.status.padEnd(8)} ${r.id.padEnd(width)}  ${r.name}${r.detail ? `  [${redact(r.detail)}]` : ''}`);
  }
  const count = s => results.filter(r => r.status === s).length;
  console.log(`\nPASS ${count('PASS')}  FAIL ${count('FAIL')}  SKIP ${count('SKIP')}  WARN ${count('WARN')}  (run ${RUN}, origin ${ORIGIN})`);
}

async function main({ readConfig = () => readFile(join(ROOT, 'wrangler.jsonc'), 'utf8'), origin = ORIGIN } = {}) {
  // Same pinned staging identity guard as the seed, plus the origin the HTTP checks call: D1 and HTTP must both be staging.
  assertStagingConfig(await readConfig());
  // Requests go to ORIGIN, so it is checked as well as the argument: synthetic session cookies must only ever travel over https to staging.
  for (const candidate of new Set([origin, ORIGIN])) {
    if (!isStagingOrigin(candidate)) throw new SeedRefusal(`STAGING_ORIGIN must be exactly ${STAGING_ORIGIN} (got ${redact(String(candidate))}); refusing to write.`);
  }
  await loadOwnerTriggers();
  const [migrated] = await d1Rows(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('sermon_scripture_refs', 'place_merges', 'import_review_rows', 'note_texts', 'note_reference_tokens')`);
  if (migrated.n !== 5) throw new Error('the staging D1 is missing migrations 0004-0006 (library, notes index, import review). Apply them and deploy the matching Worker first: pnpm exec wrangler d1 migrations apply DB --env staging --remote');
  results.length = 0; // a second in-process run (the tests) must not inherit the first run's rows
  console.log(`Staging auth QA against ${ORIGIN} (staging D1 only)`);
  console.log('Removing leftover synthetic rows, then seeding...');
  await cleanup({ requireTriggers: true });
  const tail = transport.tail();
  let failure = null;
  try {
    await d1(seedSql());
    // Give `wrangler tail` a moment to attach before traffic starts.
    for (let i = 0; i < 20 && !tail.isReady() && !tail.failure(); i++) await sleep(500);
    await sleep(2000);
    for (const step of [qaPublic, qaOAuth, qaSessions, qaTenancy, qaNewRoutesAccess, qaSearchNoLeak, qaRequestRules, qaRoles, qaInvitations, qaRevocation, qaLogout]) {
      try { await step(); } catch (error) { check(`ERR-${step.name}`, `${step.name} ran to completion`, false, redact(error.message)); }
    }
    await sleep(4000);
  } catch (error) { failure = error; }
  finally {
    tail.stop();
    await sleep(500);
    if (!tail.child.killed || tail.child.exitCode === null) tail.child.kill('SIGKILL');
  }
  if (failure) check('SETUP', 'Seed and run', false, redact(failure.message));

  // Error response and `wrangler tail` leak checks.
  const leaks = observedErrors.map((e, i) => scanForLeaks(`response #${i + 1} (${e.status})`, e)).filter(Boolean);
  check('LEAK-1', `No tokens, secrets, emails or stack traces in ${observedErrors.length} error responses`, leaks.length === 0, leaks.slice(0, 3).join('; '));
  const tailText = tail.lines.join('');
  if (tail.failure() || !/"(outcome|event|logs)"/.test(tailText)) {
    skip('LEAK-2', '`wrangler tail --env staging` output has no tokens/secrets/emails/stack traces', 'tail captured no events: ' + (tail.failure() || 'no events seen'));
  } else {
    const tailLeaks = [];
    for (const secret of secrets) if (tailText.includes(secret)) tailLeaks.push('a known token/email');
    if (/D1_ERROR|SQLITE_|\bstack\b/i.test(tailText)) tailLeaks.push('error internals');
    if (/[\w.+-]+@(?!sermon-qa\.test)[\w-]+(\.[\w-]+)+/.test(tailText.replace(/"cf-connecting-ip"[^,]*/g, ''))) tailLeaks.push('an email address');
    const events = (tailText.match(/"outcome"/g) || []).length;
    check('LEAK-2', `wrangler tail output (${events} events) has no tokens/secrets/emails/stack traces`, tailLeaks.length === 0, [...new Set(tailLeaks)].join(', '));
  }

  let residue = null;
  try { residue = await cleanup(); } catch (error) { check('CLEAN-1', 'Synthetic rows removed', false, redact(error.message)); }
  if (residue) check('CLEAN-1', 'Synthetic rows removed (accounts, workspaces, library, note text and search index), owner-protection triggers restored',
    residue.accounts === 0 && residue.workspaces === 0 && residue.library_rows === 0 && residue.note_rows === 0 && residue.fts_rows === 0 && residue.triggers === 2 && residue.attempts === 0,
    `accounts ${residue.accounts}, workspaces ${residue.workspaces}, library rows ${residue.library_rows}, note rows ${residue.note_rows}, search index rows ${residue.fts_rows}, triggers ${residue.triggers}, attempts ${residue.attempts}`);
  printTable();
  process.exitCode = results.some(r => r.status === 'FAIL') ? 1 : 0;
}

export { main };
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error('staging-qa aborted: ' + redact(error.message)); process.exit(2); });
}
