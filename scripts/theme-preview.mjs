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

export function parseArgs(args) {
  const options = { port: 4181, signedOut: false, layout: 'a', empty: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') {
      const value = args[++i];
      if (!/^\d+$/.test(value || '') || Number(value) < 1 || Number(value) > 65535) throw new Error('--port must be an integer from 1 to 65535');
      options.port = Number(value);
    } else if (args[i] === '--layout') {
      const value = args[++i];
      if (!['a', 'c', 'original'].includes(value)) throw new Error('--layout must be a, c, or original');
      options.layout = value;
    } else if (args[i] === '--signed-out') options.signedOut = true;
    else if (args[i] === '--empty') options.empty = true;
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  return options;
}

export async function createPreviewServer(options = {}) {
  const settings = { port: 4181, signedOut: false, layout: 'a', empty: false, ...options };
  const db = new DatabaseMock();
  seedPreviewData(db, { empty: settings.empty, layout: settings.layout });
  const token = randomToken();
  db.execute('INSERT INTO auth_sessions(token_hash,account_id,expires_at) VALUES (?,?,?)', [await sha256(token), PREVIEW_OWNER.id, Math.floor(Date.now() / 1000) + 3600]);
  const origin = 'https://preview.example.test';
  const env = {
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
  };
  const server = createServer(async (incoming, outgoing) => {
    const port = server.address()?.port ?? settings.port;
    const expectedHost = incoming.headers.host;
    if (expectedHost !== `127.0.0.1:${port}` && expectedHost !== `localhost:${port}`) {
      outgoing.writeHead(421, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end('Misdirected Request');
      return;
    }
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === 'string' && !['host', 'content-length', 'origin', 'sec-fetch-site'].includes(name)) headers.set(name, value);
      }
      const cookies = (headers.get('cookie') || '').split(';').map(value => value.trim())
        .filter(value => value && !value.startsWith(`${SESSION_COOKIE}=`) && !value.startsWith('sb_layout='));
      if (!settings.signedOut) cookies.push(`${SESSION_COOKIE}=${token}`);
      cookies.push(`sb_layout=${settings.layout}`);
      headers.set('cookie', cookies.join('; '));
      if (incoming.method !== 'GET' && incoming.method !== 'HEAD') headers.set('origin', origin);
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const request = new Request(origin + incoming.url, { method: incoming.method, headers, body });
      const response = await handleRequest(request, env);
      const responseHeaders = Object.fromEntries(response.headers);
      delete responseHeaders['content-length'];
      outgoing.writeHead(response.status, { ...responseHeaders, 'x-content-type-options': 'nosniff' });
      outgoing.end(incoming.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end('Preview request failed');
    }
  });
  return { server, db };
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
