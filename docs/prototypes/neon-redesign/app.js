// Sermon Bank Redesign Prototype (Round 2) — Interactive App
// Two interchangeable layouts persisted per user in localStorage:
//   A: Side rail (default)
//   C: Top bar (with series filter strip & wide ledger)
// URL params: ?variant=A|C  &  ?state=normal|loading|empty|error

import {
  ACCOUNT, TODAY, ROLE_LABELS, SOURCE_LABELS, INDEXING_STATUS, ROLE_ABILITIES,
  MONTHS, MONTHS_SHORT, WEEKDAYS,
  createInitialWorkspaces, plural, formatDay, formatLongDay, formatWhen,
  latestEvent, seriesSwatchIndex, runWorkspaceSearch, runSermonNoteSearch
} from './data.js';
import { icon, brandMark, shelfBooksArt, emptyBooksArt, miniBookCover, googleMark } from './icons.js';

const LAYOUT_KEY = 'sermon-bank.layout';

function readInitialLayout(params) {
  const fromUrl = (params.get('variant') || '').toUpperCase();
  if (fromUrl === 'A' || fromUrl === 'C') return fromUrl;
  try {
    const saved = window.localStorage.getItem(LAYOUT_KEY);
    if (saved === 'A' || saved === 'C') return saved;
  } catch { /* ignore storage restrictions */ }
  return 'A';
}

// Minimal safe DOM helper (text nodes only, no raw HTML injection)
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k in el && k !== 'list' && k !== 'type' && k !== 'role' && !k.startsWith('aria-') && !k.startsWith('data-')) el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
  return el;
}

const appRoot = document.getElementById('app');
const announcer = document.getElementById('announcer');
const toastEl = document.getElementById('toast');
let toastTimer = null;

function announce(msg) {
  announcer.textContent = announcer.textContent === msg ? msg + '\u00a0' : msg;
}

function showToast(msg) {
  toastEl.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.textContent = ''; }, 4500);
}

// App State
const params = new URLSearchParams(window.location.search);
const initialVariant = readInitialLayout(params);
const state = {
  workspaces: createInitialWorkspaces(),
  workspaceId: 'ws-riverbend',
  variant: initialVariant,
  panelState: ['normal', 'loading', 'empty', 'error'].includes(params.get('state')) ? params.get('state') : 'normal',
  // Library filters
  libQuery: '',
  libArchive: 'active',
  libSeries: 'all',
  libSort: 'recent',
  libView: params.get('view') || (initialVariant === 'C' ? 'table' : 'rows'),
  // Calendar state
  calYear: 2026,
  calMonth: 11,
  calDay: '2026-11-08',
  // Search state
  searchQuery: 'John 3:16',
  searchScope: 'everything',
  searchArchived: false,
  // Sermon detail state
  sermonTab: 'details',
  notesQuery: 'grace',
  // Popovers & overlays
  switcherOpen: false,
  mobileDrawer: null, // null | 'menu' | 'switcher'
  modal: null // null | { kind, payload }
};

function currentWorkspace() {
  return state.workspaces.find(w => w.id === state.workspaceId) || state.workspaces[0];
}

function canEdit(role) {
  return ['owner', 'admin', 'editor'].includes(role);
}

function canAdmin(role) {
  return ['owner', 'admin'].includes(role);
}

// Hash routing
function parseHash() {
  const raw = (window.location.hash || '#/library').replace(/^#/, '');
  const [pathPart, qsPart] = raw.split('?');
  const qs = new URLSearchParams(qsPart || '');
  const segs = pathPart.split('/').filter(Boolean);
  const head = segs[0] || 'library';

  if (head === 'signin') return { name: 'signin' };
  if (head === 'onboarding') return { name: 'onboarding' };
  if (head === 'calendar') {
    const y = Number(qs.get('y')) || state.calYear;
    const m = Number(qs.get('m')) || state.calMonth;
    const d = qs.get('d') || state.calDay;
    return { name: 'calendar', y, m, d };
  }
  if (head === 'search') {
    return {
      name: 'search',
      q: qs.has('q') ? qs.get('q') : state.searchQuery,
      scope: qs.get('scope') || state.searchScope,
      archived: qs.get('archived') === '1'
    };
  }
  if (head === 'sermon' && segs[1]) {
    return {
      name: 'sermon',
      id: segs[1],
      tab: qs.get('tab') === 'notes' ? 'notes' : 'details',
      q: qs.has('q') ? qs.get('q') : state.notesQuery
    };
  }
  if (head === 'settings') {
    return { name: 'settings', section: segs[1] || 'places' };
  }
  return { name: 'library', view: qs.get('view') || state.libView };
}

function go(hash) {
  state.switcherOpen = false;
  state.mobileDrawer = null;
  if (window.location.hash === hash) render();
  else window.location.hash = hash;
}

function setLayout(nextKey) {
  if (nextKey !== 'A' && nextKey !== 'C') return;
  state.variant = nextKey;
  try { window.localStorage.setItem(LAYOUT_KEY, nextKey); } catch { /* ignore */ }
  const url = new URL(window.location.href);
  url.searchParams.set('variant', nextKey);
  window.history.replaceState({}, '', url);
  render();
  const label = nextKey === 'A' ? 'Side rail layout' : 'Top bar layout';
  announce(`Switched to ${label}`);
  showToast(`${label} saved for this browser.`);
}

// Visible layout switcher shared by Side rail, Top bar, and Workspace settings
function layoutToggleControl({ compact = false } = {}) {
  const buttons = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Navigation layout' },
    h('button', {
      type: 'button',
      'aria-pressed': String(state.variant === 'A'),
      onclick: () => setLayout('A')
    }, icon('layoutRail', 15), compact ? 'Rail' : 'Side rail'),
    h('button', {
      type: 'button',
      'aria-pressed': String(state.variant === 'C'),
      onclick: () => setLayout('C')
    }, icon('layoutTop', 15), compact ? 'Top' : 'Top bar'));

  if (compact) return h('div', { class: 'topbar-layout-toggle' }, buttons);
  return h('div', { class: 'layout-toggle' },
    h('span', { class: 'layout-toggle-label' }, 'Layout'),
    buttons);
}

// Excerpt highlighting helper (safe text nodes + <mark>)
function renderExcerpt(excerpt) {
  const text = excerpt.text;
  const q = excerpt.query;
  const nodes = [];
  if (!q) {
    nodes.push(text);
  } else {
    const lower = text.toLowerCase();
    const qLower = q.toLowerCase();
    let pos = 0;
    let idx;
    while ((idx = lower.indexOf(qLower, pos)) !== -1) {
      if (idx > pos) nodes.push(text.slice(pos, idx));
      nodes.push(h('mark', null, text.slice(idx, idx + q.length)));
      pos = idx + q.length;
    }
    if (pos < text.length) nodes.push(text.slice(pos));
  }
  return h('p', { class: 'excerpt' }, ...nodes);
}

// ============================================================
// WORKSPACE SWITCHER POPOVER & SHEET
// ============================================================
function workspaceOptionsList(onClose) {
  return h('div', { class: 'ws-list' },
    ...state.workspaces.map(ws => {
      const active = ws.id === state.workspaceId;
      const activeCount = ws.sermons.filter(s => !s.archived_at).length;
      return h('button', {
        type: 'button',
        class: 'ws-option',
        'aria-pressed': String(active),
        onclick: () => {
          state.workspaceId = ws.id;
          state.switcherOpen = false;
          state.mobileDrawer = null;
          if (onClose) onClose();
          showToast(`Switched to ${ws.name}.`);
          go('#/library');
        }
      },
      h('span', { class: 'ws-option-main' },
        h('span', { class: 'ws-option-name' }, ws.name),
        h('span', { class: 'ws-option-sub' }, `${ROLE_LABELS[ws.role]} · ${plural(activeCount, 'sermon')}`)),
      active ? h('span', { class: 'pill pill-accent' }, 'Current') : null);
    }));
}

function workspaceSwitcherControl(compact = false) {
  const ws = currentWorkspace();
  const trigger = h('button', {
    type: 'button',
    class: compact ? 'btn' : 'ws-trigger',
    id: compact ? 'topbar-ws-trigger' : 'rail-ws-trigger',
    'aria-expanded': String(state.switcherOpen),
    'aria-haspopup': 'true',
    onclick: event => {
      event.stopPropagation();
      state.switcherOpen = !state.switcherOpen;
      render();
    }
  },
  compact
    ? [brandMark(24), h('span', null, ws.name), icon('chevronDown', 16)]
    : [
        h('span', { class: 'ws-trigger-meta' },
          h('span', { class: 'ws-trigger-name' }, ws.name),
          h('span', { class: 'ws-trigger-role' }, ROLE_LABELS[ws.role])),
        icon('chevronDown', 16)
      ]);

  const popover = state.switcherOpen
    ? h('div', { class: 'ws-popover', role: 'region', 'aria-label': 'Workspaces', onclick: e => e.stopPropagation() },
        h('div', { class: 'ws-popover-head' }, 'Your workspaces'),
        workspaceOptionsList(),
        h('div', { class: 'ws-popover-foot' },
          h('button', {
            type: 'button',
            class: 'ws-new-btn',
            onclick: () => {
              state.switcherOpen = false;
              state.modal = { kind: 'new-workspace' };
              render();
            }
          }, icon('plus', 16), 'New workspace')))
    : null;

  return h('div', { class: 'ws-switcher-wrap' }, trigger, popover);
}

