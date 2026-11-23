// Search, New workspace, join and Settings pages in layouts A and C. The fake DOM has no layout, so these
// tests pin what the views render for each layout (Original's markup must not change; A and C only add the
// search subtitle and art) and that other.css carries a rule for every class those pages render.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleRequest } from '../src/auth/app.ts';
import { SESSION_COOKIE } from '../src/auth/security.ts';
import { indexVersion } from '../src/search/index.ts';
import { fixture, ids, origin } from './helpers/library-fixture.mjs';

const J = path => new URL(`../public/assets/js/${path}`, import.meta.url).pathname;
const { createApi } = await import(J('api.js'));
const { createApp } = await import(J('app.js'));
const { joinForm } = await import(J('views/join.js'));

// ---------------------------------------------------------------- minimal fake DOM and app harness

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
  select() {}
  showModal() { this.open = true; }
  close() { if (!this.open) return; this.open = false; this.dispatch('close'); }
  closest(selector) { for (let node = this; node && node.nodeType === 1; node = node.parent) if (matches(node, selector)) return node; return null; }
  querySelectorAll(selector) { return all(this, e => matches(e, selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
class FakeDocument {
  constructor() { this.documentElement = new FakeElement(this, 'html'); this.body = new FakeElement(this, 'body'); this.activeElement = this.body; this.title = ''; }
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
const one = (node, predicate, message = 'expected element not found') => {
  const found = all(node, predicate)[0];
  assert.ok(found, message);
  return found;
};
const textOf = node => node?.textContent ?? '';

function realApi(f, actor, { onCall } = {}) {
  const fetchImpl = async (path, init) => {
    onCall?.(init.method, path);
    return handleRequest(new Request(origin + path, {
      method: init.method,
      headers: { ...init.headers, ...(actor ? { cookie: SESSION_COOKIE + '=' + f.tokens[actor] } : {}), ...(init.method === 'GET' ? {} : { origin }) },
      body: init.body
    }), f.env);
  };
  return createApi({ fetchImpl });
}

async function mountApp(f, actor, { hash = '', api, today = '2026-11-13' } = {}) {
  const calls = [];
  api ||= realApi(f, actor, { onCall: (method, path) => calls.push(`${method} ${path}`) });
  const document = new FakeDocument();
  globalThis.document = document;
  const dom = { document, root: document.make('main'), header: document.make('header'), announcer: document.make('div'), toast: document.make('div'), calls };
  let current = hash;
  let app;
  app = createApp({
    api, root: dom.root, headerRoot: dom.header, announcer: dom.announcer, toastRoot: dom.toast,
    getHash: () => current, setHash: next => { current = next; app.render(); },
    storage: { get: () => null, set() {} }, today: () => today,
    navigate: url => { dom.navigated = url; }
  });
  dom.go = next => { current = next; app.render(); };
  dom.hash = () => current;
  dom.app = app;
  document.body.append(dom.root);
  await app.start();
  return dom;
}
const byAction = (node, action) => all(node, e => e.getAttribute('data-action') === action);
async function until(check, message) {
  for (let i = 0; i < 150; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(message);
}
const openDialog = dom => one(dom.document.body, e => e.tag === 'dialog' && e.open, 'expected an open dialog');
const noDialog = dom => all(dom.document.body, e => e.tag === 'dialog' && e.open).length === 0;
async function withFixture(run) {
  const f = await fixture();
  try { await run(f); } finally { f.db.close(); }
}


const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const searchDone = dom => all(dom.root, e => e.hasClass('result-group')).length > 0 && all(dom.root, e => e.getAttribute('aria-busy') === 'true').length === 0;

// ---------------------------------------------------------------- helpers

const LAYOUTS = ['original', 'a', 'c'];
const THEMED = ['a', 'c'];
const SECTIONS = ['places', 'people', 'import', 'docs', 'workspace'];
const themeCss = name => readFileSync(new URL(`../public/assets/themes/${name}.css`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const otherCss = themeCss('other');
/** Rules of a theme stylesheet that declare something: { selector, layout } for each selector in each rule's list. */
function rulesOf(css) {
  const rules = [];
  for (let start = 0; start < css.length;) {
    const open = css.indexOf('{', start);
    if (open < 0) break;
    let depth = 1;
    let end = open + 1;
    for (; end < css.length && depth; end++) {
      if (css[end] === '{') depth++;
      if (css[end] === '}') depth--;
    }
    const prelude = css.slice(start, open).trim();
    const body = css.slice(open + 1, end - 1);
    if (/^@(media|supports|container|layer)\b/.test(prelude)) {
      rules.push(...rulesOf(body));
    } else if (!prelude.startsWith('@') && /[\w-]+\s*:\s*\S/.test(body)) {
      for (const selector of splitTop(prelude, c => c === ',')) {
        rules.push({ selector, layout: /^html\[data-layout="(a|c)"\]/.exec(selector)?.[1] });
      }
    }
    start = end;
  }
  return rules;
}
const otherRules = rulesOf(otherCss);
/** Every theme stylesheet except layout.css, which owns the Settings > Layout cards. */
const nonLayoutThemeRules = { 'browse.css': rulesOf(themeCss('browse')), 'other.css': otherRules };
const appCss = readFileSync(new URL('../public/assets/app.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const classesOf = node => (node.getAttribute('class') || '').split(/\s+/).filter(Boolean);
/** Tags and classes of a subtree: its markup without the text. */
const shape = (node, skip = () => false) => `${node.tag}.${classesOf(node).join('.')}[${(node.children || []).filter(c => c.nodeType === 1 && !skip(c)).map(c => shape(c, skip)).join(',')}]`;
const renderedClasses = node => new Set([...classesOf(node), ...all(node, () => true).flatMap(classesOf)]);
const isThemeOnly = e => e.hasClass('search-sub') || e.hasClass('search-art');
const withoutThemeOnly = node => shape(node, isThemeOnly);

async function withOwner(layout, run) {
  const f = await fixture();
  try {
    f.db.execute("UPDATE user_accounts SET layout_theme = ? WHERE email_normalized = 'owner@example.test'", [layout]);
    await run(f);
  } finally { f.db.close(); }
}

async function mountAs(layout, hash, prepare) {
  const f = await fixture();
  try {
    f.db.execute("UPDATE user_accounts SET layout_theme = ? WHERE email_normalized = 'owner@example.test'", [layout]);
    await prepare?.(f);
    const dom = await mountApp(f, 'owner', { hash });
    return { dom, f };
  } catch (error) { f.db.close(); throw error; }
}

async function seedNotes(f) {
  f.db.execute('UPDATE sermon_versions SET index_consent_by=?, index_consent_at=?, indexing_state=? WHERE id=?', [ids.owner, '2025-06-01 10:00:00', 'queued', ids.version1]);
  await indexVersion(f.env.DB, { workspaceId: ids.w1, versionId: ids.version1, text: 'For God so loved the world, John 3:16 says it plainly.', actorId: ids.owner });
}

// ---------------------------------------------------------------- search

test('the layout reaches the DOM before the search page renders', async () => {
  for (const layout of LAYOUTS) {
    const { dom, f } = await mountAs(layout, '#/search');
    try { assert.equal(dom.document.documentElement.getAttribute('data-layout'), layout); } finally { f.db.close(); }
  }
});

test('A and C add a subtitle and book art to the idle search page and nothing else; Original has neither', async () => {
  const shapes = {};
  for (const layout of LAYOUTS) {
    const { dom, f } = await mountAs(layout, '#/search');
    try {
      const page = one(dom.root, e => e.hasClass('search-page'));
      shapes[layout] = withoutThemeOnly(page);
      const subtitle = all(page, e => e.hasClass('search-sub'));
      const art = all(page, e => e.hasClass('search-art'));
      if (THEMED.includes(layout)) {
        assert.equal(subtitle.length, 1, layout);
        assert.equal(textOf(subtitle[0]), 'Find sermons by Scripture passage metadata or inside indexed notes.');
        assert.equal(subtitle[0].parent.children[0].tag, 'h1', 'the subtitle follows the page heading');
        assert.equal(art.length, 1, layout);
        const [image] = art;
        assert.equal(image.tag, 'img');
        assert.equal(image.getAttribute('alt'), '', 'decorative art has empty alt text');
        assert.match(image.getAttribute('src'), /^data:image\/svg\+xml,%3Csvg /);
        assert.doesNotMatch(decodeURIComponent(image.getAttribute('src')).replace('http://www.w3.org/2000/svg', ''), /https?:\/\/|<script|\p{Extended_Pictographic}/u);
        assert.equal(image.parent.getAttribute('id'), 'search-results');
        assert.equal(image.parent.children[1].hasClass('muted'), true, 'the idle copy still follows the art');
      } else {
        assert.equal(subtitle.length + art.length, 0, 'Original renders exactly the old page');
      }
    } finally { f.db.close(); }
  }
  assert.equal(shapes.a, shapes.original, 'A keeps the same markup under the added nodes');
  assert.equal(shapes.c, shapes.original, 'C keeps the same markup under the added nodes');
});

test('an unknown data-layout value renders the Original search page', async () => {
  const { dom, f } = await mountAs('original', '#/library');
  try {
    for (const value of ['b', '', 'A']) {
      dom.document.documentElement.setAttribute('data-layout', value);
      dom.go('#/search');
      const page = one(dom.root, e => e.hasClass('search-page'));
      assert.equal(all(page, e => isThemeOnly(e)).length, 0, `data-layout="${value}"`);
    }
  } finally { f.db.close(); }
});

test('the two-stage search renders the same groups and results in every layout, without the idle art', async () => {
  const seen = {};
  for (const layout of LAYOUTS) {
    const { dom, f } = await mountAs(layout, '#/search?q=John%203:16&scope=everything', seedNotes);
    try {
      await until(() => searchDone(dom), 'both groups landed');
      const page = one(dom.root, e => e.hasClass('search-page'));
      assert.equal(all(page, e => e.hasClass('search-art')).length, 0, 'art shows only before a search');
      assert.equal(all(page, e => e.hasClass('search-sub')).length, THEMED.includes(layout) ? 1 : 0);
      seen[layout] = {
        groups: all(page, e => e.hasClass('result-group')).map(g => textOf(g.children[0])),
        items: all(page, e => e.hasClass('result-item')).map(textOf),
        scopes: all(page, e => e.getAttribute('data-scope')).map(e => [e.getAttribute('data-scope'), e.getAttribute('aria-pressed')]),
        marks: all(page, e => e.tag === 'mark').map(textOf)
      };
      assert.ok(seen[layout].items.length > 0 && seen[layout].marks.length > 0, 'results and highlighted matches rendered');
      assert.deepEqual(seen[layout].scopes.map(([key]) => key), ['everything', 'bible', 'notes']);
    } finally { f.db.close(); }
  }
  assert.deepEqual(seen.a, seen.original);
  assert.deepEqual(seen.c, seen.original);
});

// ---------------------------------------------------------------- New workspace, join, Settings

async function newWorkspaceDialog(layout) {
  const { dom, f } = await mountAs(layout, '#/library');
  try {
    const open = one(dom.header, e => e.getAttribute('data-action') === 'new-workspace');
    open.dispatch('click');
    const dialog = one(dom.document.body, e => e.tag === 'dialog' && e.open, 'expected an open dialog');
    return { dialog: shape(dialog), classes: renderedClasses(dialog), title: textOf(one(dialog, e => e.tag === 'h2')) };
  } finally { f.db.close(); }
}

test('the New workspace dialog has the same markup in every layout', async () => {
  const seen = {};
  for (const layout of LAYOUTS) seen[layout] = await newWorkspaceDialog(layout);
  assert.equal(seen.a.title, 'New workspace');
  assert.equal(seen.a.dialog, seen.original.dialog);
  assert.equal(seen.c.dialog, seen.original.dialog);
  for (const name of ['dialog', 'dialog-head', 'icon-btn', 'field', 'dialog-actions', 'btn', 'btn-primary']) {
    assert.ok(seen.a.classes.has(name), `the dialog renders .${name}`);
  }
});

test('the join form renders the same markup in every layout', () => {
  const shapes = LAYOUTS.map(layout => {
    const document = new FakeDocument();
    globalThis.document = document;
    document.documentElement.setAttribute('data-layout', layout);
    return shape(joinForm({ join: async () => {} }));
  });
  assert.equal(shapes[1], shapes[0]);
  assert.equal(shapes[2], shapes[0]);
  assert.match(shapes[0], /form\.state-form\.join-form/);
});

test('every Settings section renders the same markup in every layout', async () => {
  for (const section of SECTIONS) {
    const seen = {};
    for (const layout of LAYOUTS) {
      const { dom, f } = await mountAs(layout, `#/settings/${section}`);
      try {
        await until(() => all(dom.root, e => e.hasClass('settings-section')).length > 0 && all(dom.root, e => e.hasClass('state-loading')).length === 0, `${section} rendered`);
        await settle();
        seen[layout] = { markup: shape(one(dom.root, e => e.hasClass('settings-body'))), classes: renderedClasses(dom.root) };
        assert.ok(all(dom.root, e => e.tag === 'h1').length === 1, 'one page heading');
      } finally { f.db.close(); }
    }
    assert.equal(seen.a.markup, seen.original.markup, `${section} in A`);
    assert.equal(seen.c.markup, seen.original.markup, `${section} in C`);
  }
});


// ---------------------------------------------------------------- Settings > Layout cards

/** Splits at top-level (outside parentheses and brackets) on any character for which isSep is true. */
function splitTop(text, isSep) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    if ('([' .includes(text[i])) depth++;
    else if (')]'.includes(text[i])) depth--;
    else if (depth === 0 && isSep(text[i])) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts.map(part => part.trim()).filter(Boolean);
}

/** True when one compound selector (no combinators) matches the described element. Dynamic pseudo-classes count as matching. */
function compoundMatches(node, compound) {
  let rest = compound;
  const tag = /^[a-z][a-z0-9]*/i.exec(rest);
  if (tag) { if (node.tag !== tag[0].toLowerCase()) return false; rest = rest.slice(tag[0].length); }
  while (rest) {
    let m;
    if ((m = /^\.([\w-]+)/.exec(rest))) { if (!node.classes.has(m[1])) return false; }
    else if ((m = /^\[([\w-]+)(?:="([^"]*)")?\]/.exec(rest))) { if (m[2] === undefined ? !node.attrs.has(m[1]) : node.attrs.get(m[1]) !== m[2]) return false; }
    else if ((m = /^\*/.exec(rest))) { /* universal */ }
    else if ((m = /^::[\w-]+/.exec(rest))) return false;
    else if ((m = /^:(is|where|not)\(/.exec(rest))) {
      let depth = 1, end = m[0].length;
      while (depth > 0 && end < rest.length) depth += rest[end] === '(' ? 1 : rest[end] === ')' ? -1 : 0, end++;
      const any = splitTop(rest.slice(m[0].length, end - 1), c => c === ',').some(alt => compoundMatches(node, alt));
      if (m[1] === 'not' ? any : !any) return false;
      m = [rest.slice(0, end)];
    }
    else if ((m = /^:(disabled|enabled)\b/.exec(rest))) {
      if ((m[1] === 'disabled') !== node.attrs.has('disabled')) return false;
    }
    else if ((m = /^:[\w-]+/.exec(rest))) { /* :hover, :focus-visible, :last-child ... */ }
    else throw new Error('selector part not understood: ' + rest);
    rest = rest.slice(m[0].length);
  }
  return true;
}

/** Descendant-combinator match of a selector against an element and its ancestor chain, nearest ancestor last. A child combinator is read as a descendant one, which can only over-report. */
function selectorReaches(selector, element, ancestors) {
  const compounds = splitTop(selector, c => /[\s>]/.test(c));
  if (!compoundMatches(element, compounds.pop())) return false;
  let at = ancestors.length - 1;
  while (compounds.length) {
    const compound = compounds.pop();
    while (at >= 0 && !compoundMatches(ancestors[at], compound)) at--;
    if (at-- < 0) return false;
  }
  return true;
}

const describeNode = (tag, classes, attrs = {}) => ({ tag, classes: new Set(classes.split(' ').filter(Boolean)), attrs: new Map(Object.entries(attrs)) });

test('the selector matcher finds an unguarded button rule and passes a guarded one', () => {
  const card = describeNode('button', 'btn btn-primary place-main layout-option', { 'aria-pressed': 'true' });
  const chain = [describeNode('html', '', { 'data-layout': 'a' }), describeNode('main', 'settings')];
  assert.ok(selectorReaches('html[data-layout="a"] :is(.search-page, .settings) .btn-primary', card, chain));
  assert.ok(selectorReaches('html[data-layout="a"] .settings .btn:hover', card, chain));
  assert.ok(selectorReaches('html[data-layout="a"] .btn:hover:not(:disabled)', card, chain));
  assert.ok(selectorReaches('.settings .btn', card, chain));
  card.attrs.set('disabled', '');
  assert.ok(!selectorReaches('html[data-layout="a"] .btn:hover:not(:disabled)', card, chain));
  assert.ok(selectorReaches('html[data-layout="a"] .btn:disabled', card, chain));
  assert.ok(selectorReaches('html[data-layout="a"] .settings :focus-visible', card, chain));
  assert.ok(!selectorReaches('html[data-layout="a"] .settings .btn-primary:where(:not(.layout-option))', card, chain));
  assert.ok(!selectorReaches('html[data-layout="c"] .settings .btn-primary', card, chain));
  assert.ok(!selectorReaches('html[data-layout="a"] .dialog .btn-primary', card, chain));
  assert.ok(!selectorReaches('html[data-layout="a"] .settings .btn::before', card, chain));
});

test('no theme stylesheet but layout.css (browse.css, other.css) has a rule that matches the Settings > Layout option cards', async () => {
  const offenders = new Set();
  const describe = node => ({ tag: node.tag, classes: new Set(classesOf(node)), attrs: new Map(node.attrs) });
  for (const layout of THEMED) {
    const { dom, f } = await mountAs(layout, '#/settings/layout');
    try {
      const cards = all(dom.root, e => e.tag === 'button' && e.hasClass('layout-option'));
      assert.equal(cards.length, 3);
      assert.equal(cards.filter(card => card.getAttribute('aria-pressed') === 'true').length, 1);
      for (const card of cards) {
        const chain = [];
        for (let ancestor = card.parent; ancestor; ancestor = ancestor.parent) chain.unshift(describe(ancestor));
        chain.unshift(describe(dom.document.documentElement));
        const node = describe(card);
        const disabled = { ...node, attrs: new Map([...node.attrs, ['disabled', '']]) };
        for (const [sheet, rules] of Object.entries(nonLayoutThemeRules)) {
          for (const { selector } of rules) {
            if (selectorReaches(selector, node, chain) || selectorReaches(selector, disabled, chain)) {
              offenders.add(`${sheet}: ${selector}`);
            }
          }
        }
      }
    } finally { f.db.close(); }
  }
  assert.deepEqual([...offenders], []);
});

// ---------------------------------------------------------------- stylesheet coverage

test('the narrow-screen Settings rules do not restyle the outer nav wrapper that layout.css makes a sticky grid', async () => {
  const { dom, f } = await mountAs('a', '#/settings/places');
  try {
    await until(() => all(dom.root, e => e.hasClass('settings-index')).length > 0, 'settings nav');
    const wrapper = one(dom.root, e => e.hasClass('settings-index'));
    const start = otherCss.indexOf('@media (max-width: 900px)');
    assert.ok(start >= 0, 'the 900px block exists');
    let depth = 0, end = otherCss.indexOf('{', start);
    for (let i = end; i < otherCss.length; i++) {
      if (otherCss[i] === '{') depth++;
      else if (otherCss[i] === '}' && --depth === 0) { end = i; break; }
    }
    const block = otherCss.slice(otherCss.indexOf('{', start) + 1, end);
    const offenders = [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .flatMap(([, prelude, body]) => prelude.split(',').map(selector => [selector.trim().replace(/^html\[data-layout="[ac]"\]\s*/, ''), body]))
      .filter(([selector, body]) => /^[.\w-]+$/.test(selector) && matches(wrapper, selector) && /(^|;|\s)(display|flex-wrap)\s*:/.test(body))
      .map(([selector]) => selector);
    assert.deepEqual(offenders, [], 'a bare compound selector here also matches the wrapper (.settings-nav.settings-index) and turns it into a flex row');
  } finally { f.db.close(); }
});

test('at phone width the abilities caption is a full-width block, not a shrink-to-fit table-caption', () => {
  const start = otherCss.indexOf('@media (max-width: 720px)');
  assert.ok(start >= 0, 'the 720px block exists');
  const open = otherCss.indexOf('{', start);
  let depth = 0, end = open;
  for (let i = open; i < otherCss.length; i++) {
    if (otherCss[i] === '{') depth++;
    else if (otherCss[i] === '}' && --depth === 0) { end = i; break; }
  }
  const block = otherCss.slice(open + 1, end);
  for (const layout of THEMED) {
    const rule = [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .find(([, prelude]) => prelude.split(',').some(s => s.trim() === `html[data-layout="${layout}"] .settings .abilities caption`));
    assert.ok(rule, `layout ${layout} has a 720px rule for the abilities caption`);
    assert.match(rule[2], /display:\s*block/);
    assert.match(rule[2], /width:\s*100%/);
  }
  // app.css makes the table a block at this width, which is why the caption needs the override.
  assert.match(appCss, /\.sermon-table, \.sermon-table tbody[^{]*\{[^}]*display:\s*block/);
});

/** Classes the pages render that app.css styles and that look the same in a layout, so other.css need not restyle them. */
const SHARED_LOOK = new Set([
  'panel-body', 'section-actions', 'settings-body', // spacing and min-width only
  'req' // the required-field marker is already the layout's danger red (#9b2c2c)
]);

test('other.css carries a rule for every class the themed pages render that app.css styles', async () => {
  const rendered = new Set();
  const collect = set => { for (const name of set) rendered.add(name); };
  {
    const { dom, f } = await mountAs('a', '#/search?q=John%203:16&scope=everything', seedNotes);
    try { await until(() => searchDone(dom), 'results'); collect(renderedClasses(one(dom.root, e => e.hasClass('search-page')))); } finally { f.db.close(); }
  }
  collect((await newWorkspaceDialog('a')).classes);
  for (const section of SECTIONS) {
    const { dom, f } = await mountAs('a', `#/settings/${section}`);
    try {
      await until(() => all(dom.root, e => e.hasClass('settings-section')).length > 0 && all(dom.root, e => e.hasClass('state-loading')).length === 0, section);
      collect(renderedClasses(one(dom.root, e => e.hasClass('settings'))));
    } finally { f.db.close(); }
  }
  collect(renderedClasses(joinForm({ join: async () => {} })));
  const styledByApp = name => new RegExp(`\\.${name}(?![\\w-])`).test(appCss);
  const styledIn = (name, layout) => otherRules.some(rule => rule.layout === layout && new RegExp(`\\.${name}(?![\\w-])`).test(rule.selector));
  const unthemed = [...rendered]
    .filter(name => styledByApp(name) && !SHARED_LOOK.has(name))
    .flatMap(name => ['a', 'c'].filter(layout => !styledIn(name, layout)).map(layout => `${name} (${layout})`)).sort();
  assert.deepEqual(unthemed, [], 'give each class a rule with declarations in other.css for both layouts, or list it in SHARED_LOOK when it should look the same');
});
