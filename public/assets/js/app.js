// App controller: owns state, loads data through the API, picks the view for the current
// hash route and wires the write actions. Everything environment-specific (location,
// storage, clock) is injected so the whole flow can run under a fake DOM in tests.
import { h, mount, rememberFocus, restoreFocus } from './dom.js';
import { ApiError, describeError } from './api.js';
import { applyLayout, isLayout, LAYOUT_LABELS, readLayoutCookie } from './layout.js';
import { createLibraryClient } from './data.js';
import { parseRoute, hrefFor, sermonHref, notesHref, cleanQuery, hasLibraryView, hasSearchScope, LIBRARY_HREF } from './router.js';
import { createPrefs } from './prefs.js';
import { summarise } from './library-model.js';
import { indexEvents } from './calendar-model.js';
import { header } from './views/shell.js';
import { libraryPage } from './views/library.js';
import { calendarPage } from './views/calendar.js';
import { sermonPage } from './views/sermon.js';
import { searchPage, notesPanel } from './views/search.js';
import { shapeSearch, stagesFor } from './search-model.js';
import { settingsPage } from './views/settings.js';
import { joinForm } from './views/join.js';
import { loadingState, emptyState, errorState, deniedState } from './views/states.js';
import { newDraftDialog, newWorkspaceDialog, editSermonDialog, logPreachingDialog, confirmArchiveDialog, workspaceNameField, workspaceNameError } from './views/dialogs.js';