// ============================================================
// SHELL (DESKTOP RAIL [A] + TOP BAR [C] + MOBILE CHROME)
// ============================================================
function renderShell(route, mainNode) {
  const ws = currentWorkspace();
  const activeCount = state.panelState === 'empty'
    ? 0
    : ['loading', 'error'].includes(state.panelState)
      ? undefined
      : ws.sermons.filter(s => !s.archived_at).length;

  const primaryNav = [
    { key: 'library', label: 'Library', ic: 'library', href: '#/library', badge: activeCount },
    { key: 'calendar', label: 'Preaching Calendar', ic: 'calendar', href: '#/calendar' },
    { key: 'search', label: 'Search', ic: 'search', href: '#/search' }
  ];

  const workspaceNav = [
    { key: 'places', label: 'Places', ic: 'places', href: '#/settings/places', badge: ws.places.length },
    { key: 'docs', label: 'Docs & Privacy', ic: 'docs', href: '#/settings/docs' },
    ...(canAdmin(ws.role) ? [{ key: 'people', label: 'People & Access', ic: 'people', href: '#/settings/people' }] : []),
    { key: 'workspace', label: 'Workspace', ic: 'settings', href: '#/settings/workspace' }
  ];

  const activeMain = route.name === 'sermon' ? 'library' : route.name;
  const activeSection = route.name === 'settings' ? route.section : null;

  // Desktop Left Rail (Variant A — default)
  const rail = h('aside', { class: 'rail', 'aria-label': 'Workspace navigation' },
    h('div', { class: 'rail-brand' },
      brandMark(28),
      h('span', { class: 'rail-app-name' }, 'Sermon Bank')),
    workspaceSwitcherControl(false),
    h('nav', { class: 'rail-nav', 'aria-label': 'Primary' },
      h('div', { class: 'rail-group' },
        ...primaryNav.map(item => h('a', {
          class: 'rail-link',
          href: item.href,
          'aria-current': activeMain === item.key ? 'page' : null
        },
        h('span', { class: 'rail-link-left' }, icon(item.ic, 18), h('span', null, item.label)),
        item.badge !== undefined ? h('span', { class: 'count-badge' }, String(item.badge)) : null))),
      h('div', { class: 'rail-group' },
        h('p', { class: 'rail-group-label' }, 'Manage'),
        ...workspaceNav.map(item => h('a', {
          class: 'rail-link',
          href: item.href,
          'aria-current': activeSection === item.key ? 'page' : null
        },
        h('span', { class: 'rail-link-left' }, icon(item.ic, 18), h('span', null, item.label)),
        item.badge !== undefined ? h('span', { class: 'count-badge' }, String(item.badge)) : null)))),
    h('div', { class: 'rail-footer' },
      layoutToggleControl({ compact: false }),
      h('div', { class: 'rail-account' },
        h('div', null,
          h('p', { class: 'rail-account-name' }, ACCOUNT.display_name),
          h('p', { class: 'rail-account-email' }, ACCOUNT.email))),
      h('div', { class: 'rail-footer-actions' },
        h('a', { class: 'btn btn-quiet', href: '#/signin' }, icon('logout', 16), 'Sign out'))));

  // Desktop Top Bar (Variant C — interchangeable)
  const topbar = h('header', { class: 'topbar' },
    h('div', { class: 'topbar-inner' },
      h('div', { class: 'topbar-left' },
        workspaceSwitcherControl(true),
        h('nav', { class: 'topbar-nav', 'aria-label': 'Main' },
          ...primaryNav.map(item => h('a', {
            href: item.href,
            'aria-current': activeMain === item.key ? 'page' : null
          }, icon(item.ic, 17), item.label)),
          h('a', {
            href: '#/settings/places',
            'aria-current': route.name === 'settings' ? 'page' : null
          }, icon('settings', 17), 'Settings'))),
      h('div', { class: 'topbar-right' },
        layoutToggleControl({ compact: true }),
        h('span', { class: 'pill' }, ROLE_LABELS[ws.role]),
        h('a', { class: 'btn btn-quiet', href: '#/signin' }, 'Sign out'))));

  // Mobile Header
  const mobileHeader = h('header', { class: 'mobile-header' },
    h('button', {
      type: 'button',
      class: 'mobile-ws-btn',
      'aria-expanded': String(state.mobileDrawer === 'switcher'),
      onclick: () => {
        state.mobileDrawer = state.mobileDrawer === 'switcher' ? null : 'switcher';
        render();
      }
    },
    brandMark(28),
    h('span', { class: 'mobile-ws-name' }, ws.name),
    icon('chevronDown', 16)),
    h('button', {
      type: 'button',
      class: 'btn btn-quiet',
      'aria-label': 'Workspace menu',
      'aria-expanded': String(state.mobileDrawer === 'menu'),
      onclick: () => {
        state.mobileDrawer = state.mobileDrawer === 'menu' ? null : 'menu';
        render();
      }
    }, icon('menu', 18), 'Menu'));

  // Mobile Fixed Bottom Tab Bar
  const mobileTabs = h('nav', { class: 'mobile-tabbar', 'aria-label': 'Main navigation' },
    h('a', { class: 'mobile-tab', href: '#/library', 'aria-current': activeMain === 'library' ? 'page' : null },
      icon('library', 20), h('span', null, 'Library')),
    h('a', { class: 'mobile-tab', href: '#/calendar', 'aria-current': activeMain === 'calendar' ? 'page' : null },
      icon('calendar', 20), h('span', null, 'Calendar')),
    h('a', { class: 'mobile-tab', href: '#/search', 'aria-current': activeMain === 'search' ? 'page' : null },
      icon('search', 20), h('span', null, 'Search')),
    h('button', {
      type: 'button',
      class: 'mobile-tab',
      'aria-current': route.name === 'settings' ? 'page' : null,
      'aria-expanded': String(state.mobileDrawer === 'menu'),
      onclick: () => {
        state.mobileDrawer = state.mobileDrawer === 'menu' ? null : 'menu';
        render();
      }
    }, icon('settings', 20), h('span', null, 'More')));

  // Mobile Drawer Sheet (Switcher or Workspace Menu)
  let mobileSheet = null;
  if (state.mobileDrawer === 'switcher') {
    mobileSheet = h('div', {
      class: 'mobile-drawer-backdrop',
      onclick: () => { state.mobileDrawer = null; render(); }
    },
    h('div', { class: 'mobile-sheet', role: 'dialog', 'aria-label': 'Switch workspace', onclick: e => e.stopPropagation() },
      h('div', { class: 'mobile-sheet-head' },
        h('h2', { class: 'section-heading' }, 'Switch workspace'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: () => { state.mobileDrawer = null; render(); } }, icon('close', 20))),
      workspaceOptionsList(),
      h('button', {
        type: 'button',
        class: 'btn',
        onclick: () => {
          state.mobileDrawer = null;
          state.modal = { kind: 'new-workspace' };
          render();
        }
      }, icon('plus', 18), 'New workspace')));
  } else if (state.mobileDrawer === 'menu') {
    mobileSheet = h('div', {
      class: 'mobile-drawer-backdrop',
      onclick: () => { state.mobileDrawer = null; render(); }
    },
    h('div', { class: 'mobile-sheet', role: 'dialog', 'aria-label': 'Workspace menu', onclick: e => e.stopPropagation() },
      h('div', { class: 'mobile-sheet-head' },
        h('div', null,
          h('h2', { class: 'section-heading' }, ws.name),
          h('p', { class: 'field-hint' }, `${ACCOUNT.display_name} · ${ROLE_LABELS[ws.role]}`)),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: () => { state.mobileDrawer = null; render(); } }, icon('close', 20))),
      h('div', { class: 'rail-group' },
        ...workspaceNav.map(item => h('a', {
          class: 'rail-link',
          href: item.href,
          'aria-current': activeSection === item.key ? 'page' : null,
          onclick: () => { state.mobileDrawer = null; }
        },
        h('span', { class: 'rail-link-left' }, icon(item.ic, 18), h('span', null, item.label)),
        item.badge !== undefined ? h('span', { class: 'count-badge' }, String(item.badge)) : null))),
      h('div', { class: 'rail-footer' },
        h('button', {
          type: 'button',
          class: 'btn',
          onclick: () => { state.mobileDrawer = 'switcher'; render(); }
        }, 'Switch workspace'),
        h('a', { class: 'btn btn-quiet', href: '#/signin' }, icon('logout', 16), 'Sign out'))));
  }

  return h('div', { class: 'shell' },
    rail,
    topbar,
    mobileHeader,
    h('main', { class: 'main-area', id: 'main-content', tabindex: '-1' },
      h('div', { class: 'content-wrap' }, mainNode)),
    mobileTabs,
    mobileSheet);
}

// ============================================================
// PANEL STATES (Loading skeleton, Empty with book art, Error)
// ============================================================
function loadingSkeleton(rows = 6) {
  return h('section', { class: 'skeleton-list edge-list-mobile', 'aria-busy': 'true', 'aria-label': 'Loading sermons' },
    ...Array.from({ length: rows }, () => h('div', { class: 'skeleton-row' },
      h('div', { class: 'skel-stack' },
        h('div', { class: 'skel-bar skel-title' }),
        h('div', { class: 'skel-bar skel-sub' })),
      h('div', { class: 'skel-bar skel-meta' }),
      h('div', { class: 'skel-bar skel-meta' }))));
}

function emptyPanel({ title, body, actionLabel, onAction, showArt = true }) {
  return h('section', { class: 'state-panel', role: 'status' },
    showArt ? emptyBooksArt() : null,
    h('h2', { class: 'section-heading' }, title),
    h('p', { class: 'body-copy muted' }, body),
    actionLabel ? h('button', { type: 'button', class: 'btn', onclick: onAction }, actionLabel) : null);
}

function errorPanel({ title, body, onRetry }) {
  return h('section', { class: 'state-panel state-panel-error', role: 'alert' },
    h('h2', { class: 'section-heading' }, title),
    h('p', { class: 'body-copy' }, body),
    h('button', { type: 'button', class: 'btn', onclick: onRetry }, 'Try again'));
}

