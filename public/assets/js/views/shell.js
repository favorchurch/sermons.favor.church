// The persistent header: workspace switcher ("My Sermons"), signed-in person and sign out.
import { h, uid } from '../dom.js';
import { ROLE_LABELS } from '../permissions.js';

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

  return h('div', { class: 'header-inner' },
    brand,
    h('div', { class: 'header-right' },
      switcher,
      state.account ? h('span', { class: 'who' }, state.account.display_name, current ? h('span', { class: 'pill' }, ROLE_LABELS[current.role] || current.role) : null) : null,
      state.account ? h('button', { type: 'button', class: 'btn btn-quiet', onclick: ctx.signOut }, 'Sign out') : null));
}
