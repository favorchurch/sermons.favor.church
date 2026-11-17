// UI shell tests: Worker gating of the static app, static asset hygiene, the pure client
// models, and the whole client app run under a tiny fake DOM against the real API handler.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import { handleRequest } from '../src/auth/app.ts';
import { sha256, SESSION_COOKIE } from '../src/auth/security.ts';
import { fixture, ids, origin } from './helpers/library-fixture.mjs';
import { contrast, hex, over, rule, variables } from './helpers/contrast.mjs';

const root = new URL('../', import.meta.url).pathname;
const publicDir = join(root, 'public');
const J = path => join(publicDir, 'assets/js', path);


// ---------------------------------------------------------------- minimal fake DOM

class FakeText {
  constructor(text) { this.nodeType = 3; this.text = text; this.parent = null; }
  get textContent() { return this.text; }
}
class FakeElement {
  constructor(doc, tag) {
    this.doc = doc; this.tag = tag; this.nodeType = 1; this.attrs = new Map(); this.children = [];
    this.parent = null; this.listeners = {}; this.open = false; this._value = undefined;
    this.style = { setProperty: (name, value) => { (this.styles ||= {})[name] = value; } };
  }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  hasAttribute(name) { return this.attrs.has(name); }
  removeAttribute(name) { this.attrs.delete(name); }
  hasClass(name) { return (this.attrs.get('class') || '').split(/\s+/).includes(name); }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  dispatch(type, event = {}) {
    const e = { type, target: this, preventDefault() {}, ...event };
    for (const handler of this.listeners[type] || []) handler(e);
  }
  adopt(node) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = this;
    return node;
  }
  append(...nodes) { for (const node of nodes) this.children.push(this.adopt(typeof node === 'string' ? new FakeText(node) : node)); }
  replaceChildren(...nodes) { for (const child of this.children) child.parent = null; this.children = []; this.append(...nodes); }
  remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
  get isConnected() { let node = this; while (node.parent) node = node.parent; return node === this.doc.body; }
  get textContent() { return this.children.map(child => child.textContent).join(''); }
  set textContent(text) { this.replaceChildren(String(text)); }
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.tag === 'textarea') return this.textContent;
    if (this.tag === 'select') {
      const options = all(this, e => e.tag === 'option');
      return (options.find(o => o.hasAttribute('selected')) || options[0])?.getAttribute('value') ?? '';
    }
    return this.getAttribute('value') ?? '';
  }
  set value(v) { this._value = String(v); }
  focus() { this.doc.activeElement = this; }
  showModal() { this.open = true; }
  close() { if (!this.open) return; this.open = false; this.dispatch('close'); }
  closest(selector) { for (let node = this; node && node.nodeType === 1; node = node.parent) if (matches(node, selector)) return node; return null; }
  querySelectorAll(selector) { return all(this, e => matches(e, selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
class FakeDocument {
  constructor() { this.body = new FakeElement(this, 'body'); this.activeElement = this.body; this.title = ''; }
  createElement(tag) { return new FakeElement(this, tag); }
  createTextNode(text) { return new FakeText(text); }
  make(tag) { return this.createElement(tag); }
}
function matchesCompound(el, compound) {
  let rest = compound.trim();
  const tag = /^[a-z][a-z0-9]*/i.exec(rest);
  if (tag) { if (el.tag !== tag[0].toLowerCase()) return false; rest = rest.slice(tag[0].length); }
  while (rest) {
    let m;
    if ((m = /^#([\w-]+)/.exec(rest))) { if (el.getAttribute('id') !== m[1]) return false; }
    else if ((m = /^\.([\w-]+)/.exec(rest))) { if (!el.hasClass(m[1])) return false; }
    else if ((m = /^\[([\w-]+)(?:="([^"]*)")?\]/.exec(rest))) { if (m[2] === undefined ? !el.hasAttribute(m[1]) : el.getAttribute(m[1]) !== m[2]) return false; }
    else if ((m = /^:not\((.+?\])\)/.exec(rest))) { if (matchesCompound(el, m[1])) return false; }
    else throw new Error('fake DOM cannot match selector part: ' + rest);
    rest = rest.slice(m[0].length);
  }
  return true;
}
const matches = (el, selector) => selector.split(/,\s*(?![^(]*\))/).some(part => matchesCompound(el, part));
function all(node, predicate) {
  const found = [];
  for (const child of node.children || []) {
    if (child.nodeType === 1 && predicate(child)) found.push(child);
    if (child.nodeType === 1) found.push(...all(child, predicate));
  }
  return found;
}
const one = (node, predicate) => {
  const found = all(node, predicate)[0];
  assert.ok(found, 'expected element not found');
  return found;
};
const textOf = node => node?.textContent ?? '';

// ---------------------------------------------------------------- Worker gating

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function withAssets(env) {
  const calls = [];
  env.ASSETS = {
    async fetch(request) {
      const url = new URL(request.url);
      calls.push(url.pathname);
      const file = join(publicDir, url.pathname === '/' ? 'index.html' : url.pathname);
      if (!file.startsWith(publicDir) || !existsSync(file) || statSync(file).isDirectory()) return new Response('not found', { status: 404 });
      return new Response(readFileSync(file), { status: 200, headers: { 'content-type': MIME[extname(file)] || 'application/octet-stream', etag: '"x"' } });
    }
  };
  return calls;
}

test('signed-out visitors get the sign-in page and the app shell is never fetched', async () => {
  const f = await fixture();
  try {
    const calls = withAssets(f.env);
    const res = await f.call('GET', '/', null);
    assert.equal(res.status, 200);
    assert.match(res.text, /Continue with Google/);
    assert.ok(!res.text.includes('/assets/'), 'sign-in page must not reference app assets');
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
    for (const path of ['/assets/js/main.js', '/assets/app.css']) {
      const asset = await f.call('GET', path, null);
      assert.equal(asset.status, 404);
      assert.deepEqual(asset.json, { error: 'not_found' });
      assert.ok(!asset.text.includes('import'));
    }
    assert.deepEqual(calls, []);
  } finally { f.db.close(); }
});

test('signed-in users get a static shell with no data in it and a strict CSP', async () => {
  const f = await fixture();
  try {
    const calls = withAssets(f.env);
    const res = await f.call('GET', '/', 'viewer');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.text, /<main id="main"/);
    assert.match(res.text, /\/assets\/js\/main\.js/);
    // Nothing from the database or the account may be embedded in the HTML.
    for (const secret of ['Alpha', 'Beta', 'Private', 'viewer@example.test', 'Harbor', ids.w1, ids.sermon1, f.tokens.viewer]) {
      assert.ok(!res.text.includes(secret), `shell leaks ${secret}`);
    }
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
    assert.equal(res.headers.get('cache-control'), 'private, no-cache');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('vary'), /Cookie/);
    const js = await f.call('GET', '/assets/js/main.js', 'viewer');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    assert.deepEqual(calls, ['/', '/assets/js/main.js']);
  } finally { f.db.close(); }
});

// ---------------------------------------------------------------- Sermon Bank icon

const ICON_FILES = { 'icon.svg': null, 'icon-32.png': 32, 'icon-180.png': 180, 'icon-192.png': 192, 'icon-512.png': 512 };
const pngSize = buffer => {
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'not a PNG');
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
};

test('icon assets are committed at the documented sizes, and the favicon has 16, 32 and 48 frames', () => {
  const svg = readFileSync(join(publicDir, 'assets/icon.svg'), 'utf8');
  assert.match(svg, /viewBox="0 0 32 32"/);
  assert.match(svg, /fill="#476b51"/);
  for (const [name, size] of Object.entries(ICON_FILES)) {
    if (size) assert.deepEqual(pngSize(readFileSync(join(publicDir, 'assets', name))), [size, size], name);
  }
  const ico = readFileSync(join(publicDir, 'favicon.ico'));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  const frames = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico[6 + i * 16] || 256);
  assert.deepEqual(frames, [16, 32, 48]);
  assert.match(readFileSync(join(publicDir, 'assets/icon-16.svg'), 'utf8'), /viewBox="0 0 16 16"/);
});

test('the app shell links the icons and every decorative use is hidden from assistive tech', () => {
  const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
  assert.ok(!html.includes('href="data:,"'), 'blank favicon placeholder is gone');
  assert.match(html, /<link rel="icon" href="\/assets\/icon\.svg"/);
  assert.match(html, /<link rel="icon" href="\/assets\/icon-32\.png"/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/assets\/icon-180\.png"/);
  for (const file of ['views/shell.js', 'views/states.js', 'views/calendar.js']) {
    const uses = readFileSync(J(file), 'utf8').split('\n').filter(line => line.includes('/assets/icon.svg'));
    assert.ok(uses.length >= 1, `${file} uses the icon`);
    for (const line of uses) assert.match(line, /alt: ''/, `${file} icon must be decorative`);
  }
});

test('no asterisk, sparkle or starburst glyph ships under public/', () => {
  const banned = /[✳✱✲✴✻✼❊❋✦✧❇]/u;
  const files = walk(publicDir).filter(path => /\.(html|css|js|svg|json|txt|webmanifest)$/.test(path));
  assert.ok(files.length > 10);
  for (const file of files) assert.ok(!banned.test(readFileSync(file, 'utf8')), `${file} contains a banned glyph`);
});

test('signed-out visitors get the icon inline and still cannot fetch any asset', async () => {
  const f = await fixture();
  try {
    const calls = withAssets(f.env);
    const page = await f.call('GET', '/', null);
    assert.equal(page.status, 200);
    assert.ok(!page.text.includes('/assets/'));
    const icon = page.text.match(/<link rel="icon" href="data:image\/svg\+xml,([^"]+)" type="image\/svg\+xml">/);
    assert.ok(icon, 'sign-in page inlines its favicon');
    assert.equal(decodeURIComponent(icon[1]), readFileSync(join(publicDir, 'assets/icon.svg'), 'utf8').trim());
    const touch = page.text.match(/<link rel="apple-touch-icon" href="data:image\/png;base64,([^"]+)">/);
    assert.ok(touch, 'sign-in page inlines its apple-touch-icon');
    assert.deepEqual(pngSize(Buffer.from(touch[1], 'base64')), [180, 180]);
    assert.match(page.headers.get('content-security-policy'), /img-src data:(;|$)/);
    assert.ok(!/img-src[^;]*(https?:|'self'|\*)/.test(page.headers.get('content-security-policy')));
    for (const path of ['/favicon.ico', ...Object.keys(ICON_FILES).map(name => `/assets/${name}`), '/assets/icon-16.svg']) {
      const res = await f.call('GET', path, null);
      assert.equal(res.status, 404, path);
      assert.deepEqual(res.json, { error: 'not_found' }, path);
    }
    assert.deepEqual(calls, [], 'signed-out requests never reach ASSETS');
  } finally { f.db.close(); }
});

test('signed-in users get the icon files with private caching', async () => {
  const f = await fixture();
  try {
    withAssets(f.env);
    for (const [name, type] of [['icon.svg', /image\/svg\+xml/], ['icon-32.png', /image\/png/], ['icon-180.png', /image\/png/]]) {
      const res = await f.call('GET', `/assets/${name}`, 'viewer');
      assert.equal(res.status, 200, name);
      assert.match(res.headers.get('content-type'), type);
      assert.equal(res.headers.get('cache-control'), 'private, no-cache');
    }
  } finally { f.db.close(); }
});

test('only the shell and /assets/* are reachable, nothing else in public/', async () => {
  const f = await fixture();
  try {
    const calls = withAssets(f.env);
    for (const path of ['/index.html', '/assets', '/assets/', '/assets//app.css', '/assets/js/..', '/robots.txt', '/signin/x']) {
      const res = await f.call('GET', path, 'owner');
      assert.equal(res.status, 404, path);
    }
    const traversal = await f.call('GET', '/assets/../index.html', 'owner');
    assert.equal(traversal.status, 404);
    const post = await f.call('POST', '/', 'owner', {});
    assert.notEqual(post.status, 200);
    assert.deepEqual(calls, [], 'ASSETS must not be asked for unrouted paths');
    const missing = await f.call('GET', '/assets/nope.js', 'owner');
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.json, { error: 'not_found' });
  } finally { f.db.close(); }
});