// ============================================================
// LIBRARY VIEW
// ============================================================
function filterSermons(ws) {
  const q = state.libQuery.trim().toLowerCase();
  const list = ws.sermons.filter(s => {
    const isArch = Boolean(s.archived_at);
    if (state.libArchive === 'active' && isArch) return false;
    if (state.libArchive === 'archived' && !isArch) return false;
    if (state.libSeries !== 'all') {
      if (state.libSeries === '__none__' && s.series_name) return false;
      if (state.libSeries !== '__none__' && s.series_name !== state.libSeries) return false;
    }
    if (!q) return true;
    const hay = [s.title, s.series_name, ...(s.scripture_references || []), ...(s.tags || [])].join(' ').toLowerCase();
    return hay.includes(q);
  });

  const sorted = list.slice();
  if (state.libSort === 'title') {
    sorted.sort((a, b) => a.title.localeCompare(b.title));
  } else if (state.libSort === 'most') {
    sorted.sort((a, b) => b.preaching_events.length - a.preaching_events.length || a.title.localeCompare(b.title));
  } else if (state.libSort === 'added') {
    sorted.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  } else {
    sorted.sort((a, b) => {
      const la = latestEvent(a)?.preached_on || '';
      const lb = latestEvent(b)?.preached_on || '';
      return lb.localeCompare(la) || (b.created_at || '').localeCompare(a.created_at || '');
    });
  }
  return sorted;
}

function sermonListRow(sermon) {
  const last = latestEvent(sermon);
  const swatch = seriesSwatchIndex(sermon.series_name || sermon.title);
  const count = sermon.preaching_events.length;
  const vCount = sermon.versions.length;
  const lastText = last ? formatWhen(last.preached_on, last.date_precision) : 'Not preached yet';

  return h('li', { class: 'sermon-row' },
    h('span', { class: `row-spine spine-${swatch}`, 'aria-hidden': 'true' }),
    h('div', { class: 'row-primary' },
      h('div', { class: 'row-title-line' },
        h('a', { class: 'row-link', href: `#/sermon/${sermon.id}` }, sermon.title),
        sermon.archived_at ? h('span', { class: 'pill pill-warning' }, 'Archived') : null),
      h('div', { class: 'row-sub' },
        sermon.scripture_references.length
          ? h('span', { class: 'row-scripture' }, sermon.scripture_references.join(' · '))
          : h('span', null, 'No Scripture'),
        sermon.series_name ? h('span', null, `· ${sermon.series_name}`) : null)),
    h('span', { class: 'row-col row-col-date' },
      lastText,
      h('span', { class: 'mobile-only-inline' }, ` · ${plural(count, 'time')} · ${plural(vCount, 'version')}`)),
    h('span', { class: 'row-col row-col-right row-col-count' }, plural(count, 'time')),
    h('span', { class: 'row-col row-col-right row-col-versions' }, plural(vCount, 'version')),
    h('span', { class: 'row-chevron', 'aria-hidden': 'true' }, icon('chevronRight', 16)));
}

function sermonTable(items) {
  return h('div', { class: 'panel edge-list-mobile' },
    h('div', { class: 'table-scroll' },
      h('table', { class: 'data-table' },
        h('caption', { class: 'sr-only' }, 'Sermons in workspace'),
        h('thead', null,
          h('tr', null,
            h('th', { scope: 'col' }, 'Title'),
            h('th', { scope: 'col' }, 'Scripture'),
            h('th', { scope: 'col' }, 'Series'),
            h('th', { scope: 'col' }, 'Last preached'),
            h('th', { scope: 'col', class: 'num' }, 'Preachings'),
            h('th', { scope: 'col', class: 'num' }, 'Versions'))),
        h('tbody', null,
          ...items.map(s => {
            const last = latestEvent(s);
            return h('tr', null,
              h('th', { scope: 'row' },
                h('a', { href: `#/sermon/${s.id}` }, s.title),
                s.archived_at ? [' ', h('span', { class: 'pill pill-warning' }, 'Archived')] : null),
              h('td', null, s.scripture_references.join(', ') || '—'),
              h('td', null, s.series_name || 'Standalone'),
              h('td', { class: 'tabular' }, last ? formatWhen(last.preached_on, last.date_precision) : 'Not preached yet'),
              h('td', { class: 'num' }, String(s.preaching_events.length)),
              h('td', { class: 'num' }, String(s.versions.length)));
          })))));
}

