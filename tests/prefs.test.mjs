// View preferences: localStorage paints the first frame, the account wins once it answers (except for
// choices still waiting to be sent), and every control writes both. The unit tests drive the store with
// a fake storage and API. The app tests run the real controller under a fake DOM against the real API handler.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/auth/app.ts';
import { SESSION_COOKIE } from '../src/auth/security.ts';
import { fixture, ids, origin } from './helpers/library-fixture.mjs';
import { FakeDocument, FakeElement, all, one, textOf } from './helpers/fake-dom.mjs';

const root = new URL('../', import.meta.url).pathname;
const J = path => root + 'public/assets/js/' + path;
const { createPrefs, PREFS_KEY } = await import(J('prefs.js'));
const { ApiError, createApi } = await import(J('api.js'));
const { createApp } = await import(J('app.js'));
const { hasLibraryView, hasSearchScope } = await import(J('router.js'));

// ---------------------------------------------------------------- doubles

/** A Storage-like object over a Map. Pass the saved object to start with, or raw text for a corrupt value. */
function memoryStorage(initial) {
  const data = new Map();
  if (initial !== undefined) data.set(PREFS_KEY, typeof initial === 'string' ? initial : JSON.stringify(initial));
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, String(value)); } };
}
const saved = storage => JSON.parse(storage.data.get(PREFS_KEY));
const brokenStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };

function fakeWindow() {
  const listeners = {};
  return { addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); }, fire: type => (listeners[type] || []).forEach(fn => fn({ type })) };
}

/** An API double that records PATCH bodies and answers with the fake account. */
function fakeApi({ account = { id: 'acct-1', layout: 'original', prefs: {} }, patchError = null } = {}) {
  const patches = [];
  const api = {
    patches, account, patchError,
    get: async () => ({ account: api.account }),
    patch: async (path, body) => {
      patches.push(body);
      if (api.patchError) throw api.patchError;
      if (body.layout) api.account.layout = body.layout;
      api.account.prefs = { ...api.account.prefs, ...(body.prefs || {}) };
      return { account: api.account };
    }
  };
  return api;
}
const network = () => new ApiError(0, 'network');

