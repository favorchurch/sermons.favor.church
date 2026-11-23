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
  if (layout !== null) doc.documentElement.setAttribute('data-layout', layout);
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
  },
  {
    id: 'c1000000-0000-4000-8000-000000000003',
    title: 'Archived Message',
    series_name: 'all',
    scripture_references: ['John 3:16'],
    tags: ['gospel'],
    created_at: '2026-07-01 09:00:00',
    archived_at: '2026-10-01 09:00:00',
    version_count: 1,
    preachCount: 1,
    last: { date: '2026-07-12', precision: 'exact' }
  },
  {
    id: 'c1000000-0000-4000-8000-000000000004',
    title: 'Archived Series Opener',
    series_name: 'Enough',
    archived_at: '2026-10-01 09:00:00',
    preachCount: 0
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
    { id: 'v2', label: 'Short edit (28 min)', source_type: 'pdf', indexing_state: 'not_indexed' },
    { id: 'v3', label: 'External outline', source_type: 'external', source_url: 'https://example.test/outline', indexing_state: 'not_indexed' },
    { id: 'v4', label: 'Unsafe http link', source_type: 'external', source_url: 'http://example.test/insecure', indexing_state: 'not_indexed' }
  ],
  preaching_events: [
    { id: 'e1', preached_on: '2026-11-08', date_precision: 'exact', place_name: 'Riverbend Chapel', occasion: 'Sunday morning', version_id: 'v1' }
  ]
};

test('spineIndex and layoutOf handle determinism, series sharing, and fallback normalization', async () => {
  const { spineIndex } = await import('../public/assets/js/covers.js');
  const { layoutOf } = await import('../public/assets/js/views/covers.js');
  const idxA = spineIndex({ id: '1', title: 'One', series_name: 'Enough' });
  const idxB = spineIndex({ id: '2', title: 'Two', series_name: 'Enough' });
  assert.equal(idxA, idxB, 'sermons in the same series share a spine index');
  assert.ok(Number.isInteger(idxA) && idxA >= 0 && idxA <= 5);
  assert.ok(Number.isInteger(spineIndex({})) && spineIndex({}) >= 0 && spineIndex({}) <= 5);
  assert.equal(spineIndex({ id: 'x', title: 'Only Title' }), spineIndex({ id: 'y', title: 'Only Title' }));

  installFakeDom('c');
  try {
    assert.equal(layoutOf(), 'c');
    assert.equal(layoutOf('a'), 'a');
    assert.equal(layoutOf('unknown'), 'original');
  } finally {
    delete globalThis.document;
  }
  installFakeDom(null);
  try {
    assert.equal(layoutOf(), 'original');
  } finally {
    delete globalThis.document;
  }
});