function renderLibrary() {
  const ws = currentWorkspace();
  const editor = canEdit(ws.role);
  const activeSermons = ws.sermons.filter(s => !s.archived_at);
  const totalPreachings = ws.sermons.reduce((n, s) => n + s.preaching_events.length, 0);
  const allDates = ws.sermons.flatMap(s => s.preaching_events).filter(e => e.preached_on).sort((a, b) => b.preached_on.localeCompare(a.preached_on));
  const latest = allDates[0];

  const seriesNames = [...new Set(ws.sermons.map(s => s.series_name).filter(Boolean))].sort();
  const filtered = filterSermons(ws);

  const summary = state.panelState === 'loading'
    ? 'Loading workspace sermons…'
    : state.panelState === 'error'
      ? 'Could not load sermons for this workspace.'
      : state.panelState === 'empty'
        ? '0 active sermons · 0 preachings'
        : `${plural(activeSermons.length, 'active sermon')} · ${plural(totalPreachings, 'preaching')}${latest ? ` · last preached ${formatWhen(latest.preached_on, latest.date_precision)}` : ''}`;

  const header = h('header', { class: 'page-head' },
    h('div', { class: 'page-head-left' },
      shelfBooksArt({ width: 96, height: 40 }),
      h('div', { class: 'page-head-copy' },
        h('h1', { class: 'page-title', id: 'page-title', tabindex: '-1' }, 'Library'),
        h('p', { class: 'page-summary' }, summary))),
    h('div', { class: 'page-head-actions' },
      editor
        ? h('button', {
            type: 'button',
            class: 'btn btn-primary',
            onclick: () => { state.modal = { kind: 'new-draft' }; render(); }
          }, icon('plus', 18), 'New draft')
        : h('span', { class: 'pill' }, 'View-only access')));

  // Variant C Series Filter Strip
  const seriesStrip = state.variant === 'C'
    ? h('div', { class: 'series-strip', role: 'group', 'aria-label': 'Filter by series' },
        h('button', {
          type: 'button',
          class: 'series-pill',
          'aria-pressed': String(state.libSeries === 'all'),
          onclick: () => { state.libSeries = 'all'; render(); }
        }, 'All series'),
        ...seriesNames.map(name => h('button', {
          type: 'button',
          class: 'series-pill',
          'aria-pressed': String(state.libSeries === name),
          onclick: () => { state.libSeries = name; render(); }
        }, name)),
        h('button', {
          type: 'button',
          class: 'series-pill',
          'aria-pressed': String(state.libSeries === '__none__'),
          onclick: () => { state.libSeries = '__none__'; render(); }
        }, 'Standalone'))
    : null;

  const filterInput = h('input', {
    id: 'lib-filter',
    class: 'input',
    type: 'search',
    value: state.libQuery,
    placeholder: 'Filter by title, Scripture, series, or tag',
    autocomplete: 'off',
    oninput: e => {
      state.libQuery = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const nextInput = document.getElementById('lib-filter');
      if (nextInput) { nextInput.focus(); nextInput.setSelectionRange(pos, pos); }
    }
  });

  const controls = h('div', { class: 'filter-bar' },
    h('div', { class: 'filter-left' },
      h('div', { class: 'field filter-search' },
        h('label', { class: 'sr-only', for: 'lib-filter' }, 'Filter sermons'),
        h('div', { class: 'search-input-wrap' }, icon('search', 16), filterInput)),
      h('div', { class: 'segmented', role: 'group', 'aria-label': 'Status filter' },
        h('button', {
          type: 'button',
          'aria-pressed': String(state.libArchive === 'active'),
          onclick: () => { state.libArchive = 'active'; render(); }
        }, 'Active'),
        h('button', {
          type: 'button',
          'aria-pressed': String(state.libArchive === 'archived'),
          onclick: () => { state.libArchive = 'archived'; render(); }
        }, 'Archived'))),
    h('div', { class: 'filter-right' },
      h('div', { class: 'filter-selects' },
        state.variant !== 'C'
          ? h('div', { class: 'field' },
              h('label', { class: 'sr-only', for: 'lib-series' }, 'Series'),
              h('select', {
                id: 'lib-series',
                class: 'select',
                onchange: e => { state.libSeries = e.target.value; render(); }
              },
              h('option', { value: 'all', selected: state.libSeries === 'all' }, 'All series'),
              ...seriesNames.map(n => h('option', { value: n, selected: state.libSeries === n }, n)),
              h('option', { value: '__none__', selected: state.libSeries === '__none__' }, 'Standalone')))
          : null,
        h('div', { class: 'field' },
          h('label', { class: 'sr-only', for: 'lib-sort' }, 'Sort sermons'),
          h('select', {
            id: 'lib-sort',
            class: 'select',
            onchange: e => { state.libSort = e.target.value; render(); }
          },
          h('option', { value: 'recent', selected: state.libSort === 'recent' }, 'Last preached'),
          h('option', { value: 'title', selected: state.libSort === 'title' }, 'Title A–Z'),
          h('option', { value: 'most', selected: state.libSort === 'most' }, 'Most preached'),
          h('option', { value: 'added', selected: state.libSort === 'added' }, 'Recently added')))),
      h('div', { class: 'segmented', role: 'group', 'aria-label': 'Layout view' },
        h('button', {
          type: 'button',
          'aria-pressed': String(state.libView === 'rows'),
          onclick: () => { state.libView = 'rows'; render(); }
        }, icon('rows', 15), 'Rows'),
        h('button', {
          type: 'button',
          'aria-pressed': String(state.libView === 'table'),
          onclick: () => { state.libView = 'table'; render(); }
        }, icon('table', 15), 'Table'),
        h('button', {
          type: 'button',
          'aria-pressed': String(state.libView === 'series'),
          onclick: () => { state.libView = 'series'; render(); }
        }, icon('folder', 15), 'Series'))));

  let dataArea;
  if (state.panelState === 'loading') {
    dataArea = loadingSkeleton(6);
  } else if (state.panelState === 'error') {
    dataArea = errorPanel({
      title: 'The library could not be loaded',
      body: 'The workspace could not be reached. Check your connection and try again.',
      onRetry: () => { state.panelState = 'normal'; render(); showToast('Library reloaded.'); }
    });
  } else if (state.panelState === 'empty' || ws.sermons.length === 0) {
    dataArea = emptyPanel({
      title: 'No sermons in this workspace',
      body: editor
        ? 'Start with a draft title. Scripture references, preaching dates, and notes can be added later.'
        : 'No sermons have been added to this workspace yet. Editors and owners can add sermons.',
      actionLabel: editor ? 'Create first draft' : null,
      onAction: () => { state.panelState = 'normal'; state.modal = { kind: 'new-draft' }; render(); }
    });
  } else if (!filtered.length) {
    dataArea = emptyPanel({
      title: 'No sermons match this filter',
      body: 'Clear the search text or switch between Active and Archived sermons.',
      actionLabel: 'Clear filters',
      onAction: () => { state.libQuery = ''; state.libSeries = 'all'; state.libArchive = 'active'; render(); }
    });
  } else if (state.libView === 'table') {
    dataArea = sermonTable(filtered);
  } else if (state.libView === 'series') {
    const groups = new Map();
    for (const s of filtered) {
      const key = s.series_name || 'Standalone sermons';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    dataArea = h('div', { class: 'series-groups' },
      ...[...groups.entries()].map(([name, items]) => h('section', { class: 'series-group' },
        h('div', { class: 'series-group-head' },
          h('h2', { class: 'section-heading' }, name),
          h('span', { class: 'muted tabular' }, plural(items.length, 'sermon'))),
        h('div', { class: 'panel edge-list-mobile' },
          h('ul', { class: 'sermon-list' }, ...items.map(s => sermonListRow(s)))))));
  } else {
    dataArea = h('div', { class: 'panel edge-list-mobile' },
      h('div', { class: 'list-head-row', 'aria-hidden': 'true' },
        h('span'),
        h('span', null, 'Sermon'),
        h('span', null, 'Last preached'),
        h('span', { class: 'row-col-right' }, 'Preached'),
        h('span', { class: 'row-col-right' }, 'Versions'),
        h('span')),
      h('ul', { class: 'sermon-list' }, ...filtered.map(s => sermonListRow(s))));
  }

  return h('div', null,
    header,
    seriesStrip,
    controls,
    state.panelState === 'normal'
      ? h('div', { class: 'results-meta' },
          h('span', null, `Showing ${plural(filtered.length, 'sermon')}${state.libQuery ? ` matching "${state.libQuery}"` : ''}`),
          h('span', null, state.libArchive === 'active' ? 'Active library' : 'Archived sermons'))
      : null,
    dataArea);
}

// ============================================================
// PREACHING CALENDAR VIEW
// ============================================================
function allWorkspaceEvents(ws) {
  const out = [];
  for (const s of ws.sermons) {
    for (const ev of s.preaching_events) {
      out.push({ ...ev, sermon_id: s.id, sermon_title: s.title, sermon_archived: Boolean(s.archived_at), series_name: s.series_name });
    }
  }
  return out;
}

function renderCalendar(route) {
  const ws = currentWorkspace();
  const editor = canEdit(ws.role);
  const y = route.y;
  const m = route.m;
  state.calYear = y;
  state.calMonth = m;

  const events = allWorkspaceEvents(ws);
  const yearEvents = events.filter(e => e.preached_on && Number(e.preached_on.slice(0, 4)) === y);
  const monthPrefix = `${y}-${String(m).padStart(2, '0')}`;
  const exactInMonth = yearEvents.filter(e => ['exact', 'needs_review'].includes(e.date_precision) && e.preached_on.startsWith(monthPrefix));
  const monthOnly = yearEvents.filter(e => e.date_precision === 'month' && e.preached_on.startsWith(monthPrefix));
  const yearOnly = yearEvents.filter(e => e.date_precision === 'year');
  const undated = events.filter(e => e.date_precision === 'unknown' || !e.preached_on);

  const byDay = new Map();
  for (const ev of exactInMonth) {
    const key = ev.preached_on.slice(0, 10);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(ev);
  }

  const selectedDay = (route.d && route.d.startsWith(monthPrefix))
    ? route.d
    : [...byDay.keys()].sort().reverse()[0] || null;
  state.calDay = selectedDay;

  const monthCounts = Array.from({ length: 12 }, (_, idx) => {
    const pfx = `${y}-${String(idx + 1).padStart(2, '0')}`;
    return yearEvents.filter(e => e.date_precision !== 'year' && e.preached_on.startsWith(pfx)).length;
  });
  const maxMonthCount = Math.max(1, ...monthCounts);

  const calHref = (ny, nm, nd) => `#/calendar?y=${ny}&m=${nm}${nd ? `&d=${nd}` : ''}`;
  const prevMonth = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  const nextMonth = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };

  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const weeks = [];
  let row = Array(firstDow).fill(null);
  for (let d = 1; d <= daysInMonth; d++) {
    row.push({ day: d, date: `${monthPrefix}-${String(d).padStart(2, '0')}` });
    if (row.length === 7) { weeks.push(row); row = []; }
  }
  if (row.length) {
    while (row.length < 7) row.push(null);
    weeks.push(row);
  }

  const header = h('header', { class: 'page-head' },
    h('div', { class: 'page-head-left' },
      brandMark(40),
      h('div', { class: 'page-head-copy' },
        h('h1', { class: 'page-title', id: 'page-title', tabindex: '-1' }, 'Preaching Calendar'),
        h('p', { class: 'page-summary' }, `${plural(yearEvents.length, 'preaching')} in ${y} · ${plural(exactInMonth.length + monthOnly.length, 'preaching')} in ${MONTHS[m - 1]}`))),
    h('div', { class: 'page-head-actions' },
      editor
        ? h('button', {
            type: 'button',
            class: 'btn btn-primary',
            onclick: () => { state.modal = { kind: 'log-preaching', sermonId: ws.sermons[0]?.id }; render(); }
          }, icon('plus', 18), 'Log preaching')
        : null));

  const yearStrip = h('section', { class: 'year-strip-panel', 'aria-label': `Months in ${y}` },
    h('div', { class: 'year-strip-head' },
      h('div', { class: 'year-nav' },
        h('a', { class: 'icon-btn', href: calHref(y - 1, m), 'aria-label': `Previous year, ${y - 1}` }, icon('chevronLeft', 18)),
        h('h2', { class: 'year-label' }, String(y)),
        h('a', { class: 'icon-btn', href: calHref(y + 1, m), 'aria-label': `Next year, ${y + 1}` }, icon('chevronRight', 18))),
      h('span', { class: 'muted tabular' }, `${plural(yearEvents.length, 'preaching')} recorded in ${y}`)),
    h('ol', { class: 'year-months' },
      ...MONTHS_SHORT.map((label, idx) => {
        const count = monthCounts[idx];
        const fill = Math.round((count / maxMonthCount) * 100);
        return h('li', null,
          h('a', {
            class: 'month-tile',
            href: calHref(y, idx + 1),
            'aria-current': idx + 1 === m ? 'true' : null,
            'aria-label': `${MONTHS[idx]} ${y}, ${plural(count, 'preaching')}`
          },
          h('span', { class: 'month-tile-name' }, label),
          h('span', { class: 'month-tile-count' }, String(count)),
          h('span', { class: 'month-tile-bar', style: { '--fill': `${count ? Math.max(18, fill) : 0}%` }, 'aria-hidden': 'true' })));
      })));

  const gridPanel = h('section', { class: 'cal-panel', 'aria-label': `${MONTHS[m - 1]} ${y}` },
    h('div', { class: 'cal-month-head' },
      h('div', { class: 'cal-month-nav' },
        h('a', { class: 'icon-btn', href: calHref(prevMonth.y, prevMonth.m), 'aria-label': `Previous month, ${MONTHS[prevMonth.m - 1]} ${prevMonth.y}` }, icon('chevronLeft', 18)),
        h('h2', { class: 'cal-month-title' }, `${MONTHS[m - 1]} ${y}`),
        h('a', { class: 'icon-btn', href: calHref(nextMonth.y, nextMonth.m), 'aria-label': `Next month, ${MONTHS[nextMonth.m - 1]} ${nextMonth.y}` }, icon('chevronRight', 18))),
      h('span', { class: 'muted tabular' }, plural(exactInMonth.length, 'dated preaching'))),
    h('table', { class: 'cal-table' },
      h('caption', { class: 'sr-only' }, `${MONTHS[m - 1]} ${y} preaching calendar`),
      h('thead', null, h('tr', null, ...WEEKDAYS.map(d => h('th', { scope: 'col' }, d)))),
      h('tbody', null,
        ...weeks.map(week => h('tr', null,
          ...week.map(cell => {
            if (!cell) return h('td', null);
            const evs = byDay.get(cell.date);
            const isToday = cell.date === TODAY;
            const isSelected = cell.date === selectedDay;
            if (!evs) {
              return h('td', null,
                h('div', { class: `cal-day${isToday ? ' is-today' : ''}` },
                  h('span', { class: 'cal-day-num' }, String(cell.day))));
            }
            const hasReview = evs.some(e => e.date_precision === 'needs_review');
            return h('td', null,
              h('a', {
                class: `cal-day has-event${isToday ? ' is-today' : ''}${isSelected ? ' is-selected' : ''}`,
                href: calHref(y, m, cell.date),
                'aria-current': isSelected ? 'true' : null,
                'aria-label': `${formatLongDay(cell.date)}, ${plural(evs.length, 'preaching')}`
              },
              h('span', { class: 'cal-day-num' }, String(cell.day)),
              h('span', { class: `cal-day-tag${hasReview ? ' is-review' : ''}` },
                h('span', { class: 'cal-tag-desktop' }, hasReview ? 'Review' : plural(evs.length, 'sermon')),
                h('span', { class: 'cal-tag-mobile' }, hasReview ? 'Rev' : `${evs.length}×`))));
          }))))));

  const dayEvents = selectedDay ? (byDay.get(selectedDay) || []) : [];
  const inspector = h('aside', { class: 'inspector-panel edge-list-mobile', 'aria-label': 'Selected day details' },
    h('div', { class: 'inspector-head' },
      h('h2', { class: 'section-heading' }, selectedDay ? formatLongDay(selectedDay) : `${MONTHS[m - 1]} ${y}`),
      h('p', { class: 'field-hint tabular' }, selectedDay ? plural(dayEvents.length, 'preaching') : 'Select a marked day')),
    dayEvents.length
      ? h('ul', { class: 'inspector-list' },
          ...dayEvents.map(ev => h('li', { class: 'inspector-item' },
            h('a', { class: 'inspector-item-title', href: `#/sermon/${ev.sermon_id}` }, ev.sermon_title),
            h('div', { class: 'detail-chips' },
              ev.date_precision === 'needs_review' ? h('span', { class: 'pill pill-warning' }, 'Date needs review') : null,
              ev.sermon_archived ? h('span', { class: 'pill pill-warning' }, 'Archived') : null),
            h('p', { class: 'inspector-item-meta' }, [ev.place_name, ev.occasion].filter(Boolean).join(' · ') || 'No place recorded'),
            ev.raw_date ? h('p', { class: 'inspector-item-meta' }, `Recorded as "${ev.raw_date}"`) : null)))
      : h('p', { class: 'inspector-empty' }, exactInMonth.length ? 'Select a marked day on the calendar to inspect preachings.' : `No dated preachings recorded for ${MONTHS[m - 1]} ${y}.`));

  const imprecise = [];
  if (monthOnly.length) {
    imprecise.push(h('section', { class: 'imprecise-section' },
      h('h3', { class: 'sub-heading' }, `Recorded for ${MONTHS[m - 1]} ${y} without a specific day`),
      h('div', { class: 'panel edge-list-mobile' },
        h('ul', { class: 'inspector-list' },
          ...monthOnly.map(ev => h('li', { class: 'inspector-item' },
            h('a', { class: 'inspector-item-title', href: `#/sermon/${ev.sermon_id}` }, ev.sermon_title),
            h('p', { class: 'inspector-item-meta' }, [ev.place_name, ev.occasion, ev.raw_date && `Recorded as "${ev.raw_date}"`].filter(Boolean).join(' · '))))))));
  }
  if (yearOnly.length) {
    imprecise.push(h('section', { class: 'imprecise-section' },
      h('h3', { class: 'sub-heading' }, `Recorded for ${y} without a month`),
      h('div', { class: 'panel edge-list-mobile' },
        h('ul', { class: 'inspector-list' },
          ...yearOnly.map(ev => h('li', { class: 'inspector-item' },
            h('a', { class: 'inspector-item-title', href: `#/sermon/${ev.sermon_id}` }, ev.sermon_title),
            h('p', { class: 'inspector-item-meta' }, [ev.place_name, ev.occasion, ev.raw_date && `Recorded as "${ev.raw_date}"`].filter(Boolean).join(' · '))))))));
  }
  if (undated.length) {
    imprecise.push(h('p', { class: 'field-hint tabular' },
      `${plural(undated.length, 'preaching')} in this workspace ${undated.length === 1 ? 'has' : 'have'} no date. Open the sermon record to add a date.`));
  }

  return h('div', null,
    header,
    yearStrip,
    h('div', { class: 'cal-grid-layout' }, gridPanel, inspector),
    ...imprecise);
}