export function createApp({ api, root, headerRoot, announcer, toastRoot, getHash, setHash, today, navigate, initialLayout, prefs = createPrefs({ api }) }) {
  const savedLayout = prefs.get('layout');
  const bootLayout = isLayout(savedLayout) ? savedLayout : isLayout(initialLayout) ? initialLayout : readLayoutCookie();
  const state = {
    phase: 'boot', account: null, workspaces: [], workspaceId: null, role: null, layout: bootLayout, layoutSaving: false, layoutError: null,
    items: [], events: [], index: indexEvents([]), query: '', archive: 'active', sort: 'recent', series: 'all', error: null
  };
  // The saved choices that sit on the page state, read again whenever the account's copy is taken in.
  const loadViewPrefs = () => {
    state.archive = prefs.get('archive') ?? 'active';
    state.sort = prefs.get('sort') ?? 'recent';
    state.series = prefs.get('series') ?? 'all';
  };
  loadViewPrefs();
  let client = null;
  let detail = null;
  let search = null; // { key, scope, quick, deep } for the search page; each stage is { phase, data?, error? }
  let notes = null; // the same, for a sermon's Find in notes tab
  let lastSignature = null;
  let headerSignature = null;
  let needsFocus = false;
  let toastTimer = null;

  // The same message twice in a row is still a change for a screen reader, so a repeated search is announced again.
  const announce = message => {
    if (!announcer) return;
    announcer.textContent = announcer.textContent === message ? message + '\u00a0' : message;
  };
  // QA12: announce a loading screen once when it appears, not again on each re-render while it stays up.
  let loadingShown = null;
  let loadingNext = null;
  const loading = label => {
    if (loadingShown !== label) announce(label);
    loadingNext = label;
    return loadingState(label);
  };
  function toast(message) {
    if (!toastRoot) return;
    toastRoot.textContent = message;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastRoot.textContent = ''; }, 6000);
  }

  function fail(error, retry) {
    state.error = { error, retry };
    state.phase = error instanceof ApiError && error.status === 401 ? 'signedout'
      : error instanceof ApiError && (error.status === 403 || error.status === 404) ? 'denied' : 'error';
    renderHeader();
    render();
  }

  /** The route for the current address. An address that leaves out the Library view or search scope gets the saved one. */
  function currentRoute() {
    const hash = getHash();
    const route = parseRoute(hash);
    if (route.name === 'library' && !hasLibraryView(hash) && prefs.get('libraryView')) return parseRoute(`#/library/${prefs.get('libraryView')}`);
    if (route.name === 'search' && !hasSearchScope(hash) && prefs.get('searchScope')) return { ...route, scope: prefs.get('searchScope') };
    return route;
  }

  function renderHeader() {
    mount(headerRoot, header({ state, route: currentRoute(), switchWorkspace, newWorkspace, signOut, changeLayout, search: q => runSearch({ q, scope: 'everything', archived: false }) }));
  }

  async function signOut() {
    try { await api.post('/auth/logout'); } catch (error) { toast(describeError(error)); return; }
    navigate('/');
  }

  function setLibrary({ sermons, events }) {
    state.items = summarise(sermons, events);
    state.events = events;
    state.index = indexEvents(events);
  }

  async function loadWorkspace() {
    state.phase = 'loading';
    detail = null;
    const current = state.workspaces.find(w => w.id === state.workspaceId);
    state.role = current ? current.role : null;
    client = createLibraryClient(api, state.workspaceId);
    renderHeader();
    render();
    const requested = state.workspaceId;
    try {
      const library = await client.loadLibrary();
      if (state.workspaceId !== requested) return; // the person switched workspaces while this was loading
      setLibrary(library);
      state.phase = 'ready';
      render();
    } catch (error) {
      if (state.workspaceId === requested) fail(error, loadWorkspace);
    }
  }

  async function start() {
    applyLayout(state.layout);
    renderHeader();
    render();
    let me, list;
    try {
      [me, list] = await Promise.all([api.get('/api/me'), api.get('/api/workspaces')]);
    } catch (error) { return fail(error, start); }
    state.account = me.account;
    prefs.merge(me.account);
    state.layout = isLayout(prefs.get('layout')) ? prefs.get('layout') : 'original';
    applyLayout(state.layout);
    loadViewPrefs();
    prefs.flush(); // sends what an earlier visit could not
    state.workspaces = list.workspaces || [];
    if (!state.workspaces.length) { state.phase = 'no-workspace'; renderHeader(); render(); return; }
    // A saved workspace the account no longer belongs to is ignored.
    const saved = prefs.get('workspaceId');
    state.workspaceId = (state.workspaces.find(w => w.id === saved) || state.workspaces[0]).id;
    await loadWorkspace();
  }

  async function changeLayout(layout, source = null) {
    if (!state.account || state.phase === 'signedout' || !isLayout(layout) || layout === state.layout || state.layoutSaving) return;
    const active = document.activeElement;
    const origin = source ?? (
      active?.getAttribute?.('data-layout-option') ? 'settings'
        : active?.getAttribute?.('data-mobile-layout') ? 'mobile-menu'
          : active?.getAttribute?.('data-quick-layout') ? 'header' : null
    );
    const previous = state.layout;
    state.layout = layout;
    state.layoutSaving = true;
    state.layoutError = null;
    applyLayout(layout);
    renderHeader();
    render();
    try {
      // The choice is kept on this device at once. The account may take it later if it cannot now.
      const saved = await prefs.set({ layout });
      if (saved.rejected) {
        state.layout = previous;
        state.layoutError = saved.error;
        applyLayout(previous);
        toast(describeError(saved.error));
      } else {
        state.layout = isLayout(saved.result?.account?.layout) ? saved.result.account.layout : layout;
        applyLayout(state.layout);
        announce(`Layout changed to ${LAYOUT_LABELS[state.layout]}.`);
        if (!saved.ok) toast('Layout saved on this device. It will sync to your account later.');
      }
    } finally {
      state.layoutSaving = false;
      renderHeader();
      render();
      if (origin === 'settings') root.querySelector(`[data-layout-option="${state.layout}"]`)?.focus();
      else if (origin === 'mobile-menu') (headerRoot.querySelector('[data-test="account-menu"]') || root.querySelector('#sermon-title') || root.querySelector('#page-title') || root)?.focus();
      else if (origin === 'header') (headerRoot.querySelector(`[data-quick-layout="${state.layout}"]`) || root.querySelector('#sermon-title') || root.querySelector('#page-title') || root)?.focus();
    }
  }

  function switchWorkspace(id) {
    if (id === state.workspaceId) return;
    state.workspaceId = id;
    state.query = '';
    state.archive = 'active';
    state.series = 'all'; // series names belong to one workspace
    prefs.set({ workspaceId: id, archive: 'active', series: 'all' });
    search = null;
    notes = null;
    setHash(LIBRARY_HREF);
    loadWorkspace();
  }

  /** Create a workspace from the header, reload the list and open the new one. */
  const newWorkspace = () => newWorkspaceDialog({
    create: name => api.post('/api/workspaces', { name }),
    onCreated: async created => {
      let refreshed = true;
      try {
        state.workspaces = (await api.get('/api/workspaces')).workspaces || [];
      } catch {
        refreshed = false;
      }
      // Fall back to the create response, so the new workspace opens even if the list failed to load.
      if (!state.workspaces.some(w => w.id === created.id)) state.workspaces = [...state.workspaces, created];
      toast(refreshed ? 'Workspace created.' : 'Workspace created, but the list could not be refreshed. Reload the page to see the latest.');
      switchWorkspace(created.id);
    }
  });

  /** Reload lists after a write without a loading screen. A failed refresh is reported, not fatal. */
  async function refreshLibrary() {
    try {
      setLibrary(await client.loadLibrary());
    } catch {
      toast('Saved, but the list could not be refreshed. Reload the page to see the latest.');
    }
  }

  async function loadDetail(id, quiet) {
    try {
      const sermon = await client.getSermon(id);
      if (detail?.id === id) detail = { id, phase: 'ready', sermon };
    } catch (error) {
      if (detail?.id !== id) return;
      if (quiet && detail.phase === 'ready') { toast(describeError(error)); return; }
      detail = { id, phase: 'failed', error };
    }
    if (currentRoute().id === id) render();
  }

  /** Redeem a one-time invitation code, then reload the list of workspaces. The server checks it against the signed-in email. */
  async function joinWithCode(token) {
    await api.post('/api/invitations/accept', { token });
    toast('You have joined the workspace.');
    await start();
  }

  /** Go to `href`. The same address fires no hash change, so `reset` clears the cached result and it re-runs in place. */
  function visit(href, reset) {
    if (getHash() === href) { reset(); render(); } else setHash(href);
  }

  const runSearch = ({ q, scope, archived }) => visit(hrefFor({ name: 'search', q: cleanQuery(q), scope, archived }), () => { search = null; });

  /**
   * The search page runs two requests that land on their own: the quick sermon matches and the deep note
   * matches. Each is its own {phase, data?, error?} on the run, so one can render, fail or be retried
   * without the other. A response only counts while its run is still the page's current search.
   */
  function runStage(run, stage, route) {
    const entry = { phase: 'loading' };
    run[stage] = entry;
    const request = stage === 'quick' ? client.quickSearch : client.search;
    request(route.q, { archived: route.archived }).then(
      data => { entry.phase = 'ready'; entry.data = data; },
      error => { entry.phase = 'failed'; entry.error = error; }
    ).then(() => {
      if (search !== run) return;
      const current = currentRoute();
      if (current.name !== 'search') return;
      if (entry.phase === 'ready') announceSearch(run, current);
      render();
    });
  }

  /** One announcement per stage that lands. The "not a Bible reference" notice is spoken once per search. */
  function announceSearch(run, route) {
    const shaped = shapeSearch({ scope: route.scope, quick: run.quick, deep: run.deep, q: route.q });
    if (!shaped.needsReference) announce(shaped.summary);
    else if (!run.announcedNotice) { run.announcedNotice = true; announce(shaped.notice); }
  }

  function searchView(route) {
    document.title = 'Search · Sermon Bank';
    let run = null;
    if (route.q) {
      const key = JSON.stringify([state.workspaceId, route.q, route.archived]);
      if (search?.key !== key) { search = { key, scope: route.scope, quick: null, deep: null }; announce('Searching…'); }
      run = search;
      const needs = stagesFor(route.scope);
      if (needs.deep && !run.deep) runStage(run, 'deep', route);
      if (needs.quick && !run.quick) runStage(run, 'quick', route);
      // Changing scope re-filters what is already here, so say what the new scope shows.
      if (run.scope !== route.scope) { run.scope = route.scope; if (run.quick || run.deep) announceSearch(run, route); }
    }
    const retry = stage => () => { if (run) run[stage] = null; render(); };
    return searchPage({
      route, quick: run?.quick ?? null, deep: run?.deep ?? null, search: runSearch, rememberScope: searchScope => prefs.set({ searchScope }),
      retryQuick: retry('quick'), retryDeep: retry('deep')
    });
  }

  async function loadNotes(route, key) {
    notes = { key, phase: 'loading' };
    try {
      const data = await client.findInNotes(route.id, route.q);
      if (notes?.key === key) notes = { key, phase: 'ready', data };
    } catch (error) {
      if (notes?.key === key) notes = { key, phase: 'failed', error };
    }
    const current = currentRoute();
    if (notes?.key === key && current.name === 'sermon' && current.tab === 'notes') render();
  }

  function notesView(route, sermon) {
    const key = JSON.stringify([state.workspaceId, route.id, route.q]);
    if (route.q && notes?.key !== key) loadNotes(route, key);
    const find = q => visit(notesHref(route.id, cleanQuery(q)), () => { notes = null; });
    return notesPanel({ sermon, route, result: route.q ? notes : null, announce, find, retry: () => { notes = null; render(); } });
  }

  const afterWrite = (message, id) => async () => {
    toast(message);
    await refreshLibrary();
    if (id) await loadDetail(id, true);
    render();
  };

  const newDraft = () => newDraftDialog({
    client,
    onCreated: async created => {
      toast('Draft created.');
      await refreshLibrary();
      setHash(sermonHref(created.id));
    }
  });

  function sermonView(route) {
    if (!detail || detail.id !== route.id) {
      detail = { id: route.id, phase: 'loading' };
      loadDetail(route.id, false);
    }
    if (detail.phase === 'loading') return loading('Loading sermon…');
    if (detail.phase === 'failed') {
      const { error } = detail;
      if (error instanceof ApiError && error.status === 404) {
        return emptyState({
          title: 'Sermon not found',
          body: 'It may have been removed, or it may belong to a workspace you don’t have access to.',
          actions: [h('a', { class: 'btn', href: LIBRARY_HREF }, 'Back to the library')]
        });
      }
      return errorState({
        title: 'This sermon could not be loaded', body: describeError(error),
        actions: [h('button', { type: 'button', class: 'btn btn-primary', onclick: () => { detail = null; render(); } }, 'Try again')]
      });
    }
    const { sermon } = detail;
    document.title = `${sermon.title} · Sermon Bank`;
    const done = message => afterWrite(message, sermon.id);
    return sermonPage({
      sermon, role: state.role, tab: route.tab || 'details', q: route.q,
      notes: route.tab === 'notes' ? notesView(route, sermon) : null,
      edit: () => editSermonDialog({ client, sermon, onSaved: done('Changes saved.') }),
      logPreaching: () => logPreachingDialog({ client, sermon, onSaved: done('Preaching logged.') }),
      archive: () => confirmArchiveDialog({ client, sermon, restore: false, onDone: done('Sermon archived.') }),
      restore: () => confirmArchiveDialog({ client, sermon, restore: true, onDone: done('Sermon restored.') })
    });
  }

  function noWorkspaceView() {
    const name = workspaceNameField({ value: 'My Sermons' });
    const message = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const form = h('form', {
      class: 'state-form', novalidate: true,
      onsubmit: async event => {
        event.preventDefault();
        message.setAttribute('hidden', '');
        const invalid = workspaceNameError(name.control.value);
        name.setError(invalid);
        if (invalid) { name.control.focus(); return; }
        try {          await api.post('/api/workspaces', { name: name.control.value.trim() });
          await start();
        } catch (error) {
          message.textContent = describeError(error);
          message.removeAttribute('hidden');
        }
      }
    }, name.wrapper, message, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Create workspace'));
    return h('section', { class: 'state state-empty' },
      h('h2', null, 'You don’t have a workspace yet'),
      h('p', null, 'Create your own private workspace, or use the invitation code an owner gave you.'),
      form,
      joinForm({ join: joinWithCode }),
      h('a', { href: hrefFor({ name: 'settings', section: 'layout' }) }, 'Layout settings'));  }

  function readyView(route) {
    // A result is only kept while its page is open, so coming back always shows what the server holds now.
    if (route.name !== 'search') search = null;
    if (!(route.name === 'sermon' && route.tab === 'notes')) notes = null;
    if (!(route.name === 'settings' && route.section === 'layout')) state.layoutError = null;
    if (route.name === 'sermon') return sermonView(route);
    detail = null;
    if (route.name === 'search') return searchView(route);
    if (route.name === 'settings') {
      document.title = 'Settings · Sermon Bank';
      return settingsPage({ route, state, client, toast, setHash: href => visit(href, () => {}), refreshLibrary, switchWorkspace, join: joinWithCode, changeLayout });
    }
    if (route.name !== 'library') {
      return emptyState({
        title: 'That page doesn’t exist', body: 'Check the address, or head back to the library.',
        actions: [h('a', { class: 'btn btn-primary', href: LIBRARY_HREF }, 'Go to the library')]
      });
    }
    document.title = 'Library · Sermon Bank';
    // A view the address names wins for this visit and becomes the saved one.
    if (hasLibraryView(getHash())) prefs.set({ libraryView: route.view });
    const common = { state, announce, newDraft, remember: changes => prefs.set(changes) };
    return route.view === 'calendar'
      ? calendarPage({ route, today: today(), index: state.index })
      : libraryPage({ ...common, view: route.view });
  }

  function render() {
    const route = currentRoute();
    const signature = `${route.name}|${route.view || ''}|${route.id || ''}|${route.section || ''}|${route.tab || ''}`;
    // The header only shows which page is current, so it is rebuilt when the page changes. A result that
    // arrives later re-renders the page but must not wipe what the person is typing in the header box.
    if (signature !== headerSignature) { renderHeader(); headerSignature = signature; }
    const focusKey = document.activeElement?.getAttribute?.('data-focus-key');
    const focused = rememberFocus();
    let view;
    loadingNext = null;
    if (state.phase === 'boot' || state.phase === 'loading') view = loading('Loading your library…');
    else if (state.phase === 'signedout') {
      view = deniedState({
        title: 'Your session has ended', body: 'Sign in again to keep working. Nothing you have saved is lost.',
        actions: [h('a', { class: 'btn btn-primary', href: '/' }, 'Sign in')]
      });
    } else if (state.phase === 'denied') {
      view = deniedState({
        title: 'You don’t have access to this workspace',
        body: 'Ask an owner or admin to invite you, or switch to a workspace you belong to.',
        actions: state.workspaces.filter(w => w.id !== state.workspaceId).map(w => h('button', { type: 'button', class: 'btn', onclick: () => switchWorkspace(w.id) }, `Open ${w.name}`))
      });
    } else if (state.phase === 'error') {
      view = errorState({
        title: 'The library could not be loaded', body: describeError(state.error?.error),
        actions: [h('button', { type: 'button', class: 'btn btn-primary', onclick: () => (state.error?.retry || start)() }, 'Try again')]
      });
    } else if (state.phase === 'no-workspace' && !(route.name === 'settings' && route.section === 'layout')) view = noWorkspaceView();
    else view = readyView(route);
    loadingShown = loadingNext;

    mount(root, view);
    // Move focus to the new page only after a route change (never on first load or data refresh).
    // Keep calendar controls focused across their own re-renders.
    if (lastSignature !== null && signature !== lastSignature) needsFocus = true;
    lastSignature = signature;
    const target = focusKey && root.querySelector(`[data-focus-key="${focusKey}"]`);
    if (target) target.focus();
    else if (needsFocus) {
      (root.querySelector('#sermon-title') || root.querySelector('#page-title') || root).focus();
      // A loading screen is replaced shortly; keep the request open until real content is shown.
      needsFocus = Boolean(root.querySelector('.state-loading'));
    } else restoreFocus(root, focused);
  }

  return { start, render, state };
}

