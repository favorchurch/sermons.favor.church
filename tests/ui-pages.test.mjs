// Search, Find in notes, Settings (Places, People & Access, Import Review, Docs & Privacy,
// Workspace). The app runs under a small fake DOM against the real API handler and in-memory D1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleRequest } from '../src/auth/app.ts';
import { sha256, SESSION_COOKIE, canManageMember as serverCanManage, canInvite as serverCanInvite } from '../src/auth/security.ts';
import { indexVersion } from '../src/search/index.ts';
import { fixture, ids, origin, ROLES } from './helpers/library-fixture.mjs';

const root = new URL('../', import.meta.url).pathname;
const J = path => `${root}public/assets/js/${path}`;
const csv = readFileSync(new URL('./fixtures/anonymous-history.csv', import.meta.url), 'utf8');

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
  select() {}
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
const one = (node, predicate, message = 'expected element not found') => {
  const found = all(node, predicate)[0];
  assert.ok(found, message);
  return found;
};
const textOf = node => node?.textContent ?? '';

// ---------------------------------------------------------------- modules under test

const { highlightParts, shapeResults, noteReason, truncated } = await import(J('search-model.js'));
const { parseRoute, hrefFor, notesHref } = await import(J('router.js'));
const { rowActions, filterRows, pageOf, flagLabel, statusInfo, PAGE_SIZE } = await import(J('import-model.js'));
const perms = await import(J('permissions.js'));
const { ApiError, describeError, createApi } = await import(J('api.js'));
const { pdfProblem } = await import(J('views/settings-docs.js'));
const { createApp } = await import(J('app.js'));

// ---------------------------------------------------------------- app harness (real API handler)

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
const buttons = (node, label) => all(node, e => e.tag === 'button' && textOf(e).trim() === label);
const byAction = (node, action) => all(node, e => e.getAttribute('data-action') === action);
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
async function until(check, message) {
  for (let i = 0; i < 150; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(message);
}
const openDialog = dom => one(dom.document.body, e => e.tag === 'dialog' && e.open, 'expected an open dialog');
const noDialog = dom => all(dom.document.body, e => e.tag === 'dialog' && e.open).length === 0;
const section = (node, title) => one(node, e => e.tag === 'section' && textOf(e.children[0]).startsWith(title), `section ${title}`);

async function withFixture(run) {
  const f = await fixture();
  try { await run(f); } finally { f.db.close(); }
}

// ---------------------------------------------------------------- library with indexed notes

const SERMON3 = 'c1000000-0000-4000-8000-000000000003';
const vid = n => `d1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOTES = 'Opening. For God so loved the world, John 3:16 says it plainly. Later we read Jn 3:16-18 again and Romans 8 closes the sermon.';
function consent(db, versionId, state = 'queued') {
  db.execute('UPDATE sermon_versions SET index_consent_by=?, index_consent_at=?, indexing_state=? WHERE id=?', [ids.owner, '2025-06-01 10:00:00', state, versionId]);
}
const index = (f, versionId, text) => indexVersion(f.env.DB, { workspaceId: ids.w1, versionId, text, actorId: ids.owner });

/** Sermon 1 gets versions in every search state. Sermon 3 is about John 3 but its notes never say so. */
async function withLibrary(run) {
  await withFixture(async f => {
    consent(f.db, ids.version1);
    await index(f, ids.version1, NOTES);
    f.db.execute('INSERT INTO sermons(id,workspace_id,title,scripture_passage) VALUES (?,?,?,?)', [SERMON3, ids.w1, 'Beta Light Sermon', 'John 3:14-17']);
    f.db.execute('INSERT INTO sermon_scripture_refs(workspace_id,sermon_id,position,reference_text) VALUES (?,?,0,?)', [ids.w1, SERMON3, 'John 3:14-17']);
    f.db.execute(`INSERT INTO sermon_versions(id,workspace_id,sermon_id,label,source_type,google_document_id) VALUES (?,?,?,?,?,?)`, [vid(3), ids.w1, SERMON3, 'Original', 'google_doc', 'thirdDocId0003']);
    consent(f.db, vid(3));
    await index(f, vid(3), 'This message speaks about harbors, lanterns and Psalm 107 only.');
    for (const [n, label, state] of [[10, 'Indexed miss', 'indexed'], [11, 'Waiting', 'awaiting_consent'], [12, 'Pulled', 'revoked'], [13, 'Fresh', 'not_indexed']]) {
      f.db.execute(`INSERT INTO sermon_versions(id,workspace_id,sermon_id,label,source_type) VALUES (?,?,?,?,?)`, [vid(n), ids.w1, ids.sermon1, label, 'pdf']);
      if (state === 'indexed') { consent(f.db, vid(n)); await index(f, vid(n), 'Only harbors and lanterns here.'); }
      else f.db.execute('UPDATE sermon_versions SET indexing_state=? WHERE id=?', [state, vid(n)]);
    }
    await run(f);
  });
}

// ================================================================= pure models

test('highlightParts splits text on ranges, merges overlaps and drops bad ranges', () => {
  assert.deepEqual(highlightParts('For God so loved', [{ start: 4, end: 7 }]), [
    { text: 'For ', mark: false }, { text: 'God', mark: true }, { text: ' so loved', mark: false }]);
  assert.deepEqual(highlightParts('abcdef', [{ start: 3, end: 5 }, { start: 0, end: 2 }, { start: 1, end: 4 }]), [
    { text: 'abcde', mark: true }, { text: 'f', mark: false }], 'unsorted and overlapping ranges merge');
  assert.deepEqual(highlightParts('abc', [{ start: 2, end: 99 }]), [{ text: 'ab', mark: false }, { text: 'c', mark: true }], 'end clamps to the text');
  for (const bad of [[{ start: 5, end: 9 }], [{ start: 2, end: 2 }], [{ start: -1, end: 2 }], [{ start: 'a', end: 2 }], [null], null, 'x']) {
    assert.deepEqual(highlightParts('abc', bad), [{ text: 'abc', mark: false }], JSON.stringify(bad));
  }
  assert.deepEqual(highlightParts(undefined, [{ start: 0, end: 1 }]), []);
  // Offsets are UTF-16 code units, so text after an astral character lines up.
  const text = 'a😀 Grace';
  assert.equal(highlightParts(text, [{ start: 4, end: 9 }]).find(p => p.mark).text, 'Grace');
  assert.equal(highlightParts(text, [{ start: 4, end: 9 }]).map(p => p.text).join(''), text);
});

test('scope decides which result groups are shown', () => {
  const data = { query: { kind: 'reference', label: 'John 3:16' }, metadataMatches: [{ sermon_id: 'a' }], notesMatches: [{ sermon_id: 'b' }] };
  assert.deepEqual(shapeResults(data, 'everything'), { reference: true, needsReference: false, showMetadata: true, metadata: data.metadataMatches, notes: data.notesMatches });
  assert.deepEqual(shapeResults(data, 'bible').metadata, data.metadataMatches);
  const inside = shapeResults(data, 'notes');
  assert.deepEqual([inside.showMetadata, inside.metadata.length, inside.notes.length], [false, 0, 1], 'Inside notes hides passage matches');
  const phrase = { query: { kind: 'phrase', label: 'grace' }, metadataMatches: [], notesMatches: [{ sermon_id: 'b' }] };
  assert.equal(shapeResults(phrase, 'bible').needsReference, true);
  assert.equal(shapeResults(phrase, 'bible').notes.length, 0);
  assert.equal(shapeResults(phrase, 'everything').showMetadata, false, 'phrases have no passage group');
  assert.deepEqual(shapeResults(null, 'everything').notes, []);
  assert.match(noteReason('pending'), /consent/);
  assert.match(noteReason('revoked'), /revoked/);
  assert.match(noteReason('unindexed'), /not been indexed/);
  assert.match(noteReason('mystery'), /cannot be searched/);
});

test('search, notes tab and settings routes parse strictly and round-trip', () => {
  const id = ids.sermon1;
  assert.deepEqual(parseRoute('#/search'), { name: 'search', q: '', scope: 'everything', archived: false });
  assert.deepEqual(parseRoute('#/search?q=%20John%20%203:16%20&scope=bible&archived=1'), { name: 'search', q: 'John 3:16', scope: 'bible', archived: true });
  assert.equal(parseRoute('#/search?scope=nonsense').scope, 'everything');
  assert.equal(parseRoute('#/search?q=' + 'x'.repeat(500)).q.length, 200);
  assert.equal(parseRoute('#/search/extra').name, 'missing');
  assert.deepEqual(parseRoute(`#/sermons/${id}?tab=notes&q=grace`), { name: 'sermon', id, tab: 'notes', q: 'grace' });
  assert.deepEqual(parseRoute(`#/sermons/${id}?tab=other`), { name: 'sermon', id });
  assert.deepEqual(parseRoute('#/settings'), { name: 'settings', section: 'places' });
  assert.equal(parseRoute('#/settings/nope').name, 'missing');
  assert.equal(parseRoute('#/settings/places/x').name, 'missing');
  assert.equal(parseRoute('#/settings/import?batch=not-a-uuid').batch, null);
  assert.equal(parseRoute(`#/settings/import?batch=${id.toUpperCase()}`).batch, id);
  assert.equal(parseRoute(`#/settings/docs?sermon=${id}`).sermon, id);
  for (const route of [
    { name: 'search', q: 'grace & peace?', scope: 'notes', archived: true },
    { name: 'sermon', id, tab: 'notes', q: 'John 3:16' },
    { name: 'settings', section: 'import', batch: id },
    { name: 'settings', section: 'docs', sermon: id },
    { name: 'settings', section: 'people' }
  ]) assert.deepEqual(parseRoute(hrefFor(route)), route, hrefFor(route));
  assert.equal(notesHref(id, 'a b'), `#/sermons/${id}?tab=notes&q=a+b`);
});

test('import rows allow only the actions the server accepts', () => {
  const row = (status, extra = {}) => ({ id: status, status, parse_outcome: 'parsed', proposed_title: 'T', flags: [], ...extra });
  const can = r => Object.entries(rowActions(r)).filter(([, v]) => v).map(([k]) => k);
  assert.deepEqual(can(row('unreviewed')), ['attest', 'ignore']);
  assert.deepEqual(can(row('attested')), ['ignore', 'approve']);
  assert.deepEqual(can(row('ignored')), ['attest']);
  assert.deepEqual(can(row('approved')), ['rollback']);
  assert.deepEqual(can(row('rollback_conflict')), ['rollback']);
  assert.deepEqual(can(row('rolled_back')), ['attest']);
  assert.deepEqual(can(row('unreviewed', { parse_outcome: 'invalid' })), ['ignore'], 'unreadable rows can only be ignored');
  assert.deepEqual(can(row('attested', { proposed_title: null })), ['ignore'], 'no title, no approval');
  assert.deepEqual(can(row('mystery')), []);
});

test('import filters and paging', () => {
  const rows = Array.from({ length: 120 }, (_, i) => ({
    id: String(i), status: i % 4 === 0 ? 'approved' : i % 4 === 1 ? 'rollback_conflict' : 'unreviewed',
    parse_outcome: i === 7 ? 'invalid' : 'parsed', flags: i % 3 === 0 ? ['undated'] : []
  }));
  assert.equal(filterRows(rows, 'all').length, 120);
  assert.equal(filterRows(rows, 'approved').length, 30);
  assert.equal(filterRows(rows, 'blocked').length, 30);
  assert.equal(filterRows(rows, 'invalid').length, 1);
  assert.equal(filterRows(rows, 'flagged').length, 40);
  assert.equal(filterRows(rows, 'unreviewed').length, 60);
  const last = pageOf(rows, 99);
  assert.deepEqual([last.page, last.pages, last.rows.length], [2, 3, 120 - 2 * PAGE_SIZE]);
  assert.deepEqual([pageOf([], 4).page, pageOf([], 4).pages], [0, 1]);
  assert.equal(flagLabel('suspected_duplicate_event'), 'Possible duplicate');
  assert.equal(flagLabel('some_new_flag'), 'some new flag');
  assert.deepEqual(statusInfo('approved'), { label: 'Approved', tone: 'good' });
  assert.equal(statusInfo('???').label, 'Unknown');
});