// ============================================================
// SERMON DETAIL & FIND IN NOTES
// ============================================================
function renderSermonDetail(route) {
  const ws = currentWorkspace();
  const sermon = ws.sermons.find(s => s.id === route.id) || ws.sermons[0];
  if (!sermon) return emptyPanel({ title: 'Sermon not found', body: 'This sermon is not in the current workspace.', actionLabel: 'Back to Library', onAction: () => go('#/library') });

  const editor = canEdit(ws.role);
  const isNotesTab = route.tab === 'notes';
  state.sermonTab = route.tab;
  state.notesQuery = route.q;
  const swatch = seriesSwatchIndex(sermon.series_name || sermon.title);
  const versionMap = new Map(sermon.versions.map(v => [v.id, v.label]));
  const events = sermon.preaching_events.slice().reverse();

  const backBar = h('div', { class: 'back-bar' },
    h('a', { class: 'back-link', href: '#/library' }, icon('arrowLeft', 16), 'Library'));

  const headerBand = h('header', { class: `detail-header spine-${swatch}` },
    h('div', { class: 'detail-header-identity' },
      miniBookCover(swatch),
      h('div', { class: 'detail-header-main' },
        sermon.series_name ? h('p', { class: 'detail-series' }, sermon.series_name) : null,
        h('h1', { class: 'page-title', id: 'page-title', tabindex: '-1' }, sermon.title),
        h('div', { class: 'detail-chips' },
          sermon.archived_at ? h('span', { class: 'pill pill-warning' }, 'Archived') : null,
          ...sermon.scripture_references.map(ref => h('span', { class: 'chip-scripture' }, ref)),
          ...sermon.tags.map(tag => h('span', { class: 'chip-tag' }, tag))))),
    editor
      ? h('div', { class: 'detail-actions' },
          !sermon.archived_at
            ? h('button', {
                type: 'button',
                class: `btn${isNotesTab ? '' : ' btn-primary'}`,
                onclick: () => { state.modal = { kind: 'log-preaching', sermonId: sermon.id }; render(); }
              }, icon('plus', 17), 'Log preaching')
            : null,
          h('button', {
            type: 'button',
            class: 'btn',
            onclick: () => { state.modal = { kind: 'edit-sermon', sermonId: sermon.id }; render(); }
          }, icon('edit', 16), 'Edit'),
          h('button', {
            type: 'button',
            class: 'btn',
            onclick: () => { state.modal = { kind: 'archive-sermon', sermonId: sermon.id }; render(); }
          }, icon('archive', 16), sermon.archived_at ? 'Restore' : 'Archive'))
      : h('span', { class: 'pill' }, 'View-only access'));

  const tabs = h('nav', { class: 'tabs', 'aria-label': 'Sermon sections' },
    h('a', { href: `#/sermon/${sermon.id}`, 'aria-current': !isNotesTab ? 'page' : null }, 'Details'),
    h('a', { href: `#/sermon/${sermon.id}?tab=notes&q=${encodeURIComponent(state.notesQuery)}`, 'aria-current': isNotesTab ? 'page' : null }, 'Find in notes'));

  let tabBody;
  if (isNotesTab) {
    const qInput = h('input', {
      id: 'notes-q',
      class: 'input',
      type: 'search',
      value: route.q || '',
      placeholder: 'A phrase or Bible reference like Exodus 16',
      autocomplete: 'off'
    });
    const notesResults = route.q ? runSermonNoteSearch(sermon, route.q) : null;
    const matchedCount = notesResults ? notesResults.filter(r => r.status === 'matched').length : 0;

    tabBody = h('section', { class: 'detail-section', 'aria-labelledby': 'notes-heading' },
      h('h2', { class: 'section-heading', id: 'notes-heading' }, 'Find in notes'),
      h('form', {
        class: 'search-form',
        role: 'search',
        onsubmit: e => {
          e.preventDefault();
          const val = qInput.value.trim();
          state.notesQuery = val;
          go(`#/sermon/${sermon.id}?tab=notes&q=${encodeURIComponent(val)}`);
        }
      },
      h('div', { class: 'search-row' },
        h('div', { class: 'field' },
          h('label', { for: 'notes-q' }, 'Search text in this sermon’s versions'),
          qInput),
        h('button', { type: 'submit', class: 'btn btn-primary' }, icon('search', 16), 'Find')),
      h('p', { class: 'field-hint' }, 'Words are matched as a phrase, in order. A Bible reference also works.')),
      !route.q
        ? h('p', { class: 'muted' }, `Enter a phrase or passage to check which versions of "${sermon.title}" contain it.`)
        : !sermon.versions.length
          ? h('p', { class: 'muted' }, 'This sermon has no versions attached yet.')
          : h('div', { class: 'detail-section' },
              h('p', { class: 'results-meta' }, `Found in ${plural(matchedCount, 'version')} of ${sermon.versions.length}`),
              h('div', { class: 'panel edge-list-mobile' },
                ...notesResults.map(res => {
                  const statusPill = res.status === 'matched'
                    ? h('span', { class: 'pill pill-positive' }, 'Found in notes')
                    : res.status === 'not_in_notes'
                      ? h('span', { class: 'pill' }, 'Not in notes')
                      : h('span', { class: 'pill pill-warning' }, 'Not searchable');
                  return h('div', { class: 'result-row' },
                    h('div', { class: 'version-top' },
                      h('strong', { class: 'version-name' }, res.version.label),
                      statusPill),
                    h('p', { class: 'result-meta' },
                      SOURCE_LABELS[res.version.source_type] || 'Source',
                      res.status === 'matched' ? ` · ${plural(res.match_count, 'match', 'matches')}` : ''),
                    res.status === 'not_in_notes' ? h('p', { class: 'muted' }, 'This version is searchable, and the notes do not contain this phrase.') : null,
                    res.status === 'not_searchable'
                      ? h('p', { class: 'muted' }, res.version.indexing_state === 'revoked'
                        ? 'Search access was revoked for this version.'
                        : res.version.indexing_state === 'awaiting_consent'
                          ? 'Waiting for an Owner to allow search for this PDF.'
                          : 'This version has not been indexed for search.')
                      : null,
                    ...(res.excerpts || []).map(ex => renderExcerpt(ex)));
                }))));
  } else {
    tabBody = h('div', { class: 'detail-grid' },
      h('div', { class: 'detail-main' },
        h('section', { class: 'detail-section', 'aria-labelledby': 'about-heading' },
          h('h2', { class: 'section-heading', id: 'about-heading' }, 'About this sermon'),
          sermon.description
            ? h('p', { class: 'body-copy' }, sermon.description)
            : h('p', { class: 'muted' }, 'No description added yet.')),
        h('section', { class: 'detail-section', 'aria-labelledby': 'history-heading' },
          h('h2', { class: 'section-heading', id: 'history-heading' }, `Preaching history (${events.length})`),
          events.length
            ? h('ol', { class: 'timeline' },
                ...events.map(ev => {
                  const vLabel = versionMap.get(ev.version_id);
                  const details = [ev.place_name, ev.occasion, vLabel && `Version: ${vLabel}`].filter(Boolean);
                  return h('li', { class: 'timeline-item' },
                    h('div', { class: 'timeline-date' },
                      formatWhen(ev.preached_on, ev.date_precision),
                      ev.date_precision === 'needs_review' ? h('span', { class: 'pill pill-warning' }, 'Date needs review') : null),
                    details.length ? h('p', { class: 'timeline-detail' }, details.join(' · ')) : null,
                    ev.raw_date ? h('p', { class: 'timeline-detail' }, `Recorded as "${ev.raw_date}"`) : null);
                }))
            : h('p', { class: 'muted' }, 'Not preached yet. Use Log preaching when this sermon is delivered.'))),
      h('aside', { class: 'detail-aside' },
        h('section', { class: 'detail-section', 'aria-labelledby': 'versions-heading' },
          h('h2', { class: 'section-heading', id: 'versions-heading' }, `Versions (${sermon.versions.length})`),
          sermon.versions.length
            ? h('div', { class: 'panel edge-list-mobile' },
                ...sermon.versions.map(v => {
                  const st = INDEXING_STATUS[v.indexing_state] || INDEXING_STATUS.not_indexed;
                  const link = v.source_type === 'google_doc' && v.google_document_id
                    ? `https://docs.google.com/document/d/${v.google_document_id}/edit`
                    : v.source_url || null;
                  return h('div', { class: 'version-row' },
                    h('div', { class: 'version-top' },
                      h('span', { class: 'version-name' }, v.label),
                      h('span', { class: `pill pill-${st.tone}` }, st.label)),
                    h('span', { class: 'version-sub' }, SOURCE_LABELS[v.source_type] || 'Source'),
                    link ? h('a', { class: 'version-link', href: link, target: '_blank', rel: 'noopener noreferrer' }, 'Open original', icon('external', 14)) : null);
                }))
            : h('p', { class: 'muted' }, 'No versions attached yet.'),
          editor ? h('p', null, h('a', { href: '#/settings/docs' }, 'Manage documents and privacy')) : null),
        h('section', { class: 'detail-section', 'aria-labelledby': 'record-heading' },
          h('h2', { class: 'section-heading', id: 'record-heading' }, 'Record'),
          h('dl', { class: 'facts' },
            h('dt', null, 'Added'), h('dd', null, formatDay(sermon.created_at)),
            h('dt', null, 'Last edited'), h('dd', null, formatDay(sermon.updated_at)),
            h('dt', null, 'Preached'), h('dd', null, plural(events.length, 'time')),
            h('dt', null, 'Workspace'), h('dd', null, ws.name)))));
  }

  return h('article', null, backBar, headerBand, tabs, tabBody);
}

