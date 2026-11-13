/** Private, fail-closed Worker routes. Pilot authentication: Google OIDC only. */
import {
  SESSION_COOKIE, FLOW_COOKIE, randomToken, sha256, constantTimeEqual,
  getCookie, sessionCookie, clearSessionCookie, flowCookie, clearFlowCookie,
  noStoreHeaders, reply, readBinding, publicOrigin, requiresSameOrigin, parseEmail,
  readJson, can, canInvite, canManageMember, isRole, isUuid, type Role
} from './security.ts';
import { handleLibraryRoute } from '../api/index.ts';
import { isStaticPath, serveStatic } from '../ui/assets.ts';
import { googleAuthorizationUrl, pkceChallenge, exchangeCode, verifyGoogleIdToken, type GoogleIdentity } from './google.ts';

const NOW = () => Math.floor(Date.now() / 1000);
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const INVITE_SECONDS = 7 * 24 * 60 * 60;
const LOGIN_SECONDS = 10 * 60;

type Account = { id: string; email_normalized: string; display_name: string };
type Membership = { role: Role };
type InviteRow = { id: string; workspace_id: string; invited_role: Role };

function redirect(location: string, setCookie?: string): Response {
  const headers = noStoreHeaders();
  headers.delete('content-type');
  headers.set('location', location);
  if (setCookie) headers.append('set-cookie', setCookie);
  return new Response(null, { status: 303, headers });
}

function csrfRejected(request: Request, origin: string): Response | null {
  if (!requiresSameOrigin(request, origin)) return reply(403, { error: 'invalid_origin' });
  return null;
}

function config(env: Env, request: Request): { origin: string; clientId: string; clientSecret: string; redirectUri: string } | null {
  const origin = publicOrigin(env);
  const clientId = readBinding(env, 'GOOGLE_CLIENT_ID');
  const clientSecret = readBinding(env, 'GOOGLE_CLIENT_SECRET');
  if (!origin || !clientId || !clientSecret || new URL(request.url).origin !== origin) return null;
  return { origin, clientId, clientSecret, redirectUri: origin + '/auth/google/callback' };
}

function pilotAllowed(env: Env, email: string): boolean {
  const list = readBinding(env, 'PILOT_OWNER_EMAILS');
  return Boolean(list && list.split(',').some(item => parseEmail(item) === email));
}

async function activeInviteForEmail(env: Env, email: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS found FROM workspace_invitations i
    JOIN workspaces w ON w.id = i.workspace_id
    WHERE i.email_normalized = ? AND i.expires_at > ? AND i.accepted_at IS NULL
      AND i.revoked_at IS NULL AND w.deleted_at IS NULL LIMIT 1`)
    .bind(email, NOW()).first<{ found: number }>();
  return row?.found === 1;
}

async function findOrProvisionAccount(env: Env, identity: GoogleIdentity): Promise<Account | null> {
  const existing = await env.DB.prepare(`SELECT a.id, a.email_normalized, a.display_name, a.disabled_at
    FROM google_identities gi JOIN user_accounts a ON a.id = gi.account_id
    WHERE gi.subject = ?`)
    .bind(identity.subject).first<Account & { disabled_at: string | null }>();
  if (existing) {
    // A disabled account must never fall through to email lookup or provisioning.
    if (existing.disabled_at !== null) return null;
    // A verified email change can change who controls that address. Require
    // explicit reconciliation rather than silently inheriting workspace access.
    return existing.email_normalized === identity.email ? existing : null;
  }
  if (!pilotAllowed(env, identity.email) && !(await activeInviteForEmail(env, identity.email))) return null;
  const byEmail = await env.DB.prepare(`SELECT id, email_normalized, display_name FROM user_accounts
    WHERE email_normalized = ? AND disabled_at IS NULL`).bind(identity.email).first<Account>();
  if (byEmail) {
    const other = await env.DB.prepare(`SELECT subject FROM google_identities WHERE account_id = ?`)
      .bind(byEmail.id).first<{ subject: string }>();
    if (other) return null; // Never link a different Google subject automatically.
    await env.DB.prepare(`INSERT INTO google_identities(subject, account_id) VALUES(?, ?)`)
      .bind(identity.subject, byEmail.id).run();
    return byEmail;
  }
  const accountId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO user_accounts(id, email_normalized, display_name)
      VALUES (?, ?, ?)`).bind(accountId, identity.email, identity.displayName),
    env.DB.prepare(`INSERT INTO google_identities(subject, account_id) VALUES(?, ?)`)
      .bind(identity.subject, accountId)
  ]);
  return { id: accountId, email_normalized: identity.email, display_name: identity.displayName };
}