test('Library covers, rows, and table views render under layouts A and C with interactive controls, edge cases, and viewer gating', async () => {
  const { libraryPage } = await import('../public/assets/js/views/library.js');
  for (const layout of ['a', 'c']) {
    installFakeDom(layout);
    try {
      for (const view of ['covers', 'rows', 'table']) {
        const state = { layout, workspaceId: 'w1', role: 'owner', items: sampleItems, query: '', archive: 'active', sort: 'recent' };
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
          assert.ok(findAll(strip, n => n.hasClass('series-pill')).length >= 4);
        }
        if (view === 'covers') {
          assert.equal(findAll(page, n => n.hasClass('sermon-card')).length, 2);
        } else if (view === 'rows') {
          const panel = findOne(page, n => n.hasClass('panel') && n.hasClass('edge-list-mobile'), `${layout} rows edge-to-edge`);
          assert.equal(findAll(panel, n => n.hasClass('sermon-row')).length, 2);
          assert.equal(findAll(panel, n => n.hasClass('row-spine')).length, 2);
        } else {
          const panel = findOne(page, n => n.hasClass('panel') && n.hasClass('edge-list-mobile'), `${layout} table edge-to-edge`);
          const table = findOne(panel, n => n.tag === 'table' && n.hasClass('data-table'));
          const body = findOne(table, n => n.tag === 'tbody');
          assert.deepEqual(findAll(body, n => n.tag === 'a').map(n => n.textContent), ['Walking on Water', 'The Shepherd Who Stays']);
        }
      }

      // Interactive series filter (named series, Standalone, and series named 'all'), search, Clear filters, sort, Active/Archived.
      const state = { layout, workspaceId: 'w1', role: 'owner', items: sampleItems, query: '', archive: 'active', sort: 'recent' };
      const rowsPage = libraryPage({ state, view: 'rows', announce() {}, newDraft() {} });
      const selectSeries = (value, label) => {
        if (layout === 'a') {
          const select = findOne(rowsPage, n => n.getAttribute('id') === 'sermon-series');
          select.value = value;
          select.dispatch('change');
        } else {
          const pill = findOne(rowsPage, n => n.hasClass('series-pill') && n.textContent === label);
          pill.dispatch('click');
          assert.equal(pill.getAttribute('aria-pressed'), 'true');
        }
      };

      selectSeries('series:Enough', 'Enough');
      assert.equal(findAll(rowsPage, n => n.hasClass('sermon-row')).length, 1);
      assert.match(rowsPage.textContent, /Walking on Water/);
      assert.doesNotMatch(rowsPage.textContent, /The Shepherd Who Stays/);

      // Standalone filtering ('__none__')
      selectSeries('__none__', 'Standalone');
      assert.equal(findAll(rowsPage, n => n.hasClass('sermon-row')).length, 1);
      assert.match(rowsPage.textContent, /The Shepherd Who Stays/);

      // Search + empty filter state + Clear filters button
      const searchInput = findOne(rowsPage, n => n.getAttribute('id') === 'sermon-search');
      searchInput.value = 'nomatchxyz';
      searchInput.dispatch('input');
      assert.equal(findAll(rowsPage, n => n.hasClass('sermon-row')).length, 0);
      assert.ok(findOne(rowsPage, n => n.tag === 'svg' && n.hasClass('empty-books-art')));
      const clearBtn = findOne(rowsPage, n => n.tag === 'button' && n.textContent === 'Clear filters');
      clearBtn.focus();
      clearBtn.dispatch('click');
      assert.equal(state.query, '');
      assert.equal(state.series, 'all');
      assert.equal(searchInput.value, '');
      assert.equal(document.activeElement?.getAttribute('id'), 'sermon-search');
      assert.equal(findAll(rowsPage, n => n.hasClass('sermon-row')).length, 2);

      // Sort by title changes order
      const sortSelect = findOne(rowsPage, n => n.getAttribute('id') === 'sermon-sort');
      sortSelect.value = 'title';
      sortSelect.dispatch('change');
      assert.deepEqual(
        findAll(rowsPage, n => n.hasClass('row-link')).map(n => n.textContent),
        ['The Shepherd Who Stays', 'Walking on Water']
      );

      // Active / Archived toggle + series literally named 'all' does not collide with All series
      const archivedBtn = findOne(rowsPage, n => n.tag === 'button' && n.textContent === 'Archived');
      archivedBtn.dispatch('click');
      assert.equal(archivedBtn.getAttribute('aria-pressed'), 'true');
      assert.equal(findOne(rowsPage, n => n.hasClass('results-scope')).textContent, 'Archived sermons');
      assert.equal(findAll(rowsPage, n => n.hasClass('sermon-row')).length, 2);
      selectSeries('series:all', 'all');
      assert.deepEqual(findAll(rowsPage, n => n.hasClass('row-link')).map(n => n.textContent), ['Archived Message']);

      // Stale '__none__' resets when no standalone sermons exist, and workspace switch resets state.series.
      const onlySeriesItems = [sampleItems[0]];
      const staleState = { layout, workspaceId: 'w1', seriesWorkspaceId: 'w1', series: '__none__', role: 'owner', items: onlySeriesItems, query: '', archive: 'active', sort: 'recent' };
      const stalePage = libraryPage({ state: staleState, view: 'rows', announce() {}, newDraft() {} });
      assert.equal(staleState.series, 'all', 'stale __none__ resets when !hasStandalone');
      assert.equal(findAll(stalePage, n => n.hasClass('sermon-row')).length, 1);

      const switchedState = { layout, workspaceId: 'w2', seriesWorkspaceId: 'w1', series: 'series:Enough', role: 'owner', items: sampleItems, query: '', archive: 'active', sort: 'recent' };
      const switchedPage = libraryPage({ state: switchedState, view: 'rows', announce() {}, newDraft() {} });
      assert.equal(switchedState.series, 'all', 'workspace switch resets series filter');
      assert.equal(findAll(switchedPage, n => n.hasClass('sermon-row')).length, 2);

      // Viewer role hides New draft / Create first draft and shows View-only access.
      const viewerEmpty = libraryPage({
        state: { layout, workspaceId: 'w1', role: 'viewer', items: [], query: '', archive: 'active', sort: 'recent' },
        view: 'rows', announce() {}, newDraft() {}
      });
      assert.equal(findAll(viewerEmpty, n => n.tag === 'button' && /draft/i.test(n.textContent)).length, 0);
      assert.match(viewerEmpty.textContent, /View-only access/);
      assert.ok(findOne(viewerEmpty, n => n.tag === 'svg' && n.hasClass('empty-books-art'), `${layout} empty state SVG book art`));
    } finally {
      delete globalThis.document;
    }
  }
});

