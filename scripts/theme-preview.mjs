#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleRequest } from '../src/auth/app.ts';
import { randomToken, sha256, SESSION_COOKIE } from '../src/auth/security.ts';
import { DatabaseMock } from '../tests/helpers/d1.mjs';
import { PREVIEW_OWNER, seedPreviewData } from './theme-preview-data.mjs';

const root = resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const mime = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

const LAYOUTS = ['a', 'c', 'original'];
const FIXTURES = ['default', 'empty', 'error', 'loading', 'no-workspace'];
const FIXTURE_COOKIE = 'sb_preview';
const LAYOUT_COOKIE = 'sb_layout';
/** The library list calls the Library view makes: GET /api/workspaces/<id>/sermons and /events. */
const LIBRARY_LIST = /^\/api\/workspaces\/[^/]+\/(?:sermons|events)\/?$/;

// The loading fixture holds the library list in the browser, never on the server: a script placed ahead of the app
// swaps fetch for one whose library list calls never settle. No server request stays open, so the page reaches load
// and network idle while the loading screen stays up. It is a same-origin file because the app CSP is script-src 'self'.
const LOADING_STUB_PATH = '/__preview/loading-stub.js';
const LOADING_STUB = `const libraryList = ${LIBRARY_LIST};
const realFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const request = input instanceof Request ? input : null;
  const url = new URL(request ? request.url : String(input), location.href);
  const method = (init?.method || request?.method || 'GET').toUpperCase();
  return method === 'GET' && libraryList.test(url.pathname) ? new Promise(() => {}) : realFetch(input, init);
};
`;

export function parseArgs(args) {
  const options = { port: 4181, signedOut: false, layout: 'a', empty: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') {
      const value = args[++i];
      if (!/^\d+$/.test(value || '') || Number(value) < 1 || Number(value) > 65535) throw new Error('--port must be an integer from 1 to 65535');
      options.port = Number(value);
    } else if (args[i] === '--layout') {
      const value = args[++i];
      if (!LAYOUTS.includes(value)) throw new Error('--layout must be a, c, or original');
      options.layout = value;
    } else if (args[i] === '--signed-out') options.signedOut = true;
    else if (args[i] === '--empty') options.empty = true;
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  return options;
}