async function startLogin(request: Request, env: Env): Promise<Response> {
  const c = config(env, request);
  if (!c) return reply(503, { error: 'identity_provider_not_configured' });
  const state = randomToken(), verifier = randomToken(), nonce = randomToken();
  await env.DB.batch([
    // Unauthenticated starts must not accumulate rows forever.
    env.DB.prepare(`DELETE FROM oauth_login_attempts WHERE expires_at <= ?`).bind(NOW()),
    env.DB.prepare(`INSERT INTO oauth_login_attempts(state_hash, nonce, code_verifier, expires_at)
      VALUES(?, ?, ?, ?)`).bind(await sha256(state), nonce, verifier, NOW() + LOGIN_SECONDS)
  ]);
  const url = googleAuthorizationUrl(c.clientId, c.redirectUri, state, nonce, await pkceChallenge(verifier));
  return redirect(url, flowCookie(state, LOGIN_SECONDS));
}

async function finishLogin(request: Request, env: Env): Promise<Response> {
  const cookie = getCookie(request, FLOW_COOKIE);
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const c = config(env, request);
  const reject = (status: number) => {
    const res = reply(status, { error: 'login_failed' });
    res.headers.append('set-cookie', clearFlowCookie());
    return res;
  };
  if (!c || !cookie || !state || !code || !constantTimeEqual(cookie, state) ||
      !/^[A-Za-z0-9_-]{43}$/.test(state)) return reject(401);
  // The one-time DB deletion happens before exchange, so even an interrupted
  // callback cannot replay the state, nonce or PKCE verifier.
  const attempt = await env.DB.prepare(`DELETE FROM oauth_login_attempts
    WHERE state_hash = ? AND expires_at > ? RETURNING nonce, code_verifier`)
    .bind(await sha256(state), NOW()).first<{ nonce: string; code_verifier: string }>();
  if (!attempt) return reject(401);
  try {
    const idToken = await exchangeCode(code, attempt.code_verifier, c);
    const identity = await verifyGoogleIdToken(idToken, c.clientId, attempt.nonce);
    const account = await findOrProvisionAccount(env, identity);
    if (!account) return reject(403);
    const rawSession = randomToken();
    await env.DB.prepare(`INSERT INTO auth_sessions(token_hash, account_id, expires_at)
      VALUES(?, ?, ?)`).bind(await sha256(rawSession), account.id, NOW() + SESSION_SECONDS).run();
    const response = redirect('/', sessionCookie(rawSession, SESSION_SECONDS));
    response.headers.append('set-cookie', clearFlowCookie());
    return response;
  } catch {
    // Never echo OAuth tokens, callback params or Google errors to a user/log.
    return reject(401);
  }
}

async function session(request: Request, env: Env): Promise<Account | null> {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const found = await env.DB.prepare(`SELECT a.id, a.email_normalized, a.display_name
    FROM auth_sessions s JOIN user_accounts a ON a.id = s.account_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
      AND a.disabled_at IS NULL`).bind(await sha256(token), NOW()).first<Account>();
  return found || null;
}

async function membership(env: Env, workspaceId: string, actorId: string): Promise<Membership | null> {
  if (!isUuid(workspaceId)) return null;
  return env.DB.prepare(`SELECT wm.role FROM workspace_memberships wm
    JOIN workspaces w ON w.id = wm.workspace_id
    WHERE wm.workspace_id = ? AND wm.account_id = ? AND wm.accepted_at IS NOT NULL
      AND wm.revoked_at IS NULL AND w.deleted_at IS NULL`)
    .bind(workspaceId, actorId).first<Membership>();
}

async function listWorkspaces(env: Env, account: Account): Promise<Response> {
  const results = await env.DB.prepare(`SELECT w.id, w.name, wm.role FROM workspace_memberships wm
    JOIN workspaces w ON w.id = wm.workspace_id
    WHERE wm.account_id = ? AND wm.accepted_at IS NOT NULL
      AND wm.revoked_at IS NULL AND w.deleted_at IS NULL
    ORDER BY w.created_at ASC LIMIT 100`).bind(account.id)
    .all<{ id: string; name: string; role: Role }>();
  return reply(200, { workspaces: results.results || [] });
}