test('revoked and expired sessions fall back to the sign-in page, HEAD has no body', async () => {
  const f = await fixture();
  try {
    withAssets(f.env);
    const head = await handleRequest(new Request(origin + '/', { method: 'HEAD', headers: { cookie: SESSION_COOKIE + '=' + f.tokens.owner } }), f.env);
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    f.db.execute('UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ?', [await sha256(f.tokens.owner)]);
    const res = await f.call('GET', '/', 'owner');
    assert.match(res.text, /Continue with Google/);
    assert.equal((await f.call('GET', '/assets/app.css', 'owner')).status, 404);
  } finally { f.db.close(); }
});

test('a Worker without the ASSETS binding fails closed', async () => {
  const f = await fixture();
  try {
    const res = await f.call('GET', '/', 'owner');
    assert.equal(res.status, 503);
    assert.deepEqual(res.json, { error: 'service_not_configured' });
  } finally { f.db.close(); }
});

test('existing public routes are unchanged', async () => {
  const f = await fixture();
  try {
    withAssets(f.env);
    assert.equal((await f.call('GET', '/health', null)).status, 200);
    const welcome = await f.call('GET', '/welcome', null);
    assert.equal(welcome.status, 303);
    assert.equal(welcome.headers.get('location'), '/api/me');
    assert.match((await f.call('GET', '/signin', 'owner')).text, /Continue with Google/);
    assert.equal((await f.call('GET', '/nope', 'owner')).status, 404);
  } finally { f.db.close(); }
});

test('wrangler serves public/ through an ASSETS binding with the Worker running first', () => {
  const text = readFileSync(join(root, 'wrangler.jsonc'), 'utf8').split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  const config = JSON.parse(text);
  assert.deepEqual(config.assets, { directory: './public', binding: 'ASSETS', run_worker_first: true });
  assert.equal(config.env.staging.assets, undefined, 'staging inherits assets from the top level');
});

// ---------------------------------------------------------------- static asset hygiene

function walk(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}
const files = walk(publicDir);
const read = path => readFileSync(path, 'utf8');
const jsFiles = files.filter(file => file.endsWith('.js'));

test('public/ is static, self-contained and free of unsafe patterns', () => {
  assert.ok(files.some(file => file.endsWith('index.html')) && jsFiles.length > 5);
  for (const file of files) {
    const text = read(file);
    const rel = file.slice(publicDir.length);
    assert.ok(!/favor/i.test(text), `${rel} must not carry Favor branding`);
    if (file.endsWith('.js')) {
      assert.ok(!/\.(innerHTML|outerHTML)\b|insertAdjacentHTML|document\.write|\beval\(|new Function\(/.test(text), `${rel} uses an HTML or code injection sink`);
      assert.ok(!/setAttribute\(\s*['"]style['"]/.test(text), `${rel} sets a style attribute (blocked by CSP)`);
      for (const url of text.match(/https?:\/\/[^\s'"`)$]+/g) || []) {
        assert.equal(url, 'https://docs.google.com/document/d/', `${rel} references ${url}`);
      }
    } else {
      assert.ok(!/https?:\/\//.test(text.replace(/<!doctype[^>]*>/i, '').replace(' xmlns="http://www.w3.org/2000/svg"', '')), `${rel} references an external URL`);
    }
    if (file.endsWith('.css')) {
      assert.ok(!/@import|@font-face/.test(text), `${rel} loads fonts or imports`);
    }
  }
  const html = read(join(publicDir, 'index.html'));
  assert.match(html, /<html lang="en">/);
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1"/);
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), 'no inline script');
  assert.ok(!/\sstyle=|\son[a-z]+=/i.test(html), 'no inline style or event handler attributes');
  assert.match(html, /class="skip-link"/);
});

test('css honours reduced motion, shows focus, and stacks the table on phones', () => {
  const css = read(join(publicDir, 'assets/app.css'));
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /animation:\s*none\s*!important/);
  assert.match(reduced, /transition:\s*none\s*!important/);
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*3px/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.sermon-table td::before/);
  assert.ok(!/outline:\s*none/.test(css.replace(/main:focus[^}]*\}/, '').replace(/\.card-link:focus-visible[^}]*\}/, '')), 'focus outlines are never removed');
  for (const motion of ['shelfSway', 'riseIn', 'slowTurn']) assert.ok(css.includes('@keyframes ' + motion));
});

test('every module import resolves to a file inside public/assets/js', () => {
  for (const file of jsFiles) {
    for (const [, spec] of read(file).matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      assert.ok(existsSync(resolve(dirname(file), spec)), `${file} imports missing ${spec}`);
    }
  }
});

// ---------------------------------------------------------------- pure models

const { parseDay, formatDay, formatWhen, formatWhenShort, formatLongDay, indexingStatus, formatStamp } = await import(J('format.js'));
const cal = await import(J('calendar-model.js'));
const lib = await import(J('library-model.js'));
const { parseRoute, hrefFor } = await import(J('router.js'));
const { coverFor, PALETTES, MOTIFS } = await import(J('covers.js'));
const { canEdit } = await import(J('permissions.js'));
const { ApiError, describeError, createApi } = await import(J('api.js'));
const { wrapFocus } = await import(J('dom.js'));

const ev = (id, sermon, date, precision = 'exact', extra = {}) =>
  ({ id, sermon_id: sermon, preached_on: date, date_precision: precision, sermon_title: 'T' + sermon, sermon_archived: false, ...extra });

test('dates format from their parts and never shift', () => {
  assert.deepEqual(parseDay('2026-02-29'), null);
  assert.deepEqual(parseDay('2028-02-29'), { y: 2028, m: 2, d: 29 });
  assert.equal(parseDay('2026-1-5'), null);
  assert.equal(formatDay('2026-03-01'), 'Mar 1, 2026');
  assert.equal(formatDay('2025-12-31'), 'Dec 31, 2025');
  assert.equal(formatLongDay('2026-11-08'), 'Sun, November 8, 2026');
  assert.equal(formatWhen('2025-04-01', 'month'), 'April 2025 (month only)');
  assert.equal(formatWhen('2024-01-01', 'year'), '2024 (year only)');
  assert.equal(formatWhen(null, 'unknown'), 'Date unknown');
  assert.equal(formatWhenShort('2025-04-01', 'month'), 'April 2025');
  assert.equal(formatStamp('2026-10-04 09:30:00'), 'Oct 4, 2026');
  assert.deepEqual(indexingStatus('indexed'), { label: 'Indexed', tone: 'good' });
  assert.equal(indexingStatus('something_new').label, 'Unknown status');
});