function readCookie(header, name) {
  for (const part of (header || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

export async function createPreviewServer(options = {}) {
  const settings = { port: 4181, signedOut: false, layout: 'a', empty: false, ...options };
  const origin = 'https://preview.example.test';

  async function openFixture(store, layout) {
    const db = new DatabaseMock();
    seedPreviewData(db, { empty: store === 'empty', layout, noWorkspace: store === 'no-workspace' });
    const token = randomToken();
    db.execute('INSERT INTO auth_sessions(token_hash,account_id,expires_at) VALUES (?,?,?)', [await sha256(token), PREVIEW_OWNER.id, Math.floor(Date.now() / 1000) + 3600]);
    return { db, token };
  }

  // Each fixture that needs different data gets its own database, opened on first use.
  // The default one (empty with --empty) is the returned `db`.
  const defaultStore = settings.empty ? 'empty' : 'full';
  const primary = await openFixture(defaultStore, settings.layout);
  const stores = new Map([[defaultStore, primary]]);
  const fixtureFor = (name, layout) => {
    const store = name === 'empty' || name === 'no-workspace' ? name : defaultStore;
    if (!stores.has(store)) stores.set(store, openFixture(store, layout));
    return stores.get(store);
  };

  const env = db => ({
    DB: db, PUBLIC_ORIGIN: origin, GOOGLE_CLIENT_ID: 'preview-client.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'preview-only-secret',
    ASSETS: { async fetch(request) {
      const url = new URL(request.url);
      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const path = resolve(root, relative);
      if (!path.startsWith(root + sep) && path !== resolve(root, 'index.html')) return new Response(null, { status: 404 });
      try {
        const content = await readFile(path);
        return new Response(content, { headers: { 'content-type': mime[extname(path)] || 'application/octet-stream' } });
      } catch { return new Response(null, { status: 404 }); }
    } }
  });

  const plain = (outgoing, status, text) => outgoing.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(text);

  const server = createServer(async (incoming, outgoing) => {
    const port = server.address()?.port ?? settings.port;
    const expectedHost = incoming.headers.host;
    if (expectedHost !== `127.0.0.1:${port}` && expectedHost !== `localhost:${port}`) return plain(outgoing, 421, 'Misdirected Request');
    try {
      const url = new URL(incoming.url, 'http://preview.local');
      const queryFixture = url.searchParams.get('preview');
      const queryLayout = url.searchParams.get('preview_layout');
      if (queryFixture !== null && !FIXTURES.includes(queryFixture)) return plain(outgoing, 400, 'Unknown preview fixture');
      if (queryLayout !== null && !LAYOUTS.includes(queryLayout)) return plain(outgoing, 400, 'Unknown preview layout');
      const cookieFixture = readCookie(incoming.headers.cookie, FIXTURE_COOKIE);
      const cookieLayout = readCookie(incoming.headers.cookie, LAYOUT_COOKIE);
      const fixtureName = queryFixture ?? (FIXTURES.includes(cookieFixture) ? cookieFixture : 'default');
      const requested = queryLayout ?? (LAYOUTS.includes(cookieLayout) ? cookieLayout : settings.layout);
      const fixture = await fixtureFor(fixtureName, requested);
      // Only ?preview_layout writes the stored layout. A cookie never does: the browser may hold a stale one
      // (or none) after Settings saved a layout through PATCH /api/me, and the saved choice wins.
      if (queryLayout !== null) fixture.db.execute('UPDATE user_accounts SET layout_theme = ? WHERE id = ?', [queryLayout, PREVIEW_OWNER.id]);
      // Signed in, the app reads the saved layout, so the forwarded cookie matches it. Signed out, the cookie decides.
      const saved = fixture.db.query('SELECT layout_theme FROM user_accounts WHERE id = ?', [PREVIEW_OWNER.id])[0]?.layout_theme;
      const layout = settings.signedOut || !LAYOUTS.includes(saved) ? requested : saved;

      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === 'string' && !['host', 'content-length', 'origin', 'sec-fetch-site'].includes(name)) headers.set(name, value);
      }
      const cookies = (headers.get('cookie') || '').split(';').map(value => value.trim())
        .filter(value => value && !value.startsWith(`${SESSION_COOKIE}=`) && !value.startsWith(`${LAYOUT_COOKIE}=`));
      if (!settings.signedOut) cookies.push(`${SESSION_COOKIE}=${fixture.token}`);
      cookies.push(`${LAYOUT_COOKIE}=${layout}`);
      headers.set('cookie', cookies.join('; '));
      if (incoming.method !== 'GET' && incoming.method !== 'HEAD') headers.set('origin', origin);

      if (incoming.method === 'GET' && LIBRARY_LIST.test(url.pathname)) {
        if (fixtureName === 'error') return outgoing.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify({ error: 'preview_error' }));
      }

      if (incoming.method === 'GET' && url.pathname === LOADING_STUB_PATH) {
        return outgoing.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(LOADING_STUB);
      }

      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const request = new Request(origin + incoming.url, { method: incoming.method, headers, body });
      const response = await handleRequest(request, env(fixture.db));
      const responseHeaders = Object.fromEntries(response.headers);
      delete responseHeaders['content-length'];
      delete responseHeaders['set-cookie'];
      // The app's layout cookie is Secure, which a browser on local http can drop. Strip it so the saved layout survives a reload.
      const setCookies = response.headers.getSetCookie()
        .map(line => (line.startsWith(`${LAYOUT_COOKIE}=`) ? line.replace(/;\s*Secure\s*(?=;|$)/gi, '') : line));
      // Preview-only cookies skip Secure so every browser keeps them over local http.
      if (queryFixture !== null) setCookies.push(`${FIXTURE_COOKIE}=${queryFixture}; Path=/; SameSite=Lax; Max-Age=3600`);
      if (queryLayout !== null) setCookies.push(`${LAYOUT_COOKIE}=${queryLayout}; Path=/; SameSite=Lax; Max-Age=3600`);
      if (setCookies.length) responseHeaders['set-cookie'] = setCookies;
      let payload = Buffer.from(await response.arrayBuffer());
      if (fixtureName === 'loading' && (response.headers.get('content-type') || '').startsWith('text/html')) {
        payload = Buffer.from(payload.toString('utf8').replace('<head>', () => `<head><script src="${LOADING_STUB_PATH}"></script>`));
      }
      outgoing.writeHead(response.status, { ...responseHeaders, 'x-content-type-options': 'nosniff' });
      outgoing.end(incoming.method === 'HEAD' ? undefined : payload);
    } catch {
      if (!outgoing.headersSent) plain(outgoing, 500, 'Preview request failed');
      else outgoing.destroy();
    }
  });
  // The caller closes the returned `db`; the extra fixture databases close with the server.
  server.on('close', async () => { for (const [store, entry] of stores) if (store !== defaultStore) (await entry).db.close(); });
  return { server, db: primary.db };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const { server, db } = await createPreviewServer(options);
    server.on('close', () => db.close());
    server.listen(options.port, '127.0.0.1', () => console.log(`Theme preview at http://127.0.0.1:${options.port}/ (${options.signedOut ? 'signed out' : 'preview owner'}, layout ${options.layout}${options.empty ? ', empty' : ''})`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Unable to start theme preview');
    process.exitCode = 1;
  }
}
