/** Private, fail-closed Worker routes. Public sign-up: Google OIDC only. */
import {
  SESSION_COOKIE, FLOW_COOKIE, randomToken, sha256, constantTimeEqual,
  getCookie, sessionCookie, clearSessionCookie, flowCookie, clearFlowCookie,
  noStoreHeaders, reply, readBinding, publicOrigin, requiresSameOrigin, parseEmail,
  readJson, can, canInvite, canManageMember, isRole, isUuid, type Role
} from './security.ts';
import { handleLibraryRoute } from '../api/index.ts';
import { FAVICON_PATH, isStaticPath, serveFavicon, serveStatic } from '../ui/assets.ts';
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
  // Public sign-up: any verified Google account may create workspaces, as many as it needs.
  const body = await readJson(request);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (name.length < 3 || name.length > 120) return reply(400, { error: 'invalid_workspace_name' });
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspaces(id, name, owner_account_id) VALUES(?, ?, ?)`)
      .bind(id, name, actor.id),
    env.DB.prepare(`INSERT INTO workspace_memberships(workspace_id, account_id, role, accepted_at)
      VALUES(?, ?, 'owner', CURRENT_TIMESTAMP)`).bind(id, actor.id),
    env.DB.prepare(`INSERT INTO audit_events(id, workspace_id, actor_account_id, action, target_type, target_id)
      VALUES(?, ?, ?, 'workspace.create', 'workspace', ?)`)
      .bind(crypto.randomUUID(), id, actor.id, id)
  ]);
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

/** Every active, accepted member of one workspace (no cap, so People & Access can manage all of them). Read-only, for the people who can already manage them. */
async function listMembers(env: Env, workspaceId: string): Promise<Response> {
  const rows = await env.DB.prepare(`SELECT u.id AS account_id, u.display_name, u.email_normalized AS email, wm.role, wm.accepted_at
    FROM workspace_memberships wm JOIN user_accounts u ON u.id = wm.account_id
    WHERE wm.workspace_id = ? AND wm.accepted_at IS NOT NULL AND wm.revoked_at IS NULL
    ORDER BY CASE wm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'editor' THEN 2 ELSE 3 END,
      u.display_name COLLATE NOCASE, u.id`)
    .bind(workspaceId).all<{ account_id: string; display_name: string; email: string; role: Role; accepted_at: string }>();
  return reply(200, { members: rows.results || [] });
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

// Signed-out visitors cannot fetch /assets/*, so the sign-in page carries its own icons as data: URIs.
// ICON_SVG is byte-identical to public/assets/icon.svg (a test enforces it); the PNG is a 180px apple-touch-icon.
const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#476b51"/><rect x="6.5" y="9" width="4.6" height="15" rx="1" fill="#eef4ea"/><rect x="12.4" y="6.5" width="4.6" height="17.5" rx="1" fill="#cfe0cc"/><rect x="18.6" y="9.4" width="4.6" height="15" rx="1" transform="rotate(14 20.9 24)" fill="#eef4ea"/><path d="M13.6 6.5h2.2v6.4l-1.1-1-1.1 1z" fill="#c8a45c"/><rect x="5" y="24" width="22" height="2.4" rx="1.2" fill="#24382a"/></svg>';
const APPLE_TOUCH_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAMAAAAKE/YAAAAAKlBMVEX///83Uj9Ha1E9YkhdfWV9l4JsiXCdsJrP38zQ4c3IpF3v9eskOCoeNCWZ0YSKAAAAAXRSTlMAQObYZgAABOhJREFUeNrt3X2foiAQB3AJDTjt/b/dk8zClMcZGGY/zf1xtdfZd2d/gLWpwxAtIW4NS4i4KOJtyT3Q2YnL3bTirVg1+VMZ7aamusWQnMqmNhaou0mzW4Jbm7fiaA6pqWUlampXiZpaVaKmNpWou5zrjiUYNvrcampPiZpaU6SmxpSgqS0lagYzx16CYaOdVlNDStDUjiI1NaMEzWgY2hIMG/1qNTWiBM0sHVs+qA359UP/0EE0u3FoRyIeWkrp3nbuoaPRNjVO03R3aprGWmo0tNLG6H9OGWNUJTYWWq1ko1y0Xr8Lc+8YLdVK/kIb+23ojtE321VzQq/qqcZwxEGPRnvQql/03aL1D90I/YtHfbT0oU33aMMLfeu20/K7+kdLuxN3rPHjWdG6w4Go5nOpvtGjma/KOOjCebroxUISWur5urSEoeVNrXW/ZcKT0OPsq9FB58dDTq+fmFpfLmTAU9D7ti/qtedZ1unDdnPgSWjlRSsHnd/p0xh5wrtGX2/WqDioLjq4uPiGt4m+HCZE34xnoyYGQkRnDkR5jw3vHtH+rep26MyB6F2xVnQEhIU2+fO08aNJOx0aiP5Iz7EdFjJ0YKPzvRVa56L9kZ5joAponZbp8khXmPL06+8IGhBpfLTt+PNGGA2JNDraSm1UomhApHHRVqp3tQ7HAxBpXPRz3jPbLR1GQyKNi3ZKm2A8gpGOgrA7/V0+NCTSVGhQpCujvfEARbpapsOdBs3SVdHbyn6N9kc6+loLCy2vO+1HwyJdOR4+NCzSNdA6igZGmqbTsFmaKh6BSDdDy0w0MNIknYZGGrPTl+5LNDDSlePhWRGBkUZ9C0F/RcMXD2ikKfY9wJGmWFzAkSaZPWA7HiRo6f9dWWKkKdDgSFOgwZGmyDR0lqZAwyONiNZpaIRIt19cQug0MsWKCI90+0wjRLryMn7uNEakm3caYZYmeLkF3vEg6DR4XxoZrRPQKJFu3WmMWbp9PBBm6eYDEWOWbt3pUDoyDnmo0OnA4oIT6dbve6BEulI8tCceOJFuu5eHFGnMj07EByJSpNuikSLddspDinRTNFaku0FnkBvHAynSTdFYkUZG6xAaLdItFxeUl4cV0foKjRbplplGi3RDNF6kO0FnkZu+3EKLdMNO40W6HTpwWFJupJEOgxqv31F3j9APofPIqYf2RZ9OnRfD7dfMnwNt/PHIPmFC2qF9vny8f/j358dit0+Y6k+5xzT5F8TsAy0Tj/y8Vjuk6XoRd7fhbXX2SR4S0XKyP+39WdZb6x/tPpkclf4uNR23Mer9f3+2M6d9Ei8TLZdnPR6LeNdib9svObXfE6/79lGHB9i74ljP7Yjlu6AfRZYH1lb7rdOTvR/h+/fl4W7jfff0qBh7SDa3rIcEoInMa5Wj5QP+7DVaHUTTNTrc6h+6C7Sgy3TwlGfBE6JRzXhLeIGJnMWNqtXhRovISf4WEvUjMk3HzkwoPov2I60ij49txrYpcg6/hNMpyqsSQmZ9PatiIqbngOR3EkjB9bS3PNHM8iH4njSbJ5qVmvXZ6zkNRefyKNSU9OJ48Qv2VxnhouZ46Zy/cWElBq0eBn7qYeCnHgZ+6mHgpx4GfuohWF3OfPELw1ILzxUld6hOMXfGTiT3lOzMq0pTc23liXtoN79LjsMv797d5ej/A7/LDUCmujcWAAAAAElFTkSuQmCC';
const ICON_LINKS = `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(ICON_SVG)}" type="image/svg+xml"><link rel="apple-touch-icon" href="data:image/png;base64,${APPLE_TOUCH_PNG_BASE64}">`;