test('Preaching Calendar renders under layouts A and C with needs_review, imprecise dates, empty states, and year bounds', async () => {
  const { indexEvents, MIN_YEAR, MAX_YEAR } = await import('../public/assets/js/calendar-model.js');
  const { calendarPage } = await import('../public/assets/js/views/calendar.js');
  const index = indexEvents([
    { id: 'e1', sermon_id: sampleSermon.id, sermon_title: sampleSermon.title, preached_on: '2026-11-08', date_precision: 'needs_review', raw_date: 'Nov 2026?', place_name: 'Riverbend Chapel', occasion: 'Sunday morning', sermon_archived: true },
    { id: 'e2', sermon_id: sampleSermon.id, sermon_title: 'Month Only Sermon', preached_on: '2026-10-01', date_precision: 'month', sermon_archived: false },
    { id: 'e3', sermon_id: sampleSermon.id, sermon_title: 'Year Only Sermon', preached_on: '2026-01-01', date_precision: 'year', sermon_archived: false },
    { id: 'e4', sermon_id: sampleSermon.id, sermon_title: sampleSermon.title, preached_on: null, date_precision: 'unknown', sermon_archived: false }
  ]);
  for (const layout of ['a', 'c']) {
    installFakeDom(layout);
    try {
      const page = calendarPage({ route: { name: 'library', view: 'calendar', y: 2026, m: 11, d: '2026-11-08' }, today: '2026-11-08', index });
      const heading = findOne(page, n => n.tag === 'h1');
      assert.equal(heading.textContent, 'Preaching Calendar');
      assert.ok(findOne(page, n => n.tag === 'svg' && n.hasClass('brand-mark')));
      assert.equal(findAll(page, n => n.hasClass('month-tile')).length, 12);
      assert.equal(findOne(page, n => n.hasClass('month-tile') && n.getAttribute('aria-current') === 'true').getAttribute('data-focus-key'), 'month-11');
      const activeDay = findOne(page, n => n.getAttribute('data-focus-key') === 'day-2026-11-08');
      assert.ok(activeDay.hasClass('is-today') && activeDay.hasClass('is-selected'));
      assert.equal(activeDay.getAttribute('aria-current'), 'true');
      assert.match(activeDay.getAttribute('aria-label'), /date needs review/i);
      const reviewTag = findOne(activeDay, n => n.hasClass('cal-day-tag') && n.hasClass('is-review'));
      assert.match(reviewTag.textContent, /Review/);
      assert.match(reviewTag.textContent, /!/);

      const inspector = findOne(page, n => n.hasClass('inspector-panel') && n.hasClass('edge-list-mobile'));
      assert.match(inspector.textContent, /Grace Enough for Today/);
      assert.match(inspector.textContent, /Archived/);
      assert.match(inspector.textContent, /Date needs review/);
      assert.match(inspector.textContent, /Recorded as “Nov 2026\?”/);
      assert.match(page.textContent, /1 preaching in this workspace has no date/);

      // Month-only event in October (datedCount === 0, monthOnly.length === 1) shows imprecise section and accurate inspector copy.
      const oct = calendarPage({ route: { name: 'library', view: 'calendar', y: 2026, m: 10, d: null }, today: '2026-11-08', index });
      assert.match(findOne(oct, n => n.hasClass('inspector-empty')).textContent, /listed below/);
      const imprecise = findOne(oct, n => n.hasClass('imprecise-section'));
      assert.ok(findAll(imprecise, n => n.hasClass('panel') && n.hasClass('edge-list-mobile')).length >= 2);
      assert.match(imprecise.textContent, /Month Only Sermon/);
      assert.match(imprecise.textContent, /Year Only Sermon/);

      // Selected day with no events shows empty day inspector.
      const emptyDay = calendarPage({ route: { name: 'library', view: 'calendar', y: 2026, m: 11, d: '2026-11-09' }, today: '2026-11-08', index });
      assert.match(findOne(emptyDay, n => n.hasClass('inspector-empty')).textContent, /No preachings recorded on this day/);

      // Year boundaries disable prev/next nav controls as spans.
      const minPage = calendarPage({ route: { name: 'library', view: 'calendar', y: MIN_YEAR, m: 1, d: null }, today: '2026-11-08', index });
      assert.ok(findAll(minPage, n => n.tag === 'span' && n.hasClass('icon-btn') && n.hasClass('is-disabled')).length >= 2);
      const maxPage = calendarPage({ route: { name: 'library', view: 'calendar', y: MAX_YEAR, m: 12, d: null }, today: '2026-11-08', index });
      assert.ok(findAll(maxPage, n => n.tag === 'span' && n.hasClass('icon-btn') && n.hasClass('is-disabled')).length >= 2);
    } finally {
      delete globalThis.document;
    }
  }
});

