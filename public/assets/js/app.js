// App controller: owns state, loads data through the API, picks the view for the current
// hash route and wires the write actions. Everything environment-specific (location,
// storage, clock) is injected so the whole flow can run under a fake DOM in tests.
import { h, mount, field } from './dom.js';
import { ApiError, describeError } from './api.js';
import { createLibraryClient } from './data.js';
import { parseRoute, hrefFor, sermonHref, notesHref, cleanQuery } from './router.js';
import { summarise } from './library-model.js';
import { indexEvents } from './calendar-model.js';
import { header } from './views/shell.js';
import { libraryPage } from './views/library.js';
import { calendarPage } from './views/calendar.js';
import { sermonPage } from './views/sermon.js';
import { searchPage, notesPanel } from './views/search.js';
import { settingsPage } from './views/settings.js';
import { joinForm } from './views/join.js';
import { loadingState, emptyState, errorState, deniedState } from './views/states.js';
import { newDraftDialog, editSermonDialog, logPreachingDialog, confirmArchiveDialog } from './views/dialogs.js';

const WORKSPACE_KEY = 'sermon-bank.workspace';

export function createApp({ api, root, headerRoot, announcer, toastRoot, getHash, setHash, storage, today, navigate }) {
  const state = {
    phase: 'boot', account: null, workspaces: [], workspaceId: null, role: null,
    items: [], events: [], index: indexEvents([]), query: '', archive: 'active', sort: 'recent', error: null
  };
  let client = null;
  let detail = null;
  let search = null; // { key, phase, data?, error? } for the search page
  let notes = null; // the same, for a sermon's Find in notes tab
  let lastSignature = null;
  let headerSignature = null;
  let needsFocus = false;
  let toastTimer = null;

  const announce = message => { if (announcer) announcer.textContent = message; };
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

  function renderHeader() {
    mount(headerRoot, header({ state, route: parseRoute(getHash()), switchWorkspace, signOut, search: q => runSearch({ q, scope: 'everything', archived: false }) }));
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
      if (state.workspaceId !== requested) return; // the person switched archives while this was loading
      setLibrary(library);
      state.phase = 'ready';
      render();
    } catch (error) {
      if (state.workspaceId === requested) fail(error, loadWorkspace);
    }
  }

  async function start() {
    renderHeader();
    render();
    let me, list;
    try {
      [me, list] = await Promise.all([api.get('/api/me'), api.get('/api/workspaces')]);
    } catch (error) { return fail(error, start); }
    state.account = me.account;
    state.workspaces = list.workspaces || [];
    if (!state.workspaces.length) { state.phase = 'no-workspace'; renderHeader(); render(); return; }
    const saved = storage.get(WORKSPACE_KEY);
    state.workspaceId = (state.workspaces.find(w => w.id === saved) || state.workspaces[0]).id;
    await loadWorkspace();
  }

  function switchWorkspace(id) {
    if (id === state.workspaceId) return;
    storage.set(WORKSPACE_KEY, id);
    state.workspaceId = id;
    state.query = '';
    state.archive = 'active';
    search = null;
    notes = null;
    setHash(hrefFor({ name: 'library', view: 'covers' }));
    loadWorkspace();
  }

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
    if (parseRoute(getHash()).id === id) render();
  }

  /** Redeem a one-time invitation code, then reload the list of archives. The server checks it against the signed-in email. */
  async function joinWithCode(token) {
    await api.post('/api/invitations/accept', { token });
    toast('You have joined the archive.');
    await start();
  }

  /** Go to `href`. The same address fires no hash change, so `reset` clears the cached result and it re-runs in place. */
  function visit(href, reset) {
    if (getHash() === href) { reset(); render(); } else setHash(href);
  }

  const runSearch = ({ q, scope, archived }) => visit(hrefFor({ name: 'search', q: cleanQuery(q), scope, archived }), () => { search = null; });

  async function loadSearch(route, key) {
    search = { key, phase: 'loading' };
    try {
      const data = await client.search(route.q, { archived: route.archived });
      if (search?.key === key) search = { key, phase: 'ready', data };
    } catch (error) {
      if (search?.key === key) search = { key, phase: 'failed', error };
    }
    if (search?.key === key && parseRoute(getHash()).name === 'search') render();
  }

  function searchView(route) {
    document.title = 'Search · My Sermons';
    const key = JSON.stringify([state.workspaceId, route.q, route.archived]);
    if (route.q && search?.key !== key) loadSearch(route, key);
    return searchPage({ route, result: route.q ? search : null, search: runSearch, retry: () => { search = null; render(); } });
  }

  async function loadNotes(route, key) {
    notes = { key, phase: 'loading' };
    try {
      const data = await client.findInNotes(route.id, route.q);
      if (notes?.key === key) notes = { key, phase: 'ready', data };
    } catch (error) {
      if (notes?.key === key) notes = { key, phase: 'failed', error };
    }
    const current = parseRoute(getHash());
    if (notes?.key === key && current.name === 'sermon' && current.tab === 'notes') render();
  }

  function notesView(route, sermon) {
    const key = JSON.stringify([state.workspaceId, route.id, route.q]);
    if (route.q && notes?.key !== key) loadNotes(route, key);
    const find = q => visit(notesHref(route.id, cleanQuery(q)), () => { notes = null; });
    return notesPanel({ sermon, route, result: route.q ? notes : null, find, retry: () => { notes = null; render(); } });
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
    if (detail.phase === 'loading') return loadingState('Loading sermon…');
    if (detail.phase === 'failed') {
      const { error } = detail;
      if (error instanceof ApiError && error.status === 404) {
        return emptyState({
          title: 'Sermon not found',
          body: 'It may have been removed, or it may belong to an archive you don’t have access to.',
          actions: [h('a', { class: 'btn', href: hrefFor({ name: 'library', view: 'covers' }) }, 'Back to the library')]
        });
      }
      return errorState({
        title: 'This sermon could not be loaded', body: describeError(error),
        actions: [h('button', { type: 'button', class: 'btn btn-primary', onclick: () => { detail = null; render(); } }, 'Try again')]
      });
    }
    const { sermon } = detail;
    document.title = `${sermon.title} · My Sermons`;
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
    const name = field({ label: 'Name your archive', name: 'name', required: true, maxlength: 120, value: 'My Sermons', hint: 'At least 3 characters. Only pilot owners can create an archive.' });
    const message = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const form = h('form', {
      class: 'state-form', novalidate: true,
      onsubmit: async event => {
        event.preventDefault();
        message.setAttribute('hidden', '');
        try {
          await api.post('/api/workspaces', { name: name.control.value });
          await start();
        } catch (error) {
          message.textContent = error instanceof ApiError && error.code === 'pilot_access_only'
            ? 'Creating an archive is limited to pilot owners. Ask an owner to invite you instead.'
            : describeError(error);
          message.removeAttribute('hidden');
        }
      }
    }, name.wrapper, message, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Create archive'));
    return h('section', { class: 'state state-empty' },
      h('h2', null, 'You don’t have an archive yet'),
      h('p', null, 'Create your own private archive, or use the invitation code an owner gave you.'),
      form,
      joinForm({ join: joinWithCode }));
  }

  function readyView(route) {
    // A result is only kept while its page is open, so coming back always shows what the server holds now.
    if (route.name !== 'search') search = null;
    if (!(route.name === 'sermon' && route.tab === 'notes')) notes = null;
    if (route.name === 'sermon') return sermonView(route);
    detail = null;
    if (route.name === 'search') return searchView(route);
    if (route.name === 'settings') {
      document.title = 'Settings · My Sermons';
      return settingsPage({ route, state, client, toast, setHash: href => visit(href, () => {}), refreshLibrary, switchWorkspace, join: joinWithCode });
    }
    if (route.name !== 'library') {
      return emptyState({
        title: 'That page doesn’t exist', body: 'Check the address, or head back to the library.',
        actions: [h('a', { class: 'btn btn-primary', href: hrefFor({ name: 'library', view: 'covers' }) }, 'Go to the library')]
      });
    }
    document.title = 'Library · My Sermons';
    const common = { state, announce, newDraft };
    return route.view === 'calendar'
      ? calendarPage({ route, today: today(), index: state.index })
      : libraryPage({ ...common, view: route.view });
  }

  function render() {
    const route = parseRoute(getHash());
    const signature = `${route.name}|${route.view || ''}|${route.id || ''}|${route.section || ''}|${route.tab || ''}`;
    // The header only shows which page is current, so it is rebuilt when the page changes. A result that
    // arrives later re-renders the page but must not wipe what the person is typing in the header box.
    if (signature !== headerSignature) { renderHeader(); headerSignature = signature; }
    const focusKey = document.activeElement?.getAttribute?.('data-focus-key');
    let view;
    if (state.phase === 'boot' || state.phase === 'loading') view = loadingState('Loading your library…');
    else if (state.phase === 'signedout') {
      view = deniedState({
        title: 'Your session has ended', body: 'Sign in again to keep working. Nothing you have saved is lost.',
        actions: [h('a', { class: 'btn btn-primary', href: '/' }, 'Sign in')]
      });
    } else if (state.phase === 'denied') {
      view = deniedState({
        title: 'You don’t have access to this archive',
        body: 'Ask an owner or admin to invite you, or switch to an archive you belong to.',
        actions: state.workspaces.filter(w => w.id !== state.workspaceId).map(w => h('button', { type: 'button', class: 'btn', onclick: () => switchWorkspace(w.id) }, `Open ${w.name}`))
      });
    } else if (state.phase === 'error') {
      view = errorState({
        title: 'The library could not be loaded', body: describeError(state.error?.error),
        actions: [h('button', { type: 'button', class: 'btn btn-primary', onclick: () => (state.error?.retry || start)() }, 'Try again')]
      });
    } else if (state.phase === 'no-workspace') view = noWorkspaceView();
    else view = readyView(route);

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
    }
  }

  return { start, render, state };
}

