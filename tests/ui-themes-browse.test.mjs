import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

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
    this.style = { setProperty: (name, value) => { (this.styles ||= {})[name] = value; } };
    this._value = undefined;
  }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  hasAttribute(name) { return this.attrs.has(name); }
  removeAttribute(name) { this.attrs.delete(name); }
  hasClass(name) { return (this.attrs.get('class') || '').split(/\s+/).includes(name); }
  append(...nodes) {
    for (const node of nodes) {
      const child = typeof node === 'string' ? new FakeText(node) : node;
      child.parent = this;
      this.children.push(child);
    }
  }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  dispatch(type, event = {}) {
    const ev = { target: this, prevented: false, preventDefault() { this.prevented = true; }, ...event };
    for (const handler of this.listeners[type] || []) handler(ev);
    return ev;
  }
  get value() { return this._value ?? this.getAttribute('value') ?? ''; }
  set value(v) { this._value = String(v); }
  focus() { this.doc.activeElement = this; }
  closest(sel) {
    let cur = this;
    while (cur) {
      if (sel.startsWith('.') ? cur.hasClass(sel.slice(1)) : cur.tag === sel) return cur;
      cur = cur.parent;
    }
    return null;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    return findAll(this, node => {
      if (sel.startsWith('#')) return node.getAttribute('id') === sel.slice(1);
      if (sel.startsWith('.')) return node.hasClass(sel.slice(1));
      const attr = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(sel);
      if (attr) return attr[2] === undefined ? node.hasAttribute(attr[1]) : node.getAttribute(attr[1]) === attr[2];
      return node.tag === sel.toLowerCase();
    });
  }
  get textContent() { return this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this.children = [new FakeText(v)]; }
}