test('UI permission helpers match the server for every role pair', () => {
  const all4 = ['owner', 'admin', 'editor', 'viewer'];
  for (const actor of all4) {
    const offered = perms.assignableRoles(actor);
    for (const role of all4) assert.equal(offered.includes(role), serverCanInvite(actor, role), `${actor} may invite ${role}`);
    for (const existing of all4) {
      const ui = perms.canManageMember(actor, existing);
      assert.equal(ui, serverCanManage(actor, existing, 'revoke'), `${actor} may revoke ${existing}`);
      for (const next of all4) assert.equal(ui && offered.includes(next), serverCanManage(actor, existing, next), `${actor} may set ${existing} -> ${next}`);
    }
  }
  assert.deepEqual(all4.map(r => perms.canSeeSection(r, 'import')), [true, false, false, false]);
  assert.deepEqual(all4.map(r => perms.canSeeSection(r, 'people')), [true, true, false, false]);
  assert.deepEqual(all4.map(r => perms.canSeeSection(r, 'places')), [true, true, true, true]);
  assert.equal(perms.canSeeSection('owner', 'nope'), false);
});

test('new error messages are fixed text, and a PDF is pre-checked locally', () => {
  assert.match(describeError(new ApiError(429, 'invite_limit_reached')), /20 invitations/);
  assert.match(describeError(new ApiError(400, 'invalid_invitation')), /email address and role/);
  assert.match(describeError(new ApiError(409, 'invalid_row_state')), /row changed/);
  assert.match(describeError(new ApiError(415, 'unsupported_media_type')), /not a PDF/);
  assert.match(describeError(new ApiError(413, 'too_large')), /size limit/);
  assert.match(describeError(new ApiError(409, 'pdf_already_uploaded')), /already has a file/);
  assert.match(describeError(new ApiError(400, 'invalid_request', 'q')), /Check the search/);
  assert.match(describeError(new ApiError(400, 'invalid_request', 'target_place_id')), /place to merge into/);
  assert.ok(!describeError(new ApiError(409, '<script>')).includes('<'));
  assert.equal(pdfProblem(null), 'Choose a PDF file first.');
  assert.equal(pdfProblem({ name: 'a.pdf', type: 'application/pdf', size: 10 }), null);
  assert.equal(pdfProblem({ name: 'a.pdf', type: '', size: 10 }), null, 'some systems report no type');
  assert.match(pdfProblem({ name: 'a.txt', type: 'text/plain', size: 10 }), /not a PDF/);
  assert.match(pdfProblem({ name: 'a.txt', type: '', size: 10 }), /not a PDF/);
  assert.match(pdfProblem({ name: 'a.pdf', type: 'application/pdf', size: 11 * 1024 * 1024 }), /over 10 MB/);
  assert.match(pdfProblem({ name: 'a.pdf', type: 'application/pdf', size: 0 }), /empty/);
});

// ================================================================= members route (src/auth/app.ts)

test('GET members lists active accepted members for Owner and Admin only', async () => {
  await withFixture(async f => {
    f.db.execute('INSERT INTO user_accounts(id,email_normalized,display_name) VALUES (?,?,?),(?,?,?)', ['a0000000-0000-4000-8000-0000000000e1', 'pending@example.test', 'Pending Pat', 'a0000000-0000-4000-8000-0000000000e2', 'gone@example.test', 'Gone Gil']);
    f.db.execute('INSERT INTO workspace_memberships(workspace_id,account_id,role,accepted_at) VALUES (?,?,?,NULL)', [ids.w1, 'a0000000-0000-4000-8000-0000000000e1', 'editor']);
    f.db.execute('INSERT INTO workspace_memberships(workspace_id,account_id,role,accepted_at,revoked_at) VALUES (?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)', [ids.w1, 'a0000000-0000-4000-8000-0000000000e2', 'viewer']);
    for (const actor of ['owner', 'admin']) {
      const res = await f.call('GET', f.w('/members'), actor);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.headers.get('cache-control'), 'no-store, private');
      assert.deepEqual(res.json.members.map(m => [m.role, m.display_name, m.email]), [
        ['owner', 'owner', 'owner@example.test'], ['admin', 'admin', 'admin@example.test'],
        ['editor', 'editor', 'editor@example.test'], ['viewer', 'viewer', 'viewer@example.test']]);
      assert.deepEqual(Object.keys(res.json.members[0]).sort(), ['account_id', 'display_name', 'email', 'role']);
      assert.ok(!res.text.includes('Pending Pat') && !res.text.includes('Gone Gil') && !res.text.includes('owner2'), 'no pending, revoked or other-workspace people');
    }
    for (const actor of ['editor', 'viewer']) {
      const res = await f.call('GET', f.w('/members'), actor);
      assert.equal(res.status, 403, actor);
      assert.ok(!res.text.includes('@example.test'));
    }
    assert.equal((await f.call('GET', f.w('/members'), 'outsider')).status, 404);
    assert.equal((await f.call('GET', f.w('/members'), null)).status, 401);
    assert.equal((await f.call('GET', `/api/workspaces/${ids.w2}/members`, 'owner')).status, 404, 'another workspace is not readable');
    assert.equal((await f.call('POST', f.w('/members'), 'owner', {})).status, 404, 'only GET was added');
    assert.equal((await f.call('GET', f.w(`/members/${ids.viewer}`), 'owner')).status, 404);
  });
});

// ================================================================= header and global search

test('every role sees Library, Search and Settings, with the current page marked', async () => {
  await withFixture(async f => {
    for (const role of ROLES) {
      const dom = await mountApp(f, role);
      const nav = one(dom.header, e => e.tag === 'nav' && e.getAttribute('aria-label') === 'Main');
      assert.deepEqual(all(nav, e => e.tag === 'a').map(textOf), ['Library', 'Search', 'Settings']);
      assert.equal(textOf(one(nav, e => e.getAttribute('aria-current') === 'page')), 'Library');
      dom.go('#/search');
      assert.equal(textOf(one(dom.header, e => e.tag === 'a' && e.getAttribute('aria-current') === 'page')), 'Search');
      dom.go('#/settings/places');
      assert.equal(textOf(one(dom.header, e => e.tag === 'a' && e.getAttribute('aria-current') === 'page')), 'Settings');
    }
  });
});

test('the header search box goes to the search page', async () => {
  await withLibrary(async f => {
    const dom = await mountApp(f, 'viewer');
    const form = one(dom.header, e => e.tag === 'form');
    one(form, e => e.tag === 'input').value = '  John   3:16 ';
    form.dispatch('submit');
    assert.equal(dom.hash(), '#/search?q=John+3%3A16&scope=everything');
    await until(() => all(dom.root, e => e.hasClass('result-group')).length === 2, 'results');
    assert.equal(dom.document.activeElement.getAttribute('id'), 'page-title', 'focus moves to the page heading');
    one(form, e => e.tag === 'input').value = '   ';
    const before = dom.hash();
    form.dispatch('submit');
    assert.equal(dom.hash(), before, 'a blank box does nothing');
  });
});

const groupItems = (group) => all(group, e => e.hasClass('result-item'));

test('search separates Sermon passage (metadata) from Found in notes, with version and highlighted excerpt', async () => {
  await withLibrary(async f => {
    const dom = await mountApp(f, 'viewer', { hash: '#/search?q=John%203:16&scope=everything' });
    await until(() => all(dom.root, e => e.hasClass('result-group')).length === 2, 'two result groups');
    const passages = section(dom.root, 'Sermon passage (metadata)');
    const notes = section(dom.root, 'Found in notes');
    assert.notEqual(passages, notes);
    assert.deepEqual(groupItems(passages).map(item => textOf(one(item, e => e.hasClass('result-title')))).sort(), ['Alpha Hope Sermon', 'Beta Light Sermon']);
    assert.match(textOf(passages), /Its notes were not read/);
    assert.equal(all(passages, e => e.tag === 'mark').length, 0, 'passage matches never show note text');
    assert.ok(!textOf(passages).includes('God so loved'));
    // The notes group has only the sermon whose notes contain the reference, with its version name.
    const hits = groupItems(notes);
    assert.equal(hits.length, 1);
    assert.match(textOf(hits[0]), /Alpha Hope Sermon/);
    assert.match(textOf(hits[0]), /Original Alpha/);
    assert.match(textOf(hits[0]), /Google Doc/);
    assert.match(textOf(hits[0]), /2 matches/);
    const marks = all(hits[0], e => e.tag === 'mark').map(textOf);
    assert.ok(marks.length >= 1 && marks.every(m => /John 3:16|Jn 3:16/.test(m)), `marks: ${marks}`);
    assert.match(textOf(one(hits[0], e => e.hasClass('excerpt'))), /God so loved the world/);
    assert.match(textOf(dom.root), /3 results for Bible reference John 3:16/);
    // Deep link: opens Find in notes with the query prefilled.
    const link = one(hits[0], e => e.tag === 'a' && e.hasClass('result-title'));
    assert.equal(link.getAttribute('href'), notesHref(ids.sermon1, 'John 3:16'));
    for (const item of groupItems(passages)) assert.match(one(item, e => e.hasClass('result-title')).getAttribute('href'), /\?tab=notes&q=John\+3%3A16$/);
  });
});

test('scopes: Everything, Bible verses and Inside notes', async () => {
  await withLibrary(async f => {
    const dom = await mountApp(f, 'owner', { hash: '#/search?q=John%203:16&scope=notes' });
    await until(() => all(dom.root, e => e.hasClass('result-group')).length > 0, 'results');
    assert.equal(all(dom.root, e => e.hasClass('result-group')).length, 1, 'Inside notes hides passage matches');
    assert.match(textOf(dom.root), /Found in notes/);
    assert.ok(!textOf(dom.root).includes('Sermon passage (metadata)'));
    assert.deepEqual(all(dom.root, e => e.getAttribute('data-scope')).map(e => [e.getAttribute('data-scope'), e.getAttribute('aria-pressed')]),
      [['everything', 'false'], ['bible', 'false'], ['notes', 'true']]);

    // Switching scope re-filters the same response: no second search request.
    const searches = () => dom.calls.filter(c => c.includes('/search?')).length;
    assert.equal(searches(), 1);
    one(dom.root, e => e.getAttribute('data-scope') === 'bible').dispatch('click');
    await settle();
    assert.equal(all(dom.root, e => e.hasClass('result-group')).length, 2);
    assert.equal(searches(), 1, 'scope change does not search again');
    one(dom.root, e => e.getAttribute('data-scope') === 'everything').dispatch('click');
    await settle();
    assert.equal(searches(), 1);

    // A plain phrase: Bible verses explains itself, Everything shows notes only.
    dom.go('#/search?q=lanterns&scope=bible');
    await until(() => /is not a Bible reference/.test(textOf(dom.root)), 'reference hint');
    assert.equal(all(dom.root, e => e.hasClass('result-group')).length, 0);
    dom.go('#/search?q=lanterns&scope=everything');
    await until(() => all(dom.root, e => e.hasClass('result-group')).length === 1, 'phrase results');
    const hits = groupItems(section(dom.root, 'Found in notes'));
    assert.deepEqual(hits.map(item => textOf(one(item, e => e.hasClass('result-title')))).sort(), ['Alpha Hope Sermon', 'Beta Light Sermon']);
    assert.ok(!textOf(dom.root).includes('Sermon passage (metadata)'), 'a phrase has no passage group');
  });
});