// ============================================================
// GLOBAL SEARCH VIEW
// ============================================================
function renderSearch(route) {
  const ws = currentWorkspace();
  state.searchQuery = route.q;
  state.searchScope = route.scope;
  state.searchArchived = route.archived;

  const qInput = h('input', {
    id: 'global-search-q',
    class: 'input',
    type: 'search',
    value: route.q || '',
    placeholder: 'A phrase or a Bible reference like John 3:16',
    autocomplete: 'off'
  });
  const archCheck = h('input', {
    id: 'search-archived',
    type: 'checkbox',
    checked: route.archived,
    onchange: () => run(route.scope)
  });

  function run(scope) {
    const q = qInput.value.trim();
    const arch = archCheck.checked ? '&archived=1' : '';
    go(`#/search?q=${encodeURIComponent(q)}&scope=${scope}${arch}`);
  }

  const header = h('header', { class: 'page-head' },
    h('div', { class: 'page-head-copy' },
      h('h1', { class: 'page-title', id: 'page-title', tabindex: '-1' }, 'Search'),
      h('p', { class: 'page-summary' }, 'Find sermons by Scripture passage metadata or inside indexed notes.')));

  const form = h('form', {
    class: 'search-form',
    role: 'search',
    onsubmit: e => { e.preventDefault(); run(route.scope); }
  },
  h('div', { class: 'search-row' },
    h('div', { class: 'field' },
      h('label', { for: 'global-search-q' }, 'Search this workspace'),
      qInput),
    h('button', { type: 'submit', class: 'btn btn-primary' }, icon('search', 17), 'Search')),
  h('div', { class: 'search-options' },
    h('div', { class: 'segmented', role: 'group', 'aria-label': 'Search scope' },
      ...[
        ['everything', 'Everything'],
        ['bible', 'Bible verses'],
        ['notes', 'Inside notes']
      ].map(([key, label]) => h('button', {
        type: 'button',
        'aria-pressed': String(route.scope === key),
        onclick: () => run(key)
      }, label))),
    h('label', { class: 'check-label', for: 'search-archived' }, archCheck, 'Include archived sermons')));

  let resultsArea;
  if (!route.q) {
    resultsArea = h('div', { class: 'state-panel' },
      emptyBooksArt(),
      h('h2', { class: 'section-heading' }, 'Search passages and indexed notes'),
      h('p', { class: 'body-copy muted' }, 'Words are matched as a phrase, in order. Notes only appear once an Owner has allowed them to be searched.'),
      h('div', { class: 'quick-queries' },
        h('span', { class: 'field-hint' }, 'Try:'),
        ...['John 3:16', 'grace', 'shepherd', 'Exodus 16'].map(sample => h('button', {
          type: 'button',
          class: 'quick-query-btn',
          onclick: () => go(`#/search?q=${encodeURIComponent(sample)}&scope=everything`)
        }, sample))));
  } else {
    const res = runWorkspaceSearch(ws, route.q, { scope: route.scope, includeArchived: route.archived });
    if (res.needsReference) {
      resultsArea = h('div', { class: 'notice-box', role: 'status' },
        `"${route.q}" is not a Bible reference. Try a reference like John 3:16, or switch scope to Everything.`);
    } else {
      const total = res.metadata.length + res.notes.length;
      const groups = [];
      if (route.scope !== 'notes') {
        groups.push(h('section', { class: 'result-group', 'aria-labelledby': 'grp-passages' },
          h('div', { class: 'result-group-head' },
            h('h2', { class: 'section-heading', id: 'grp-passages' }, `Sermon passage (metadata) (${res.metadata.length})`),
            h('span', { class: 'result-group-note' }, 'Matches the Scripture the sermon is about. Notes were not read.')),
          res.metadata.length
            ? h('div', { class: 'panel edge-list-mobile' },
                ...res.metadata.map(hit => h('div', { class: 'result-row' },
                  h('a', { class: 'result-title', href: `#/sermon/${hit.sermon.id}?tab=notes&q=${encodeURIComponent(route.q)}` }, hit.sermon.title),
                  h('div', { class: 'result-meta' },
                    h('span', { class: 'pill' }, 'Sermon passage (metadata)'),
                    h('span', { class: 'chip-scripture' }, hit.passage),
                    hit.sermon.series_name ? h('span', null, hit.sermon.series_name) : null))))
            : h('p', { class: 'muted' }, 'No sermon is tagged with this passage.')));
      }
      groups.push(h('section', { class: 'result-group', 'aria-labelledby': 'grp-notes' },
        h('div', { class: 'result-group-head' },
          h('h2', { class: 'section-heading', id: 'grp-notes' }, `Found in notes (${res.notes.length})`)),
        res.notes.length
          ? h('div', { class: 'panel edge-list-mobile' },
              ...res.notes.map(hit => h('div', { class: 'result-row' },
                h('a', { class: 'result-title', href: `#/sermon/${hit.sermon.id}?tab=notes&q=${encodeURIComponent(route.q)}` }, hit.sermon.title),
                h('div', { class: 'result-meta' },
                  h('span', { class: 'pill pill-positive' }, 'Found in notes'),
                  h('strong', null, hit.version.label),
                  h('span', null, `· ${SOURCE_LABELS[hit.version.source_type]} · ${plural(hit.match_count, 'match', 'matches')}`)),
                hit.excerpt ? renderExcerpt(hit.excerpt) : null)))
          : h('p', { class: 'muted' }, 'No indexed notes contain this query.')));

      resultsArea = h('div', { class: 'result-groups' },
        h('p', { class: 'results-meta' }, `${plural(total, 'result')} for "${route.q}"${res.isRef ? ' (Bible reference)' : ''}`),
        ...groups);
    }
  }

  return h('div', null, header, form, resultsArea);
}