function installFakeDom(layout = 'a') {
  const doc = {
    title: '',
    activeElement: null,
    createElement(tag) { return new FakeElement(tag, doc); },
    createElementNS(_ns, tag) { return new FakeElement(tag, doc); },
    createTextNode(text) { return new FakeText(text); }
  };
  doc.documentElement = new FakeElement('html', doc);
  doc.documentElement.setAttribute('data-layout', layout);
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

const sampleItems = [
  {
    id: 'c1000000-0000-4000-8000-000000000001',
    title: 'Walking on Water',
    series_name: 'Enough',
    scripture_references: ['Matthew 14:22-33'],
    tags: ['faith', 'courage'],
    created_at: '2026-09-01 09:00:00',
    archived_at: null,
    version_count: 2,
    preachCount: 2,
    last: { date: '2026-11-22', precision: 'exact' }
  },
  {
    id: 'c1000000-0000-4000-8000-000000000002',
    title: 'The Shepherd Who Stays',
    series_name: null,
    scripture_references: ['Psalm 23'],
    tags: ['pastoral'],
    created_at: '2026-08-10 09:00:00',
    archived_at: null,
    version_count: 1,
    preachCount: 1,
    last: { date: '2026-08-16', precision: 'exact' }
  }
];

const sampleSermon = {
  id: 'c1000000-0000-4000-8000-000000000001',
  title: 'Grace Enough for Today',
  series_name: 'Enough',
  description: 'Series opener on weakness and daily sufficiency.',
  scripture_references: ['2 Corinthians 12:7-10'],
  tags: ['weakness', 'pastoral'],
  created_at: '2026-09-01 09:00:00',
  updated_at: '2026-11-09 10:00:00',
  archived_at: null,
  versions: [
    { id: 'v1', label: 'Original manuscript', source_type: 'google_doc', google_document_id: 'doc1', indexing_state: 'indexed' },
    { id: 'v2', label: 'Short edit (28 min)', source_type: 'pdf', indexing_state: 'not_indexed' }
  ],
  preaching_events: [
    { id: 'e1', preached_on: '2026-11-08', date_precision: 'exact', place_name: 'Riverbend Chapel', occasion: 'Sunday morning', version_id: 'v1' }
  ]
};

test('Library covers, rows, and table views render under layouts A and C with exact heading, SVG book art, and variant series controls', async () => {
  const { libraryPage } = await import('../public/assets/js/views/library.js');
  for (const layout of ['a', 'c']) {
    installFakeDom(layout);
    try {
      for (const view of ['covers', 'rows', 'table']) {
        const state = { layout, role: 'owner', items: sampleItems, query: '', archive: 'active', sort: 'recent' };
        const page = libraryPage({ state, view, announce() {}, newDraft() {} });
        const heading = findOne(page, n => n.tag === 'h1', `${layout}/${view} h1`);
        assert.equal(heading.textContent, 'Library');
        const bookArt = findOne(page, n => n.tag === 'svg' && n.hasClass('shelf-art'), `${layout}/${view} shelf SVG`);
        assert.equal(bookArt.getAttribute('aria-hidden'), 'true');
        if (layout === 'a') {
          assert.ok(findOne(page, n => n.tag === 'select' && n.getAttribute('id') === 'sermon-series', 'A has series select'));
          assert.equal(findAll(page, n => n.hasClass('series-strip')).length, 0);
        } else {
          const strip = findOne(page, n => n.hasClass('series-strip'), 'C has series strip');
          assert.ok(findAll(strip, n => n.hasClass('series-pill')).length >= 3);
        }
        if (view === 'covers') {
          assert.equal(findAll(page, n => n.hasClass('sermon-card')).length, 2);
        } else if (view === 'rows') {
          const panel = findOne(page, n => n.hasClass('panel') && n.hasClass('edge-list-mobile'), `${layout} rows edge-to-edge`);
          assert.equal(findAll(panel, n => n.hasClass('sermon-row')).length, 2);
          assert.equal(findAll(panel, n => n.hasClass('row-spine')).length, 2);
        } else {
          const panel = findOne(page, n => n.hasClass('panel') && n.hasClass('edge-list-mobile'), `${layout} table edge-to-edge`);
          assert.ok(findOne(panel, n => n.tag === 'table' && n.hasClass('data-table')));
        }
      }

      // Series filter works in both A and C, and empty workspace uses SVG book art.
      const state = { layout, role: 'owner', items: sampleItems, query: '', archive: 'active', sort: 'recent' };
      const rowsPage = libraryPage({ state, view: 'rows', announce() {}, newDraft() {} });
      if (layout === 'a') {
        const select = findOne(rowsPage, n => n.getAttribute('id') === 'sermon-series');
        select.value = 'Enough';
        select.dispatch('change');
      } else {
        const enoughPill = findOne(rowsPage, n => n.hasClass('series-pill') && n.textContent === 'Enough');
        enoughPill.dispatch('click');
      }
      assert.equal(findAll(rowsPage, n => n.hasClass('sermon-row')).length, 1);
      assert.match(rowsPage.textContent, /Walking on Water/);
      assert.doesNotMatch(rowsPage.textContent, /The Shepherd Who Stays/);

      const emptyPage = libraryPage({
        state: { layout, role: 'owner', items: [], query: '', archive: 'active', sort: 'recent' },
        view: 'rows', announce() {}, newDraft() {}
      });
      assert.ok(findOne(emptyPage, n => n.tag === 'svg' && n.hasClass('empty-books-art'), `${layout} empty state SVG book art`));
    } finally {
      delete globalThis.document;
    }
  }
});

test('Preaching Calendar renders under layouts A and C with exact heading, SVG mark, year strip, month grid, and edge-to-edge inspector', async () => {
  const { indexEvents } = await import('../public/assets/js/calendar-model.js');
  const { calendarPage } = await import('../public/assets/js/views/calendar.js');
  const index = indexEvents([
    { id: 'e1', sermon_id: sampleSermon.id, sermon_title: sampleSermon.title, preached_on: '2026-11-08', date_precision: 'exact', place_name: 'Riverbend Chapel', occasion: 'Sunday morning', sermon_archived: false },
    { id: 'e2', sermon_id: sampleSermon.id, sermon_title: sampleSermon.title, preached_on: null, date_precision: 'unknown', sermon_archived: false }
  ]);
  for (const layout of ['a', 'c']) {
    installFakeDom(layout);
    try {
      const page = calendarPage({ route: { name: 'library', view: 'calendar', y: 2026, m: 11, d: '2026-11-08' }, today: '2026-11-22', index });
      const heading = findOne(page, n => n.tag === 'h1');
      assert.equal(heading.textContent, 'Preaching Calendar');
      assert.ok(findOne(page, n => n.tag === 'svg' && n.hasClass('brand-mark')));
      assert.equal(findAll(page, n => n.hasClass('month-tile')).length, 12);
      assert.ok(findOne(page, n => n.tag === 'table' && n.hasClass('cal-table')));
      const inspector = findOne(page, n => n.hasClass('inspector-panel') && n.hasClass('edge-list-mobile'));
      assert.match(inspector.textContent, /Grace Enough for Today/);
      assert.match(page.textContent, /1 preaching in this workspace has no date/);
    } finally {
      delete globalThis.document;
    }
  }
});

test('Sermon detail and Find in notes tab render under layouts A and C with mini book cover, tabs, timeline, and edge-to-edge lists', async () => {
  const { sermonPage } = await import('../public/assets/js/views/sermon.js');
  const { notesPanel } = await import('../public/assets/js/views/search.js');
  for (const layout of ['a', 'c']) {
    installFakeDom(layout);
    try {
      const detail = sermonPage({
        sermon: sampleSermon, role: 'owner', tab: 'details', q: '',
        edit() {}, logPreaching() {}, archive() {}, restore() {}
      });
      assert.equal(findOne(detail, n => n.tag === 'h1').textContent, 'Grace Enough for Today');
      assert.ok(findOne(detail, n => n.tag === 'svg' && n.hasClass('detail-book-thumb'), `${layout} mini book cover`));
      assert.ok(findOne(detail, n => n.hasClass('tab-bar')));
      assert.ok(findOne(detail, n => n.hasClass('btn-primary') && n.getAttribute('data-action') === 'log'));
      assert.ok(findOne(detail, n => n.hasClass('panel') && n.hasClass('edge-list-mobile')));
      assert.equal(findAll(detail, n => n.hasClass('version-row')).length, 2);

      const notes = notesPanel({
        sermon: sampleSermon,
        route: { id: sampleSermon.id, tab: 'notes', q: 'grace' },
        result: {
          phase: 'ready',
          data: {
            versions: [
              { label: 'Original manuscript', source_type: 'google_doc', status: 'matched', match_count: 1, excerpts: [{ text: 'My grace is sufficient.', highlights: [{ start: 3, end: 8 }] }] }
            ]
          }
        },
        announce() {}, find() {}, retry() {}
      });
      const notesPage = sermonPage({
        sermon: sampleSermon, role: 'owner', tab: 'notes', q: 'grace', notes,
        edit() {}, logPreaching() {}, archive() {}, restore() {}
      });
      assert.ok(findOne(notesPage, n => n.hasClass('notes-panel')));
      assert.equal(findAll(notesPage, n => n.hasClass('btn-primary') && n.getAttribute('data-action') === 'log').length, 0);
      assert.equal(findOne(notesPage, n => n.tag === 'mark').textContent, 'grace');
    } finally {
      delete globalThis.document;
    }
  }
});

test('Loading, empty, error, denied states and panel render themed states under A and C and original states under Original', async () => {
  const { loadingState, emptyState, errorState, deniedState } = await import('../public/assets/js/views/states.js');
  const { panel } = await import('../public/assets/js/views/panel.js');
  for (const layout of ['a', 'c']) {
    installFakeDom(layout);
    try {
      const loading = loadingState('Loading library…');
      assert.ok(loading.hasClass('skeleton-list') && loading.hasClass('edge-list-mobile'));
      assert.equal(loading.getAttribute('role'), null, 'loading skeleton is not a live region');
      assert.equal(findAll(loading, n => n.hasClass('skeleton-row')).length, 6);

      const empty = emptyState({ title: 'Nothing here', body: 'Add a sermon.' });
      assert.ok(empty.hasClass('state-panel'));
      assert.ok(findOne(empty, n => n.tag === 'svg' && n.hasClass('empty-books-art')));

      const err = errorState({ title: 'Could not load', body: 'Try again.' });
      assert.ok(err.hasClass('state-panel-error'));
      assert.equal(err.getAttribute('role'), 'alert');
      assert.equal(findAll(err, n => n.tag === 'svg').length, 0);

      const denied = deniedState({ title: 'No access', body: 'Ask an owner.' });
      assert.ok(denied.hasClass('state-panel'));
      assert.ok(findOne(denied, n => n.tag === 'svg' && n.hasClass('empty-books-art')));

      let resolveLoad;
      const p = panel({ label: 'places', load: () => new Promise(r => { resolveLoad = r; }), render: () => document.createElement('div') });
      assert.ok(findOne(p.node, n => n.hasClass('panel-loading')));
      resolveLoad([]);
    } finally {
      delete globalThis.document;
    }
  }

  // Original preserves origin/main markup without themed book-art classes.
  installFakeDom('original');
  try {
    const { libraryPage } = await import('../public/assets/js/views/library.js');
    const { calendarPage } = await import('../public/assets/js/views/calendar.js');
    const { sermonPage } = await import('../public/assets/js/views/sermon.js');
    const { indexEvents } = await import('../public/assets/js/calendar-model.js');
    const lib = libraryPage({ state: { layout: 'original', role: 'owner', items: sampleItems, query: '', archive: 'active', sort: 'recent' }, view: 'covers', announce() {}, newDraft() {} });
    assert.ok(findOne(lib, n => n.hasClass('books-figure')));
    assert.equal(findAll(lib, n => n.hasClass('shelf-art')).length, 0);

    const cal = calendarPage({ route: { name: 'library', view: 'calendar', y: 2026, m: 11, d: null }, today: '2026-11-22', index: indexEvents([]) });
    assert.equal(findOne(cal, n => n.tag === 'h1').textContent, 'Preaching calendar');
    assert.equal(findAll(cal, n => n.hasClass('year-strip-panel')).length, 0);

    const det = sermonPage({ sermon: sampleSermon, role: 'owner', tab: 'details', q: '', edit() {}, logPreaching() {}, archive() {}, restore() {} });
    assert.ok(findOne(det, n => n.hasClass('detail-head')));
    assert.equal(findAll(det, n => n.hasClass('detail-book-thumb')).length, 0);

    const loading = loadingState('Loading…');
    assert.equal(findAll(loading, n => n.hasClass('skeleton-card')).length, 8);
    const empty = emptyState({ title: 'Empty', body: 'None' });
    assert.ok(findOne(empty, n => n.tag === 'img' && n.getAttribute('src') === '/assets/icon.svg'));
  } finally {
    delete globalThis.document;
  }
});

test('browse.css is linked in index.html, defines mobile edge-to-edge rules, and browse views contain no emoji or star glyphs', async () => {
  const html = await readFile(join(root, 'public/index.html'), 'utf8');
  assert.match(html, /href="\/assets\/themes\/browse\.css"/);
  const css = await readFile(join(root, 'public/assets/themes/browse.css'), 'utf8');
  assert.match(css, /\.edge-list-mobile/);
  assert.match(css, /\.notes-panel\s+\.version-results/);
  assert.match(css, /margin-left:\s*-16px/);
  for (const rel of [
    'public/assets/js/covers.js',
    'public/assets/js/views/covers.js',
    'public/assets/js/views/library.js',
    'public/assets/js/views/calendar.js',
    'public/assets/js/views/sermon.js',
    'public/assets/js/views/panel.js',
    'public/assets/js/views/states.js',
    'public/assets/themes/browse.css'
  ]) {
    const source = await readFile(join(root, rel), 'utf8');
    assert.doesNotMatch(source, /\p{Emoji_Presentation}|[\u2605\u2606\u2736-\u273f]/u, rel);
  }
});