test('month grid starts on Sunday and covers every day once', () => {
  const weeks = cal.monthGrid(2026, 11); // Nov 1 2026 is a Sunday
  assert.equal(weeks[0][0].date, '2026-11-01');
  assert.equal(weeks.flat().filter(Boolean).length, 30);
  assert.ok(weeks.every(week => week.length === 7));
  const feb = cal.monthGrid(2028, 2); // Feb 1 2028 is a Tuesday, leap year
  assert.deepEqual(feb[0].map(cell => cell && cell.day), [null, null, 1, 2, 3, 4, 5]);
  assert.equal(feb.flat().filter(Boolean).length, 29);
});

test('calendar buckets match the server rules: month-only and year-only events never sit on a day', () => {
  const events = [
    ev('1', 'a', '2025-04-06'), ev('2', 'b', '2025-04-06'), ev('3', 'a', '2025-04-01', 'month'),
    ev('4', 'a', '2025-01-01', 'year'), ev('5', 'c', '2025-04-13', 'needs_review'), ev('6', 'c', null, 'unknown'), ev('7', 'c', '2024-12-25')
  ];
  const index = cal.indexEvents(events);
  const april = cal.monthView(index, 2025, 4);
  assert.equal(april.count, 4);
  assert.deepEqual([...april.days.keys()], ['2025-04-06', '2025-04-13']);
  assert.equal(april.days.has('2025-04-01'), false, 'a month-precision event stored on day 1 is not a day marker');
  assert.equal(april.monthOnly.length, 1);
  assert.equal(cal.monthView(index, 2025, 1).count, 0, 'a year-only event is not in January');
  const year = cal.yearView(index, 2025);
  assert.equal(year.months[3].count, 4);
  assert.equal(year.months[3].level, 1);
  assert.equal(year.months[0].level, 0);
  assert.equal(year.yearOnly.length, 1);
  assert.equal(year.total, 5);
  assert.equal(index.undated.length, 1);
  assert.equal(cal.defaultDay(april), '2025-04-13');
  assert.equal(cal.defaultDay(cal.monthView(index, 2025, 6)), null);
});

test('month arrows cross years and stop at the supported range', () => {
  assert.deepEqual(cal.shiftMonth(2026, 1, -1), { y: 2025, m: 12 });
  assert.deepEqual(cal.shiftMonth(2026, 12, 1), { y: 2027, m: 1 });
  assert.deepEqual(cal.shiftMonth(2026, 3, 11), { y: 2027, m: 2 });
  assert.deepEqual(cal.shiftMonth(1900, 1, -1), { y: 1900, m: 1 });
  assert.deepEqual(cal.shiftMonth(2100, 12, 1), { y: 2100, m: 12 });
});

test('calendar opens where the history is', () => {
  const index = cal.indexEvents([ev('1', 'a', '2025-03-09'), ev('2', 'a', '2027-01-03'), ev('3', 'a', '2024-05-01', 'month')]);
  assert.deepEqual(cal.defaultPosition(index, '2026-11-13'), { y: 2025, m: 3 }, 'latest past event, ignoring the future one');
  assert.deepEqual(cal.defaultPosition(cal.indexEvents([ev('4', 'a', '2026-11-02')]), '2026-11-13'), { y: 2026, m: 11 });
  assert.deepEqual(cal.defaultPosition(cal.indexEvents([]), '2026-11-13'), { y: 2026, m: 11 });
});

test('library summary, filtering and sorting', () => {
  const sermons = [
    { id: 'a', title: 'Zeal', series_name: 'Fire', scripture_references: ['Acts 2:1'], tags: ['Spirit'], created_at: '2026-01-02 00:00:00', archived_at: null },
    { id: 'b', title: 'Élan', series_name: null, scripture_references: [], tags: [], created_at: '2026-03-01 00:00:00', archived_at: null },
    { id: 'c', title: 'Calm', series_name: null, scripture_references: ['Psalm 23'], tags: [], created_at: '2026-02-01 00:00:00', archived_at: '2026-04-01 00:00:00' },
    { id: 'd', title: 'Apple', series_name: null, scripture_references: [], tags: [], created_at: '2026-04-01 00:00:00', archived_at: null }
  ];
  const events = [ev('1', 'a', '2025-04-06'), ev('2', 'a', '2025-04-01', 'month'), ev('3', 'b', '2026-02-01', 'year'), ev('4', 'b', null, 'unknown')];
  const items = lib.summarise(sermons, events);
  assert.equal(items[0].preachCount, 2);
  assert.deepEqual(items[0].last, { date: '2025-04-06', precision: 'exact' });
  assert.equal(items[1].preachCount, 2);
  assert.deepEqual(items[1].last, { date: '2026-02-01', precision: 'year' });
  assert.equal(items[3].last, null);
  assert.deepEqual(lib.filterAndSort(items, { sort: 'recent' }).map(i => i.id), ['b', 'a', 'd']);
  assert.deepEqual(lib.filterAndSort(items, { sort: 'title' }).map(i => i.id), ['d', 'b', 'a']);
  assert.deepEqual(lib.filterAndSort(items, { sort: 'added' }).map(i => i.id), ['d', 'b', 'a']);
  assert.deepEqual(lib.filterAndSort(items, { archive: 'archived' }).map(i => i.id), ['c']);
  assert.deepEqual(lib.filterAndSort(items, { query: 'elan' }).map(i => i.id), ['b'], 'accent-insensitive');
  assert.deepEqual(lib.filterAndSort(items, { query: 'acts spirit' }).map(i => i.id), ['a'], 'every term must match');
  assert.deepEqual(lib.filterAndSort(items, { query: 'psalm' }).map(i => i.id), [], 'archived hidden from the active list');
  assert.deepEqual(lib.libraryTotals(items), { sermons: 3, archived: 1, preachings: 4, latest: { date: '2026-02-01', precision: 'year' } });
});

test('routes parse strictly and round-trip', () => {
  const id = ids.sermon1;
  assert.deepEqual(parseRoute(''), { name: 'library', view: 'covers' });
  assert.deepEqual(parseRoute('#/library/table'), { name: 'library', view: 'table' });
  assert.deepEqual(parseRoute('#/sermons/' + id.toUpperCase()), { name: 'sermon', id });
  assert.equal(parseRoute('#/sermons/nope').name, 'missing');
  assert.equal(parseRoute('#/sermons/' + id + '/x').name, 'missing');
  assert.equal(parseRoute('#/library/nope').name, 'missing');
  assert.equal(parseRoute('#/admin').name, 'missing');
  assert.deepEqual(parseRoute('#/library/calendar?y=2026&m=10'), { name: 'library', view: 'calendar', y: 2026, m: 10, d: null });
  assert.deepEqual(parseRoute('#/library/calendar?d=2026-10-04'), { name: 'library', view: 'calendar', y: 2026, m: 10, d: '2026-10-04' });
  assert.equal(parseRoute('#/library/calendar?y=2026&m=13').y, null);
  assert.equal(parseRoute('#/library/calendar?y=3000&m=1').y, null);
  assert.equal(parseRoute('#/library/calendar?d=2026-02-30').d, null);
  assert.equal(hrefFor({ name: 'library', view: 'calendar', y: 2026, m: 10, d: '2026-10-04' }), '#/library/calendar?y=2026&m=10&d=2026-10-04');
  assert.equal(hrefFor({ name: 'sermon', id }), '#/sermons/' + id);
});

test('cover art is deterministic and varied', () => {
  assert.deepEqual(coverFor({ id: ids.sermon1 }), coverFor({ id: ids.sermon1 }));
  const seen = new Set();
  for (let i = 0; i < 60; i++) {
    const cover = coverFor({ id: `c0000000-0000-4000-8000-${String(i).padStart(12, '0')}` });
    assert.ok(PALETTES.includes(cover.palette) && MOTIFS.includes(cover.motif));
    assert.ok(cover.height >= 76 && cover.height <= 100);
    seen.add(cover.palette + cover.motif);
  }
  assert.ok(seen.size > 10);
});

test('role gating mirrors the server and focus wraps inside dialogs', () => {
  assert.deepEqual(['owner', 'admin', 'editor', 'viewer', undefined, 'x'].map(canEdit), [true, true, true, false, false, false]);
  assert.equal(wrapFocus(2, 3, false), 0);
  assert.equal(wrapFocus(0, 3, true), 2);
  assert.equal(wrapFocus(-1, 3, true), 2, 'focus outside the dialog is pulled back in');
  assert.equal(wrapFocus(1, 3, false), null);
  assert.equal(wrapFocus(1, 3, true), null);
  assert.equal(wrapFocus(0, 0, false), 0);
});

