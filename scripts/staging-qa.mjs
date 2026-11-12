#!/usr/bin/env node
/**
 * Staging end-to-end auth QA. Run with `pnpm qa:staging`.
 *
 * - Seeds synthetic `*.test` accounts, workspaces, sessions and invitations in the
 *   STAGING D1 only (`wrangler d1 execute --env staging --remote`).
 * - Session and invite tokens are minted by inserting only their SHA-256 hashes
 *   (the scheme in src/auth). Raw tokens live in memory and are never printed.
 * - Exercises the deployed Worker over real HTTP, prints a PASS/FAIL/SKIP table,
 *   exits non-zero on any FAIL and removes every synthetic row it created.
 * - The real Google round trip (login, /api/me, logout) is out of scope: only the
 *   /auth/google/start redirect and state replay rejection are covered here.
 */
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = new URL('..', import.meta.url).pathname;
const WRANGLER = join(ROOT, 'node_modules', '.bin', 'wrangler');
const ORIGIN = (process.env.STAGING_ORIGIN || 'https://sermons-preview.favor.church').replace(/\/$/, '');
const HOST = new URL(ORIGIN).host;
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

function redact(text) {
  let out = String(text);
  for (const s of secrets) out = out.split(s).join('[redacted]');
  return out.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]').slice(0, 300);
}

// ---------- HTTP (curl with DNS-over-HTTPS: local DNS can hold a stale negative cache) ----------
async function http(method, path, { cookie, headers = {}, body, origin = ORIGIN, json = true } = {}) {
  const args = ['-sS', '-i', '--max-time', '30', '--max-redirs', '0', '--doh-url', DOH, '-X', method];
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (method !== 'GET' && origin) h.origin = origin;
  if (body !== undefined) { if (json) h['content-type'] = 'application/json'; }
  for (const [k, v] of Object.entries(h)) args.push('-H', `${k}: ${v}`);
  if (body !== undefined) args.push('--data-binary', typeof body === 'string' ? body : JSON.stringify(body));
  args.push(ORIGIN + path);
  const { stdout } = await run('curl', args, { maxBuffer: 4 << 20 });
  const split = stdout.indexOf('\r\n\r\n');
  const head = stdout.slice(0, split).split('\r\n');
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
  const text = stdout.slice(split + 4);
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (status < 200 || status >= 300) observedErrors.push({ status, headers: head.join('\n'), text });
  return { status, headers: resHeaders, setCookies, text, data };
}
const asSession = tok => `${SESSION_COOKIE}=${tok}`;