test('search handles no query, no results, archived sermons, and server errors', async () => {
  await withLibrary(async f => {
    const dom = await mountApp(f, 'editor', { hash: '#/search' });
    assert.match(textOf(dom.root), /Notes only appear once an Owner has allowed them/);
    assert.equal(dom.calls.filter(c => c.includes('/search?')).length, 0, 'no request without a query');

    dom.go('#/search?q=zzzznotthere&scope=everything');
    await until(() => /0 results/.test(textOf(dom.root)), 'empty result');
    assert.match(textOf(dom.root), /No indexed notes contain this/);

    // Archived sermons are excluded until asked for.
    f.db.execute('UPDATE sermons SET archived_at=CURRENT_TIMESTAMP WHERE id=?', [SERMON3]);
    dom.go('#/search?q=Psalm%20107&scope=everything');
    await until(() => /0 results/.test(textOf(dom.root)), 'archived excluded');
    dom.go('#/search?q=Psalm%20107&scope=everything&archived=1');
    await until(() => /1 result for/.test(textOf(dom.root)), 'archived included');
    assert.equal(all(dom.root, e => e.getAttribute('id') === 'search-archived')[0].hasAttribute('checked'), true);

    // Ticking the box and searching asks for archived sermons too.
    const form = one(dom.root, e => e.tag === 'form');
    const box = one(dom.root, e => e.getAttribute('id') === 'search-archived');
    box.checked = false;
    form.dispatch('submit');
    assert.equal(dom.hash(), '#/search?q=Psalm+107&scope=everything');

    // Too many words is rejected by the server and shown as a fixed message.
    dom.go('#/search?q=' + encodeURIComponent('one two three four five six seven eight nine ten eleven twelve thirteen'));
    await until(() => all(dom.root, e => e.hasClass('inline-error')).length === 1, 'validation error');
    assert.match(textOf(dom.root), /Check the search and try again/);

    // A failing server: alert with Try again that runs the search once more.
    let failing = true;
    const base = realApi(f, 'editor');
    const flaky = { ...base, get: async path => { if (failing && path.includes('/search?')) throw new ApiError(503, 'temporarily_unavailable'); return base.get(path); } };
    const broken = await mountApp(f, 'editor', { api: flaky, hash: '#/search?q=lanterns' });
    await until(() => all(broken.root, e => e.hasClass('inline-error')).length === 1, 'error shown');
    assert.equal(one(broken.root, e => e.hasClass('inline-error')).getAttribute('role'), 'alert');
    assert.match(textOf(broken.root), /Search could not run/);
    failing = false;
    buttons(broken.root, 'Try again')[0].dispatch('click');
    await until(() => all(broken.root, e => e.hasClass('result-group')).length === 1, 'retry works');
  });
});

test('searching again with the same text runs the search again', async () => {
  await withLibrary(async f => {
    const dom = await mountApp(f, 'owner', { hash: '#/search?q=lanterns&scope=everything' });
    await until(() => all(dom.root, e => e.hasClass('result-group')).length === 1, 'first run');
    const count = () => dom.calls.filter(c => c.includes('/search?')).length;
    assert.equal(count(), 1);
    one(dom.root, e => e.tag === 'form').dispatch('submit'); // same address
    await until(() => count() === 2, 'second request');
  });
});

test('search results never inject note text as markup', async () => {
  await withFixture(async f => {
    consent(f.db, ids.version1);
    await index(f, ids.version1, 'Look: <img src=x onerror=alert(1)> and <b>grace</b> abounds.');
    const dom = await mountApp(f, 'owner', { hash: '#/search?q=grace&scope=notes' });
    await until(() => all(dom.root, e => e.tag === 'mark').length > 0, 'highlight');
    assert.equal(all(dom.root, e => e.tag === 'img' || e.tag === 'b').length, 0);
    assert.match(textOf(one(dom.root, e => e.hasClass('excerpt'))), /<img src=x onerror=alert\(1\)>/);
    assert.deepEqual(all(dom.root, e => e.tag === 'mark').map(textOf), ['grace']);
  });
});

// ================================================================= Find in notes tab

test('Find in notes lists matched, not in notes and not searchable versions', async () => {
  await withLibrary(async f => {
    const dom = await mountApp(f, 'viewer', { hash: notesHref(ids.sermon1, 'John 3:16') });
    await until(() => all(dom.root, e => e.hasClass('version-result')).length === 5, 'five versions');
    assert.equal(textOf(one(dom.root, e => e.tag === 'h1')), 'Alpha Hope Sermon');
    assert.equal(one(dom.root, e => e.getAttribute('id') === 'notes-q').value, 'John 3:16', 'query is prefilled');
    const byLabel = Object.fromEntries(all(dom.root, e => e.hasClass('version-result')).map(li => [textOf(one(li, e => e.tag === 'strong')), li]));
    assert.equal(byLabel['Original Alpha'].getAttribute('data-status'), 'matched');
    assert.match(textOf(byLabel['Original Alpha']), /Found in notes/);
    assert.match(textOf(byLabel['Original Alpha']), /2 matches/);
    assert.ok(all(byLabel['Original Alpha'], e => e.tag === 'mark').length >= 1);
    assert.equal(byLabel['Indexed miss'].getAttribute('data-status'), 'not_in_notes');
    assert.match(textOf(byLabel['Indexed miss']), /notes do not contain it/);
    assert.equal(all(byLabel['Indexed miss'], e => e.tag === 'mark').length, 0);
    assert.equal(byLabel.Waiting.getAttribute('data-status'), 'not_searchable');
    assert.match(textOf(byLabel.Waiting), /Waiting for an Owner to consent/);
    assert.match(textOf(byLabel.Pulled), /Access was revoked/);
    assert.match(textOf(byLabel.Fresh), /not been indexed/);
    for (const label of ['Waiting', 'Pulled', 'Fresh']) assert.equal(all(byLabel[label], e => e.tag === 'mark' || e.hasClass('excerpt')).length, 0, `${label} shows no text`);
    assert.match(textOf(dom.root), /Found in 1 version of 5/);
    // Tabs
    const tabs = one(dom.root, e => e.tag === 'nav' && e.getAttribute('aria-label') === 'Sermon sections');
    assert.equal(textOf(one(tabs, e => e.getAttribute('aria-current') === 'page')), 'Find in notes');
    assert.equal(all(dom.root, e => e.hasClass('detail-grid')).length, 0);
    // Back to Details keeps the sermon page as before.
    dom.go(`#/sermons/${ids.sermon1}`);
    assert.equal(all(dom.root, e => e.hasClass('detail-grid')).length, 1);
    assert.equal(textOf(one(dom.root, e => e.tag === 'nav' && e.getAttribute('aria-label') === 'Sermon sections', 'tabs').children.find(c => c.getAttribute?.('aria-current') === 'page')), 'Details');
  });
});

test('Find in notes: no query, new query, miss and unknown sermon', async () => {
  await withLibrary(async f => {
    const dom = await mountApp(f, 'editor', { hash: notesHref(ids.sermon1, '') });
    await until(() => all(dom.root, e => e.getAttribute('id') === 'notes-q').length === 1, 'panel');
    assert.match(textOf(dom.root), /Type something to see which versions/);
    assert.equal(dom.calls.filter(c => c.includes('find-in-notes')).length, 0);
    const input = one(dom.root, e => e.getAttribute('id') === 'notes-q');
    input.value = 'romans 8';
    one(dom.root, e => e.getAttribute('id') === 'notes-title').parent.querySelector('form').dispatch('submit');
    assert.equal(dom.hash(), notesHref(ids.sermon1, 'romans 8'));
    await until(() => all(dom.root, e => e.hasClass('version-result')).length === 5, 'results');
    assert.match(textOf(dom.root), /Found in 1 version of 5/);
    dom.go(notesHref(ids.sermon1, 'nothing like this'));
    await until(() => /Found in 0 versions of 5/.test(textOf(dom.root)), 'miss');
    // A sermon from another workspace is a not-found state, and the query never reaches it.
    const other = await mountApp(f, 'owner', { hash: notesHref(ids.sermon2, 'secret') });
    await settle();
    assert.match(textOf(other.root), /Sermon not found/);
    assert.equal(other.calls.filter(c => c.includes('find-in-notes')).length, 0);
  });
});

// ================================================================= Settings shell and role gating

const sectionNames = dom => all(one(dom.root, e => e.tag === 'nav' && e.getAttribute('aria-label') === 'Settings sections'), e => e.tag === 'a').map(textOf);

test('Settings shows each role only the sections it can use', async () => {
  await withFixture(async f => {
    const expected = {
      owner: ['Places', 'People & Access', 'Import Review', 'Docs & Privacy', 'Workspace'],
      admin: ['Places', 'People & Access', 'Docs & Privacy', 'Workspace'],
      editor: ['Places', 'Docs & Privacy', 'Workspace'],
      viewer: ['Places', 'Docs & Privacy', 'Workspace']
    };
    for (const role of ROLES) {
      const dom = await mountApp(f, role, { hash: '#/settings/places' });
      await settle();
      assert.deepEqual(sectionNames(dom), expected[role], role);
    }
  });
});

test('a hidden section is refused in the UI and never calls its API', async () => {
  await withFixture(async f => {
    const admin = await mountApp(f, 'admin', { hash: '#/settings/import' });
    await settle();
    assert.match(textOf(admin.root), /Import Review is not available to your role/);
    assert.equal(all(admin.root, e => e.getAttribute('id') === 'import-file').length, 0, 'no upload control');
    assert.ok(!admin.calls.some(c => c.includes('/imports')), 'no import request');
    const editor = await mountApp(f, 'editor', { hash: '#/settings/people' });
    await settle();
    assert.match(textOf(editor.root), /People & Access is not available to your role/);
    assert.equal(byAction(editor.root, 'invite').length, 0);
    assert.ok(!editor.calls.some(c => c.includes('/members')), 'no members request');
    const viewer = await mountApp(f, 'viewer', { hash: '#/settings/import?batch=' + ids.sermon1 });
    await settle();
    assert.ok(!viewer.calls.some(c => c.includes('/imports')));
    // The server still refuses even if someone calls it directly.
    assert.equal((await f.call('GET', f.w(`/imports/${ids.sermon1}/summary`), 'admin')).status, 403);
    assert.equal((await f.call('GET', f.w('/members'), 'editor')).status, 403);
  });
});

