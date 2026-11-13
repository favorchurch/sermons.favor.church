// The persistent header: workspace switcher ("My Sermons"), signed-in person and sign out.
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
    h('label', { class: 'sr-only', for: 'header-search' }, 'Search the archive'), input,
    h('button', { type: 'submit', class: 'btn btn-quiet' }, 'Search'));
}

export function header(ctx) {
  const { state } = ctx;
  const current = state.workspaces.find(w => w.id === state.workspaceId);
  const menuId = uid('workspace-menu');
  const brand = h('div', { class: 'brand' },
    h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, '✳'),
    h('div', { class: 'brand-text' },
      h('span', { class: 'brand-name' }, 'My Sermons'),
      current ? h('span', { class: 'brand-workspace' }, current.name) : null));

  let switcher = null;
  if (state.workspaces.length > 1) {
    const menu = h('ul', { class: 'menu', id: menuId, hidden: true },
      ...state.workspaces.map(w => h('li', null, h('button', {
        type: 'button', 'aria-pressed': String(w.id === state.workspaceId), onclick: () => ctx.switchWorkspace(w.id)
      }, w.name, h('span', { class: 'muted' }, ` · ${ROLE_LABELS[w.role] || w.role}`)))));
    const toggle = h('button', {
      type: 'button', class: 'btn btn-quiet', 'aria-expanded': 'false', 'aria-controls': menuId,
      onclick: () => {
        const open = menu.hasAttribute('hidden');
        if (open) menu.removeAttribute('hidden'); else menu.setAttribute('hidden', '');
        toggle.setAttribute('aria-expanded', String(open));
      }
    }, 'Switch archive ▾');
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