test('error messages are fixed text and never echo the server', async () => {
  assert.match(describeError(new ApiError(401, 'unauthenticated')), /Sign in again/);
  assert.match(describeError(new ApiError(403, 'forbidden')), /permission/);
  assert.match(describeError(new ApiError(404, 'not_found')), /no longer exists/);
  assert.match(describeError(new ApiError(400, 'invalid_request', 'title')), /title/);
  assert.match(describeError(new ApiError(400, 'precision_mismatch', 'date_precision')), /precision/);
  assert.match(describeError(new ApiError(409, 'already_archived')), /already archived/);
  assert.match(describeError(new ApiError(503, 'temporarily_unavailable')), /our side/);
  assert.ok(!describeError(new ApiError(400, '<script>alert(1)</script>', '<b>x</b>')).includes('<'));
  const api = createApi({ fetchImpl: async () => { throw new TypeError('offline'); } });
  await assert.rejects(api.get('/x'), error => error instanceof ApiError && error.status === 0);
  const bad = createApi({ fetchImpl: async () => new Response('<html>', { status: 502 }) });
  await assert.rejects(bad.get('/x'), error => error.status === 502 && error.code === 'error');
});

// ---------------------------------------------------------------- app under a fake DOM, real API

const { createApp } = await import(J('app.js'));
const { createLibraryClient } = await import(J('data.js'));

/** An api object whose requests run through the real Worker handler as `actor`. */
function realApi(f, actor) {
  const fetchImpl = async (path, init) => handleRequest(new Request(origin + path, {
    method: init.method,
    headers: { ...init.headers, ...(actor ? { cookie: SESSION_COOKIE + '=' + f.tokens[actor] } : {}), ...(init.method === 'GET' ? {} : { origin }) },
    body: init.body
  }), f.env);
  return createApi({ fetchImpl });
}

async function mountApp(f, actor, { hash = '', api = realApi(f, actor), today = '2026-11-13' } = {}) {
  const document = new FakeDocument();
  globalThis.document = document;
  const dom = { document, root: document.make('main'), header: document.make('header'), announcer: document.make('div'), toast: document.make('div') };
  let current = hash;
  let app;
  app = createApp({
    api, root: dom.root, headerRoot: dom.header, announcer: dom.announcer, toastRoot: dom.toast,
    getHash: () => current, setHash: next => { current = next; app.render(); },
    storage: { get: () => null, set() {} }, today: () => today,
    navigate: url => { dom.navigated = url; }
  });
  dom.go = next => { current = next; app.render(); };
  dom.app = app;
  document.body.append(dom.root);
  await app.start();
  return dom;
}
const buttons = (node, label) => all(node, e => e.tag === 'button' && textOf(e).trim() === label);
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
async function until(check, message) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(message);
}

test('owner sees the library with covers, a New draft control and counts from the API', async () => {
  const f = await fixture();
  try {
    const dom = await mountApp(f, 'owner');
    assert.equal(dom.app.state.phase, 'ready');
    const cards = all(dom.root, e => e.hasClass('sermon-card'));
    assert.equal(cards.length, 1);
    assert.match(textOf(cards[0]), /Alpha Hope Sermon/);
    assert.match(textOf(cards[0]), /Last preached Mar 9, 2025/);
    assert.ok(all(cards[0], e => e.hasClass('bookcover')).length === 1);
    assert.equal(buttons(dom.root, 'New draft').length, 1);
    assert.match(textOf(dom.header), /My Sermons/);
    assert.match(textOf(dom.header), /Private Alpha/);
    assert.ok(!textOf(dom.root).includes('Beta Secret'), 'other workspace never appears');
  } finally { f.db.close(); }
});

test('Quick rows and Table views list the same sermons with working links', async () => {
  const f = await fixture();
  try {
    const dom = await mountApp(f, 'owner', { hash: '#/library/rows' });
    const rows = all(dom.root, e => e.hasClass('quick-row'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].getAttribute('href'), '#/sermons/' + ids.sermon1);
    dom.go('#/library/table');
    const table = all(dom.root, e => e.tag === 'table');
    assert.equal(table.length, 1);
    assert.ok(all(table[0], e => e.tag === 'td' && e.getAttribute('data-label')).length >= 6, 'cells carry labels for the phone layout');
    assert.match(textOf(table[0]), /Mar 9, 2025/);
  } finally { f.db.close(); }
});

test('search narrows results without rebuilding the toolbar, and empty results offer a way out', async () => {
  const f = await fixture();
  try {
    const dom = await mountApp(f, 'owner');
    const search = one(dom.root, e => e.getAttribute('id') === 'sermon-search');
    search.value = 'zzzz';
    search.dispatch('input', { target: search });
    assert.equal(all(dom.root, e => e.hasClass('sermon-card')).length, 0);
    assert.match(textOf(dom.root), /No sermons match your search/);
    assert.ok(one(dom.root, e => e.getAttribute('id') === 'sermon-search') === search, 'toolbar input is the same element, so it keeps focus');
    buttons(dom.root, 'Clear search')[0].dispatch('click');
    assert.equal(all(dom.root, e => e.hasClass('sermon-card')).length, 1);
    buttons(dom.root, 'Archived')[0].dispatch('click');
    assert.match(textOf(dom.root), /No archived sermons/);
  } finally { f.db.close(); }
});

test('Viewer sees no edit controls anywhere, and the server still refuses writes', async () => {
  const f = await fixture();
  try {
    const dom = await mountApp(f, 'viewer');
    assert.equal(buttons(dom.root, 'New draft').length, 0);
    assert.match(textOf(dom.root), /view-only access/i);
    dom.go('#/sermons/' + ids.sermon1);
    await settle();
    assert.match(textOf(dom.root), /Alpha Hope Sermon/);
    assert.match(textOf(dom.root), /View-only access/);
    for (const label of ['Edit', 'Log preaching', 'Archive', 'Restore']) assert.equal(buttons(dom.root, label).length, 0, label);
    assert.equal(all(dom.root, e => e.getAttribute('data-action')).length, 0);
    // The UI hiding the buttons is not the control: the API refuses the same writes.
    const client = createLibraryClient(realApi(f, 'viewer'), ids.w1);
    await assert.rejects(client.createSermon('Sneaky'), error => error.status === 403);
    await assert.rejects(client.archiveSermon(ids.sermon1), error => error.status === 403);
    assert.equal(f.db.query("SELECT COUNT(*) AS n FROM sermons WHERE title = 'Sneaky'")[0].n, 0);
  } finally { f.db.close(); }
});

test('editor creates a title-only draft through the dialog and lands on its record', async () => {
  const f = await fixture();
  try {
    const dom = await mountApp(f, 'editor');
    buttons(dom.root, 'New draft')[0].dispatch('click');
    const dialog = one(dom.document.body, e => e.tag === 'dialog');
    assert.ok(dialog.open, 'opened as a modal');
    assert.equal(one(dialog, e => e.getAttribute('id') === dialog.getAttribute('aria-labelledby')).tag, 'h2', 'dialog is labelled by its title');
    const title = one(dialog, e => e.getAttribute('name') === 'title');
    assert.equal(dom.document.activeElement, title, 'first field is focused');
    // Empty title: the API rejects it and the error is shown on the field, dialog stays open.
    one(dialog, e => e.tag === 'form').dispatch('submit');
    await until(() => title.getAttribute('aria-invalid') === 'true', 'the error is shown on the field');
    assert.ok(dialog.open);
    assert.match(textOf(dialog), /Check the title/);
    title.value = '  Grace in the Gaps  ';
    one(dialog, e => e.tag === 'form').dispatch('submit');
    await until(() => !dialog.open, 'dialog closed');
    const row = f.db.query("SELECT title, workspace_id FROM sermons WHERE title = 'Grace in the Gaps'")[0];
    assert.equal(row.workspace_id, ids.w1);
    await until(() => /Grace in the Gaps/.test(textOf(dom.root)), 'the new record is shown');
    assert.ok(buttons(dom.root, 'Edit').length === 1 && buttons(dom.root, 'Archive').length === 1);
    assert.equal(dom.document.activeElement.getAttribute('id'), 'sermon-title', 'focus lands on the new record heading');
  } finally { f.db.close(); }
});

test('editing saves metadata and surfaces server validation on the right field', async () => {
  const f = await fixture();
  try {
    const dom = await mountApp(f, 'editor', { hash: '#/sermons/' + ids.sermon1 });
    await settle();
    buttons(dom.root, 'Edit')[0].dispatch('click');
    const dialog = one(dom.document.body, e => e.tag === 'dialog');
    const field = name => one(dialog, e => e.getAttribute('name') === name);
    assert.equal(field('title').value, 'Alpha Hope Sermon');
    assert.equal(field('scripture_references').value, 'John 3:16');
    field('title').value = '';
    one(dialog, e => e.tag === 'form').dispatch('submit');
    await settle();
    assert.equal(field('title').getAttribute('aria-invalid'), 'true');
    field('title').value = 'Alpha Hope, Revised';
    field('series_name').value = 'Hope Series';
    field('scripture_references').value = 'John 3:16\n\nRomans 5:1-5\n';
    field('tags').value = 'hope, grace ,';
    one(dialog, e => e.tag === 'form').dispatch('submit');
    await settle(); await settle();
    const saved = await createLibraryClient(realApi(f, 'owner'), ids.w1).getSermon(ids.sermon1);
    assert.equal(saved.title, 'Alpha Hope, Revised');
    assert.equal(saved.series_name, 'Hope Series');
    assert.deepEqual(saved.scripture_references, ['John 3:16', 'Romans 5:1-5']);
    assert.deepEqual(saved.tags, ['hope', 'grace']);
    assert.match(textOf(dom.root), /Alpha Hope, Revised/, 'detail refreshes after save');
  } finally { f.db.close(); }
});

