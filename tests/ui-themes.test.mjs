import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contrast, hex } from './helpers/contrast.mjs';
import { fixture } from './helpers/library-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const themeDir = join(root, 'public/assets/themes');

function splitSelectors(prelude) {
  const result = [];
  let current = '', paren = 0, bracket = 0, quote = '';
  for (let i = 0; i < prelude.length; i++) {
    const ch = prelude[i];
    if (quote) {
      current += ch;
      if (ch === '\\' && i + 1 < prelude.length) { current += prelude[++i]; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '(') paren++;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket = Math.max(0, bracket - 1);
    else if (ch === ',' && paren === 0 && bracket === 0) {
      if (current.trim()) result.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

function findNext(css, start, end, chars) {
  let quote = '';
  for (let i = start; i < end; i++) {
    const ch = css[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (chars.includes(ch)) return i;
  }
  return -1;
}

function findMatchingBrace(css, open, end) {
  let depth = 1, quote = '';
  for (let i = open + 1; i < end; i++) {
    const ch = css[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseRules(source) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  function scan(start, end) {
    let cursor = start;
    while (cursor < end) {
      while (cursor < end && /\s/.test(css[cursor])) cursor++;
      if (cursor >= end) break;
      const hit = findNext(css, cursor, end, '{;');
      if (hit < 0) break;
      if (css[hit] === ';') {
        const stmt = css.slice(cursor, hit).trim();
        assert.match(stmt, /^@(?:charset|namespace|layer)\b/i, `disallowed statement at-rule: ${stmt}`);
        cursor = hit + 1;
        continue;
      }
      const prelude = css.slice(cursor, hit).trim();
      const close = findMatchingBrace(css, hit, end);
      assert.ok(close > hit, 'CSS blocks are balanced');
      if (prelude.startsWith('@')) {
        if (/^@(?:media|supports|layer|container|scope|starting-style)\b/i.test(prelude)) {
          scan(hit + 1, close);
        } else {
          assert.match(prelude, /^@(?:font-face|keyframes)\b/i, `unexpected at-rule in theme CSS: ${prelude}`);
        }
      } else {
        const body = css.slice(hit + 1, close);
        assert.equal(findNext(body, 0, body.length, '{'), -1, `nested CSS blocks are not allowed in theme CSS: ${prelude}`);
        const declarations = body.split(';').map(part => {
          const colon = part.indexOf(':');
          return colon < 0 ? null : [part.slice(0, colon).trim(), part.slice(colon + 1).trim()];
        }).filter(Boolean);
        rules.push({ selectors: splitSelectors(prelude), declarations });
      }
      cursor = close + 1;
    }
  }
  scan(0, css.length);
  return rules;
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  }))).flat();
}

const themeFiles = await filesUnder(themeDir);
const cssFiles = themeFiles.filter(path => path.endsWith('.css'));
const allRules = new Map();

for (const path of cssFiles) allRules.set(path, parseRules(await readFile(path, 'utf8')));

test('every theme selector is layout-scoped, text sizes meet the floor, and layout rules avoid clipping bugs', () => {
  assert.ok(cssFiles.length > 0);
  for (const [path, rules] of allRules) for (const { selectors, declarations } of rules) {
    for (const selector of selectors) {
      assert.match(selector, /^html\[data-layout="(?:a|c)"\](?:\s|$|[.#:[>+~])/,
        `${path.slice(root.length + 1)} selector is not scoped: ${selector}`);
      for (const [rawProp, value] of declarations) {
        const property = rawProp.toLowerCase();
        if (property === 'font-size') {
          const px = /^(\d+(?:\.\d+)?)px$/.exec(value);
          assert.ok(px, `${selector} font-size must be an explicit px value: ${value}`);
          const size = Number(px[1]);
          assert.ok(size >= 13 || (size >= 11 && selector.includes('.theme-tab-label')),
            `${selector} font-size ${value} is below the 13px floor (11px is allowed only for tab labels)`);
        } else if (property === 'font' && value.toLowerCase() !== 'inherit') {
          const px = /(\d+(?:\.\d+)?)px/.exec(value);
          assert.ok(px, `${selector} font shorthand must use explicit px or inherit: ${value}`);
          const size = Number(px[1]);
          assert.ok(size >= 13 || (size >= 11 && selector.includes('.theme-tab-label')),
            `${selector} font shorthand size ${px[0]} is below the 13px floor`);
        }
        if (selector.endsWith('.theme-layout-buttons') && property === 'overflow') {
          assert.notEqual(value.toLowerCase(), 'hidden', `${selector} must not clip button focus rings with overflow: hidden`);
        }
        if (selector.endsWith('.theme-rail') && property === 'overflow-y') {
          assert.notEqual(value.toLowerCase(), 'auto', `${selector} must not clip workspace menu with overflow-y: auto`);
        }
        if (selector.endsWith('.layout-options') && property === 'grid-template-columns' && value !== '1fr') {
          assert.match(value, /auto-fit/, `${selector} should wrap responsively with auto-fit instead of fixed columns: ${value}`);
        }
      }
    }
  }
});

test('theme text palettes meet WCAG AA contrast on their surfaces', () => {
  let checked = 0;
  for (const [path, rules] of allRules) {
    for (const rule of rules) {
      const palette = Object.fromEntries(rule.declarations.filter(([property]) => property.startsWith('--theme-')));
      if (!Object.keys(palette).length) continue;
      checked++;
      assert.ok(palette['--theme-text'], `${path}: palette block must declare --theme-text`);
      const ratio = (foreground, background) => contrast(hex(palette[foreground]), hex(palette[background]));
      assert.ok(ratio('--theme-text', '--theme-paper') >= 4.5, `${path}: text on paper`);
      assert.ok(ratio('--theme-text', '--theme-rail') >= 4.5, `${path}: text on rail`);
      assert.ok(ratio('--theme-text', '--theme-ground') >= 4.5, `${path}: text on ground`);
      assert.ok(ratio('--theme-muted', '--theme-paper') >= 4.5, `${path}: muted text on paper`);
      assert.ok(ratio('--theme-muted', '--theme-rail') >= 4.5, `${path}: muted text on rail`);
      assert.ok(ratio('--theme-muted', '--theme-ground') >= 4.5, `${path}: muted text on ground`);
      assert.ok(ratio('--theme-accent-strong', '--theme-paper') >= 4.5, `${path}: strong accent on paper`);
      assert.ok(ratio('--theme-accent-strong', '--theme-active') >= 4.5, `${path}: strong accent on active surface`);
      assert.ok(ratio('--theme-accent', '--theme-active') >= 4.5, `${path}: accent text on active surface`);
      assert.ok(ratio('--theme-accent-text', '--theme-accent') >= 4.5, `${path}: inverse text on accent`);
    }
  }
  assert.ok(checked > 0, 'at least one theme palette block must be checked');
});

test('theme views have plain copy, use workspace language, declare bundled fonts, and do not contain emoji or star glyphs', async () => {
  for (const path of [
    join(root, 'public/assets/js/layout.js'),
    join(root, 'public/assets/js/views/shell.js'),
    join(root, 'public/assets/js/views/settings-layout.js')
  ]) {
    const source = await readFile(path, 'utf8');
    assert.doesNotMatch(source, /\p{Extended_Pictographic}|[\u2605\u2606\u2736-\u273f]/u, path);
    assert.doesNotMatch(source, /archive/i, path);
  }
  const html = await readFile(join(root, 'public/index.html'), 'utf8');
  assert.match(html, /href="\/assets\/themes\/layout\.css"/);
  assert.doesNotMatch(html, /fonts\.css/);
  const layoutCss = (await readFile(join(themeDir, 'layout.css'), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  const fontFaces = [...layoutCss.matchAll(/@font-face\s*\{([^}]*)\}/gi)].map(m => m[1]);
  assert.ok(fontFaces.some(block => block.includes('/assets/fonts/inter-latin.woff2')), 'Inter @font-face declared');
  assert.ok(fontFaces.some(block => block.includes('/assets/fonts/plus-jakarta-sans-latin.woff2')), 'Plus Jakarta Sans @font-face declared');
  await access(join(root, 'public/assets/fonts/inter-latin.woff2'));
  await access(join(root, 'public/assets/fonts/plus-jakarta-sans-latin.woff2'));
});

class FakeText {
  constructor(text) { this.text = String(text); this.nodeType = 3; this.parent = null; }
  get textContent() { return this.text; }
}

class FakeElement {
  constructor(tag, doc) {
    this.tag = tag.toLowerCase();
    this.tagName = tag.toUpperCase();
    this.doc = doc;
    this.attrs = new Map();
    this.children = [];
    this.listeners = {};
    this.nodeType = 1;
    this.parent = null;
  }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  hasAttribute(name) { return this.attrs.has(name); }
  removeAttribute(name) { this.attrs.delete(name); }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  dispatch(type, event = {}) {
    if (type === 'click' && this.hasAttribute('disabled')) return null;
    const ev = { target: this, prevented: false, preventDefault() { this.prevented = true; }, ...event };
    for (const handler of this.listeners[type] || []) handler(ev);
    return ev;
  }
  focus() {
    if (this.hasAttribute('disabled')) return;
    this.doc.activeElement = this;
  }
  closest(sel) {
    let cur = this;
    while (cur) {
      if (cur.tag === sel) return cur;
      cur = cur.parent;
    }
    return null;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    return findAll(this, node => {
      if (selector.startsWith('#')) return node.getAttribute('id') === selector.slice(1);
      if (selector.startsWith('.')) return (node.getAttribute('class') || '').split(/\s+/).includes(selector.slice(1));
      const attr = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
      if (attr) return attr[2] === undefined ? node.hasAttribute(attr[1]) : node.getAttribute(attr[1]) === attr[2];
      return node.tag === selector.toLowerCase();
    });
  }
  get isConnected() {
    let cur = this;
    while (cur.parent) cur = cur.parent;
    return cur === this.doc.documentElement || cur === this.doc.body;
  }
  get textContent() { return this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.children = [new FakeText(value)]; }
}

function installFakeDom() {
  const doc = {
    title: '',
    activeElement: null,
    createElement(tag) { return new FakeElement(tag, doc); },
    createTextNode(text) { return new FakeText(text); }
  };
  doc.documentElement = new FakeElement('html', doc);
  doc.body = new FakeElement('body', doc);
  doc.documentElement.append(doc.body);
  doc.activeElement = doc.body;
  globalThis.document = doc;
  return doc;
}

function findAll(node, predicate) {
  return node.children.flatMap(child => child.nodeType === 1 ? [...(predicate(child) ? [child] : []), ...findAll(child, predicate)] : []);
}

function findOne(node, predicate, message = 'expected element') {
  const matches = findAll(node, predicate);
  assert.ok(matches.length >= 1, message);
  return matches[0];
}

const settle = () => new Promise(resolve => setTimeout(resolve, 25));

test('shell renders A, C and Original with exact containers, workspace menu, Escape close, book mark, and auth gating', async () => {
  const doc = installFakeDom();
  try {
    const { header } = await import('../public/assets/js/views/shell.js');
    const stateFor = layout => ({
      phase: 'ready',
      layout,
      account: { display_name: 'Rico Santos', email_normalized: 'rico@example.test' },
      workspaces: [
        { id: 'one', name: 'Sermon workspace', role: 'owner' },
        { id: 'two', name: 'Team workspace', role: 'editor' }
      ],
      workspaceId: 'one'
    });
    for (const layout of ['a', 'c', 'original']) {
      let switched = null, opened = false;
      const selected = [];
      const state = stateFor(layout);
      const shell = header({
        state, route: { name: 'library' },
        switchWorkspace: id => { switched = id; },
        newWorkspace: () => { opened = true; },
        signOut() {}, search() {},
        changeLayout: value => { selected.push(value); }
      });
      if (layout === 'a') {
        assert.equal(shell.tag, 'aside');
        assert.ok((shell.getAttribute('class') || '').includes('theme-rail'));
      } else if (layout === 'c') {
        assert.equal(shell.tag, 'div');
        assert.ok((shell.getAttribute('class') || '').includes('theme-topbar'));
      } else {
        assert.equal(shell.getAttribute('class'), 'header-inner');
        assert.equal(findAll(shell, node => (node.getAttribute('class') || '').includes('theme-shell')).length, 0);
        assert.equal(findAll(shell, node => node.getAttribute('aria-label') === 'Quick layout switch').length, 0);
      }
      const text = shell.textContent;
      for (const label of ['Library', 'Search', 'Settings', 'Sermon workspace', 'New workspace', 'Rico Santos', 'Sign out']) {
        assert.ok(text.includes(label), `${layout} includes ${label}`);
      }
      const mark = findOne(shell, node => node.tag === 'img' && node.getAttribute('src') === '/assets/icon.svg', `${layout} book mark`);
      assert.ok(mark);
      const toggle = findOne(shell, node => node.getAttribute('aria-controls') !== null);
      const menu = findOne(shell, node => node.getAttribute('id') === toggle.getAttribute('aria-controls'));
      const switcher = toggle.parent;
      assert.equal(toggle.getAttribute('aria-expanded'), 'false');
      doc.activeElement = doc.body;
      switcher.dispatch('keydown', { key: 'Escape' });
      assert.equal(doc.activeElement, doc.body, 'Escape on closed menu is a no-op');
      toggle.dispatch('click');
      assert.equal(menu.hasAttribute('hidden'), false);
      assert.equal(toggle.getAttribute('aria-expanded'), 'true');
      switcher.dispatch('keydown', { key: 'Escape' });
      assert.equal(menu.hasAttribute('hidden'), true);
      assert.equal(toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(doc.activeElement, toggle);
      toggle.dispatch('click');
      const workspaceButton = findOne(menu, node => node.tag === 'button' && node.textContent.includes('Team workspace'));
      workspaceButton.dispatch('click');
      assert.equal(switched, 'two');
      assert.equal(menu.hasAttribute('hidden'), true);
      assert.equal(doc.activeElement, toggle);
      toggle.dispatch('click');
      const newButton = findOne(menu, node => node.getAttribute('data-action') === 'new-workspace');
      newButton.dispatch('click');
      assert.equal(opened, true);
      assert.equal(menu.hasAttribute('hidden'), true);
      assert.equal(doc.activeElement, toggle);
      if (layout !== 'original') {
        const quick = findOne(shell, node => node.getAttribute('aria-label') === 'Quick layout switch');
        const railBtn = findOne(quick, node => node.tag === 'button' && node.getAttribute('aria-label') === 'Side rail');
        const topBtn = findOne(quick, node => node.tag === 'button' && node.getAttribute('aria-label') === 'Top bar');
        assert.equal(railBtn.getAttribute('aria-pressed'), String(layout === 'a'));
        assert.equal(topBtn.getAttribute('aria-pressed'), String(layout === 'c'));
        railBtn.dispatch('click');
        topBtn.dispatch('click');
        assert.deepEqual(selected, ['a', 'c']);
      }
      // Signed-out / unauthenticated states never render Quick layout switch or workspace switcher.
      for (const unauth of [{ ...state, account: null }, { ...state, phase: 'signedout' }]) {
        const outShell = header({
          state: unauth, route: { name: 'library' },
          switchWorkspace() {}, newWorkspace() {}, signOut() {}, search() {}, changeLayout() {}
        });
        assert.equal(findAll(outShell, node => node.getAttribute('aria-label') === 'Quick layout switch').length, 0);
      }
    }
  } finally {
    delete globalThis.document;
  }
});

test('app hydrates non-default account layout from GET /api/me and falls back to original on unknown values', async () => {
  const doc = installFakeDom();
  const f = await fixture();
  try {
    f.db.execute("UPDATE user_accounts SET layout_theme = 'a' WHERE email_normalized = 'owner@example.test'");
    const { createApi } = await import('../public/assets/js/api.js');
    const { createApp } = await import('../public/assets/js/app.js');
    const makeApp = (overrideLayout = null) => {
      const api = createApi({
        fetchImpl: async (path, init = {}) => {
          const res = await f.call(init.method || 'GET', path, 'owner', init.body ? JSON.parse(init.body) : undefined);
          if (overrideLayout !== null && path === '/api/me') {
            const data = JSON.parse(res.text);
            data.account.layout = overrideLayout;
            return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
          }
          return new Response(res.text, { status: res.status, headers: res.headers });
        }
      });
      const rootEl = doc.createElement('main');
      const headerRoot = doc.createElement('header');
      doc.body.replaceChildren(headerRoot, rootEl);
      const app = createApp({
        api, root: rootEl, headerRoot, announcer: doc.createElement('div'), toastRoot: doc.createElement('div'),
        getHash: () => '#/library', setHash() {}, storage: { get: () => null, set() {} }, today: () => '2026-11-23', navigate() {}
      });
      return { app, rootEl, headerRoot };
    };
    const aBoot = makeApp();
    await aBoot.app.start();
    assert.equal(doc.documentElement.getAttribute('data-layout'), 'a');
    assert.ok(findOne(aBoot.headerRoot, el => (el.getAttribute('class') || '').includes('theme-rail')));

    const badBoot = makeApp('unknown-theme');
    await badBoot.app.start();
    assert.equal(doc.documentElement.getAttribute('data-layout'), 'original');
    assert.ok(findOne(badBoot.headerRoot, el => el.getAttribute('class') === 'header-inner'));
  } finally {
    f.db.close();
    delete globalThis.document;
  }
});

test('Settings > Layout works in all three themes, PATCHes /api/me with exact payloads, keeps focus, guards concurrent saves, and rolls back on failure', async () => {
  const doc = installFakeDom();
  const f = await fixture();
  try {
    const { createApi } = await import('../public/assets/js/api.js');
    const { createApp } = await import('../public/assets/js/app.js');
    const patches = [];
    let failPatch = false;
    let releasePatch = null;
    const api = createApi({
      fetchImpl: async (path, init = {}) => {
        const method = init.method || 'GET';
        const body = init.body ? JSON.parse(init.body) : undefined;
        if (method === 'PATCH' && path === '/api/me') {
          patches.push(body);
          if (releasePatch) {
            await new Promise(resolve => { const done = releasePatch; releasePatch = null; done(resolve); });
          }
          if (failPatch) {
            return new Response(JSON.stringify({ error: 'invalid_layout' }), { status: 400, headers: { 'content-type': 'application/json' } });
          }
        }
        const res = await f.call(method, path, 'owner', body);
        return new Response(res.text, { status: res.status, headers: res.headers });
      }
    });
    const rootEl = doc.createElement('main');
    const headerRoot = doc.createElement('header');
    const announcer = doc.createElement('div');
    const toastRoot = doc.createElement('div');
    doc.body.append(headerRoot, rootEl, announcer, toastRoot);
    let currentHash = '#/settings/layout';
    const app = createApp({
      api, root: rootEl, headerRoot, announcer, toastRoot,
      getHash: () => currentHash,
      setHash: next => { currentHash = next; app.render(); },
      storage: { get: () => null, set() {} },
      today: () => '2026-11-23',
      navigate() {}
    });
    await app.start();
    await settle();

    // Original highlights active option with btn-primary and keeps settings-nav on the settings index column.
    assert.equal(doc.documentElement.getAttribute('data-layout'), 'original');
    const settingsIndex = findOne(rootEl, el => (el.getAttribute('class') || '').includes('settings-index'));
    assert.ok((settingsIndex.getAttribute('class') || '').includes('settings-nav'));
    const origBtn = findOne(rootEl, el => el.getAttribute('data-layout-option') === 'original');
    assert.equal(origBtn.getAttribute('aria-pressed'), 'true');
    assert.ok((origBtn.getAttribute('class') || '').includes('btn-primary'));
    assert.equal(findOne(rootEl, el => el.tag === 'a' && el.getAttribute('href') === '#/settings/layout').getAttribute('aria-current'), 'page');

    // Clicking the already-active layout is a no-op (no PATCH).
    origBtn.dispatch('click');
    await settle();
    assert.equal(patches.length, 0);

    // Deferred PATCH tests in-flight disabled buttons, Saving layout... status, concurrent click guard, and focus restoration.
    let finishFirstPatch;
    releasePatch = resolve => { finishFirstPatch = resolve; };
    const aBtn = findOne(rootEl, el => el.getAttribute('data-layout-option') === 'a');
    aBtn.focus();
    aBtn.dispatch('click');
    assert.equal(doc.documentElement.getAttribute('data-layout'), 'a');
    assert.ok(findOne(rootEl, el => el.getAttribute('data-layout-option') === 'c').hasAttribute('disabled'));
    assert.match(rootEl.textContent, /Saving layout/);
    findOne(rootEl, el => el.getAttribute('data-layout-option') === 'c').dispatch('click');
    assert.equal(patches.length, 1);
    finishFirstPatch();
    await settle();
    assert.deepEqual(patches, [{ layout: 'a' }]);
    assert.equal(doc.activeElement, findOne(rootEl, el => el.getAttribute('data-layout-option') === 'a'), 'focus restored to selected settings option');
    assert.match(announcer.textContent, /Default \(side rail\)/);
    assert.ok(findOne(headerRoot, el => (el.getAttribute('class') || '').includes('theme-rail')));

    // Switch to C via header quick toggle and verify focus restoration in headerRoot.
    const quickTop = findOne(headerRoot, el => el.getAttribute('data-quick-layout') === 'c');
    quickTop.focus();
    quickTop.dispatch('click');
    await settle();
    assert.deepEqual(patches, [{ layout: 'a' }, { layout: 'c' }]);
    assert.equal(doc.documentElement.getAttribute('data-layout'), 'c');
    assert.equal(doc.activeElement, findOne(headerRoot, el => el.getAttribute('data-quick-layout') === 'c'), 'focus restored to header quick toggle');
    assert.match(announcer.textContent, /Top bar/);
    assert.ok(findOne(rootEl, el => el.tag === 'a' && el.getAttribute('href') === '#/settings/layout'));

    // Failure keeps the old layout, reverts html[data-layout], shows alert and toast.
    failPatch = true;
    findOne(rootEl, el => el.getAttribute('data-layout-option') === 'original').dispatch('click');
    await settle();
    assert.equal(doc.documentElement.getAttribute('data-layout'), 'c');
    assert.equal(findOne(rootEl, el => el.getAttribute('data-layout-option') === 'c').getAttribute('aria-pressed'), 'true');
    assert.match(findOne(rootEl, el => el.getAttribute('role') === 'alert').textContent, /layout option is not available/i);
    assert.match(toastRoot.textContent, /layout option is not available/i);

    // Navigating away from Settings > Layout clears the stale layoutError.
    currentHash = '#/settings/places';
    app.render();
    currentHash = '#/settings/layout';
    app.render();
    assert.equal(findAll(rootEl, el => el.getAttribute('role') === 'alert').length, 0);

    // Successful switch back to Original works end-to-end.
    failPatch = false;
    findOne(rootEl, el => el.getAttribute('data-layout-option') === 'original').dispatch('click');
    await settle();
    assert.deepEqual(patches, [{ layout: 'a' }, { layout: 'c' }, { layout: 'original' }, { layout: 'original' }]);
    assert.equal(doc.documentElement.getAttribute('data-layout'), 'original');
    assert.match(announcer.textContent, /Original/);
    assert.ok(findOne(headerRoot, el => el.getAttribute('class') === 'header-inner'));
  } finally {
    f.db.close();
    delete globalThis.document;
  }
});
