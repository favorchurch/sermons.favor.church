/**
 * Static app shell served through the Worker. The `ASSETS` binding runs behind the
 * Worker (`run_worker_first`), so nothing under public/ is reachable except through
 * the routes below, and the caller checks the session before calling serveStatic.
 * The shell is static: no workspace, sermon or account data is ever embedded in it.
 */

const SHELL_PATH = '/';
const ASSET_PREFIX = '/assets/';

/** The only paths that may be answered from public/. Everything else is a 404. */
export function isStaticPath(pathname: string): boolean {
  if (pathname === SHELL_PATH) return true;
  return pathname.startsWith(ASSET_PREFIX) && pathname.length > ASSET_PREFIX.length &&
    !pathname.includes('//') && !pathname.split('/').some(part => part === '.' || part === '..');
}

const SHELL_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'"
].join('; ');

function notFound(): Response {
  return new Response(JSON.stringify({ error: 'not_found' }), {
    status: 404,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store, private', 'x-content-type-options': 'nosniff' }
  });
}

/** Serve one allowed static file with private caching and a strict CSP. Callers must have verified the session. */
export async function serveStatic(request: Request, env: Env): Promise<Response> {
  const binding = (env as { ASSETS?: Fetcher }).ASSETS;
  if (!binding) return new Response(JSON.stringify({ error: 'service_not_configured' }), {
    status: 503, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store, private' }
  });
  const found = await binding.fetch(request);
  if (found.status === 404) return notFound();
  const headers = new Headers(found.headers);
  // Revalidate on every load: the Worker re-checks the session each time, so a signed-out
  // browser can never be served the shell from its own cache without asking.
  headers.set('cache-control', 'private, no-cache');
  headers.set('content-security-policy', SHELL_CSP);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-frame-options', 'DENY');
  headers.set('vary', 'Cookie');
  return new Response(request.method === 'HEAD' ? null : found.body, { status: found.status, statusText: found.statusText, headers });
}