// ============================================================
// SETTINGS SECTIONS
// ============================================================
function renderSettings(route) {
  const ws = currentWorkspace();
  const section = route.section;
  const editor = canEdit(ws.role);
  const owner = ws.role === 'owner';

  if (section === 'places') {
    return h('div', { class: 'settings-stack' },
      h('header', { class: 'page-head' },
        h('div', { class: 'page-head-copy' },
          h('h1', { class: 'page-title', id: 'page-title', tabindex: '-1' }, 'Places'),
          h('p', { class: 'page-summary' }, 'Rename a place or merge duplicates. Merged names stay as aliases for imports.'))),
      h('div', { class: 'panel edge-list-mobile' },
        ...ws.places.map(pl => h('div', { class: 'place-row' },
          h('div', { class: 'place-info' },
            h('strong', null, pl.display_name),
            h('span', { class: 'field-hint tabular' }, plural(pl.event_count, 'preaching')),
            pl.aliases.length ? h('span', { class: 'field-hint' }, `Also known as: ${pl.aliases.join(', ')}`) : null),
          editor
            ? h('div', { class: 'row-actions' },
                h('button', { type: 'button', class: 'btn', onclick: () => showToast(`Rename dialog for ${pl.display_name} (prototype stub).`) }, 'Rename'),
                h('button', { type: 'button', class: 'btn', onclick: () => showToast(`Merge preview for ${pl.display_name} (prototype stub).`) }, 'Merge'))
            : null))));
  }

  if (section === 'docs') {
    const versions = ws.sermons.flatMap(s => s.versions.map(v => ({ sermon: s, version: v })));
    return h('div', { class: 'settings-stack' },
      h('header', { class: 'page-head' },
        h('div', { class: 'page-head-copy' },
          h('h1', { class: 'page-title', id: 'page-title', tabindex: '-1' }, 'Docs & Privacy'),
          h('p', { class: 'page-summary' }, 'PDF text stays private until an Owner allows search. Revoking deletes extracted text permanently.'))),
      h('div', { class: 'panel edge-list-mobile' },
        ...versions.map(({ sermon, version }) => {
          const st = INDEXING_STATUS[version.indexing_state] || INDEXING_STATUS.not_indexed;
          return h('div', { class: 'place-row' },
            h('div', { class: 'place-info' },
              h('div', { class: 'row-title-line' },
                h('strong', null, `${sermon.title} — ${version.label}`),
                h('span', { class: `pill pill-${st.tone}` }, st.label)),
              h('span', { class: 'field-hint' }, SOURCE_LABELS[version.source_type])),
            owner
              ? h('div', { class: 'row-actions' },
                  version.indexing_state === 'awaiting_consent'
                    ? h('button', {
                        type: 'button',
                        class: 'btn btn-primary',
                        onclick: () => { version.indexing_state = 'indexed'; render(); showToast(`Search allowed for ${version.label}.`); }
                      }, 'Allow search')
                    : null,
                  ['indexed', 'awaiting_consent', 'failed'].includes(version.indexing_state)
                    ? h('button', {
                        type: 'button',
                        class: 'btn btn-danger',
                        onclick: () => { version.indexing_state = 'revoked'; version.notes = null; render(); showToast(`Revoked search access for ${version.label}.`); }
                      }, 'Revoke')
                    : null)
              : null);
        })));
  }

  if (section === 'people') {
    return h('div', { class: 'settings-stack' },
      h('header', { class: 'page-head' },
        h('div', { class: 'page-head-copy' },
          h('h1', { class: 'page-title', id: 'page-title', tabindex: '-1' }, 'People & Access'),
          h('p', { class: 'page-summary' }, 'Accepted members of this workspace. Pending invitations are not listed here.')),
        h('div', { class: 'page-head-actions' },
          h('button', { type: 'button', class: 'btn btn-primary', onclick: () => showToast('Invitation code created (prototype stub).') }, icon('plus', 17), 'Invite member'))),
      h('div', { class: 'panel edge-list-mobile' },
        h('div', { class: 'table-scroll' },
          h('table', { class: 'data-table' },
            h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Email'), h('th', null, 'Role'), h('th', null, 'Joined'))),
            h('tbody', null,
              ...ws.members.map(mem => h('tr', null,
                h('th', { scope: 'row' }, mem.display_name, mem.account_id === ACCOUNT.id ? [' ', h('span', { class: 'pill pill-accent' }, 'You')] : null),
                h('td', null, mem.email),
                h('td', null, ROLE_LABELS[mem.role]),
                h('td', { class: 'tabular' }, formatDay(mem.accepted_at)))))))));
  }

  return h('div', { class: 'settings-stack' },
    h('header', { class: 'page-head' },
      h('div', { class: 'page-head-copy' },
        h('h1', { class: 'page-title', id: 'page-title', tabindex: '-1' }, 'Workspace'),
        h('p', { class: 'page-summary' }, 'Current workspace details, navigation layout preference, and role permissions.')),
      h('div', { class: 'page-head-actions' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: () => { state.modal = { kind: 'new-workspace' }; render(); } }, icon('plus', 17), 'New workspace'))),
    h('dl', { class: 'facts' },
      h('dt', null, 'Workspace name'), h('dd', null, ws.name),
      h('dt', null, 'Your role'), h('dd', null, ROLE_LABELS[ws.role]),
      h('dt', null, 'Signed in as'), h('dd', null, `${ACCOUNT.display_name} (${ACCOUNT.email})`),
      h('dt', null, 'Sermons'), h('dd', null, String(ws.sermons.length)),
      h('dt', null, 'Desktop layout'), h('dd', null, layoutToggleControl({ compact: true }))),
    h('div', { class: 'panel edge-list-mobile' },
      h('div', { class: 'table-scroll' },
        h('table', { class: 'data-table' },
          h('thead', null, h('tr', null, h('th', null, 'Ability'), h('th', null, 'Owner'), h('th', null, 'Admin'), h('th', null, 'Editor'), h('th', null, 'Viewer'))),
          h('tbody', null,
            ...ROLE_ABILITIES.map(([label, roles]) => h('tr', null,
              h('th', { scope: 'row' }, label),
              ...['owner', 'admin', 'editor', 'viewer'].map(r => h('td', null, roles.includes(r) ? 'Yes' : '—')))))))));
}

// ============================================================
// SIGN-IN & NO-WORKSPACE ONBOARDING SCREENS
// ============================================================
function renderSignIn() {
  return h('main', { class: 'auth-page', id: 'main-content', tabindex: '-1' },
    h('section', { class: 'auth-card', 'aria-labelledby': 'page-title' },
      h('div', { class: 'auth-shelf-band' },
        brandMark(40),
        shelfBooksArt({ width: 108, height: 44 })),
      h('div', { class: 'auth-body' },
        h('div', { class: 'auth-head' },
          h('h1', { class: 'auth-title', id: 'page-title', tabindex: '-1' }, 'Sermon Bank'),
          h('p', { class: 'auth-sub' }, 'Sign in to open your workspace.')),
        h('button', {
          type: 'button',
          class: 'btn btn-primary google-btn',
          onclick: () => { showToast(`Signed in as ${ACCOUNT.display_name}.`); go('#/library'); }
        },
        h('span', { class: 'google-badge' }, googleMark()),
        h('span', { class: 'google-btn-label' }, 'Continue with Google')),
        h('p', { class: 'auth-note' }, 'Any Google account can sign in. If you were invited, use the Google account the invitation was made for.'))));
}