// ---------- D1 (staging only) ----------
async function d1(sql) {
  // --command rather than --file: wrangler 4.47's --file upload trips a FileHandle error on current Node.
  try {
    const { stdout } = await run(WRANGLER, ['d1', 'execute', 'DB', '--env', 'staging', '--remote', '--command', sql, '--json'],
      { cwd: ROOT, maxBuffer: 16 << 20, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' } });
    return JSON.parse(stdout);
  } catch (error) {
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
async function cleanup() {
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
    `DELETE FROM workspaces WHERE owner_account_id IN ${SYN_ACCOUNTS}`,
    `DELETE FROM google_identities WHERE account_id IN ${SYN_ACCOUNTS}`,
    `DELETE FROM user_accounts WHERE email_normalized LIKE '%@${EMAIL_DOMAIN}'`,
    ...ownerTriggers
  ];
  await d1(statements.join(';\n') + ';');
  const left = await d1Rows(`SELECT
    (SELECT COUNT(*) FROM user_accounts WHERE email_normalized LIKE '%@${EMAIL_DOMAIN}') AS accounts,
    (SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'protect_owner_membership_%') AS triggers,
    (SELECT COUNT(*) FROM oauth_login_attempts WHERE code_verifier LIKE 'qa-%') AS attempts`);
  return left[0];
}

// ---------- fixtures ----------
const W = { alpha: uuid(), beta: uuid() };
const A = Object.fromEntries(['owner', 'admin', 'admin2', 'editor', 'viewer', 'outsider', 'invitee', 'inviteeWrong', 'expired', 'revoked', 'disabled', 'fresh']
  .map(name => [name, { id: uuid(), email: email(name), session: token() }]));
const INVITE_EXPIRED = { id: uuid(), raw: token() };
const INVITE_REVOKED = { id: uuid(), raw: token() };
const SERMON = { alpha: uuid(), beta: uuid() };
const OAUTH = { state: token(), nonce: token(), verifier: 'qa-' + token() };
for (const a of Object.values(A)) { secrets.add(a.email); secrets.add(a.session); }
for (const t of [INVITE_EXPIRED.raw, INVITE_REVOKED.raw, OAUTH.state]) secrets.add(t);

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
  s.push(`INSERT INTO sermons(id,workspace_id,title) VALUES(${q(SERMON.alpha)},${q(W.alpha)},'QA alpha sermon ${RUN}')`);
  s.push(`INSERT INTO sermons(id,workspace_id,title) VALUES(${q(SERMON.beta)},${q(W.beta)},'QA beta sermon ${RUN}')`);
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
    if (flowValue) secrets.add(flowValue);
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
  check('TEN-12', 'No write route exists for sermons (404)', post.status === 404, `status ${post.status}`);
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
  const del = await http('DELETE', '/api/me', { cookie });
  check('CSRF-5', 'Unsupported method -> 405', del.status === 405, `status ${del.status}`);
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

// ---------- leak scan ----------
function scanForLeaks(label, text) {
  const hits = [];
  for (const s of secrets) if (text.includes(s)) hits.push('a known token/email');
  if (/(\bat\s+\S+\s+\(|\.(ts|js|mjs):\d+|\bstack\b|D1_ERROR|SQLITE_|Error:)/i.test(text)) hits.push('stack/error internals');
  if (/\b(client_secret|GOOGLE_CLIENT_SECRET|PILOT_OWNER_EMAILS)\b/.test(text)) hits.push('secret name');
  if (/[\w.+-]+@[\w-]+(\.[\w-]+)+/.test(text)) hits.push('an email address');
  return hits.length ? `${label}: ${[...new Set(hits)].join(', ')}` : null;
}

function startTail() {
  const lines = [];
  let ready = false;
  const child = spawn(WRANGLER, ['tail', '--env', 'staging', '--format', 'json'], { cwd: ROOT, env: { ...process.env, NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false' } });
  const onData = chunk => { ready = true; lines.push(chunk.toString()); };
  child.stdout.on('data', onData);
  child.stderr.on('data', chunk => { ready = true; lines.push(chunk.toString()); });
  let failed = null;
  child.on('error', error => { failed = error.message; });
  child.on('exit', code => { if (code && !failed) failed = `exited ${code}`; });
  return { child, lines, isReady: () => ready, failure: () => failed };
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
  console.log(`\nPASS ${count('PASS')}  FAIL ${count('FAIL')}  SKIP ${count('SKIP')}  (run ${RUN}, origin ${ORIGIN})`);
}

async function main() {
  await loadOwnerTriggers();
  console.log(`Staging auth QA against ${ORIGIN} (staging D1 only)`);
  console.log('Removing leftover synthetic rows, then seeding...');
  await cleanup();
  const tail = startTail();
  let failure = null;
  try {
    await d1(seedSql());
    // Give `wrangler tail` a moment to attach before traffic starts.
    for (let i = 0; i < 20 && !tail.isReady() && !tail.failure(); i++) await sleep(500);
    await sleep(2000);
    for (const step of [qaPublic, qaOAuth, qaSessions, qaTenancy, qaRequestRules, qaRoles, qaInvitations, qaRevocation, qaLogout]) {
      try { await step(); } catch (error) { check(`ERR-${step.name}`, `${step.name} ran to completion`, false, redact(error.message)); }
    }
    await sleep(4000);
  } catch (error) { failure = error; }
  finally {
    tail.child.kill('SIGINT');
    await sleep(500);
    if (!tail.child.killed || tail.child.exitCode === null) tail.child.kill('SIGKILL');
  }
  if (failure) check('SETUP', 'Seed and run', false, redact(failure.message));

  // Error response and `wrangler tail` leak checks.
  const leaks = observedErrors.map((e, i) => scanForLeaks(`response #${i + 1} (${e.status})`, e.headers + '\n' + e.text)).filter(Boolean);
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
  if (residue) check('CLEAN-1', 'Synthetic rows removed, owner-protection triggers restored',
    residue.accounts === 0 && residue.triggers === 2 && residue.attempts === 0, `accounts ${residue.accounts}, triggers ${residue.triggers}, attempts ${residue.attempts}`);
  printTable();
  process.exitCode = results.some(r => r.status === 'FAIL') ? 1 : 0;
}

main().catch(error => { console.error('staging-qa aborted: ' + redact(error.message)); process.exit(2); });