// Sign-in page (variant A, Rico 2026-11-22): one centred column with the name, one sentence, the button and one note.
// Colours match public/assets/app.css. Inline <style> and <svg> only: the CSP allows inline styles and data: images, nothing else.
const SIGN_IN_CSS = ":root{--background:#f8f9f5;--ink:#26392c;--muted:#5a6b5e;--accent:#476b51;--accent-strong:#335a3e;--focus:#1d5fa8;--serif:Georgia,'Times New Roman',serif;--sans:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif}*,*::before,*::after{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:24px 20px;background:var(--background);color:var(--ink);font:16px/1.5 var(--sans)}h1,p{margin:0}:focus-visible{outline:3px solid var(--focus);outline-offset:2px;border-radius:4px}main{width:100%;max-width:352px;text-align:center}.mark{display:inline-block;line-height:0}h1{font:400 32px/1.15 var(--serif);letter-spacing:-.5px;margin-top:16px}.what{margin-top:8px;color:var(--muted)}.go{display:flex;width:100%;margin-top:32px;align-items:center;justify-content:center;gap:12px;min-height:48px;padding:8px 20px 8px 8px;background:var(--accent);border:1px solid var(--accent);color:#fff;border-radius:9px;font-weight:650;text-decoration:none}.go:hover{background:var(--accent-strong)}.go .g{display:grid;place-items:center;width:32px;height:32px;background:#fff;border-radius:6px;flex:none}.note{margin-top:16px;font-size:14px;color:var(--muted)}";
const GOOGLE_G_SVG = "<svg width=\"18\" height=\"18\" viewBox=\"0 0 18 18\"><path fill=\"#4285F4\" d=\"M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z\"/><path fill=\"#34A853\" d=\"M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 0 0 9 18z\"/><path fill=\"#FBBC05\" d=\"M3.96 10.71A5.41 5.41 0 0 1 3.68 9c0-.6.1-1.17.28-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.04l3-2.33z\"/><path fill=\"#EA4335\" d=\"M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.66 3.58 9 3.58z\"/></svg>";

function signInPage(): Response {
  const headers = noStoreHeaders();
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('content-security-policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sermon Bank</title>${ICON_LINKS}<style>${SIGN_IN_CSS}</style><main><span class="mark" aria-hidden="true">${ICON_SVG.replace('<svg ', '<svg width="48" height="48" ')}</span><h1>Sermon Bank</h1><p class="what">Sign in to open your sermon archive.</p><a class="go" href="/auth/google/start"><span class="g" aria-hidden="true">${GOOGLE_G_SVG}</span>Continue with Google</a><p class="note">Invite only. Use the Google account that was invited.</p></main></html>`;
  return new Response(html, { status: 200, headers });
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (request.method === 'GET' && pathname === '/health') return reply(200, { status: 'ok', app: 'sermon-bank' });
  const origin = publicOrigin(env);
  if (!origin || new URL(request.url).origin !== origin || !env.DB) return reply(503, { error: 'service_not_configured' });
  try {
    if (request.method === 'GET' && pathname === '/signin') return signInPage();
    if ((request.method === 'GET' || request.method === 'HEAD') && pathname === FAVICON_PATH) return await serveFavicon(request, env);
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
    if (rest?.[1] === 'members' && !rest[2] && request.method === 'GET') {
      if (!can(access.role, 'invite')) return reply(403, { error: 'forbidden' });
      return await listMembers(env, workspaceId);
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