async function createWorkspace(request: Request, env: Env, actor: Account): Promise<Response> {
  // This is an *invite-only pilot* bootstrap, not global self-registration.
  if (!pilotAllowed(env, actor.email_normalized)) return reply(403, { error: 'pilot_access_only' });
  const body = await readJson(request);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (name.length < 3 || name.length > 120) return reply(400, { error: 'invalid_workspace_name' });
  const hasWorkspace = async () => Boolean(await env.DB.prepare(`SELECT 1 AS found FROM workspaces
    WHERE owner_account_id = ? AND deleted_at IS NULL LIMIT 1`).bind(actor.id).first());
  if (await hasWorkspace()) return reply(409, { error: 'personal_workspace_exists' });
  const id = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workspaces(id, name, owner_account_id) VALUES(?, ?, ?)`)
        .bind(id, name, actor.id),
      env.DB.prepare(`INSERT INTO workspace_memberships(workspace_id, account_id, role, accepted_at)
        VALUES(?, ?, 'owner', CURRENT_TIMESTAMP)`).bind(id, actor.id),
      env.DB.prepare(`INSERT INTO audit_events(id, workspace_id, actor_account_id, action, target_type, target_id)
        VALUES(?, ?, ?, 'workspace.create', 'workspace', ?)`)
        .bind(crypto.randomUUID(), id, actor.id, id)
    ]);
  } catch (error) {
    // A concurrent create hits the unique active-owner index; report it as a conflict.
    if (await hasWorkspace()) return reply(409, { error: 'personal_workspace_exists' });
    throw error;
  }
  return reply(201, { id, name, role: 'owner' });
}

async function inviteMember(request: Request, env: Env, workspaceId: string, actor: Account, actorRole: Role, origin: string): Promise<Response> {
  const body = await readJson(request);
  const email = parseEmail(body?.email), role = body?.role;
  if (!email || !canInvite(actorRole, role)) return reply(400, { error: 'invalid_invitation' });
  const already = await env.DB.prepare(`SELECT 1 AS found FROM workspace_memberships wm
    JOIN user_accounts u ON u.id = wm.account_id
    WHERE wm.workspace_id = ? AND u.email_normalized = ? AND wm.revoked_at IS NULL LIMIT 1`)
    .bind(workspaceId, email).first<{ found: number }>();
  if (already) return reply(409, { error: 'member_exists' });
  const rate = await env.DB.prepare(`SELECT COUNT(*) AS n FROM workspace_invitations
    WHERE workspace_id = ? AND created_at > datetime('now','-1 day')`).bind(workspaceId).first<{ n: number }>();
  if ((rate?.n || 0) >= 20) return reply(429, { error: 'invite_limit_reached' });
  const inviteId = crypto.randomUUID(), rawToken = randomToken();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspace_invitations
      (id, workspace_id, email_normalized, invited_role, token_hash, invited_by_account_id, expires_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)`)
      .bind(inviteId, workspaceId, email, role, await sha256(rawToken), actor.id, NOW() + INVITE_SECONDS),
    env.DB.prepare(`INSERT INTO audit_events(id, workspace_id, actor_account_id, action, target_type, target_id)
      VALUES(?, ?, ?, 'invitation.create', 'invitation', ?)`)
      .bind(crypto.randomUUID(), workspaceId, actor.id, inviteId)
  ]);
  // Email transport and web acceptance form are deliberately separate follow-ups.
  // The secret is returned once to an authorized Owner/Admin; never logged.
  return reply(201, { invitation_id: inviteId, role, email, token: rawToken, expires_in_seconds: INVITE_SECONDS, acceptance_endpoint: origin + '/api/invitations/accept' });
}