function renderOnboarding() {
  const nameInput = h('input', { id: 'onboard-ws-name', class: 'input', type: 'text', value: 'My Sermons', maxlength: 120, required: true });
  const nameErr = h('p', { class: 'field-error', hidden: true });
  const codeInput = h('input', { id: 'onboard-code', class: 'input', type: 'text', placeholder: 'Paste invitation code', maxlength: 80 });

  return h('main', { class: 'main-area', id: 'main-content', tabindex: '-1' },
    h('div', { class: 'onboarding-wrap' },
      h('div', { class: 'onboarding-head' },
        h('div', { class: 'rail-brand' }, brandMark(32), h('span', { class: 'rail-app-name' }, 'Sermon Bank')),
        shelfBooksArt({ width: 96, height: 40 })),
      h('div', { class: 'page-head-copy' },
        h('h1', { class: 'page-title', id: 'page-title', tabindex: '-1' }, 'You do not have a workspace yet'),
        h('p', { class: 'page-summary' }, 'Create your own private workspace, or enter an invitation code from an owner.')),
      h('section', { class: 'onboarding-panel', 'aria-labelledby': 'create-ws-h' },
        h('h2', { class: 'section-heading', id: 'create-ws-h' }, 'New workspace'),
        h('form', {
          class: 'onboarding-form',
          novalidate: true,
          onsubmit: e => {
            e.preventDefault();
            const val = nameInput.value.trim();
            if (val.length < 3 || val.length > 120) {
              nameInput.setAttribute('aria-invalid', 'true');
              nameErr.textContent = 'The name must be 3 to 120 characters.';
              nameErr.hidden = false;
              nameInput.focus();
              return;
            }
            const id = 'ws-' + Date.now();
            state.workspaces.push({ id, name: val, role: 'owner', places: [], members: [{ account_id: ACCOUNT.id, display_name: ACCOUNT.display_name, email: ACCOUNT.email, role: 'owner', accepted_at: TODAY }], sermons: [] });
            state.workspaceId = id;
            showToast(`Workspace "${val}" created.`);
            go('#/library');
          }
        },
        h('div', { class: 'field' },
          h('label', { for: 'onboard-ws-name' }, 'Workspace name'),
          nameInput,
          h('p', { class: 'field-hint' }, 'Between 3 and 120 characters.'),
          nameErr),
        h('div', null, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Create workspace')))),
      h('section', { class: 'onboarding-panel', 'aria-labelledby': 'join-ws-h' },
        h('h2', { class: 'section-heading', id: 'join-ws-h' }, 'Join with a code'),
        h('form', {
          class: 'onboarding-form',
          onsubmit: e => {
            e.preventDefault();
            showToast('Invitation accepted. Opening workspace.');
            go('#/library');
          }
        },
        h('div', { class: 'field' },
          h('label', { for: 'onboard-code' }, 'Invitation code'),
          codeInput,
          h('p', { class: 'field-hint' }, 'Sign in with the Google account the invitation was made for.')),
        h('div', null, h('button', { type: 'submit', class: 'btn' }, 'Join workspace'))))));
}

// ============================================================
// MODALS (New Workspace, New Draft, Log Preaching, Edit, Archive)
// ============================================================
function renderModal() {
  if (!state.modal) return null;
  const ws = currentWorkspace();
  const close = () => { state.modal = null; render(); };

  let title = '';
  let body = null;

  if (state.modal.kind === 'new-workspace') {
    title = 'New workspace';
    const input = h('input', { id: 'modal-ws-name', class: 'input', type: 'text', placeholder: 'For example Sunday Sermons', maxlength: 120 });
    const err = h('p', { class: 'field-error', hidden: true });
    body = h('form', {
      class: 'modal-form',
      novalidate: true,
      onsubmit: e => {
        e.preventDefault();
        const name = input.value.trim();
        if (name.length < 3 || name.length > 120) {
          input.setAttribute('aria-invalid', 'true');
          err.textContent = 'The name must be 3 to 120 characters.';
          err.hidden = false;
          input.focus();
          return;
        }
        const id = 'ws-' + Date.now();
        state.workspaces.push({ id, name, role: 'owner', places: [], members: [{ account_id: ACCOUNT.id, display_name: ACCOUNT.display_name, email: ACCOUNT.email, role: 'owner', accepted_at: TODAY }], sermons: [] });
        state.workspaceId = id;
        state.modal = null;
        showToast(`Workspace "${name}" created.`);
        go('#/library');
      }
    },
    h('div', { class: 'field' },
      h('label', { for: 'modal-ws-name' }, 'Workspace name'),
      input,
      h('p', { class: 'field-hint' }, 'Between 3 and 120 characters.'),
      err),
    h('div', { class: 'modal-actions' },
      h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'),
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Create workspace')));
  } else if (state.modal.kind === 'new-draft') {
    title = 'New sermon draft';
    const input = h('input', { id: 'modal-draft-title', class: 'input', type: 'text', placeholder: 'Sermon title', maxlength: 200 });
    const err = h('p', { class: 'field-error', hidden: true });
    body = h('form', {
      class: 'modal-form',
      novalidate: true,
      onsubmit: e => {
        e.preventDefault();
        const t = input.value.trim();
        if (!t) {
          input.setAttribute('aria-invalid', 'true');
          err.textContent = 'Enter a title for the sermon.';
          err.hidden = false;
          input.focus();
          return;
        }
        const id = 'sermon-' + Date.now();
        ws.sermons.unshift({
          id, title: t, series_name: '', scripture_references: [], tags: [],
          description: '', created_at: `${TODAY} 12:00:00`, updated_at: `${TODAY} 12:00:00`,
          archived_at: null, versions: [], preaching_events: []
        });
        state.modal = null;
        showToast('Draft created.');
        go(`#/sermon/${id}`);
      }
    },
    h('div', { class: 'field' },
      h('label', { for: 'modal-draft-title' }, 'Title'),
      input,
      h('p', { class: 'field-hint' }, 'Only a title is needed. Scripture, versions, and places can be added later.'),
      err),
    h('div', { class: 'modal-actions' },
      h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'),
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Create draft')));
  } else if (state.modal.kind === 'log-preaching') {
    const sermon = ws.sermons.find(s => s.id === state.modal.sermonId) || ws.sermons[0];
    title = 'Log a preaching';
    const sermonSel = h('select', { id: 'modal-log-sermon', class: 'select' },
      ...ws.sermons.filter(s => !s.archived_at).map(s => h('option', { value: s.id, selected: s.id === sermon?.id }, s.title)));
    const precSel = h('select', { id: 'modal-log-prec', class: 'select' },
      h('option', { value: 'exact', selected: true }, 'Exact day'),
      h('option', { value: 'month' }, 'Month and year'),
      h('option', { value: 'year' }, 'Year only'),
      h('option', { value: 'unknown' }, 'Date unknown'));
    const dateInput = h('input', { id: 'modal-log-date', class: 'input', type: 'date', value: TODAY });
    const placeSel = h('select', { id: 'modal-log-place', class: 'select' },
      h('option', { value: '' }, 'No place recorded'),
      ...ws.places.map(p => h('option', { value: p.id }, p.display_name)));
    const occInput = h('input', { id: 'modal-log-occ', class: 'input', type: 'text', placeholder: 'For example Sunday morning or Youth night' });

    body = h('form', {
      class: 'modal-form',
      onsubmit: e => {
        e.preventDefault();
        const target = ws.sermons.find(s => s.id === sermonSel.value);
        const pl = ws.places.find(p => p.id === placeSel.value);
        if (target) {
          target.preaching_events.push({
            id: 'ev-' + Date.now(),
            preached_on: precSel.value === 'unknown' ? null : (dateInput.value || TODAY),
            date_precision: precSel.value,
            place_id: pl?.id || null,
            place_name: pl?.display_name || '',
            occasion: occInput.value.trim(),
            version_id: target.versions[0]?.id || null,
            raw_date: null
          });
        }
        state.modal = null;
        showToast('Preaching logged.');
        render();
      }
    },
    h('div', { class: 'field' }, h('label', { for: 'modal-log-sermon' }, 'Sermon'), sermonSel),
    h('div', { class: 'field' }, h('label', { for: 'modal-log-prec' }, 'Date precision'), precSel),
    h('div', { class: 'field' }, h('label', { for: 'modal-log-date' }, 'Date'), dateInput),
    h('div', { class: 'field' }, h('label', { for: 'modal-log-place' }, 'Place'), placeSel),
    h('div', { class: 'field' }, h('label', { for: 'modal-log-occ' }, 'Occasion'), occInput),
    h('div', { class: 'modal-actions' },
      h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'),
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Log preaching')));
  } else if (state.modal.kind === 'edit-sermon') {
    const sermon = ws.sermons.find(s => s.id === state.modal.sermonId);
    title = 'Edit sermon';
    const tIn = h('input', { id: 'ed-t', class: 'input', value: sermon.title });
    const sIn = h('input', { id: 'ed-s', class: 'input', value: sermon.series_name });
    const rIn = h('textarea', { id: 'ed-r', class: 'textarea', value: sermon.scripture_references.join('\n') });
    const dIn = h('textarea', { id: 'ed-d', class: 'textarea', value: sermon.description });
    body = h('form', {
      class: 'modal-form',
      onsubmit: e => {
        e.preventDefault();
        if (tIn.value.trim()) sermon.title = tIn.value.trim();
        sermon.series_name = sIn.value.trim();
        sermon.scripture_references = rIn.value.split('\n').map(x => x.trim()).filter(Boolean);
        sermon.description = dIn.value.trim();
        state.modal = null;
        showToast('Changes saved.');
        render();
      }
    },
    h('div', { class: 'field' }, h('label', { for: 'ed-t' }, 'Title'), tIn),
    h('div', { class: 'field' }, h('label', { for: 'ed-s' }, 'Series'), sIn),
    h('div', { class: 'field' }, h('label', { for: 'ed-r' }, 'Scripture references'), rIn, h('p', { class: 'field-hint' }, 'One per line.')),
    h('div', { class: 'field' }, h('label', { for: 'ed-d' }, 'Description'), dIn),
    h('div', { class: 'modal-actions' },
      h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'),
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save changes')));
  } else if (state.modal.kind === 'archive-sermon') {
    const sermon = ws.sermons.find(s => s.id === state.modal.sermonId);
    const restore = Boolean(sermon.archived_at);
    title = restore ? 'Restore this sermon?' : 'Archive this sermon?';
    body = h('div', { class: 'modal-form' },
      h('p', { class: 'body-copy' }, restore
        ? `Restore "${sermon.title}" to the active library?`
        : `Archive "${sermon.title}"? Its ${plural(sermon.preaching_events.length, 'preaching')} and versions are kept and can be restored at any time.`),
      h('div', { class: 'modal-actions' },
        h('button', { type: 'button', class: 'btn', id: 'modal-cancel-focus', onclick: close }, 'Cancel'),
        h('button', {
          type: 'button',
          class: `btn ${restore ? 'btn-primary' : 'btn-danger-fill'}`,
          onclick: () => {
            sermon.archived_at = restore ? null : `${TODAY} 12:00:00`;
            state.modal = null;
            showToast(restore ? 'Sermon restored.' : 'Sermon archived.');
            render();
          }
        }, restore ? 'Restore sermon' : 'Archive sermon')));
  }

  return h('div', { class: 'modal-backdrop', onclick: close },
    h('div', { class: 'modal-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-title', onclick: e => e.stopPropagation() },
      h('div', { class: 'modal-head' },
        h('h2', { class: 'section-heading', id: 'modal-title' }, title),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close dialog', onclick: close }, icon('close', 20))),
      body));
}

// ============================================================
// RENDER LOOP & EVENTS
// ============================================================
function render() {
  document.body.dataset.variant = state.variant;
  const route = parseHash();

  let view;
  if (route.name === 'signin') {
    document.title = 'Sign in · Sermon Bank';
    view = renderSignIn();
  } else if (route.name === 'onboarding') {
    document.title = 'New workspace · Sermon Bank';
    view = renderOnboarding();
  } else {
    let mainNode;
    if (route.name === 'calendar') {
      document.title = 'Preaching Calendar · Sermon Bank';
      mainNode = renderCalendar(route);
    } else if (route.name === 'sermon') {
      document.title = 'Sermon · Sermon Bank';
      mainNode = renderSermonDetail(route);
    } else if (route.name === 'search') {
      document.title = 'Search · Sermon Bank';
      mainNode = renderSearch(route);
    } else if (route.name === 'settings') {
      document.title = 'Settings · Sermon Bank';
      mainNode = renderSettings(route);
    } else {
      document.title = 'Library · Sermon Bank';
      mainNode = renderLibrary();
    }
    view = renderShell(route, mainNode);
  }

  if (state.modal) view.setAttribute('inert', '');
  appRoot.replaceChildren(view, ...(state.modal ? [renderModal()] : []));
}

window.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (state.modal || state.switcherOpen || state.mobileDrawer) {
      state.modal = null;
      state.switcherOpen = false;
      state.mobileDrawer = null;
      render();
    }
  }
});

window.addEventListener('click', () => {
  if (state.switcherOpen) {
    state.switcherOpen = false;
    render();
  }
});

window.addEventListener('hashchange', render);

if (params.get('modal') === 'new-workspace') state.modal = { kind: 'new-workspace' };
if (params.get('switcher') === 'open') state.switcherOpen = true;

render();