const settle = () => new Promise(resolve => setTimeout(resolve, 20));
async function until(check, message) {
  for (let i = 0; i < 150; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(message);
}

// ---------------------------------------------------------------- the store

test('bad storage falls back to defaults without errors', async () => {
  for (const storage of [brokenStorage, null, memoryStorage('{not json'), memoryStorage('[1,2]'), memoryStorage('"text"'), memoryStorage('null')]) {
    const api = fakeApi();
    const prefs = createPrefs({ storage, api });
    for (const key of ['layout', 'libraryView', 'sort', 'archive', 'series', 'searchScope', 'workspaceId']) assert.equal(prefs.get(key), undefined, key);
    assert.deepEqual(prefs.pendingKeys(), []);
    assert.equal((await prefs.set({ sort: 'title' })).ok, true, 'a choice is still sent to the account');
    assert.deepEqual(api.patches, [{ prefs: { sort: 'title' } }]);
    assert.equal(prefs.get('sort'), 'title');
  }
});

test('saved values that are not allowed, and a pending list that names nothing, are dropped', () => {
  const storage = memoryStorage({
    values: { layout: 'z', libraryView: 'rows', sort: 7, archive: 'archived', bogus: 'x', series: '' },
    pending: ['libraryView', 'sort', 'bogus', 'archive', 5]
  });
  const prefs = createPrefs({ storage, api: fakeApi() });
  assert.equal(prefs.get('layout'), undefined);
  assert.equal(prefs.get('libraryView'), 'rows');
  assert.equal(prefs.get('sort'), undefined);
  assert.equal(prefs.get('bogus'), undefined);
  assert.equal(prefs.get('series'), undefined);
  assert.deepEqual(prefs.pendingKeys().sort(), ['archive', 'libraryView']);
});

test('boot applies the saved layout to the page, else the cookie layout, and reports the saved Library view', () => {
  const document = new FakeDocument();
  document.documentElement = new FakeElement(document, 'html');
  globalThis.document = document;
  try {
    const stored = createPrefs({ storage: memoryStorage({ values: { layout: 'c', libraryView: 'table' } }), api: fakeApi() });
    assert.deepEqual(stored.boot(), { layout: 'c', libraryView: 'table' });
    assert.equal(document.documentElement.getAttribute('data-layout'), 'c');

    document.cookie = 'sb_layout=original';
    const none = createPrefs({ storage: memoryStorage(), api: fakeApi() });
    assert.deepEqual(none.boot(), { layout: 'original', libraryView: 'covers' });
    assert.equal(document.documentElement.getAttribute('data-layout'), 'original');
  } finally { delete globalThis.document; }
});

test('the account wins over what this device saved, and what it does not hold is dropped', () => {
  const storage = memoryStorage({ values: { layout: 'c', sort: 'title', archive: 'archived', libraryView: 'table' }, pending: [] });
  const prefs = createPrefs({ storage, api: fakeApi() });
  prefs.merge({ id: 'acct-1', layout: 'a', prefs: { sort: 'added', libraryView: 'rows' } });
  assert.equal(prefs.get('layout'), 'a');
  assert.equal(prefs.get('sort'), 'added');
  assert.equal(prefs.get('libraryView'), 'rows');
  assert.equal(prefs.get('archive'), undefined);
  assert.deepEqual(saved(storage).values, { layout: 'a', libraryView: 'rows', sort: 'added' });
});

test('a pending choice survives an older account value and is sent on the next load', async () => {
  const storage = memoryStorage({ account: 'acct-1', values: { sort: 'title', archive: 'archived' }, pending: ['sort'] });
  const api = fakeApi({ account: { id: 'acct-1', layout: 'original', prefs: { sort: 'added', archive: 'active' } } });
  const prefs = createPrefs({ storage, api });
  prefs.merge(api.account);
  assert.equal(prefs.get('sort'), 'title', 'pending local choice kept');
  assert.equal(prefs.get('archive'), 'active', 'everything else follows the account');
  assert.deepEqual(prefs.pendingKeys(), ['sort']);
  assert.equal((await prefs.flush()).ok, true);
  assert.deepEqual(api.patches, [{ prefs: { sort: 'title' } }]);
  assert.deepEqual(prefs.pendingKeys(), []);
  assert.deepEqual(saved(storage).pending, []);
  assert.equal(api.account.prefs.sort, 'title');
});

test('a failed send marks the keys pending, then the online event sends them (layout through {layout}, the rest through {prefs})', async () => {
  const storage = memoryStorage();
  const api = fakeApi({ patchError: network() });
  const win = fakeWindow();
  const prefs = createPrefs({ storage, api, win });
  const first = await prefs.set({ layout: 'c', sort: 'title' });
  assert.equal(first.ok, false);
  assert.equal(first.rejected, false);
  assert.deepEqual(prefs.pendingKeys().sort(), ['layout', 'sort']);
  assert.deepEqual(saved(storage), { account: null, values: { layout: 'c', sort: 'title' }, pending: ['layout', 'sort'] });

  api.patchError = null;
  win.fire('online');
  await settle();
  assert.deepEqual(api.patches.at(-1), { layout: 'c', prefs: { sort: 'title' } });
  assert.deepEqual(prefs.pendingKeys(), []);
  assert.deepEqual(saved(storage).pending, []);
});

test('a choice the account refuses goes back to what it holds and is not retried', async () => {
  const storage = memoryStorage();
  const api = fakeApi();
  const win = fakeWindow();
  const prefs = createPrefs({ storage, api, win });
  prefs.merge(api.account);
  await prefs.set({ sort: 'title' });
  api.patchError = new ApiError(400, 'invalid_prefs');
  const refused = await prefs.set({ sort: 'added', layout: 'c' });
  assert.equal(refused.rejected, true);
  assert.equal(prefs.get('sort'), 'title');
  assert.equal(prefs.get('layout'), 'original', 'the layout the account holds');
  assert.deepEqual(prefs.pendingKeys(), []);
  const before = api.patches.length;
  win.fire('online');
  await settle();
  assert.equal(api.patches.length, before);
});

test('a change made while a send is in flight stays pending and is sent next', async () => {
  const storage = memoryStorage();
  const api = fakeApi();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const patch = api.patch;
  api.patch = async (path, body) => { if (!api.patches.length) await gate; return patch(path, body); };
  const prefs = createPrefs({ storage, api });
  const first = prefs.set({ sort: 'title' });
  const second = prefs.set({ sort: 'added' });
  const third = prefs.set({ archive: 'archived' });
  release();
  await Promise.all([first, second, third]);
  assert.deepEqual(api.patches, [{ prefs: { sort: 'title' } }, { prefs: { sort: 'added', archive: 'archived' } }]);
  assert.deepEqual(prefs.pendingKeys(), []);
  assert.equal(api.account.prefs.sort, 'added');
});

test('another person on the same browser does not inherit or send these choices', () => {
  const storage = memoryStorage({ account: 'acct-1', values: { sort: 'title' }, pending: ['sort'] });
  const prefs = createPrefs({ storage, api: fakeApi() });
  prefs.merge({ id: 'acct-2', layout: 'a', prefs: {} });
  assert.equal(prefs.get('sort'), undefined);
  assert.deepEqual(prefs.pendingKeys(), []);
  assert.equal(saved(storage).account, 'acct-2');
});

test('values the account cannot hold are ignored and unchanged values send nothing', async () => {
  const api = fakeApi();
  const prefs = createPrefs({ storage: memoryStorage(), api });
  assert.equal((await prefs.set({ sort: 'sideways', libraryView: 'grid', workspaceId: 'x'.repeat(65), nothing: 1 })).ok, true);
  assert.equal(api.patches.length, 0);
  await prefs.set({ sort: 'title' });
  await prefs.set({ sort: 'title' });
  assert.equal(api.patches.length, 1);
});

test('the address helpers tell a spelled-out view or scope from a bare route', () => {
  assert.equal(hasLibraryView('#/library/rows'), true);
  assert.equal(hasLibraryView('#/library/calendar?y=2026&m=1'), true);
  for (const hash of ['', '#/', '#/library', '#/library/', '#/search?q=x', '#/settings/layout']) assert.equal(hasLibraryView(hash), false, hash);
  assert.equal(hasSearchScope('#/search?q=x&scope=bible'), true);
  for (const hash of ['#/search', '#/search?q=x', '#/library/rows?scope=bible']) assert.equal(hasSearchScope(hash), false, hash);
});

// ---------------------------------------------------------------- the app

function realApi(f, actor, { offline = () => false, gateMe = null, calls = [] } = {}) {
  const fetchImpl = async (path, init) => {
    if (init.method !== 'GET' && offline()) throw new TypeError('offline');
    calls.push(init.method + ' ' + path + (init.body ? ' ' + init.body : ''));
    if (gateMe && path === '/api/me' && init.method === 'GET') await gateMe;
    return handleRequest(new Request(origin + path, {
      method: init.method,
      headers: { ...init.headers, cookie: SESSION_COOKIE + '=' + f.tokens[actor], ...(init.method === 'GET' ? {} : { origin }) },
      body: init.body
    }), f.env);
  };
  return createApi({ fetchImpl });
}

async function mountApp(f, actor, { hash = '', storage = memoryStorage(), api, win = fakeWindow(), calls = [] } = {}) {
  api ||= realApi(f, actor, { calls });
  const document = new FakeDocument();
  document.documentElement = new FakeElement(document, 'html');
  globalThis.document = document;
  const dom = { document, root: document.make('main'), header: document.make('header'), toast: document.make('div'), storage, win, calls };
  const prefs = createPrefs({ storage, api, win });
  const { layout } = prefs.boot();
  let current = hash;
  let app;
  app = createApp({
    api, prefs, root: dom.root, headerRoot: dom.header, announcer: document.make('div'), toastRoot: dom.toast,
    getHash: () => current, setHash: next => { current = next; app.render(); }, today: () => '2026-11-13', navigate() {}, initialLayout: layout
  });
  dom.go = next => { current = next; app.render(); };
  dom.hash = () => current;
  dom.app = app;
  dom.prefs = prefs;
  dom.started = app.start();
  document.body.append(dom.root);
  return dom;
}
const mount = async (...args) => { const dom = await mountApp(...args); await dom.started; await settle(); return dom; };

const viewOf = dom => dom.root.querySelector('[data-focus-key="prev-month"]') ? 'calendar' : /library-(\w+)/.exec(dom.root.querySelector('.library')?.getAttribute('class') ?? '')?.[1] ?? null;
const accountPrefs = async (f, actor) => (await f.call('GET', '/api/me', actor)).json.account;
const patchAccount = (f, actor, body) => f.call('PATCH', '/api/me', actor, body);
const buttons = (node, label) => all(node, e => e.tag === 'button' && textOf(e).trim() === label);
const byId = (node, id) => one(node, e => e.getAttribute('id') === id, 'missing #' + id);

async function withFixture(run) {
  const f = await fixture();
  try { await run(f); await settle(); } finally { f.db.close(); delete globalThis.document; }
}

test('first paint comes from localStorage before /api/me answers', () => withFixture(async f => {
  await patchAccount(f, 'owner', { layout: 'c', prefs: { libraryView: 'table', sort: 'title', archive: 'archived' } });
  const storage = memoryStorage({ account: ids.owner, values: { layout: 'c', libraryView: 'table', sort: 'title', archive: 'archived' }, pending: [] });
  let release;
  const gateMe = new Promise(resolve => { release = resolve; });
  const dom = await mountApp(f, 'owner', { hash: '#/library', storage, api: realApi(f, 'owner', { gateMe }) });
  assert.equal(dom.document.documentElement.getAttribute('data-layout'), 'c', 'layout applied at boot');
  assert.equal(dom.app.state.layout, 'c');
  assert.equal(dom.app.state.sort, 'title');
  assert.equal(dom.app.state.archive, 'archived');
  assert.equal(dom.app.state.phase, 'boot', 'the account has not answered yet');
  release();
  await dom.started;
  await settle();
  assert.equal(viewOf(dom), 'table', 'a bare #/library opens the saved view');
  assert.equal(dom.app.state.layout, 'c');
  assert.equal(dom.app.state.sort, 'title');
}));

test('the account wins over localStorage, and the winner is written back', () => withFixture(async f => {
  await patchAccount(f, 'owner', { layout: 'a', prefs: { libraryView: 'rows', sort: 'added' } });
  const storage = memoryStorage({ account: ids.owner, values: { layout: 'c', libraryView: 'table', sort: 'title', archive: 'archived' }, pending: [] });
  const calls = [];
  const dom = await mount(f, 'owner', { hash: '#/library', storage, calls });
  assert.equal(dom.document.documentElement.getAttribute('data-layout'), 'a');
  assert.equal(viewOf(dom), 'rows');
  assert.equal(dom.app.state.sort, 'added');
  assert.equal(dom.app.state.archive, 'active');
  assert.deepEqual(saved(storage), { account: ids.owner, values: { layout: 'a', libraryView: 'rows', sort: 'added' }, pending: [] });
  assert.equal(calls.filter(call => call.startsWith('PATCH')).length, 0, 'nothing to send when the account already agrees');
}));

test('a pending local choice survives an older account value and reaches the account on load', () => withFixture(async f => {
  await patchAccount(f, 'owner', { prefs: { sort: 'added', libraryView: 'rows' } });
  const storage = memoryStorage({ account: ids.owner, values: { sort: 'title', libraryView: 'table' }, pending: ['sort'] });
  const dom = await mount(f, 'owner', { hash: '#/library', storage });
  assert.equal(dom.app.state.sort, 'title');
  assert.equal(viewOf(dom), 'rows', 'the account still wins for what is not pending');
  assert.equal((await accountPrefs(f, 'owner')).prefs.sort, 'title');
  assert.deepEqual(saved(storage).pending, []);
}));

test('a layout change that cannot be sent stays on this device and is sent when the browser is online again', () => withFixture(async f => {
  let offline = false;
  const storage = memoryStorage();
  const dom = await mount(f, 'owner', { hash: '#/settings/layout', storage, api: realApi(f, 'owner', { offline: () => offline }) });
  offline = true;
  dom.root.querySelector('[data-layout-option="c"]').dispatch('click');
  await settle();
  assert.equal(dom.app.state.layout, 'c', 'not rolled back: it is only waiting to sync');
  assert.equal(dom.document.documentElement.getAttribute('data-layout'), 'c');
  assert.match(dom.toast.textContent, /on this device/);
  assert.deepEqual(saved(storage).pending, ['layout']);
  assert.equal((await accountPrefs(f, 'owner')).layout, 'original');

  offline = false;
  dom.win.fire('online');
  await until(() => saved(storage).pending.length === 0, 'the pending layout is sent');
  assert.equal((await accountPrefs(f, 'owner')).layout, 'c');
}));

test('pending choices are retried on the next load', () => withFixture(async f => {
  let offline = true;
  const storage = memoryStorage();
  const first = await mount(f, 'owner', { hash: '#/library', storage, api: realApi(f, 'owner', { offline: () => offline }) });
  buttons(first.root, 'Archived')[0].dispatch('click');
  await settle();
  assert.deepEqual(saved(storage).pending, ['archive']);
  assert.equal(saved(storage).values.archive, 'archived');
  assert.equal((await accountPrefs(f, 'owner')).prefs.archive, undefined);

  offline = false;
  const second = await mount(f, 'owner', { hash: '#/library', storage });
  assert.equal(second.app.state.archive, 'archived', 'the pending choice is not overwritten by the account');
  await until(() => saved(storage).pending.length === 0, 'sent on load');
  assert.equal((await accountPrefs(f, 'owner')).prefs.archive, 'archived');
}));

test('opening #/library uses the saved view, and a view in the address wins and becomes the saved one', () => withFixture(async f => {
  await patchAccount(f, 'owner', { prefs: { libraryView: 'rows' } });
  const storage = memoryStorage();
  const dom = await mount(f, 'owner', { hash: '#/library', storage });
  assert.equal(viewOf(dom), 'rows');

  dom.go('#/library/table');
  await settle();
  assert.equal(viewOf(dom), 'table', 'the address wins for this visit');
  assert.equal(saved(storage).values.libraryView, 'table');
  assert.equal((await accountPrefs(f, 'owner')).prefs.libraryView, 'table');

  dom.go('#/library');
  assert.equal(viewOf(dom), 'table', 'and it is what a bare #/library opens next');
  dom.go('');
  assert.equal(viewOf(dom), 'table');
  const nav = all(dom.header, e => e.tag === 'a' && textOf(e) === 'Library');
  assert.ok(nav.length > 0 && nav.every(link => link.getAttribute('href') === '#/library'), 'the Library link names no view');
}));
test('a saved calendar view opens the calendar, and a calendar in the address is saved', () => withFixture(async f => {
  const storage = memoryStorage();
  const dom = await mount(f, 'owner', { hash: '#/library/calendar?y=2025&m=3', storage });
  assert.equal(viewOf(dom), 'calendar');
  assert.equal(saved(storage).values.libraryView, 'calendar');
  dom.go('#/library');
  assert.equal(viewOf(dom), 'calendar');
}));

test('Active/Archived, sort and series each go through the store', () => withFixture(async f => {
  await patchAccount(f, 'owner', { layout: 'a' });
  const storage = memoryStorage();
  const dom = await mount(f, 'owner', { hash: '#/library', storage });
  buttons(dom.root, 'Archived')[0].dispatch('click');
  const sort = byId(dom.root, 'sermon-sort');
  sort.value = 'title';
  sort.dispatch('change');
  const series = byId(dom.root, 'sermon-series');
  series.value = '__none__';
  series.dispatch('change');
  await settle();
  assert.deepEqual(saved(storage).values, { layout: 'a', archive: 'archived', sort: 'title', series: '__none__' });
  assert.deepEqual((await accountPrefs(f, 'owner')).prefs, { archive: 'archived', sort: 'title', series: '__none__' });

  const next = await mount(f, 'owner', { hash: '#/library', storage: memoryStorage() });
  assert.equal(next.app.state.archive, 'archived', 'a new device gets them from the account');
  assert.equal(next.app.state.sort, 'title');
  assert.equal(byId(next.root, 'sermon-series').value, '__none__', 'the saved series is still selected on the first render');
}));

test('the original layout controls save too', () => withFixture(async f => {
  const storage = memoryStorage();
  const dom = await mount(f, 'owner', { hash: '#/library', storage });
  buttons(dom.root, 'Archived')[0].dispatch('click');
  const sort = byId(dom.root, 'sermon-sort');
  sort.value = 'added';
  sort.dispatch('change');
  await settle();
  assert.deepEqual((await accountPrefs(f, 'owner')).prefs, { archive: 'archived', sort: 'added' });
}));

test('the search scope is saved, opens #/search, and an explicit scope in the address still wins', () => withFixture(async f => {
  const storage = memoryStorage();
  const dom = await mount(f, 'owner', { hash: '#/search', storage });
  const pressed = () => all(dom.root, e => e.tag === 'button' && e.getAttribute('aria-pressed') === 'true' && e.getAttribute('data-scope')).map(e => e.getAttribute('data-scope'));
  assert.deepEqual(pressed(), ['everything']);
  one(dom.root, e => e.getAttribute('data-scope') === 'bible').dispatch('click');
  await settle();
  assert.equal(saved(storage).values.searchScope, 'bible');
  assert.equal((await accountPrefs(f, 'owner')).prefs.searchScope, 'bible');

  dom.go('#/search');
  assert.deepEqual(pressed(), ['bible']);
  dom.go('#/search?q=grace&scope=notes');
  assert.deepEqual(pressed(), ['notes'], 'the address wins');
  assert.equal(saved(storage).values.searchScope, 'bible', 'but is not saved: only the scope buttons save it');
  const navSearch = all(dom.header, e => e.tag === 'a' && textOf(e) === 'Search');
  assert.ok(navSearch.length > 0 && navSearch.every(link => link.getAttribute('href') === '#/search'));
}));

test('the workspace is saved in the store, reopens on the next load, and a workspace the account left is ignored', () => withFixture(async f => {
  f.db.execute("INSERT INTO workspace_memberships(workspace_id,account_id,role,accepted_at) VALUES (?,?,'viewer',CURRENT_TIMESTAMP)", [ids.w2, ids.editor]);
  const storage = memoryStorage();
  const dom = await mount(f, 'editor', { hash: '#/library', storage });
  assert.equal(dom.app.state.workspaceId, ids.w1);
  buttons(dom.header, 'Switch workspace ▾')[0].dispatch('click');
  one(dom.header, e => e.tag === 'button' && textOf(e).startsWith('Private Beta')).dispatch('click');
  await until(() => dom.app.state.phase === 'ready' && dom.app.state.workspaceId === ids.w2, 'second workspace opened');
  await settle();
  assert.equal(saved(storage).values.workspaceId, ids.w2);
  assert.equal((await accountPrefs(f, 'editor')).prefs.workspaceId, ids.w2);
  assert.equal(dom.hash(), '#/library');

  const again = await mount(f, 'editor', { hash: '#/library', storage });
  assert.equal(again.app.state.workspaceId, ids.w2);

  // viewer is not in w2: a saved w2 from some other place is ignored.
  await patchAccount(f, 'viewer', { prefs: { workspaceId: ids.w2 } });
  const viewer = await mount(f, 'viewer', { hash: '#/library' });
  assert.equal(viewer.app.state.workspaceId, ids.w1);
}));

test('the app runs with storage that throws', () => withFixture(async f => {
  const dom = await mount(f, 'owner', { hash: '#/library', storage: brokenStorage });
  assert.equal(dom.app.state.phase, 'ready');
  buttons(dom.root, 'Archived')[0].dispatch('click');
  await settle();
  assert.equal((await accountPrefs(f, 'owner')).prefs.archive, 'archived', 'the account still takes it');
}));