async function acceptInvite(request: Request, env: Env, account: Account): Promise<Response> {
  const body = await readJson(request);
  const raw = typeof body?.token === 'string' ? body.token : '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) return reply(400, { error: 'invalid_invitation' });
  const tokenHash = await sha256(raw);
  const invitation = await env.DB.prepare(`SELECT i.id, i.workspace_id, i.invited_role
    FROM workspace_invitations i JOIN workspaces w ON w.id = i.workspace_id
    WHERE i.token_hash = ? AND i.email_normalized = ? AND i.expires_at > ?
      AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND w.deleted_at IS NULL`)
    .bind(tokenHash, account.email_normalized, NOW()).first<InviteRow>();
  if (!invitation) return reply(404, { error: 'invitation_not_available' });
  const active = await membership(env, invitation.workspace_id, account.id);
  if (active) return reply(409, { error: 'already_a_member' });
  const attempt = crypto.randomUUID();
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE workspace_invitations SET accepted_at = CURRENT_TIMESTAMP,
      accepted_by_account_id = ?, acceptance_attempt_id = ?
      WHERE id = ? AND token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`)
      .bind(account.id, attempt, invitation.id, tokenHash, NOW()),
    env.DB.prepare(`UPDATE workspace_memberships SET role = ?, accepted_at = CURRENT_TIMESTAMP,
      revoked_at = NULL WHERE workspace_id = ? AND account_id = ? AND revoked_at IS NOT NULL
      AND role <> 'owner' AND EXISTS(SELECT 1 FROM workspace_invitations
        WHERE id = ? AND acceptance_attempt_id = ?)`)
      .bind(invitation.invited_role, invitation.workspace_id, account.id, invitation.id, attempt),
    env.DB.prepare(`INSERT OR IGNORE INTO workspace_memberships(workspace_id, account_id, role, accepted_at)
      SELECT workspace_id, ?, invited_role, CURRENT_TIMESTAMP FROM workspace_invitations
      WHERE id = ? AND acceptance_attempt_id = ?`)
      .bind(account.id, invitation.id, attempt),
    env.DB.prepare(`INSERT INTO audit_events(id, workspace_id, actor_account_id, action, target_type, target_id)
      SELECT ?, workspace_id, ?, 'invitation.accept', 'invitation', id
      FROM workspace_invitations WHERE id = ? AND acceptance_attempt_id = ?`)
      .bind(crypto.randomUUID(), account.id, invitation.id, attempt)
  ]);
  if (result[0]?.meta?.changes !== 1) return reply(409, { error: 'invitation_already_used' });
  return reply(200, { workspace_id: invitation.workspace_id, role: invitation.invited_role });
}

async function manageMember(request: Request, env: Env, workspaceId: string, memberId: string, actor: Account, actorRole: Role): Promise<Response> {
  if (!isUuid(memberId)) return reply(404, { error: 'not_found' });
  const body = await readJson(request);
  if (!body || (body.revoke !== true && !isRole(body.role))) return reply(400, { error: 'invalid_membership_change' });
  const target = await env.DB.prepare(`SELECT role FROM workspace_memberships
    WHERE workspace_id = ? AND account_id = ? AND accepted_at IS NOT NULL AND revoked_at IS NULL`)
    .bind(workspaceId, memberId).first<Membership>();
  if (!target) return reply(404, { error: 'not_found' });
  const newRole = body.revoke === true ? 'revoke' : body.role as Role;
  if (!canManageMember(actorRole, target.role, newRole)) return reply(403, { error: 'forbidden' });
  const eventId = crypto.randomUUID();
  const statements = [
    newRole === 'revoke'
      ? env.DB.prepare(`UPDATE workspace_memberships SET revoked_at = CURRENT_TIMESTAMP
          WHERE workspace_id = ? AND account_id = ? AND role = ? AND revoked_at IS NULL`)
          .bind(workspaceId, memberId, target.role)
      : env.DB.prepare(`UPDATE workspace_memberships SET role = ?
          WHERE workspace_id = ? AND account_id = ? AND role = ? AND revoked_at IS NULL`)
          .bind(newRole, workspaceId, memberId, target.role),
    env.DB.prepare(`INSERT INTO audit_events(id, workspace_id, actor_account_id, action, target_type, target_id, details_json)
      SELECT ?, ?, ?, ?, 'membership', ?, ? WHERE changes() = 1`)
      .bind(eventId, workspaceId, actor.id, newRole === 'revoke' ? 'membership.revoke' : 'membership.role_change', memberId,
        JSON.stringify({ previous_role: target.role, next_role: newRole }))
  ];
  const results = await env.DB.batch(statements);
  if (results[0]?.meta?.changes !== 1) return reply(409, { error: 'membership_changed' });
  return reply(200, { member_id: memberId, role: newRole });
}

async function logout(request: Request, env: Env, origin: string): Promise<Response> {
  const denied = csrfRejected(request, origin);
  if (denied) return denied;
  const token = getCookie(request, SESSION_COOKIE);
  if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
    await env.DB.prepare(`UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP
      WHERE token_hash = ? AND revoked_at IS NULL`).bind(await sha256(token)).run();
  }
  const response = reply(200, { signed_out: true });
  response.headers.append('set-cookie', clearSessionCookie());
  return response;
}

function signInPage(): Response {
  const headers = noStoreHeaders();
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>My Sermons</title><style>body{font:16px system-ui;background:#f4f6f2;color:#24382a;min-height:80vh;display:grid;place-items:center;margin:0}main{max-width:480px;padding:3rem;background:white;border:1px solid #dfe8df;border-radius:16px}a{display:inline-block;background:#376448;color:white;border-radius:8px;padding:12px 18px}small{display:block;margin-top:24px;color:#657769}</style><main><h1>My Sermons</h1><p>Every message has a story. Keep your archive private and discoverable.</p><a href="/auth/google/start">Continue with Google</a><small>Invite-only pilot. Original Google Docs and PDFs remain untouched.</small></main></html>`;
  return new Response(html, { status: 200, headers });
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (request.method === 'GET' && pathname === '/health') return reply(200, { status: 'ok', app: 'sermon-bank' });
  const origin = publicOrigin(env);
  if (!origin || new URL(request.url).origin !== origin || !env.DB) return reply(503, { error: 'service_not_configured' });
  try {
    if (request.method === 'GET' && pathname === '/signin') return signInPage();
    if ((request.method === 'GET' || request.method === 'HEAD') && isStaticPath(pathname)) {
      // The app shell and its assets are for signed-in users only. Signed out, `/` is the sign-in page.
      if (await session(request, env)) return await serveStatic(request, env);
      return pathname === '/' && request.method === 'GET' ? signInPage() : reply(404, { error: 'not_found' });
    }
    if (request.method === 'GET' && pathname === '/auth/google/start') return await startLogin(request, env);
    if (request.method === 'GET' && pathname === '/auth/google/callback') return await finishLogin(request, env);
    if (request.method === 'POST' && pathname === '/auth/logout') return await logout(request, env, origin);
    if (request.method === 'GET' && pathname === '/welcome') return redirect('/api/me');
    if (!pathname.startsWith('/api/')) return reply(404, { error: 'not_found' });
    if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(request.method)) return reply(405, { error: 'method_not_allowed' });
    if (request.method !== 'GET') {
      const rejected = csrfRejected(request, origin);
      if (rejected) return rejected;
    }
    const actor = await session(request, env);
    if (!actor) return reply(401, { error: 'unauthenticated' });
    if (pathname === '/api/me' && request.method === 'GET') {
      return reply(200, { account: actor });
    }
    if (pathname === '/api/workspaces') {
      if (request.method === 'GET') return await listWorkspaces(env, actor);
      if (request.method === 'POST') return await createWorkspace(request, env, actor);
    }
    if (pathname === '/api/invitations/accept' && request.method === 'POST') return await acceptInvite(request, env, actor);
    const match = /^\/api\/workspaces\/([^/]+)(\/.*)?$/.exec(pathname);
    if (!match) return reply(404, { error: 'not_found' });
    const workspaceId = match[1];
    const access = await membership(env, workspaceId, actor.id);
    if (!access) return reply(404, { error: 'not_found' });
    const library = await handleLibraryRoute(request, env, { workspaceId, actorId: actor.id, role: access.role }, match[2] ?? '');
    if (library) return library;
    const rest = /^\/(invitations|members)(?:\/([^/]+))?$/.exec(match[2] ?? '');
    if (rest?.[1] === 'invitations' && !rest[2] && request.method === 'POST') {
      if (!can(access.role, 'invite')) return reply(403, { error: 'forbidden' });
      return await inviteMember(request, env, workspaceId, actor, access.role, origin);
    }
    if (rest?.[1] === 'members' && rest[2] && request.method === 'PATCH') {
      if (!can(access.role, 'invite')) return reply(403, { error: 'forbidden' });
      return await manageMember(request, env, workspaceId, rest[2], actor, access.role);
    }
    return reply(404, { error: 'not_found' });
  } catch {
    // Do not log private query values, credentials, emails, tokens, source paths,
    // or SQL text. Observability is intentionally generic until redaction review.
    return reply(503, { error: 'temporarily_unavailable' });
  }
}