test('Workspace section shows the archive, the role, and what each role can do', async () => {
  await withFixture(async f => {
    const dom = await mountApp(f, 'editor', { hash: '#/settings/workspace' });
    await settle();
    const text = textOf(dom.root);
    assert.match(text, /Private Alpha/);
    assert.match(text, /Your role.*Editor/);
    assert.match(text, /1 sermon · 1 preaching/);
    const rows = all(dom.root, e => e.tag === 'tr' && e.parent.tag === 'tbody').map(tr => all(tr, e => e.tag === 'th' || e.tag === 'td').map(textOf));
    assert.deepEqual(rows, [
      ['View, search and download', 'Yes', 'Yes', 'Yes', 'Yes'],
      ['Add and edit sermons, places and PDFs', 'Yes', 'Yes', 'Yes', '—'],
      ['Invite people and change roles', 'Yes', 'Yes', '—', '—'],
      ['Consent to indexing, revoke it, review imports', 'Yes', '—', '—', '—']]);
    f.db.execute('INSERT INTO workspace_memberships(workspace_id,account_id,role,accepted_at) VALUES (?,?,?,CURRENT_TIMESTAMP)', [ids.w2, ids.editor, 'viewer']);
    const two = await mountApp(f, 'editor', { hash: '#/settings/workspace' });
    await settle();
    const open = buttons(two.root, 'Open Private Beta');
    assert.equal(open.length, 1);
    open[0].dispatch('click');
    await settle();
    assert.equal(two.app.state.workspaceId, ids.w2);
  });
});

// ================================================================= Places

test('places: rename, with conflicts shown on the field and the library refreshed', async () => {
  await withFixture(async f => {
    f.db.execute('INSERT INTO places(id,workspace_id,display_name) VALUES (?,?,?)', ['e0000000-0000-4000-8000-0000000000b1', ids.w1, 'Main Campus']);
    f.db.execute("INSERT INTO place_aliases(workspace_id,place_id,alias) VALUES (?,?,'The Harbor')", [ids.w1, ids.place1]);
    const dom = await mountApp(f, 'editor', { hash: '#/settings/places' });
    await until(() => all(dom.root, e => e.hasClass('place-row')).length === 2, 'two places');
    const rows = all(dom.root, e => e.hasClass('place-row'));
    assert.match(textOf(rows[0]), /Harbor Chapel.*1 preaching.*Also known as: The Harbor/);
    assert.match(textOf(rows[1]), /Main Campus.*0 preachings/);

    byAction(rows[0], 'rename')[0].dispatch('click');
    const dialog = openDialog(dom);
    const input = one(dialog, e => e.getAttribute('name') === 'display_name');
    assert.equal(input.value, 'Harbor Chapel');
    assert.equal(dom.document.activeElement, input);
    input.value = 'main campus'; // collides with another place, ignoring case
    one(dialog, e => e.tag === 'form').dispatch('submit');
    await settle(); await settle();
    assert.ok(dialog.open, 'stays open on conflict');
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.match(textOf(dialog), /already in use/);
    input.value = 'Harbor Church';
    one(dialog, e => e.tag === 'form').dispatch('submit');
    await until(() => noDialog(dom), 'dialog closed');
    await until(() => /Harbor Church/.test(textOf(dom.root)), 'list refreshed');
    assert.equal(f.db.query('SELECT display_name FROM places WHERE id=?', [ids.place1])[0].display_name, 'Harbor Church');
    assert.deepEqual(f.auditActions(), ['place.rename']);
    // The library's cached events pick up the new name.
    dom.go(`#/sermons/${ids.sermon1}`);
    await until(() => /Harbor Church/.test(textOf(dom.root)), 'sermon page shows new name');
  });
});

test('places: merge needs a preview of the impact before it can run', async () => {
  await withFixture(async f => {
    const target = 'e0000000-0000-4000-8000-0000000000b1', other = 'e0000000-0000-4000-8000-0000000000b2';
    f.db.execute('INSERT INTO places(id,workspace_id,display_name) VALUES (?,?,?),(?,?,?)', [target, ids.w1, 'Main Campus', other, ids.w1, 'Annex']);
    f.db.execute("INSERT INTO place_aliases(workspace_id,place_id,alias) VALUES (?,?,'Old Dock')", [ids.w1, ids.place1]);
    f.db.execute('INSERT INTO preaching_events(id,workspace_id,sermon_id,place_id,preached_on,date_precision) VALUES (?,?,?,?,?,?)', ['f0000000-0000-4000-8000-0000000000b1', ids.w1, ids.sermon1, target, '2025-05-04', 'exact']);
    const dom = await mountApp(f, 'admin', { hash: '#/settings/places' });
    await until(() => all(dom.root, e => e.hasClass('place-row')).length === 3, 'places');
    const harbor = all(dom.root, e => e.hasClass('place-row')).find(r => /Harbor Chapel/.test(textOf(r)));
    byAction(harbor, 'merge')[0].dispatch('click');
    const dialog = openDialog(dom);
    const submit = buttons(dialog, 'Merge places')[0];
    const select = one(dialog, e => e.tag === 'select');
    assert.ok(submit.hasAttribute('disabled'), 'merge is disabled before any preview');
    assert.deepEqual(all(select, e => e.tag === 'option').map(textOf), ['Choose a place…', 'Annex', 'Main Campus'], 'the place itself is not offered');

    // Preview with nothing chosen asks for a choice.
    byAction(dialog, 'preview')[0].dispatch('click');
    await settle();
    assert.match(textOf(dialog), /Choose the place to merge into/);

    select.value = target;
    select.dispatch('change');
    byAction(dialog, 'preview')[0].dispatch('click');
    await until(() => all(dialog, e => e.hasClass('impact')).length === 1, 'impact shown');
    const impact = textOf(one(dialog, e => e.hasClass('impact')));
    assert.match(impact, /Merging “Harbor Chapel” into “Main Campus”/);
    assert.match(impact, /move 1 preaching to “Main Campus” \(2 in total afterwards\)/);
    assert.match(impact, /move 1 alias: Old Dock/);
    assert.match(impact, /keep “Harbor Chapel” as an alias/);
    assert.match(impact, /cannot be undone/);
    assert.ok(!submit.hasAttribute('disabled'));
    assert.equal(f.db.query('SELECT COUNT(*) AS n FROM places')[0].n, 4, 'previewing changes nothing');

    // Changing the choice invalidates the preview.
    select.value = other;
    select.dispatch('change');
    assert.ok(submit.hasAttribute('disabled'));
    assert.equal(all(dialog, e => e.hasClass('impact')).length, 0);
    select.value = target;
    select.dispatch('change');
    byAction(dialog, 'preview')[0].dispatch('click');
    await until(() => !submit.hasAttribute('disabled'), 'preview again');
    one(dialog, e => e.tag === 'form').dispatch('submit');
    await until(() => noDialog(dom), 'merged');
    assert.deepEqual(f.db.query('SELECT display_name FROM places ORDER BY display_name').map(r => r.display_name), ['Annex', 'Beta Chapel', 'Main Campus']);
    assert.equal(f.db.query('SELECT COUNT(*) AS n FROM preaching_events WHERE place_id=?', [target])[0].n, 2);
    assert.deepEqual(f.db.query('SELECT alias FROM place_aliases WHERE place_id=? ORDER BY alias', [target]).map(r => r.alias), ['Harbor Chapel', 'Old Dock']);
    assert.deepEqual(f.auditActions(), ['place.merge']);
    await until(() => all(dom.root, e => e.hasClass('place-row')).length === 2, 'list refreshed');
  });
});

test('places: a viewer sees the list with no controls, and the server still refuses', async () => {
  await withFixture(async f => {
    const dom = await mountApp(f, 'viewer', { hash: '#/settings/places' });
    await until(() => all(dom.root, e => e.hasClass('place-row')).length === 1, 'list');
    assert.match(textOf(dom.root), /view-only access/);
    assert.equal(byAction(dom.root, 'rename').length + byAction(dom.root, 'merge').length, 0);
    assert.equal((await f.call('PATCH', f.w(`/places/${ids.place1}`), 'viewer', { display_name: 'X' })).status, 403);
  });
});

// ================================================================= People & Access

const memberRow = (dom, name) => one(dom.root, e => e.tag === 'tr' && e.parent.tag === 'tbody' && textOf(e.children[0]).startsWith(name), `member ${name}`);

test('people: Owner invites with a one-time token that is shown once and can be accepted', async () => {
  await withFixture(async f => {
    const dom = await mountApp(f, 'owner', { hash: '#/settings/people' });
    await until(() => all(dom.root, e => e.tag === 'tr' && e.parent.tag === 'tbody').length === 4, 'members');
    assert.deepEqual(all(dom.root, e => e.tag === 'tr' && e.parent.tag === 'tbody').map(tr => textOf(tr.children[2])), ['Owner', 'Admin', 'Editor', 'Viewer']);
    assert.match(textOf(memberRow(dom, 'owner')), /You/);
    assert.equal(byAction(memberRow(dom, 'owner'), 'role').length, 0, 'you cannot change yourself');

    byAction(dom.root, 'invite')[0].dispatch('click');
    const dialog = openDialog(dom);
    assert.deepEqual(all(one(dialog, e => e.tag === 'select'), e => e.tag === 'option').map(textOf), ['Admin', 'Editor', 'Viewer'], 'Owner is never offered');
    // A bad email is reported on the field.
    one(dialog, e => e.getAttribute('name') === 'email').value = 'nonsense';
    one(dialog, e => e.tag === 'form').dispatch('submit');
    await settle(); await settle();
    assert.ok(dialog.open);
    assert.match(textOf(dialog), /email address and role/);
    one(dialog, e => e.getAttribute('name') === 'email').value = 'outsider@example.test';
    one(dialog, e => e.tag === 'select').value = 'editor';
    one(dialog, e => e.tag === 'form').dispatch('submit');
    await until(() => all(dom.document.body, e => e.getAttribute('id') === 'invite-token').length === 1, 'token dialog');
    const tokenInput = one(dom.document.body, e => e.getAttribute('id') === 'invite-token');
    const token = tokenInput.value;
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(tokenInput.hasAttribute('readonly'), true);
    const shown = textOf(openDialog(dom));
    assert.match(shown, /outsider@example\.test as Editor/);
    assert.match(shown, /shown only once/);
    assert.match(shown, /no email is sent/);
    assert.match(shown, /expires in 7 days/);
    // Only the hash is stored.
    const stored = f.db.query('SELECT token_hash, invited_role FROM workspace_invitations')[0];
    assert.equal(stored.token_hash, await sha256(token));
    assert.notEqual(stored.token_hash, token);
    assert.equal(stored.invited_role, 'editor');
    // Copy button: falls back to a hint when the clipboard is unavailable.
    byAction(openDialog(dom), 'copy')[0].dispatch('click');
    await settle();
    assert.match(textOf(dom.toast), /Code copied|Select the code and copy it/);
    buttons(openDialog(dom), 'Done')[0].dispatch('click');
    assert.ok(noDialog(dom));
    assert.ok(!textOf(dom.document.body).includes(token), 'the token is gone from the page once closed');
    assert.ok(!dom.hash().includes(token));
    // The invitee redeems it with the matching account.
    const accepted = await f.call('POST', '/api/invitations/accept', 'outsider', { token });
    assert.equal(accepted.status, 200, accepted.text);
    dom.go('#/settings/people');
    await dom.app.start();
    dom.go('#/settings/people');
    await until(() => all(dom.root, e => e.tag === 'tr' && e.parent.tag === 'tbody').length === 5, 'new member listed');
    assert.match(textOf(memberRow(dom, 'outsider')), /Editor/);
  });
});

