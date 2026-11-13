/** Reusable, auditable authorization and cookie rules. All app routes also check D1. */
export type Role = 'owner' | 'admin' | 'editor' | 'viewer';
export type Operation = 'read' | 'edit' | 'invite' | 'manage_admin' | 'consent' | 'export' | 'delete' | 'transfer';

export function isRole(value: unknown): value is Role {
  return value === 'owner' || value === 'admin' || value === 'editor' || value === 'viewer';
}

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function can(role: Role, operation: Operation): boolean {
  if (operation === 'read') return true;
  if (operation === 'edit') return role !== 'viewer';
  if (operation === 'invite') return role === 'owner' || role === 'admin';
  return role === 'owner';
}

export function canInvite(actor: Role, desired: unknown): desired is Role {
  return isRole(desired) && desired !== 'owner' && can(actor, 'invite') &&
    (actor === 'owner' || desired === 'editor' || desired === 'viewer');
}

export function canManageMember(actor: Role, existing: Role, next: Role | 'revoke'): boolean {
  if (existing === 'owner' || !can(actor, 'invite')) return false;
  if (actor === 'admin' && existing === 'admin') return false;
  if (next === 'revoke') return true;
  return canInvite(actor, next);
}

export function randomToken(bytes = 32): string {
  const random = crypto.getRandomValues(new Uint8Array(bytes));
  return base64url(random);
}

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function fromBase64url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length > 50000) throw new Error('invalid encoding');
  const encoded = text.replace(/-/g, '+').replace(/_/g, '/');
  const decoded = atob(encoded + '='.repeat((4 - encoded.length % 4) % 4));
  return Uint8Array.from(decoded, c => c.charCodeAt(0));
}

export async function sha256(text: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

export function constantTimeEqual(a: string, b: string): boolean {
  const aa = new TextEncoder().encode(a), bb = new TextEncoder().encode(b);
  let difference = aa.length ^ bb.length;
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) difference |= (aa[i] || 0) ^ (bb[i] || 0);
  return difference === 0;
}

export function getCookie(request: Request, name: string): string | null {
  let result: string | null = null;
  const header = request.headers.get('cookie') || '';
  if (header.length > 8192) return null;
  for (const item of header.split(';')) {
    const part = item.trim();
    const i = part.indexOf('=');
    if (i <= 0 || part.slice(0, i) !== name) continue;
    if (result !== null) return null; // duplicate cookie name => ambiguous request
    result = part.slice(i + 1);
  }
  return result;
}

export const SESSION_COOKIE = '__Host-sb_session';
export const FLOW_COOKIE = '__Secure-sb_flow';

export function sessionCookie(token: string, seconds = 60 * 60 * 24 * 7): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${seconds}; Secure; HttpOnly; SameSite=Lax`;
}
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}
export function flowCookie(token: string, seconds = 600): string {
  return `${FLOW_COOKIE}=${token}; Path=/auth/google/callback; Max-Age=${seconds}; Secure; HttpOnly; SameSite=Lax`;
}
export function clearFlowCookie(): string {
  return `${FLOW_COOKIE}=; Path=/auth/google/callback; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}

export function noStoreHeaders(): Headers {
  return new Headers({
    'cache-control': 'no-store, private',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'vary': 'Cookie'
  });
}
export function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: noStoreHeaders() });
}

export function publicOrigin(env: unknown): string | null {
  const val = readBinding(env, 'PUBLIC_ORIGIN');
  if (!val) return null;
  try {
    const url = new URL(val);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) return null;
    return url.origin;
  } catch { return null; }
}
export function readBinding(env: unknown, key: string): string | null {
  if (!env || typeof env !== 'object') return null;
  const value: unknown = Reflect.get(env, key);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function requiresSameOrigin(request: Request, origin: string): boolean {
  const header = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  return header === origin && (site === null || site === 'same-origin' || site === 'none');
}

export function parseEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return null;
  const length = request.headers.get('content-length');
  if (length && Number(length) > 8192) return null;
  try {
    const text = await request.text();
    if (text.length > 8192) return null;
    const result: unknown = JSON.parse(text);
    return result !== null && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : null;
  } catch { return null; }
}