test('logging a repeat preaching honours date precision and adds a new place on the fly', async () => {
  const f = await fixture();
  try {
    const dom = await mountApp(f, 'editor', { hash: '#/sermons/' + ids.sermon1 });
    await settle();
    buttons(dom.root, 'Log preaching')[0].dispatch('click');
    const dialog = one(dom.document.body, e => e.tag === 'dialog');
    await settle();
    const field = name => one(dialog, e => e.getAttribute('name') === name);
    const submit = () => one(dialog, e => e.tag === 'form').dispatch('submit');
    await until(() => all(field('place_id'), e => e.tag === 'option').some(o => textOf(o) === 'Harbor Chapel'), 'existing places are offered');
    // Exact precision with no date: handled inline, nothing sent.
    submit();
    await settle();
    assert.match(textOf(dialog), /Enter a date/);
    assert.equal(f.db.query('SELECT COUNT(*) AS n FROM preaching_events WHERE sermon_id = ?', [ids.sermon1])[0].n, 1);
    field('date_precision').value = 'month';
    field('date_precision').dispatch('change');
    assert.ok(field('preached_on').parent.hasAttribute('hidden'), 'day input hidden for month precision');
    assert.ok(!field('preached_on_month').parent.hasAttribute('hidden'));
    field('preached_on_month').value = '2026-04';
    field('place_id').value = '__new__';
    field('place_id').dispatch('change');
    field('display_name').value = 'Riverside Hall';
    field('occasion').value = 'Easter';
    field('version_id').value = ids.version1;
    submit();
    await settle(); await settle(); await settle();
    assert.ok(!dialog.open);
    const events = f.db.query('SELECT preached_on, date_precision, occasion, version_id, place_id FROM preaching_events WHERE sermon_id = ? ORDER BY preached_on', [ids.sermon1]);
    assert.equal(events.length, 2);
    assert.deepEqual([events[1].preached_on, events[1].date_precision, events[1].occasion, events[1].version_id], ['2026-04-01', 'month', 'Easter', ids.version1]);
    const place = f.db.query("SELECT id, workspace_id FROM places WHERE display_name = 'Riverside Hall'")[0];
    assert.equal(place.workspace_id, ids.w1);
    assert.equal(events[1].place_id, place.id);
    assert.match(textOf(dom.root), /April 2026 \(month only\)/);
    assert.match(textOf(dom.root), /Riverside Hall/);
    // "Date unknown" sends a null date.
    buttons(dom.root, 'Log preaching')[0].dispatch('click');
    const second = all(dom.document.body, e => e.tag === 'dialog').at(-1);
    const sel = one(second, e => e.getAttribute('name') === 'date_precision');
    sel.value = 'unknown'; sel.dispatch('change');
    one(second, e => e.tag === 'form').dispatch('submit');
    await settle(); await settle(); await settle();
    assert.equal(f.db.query("SELECT COUNT(*) AS n FROM preaching_events WHERE sermon_id = ? AND date_precision = 'unknown' AND preached_on IS NULL", [ids.sermon1])[0].n, 1);
  } finally { f.db.close(); }
});

test('a failed preaching save keeps the newly created place, so the corrected retry completes', async () => {
  const f = await fixture();
  try {
    const dom = await mountApp(f, 'editor', { hash: '#/sermons/' + ids.sermon1 });
    await settle();
    buttons(dom.root, 'Log preaching')[0].dispatch('click');
    const dialog = one(dom.document.body, e => e.tag === 'dialog');
    await settle();
    const field = name => one(dialog, e => e.getAttribute('name') === name);
    const submit = () => one(dialog, e => e.tag === 'form').dispatch('submit');
    const placeCount = () => f.db.query("SELECT COUNT(*) AS n FROM places WHERE display_name = 'Lakeside Tent'")[0].n;
    const eventCount = () => f.db.query('SELECT COUNT(*) AS n FROM preaching_events WHERE sermon_id = ?', [ids.sermon1])[0].n;
    const before = eventCount();
    field('date_precision').value = 'year';
    field('date_precision').dispatch('change');
    field('preached_on_year').value = '19999';
    field('place_id').value = '__new__';
    field('place_id').dispatch('change');
    field('display_name').value = 'Lakeside Tent';
    submit();
    await settle(); await settle(); await settle();
    assert.ok(dialog.open, 'dialog stays open on the server error');
    assert.equal(eventCount(), before, 'the rejected event was not saved');
    assert.equal(placeCount(), 1, 'the place was created once');
    const created = f.db.query("SELECT id FROM places WHERE display_name = 'Lakeside Tent'")[0].id;
    assert.equal(field('place_id').value, created, 'the created place is now the selected one');
    assert.ok(field('display_name').parent.hasAttribute('hidden'), 'the new-place name input is hidden again');
    field('preached_on_year').value = '2019';
    submit();
    await settle(); await settle(); await settle();
    assert.ok(!dialog.open, 'the corrected retry completes');
    assert.equal(placeCount(), 1, 'the retry did not create the place again');
    const saved = f.db.query('SELECT place_id, preached_on, date_precision FROM preaching_events WHERE sermon_id = ? AND place_id = ?', [ids.sermon1, created]);
    assert.deepEqual(saved.map(e => [e.preached_on, e.date_precision]), [['2019-01-01', 'year']]);
  } finally { f.db.close(); }
});

test('archive and restore need confirmation, default focus to Cancel, and use the right API calls', async () => {
  const f = await fixture();
  try {
    const dom = await mountApp(f, 'admin', { hash: '#/sermons/' + ids.sermon1 });
    await settle();
    buttons(dom.root, 'Archive')[0].dispatch('click');
    const dialog = one(dom.document.body, e => e.tag === 'dialog');
    assert.match(textOf(dialog), /Archive “Alpha Hope Sermon”\?/);
    assert.equal(textOf(dom.document.activeElement), 'Cancel', 'the safe choice has focus');
    assert.equal(f.db.query('SELECT archived_at FROM sermons WHERE id = ?', [ids.sermon1])[0].archived_at, null, 'nothing happens before confirming');
    buttons(dialog, 'Cancel')[0].dispatch('click');
    assert.ok(!dialog.open);
    assert.equal(f.db.query('SELECT archived_at FROM sermons WHERE id = ?', [ids.sermon1])[0].archived_at, null);
    buttons(dom.root, 'Archive')[0].dispatch('click');
    const again = all(dom.document.body, e => e.tag === 'dialog').at(-1);
    one(again, e => e.tag === 'form').dispatch('submit');
    await settle(); await settle(); await settle();
    assert.notEqual(f.db.query('SELECT archived_at FROM sermons WHERE id = ?', [ids.sermon1])[0].archived_at, null);
    assert.match(textOf(dom.root), /Archived/);
    assert.equal(buttons(dom.root, 'Restore').length, 1);
    assert.equal(buttons(dom.root, 'Log preaching').length, 0, 'archived sermons cannot take new preachings from the UI');
    buttons(dom.root, 'Restore')[0].dispatch('click');
    one(all(dom.document.body, e => e.tag === 'dialog').at(-1), e => e.tag === 'form').dispatch('submit');
    await settle(); await settle(); await settle();
    assert.equal(f.db.query('SELECT archived_at FROM sermons WHERE id = ?', [ids.sermon1])[0].archived_at, null);
    assert.deepEqual(f.auditActions().slice(-2), ['sermon.archive', 'sermon.restore']);
  } finally { f.db.close(); }
});

test('a stale confirm reports the conflict instead of pretending it worked', async () => {
  const f = await fixture();
  try {
    const dom = await mountApp(f, 'owner', { hash: '#/sermons/' + ids.sermon1 });
    await settle();
    buttons(dom.root, 'Archive')[0].dispatch('click');
    const dialog = one(dom.document.body, e => e.tag === 'dialog');
    f.db.execute('UPDATE sermons SET archived_at = CURRENT_TIMESTAMP WHERE id = ?', [ids.sermon1]); // someone else archived it first
    one(dialog, e => e.tag === 'form').dispatch('submit');
    await settle();
    assert.ok(dialog.open, 'dialog stays open on failure');
    assert.match(textOf(dialog), /already archived/);
    assert.equal(one(dialog, e => e.tag === 'button' && textOf(e) === 'Archive sermon').hasAttribute('disabled'), false, 'can retry or cancel');
  } finally { f.db.close(); }
});