test('people: role change and revoke use confirmations and the right rules', async () => {
  await withFixture(async f => {
    const dom = await mountApp(f, 'owner', { hash: '#/settings/people' });
    await until(() => all(dom.root, e => e.tag === 'tr' && e.parent.tag === 'tbody').length === 4, 'members');
    byAction(memberRow(dom, 'viewer'), 'role')[0].dispatch('click');
    let dialog = openDialog(dom);
    assert.deepEqual(all(one(dialog, e => e.tag === 'select'), e => e.tag === 'option').map(textOf), ['Admin', 'Editor', 'Viewer']);
    assert.equal(one(dialog, e => e.tag === 'select').value, 'viewer');
    one(dialog, e => e.tag === 'select').value = 'editor';
    one(dialog, e => e.tag === 'form').dispatch('submit');
    await until(() => noDialog(dom), 'closed');
    await until(() => /Editor/.test(textOf(memberRow(dom, 'viewer')).replace('viewer', '')), 'row shows the new role');
    assert.equal(f.db.query('SELECT role FROM workspace_memberships WHERE account_id=? AND workspace_id=?', [ids.viewer, ids.w1])[0].role, 'editor');
    assert.deepEqual(f.auditActions(), ['membership.role_change']);

    byAction(memberRow(dom, 'editor'), 'revoke')[0].dispatch('click');
    dialog = openDialog(dom);
    assert.match(textOf(dialog), /editor \(editor@example\.test\) will lose access/);
    assert.equal(dom.document.activeElement.tag, 'button');
    assert.equal(textOf(dom.document.activeElement), 'Cancel', 'Cancel has focus');
    assert.equal(f.db.query('SELECT revoked_at FROM workspace_memberships WHERE account_id=?', [ids.editor])[0].revoked_at, null, 'nothing happens before confirming');
    buttons(dialog, 'Revoke access')[0].dispatch('click');
    one(dialog, e => e.tag === 'form').dispatch('submit');
    await until(() => noDialog(dom), 'revoked');
    await until(() => all(dom.root, e => e.tag === 'tr' && e.parent.tag === 'tbody').length === 3, 'row gone');
    assert.notEqual(f.db.query('SELECT revoked_at FROM workspace_memberships WHERE account_id=? AND workspace_id=?', [ids.editor, ids.w1])[0].revoked_at, null);
    assert.equal((await f.call('GET', f.w('/sermons'), 'editor')).status, 404, 'access is gone');
  });
});

test('people: an Admin manages Editors and Viewers only, and invites no Admins', async () => {
  await withFixture(async f => {
    const dom = await mountApp(f, 'admin', { hash: '#/settings/people' });
    await until(() => all(dom.root, e => e.tag === 'tr' && e.parent.tag === 'tbody').length === 4, 'members');
    assert.equal(byAction(memberRow(dom, 'owner'), 'role').length + byAction(memberRow(dom, 'owner'), 'revoke').length, 0, 'owner is untouchable');
    assert.equal(byAction(memberRow(dom, 'admin'), 'role').length, 0, 'not even yourself');
    assert.equal(byAction(memberRow(dom, 'editor'), 'role').length, 1);
    assert.equal(byAction(memberRow(dom, 'viewer'), 'revoke').length, 1);
    byAction(memberRow(dom, 'editor'), 'role')[0].dispatch('click');
    assert.deepEqual(all(one(openDialog(dom), e => e.tag === 'select'), e => e.tag === 'option').map(textOf), ['Editor', 'Viewer']);
    buttons(openDialog(dom), 'Cancel')[0].dispatch('click');
    byAction(dom.root, 'invite')[0].dispatch('click');
    assert.deepEqual(all(one(openDialog(dom), e => e.tag === 'select'), e => e.tag === 'option').map(textOf), ['Editor', 'Viewer']);
  });
});

test('people: the invitation limit and server errors are shown without server text', async () => {
  await withFixture(async f => {
    for (let i = 0; i < 20; i++) await f.call('POST', f.w('/invitations'), 'owner', { email: `n${i}@example.test`, role: 'viewer' });
    const dom = await mountApp(f, 'owner', { hash: '#/settings/people' });
    await until(() => byAction(dom.root, 'invite').length === 1, 'ready');
    byAction(dom.root, 'invite')[0].dispatch('click');
    const dialog = openDialog(dom);
    one(dialog, e => e.getAttribute('name') === 'email').value = 'late@example.test';
    one(dialog, e => e.tag === 'form').dispatch('submit');
    await settle(); await settle();
    assert.ok(dialog.open);
    assert.match(textOf(dialog), /limit of 20 invitations a day/);
    assert.equal(all(dom.document.body, e => e.getAttribute('id') === 'invite-token').length, 0);
  });
});

test('a person with no archive can redeem an invitation code', async () => {
  await withFixture(async f => {
    const invite = await f.call('POST', f.w('/invitations'), 'owner', { email: 'outsider@example.test', role: 'viewer' });
    const dom = await mountApp(f, 'outsider');
    assert.equal(dom.app.state.phase, 'no-workspace');
    assert.equal(all(dom.header, e => e.tag === 'nav').length, 0, 'no navigation before there is an archive');
    const form = all(dom.root, e => e.tag === 'form')[1];
    one(form, e => e.getAttribute('name') === 'token').value = 'wrong-code';
    form.dispatch('submit');
    await until(() => !one(form, e => e.hasClass('form-error')).hasAttribute('hidden'), 'error shown');
    assert.match(textOf(form), /does not work/);
    one(form, e => e.getAttribute('name') === 'token').value = `  ${invite.json.token} `;
    form.dispatch('submit');
    await until(() => dom.app.state.phase === 'ready', 'joined');
    assert.equal(dom.app.state.role, 'viewer');
    assert.equal(dom.app.state.workspaceId, ids.w1);
  });
});

// ================================================================= Import Review

const importRow = (dom, number) => one(dom.root, e => e.tag === 'tr' && e.parent.tag === 'tbody' && textOf(e.children[1]) === String(number), `row ${number}`);
const rowStatus = (f, number) => f.db.query('SELECT status FROM import_review_rows WHERE source_row=? AND workspace_id=?', [number, ids.w1])[0]?.status;
function chooseFile(dom, selector, file) { one(dom.root, selector).files = [file]; }
const csvFile = (text = csv) => new File([text], 'history.csv', { type: 'text/csv' });

async function openImport(f) {
  const dom = await mountApp(f, 'owner', { hash: '#/settings/import' });
  await settle();
  chooseFile(dom, e => e.getAttribute('id') === 'import-file', csvFile());
  byAction(dom.root, 'stage')[0].dispatch('click');
  try { await until(() => all(dom.root, e => e.hasClass('import-table')).length === 1, 'review table'); }
  catch (e) { console.error('DBGSTATE', textOf(dom.root).slice(0, 600), dom.calls.slice(4).join(',')); throw e; }
  return dom;
}

test('import review: upload, summary counts and a row table with flags', async () => {
  await withFixture(async f => {
    const dom = await mountApp(f, 'owner', { hash: '#/settings/import' });
    await settle();
    assert.match(textOf(dom.root), /No file is open/);
    // Nothing chosen, then a wrong file.
    byAction(dom.root, 'stage')[0].dispatch('click');
    await settle();
    assert.match(textOf(dom.root), /Choose the history CSV first/);
    chooseFile(dom, e => e.getAttribute('id') === 'import-file', csvFile('not,the,right\nfile'));
    byAction(dom.root, 'stage')[0].dispatch('click');
    await until(() => /could not be staged\. It may be too large, or not the unedited history CSV/.test(textOf(dom.root)), 'bad csv message');
    assert.equal(f.db.query('SELECT COUNT(*) AS n FROM import_review_batches')[0].n, 0);

    chooseFile(dom, e => e.getAttribute('id') === 'import-file', csvFile());
    byAction(dom.root, 'stage')[0].dispatch('click');
    await until(() => all(dom.root, e => e.hasClass('import-table')).length === 1, 'review table');
    const batch = f.db.query('SELECT id FROM import_review_batches')[0].id;
    assert.equal(dom.hash(), `#/settings/import?batch=${batch}`, 'the batch is in the address, so a reload reopens it');
    const counts = Object.fromEntries(all(dom.root, e => e.hasClass('tile')).map(t => [t.getAttribute('data-count'), textOf(t.children[0])]));
    assert.deepEqual(counts, { total: '4', parsed: '3', invalid: '1', flagged: '4', attested: '0', approved: '0' });
    assert.equal(all(dom.root, e => e.tag === 'tr' && e.parent.tag === 'tbody').length, 4);
    assert.match(textOf(dom.root), /4 rows/);
    const first = importRow(dom, 5);
    assert.match(textOf(first), /A New Beginning, Again/);
    assert.ok(all(first, e => e.getAttribute('data-flag') === 'first_day_precision_review').length === 1);
    assert.match(textOf(first), /Dated the 1st: check precision/);
    assert.match(textOf(first), /Owner unknown/);
    assert.match(textOf(first), /Needs review/);
    assert.equal(f.db.query("SELECT COUNT(*) AS n FROM sermons WHERE title='A New Beginning, Again'")[0].n, 0, 'staging creates nothing');

    // The same file again reopens the same review.
    dom.go('#/settings/import');
    await settle();
    chooseFile(dom, e => e.getAttribute('id') === 'import-file', csvFile());
    byAction(dom.root, 'stage')[0].dispatch('click');
    await until(() => dom.hash() === `#/settings/import?batch=${batch}`, 'same batch');
    assert.equal(f.db.query('SELECT COUNT(*) AS n FROM import_review_batches')[0].n, 1);
    assert.match(textOf(dom.toast), /already staged/);
  });
});

test('import review: attest needs confirmation, approve is separate, ignore and rollback work', async () => {
  await withFixture(async f => {
    const dom = await openImport(f);
    const first = importRow(dom, 5);
    assert.equal(byAction(first, 'approve').length, 0, 'cannot approve before attesting');
    byAction(first, 'attest')[0].dispatch('click');
    let dialog = openDialog(dom);
    assert.match(textOf(dialog), /you confirm that you, as Owner of this archive, are responsible/);
    assert.match(textOf(dialog), /Nothing is created yet/);
    assert.equal(textOf(dom.document.activeElement), 'Cancel');
    assert.equal(rowStatus(f, 5), 'unreviewed', 'opening the dialog changes nothing');
    buttons(dialog, 'Cancel')[0].dispatch('click');
    assert.equal(rowStatus(f, 5), 'unreviewed');

    byAction(first, 'attest')[0].dispatch('click');
    dialog = openDialog(dom);
    one(dialog, e => e.tag === 'form').dispatch('submit');
    await until(() => rowStatus(f, 5) === 'attested' && noDialog(dom), 'attested');
    await until(() => byAction(importRow(dom, 5), 'approve').length === 1, 'approve offered');
    assert.match(textOf(importRow(dom, 5)), /Attested/);
    assert.equal(f.db.query("SELECT COUNT(*) AS n FROM sermons WHERE title='A New Beginning, Again'")[0].n, 0, 'attesting alone creates nothing');
    assert.equal(textOf(one(dom.root, e => e.hasClass('tile') && e.getAttribute('data-count') === 'attested').children[0]), '1');
    assert.equal(dom.document.activeElement, one(dom.root, e => e.hasClass('review-status')), 'focus moves to the status line');
    assert.match(textOf(dom.root), /1 row attested/);

    byAction(importRow(dom, 5), 'approve')[0].dispatch('click');
    await until(() => rowStatus(f, 5) === 'approved', 'approved');
    await until(() => byAction(importRow(dom, 5), 'rollback').length === 1, 'rollback offered');
    assert.equal(f.db.query("SELECT COUNT(*) AS n FROM sermons WHERE title='A New Beginning, Again'")[0].n, 1);
    assert.match(textOf(dom.root), /Row 5 approved/);
    // The library the app holds is refreshed.
    assert.ok(dom.app.state.items.some(item => item.title === 'A New Beginning, Again'));

    // Rollback asks first, and succeeds when nothing was edited.
    byAction(importRow(dom, 5), 'rollback')[0].dispatch('click');
    dialog = openDialog(dom);
    assert.match(textOf(dialog), /only if nobody has edited or used them/);
    assert.equal(rowStatus(f, 5), 'approved', 'not rolled back before confirming');
    one(dialog, e => e.tag === 'form').dispatch('submit');
    await until(() => rowStatus(f, 5) === 'rolled_back' && noDialog(dom), 'rolled back');
    assert.equal(f.db.query("SELECT COUNT(*) AS n FROM sermons WHERE title='A New Beginning, Again'")[0].n, 0);
    await until(() => /Row rolled back/.test(textOf(dom.root)), 'message');
    assert.equal(byAction(importRow(dom, 5), 'attest').length, 1, 'a rolled-back row can be reviewed again');
    assert.equal(textOf(byAction(importRow(dom, 5), 'attest')[0]), 'Review again');

    // Ignore needs no dialog and is reversible through Review again.
    const second = Number(f.db.query("SELECT source_row FROM import_review_rows WHERE parse_outcome='parsed' AND source_row<>5 ORDER BY source_row")[0].source_row);
    byAction(importRow(dom, second), 'ignore')[0].dispatch('click');
    await until(() => rowStatus(f, second) === 'ignored', 'ignored');
    await until(() => textOf(byAction(importRow(dom, second), 'attest')[0]) === 'Review again', 'review again offered');
    assert.deepEqual(f.auditActions().filter(a => a.startsWith('import.')), ['import.upload', 'import.attest', 'import.approve', 'import.rollback', 'import.ignore']);
  });
});

