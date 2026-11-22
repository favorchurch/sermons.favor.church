// The persistent header: workspace switcher ("Sermon Bank"), signed-in person and sign out.
import { h, uid } from '../dom.js';
import { ROLE_LABELS } from '../permissions.js';
import { hrefFor } from '../router.js';

const NAV = [['library', 'Library', { name: 'library', view: 'covers' }], ['search', 'Search', { name: 'search', q: '', scope: 'everything' }], ['settings', 'Settings', { name: 'settings', section: 'places' }]];

function mainNav(route) {
  const active = ['library', 'sermon'].includes(route.name) ? 'library' : route.name;
  return h('nav', { class: 'main-nav', 'aria-label': 'Main' },
    ...NAV.map(([key, label, target]) => h('a', { href: hrefFor(target), 'aria-current': key === active ? 'page' : null }, label)));
}

function headerSearch(ctx) {
  const input = h('input', { id: 'header-search', type: 'search', name: 'q', maxlength: 200, placeholder: 'Search sermons and notes', autocomplete: 'off' });
  return h('form', { class: 'header-search', role: 'search', onsubmit: event => { event.preventDefault(); if (input.value.trim()) ctx.search(input.value); } },
    h('label', { class: 'sr-only', for: 'header-search' }, 'Search this workspace'), input,
    h('button', { type: 'submit', class: 'btn btn-quiet' }, 'Search'));
}

export function header(ctx) {
  const { state } = ctx;
  const current = state.workspaces.find(w => w.id === state.workspaceId);
  const menuId = uid('workspace-menu');
  const brand = h('div', { class: 'brand' },
    h('img', { class: 'brand-mark', src: '/assets/icon.svg', alt: '', width: 38, height: 38 }),
    h('div', { class: 'brand-text' },
      h('span', { class: 'brand-name' }, 'Sermon Bank'),
      current ? h('span', { class: 'brand-workspace' }, current.name) : null));

  let switcher = null;
  if (state.account && current) {
    const setOpen = open => {
      if (open) menu.removeAttribute('hidden'); else menu.setAttribute('hidden', '');
      toggle.setAttribute('aria-expanded', String(open));
    };
    const menu = h('ul', { class: 'menu', id: menuId, hidden: true },
      ...state.workspaces.map(w => h('li', null, h('button', {
        type: 'button', 'aria-pressed': String(w.id === state.workspaceId), onclick: () => ctx.switchWorkspace(w.id)
      }, w.name, h('span', { class: 'muted' }, ` · ${ROLE_LABELS[w.role] || w.role}`)))),
      h('li', { class: 'menu-new' }, h('button', {
        type: 'button', 'data-action': 'new-workspace',
        // Focus goes back to the toggle first, so closing the dialog returns focus to a visible control.
        onclick: () => { setOpen(false); toggle.focus(); ctx.newWorkspace(); }
      }, 'New workspace')));
    const toggle = h('button', {
      type: 'button', class: 'btn btn-quiet', 'aria-expanded': 'false', 'aria-controls': menuId,
      onclick: () => setOpen(menu.hasAttribute('hidden'))
    }, 'Switch workspace ▾');
    switcher = h('div', { class: 'switcher' }, toggle, menu);
  }

  const signedIn = Boolean(state.account && current);
  return h('div', { class: 'header-inner' },
    brand,
    signedIn ? mainNav(ctx.route) : null,
    h('div', { class: 'header-right' },
      signedIn ? headerSearch(ctx) : null,
      switcher,
      state.account ? h('span', { class: 'who' }, state.account.display_name, current ? h('span', { class: 'pill' }, ROLE_LABELS[current.role] || current.role) : null) : null,
      state.account ? h('button', { type: 'button', class: 'btn btn-quiet', onclick: ctx.signOut }, 'Sign out') : null));
}