test('dialog Tab key wraps focus and Escape-style close restores focus to the opener', async () => {
  const f = await fixture();
  try {
    const dom = await mountApp(f, 'owner');
    const opener = buttons(dom.root, 'New draft')[0];
    opener.focus();
    opener.dispatch('click');
    const dialog = one(dom.document.body, e => e.tag === 'dialog');
    const focusables = all(dialog, e => ['button', 'input', 'select', 'textarea', 'a'].includes(e.tag) && !e.hasAttribute('disabled'));
    focusables.at(-1).focus();
    let prevented = false;
    dialog.dispatch('keydown', { key: 'Tab', shiftKey: false, preventDefault() { prevented = true; } });
    assert.ok(prevented);
    assert.equal(dom.document.activeElement, focusables[0], 'Tab from the last control returns to the first');
    prevented = false;
    dialog.dispatch('keydown', { key: 'Tab', shiftKey: true, preventDefault() { prevented = true; } });
    assert.equal(dom.document.activeElement, focusables.at(-1), 'Shift+Tab from the first control goes to the last');
    dialog.dispatch('keydown', { key: 'a', preventDefault() { assert.fail('only Tab is intercepted'); } });
    dialog.close();
    assert.equal(dom.document.activeElement, opener);
    assert.equal(all(dom.document.body, e => e.tag === 'dialog').length, 0);
  } finally { f.db.close(); }
});

test('calendar: year overview, month grid, selected-day inspector, arrows and links to the record', async () => {
  const f = await fixture();
  try {
    f.db.execute(`INSERT INTO preaching_events(id,workspace_id,sermon_id,place_id,preached_on,date_precision,occasion) VALUES
      ('f0000000-0000-4000-8000-0000000000a1',?,?,?,'2025-03-30','needs_review','Guest'),
      ('f0000000-0000-4000-8000-0000000000a2',?,?,NULL,'2025-03-01','month',NULL),
      ('f0000000-0000-4000-8000-0000000000a3',?,?,NULL,'2025-01-01','year',NULL),
      ('f0000000-0000-4000-8000-0000000000a4',?,?,NULL,NULL,'unknown',NULL)`,
    [ids.w1, ids.sermon1, ids.place1, ids.w1, ids.sermon1, ids.w1, ids.sermon1, ids.w1, ids.sermon1]);
    const dom = await mountApp(f, 'owner', { hash: '#/library/calendar' });
    const text = () => textOf(dom.root);
    assert.match(text(), /March 2025/, 'opens on the latest past month with history');
    const months = all(dom.root, e => e.hasClass('mosaic-month'));
    assert.equal(months.length, 12);
    assert.match(months[2].getAttribute('aria-label'), /March 2025, 3 preachings/);
    assert.equal(months[2].getAttribute('aria-current'), 'true');
    assert.match(months[0].getAttribute('aria-label'), /January 2025, 0 preachings/, 'the year-only event is not counted in January');
    const marked = all(dom.root, e => e.hasClass('day-cell') && e.hasClass('has-event'));
    assert.deepEqual(marked.map(e => e.getAttribute('href')), ['#/library/calendar?y=2025&m=3&d=2025-03-09', '#/library/calendar?y=2025&m=3&d=2025-03-30']);
    assert.equal(marked[1].getAttribute('aria-current'), 'true', 'latest marked day is selected by default');
    assert.equal(all(marked[1], e => e.tag === 'i' && e.hasClass('marker-review')).length, 1, 'needs-review marker is distinct');
    const inspector = one(dom.root, e => e.tag === 'aside');
    assert.match(textOf(inspector), /Sun, March 30, 2025/);
    assert.match(textOf(inspector), /Date needs review/);
    dom.go(marked[0].getAttribute('href'));
    const inspected = one(dom.root, e => e.tag === 'aside');
    assert.match(textOf(inspected), /Sun, March 9, 2025/);
    const link = one(inspected, e => e.tag === 'a');
    assert.equal(link.getAttribute('href'), '#/sermons/' + ids.sermon1);
    // Without-a-day groups and undated note.
    assert.match(text(), /Recorded for March 2025 without a day/);
    assert.match(text(), /Recorded for 2025 without a month/);
    assert.match(text(), /1 preaching in this archive has no date/);
    // Month arrows and year navigation are links.
    assert.equal(one(dom.root, e => e.getAttribute('data-focus-key') === 'prev-month').getAttribute('href'), '#/library/calendar?y=2025&m=2');
    assert.equal(one(dom.root, e => e.getAttribute('data-focus-key') === 'next-year').getAttribute('href'), '#/library/calendar?y=2026&m=3');
    dom.go('#/library/calendar?y=2026&m=1');
    assert.equal(one(dom.root, e => e.getAttribute('data-focus-key') === 'prev-month').getAttribute('href'), '#/library/calendar?y=2025&m=12');
    assert.match(textOf(dom.root), /Nothing recorded for January 2026/);
    // Today is marked when visible.
    dom.go('#/library/calendar?y=2026&m=11');
    assert.equal(all(dom.root, e => e.hasClass('is-today')).length, 1);
  } finally { f.db.close(); }
});

test('calendar controls keep keyboard focus when the view re-renders', async () => {
  const f = await fixture();
  try {
    const dom = await mountApp(f, 'owner', { hash: '#/library/calendar?y=2025&m=3' });
    const next = one(dom.root, e => e.getAttribute('data-focus-key') === 'next-month');
    next.focus();
    dom.go(next.getAttribute('href'));
    assert.equal(dom.document.activeElement.getAttribute('data-focus-key'), 'next-month');
    assert.match(textOf(dom.root), /April 2025/);
  } finally { f.db.close(); }
});

test('empty, error, access-denied and signed-out states render with the right roles', async () => {
  const f = await fixture();
  try {
    f.db.execute('DELETE FROM preaching_events WHERE workspace_id = ?', [ids.w1]);
    f.db.execute('DELETE FROM sermon_versions WHERE workspace_id = ?', [ids.w1]);
    f.db.execute('DELETE FROM sermon_scripture_refs WHERE workspace_id = ?', [ids.w1]);
    f.db.execute('DELETE FROM sermons WHERE workspace_id = ?', [ids.w1]);
    const empty = await mountApp(f, 'owner');
    assert.match(textOf(empty.root), /first sermon/);
    assert.equal(one(empty.root, e => e.hasClass('state')).getAttribute('role'), 'status');
    assert.equal(buttons(empty.root, 'New draft').length >= 1, true);
    const emptyViewer = await mountApp(f, 'viewer');
    assert.match(textOf(emptyViewer.root), /Editors and owners can add sermons/);
    assert.equal(buttons(emptyViewer.root, 'New draft').length, 0);

    const base = realApi(f, 'owner');
    const failing = status => ({ ...base, get: async path => { if (path.includes('/sermons')) throw new ApiError(status, 'x'); return base.get(path); } });
    const denied = await mountApp(f, 'owner', { api: failing(404) });
    assert.equal(denied.app.state.phase, 'denied');
    assert.match(textOf(denied.root), /don’t have access to this archive/);
    assert.equal(one(denied.root, e => e.hasClass('state')).getAttribute('role'), 'alert');

    const broken = await mountApp(f, 'owner', { api: failing(503) });
    assert.equal(broken.app.state.phase, 'error');
    assert.equal(one(broken.root, e => e.hasClass('state')).getAttribute('role'), 'alert');
    assert.match(textOf(broken.root), /could not be loaded/);
    const retry = buttons(broken.root, 'Try again');
    assert.equal(retry.length, 1);

    const out = await mountApp(f, null);
    assert.equal(out.app.state.phase, 'signedout');
    assert.match(textOf(out.root), /Your session has ended/);
    assert.equal(one(out.root, e => e.tag === 'a' && e.getAttribute('href') === '/').tag, 'a');

    const lost = await mountApp(f, 'outsider');
    assert.equal(lost.app.state.phase, 'no-workspace');
    assert.match(textOf(lost.root), /don’t have an archive yet/);
  } finally { f.db.close(); }
});

test('loading shows a polite status while data is in flight', async () => {
  const f = await fixture();
  try {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const base = realApi(f, 'owner');
    const slow = { ...base, get: async path => { if (path.includes('/sermons')) await gate; return base.get(path); } };
    const document = new FakeDocument();
    globalThis.document = document;
    const root = document.make('main');
    document.body.append(root);
    const app = createApp({ api: slow, root, headerRoot: document.make('header'), announcer: document.make('div'), toastRoot: document.make('div'),
      getHash: () => '', setHash() {}, storage: { get: () => null, set() {} }, today: () => '2026-11-13', navigate() {} });
    const started = app.start();
    await settle();
    const loading = one(root, e => e.hasClass('state-loading'));
    assert.equal(loading.getAttribute('role'), 'status');
    assert.equal(loading.getAttribute('aria-busy'), 'true');
    release();
    await started;
    assert.equal(all(root, e => e.hasClass('state-loading')).length, 0);
    assert.equal(all(root, e => e.hasClass('sermon-card')).length, 1);
  } finally { f.db.close(); }
});