test('import review: an edited sermon blocks rollback and the row says so', async () => {
  await withFixture(async f => {
    const dom = await openImport(f);
    byAction(importRow(dom, 5), 'attest')[0].dispatch('click');
    one(openDialog(dom), e => e.tag === 'form').dispatch('submit');
    await until(() => byAction(importRow(dom, 5), 'approve').length === 1, 'attested');
    byAction(importRow(dom, 5), 'approve')[0].dispatch('click');
    await until(() => byAction(importRow(dom, 5), 'rollback').length === 1, 'approved');
    f.db.execute("UPDATE sermons SET updated_at=CURRENT_TIMESTAMP WHERE title='A New Beginning, Again'");
    byAction(importRow(dom, 5), 'rollback')[0].dispatch('click');
    one(openDialog(dom), e => e.tag === 'form').dispatch('submit');
    await until(() => rowStatus(f, 5) === 'rollback_conflict' && noDialog(dom), 'conflict');
    await until(() => /edited or is in use/.test(textOf(dom.root)), 'conflict message');
    assert.match(textOf(importRow(dom, 5)), /Rollback blocked/);
    assert.match(textOf(importRow(dom, 5)), /Resolve it by hand/);
    assert.equal(f.db.query("SELECT COUNT(*) AS n FROM sermons WHERE title='A New Beginning, Again'")[0].n, 1, 'the edited sermon is kept');
    assert.equal(textOf(byAction(importRow(dom, 5), 'rollback')[0]), 'Try rollback again');
  });
});

test('import review: bulk attest and approve, filters, and unreadable rows', async () => {
  await withFixture(async f => {
    const dom = await openImport(f);
    const parsedRows = f.db.query("SELECT source_row FROM import_review_rows WHERE parse_outcome='parsed' ORDER BY source_row").map(r => Number(r.source_row));
    const invalidRow = Number(f.db.query("SELECT source_row FROM import_review_rows WHERE parse_outcome<>'parsed'")[0].source_row);
    assert.equal(parsedRows.length, 3);
    const bad = importRow(dom, invalidRow);
    assert.deepEqual(all(bad, e => e.tag === 'button').map(b => b.getAttribute('data-action')), ['ignore'], 'an unreadable row can only be ignored');
    assert.equal(all(bad, e => e.tag === 'input').length, 0, 'and cannot be selected');
    assert.match(textOf(bad), /Could not be read/);

    const bulkAttest = () => byAction(dom.root, 'attest-selected')[0];
    assert.ok(bulkAttest().hasAttribute('disabled'));
    for (const number of parsedRows.slice(0, 2)) {
      const box = one(importRow(dom, number), e => e.tag === 'input');
      box.checked = true;
      box.dispatch('change');
    }
    assert.match(textOf(bulkAttest()), /Attest selected \(2\)/);
    assert.match(textOf(dom.root), /2 rows selected/);
    assert.ok(!bulkAttest().hasAttribute('disabled'));
    bulkAttest().dispatch('click');
    const dialog = openDialog(dom);
    assert.match(textOf(dialog), /Attest 2 rows\?/);
    one(dialog, e => e.tag === 'form').dispatch('submit');
    await until(() => parsedRows.slice(0, 2).every(n => rowStatus(f, n) === 'attested') && noDialog(dom), 'two attested');
    assert.equal(rowStatus(f, parsedRows[2]), 'unreviewed');
    assert.match(textOf(dom.root), /0 rows selected/, 'selection clears after attesting');

    // Select all on the page selects only rows that can take a bulk action, then approve the attested ones.
    const header = one(dom.root, e => e.tag === 'thead');
    const all1 = one(header, e => e.tag === 'input');
    all1.checked = true;
    all1.dispatch('change');
    assert.match(textOf(bulkAttest()), /Attest selected \(1\)/, 'only the unreviewed row can still be attested');
    assert.match(textOf(byAction(dom.root, 'approve-selected')[0]), /Approve selected \(2\)/);
    byAction(dom.root, 'approve-selected')[0].dispatch('click');
    await until(() => parsedRows.slice(0, 2).every(n => rowStatus(f, n) === 'approved'), 'two approved');
    assert.equal(rowStatus(f, parsedRows[2]), 'unreviewed');
    await until(() => textOf(one(dom.root, e => e.hasClass('tile') && e.getAttribute('data-count') === 'approved').children[0]) === '2', 'summary updated');

    // Filters
    const filter = one(dom.root, e => e.getAttribute('id') === 'import-filter');
    filter.value = 'approved';
    filter.dispatch('change');
    assert.equal(all(dom.root, e => e.tag === 'tr' && e.parent.tag === 'tbody').length, 2);
    assert.match(textOf(dom.root), /2 rows match this filter/);
    filter.value = 'invalid';
    filter.dispatch('change');
    assert.equal(all(dom.root, e => e.tag === 'tr' && e.parent.tag === 'tbody').length, 1);
    filter.value = 'ignored';
    filter.dispatch('change');
    assert.match(textOf(dom.root), /No rows to show/);
  });
});

test('import review: a failed action is reported and the table stays correct', async () => {
  await withFixture(async f => {
    const dom = await openImport(f);
    byAction(importRow(dom, 5), 'attest')[0].dispatch('click');
    const dialog = openDialog(dom);
    // Someone else approves the row after this page loaded: attest now conflicts.
    f.db.execute("UPDATE import_review_rows SET status='approved', attested_by=?, attested_at=CURRENT_TIMESTAMP WHERE source_row=5", [ids.owner]);
    one(dialog, e => e.tag === 'form').dispatch('submit');
    await until(() => /row changed while you were working/.test(textOf(dialog)), 'conflict shown in the dialog');
    assert.ok(dialog.open);
    assert.match(textOf(dialog), /Reload the list/);
    buttons(dialog, 'Cancel')[0].dispatch('click');
  });
});

test('import review: pages of 50 with Previous and Next', async () => {
  await withFixture(async f => {
    const dom = await mountApp(f, 'owner', { hash: '#/settings/import' });
    const header = 'Date Preached,Sermon Title,Category,Tags,Stories Shared,Location\nPlease insert rows below this row\n';
    const body = Array.from({ length: 120 }, (_, i) => `2024-${String(1 + (i % 12)).padStart(2, '0')}-${String(2 + (i % 20)).padStart(2, '0')},Sermon number ${i},,,,Hall ${i % 3}`).join('\n');
    await settle();
    chooseFile(dom, e => e.getAttribute('id') === 'import-file', csvFile(header + body + '\n'));
    byAction(dom.root, 'stage')[0].dispatch('click');
    await until(() => all(dom.root, e => e.hasClass('import-table')).length === 1, 'table');
    const shown = () => all(dom.root, e => e.tag === 'tr' && e.parent.tag === 'tbody').length;
    assert.equal(shown(), 50);
    assert.match(textOf(dom.root), /Page 1 of 3/);
    assert.ok(byAction(dom.root, 'prev')[0].hasAttribute('disabled'));
    byAction(dom.root, 'next')[0].dispatch('click');
    byAction(dom.root, 'next')[0].dispatch('click');
    assert.equal(shown(), 20);
    assert.match(textOf(dom.root), /Page 3 of 3/);
    assert.ok(byAction(dom.root, 'next')[0].hasAttribute('disabled'));
    byAction(dom.root, 'prev')[0].dispatch('click');
    assert.match(textOf(dom.root), /Page 2 of 3/);
  });
});

// ================================================================= Docs & Privacy

