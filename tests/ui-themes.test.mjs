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

function parseDeclarations(body) {
  const declarations = [];
  let start = 0, quote = '', paren = 0;
  for (let i = 0; i <= body.length; i++) {
    const ch = i < body.length ? body[i] : ';';
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') { paren++; continue; }
    if (ch === ')') { paren = Math.max(0, paren - 1); continue; }
    if (ch === ';' && paren === 0) {
      const part = body.slice(start, i);
      const colon = part.indexOf(':');
      if (colon >= 0) declarations.push([part.slice(0, colon).trim(), part.slice(colon + 1).trim()]);
      start = i + 1;
    }
  }
  return declarations;
}

const stripImportant = value => value.replace(/\s*!important\s*$/i, '').trim();

function parseRules(source) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  function scan(start, end, atRules) {
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
          scan(hit + 1, close, [...atRules, prelude]);
        } else {
          assert.match(prelude, /^@(?:font-face|keyframes)\b/i, `unexpected at-rule in theme CSS: ${prelude}`);
        }
      } else {
        const body = css.slice(hit + 1, close);
        assert.equal(findNext(body, 0, body.length, '{'), -1, `nested CSS blocks are not allowed in theme CSS: ${prelude}`);
        rules.push({ selectors: splitSelectors(prelude), declarations: parseDeclarations(body), atRules });
      }
      cursor = close + 1;
    }
  }
  scan(0, css.length, []);
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
        const cleanVal = stripImportant(value).toLowerCase();
        if (selector.endsWith('.theme-layout-buttons') && /^overflow(?:-[xy])?$/.test(property)) {
          assert.ok(!['hidden', 'clip'].includes(cleanVal), `${selector} must not clip button focus rings with ${property}: ${value}`);
        }
        if (selector.endsWith('.theme-rail') && /^overflow(?:-[xy])?$/.test(property)) {
          assert.ok(!['auto', 'scroll', 'hidden', 'clip'].includes(cleanVal), `${selector} must not clip workspace menu with ${property}: ${value}`);
        }
        if (selector.endsWith('.layout-options') && property === 'grid-template-columns' && cleanVal !== '1fr') {
          assert.match(cleanVal, /auto-fit/, `${selector} should wrap responsively with auto-fit instead of fixed columns: ${value}`);
        }
        if (selector.endsWith('.layout-option') && property === 'white-space') {
          assert.equal(cleanVal, 'normal', `${selector} must allow text wrapping`);
        }
      }
    }
  }
  const layoutRules = allRules.get(join(themeDir, 'layout.css'));
  const declMap = (selector, media = null) => {
    const entries = {};
    for (const rule of layoutRules) {
      const matchesMedia = media === null ? rule.atRules.length === 0 : rule.atRules.includes(media);
      if (!matchesMedia || !rule.selectors.includes(selector)) continue;
      for (const [p, v] of rule.declarations) entries[p.toLowerCase()] = stripImportant(v);
    }
    return entries;
  };
  // Layout A header must reset backdrop-filter so position: fixed descendants anchor to the viewport.
  assert.equal(declMap('html[data-layout="a"] .app-header')['backdrop-filter'], 'none');
  // Both A and C enforce non-clipping Settings > Layout cards, desktop/mobile responsive grids, and mobile account menus.
  for (const layout of ['a', 'c']) {
    const p = `html[data-layout="${layout}"]`;
    const opts = declMap(`${p} .layout-options`);
    assert.match(opts['grid-template-columns'] || '', /auto-fit.*min\(/, `${p} .layout-options uses responsive min(..., 100%) grid`);
    assert.equal(declMap(`${p} .layout-options`, '@media (max-width: 720px)')['grid-template-columns'], '1fr');
    const card = declMap(`${p} .layout-option`);
    assert.equal(card['white-space'], 'normal');
    assert.equal(card['min-width'], '0');
    assert.equal(card['width'], '100%');
    assert.equal(card['height'], 'auto');
    assert.match(card['overflow-wrap'] || '', /break-word|anywhere/);
    for (const part of ['.layout-option-title', '.layout-option-description']) {
      const partDecl = declMap(`${p} ${part}`);
      assert.equal(partDecl['min-width'], '0', `${p} ${part} min-width`);
      assert.equal(partDecl['width'], '100%', `${p} ${part} width`);
    }
    assert.equal(declMap(`${p} .theme-more`)['display'], 'none', `${p} .theme-more hidden on desktop`);
    const settingsIdx = declMap(`${p} .settings-index`, '@media (max-width: 850px)');
    assert.equal(settingsIdx['position'], 'static', `${p} .settings-index unsticks at <=850px`);
    assert.equal(settingsIdx['display'], 'flex', `${p} .settings-index wraps horizontally at <=850px`);
  }
  const aNavMobile = declMap('html[data-layout="a"] .theme-nav', '@media (max-width: 720px)');
  assert.equal(aNavMobile['position'], 'fixed');
  assert.equal(aNavMobile['overflow'], 'visible');
  assert.equal(declMap('html[data-layout="a"] .theme-nav .theme-more', '@media (max-width: 720px)')['display'], 'flex');
  assert.equal(declMap('html[data-layout="a"] .theme-rail.has-mobile-menu .theme-rail-footer', '@media (max-width: 720px)')['display'], 'none');
  assert.equal(declMap('html[data-layout="a"] .theme-mobile-menu', '@media (max-width: 720px)')['position'], 'fixed');
  assert.equal(declMap('html[data-layout="c"] .theme-topbar-right > .theme-more', '@media (max-width: 720px)')['display'], 'block');
  for (const hiddenSel of ['.theme-person', '.theme-layout-toggle', '.theme-signout']) {
    assert.equal(declMap(`html[data-layout="c"] .theme-topbar-right > ${hiddenSel}`, '@media (max-width: 720px)')['display'], 'none');
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
      assert.ok(ratio('--theme-text', '--theme-active') >= 4.5, `${path}: text on active surface`);
      assert.ok(ratio('--theme-muted', '--theme-active') >= 4.5, `${path}: muted text on active surface`);
      assert.ok(ratio('--theme-accent', '--theme-active') >= 4.5, `${path}: accent text on active surface`);
      assert.ok(ratio('--theme-accent-text', '--theme-accent') >= 4.5, `${path}: inverse text on accent`);
    }
  }
  assert.ok(checked > 0, 'at least one theme palette block must be checked');

  // Verify Settings > Layout option button states explicitly bind high-contrast foreground/background tokens.
  const layoutRules = allRules.get(join(themeDir, 'layout.css'));
  const paletteRule = layoutRules.find(r => r.declarations.some(([p]) => p === '--theme-text'));
  const palette = Object.fromEntries(paletteRule.declarations.filter(([p]) => p.startsWith('--theme-')));
  const resolveToken = value => {
    const m = /^var\((--theme-[a-z-]+)\)$/.exec(stripImportant(value || ''));
    assert.ok(m && palette[m[1]], `expected theme color token, got ${value}`);
    return palette[m[1]];
  };
  const declOf = selector => {
    const entries = {};
    for (const rule of layoutRules) {
      if (rule.atRules.length === 0 && rule.selectors.includes(selector)) {
        for (const [p, v] of rule.declarations) entries[p.toLowerCase()] = stripImportant(v);
      }
    }
    return entries;
  };
  for (const layout of ['a', 'c']) {
    const p = `html[data-layout="${layout}"]`;
    for (const sel of ['.layout-option', '.layout-option:hover', '.layout-option[aria-pressed="true"]', '.layout-option[aria-pressed="true"]:hover']) {
      const d = declOf(`${p} ${sel}`);
      assert.ok(contrast(hex(resolveToken(d.color)), hex(resolveToken(d.background))) >= 4.5, `${p} ${sel} meets AA contrast`);
    }
    const activeBg = resolveToken(declOf(`${p} .layout-option[aria-pressed="true"]`).background);
    const titleFg = resolveToken(declOf(`${p} .layout-option-title`).color);
    const activeDescFg = resolveToken(declOf(`${p} .layout-option[aria-pressed="true"] .layout-option-description`).color);
    assert.ok(contrast(hex(titleFg), hex(activeBg)) >= 4.5, `${p} selected title meets AA contrast`);
    assert.ok(contrast(hex(activeDescFg), hex(activeBg)) >= 4.5, `${p} selected description meets AA contrast`);
  }
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
    this.style = { setProperty() {} };
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
  contains(target) {
    let cur = target;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parent;
    }
    return false;
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
  const docListeners = {};
  const doc = {
    title: '',
    activeElement: null,
    createElement(tag) { return new FakeElement(tag, doc); },
    createTextNode(text) { return new FakeText(text); },
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      const list = docListeners[type];
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    },
    dispatch(type, event = {}) {
      const ev = { prevented: false, preventDefault() { this.prevented = true; }, ...event };
      for (const fn of [...(docListeners[type] || [])]) fn(ev);
      return ev;
    }
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
      let switched = null, opened = false, signedOut = 0;
      const selected = [];
      const state = stateFor(layout);
      const shell = header({
        state, route: { name: 'library' },
        switchWorkspace: id => { switched = id; },
        newWorkspace: () => { opened = true; },
        signOut() { signedOut++; }, search() {},
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
        assert.equal(findAll(shell, node => node.hasAttribute('data-test')).length, 0, 'Original markup gains no data-test attributes');
      }
      const text = shell.textContent;
      for (const label of ['Library', 'Search', 'Settings', 'Sermon workspace', 'New workspace', 'Rico Santos', 'Sign out']) {
        assert.ok(text.includes(label), `${layout} includes ${label}`);
      }
      const mark = findOne(shell, node => node.tag === 'img' && node.getAttribute('src') === '/assets/icon.svg', `${layout} book mark`);
      assert.ok(mark);
      const toggle = layout === 'original'
        ? findOne(shell, node => node.getAttribute('aria-controls') !== null)
        : findOne(shell, node => node.getAttribute('data-test') === 'workspace-switcher', `${layout} workspace switcher has data-test`);
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

        // Mobile account menu reaches account, layout choices (A, C, Original) and sign out.
        const moreToggle = findOne(shell, node => node.getAttribute('data-test') === 'account-menu', `${layout} mobile account menu`);
        const moreMenu = findOne(shell, node => node.getAttribute('id') === moreToggle.getAttribute('aria-controls'));
        const moreWrap = moreToggle.parent;
        if (layout === 'a') {
          assert.ok((shell.getAttribute('class') || '').includes('has-mobile-menu'), 'Layout A adds has-mobile-menu when authenticated');
          assert.equal(moreWrap.parent.tag, 'nav', 'Layout A mobile menu sits in the bottom tab bar nav');
          assert.ok(findOne(moreToggle, node => (node.getAttribute('class') || '').includes('theme-tab-label')));
        } else {
          assert.ok((moreWrap.parent.getAttribute('class') || '').includes('theme-topbar-right'), 'Layout C mobile menu is direct child of .theme-topbar-right');
        }
        assert.equal(moreToggle.getAttribute('aria-expanded'), 'false');
        assert.equal(moreMenu.hasAttribute('hidden'), true);
        doc.activeElement = doc.body;
        moreWrap.dispatch('keydown', { key: 'Escape' });
        assert.equal(doc.activeElement, doc.body, 'Escape on closed mobile menu is a no-op');
        moreToggle.dispatch('click');
        assert.equal(moreMenu.hasAttribute('hidden'), false);
        assert.equal(moreToggle.getAttribute('aria-expanded'), 'true');
        // Opening workspace switcher closes the open mobile menu (mutual exclusion) and vice versa.
        toggle.dispatch('click');
        assert.equal(menu.hasAttribute('hidden'), false);
        assert.equal(moreMenu.hasAttribute('hidden'), true);
        assert.equal(moreToggle.getAttribute('aria-expanded'), 'false');
        moreToggle.dispatch('click');
        assert.equal(menu.hasAttribute('hidden'), true);
        assert.equal(moreMenu.hasAttribute('hidden'), false);
        // Second click closes the mobile menu.
        moreToggle.dispatch('click');
        assert.equal(moreMenu.hasAttribute('hidden'), true);
        assert.equal(moreToggle.getAttribute('aria-expanded'), 'false');
        // Outside pointerdown closes the open mobile menu.
        doc.body.replaceChildren(shell);
        moreToggle.dispatch('click');
        assert.equal(moreMenu.hasAttribute('hidden'), false);
        doc.dispatch('pointerdown', { target: doc.body });
        assert.equal(moreMenu.hasAttribute('hidden'), true);
        // Escape closes and restores focus to toggle.
        moreToggle.dispatch('click');
        assert.match(moreMenu.textContent, /Rico Santos/);
        assert.match(moreMenu.textContent, /rico@example\.test/);
        for (const opt of ['a', 'c', 'original']) {
          const btn = findOne(moreMenu, node => node.getAttribute('data-mobile-layout') === opt);
          assert.equal(btn.getAttribute('aria-pressed'), String(layout === opt));
        }
        moreWrap.dispatch('keydown', { key: 'Escape' });
        assert.equal(moreMenu.hasAttribute('hidden'), true);
        assert.equal(moreToggle.getAttribute('aria-expanded'), 'false');
        assert.equal(doc.activeElement, moreToggle);
        moreToggle.dispatch('click');
        doc.activeElement = doc.body;
        findOne(moreMenu, node => node.getAttribute('data-mobile-layout') === 'original').dispatch('click');
        assert.equal(moreMenu.hasAttribute('hidden'), true);
        assert.equal(doc.activeElement, moreToggle, 'picking a mobile layout option returns focus to toggle');
        assert.deepEqual(selected, ['a', 'c', 'original']);
        moreToggle.dispatch('click');
        doc.activeElement = doc.body;
        findOne(moreMenu, node => (node.getAttribute('class') || '').includes('theme-mobile-signout')).dispatch('click');
        assert.equal(moreMenu.hasAttribute('hidden'), true);
        assert.equal(doc.activeElement, moreToggle, 'sign out returns focus to toggle before async logout');
        assert.equal(signedOut, 1);

        // Authenticated user with zero workspaces (no-workspace phase) still has mobile account menu in A and C.
        const noWsShell = header({
          state: { ...state, workspaces: [], workspaceId: null, phase: 'no-workspace' }, route: { name: 'library' },
          switchWorkspace() {}, newWorkspace() {}, signOut() {}, search() {}, changeLayout() {}
        });
        assert.ok(findOne(noWsShell, node => node.getAttribute('data-test') === 'account-menu', `${layout} no-workspace keeps account menu`));
        assert.equal(findAll(noWsShell, node => node.getAttribute('data-test') === 'workspace-switcher').length, 0);
      }
      // Signed-out / unauthenticated states never render Quick layout switch, workspace switcher, or account menu.
      for (const unauth of [{ ...state, account: null }, { ...state, phase: 'signedout' }]) {
        const outShell = header({
          state: unauth, route: { name: 'library' },
          switchWorkspace() {}, newWorkspace() {}, signOut() {}, search() {}, changeLayout() {}
        });
        assert.equal(findAll(outShell, node => node.getAttribute('aria-label') === 'Quick layout switch').length, 0);
        assert.equal(findAll(outShell, node => node.getAttribute('data-test') === 'account-menu').length, 0);
        assert.equal(findAll(outShell, node => node.getAttribute('data-test') === 'workspace-switcher').length, 0);
        assert.equal((outShell.getAttribute('class') || '').includes('has-mobile-menu'), false);
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
    for (const btn of findAll(rootEl, el => el.hasAttribute('data-layout-option'))) {
      assert.ok((btn.getAttribute('class') || '').includes('place-main'), 'every option stacks title and description in Original');
    }
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

    // Switch back to A via mobile menu and verify focus restores to the mobile menu toggle.
    const mobileRail = findOne(headerRoot, el => el.getAttribute('data-mobile-layout') === 'a');
    mobileRail.focus();
    mobileRail.dispatch('click');
    await settle();
    assert.equal(doc.documentElement.getAttribute('data-layout'), 'a');
    assert.equal(doc.activeElement, findOne(headerRoot, el => el.getAttribute('data-test') === 'account-menu'), 'focus restored to mobile menu toggle');
    assert.match(announcer.textContent, /Default \(side rail\)/);

    // Switch back to C so the failure rollback test starts from C.
    findOne(headerRoot, el => el.getAttribute('data-quick-layout') === 'c').dispatch('click');
    await settle();
    assert.equal(doc.documentElement.getAttribute('data-layout'), 'c');

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
    assert.deepEqual(patches, [{ layout: 'a' }, { layout: 'c' }, { layout: 'a' }, { layout: 'c' }, { layout: 'original' }, { layout: 'original' }]);
    assert.equal(doc.documentElement.getAttribute('data-layout'), 'original');
    assert.match(announcer.textContent, /Original/);
    assert.ok(findOne(headerRoot, el => el.getAttribute('class') === 'header-inner'));

    // Switching from A to Original via mobile menu on a non-Settings route (#/library/covers) falls back focus to main root.
    findOne(rootEl, el => el.getAttribute('data-layout-option') === 'a').dispatch('click');
    await settle();
    currentHash = '#/library/covers';
    app.render();
    const mobileOrig = findOne(headerRoot, el => el.getAttribute('data-mobile-layout') === 'original');
    mobileOrig.focus();
    mobileOrig.dispatch('click');
    await settle();
    assert.equal(doc.documentElement.getAttribute('data-layout'), 'original');
    assert.equal(doc.activeElement, rootEl, 'focus falls back to main when switching to Original from mobile menu on Library');
  } finally {
    f.db.close();
    delete globalThis.document;
  }
});