test('Sermon detail and Find in notes tab render under layouts A and C with action callbacks, viewer/archived states, and version links', async () => {
  const { sermonPage } = await import('../public/assets/js/views/sermon.js');
  const { notesPanel } = await import('../public/assets/js/views/search.js');
  for (const layout of ['a', 'c']) {
    installFakeDom(layout);
    try {
      const calls = [];
      const detail = sermonPage({
        sermon: sampleSermon, role: 'owner', tab: 'details', q: '',
        edit: () => calls.push('edit'),
        logPreaching: () => calls.push('log'),
        archive: () => calls.push('archive'),
        restore: () => calls.push('restore')
      });
      assert.equal(findOne(detail, n => n.tag === 'h1').textContent, 'Grace Enough for Today');
      assert.ok(findOne(detail, n => n.tag === 'svg' && n.hasClass('detail-book-thumb'), `${layout} mini book cover`));
      const tabs = findOne(detail, n => n.hasClass('tab-bar'));
      assert.equal(findOne(tabs, n => n.getAttribute('aria-current') === 'page').textContent, 'Details');

      const logBtn = findOne(detail, n => n.getAttribute('data-action') === 'log');
      assert.ok(logBtn.hasClass('btn-primary'));
      logBtn.dispatch('click');
      findOne(detail, n => n.getAttribute('data-action') === 'edit').dispatch('click');
      findOne(detail, n => n.getAttribute('data-action') === 'archive').dispatch('click');
      assert.deepEqual(calls, ['log', 'edit', 'archive']);

      assert.ok(findOne(detail, n => n.hasClass('panel') && n.hasClass('edge-list-mobile')));
      assert.equal(findAll(detail, n => n.hasClass('version-row')).length, 4);
      // Only google_doc and https:// external versions get .version-link; pdf and http:// do not.
      const links = findAll(detail, n => n.hasClass('version-link'));
      assert.equal(links.length, 2);
      assert.match(links[0].getAttribute('href'), /^https:\/\/docs\.google\.com\/document\/d\/doc1\/edit$/);
      assert.equal(links[1].getAttribute('href'), 'https://example.test/outline');

      // Notes tab keeps Log preaching button as secondary (btn without btn-primary) and marks Find in notes active.
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
      const notesLogBtn = findOne(notesPage, n => n.getAttribute('data-action') === 'log');
      assert.ok(notesLogBtn.hasClass('btn') && !notesLogBtn.hasClass('btn-primary'));
      assert.equal(findOne(notesPage, n => n.hasClass('tab-bar')).querySelector('[aria-current="page"]').textContent, 'Find in notes');
      assert.equal(findOne(notesPage, n => n.tag === 'mark').textContent, 'grace');

      // Archived sermon hides Log preaching, shows Archived pill and Restore button, and handles empty description/events/versions.
      let restored = false;
      const archived = sermonPage({
        sermon: { id: sampleSermon.id, title: 'Old Draft', archived_at: '2026-10-01 00:00:00', versions: [], preaching_events: [] },
        role: 'owner', tab: 'details', q: '',
        edit() {}, logPreaching() {}, archive() {}, restore: () => { restored = true; }
      });
      assert.equal(findAll(archived, n => n.getAttribute('data-action') === 'log').length, 0);
      assert.match(archived.textContent, /Archived/);
      assert.match(archived.textContent, /No description yet\./);
      assert.match(archived.textContent, /No versions attached yet\./);
      findOne(archived, n => n.getAttribute('data-action') === 'restore').dispatch('click');
      assert.equal(restored, true);

      // Viewer role hides all write actions and shows View-only access.
      const viewer = sermonPage({ sermon: sampleSermon, role: 'viewer', tab: 'details', q: '' });
      assert.equal(findAll(viewer, n => n.hasAttribute('data-action')).length, 0);
      assert.match(viewer.textContent, /View-only access/);
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

      const actionBtn = document.createElement('button');
      actionBtn.textContent = 'Create first draft';
      const empty = emptyState({ title: 'Nothing here', body: 'Add a sermon.', actions: [actionBtn] });
      assert.ok(empty.hasClass('state-panel'));
      assert.equal(empty.getAttribute('role'), 'status');
      assert.ok(findOne(empty, n => n.tag === 'svg' && n.hasClass('empty-books-art')));
      assert.ok(findOne(empty, n => n.hasClass('state-actions')));

      const err = errorState({ title: 'Could not load', body: 'Try again.' });
      assert.ok(err.hasClass('state-panel-error'));
      assert.equal(err.getAttribute('role'), 'alert');
      assert.equal(findAll(err, n => n.tag === 'svg').length, 0);

      const denied = deniedState({ title: 'No access', body: 'Ask an owner.' });
      assert.ok(denied.hasClass('state-panel'));
      assert.equal(denied.getAttribute('role'), 'alert');
      assert.ok(findOne(denied, n => n.tag === 'svg' && n.hasClass('empty-books-art')));

      let resolveLoad;
      const p = panel({
        label: 'places',
        load: () => new Promise(r => { resolveLoad = r; }),
        render: () => { const el = document.createElement('div'); el.setAttribute('class', 'loaded-ok'); return el; }
      });
      const loadingStatus = n => n.hasClass('muted') && n.getAttribute('role') === 'status';
      assert.ok(findOne(p.node, loadingStatus));
      resolveLoad([]);
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(findAll(p.node, loadingStatus).length, 0);
      assert.ok(findOne(p.node, n => n.hasClass('loaded-ok')));
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

function extractMediaBlock(css, query) {
  const idx = css.indexOf(query);
  assert.ok(idx >= 0, `expected ${query} block`);
  const open = css.indexOf('{', idx);
  let depth = 1;
  for (let i = open + 1; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  assert.fail(`unclosed ${query} block`);
}

test('browse.css is linked in index.html, scopes all selectors, defines responsive & mobile edge-to-edge rules, and browse views contain no emoji or star glyphs', async () => {
  const html = await readFile(join(root, 'public/index.html'), 'utf8');
  assert.match(html, /href="\/assets\/themes\/browse\.css"/);
  const rawCss = await readFile(join(root, 'public/assets/themes/browse.css'), 'utf8');
  const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

  const tablet = extractMediaBlock(css, '@media (max-width: 1120px)');
  assert.match(tablet, /\.detail-grid[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);

  const railTablet = extractMediaBlock(css, '@media (max-width: 960px)');
  assert.match(railTablet, /html\[data-layout="a"\]\s+\.sermon-row[\s\S]*grid-template-columns:\s*4px\s+minmax\(0,\s*1fr\)\s+18px/);

  const mobile = extractMediaBlock(css, '@media (max-width: 720px)');
  const [, edgeSelectors, edgeRules] = mobile.match(/([^{}]+\.edge-list-mobile[^{}]*)\{([^{}]+)\}/) || [];
  assert.deepEqual(edgeSelectors?.split(',').map(selector => selector.trim()).sort(),
    ['a', 'c'].flatMap(layout => ['.edge-list-mobile', '.notes-panel .version-results'].map(selector => `html[data-layout="${layout}"] ${selector}`)));
  assert.match(edgeRules, /margin-left:\s*-16px[\s\S]*margin-right:\s*-16px[\s\S]*border-radius:\s*0/);
  assert.match(mobile, /\.data-table\s+th[\s\S]*border:\s*0;\s*padding:\s*3px\s+0/);
  assert.match(mobile, /html\[data-layout="c"\]\s+\.filter-selects[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);

  const narrow = extractMediaBlock(css, '@media (max-width: 420px)');
  assert.match(narrow, /\.view-tabs[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)[\s\S]*overflow:\s*visible/);

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

test('layout C series filter pills constrain and wrap long labels', async () => {
  const css = await readFile(join(root, 'public/assets/themes/browse.css'), 'utf8');
  const [, pillRules] = css.match(/html\[data-layout="c"\] \.series-pill\s*\{([^}]+)\}/) || [];
  assert.ok(pillRules, 'series pill styles exist');
  assert.match(pillRules, /max-width:\s*100%;/);
  assert.match(pillRules, /overflow-wrap:\s*anywhere;/);
  assert.doesNotMatch(pillRules, /display:\s*(?:inline-)?flex;/);
});