test('unknown sermon ids and bad routes show a not-found state, not a crash', async () => {
  const f = await fixture();
  try {
    const dom = await mountApp(f, 'owner', { hash: '#/sermons/' + ids.sermon2 }); // belongs to the other workspace
    await until(() => /Sermon not found/.test(textOf(dom.root)), 'not-found state');
    assert.ok(!textOf(dom.root).includes('Beta Secret'));
    dom.go('#/nowhere');
    assert.match(textOf(dom.root), /That page doesn’t exist/);
  } finally { f.db.close(); }
});

test('data client pages through more than one page of sermons and events', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 130; i++) {
      f.db.execute('INSERT INTO sermons(id,workspace_id,title) VALUES (?,?,?)', [`c1000000-0000-4000-8000-${String(i).padStart(12, '0')}`, ids.w1, 'Bulk ' + i]);
    }
    const lib = await createLibraryClient(realApi(f, 'viewer'), ids.w1).loadLibrary();
    assert.equal(lib.sermons.length, 131);
    assert.equal(new Set(lib.sermons.map(s => s.id)).size, 131);
    assert.equal(lib.events.length, 1);
  } finally { f.db.close(); }
});

test('text from the API is rendered as text, never as markup', async () => {
  const f = await fixture();
  try {
    const nasty = '<img src=x onerror=alert(1)>';
    f.db.execute('UPDATE sermons SET title = ?, series_name = ? WHERE id = ?', [nasty, nasty, ids.sermon1]);
    const dom = await mountApp(f, 'owner');
    const card = one(dom.root, e => e.hasClass('sermon-card'));
    assert.ok(textOf(card).includes(nasty));
    assert.equal(all(dom.root, e => e.tag === 'img').length, 0);
    dom.go('#/sermons/' + ids.sermon1);
    await settle();
    assert.equal(all(dom.root, e => e.tag === 'img').length, 0);
    assert.ok(textOf(dom.root).includes(nasty));
  } finally { f.db.close(); }
});

test('sign out posts to the logout route and returns to the sign-in page', async () => {
  const f = await fixture();
  try {
    const dom = await mountApp(f, 'owner');
    buttons(dom.header, 'Sign out')[0].dispatch('click');
    await settle(); await settle();
    assert.equal(dom.navigated, '/');
    assert.equal(f.db.query('SELECT COUNT(*) AS n FROM auth_sessions WHERE revoked_at IS NOT NULL')[0].n, 1);
  } finally { f.db.close(); }
});

test('a slow load for the previous archive cannot overwrite the archive you switched to', async () => {
  const f = await fixture();
  try {
    f.db.execute("INSERT INTO workspace_memberships(workspace_id,account_id,role,accepted_at) VALUES (?,?,'viewer',CURRENT_TIMESTAMP)", [ids.w2, ids.editor]);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const base = realApi(f, 'editor');
    const slow = { ...base, get: async path => { if (path.startsWith(`/api/workspaces/${ids.w1}/sermons`)) await gate; return base.get(path); } };
    const document = new FakeDocument();
    globalThis.document = document;
    const root = document.make('main'), headerRoot = document.make('header');
    document.body.append(root);
    const app = createApp({ api: slow, root, headerRoot, announcer: document.make('div'), toastRoot: document.make('div'),
      getHash: () => '', setHash() {}, storage: { get: () => ids.w1, set() {} }, today: () => '2026-11-13', navigate() {} });
    const started = app.start();
    await until(() => buttons(headerRoot, 'Switch archive ▾').length === 1, 'header offers both archives');
    one(headerRoot, e => e.tag === 'button' && textOf(e).startsWith('Private Beta')).dispatch('click');
    await until(() => app.state.phase === 'ready' && app.state.workspaceId === ids.w2, 'second archive loaded');
    release();
    await started;
    await settle();
    assert.equal(app.state.workspaceId, ids.w2);
    assert.deepEqual(app.state.items.map(item => item.title), ['Beta Secret Sermon']);
    assert.ok(!textOf(root).includes('Alpha'), 'the first archive must not appear under the second');
    assert.match(textOf(root), /Beta Secret Sermon/);
  } finally { f.db.close(); }
});

test('a bad date is reported on the input that is visible for the chosen precision', async () => {
  const f = await fixture();
  try {
    const dom = await mountApp(f, 'editor', { hash: '#/sermons/' + ids.sermon1 });
    await settle();
    buttons(dom.root, 'Log preaching')[0].dispatch('click');
    const dialog = one(dom.document.body, e => e.tag === 'dialog');
    const field = name => one(dialog, e => e.getAttribute('name') === name);
    field('date_precision').value = 'year';
    field('date_precision').dispatch('change');
    field('preached_on_year').value = '20';
    one(dialog, e => e.tag === 'form').dispatch('submit');
    await until(() => field('preached_on_year').getAttribute('aria-invalid') === 'true', 'error shown on the year input');
    assert.equal(field('preached_on').getAttribute('aria-invalid'), null, 'hidden day input is not the one flagged');
    assert.equal(dom.document.activeElement, field('preached_on_year'));
    assert.match(textOf(dialog), /Check the date/);
    assert.ok(dialog.open);
    assert.equal(f.db.query('SELECT COUNT(*) AS n FROM preaching_events WHERE sermon_id = ?', [ids.sermon1])[0].n, 1);
  } finally { f.db.close(); }
});

// ---------------------------------------------------------------- browser QA regressions (docs/qa/issue-2-browser-a11y.md)

const headings = node => all(node, e => /^h[1-6]$/.test(e.tag)).map(e => ({ level: Number(e.tag[1]), text: textOf(e).trim(), id: e.getAttribute('id') }));
function assertHeadingOutline(root, where) {
  const list = headings(root);
  assert.equal(list.filter(item => item.level === 1).length, 1, `${where}: exactly one h1 (${JSON.stringify(list)})`);
  assert.equal(list[0].level, 1, `${where}: the h1 comes first`);
  list.forEach((item, i) => assert.ok(i === 0 || item.level <= list[i - 1].level + 1, `${where}: "${item.text}" skips from h${list[i - 1]?.level} to h${item.level}`));
}

test('QA1/QA2: every library view and the sermon page have one h1 and never skip a heading level', async () => {
  const f = await fixture();
  try {
    for (const hash of ['#/library/covers', '#/library/rows', '#/library/table', '#/library/calendar?y=2025&m=3&d=2025-03-09', '#/library/calendar?y=2025&m=3', '#/sermons/' + ids.sermon1]) {
      const dom = await mountApp(f, 'owner', { hash });
      await settle();
      assertHeadingOutline(dom.root, hash);
    }
    // The calendar's h1 is the page heading that route changes focus.
    const dom = await mountApp(f, 'owner', { hash: '#/library/covers' });
    dom.go('#/library/calendar?y=2025&m=3');
    const title = one(dom.root, e => e.tag === 'h1');
    assert.equal(title.getAttribute('id'), 'page-title');
    assert.equal(title.getAttribute('tabindex'), '-1');
    assert.equal(dom.document.activeElement, title, 'arriving on the calendar moves focus to its heading');
  } finally { f.db.close(); }
});

test('QA3/QA4: calendar numbers, sermon tag chips and every cover palette meet WCAG AA text contrast', () => {
  const css = read(join(publicDir, 'assets/app.css'));
  const vars = variables(css);
  const colour = value => hex(value.replace(/var\((--[\w-]+)\)/, (_, name) => vars[name]));
  // Day numbers on a calendar day without events.
  const day = rule(css, '.day-cell');
  assert.ok(contrast(colour(day.color), colour(day.background)) >= 4.5, `day numbers: ${contrast(colour(day.color), colour(day.background)).toFixed(2)}`);
  const dayHasEvent = rule(css, '.day-cell.has-event');
  assert.ok(contrast(colour(dayHasEvent.color), colour(dayHasEvent.background)) >= 4.5);
  const chip = rule(css, '.chip');
  assert.ok(!('opacity' in rule(css, '.detail-head .eyebrow')), 'the eyebrow is not faded below AA');
  for (const palette of ['moss', 'linen', 'night', 'sage', 'clay', 'pine', 'paper']) {
    const { background, color } = rule(css, `.cover-${palette}`);
    const bg = hex(background);
    assert.ok(contrast(hex(color), bg) >= 4.5, `${palette} text: ${contrast(hex(color), bg).toFixed(2)}`);
    // Tag and passage chips sit on the sermon header whatever its palette.
    const chipBg = over(hex(chip.background), bg);
    assert.ok(contrast(hex(chip.color), chipBg) >= 4.5, `${palette} chip: ${contrast(hex(chip.color), chipBg).toFixed(2)}`);
  }
});

test('QA10: text inputs, selects and textareas have a 3:1 border on every surface they sit on', () => {
  const css = read(join(publicDir, 'assets/app.css'));
  const vars = variables(css);
  const edge = hex(vars['--control-edge']);
  for (const surface of ['--paper', '--panel', '--background']) {
    assert.ok(contrast(edge, hex(vars[surface])) >= 3, `${surface}: ${contrast(edge, hex(vars[surface])).toFixed(2)}`);
  }
  for (const selector of ['.search input, .sort select', '.header-search input', '.review-controls select', '.field input, .field select, .field textarea']) {
    const line = css.split('\n').find(l => l.startsWith(selector + ' {'));
    assert.ok(line, selector);
    assert.match(line, /border:\s*1px solid var\(--control-edge\)/, `${selector} uses the control edge colour`);
  }
});