class BucketMock {
  objects = new Map();
  async head(key) { return this.objects.has(key) ? { key } : null; }
  async get(key) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return { size: bytes.byteLength, body: new Blob([bytes]).stream(), text: async () => new TextDecoder().decode(bytes) };
  }
  async put(key, value, options = {}) {
    if (options.onlyIf?.etagDoesNotMatch === '*' && this.objects.has(key)) return null;
    this.objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value));
    return { key };
  }
  async delete(key) { this.objects.delete(key); }
}
function makePdf(text) {
  const stream = text ? `BT /F1 12 Tf 72 700 Td (${text}) Tj ET` : '';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
const pdfFile = (text, name = 'notes.pdf') => new File([makePdf(text)], name, { type: 'application/pdf' });
const PDF_VERSION = vid(50);
const docsHash = `#/settings/docs?sermon=${ids.sermon1}`;

async function withDocs(run) {
  await withFixture(async f => {
    f.env.PRIVATE_PDFS = new BucketMock();
    f.db.execute(`INSERT INTO sermon_versions(id,workspace_id,sermon_id,label,source_type) VALUES (?,?,?,?,?)`, [PDF_VERSION, ids.w1, ids.sermon1, 'Printed notes', 'pdf']);
    await run(f);
  });
}
const versionCard = (dom, label) => one(dom.root, e => e.hasClass('version-card') && textOf(e.children[0]).startsWith(label), `version ${label}`);
const versionState = f => f.db.query('SELECT indexing_state FROM sermon_versions WHERE id=?', [PDF_VERSION])[0].indexing_state;

test('docs: upload a PDF, then an Owner consents and it becomes searchable, then revokes', async () => {
  await withDocs(async f => {
    const editor = await mountApp(f, 'editor', { hash: docsHash });
    await until(() => all(editor.root, e => e.hasClass('version-card')).length === 2, 'versions');
    const card = versionCard(editor, 'Printed notes');
    assert.match(textOf(card), /Not indexed/);
    assert.equal(byAction(card, 'download').length, 0, 'no file yet');
    // Local checks come first and send nothing.
    byAction(card, 'upload')[0].dispatch('click');
    await settle();
    assert.match(textOf(card), /Choose a PDF file first/);
    one(card, e => e.tag === 'input').files = [new File(['hello'], 'notes.txt', { type: 'text/plain' })];
    byAction(card, 'upload')[0].dispatch('click');
    await settle();
    assert.match(textOf(card), /not a PDF/);
    assert.ok(!editor.calls.some(c => c.startsWith('POST') && c.endsWith('/pdf')), 'nothing uploaded yet');
    // A real upload: held privately, awaiting an Owner.
    one(card, e => e.tag === 'input').files = [pdfFile('Grace upon grace as John 3:16 says')];
    byAction(card, 'upload')[0].dispatch('click');
    await until(() => versionState(f) === 'awaiting_consent', 'uploaded');
    await until(() => /Awaiting owner consent/.test(textOf(versionCard(editor, 'Printed notes'))), 'status shown');
    const after = versionCard(editor, 'Printed notes');
    assert.match(textOf(after), /held privately/);
    assert.match(textOf(editor.toast), /held privately until an Owner consents/);
    assert.equal(byAction(after, 'download').length, 1);
    assert.match(one(after, e => e.getAttribute('data-action') === 'download').getAttribute('href'), new RegExp(`/versions/${PDF_VERSION}/pdf$`));
    assert.equal(byAction(after, 'consent').length + byAction(after, 'revoke').length, 0, 'an Editor cannot consent or revoke');
    assert.match(textOf(after), /Waiting for an Owner to decide/);
    assert.equal(f.db.query('SELECT COUNT(*) AS n FROM note_texts WHERE version_id=?', [PDF_VERSION])[0].n, 0, 'not searchable yet');

    // Owner consents through a confirmation.
    const owner = await mountApp(f, 'owner', { hash: docsHash });
    await until(() => all(owner.root, e => e.hasClass('version-card')).length === 2, 'owner view');
    byAction(versionCard(owner, 'Printed notes'), 'consent')[0].dispatch('click');
    const dialog = openDialog(owner);
    assert.match(textOf(dialog), /Everyone in this archive will be able to find text from “Printed notes”/);
    assert.equal(textOf(owner.document.activeElement), 'Cancel');
    assert.equal(versionState(f), 'awaiting_consent', 'nothing changes before confirming');
    one(dialog, e => e.tag === 'form').dispatch('submit');
    await until(() => versionState(f) === 'indexed' && noDialog(owner), 'indexed');
    await until(() => /Searchable by everyone/.test(textOf(versionCard(owner, 'Printed notes'))), 'status updated');
    const found = await f.call('GET', f.w('/search?q=' + encodeURIComponent('grace upon grace')), 'viewer');
    assert.equal(found.json.notesMatches.length, 1);
    // The Owner can revoke, after a clear warning.
    byAction(versionCard(owner, 'Printed notes'), 'revoke')[0].dispatch('click');
    const warn = openDialog(owner);
    assert.match(textOf(warn), /extracted text is deleted/);
    assert.match(textOf(warn), /This is final/);
    assert.equal(versionState(f), 'indexed');
    one(warn, e => e.tag === 'form').dispatch('submit');
    await until(() => versionState(f) === 'revoked' && noDialog(owner), 'revoked');
    await until(() => /Access revoked/.test(textOf(versionCard(owner, 'Printed notes'))), 'status shows revoked');
    const revoked = versionCard(owner, 'Printed notes');
    assert.equal(byAction(revoked, 'download').length + byAction(revoked, 'consent').length + byAction(revoked, 'revoke').length, 0, 'revoked is final');
    assert.equal((await f.call('GET', f.w('/search?q=' + encodeURIComponent('grace upon grace')), 'viewer')).json.notesMatches.length, 0);
    assert.deepEqual(f.auditActions().filter(a => a.startsWith('version.')), ['version.pdf_upload', 'version.pdf_extracted', 'version.consent', 'version.index', 'version.revoke']);
  });
});

test('docs: a scanned PDF is stored but reported as not searchable, and a viewer has no controls', async () => {
  await withDocs(async f => {
    const dom = await mountApp(f, 'editor', { hash: docsHash });
    await until(() => all(dom.root, e => e.hasClass('version-card')).length === 2, 'versions');
    one(versionCard(dom, 'Printed notes'), e => e.tag === 'input').files = [pdfFile('')];
    byAction(versionCard(dom, 'Printed notes'), 'upload')[0].dispatch('click');
    await until(() => versionState(f) === 'failed', 'failed state');
    assert.match(textOf(dom.toast), /Stored, but not searchable\. That PDF has no text/);
    await until(() => /Indexing failed/.test(textOf(versionCard(dom, 'Printed notes'))), 'card updated');
    assert.match(textOf(versionCard(dom, 'Printed notes')), /cannot be searched/);
    assert.equal(byAction(versionCard(dom, 'Printed notes'), 'upload').length, 0, 'a file is already stored');
    assert.equal(byAction(versionCard(dom, 'Printed notes'), 'download').length, 1);

    const viewer = await mountApp(f, 'viewer', { hash: docsHash });
    await until(() => all(viewer.root, e => e.hasClass('version-card')).length === 2, 'viewer versions');
    assert.equal(all(viewer.root, e => e.getAttribute('data-action') && e.getAttribute('data-action') !== 'download').length, 0, 'no write controls');
    assert.match(textOf(viewer.root), /view-only access/);
    assert.equal(all(viewer.root, e => e.getAttribute('type') === 'file').length, 0);
    assert.equal(byAction(viewer.root, 'add-pdf').length, 0);
  });
});

test('docs: add a PDF version in one step, and the server refuses a repeat upload', async () => {
  await withDocs(async f => {
    const dom = await mountApp(f, 'admin', { hash: docsHash });
    await until(() => byAction(dom.root, 'add-pdf').length === 1, 'form');
    const label = one(dom.root, e => e.getAttribute('name') === 'label');
    label.value = 'Final script';
    one(dom.root, e => e.getAttribute('type') === 'file' && e.getAttribute('id')?.startsWith('new-pdf')).files = [pdfFile('The harbor light never fails')];
    byAction(dom.root, 'add-pdf')[0].dispatch('click');
    await until(() => f.db.query("SELECT indexing_state FROM sermon_versions WHERE label='Final script'")[0]?.indexing_state === 'awaiting_consent', 'created and uploaded');
    await until(() => all(dom.root, e => e.hasClass('version-card')).length === 3, 'list shows it');
    assert.match(textOf(versionCard(dom, 'Final script')), /Awaiting owner consent/);
    // The same name again is a conflict shown inline, with no file sent. (The form was rebuilt.)
    one(dom.root, e => e.getAttribute('name') === 'label').value = 'Final script';
    one(dom.root, e => e.getAttribute('type') === 'file' && e.getAttribute('id')?.startsWith('new-pdf')).files = [pdfFile('Second')];
    byAction(dom.root, 'add-pdf')[0].dispatch('click');
    await until(() => /already has a version with that name/.test(textOf(dom.root)), 'name conflict');
    // A second file for a version that has one is refused by the server.
    const again = await f.call('POST', f.w(`/sermons/${ids.sermon1}/versions/${f.db.query("SELECT id FROM sermon_versions WHERE label='Final script'")[0].id}/pdf`), 'admin');
    assert.ok([409, 415].includes(again.status));
  });
});

test('docs: sermon picker, empty library and deep links', async () => {
  await withDocs(async f => {
    const dom = await mountApp(f, 'owner', { hash: '#/settings/docs' });
    await settle();
    assert.match(textOf(dom.root), /Choose a sermon to see its versions/);
    assert.equal(dom.calls.filter(c => c.includes('/sermons/') && !c.includes('/sermons?')).length, 0, 'no sermon is loaded until one is chosen');
    const select = one(dom.root, e => e.getAttribute('id') === 'docs-sermon');
    select.value = ids.sermon1;
    select.dispatch('change');
    assert.equal(dom.hash(), docsHash);
    await until(() => all(dom.root, e => e.hasClass('version-card')).length === 2, 'versions');
    // The sermon page links here for editors, not for viewers.
    dom.go(`#/sermons/${ids.sermon1}`);
    await until(() => /Original Alpha/.test(textOf(dom.root)), 'sermon');
    assert.equal(one(dom.root, e => e.tag === 'a' && /Manage documents/.test(textOf(e))).getAttribute('href'), docsHash);
    const viewer = await mountApp(f, 'viewer', { hash: `#/sermons/${ids.sermon1}` });
    await until(() => /Original Alpha/.test(textOf(viewer.root)), 'viewer sermon');
    assert.equal(all(viewer.root, e => e.tag === 'a' && /Manage documents/.test(textOf(e))).length, 0);
    // An archive with no sermons has nothing to manage yet.
    f.db.execute('DELETE FROM preaching_events WHERE workspace_id=?', [ids.w2]);
    f.db.execute('DELETE FROM sermon_versions WHERE workspace_id=?', [ids.w2]);
    f.db.execute('DELETE FROM sermon_scripture_refs WHERE workspace_id=?', [ids.w2]);
    f.db.execute('DELETE FROM sermons WHERE workspace_id=?', [ids.w2]);
    const empty = await mountApp(f, 'owner2', { hash: '#/settings/docs' });
    await settle();
    assert.match(textOf(empty.root), /Add a sermon first/);
    assert.equal(all(empty.root, e => e.tag === 'select').length, 0);
  });
});

test('settings pages move focus to the heading and set the document title', async () => {
  await withFixture(async f => {
    const dom = await mountApp(f, 'owner', { hash: '' });
    dom.go('#/settings/workspace');
    assert.equal(dom.document.activeElement.getAttribute('id'), 'page-title');
    assert.equal(dom.document.title, 'Settings · My Sermons');
    assert.equal(textOf(one(dom.root, e => e.tag === 'h1')), 'Settings');
    assert.equal(all(dom.root, e => e.tag === 'h1').length, 1, 'one h1 per page');
    dom.go('#/search');
    assert.equal(dom.document.title, 'Search · My Sermons');
    assert.equal(all(dom.root, e => e.tag === 'h1').length, 1);
  });
});


// ================================================================= review follow-ups

/** An API wrapper that holds every GET whose path matches `hold` until `release()` is called. */
function gatedApi(f, actor, hold) {
  const base = realApi(f, actor);
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  return { calls, api: { ...base, get: async path => { calls.push(path); if (hold.test(path)) await gate; return base.get(path); } }, release };
}
const searchText = dom => textOf(one(dom.root, e => e.getAttribute('id') === 'search-results'));

test('a slow search for an earlier query cannot overwrite the newer one', async () => {
  await withLibrary(async f => {
    const { api, release, calls } = gatedApi(f, 'owner', /search\?q=closes\+the\+sermon/);
    const dom = await mountApp(f, 'owner', { api, hash: '#/search?q=closes+the+sermon&scope=everything' });
    dom.go('#/search?q=speaks+about+harbors&scope=everything');
    await until(() => /Beta Light Sermon/.test(searchText(dom)), 'newer results');
    release();
    await settle(); await settle();
    assert.equal(calls.filter(c => c.includes('/search?')).length, 2, 'the late answer is dropped, not turned into another request');
    assert.match(searchText(dom), /Beta Light Sermon/);
    assert.ok(!searchText(dom).includes('Alpha Hope Sermon'), 'the late answer to the first query was dropped');
    assert.match(searchText(dom), /for “speaks about harbors”/);
  });
});

test('a slow Find in notes answer for an earlier query cannot overwrite the newer one', async () => {
  await withLibrary(async f => {
    const { api, release, calls } = gatedApi(f, 'owner', /find-in-notes\?q=closes\+the\+sermon/);
    const dom = await mountApp(f, 'owner', { api, hash: notesHref(ids.sermon1, 'closes the sermon') });
    await until(() => calls.some(c => c.includes('find-in-notes')), 'the first question is in flight');
    dom.go(notesHref(ids.sermon1, 'nothing like this'));
    await until(() => /Found in 0 versions of 5/.test(textOf(dom.root)), 'newer results');
    release();
    await settle(); await settle();
    assert.equal(calls.filter(c => c.includes('find-in-notes')).length, 2, 'the late answer is dropped, not turned into another request');
    assert.match(textOf(dom.root), /Found in 0 versions of 5/);
    assert.equal(all(dom.root, e => e.tag === 'mark').length, 0);
  });
});

test('coming back to a search shows what the server holds now, not an old answer', async () => {
  await withLibrary(async f => {
    const dom = await mountApp(f, 'owner', { hash: '#/search?q=lanterns&scope=everything' });
    await until(() => /Alpha Hope Sermon/.test(searchText(dom)), 'first answer');
    const searches = () => dom.calls.filter(c => c.includes('/search?')).length;
    assert.equal(searches(), 1);
    dom.go('#/library/covers');
    f.db.execute("UPDATE sermon_versions SET indexing_state='revoked' WHERE id=?", [vid(10)]); // its text stops being searchable
    dom.go('#/search?q=lanterns&scope=everything');
    await until(() => searches() === 2, 'searched again');
    await until(() => /Beta Light Sermon/.test(searchText(dom)), 'new answer');
    assert.ok(!searchText(dom).includes('Alpha Hope Sermon'), 'revoked text is not shown from a cache');
    // The same goes for the notes tab.
    dom.go(notesHref(ids.sermon1, 'lanterns'));
    await until(() => /Found in 0 versions of 5/.test(textOf(dom.root)), 'notes miss');
    dom.go(`#/sermons/${ids.sermon1}`);
    f.db.execute("UPDATE sermon_versions SET indexing_state='indexed' WHERE id=?", [vid(10)]);
    dom.go(notesHref(ids.sermon1, 'lanterns'));
    await until(() => /Found in 1 version of 5/.test(textOf(dom.root)), 'notes refetched');
  });
});

test('Find in notes run again with the same text asks the server again', async () => {
  await withLibrary(async f => {
    const dom = await mountApp(f, 'owner', { hash: notesHref(ids.sermon1, 'romans 8') });
    await until(() => /Found in 1 version of 5/.test(textOf(dom.root)), 'first run');
    const count = () => dom.calls.filter(c => c.includes('find-in-notes')).length;
    assert.equal(count(), 1);
    one(dom.root, e => e.getAttribute('id') === 'notes-title').parent.querySelector('form').dispatch('submit');
    await until(() => count() === 2, 'second request');
  });
});

test('search says when a group hit the server cap', async () => {
  assert.equal(truncated({ limit: 50, metadataMatches: [], notesMatches: new Array(50).fill({}) }), true);
  assert.equal(truncated({ limit: 50, metadataMatches: new Array(50).fill({}), notesMatches: [] }), true);
  assert.equal(truncated({ limit: 50, metadataMatches: [], notesMatches: new Array(49).fill({}) }), false);
  assert.equal(truncated({ metadataMatches: [], notesMatches: [] }), false);
  assert.equal(truncated(null), false);
  await withLibrary(async f => {
    const base = realApi(f, 'owner');
    const capped = { ...base, get: async path => {
      const data = await base.get(path);
      return path.includes('/search?') ? { ...data, limit: 1 } : data;
    } };
    const dom = await mountApp(f, 'owner', { api: capped, hash: '#/search?q=lanterns' });
    await until(() => /Showing the first 1 in each group/.test(textOf(dom.root)), 'cap hint');
    const roomy = await mountApp(f, 'owner', { hash: '#/search?q=lanterns' });
    await until(() => all(roomy.root, e => e.hasClass('result-group')).length === 1, 'results');
    assert.ok(!/Showing the first/.test(textOf(roomy.root)));
  });
});

test('import review: selection never reaches rows that are filtered out or on another page', async () => {
  await withFixture(async f => {
    const dom = await openImport(f);
    const parsedRows = f.db.query("SELECT source_row FROM import_review_rows WHERE parse_outcome='parsed' ORDER BY source_row").map(r => Number(r.source_row));
    const pick = number => { const box = one(importRow(dom, number), e => e.tag === 'input'); box.checked = true; box.dispatch('change'); };
    pick(parsedRows[0]); pick(parsedRows[1]);
    assert.match(textOf(dom.root), /2 rows selected/);
    const filter = one(dom.root, e => e.getAttribute('id') === 'import-filter');
    filter.value = 'approved';
    filter.dispatch('change');
    assert.match(textOf(dom.root), /0 rows selected/, 'changing the filter clears the selection');
    assert.ok(byAction(dom.root, 'attest-selected')[0].hasAttribute('disabled'));
    filter.value = 'all';
    filter.dispatch('change');
    assert.equal(rowStatus(f, parsedRows[0]), 'unreviewed');
    assert.ok(all(dom.root, e => e.tag === 'input' && e.getAttribute('data-row')).every(box => !box.checked), 'no box is ticked after the change');
  });
});

test('import review: attesting one row keeps the other selections, and a bulk approve that stops says how far it got', async () => {
  await withFixture(async f => {
    const dom = await openImport(f);
    const rows = f.db.query("SELECT source_row FROM import_review_rows WHERE parse_outcome='parsed' ORDER BY source_row").map(r => Number(r.source_row));
    const pick = number => { const box = one(importRow(dom, number), e => e.tag === 'input'); box.checked = true; box.dispatch('change'); };
    // Select two rows, then attest a third on its own: the two stay selected.
    pick(rows[0]); pick(rows[1]);
    byAction(importRow(dom, rows[2]), 'attest')[0].dispatch('click');
    one(openDialog(dom), e => e.tag === 'form').dispatch('submit');
    await until(() => rowStatus(f, rows[2]) === 'attested' && noDialog(dom), 'third attested');
    await until(() => /2 rows selected/.test(textOf(dom.root)), 'selection kept');
    // Attest the two, select all three, then make the middle one un-approvable behind the page's back.
    byAction(dom.root, 'attest-selected')[0].dispatch('click');
    one(openDialog(dom), e => e.tag === 'form').dispatch('submit');
    await until(() => rowStatus(f, rows[0]) === 'attested' && rowStatus(f, rows[1]) === 'attested' && noDialog(dom), 'all attested');
    for (const number of rows) pick(number);
    f.db.execute("UPDATE import_review_rows SET status='ignored' WHERE source_row=?", [rows[1]]);
    byAction(dom.root, 'approve-selected')[0].dispatch('click');
    await until(() => rowStatus(f, rows[0]) === 'approved', 'first approved');
    await until(() => /Approved 1 of 3\./.test(textOf(one(dom.root, e => e.hasClass('review-status')))), 'partial message');
    assert.match(textOf(one(dom.root, e => e.hasClass('review-status'))), /row changed while you were working/);
    assert.equal(rowStatus(f, rows[1]), 'ignored');
    assert.equal(rowStatus(f, rows[2]), 'attested', 'the loop stopped at the first failure');
    assert.match(textOf(dom.root), /2 rows selected/, 'the rows that were not approved stay selected');
  });
});

test('import review: the pager keeps keyboard focus on the button that was used', async () => {
  await withFixture(async f => {
    const dom = await mountApp(f, 'owner', { hash: '#/settings/import' });
    const header = 'Date Preached,Sermon Title,Category,Tags,Stories Shared,Location\nPlease insert rows below this row\n';
    const body = Array.from({ length: 120 }, (_, i) => `2024-01-${String(2 + (i % 20)).padStart(2, '0')},Sermon number ${i},,,,Hall`).join('\n');
    await settle();
    chooseFile(dom, e => e.getAttribute('id') === 'import-file', csvFile(header + body + '\n'));
    byAction(dom.root, 'stage')[0].dispatch('click');
    await until(() => byAction(dom.root, 'next').length === 1, 'pager');
    byAction(dom.root, 'next')[0].dispatch('click');
    assert.equal(dom.document.activeElement, byAction(dom.root, 'next')[0]);
    byAction(dom.root, 'next')[0].dispatch('click'); // last page: Next is now disabled
    assert.equal(dom.document.activeElement, byAction(dom.root, 'prev')[0], 'focus falls back to the enabled button');
  });
});

test('docs: an Admin sees the document states but cannot consent or revoke', async () => {
  await withDocs(async f => {
    f.db.execute("UPDATE sermon_versions SET indexing_state='awaiting_consent' WHERE id=?", [PDF_VERSION]);
    f.db.execute(`INSERT INTO sermon_versions(id,workspace_id,sermon_id,label,source_type,indexing_state) VALUES (?,?,?,?,?,?)`, [vid(51), ids.w1, ids.sermon1, 'Live copy', 'pdf', 'indexed']);
    const admin = await mountApp(f, 'admin', { hash: docsHash });
    await until(() => all(admin.root, e => e.hasClass('version-card')).length === 3, 'versions');
    assert.equal(byAction(admin.root, 'consent').length + byAction(admin.root, 'revoke').length, 0);
    assert.match(textOf(versionCard(admin, 'Printed notes')), /Waiting for an Owner to decide/);
    const owner = await mountApp(f, 'owner', { hash: docsHash });
    await until(() => all(owner.root, e => e.hasClass('version-card')).length === 3, 'owner versions');
    assert.equal(byAction(owner.root, 'consent').length, 1);
    assert.equal(byAction(owner.root, 'revoke').length, 2);
  });
});

test('the invitation token leaves the page entirely when its dialog closes', async () => {
  await withFixture(async f => {
    const dom = await mountApp(f, 'owner', { hash: '#/settings/people' });
    await until(() => byAction(dom.root, 'invite').length === 1, 'ready');
    byAction(dom.root, 'invite')[0].dispatch('click');
    const dialog = openDialog(dom);
    one(dialog, e => e.getAttribute('name') === 'email').value = 'outsider@example.test';
    one(dialog, e => e.tag === 'form').dispatch('submit');
    await until(() => all(dom.document.body, e => e.getAttribute('id') === 'invite-token').length === 1, 'token shown');
    const token = one(dom.document.body, e => e.getAttribute('id') === 'invite-token').value;
    buttons(openDialog(dom), 'Done')[0].dispatch('click');
    assert.equal(all(dom.document.body, e => e.getAttribute('id') === 'invite-token').length, 0, 'the input is removed');
    assert.equal(all(dom.document.body, e => e.getAttribute('value') === token || e.value === token).length, 0, 'no element still holds it');
  });
});

test('someone who already has an archive can join another with a code from Workspace settings', async () => {
  await withFixture(async f => {
    const invite = await f.call('POST', f.w('/invitations'), 'owner', { email: 'owner2@example.test', role: 'viewer' });
    const dom = await mountApp(f, 'owner2', { hash: '#/settings/workspace' });
    await settle();
    assert.equal(dom.app.state.workspaces.length, 1);
    const form = one(dom.root, e => e.hasClass('join-form'));
    one(form, e => e.getAttribute('name') === 'token').value = 'wrong';
    form.dispatch('submit');
    await until(() => !one(form, e => e.hasClass('form-error')).hasAttribute('hidden'), 'bad code refused');
    assert.equal(dom.app.state.workspaces.length, 1);
    one(form, e => e.getAttribute('name') === 'token').value = invite.json.token;
    form.dispatch('submit');
    await until(() => dom.app.state.workspaces.length === 2, 'joined');
    await until(() => buttons(dom.root, 'Open Private Alpha').length === 1, 'the new archive is offered');
    assert.match(textOf(dom.toast), /joined the archive/);
    assert.deepEqual(f.db.query('SELECT role FROM workspace_memberships WHERE account_id=? AND workspace_id=?', [ids.owner2, ids.w1]).map(r => r.role), ['viewer']);
  });
});