test('QA5/QA8/QA9: phones get a static header, a shelf-free Rows and Table, and 24px targets', async () => {
  const css = read(join(publicDir, 'assets/app.css'));
  const phone = css.slice(css.indexOf('@media (max-width: 720px)'));
  assert.match(phone, /\.app-header\s*\{\s*position:\s*static;/, 'the header scrolls away on a phone instead of covering a quarter of the screen');
  assert.match(phone, /\.library-rows \.books-figure,\s*\.library-table \.books-figure\s*\{\s*display:\s*none;/);
  assert.match(css, /\.check input\s*\{\s*width:\s*24px;\s*height:\s*24px;/);
  assert.match(css, /\.event-item a\s*\{[^}]*min-height:\s*24px/);
  const f = await fixture();
  try {
    for (const view of ['covers', 'rows', 'table']) {
      const dom = await mountApp(f, 'owner', { hash: `#/library/${view}` });
      assert.ok(one(dom.root, e => e.hasClass('library')).hasClass(`library-${view}`), `${view} marks its page`);
    }
  } finally { f.db.close(); }
});

test('QA13: Quick rows and Table get a compact hero, a two-row phone header and a visible 24px+ Sign out', async () => {
  const css = read(join(publicDir, 'assets/app.css'));
  const phone = css.slice(css.lastIndexOf('@media (max-width: 720px)'), css.indexOf('@media (prefers-reduced-motion'));
  assert.match(phone, /\.hero-compact\s*\{[^}]*display:\s*block;[^}]*padding:\s*8px 0 4px/, 'compact hero has tight vertical padding');
  assert.match(phone, /\.hero-compact \.books-figure,\s*\.hero-compact \.eyebrow\s*\{\s*display:\s*none;/);
  assert.match(phone, /\.hero-compact h1\s*\{[^}]*font-size:\s*21px/);
  assert.doesNotMatch(phone, /\.hero-compact \.btn\s*\{[^}]*display:\s*none/, 'the hero actions stay reachable');
  assert.match(phone, /\.header-right\s*\{\s*display:\s*contents;/, 'Sign out joins the brand row');
  const signOut = /\.header-right > \.btn\s*\{[^}]*min-height:\s*(\d+)px/.exec(phone);
  assert.ok(signOut && Number(signOut[1]) >= 24, 'Sign out stays a 24px+ target');
  assert.doesNotMatch(phone, /\.who\s*\{[^}]*display:\s*inline/, 'the who label does not return on a phone');
  const f = await fixture();
  try {
    for (const actor of ['owner', 'viewer']) {
      for (const view of ['rows', 'table']) {
        const dom = await mountApp(f, actor, { hash: `#/library/${view}` });
        const hero = one(dom.root, e => e.hasClass('hero'));
        assert.ok(hero.hasClass('hero-compact'), `${view} hero is compact`);
        assert.equal(all(dom.root, e => e.tag === 'h1').length, 1, 'one h1 per page');
        assert.equal(all(hero, e => e.tag === 'h1').length, 1, 'the compact hero keeps the page title');
        assert.ok(all(hero, e => e.hasClass('hero-lede')).length === 1, 'and its stats line');
        assert.ok(all(hero, e => e.tag === 'a' && /Open the calendar/.test(e.textContent)).length === 1, 'calendar action stays in the hero');
        assert.equal(buttons(hero, 'New draft').length, actor === 'owner' ? 1 : 0);
      }
    }
    const covers = await mountApp(f, 'owner', { hash: '#/library/covers' });
    assert.ok(!one(covers.root, e => e.hasClass('hero')).hasClass('hero-compact'), 'Covers keeps the full hero');
    const signOutButtons = buttons(covers.header, 'Sign out');
    assert.equal(signOutButtons.length, 1, 'Sign out is a labelled control in the header');
  } finally { f.db.close(); }
});

test('QA7: after a saved dialog the page is re-rendered and focus returns to the control that opened it', async () => {
  const f = await fixture();
  try {
    const dom = await mountApp(f, 'editor', { hash: '#/sermons/' + ids.sermon1 });
    await settle();
    const opener = buttons(dom.root, 'Log preaching')[0];
    opener.focus();
    opener.dispatch('click');
    const dialog = one(dom.document.body, e => e.tag === 'dialog');
    await settle();
    const precision = one(dialog, e => e.getAttribute('name') === 'date_precision');
    precision.value = 'unknown'; precision.dispatch('change');
    one(dialog, e => e.tag === 'form').dispatch('submit');
    await settle(); await settle(); await settle();
    assert.ok(!dialog.open, 'saved');
    const active = dom.document.activeElement;
    assert.ok(active.isConnected, 'focus is on something still in the page, not on a removed button');
    assert.equal(textOf(active).trim(), 'Log preaching');
    assert.notEqual(active, opener, 'the re-rendered button, not the stale one');
  } finally { f.db.close(); }
});

test('QA7: restoring focus copes with ids that are not valid in a #selector, and falls back to the page heading', async () => {
  const { rememberFocus, restoreFocus } = await import(J('dom.js'));
  const document = new FakeDocument();
  globalThis.document = document;
  const main = document.make('main');
  document.body.append(main);
  const build = () => {
    const heading = document.make('h1'); heading.setAttribute('id', 'page-title');
    const odd = document.make('button'); odd.setAttribute('id', 'row:1.a'); odd.append('Open');
    const prefix = document.make('div'); prefix.setAttribute('id', 'row'); // `#row:1.a` would parse as id "row" plus junk
    main.replaceChildren(heading, prefix, odd);
    return { heading, odd };
  };
  const first = build();
  first.odd.focus();
  const saved = rememberFocus();
  assert.equal(saved.id, 'row:1.a');
  const second = build();
  assert.doesNotThrow(() => restoreFocus(main, saved));
  assert.equal(document.activeElement, second.odd, 'the re-rendered control with the same id');
  // Gone entirely: the heading gets focus instead of <body>.
  second.odd.focus();
  const gone = rememberFocus();
  main.replaceChildren(second.heading);
  restoreFocus(main, gone);
  assert.equal(document.activeElement, second.heading);
});

test('QA15: after a saved Settings dialog the section reloads and focus lands on the re-rendered button, not <body>', async () => {
  const f = await fixture();
  try {
    const dom = await mountApp(f, 'owner', { hash: '#/settings/places' });
    await settle(); await settle();
    const opener = buttons(dom.root, 'Rename')[0];
    assert.ok(opener, 'the place list has a Rename button');
    opener.focus();
    opener.dispatch('click');
    const dialog = one(dom.document.body, e => e.tag === 'dialog');
    await settle();
    one(dialog, e => e.getAttribute('name') === 'display_name').value = 'Harbor Chapel East';
    one(dialog, e => e.tag === 'form').dispatch('submit');
    await settle(); await settle(); await settle();
    assert.ok(!dialog.open, 'saved');
    assert.ok(textOf(dom.root).includes('Harbor Chapel East'), 'the list was reloaded');
    const active = dom.document.activeElement;
    assert.notEqual(active, dom.document.body, 'focus is not dropped on <body>');
    assert.ok(active.isConnected, 'focus is on something still in the page');
    assert.equal(textOf(active).trim(), 'Rename');
    assert.notEqual(active, opener, 'the re-rendered button, not the stale one');
  } finally { f.db.close(); }
});

test('QA15: focus restoration returns to the same one of several identical buttons, and to the last one if the list shrank', async () => {
  const { rememberFocus, restoreFocus } = await import(J('dom.js'));
  const document = new FakeDocument();
  globalThis.document = document;
  const main = document.make('main');
  document.body.append(main);
  const build = count => {
    const buttonsMade = Array.from({ length: count }, () => { const b = document.make('button'); b.append('Rename'); return b; });
    main.replaceChildren(...buttonsMade);
    return buttonsMade;
  };
  const first = build(3);
  first[1].focus();
  const saved = rememberFocus();
  assert.equal(saved.nth, 1);
  const second = build(3);
  restoreFocus(main, saved);
  assert.equal(document.activeElement, second[1], 'the second Rename, not the first');
  second[2].focus();
  const last = rememberFocus();
  const third = build(2);
  restoreFocus(main, last);
  assert.equal(document.activeElement, third[1], 'the list got shorter, so the last button gets focus');
});

test('QA15: a dialog whose opener was replaced while it was open still returns focus to the replacement on close', async () => {
  const { h, openDialog } = await import(J('dom.js'));
  const document = new FakeDocument();
  globalThis.document = document;
  const main = document.make('main');
  document.body.append(main);
  const makeButton = () => { const b = document.make('button'); b.append('Log preaching'); return b; };
  const opener = makeButton();
  main.append(opener);
  opener.focus();
  const { close, dialog } = openDialog({ title: 'Log a preaching', body: h('p', null, 'Body') });
  assert.ok(dialog.open);
  const replacement = makeButton();
  main.replaceChildren(replacement);
  document.activeElement = document.body; // the browser has nothing to give focus back to
  close();
  assert.equal(document.activeElement, replacement);
});
