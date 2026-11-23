// Persistent app navigation. The Original branch preserves the origin/main shell markup.
import { h, uid } from '../dom.js';
import { ROLE_LABELS } from '../permissions.js';
import { hrefFor } from '../router.js';

const NAV = [
  ['library', 'Library', { name: 'library', view: 'covers' }],
  ['search', 'Search', { name: 'search', q: '', scope: 'everything' }],
  ['settings', 'Settings', { name: 'settings', section: 'places' }]
];

function mainNav(route, className = 'main-nav', extra = null) {
  const active = ['library', 'sermon'].includes(route.name) ? 'library' : route.name;
  return h('nav', { class: className, 'aria-label': 'Main' },
    ...NAV.map(([key, label, target]) => h('a', {
      href: hrefFor(target),
      'aria-current': key === active ? 'page' : null
    }, className === 'theme-nav' ? h('span', { class: 'theme-tab-label' }, label) : label)),
    extra);
}

function headerSearch(ctx) {
  const input = h('input', { id: 'header-search', type: 'search', name: 'q', maxlength: 200, placeholder: 'Search sermons and notes', autocomplete: 'off' });
  return h('form', { class: 'header-search', role: 'search', onsubmit: event => { event.preventDefault(); if (input.value.trim()) ctx.search(input.value); } },
    h('label', { class: 'sr-only', for: 'header-search' }, 'Search this workspace'), input,
    h('button', { type: 'submit', class: 'btn btn-quiet' }, 'Search'));
}

function createMenuCoordinator() {
  let closeCurrent = null;
  return {
    open(closeFn, container) {
      if (closeCurrent && closeCurrent !== closeFn) closeCurrent();
      closeCurrent = closeFn;
      const onPointerDown = event => {
        if (container.isConnected === false) { cleanup(); return; }
        if (!container.contains?.(event.target)) {
          cleanup();
          closeFn();
        }
      };
      const onKeyDown = event => {
        if (container.isConnected === false) { cleanup(); return; }
        if (event.key === 'Escape') {
          event.preventDefault();
          cleanup();
          closeFn(true);
        }
      };
      const cleanup = () => {
        if (closeCurrent === closeFn) closeCurrent = null;
        document.removeEventListener?.('pointerdown', onPointerDown);
        document.removeEventListener?.('keydown', onKeyDown);
      };
      document.addEventListener?.('pointerdown', onPointerDown);
      document.addEventListener?.('keydown', onKeyDown);
      return cleanup;
    }
  };
}

function workspaceSwitcher(ctx, current, { className = 'switcher', themed = false, menus = null } = {}) {
  const { state } = ctx;
  if (!state.account || !current) return null;
  const menuId = uid('workspace-menu');
  let menu;
  let toggle;
  let container;
  let cleanup = null;
  const setOpen = (open, restoreFocus = false) => {
    if (open) {
      menu.removeAttribute('hidden');
      toggle.setAttribute('aria-expanded', 'true');
      if (menus) cleanup = menus.open(focusToggle => setOpen(false, focusToggle), container);
    } else {
      cleanup?.();
      cleanup = null;
      menu.setAttribute('hidden', '');
      toggle.setAttribute('aria-expanded', 'false');
      if (restoreFocus) toggle.focus();
    }
  };
  menu = h('ul', { class: 'menu', id: menuId, hidden: true },
    ...state.workspaces.map(w => h('li', null, h('button', {
      type: 'button',
      'aria-pressed': String(w.id === state.workspaceId),
      onclick: () => { setOpen(false); toggle.focus(); ctx.switchWorkspace(w.id); }
    }, w.name, h('span', { class: 'muted' }, ` · ${ROLE_LABELS[w.role] || w.role}`)))),
    h('li', { class: 'menu-new' }, h('button', {
      type: 'button', 'data-action': 'new-workspace',
      // Focus goes back to the toggle first, so closing the dialog returns focus to a visible control.
      onclick: () => { setOpen(false); toggle.focus(); ctx.newWorkspace(); }
    }, 'New workspace')));
  toggle = themed
    ? h('button', {
      type: 'button', class: 'btn btn-quiet workspace-toggle', 'data-test': 'workspace-switcher',
      'aria-expanded': 'false', 'aria-controls': menuId,
      onclick: () => setOpen(menu.hasAttribute('hidden'))
    },
    h('span', { class: 'workspace-toggle-text' },
      h('span', { class: 'workspace-toggle-name' }, current.name),
      h('span', { class: 'workspace-toggle-role' }, ROLE_LABELS[current.role] || current.role)),
    h('span', { class: 'workspace-chevron', 'aria-hidden': 'true' }, '▾'))
    : h('button', {
      type: 'button', class: 'btn btn-quiet', 'aria-expanded': 'false', 'aria-controls': menuId,
      onclick: () => setOpen(menu.hasAttribute('hidden'))
    }, 'Switch workspace ▾');
  container = h('div', {
    class: className,
    onkeydown: event => {
      if (event.key === 'Escape' && !menu.hasAttribute('hidden')) {
        event.preventDefault();
        setOpen(false, true);
      }
    }
  }, toggle, menu);
  return container;
}

function layoutToggle(ctx, placement, { options = [['a', 'Side rail'], ['c', 'Top bar']], label = 'Quick layout switch', attr = 'data-quick-layout', source = 'header', onPick = null } = {}) {
  return h('div', { class: `theme-layout-toggle ${placement}`, role: 'group', 'aria-label': label },
    h('span', { class: 'theme-layout-caption' }, 'Layout'),
    h('div', { class: 'theme-layout-buttons' },
      ...options.map(([value, text]) => h('button', {
        type: 'button', [attr]: value, 'aria-pressed': String(ctx.state.layout === value),
        disabled: Boolean(ctx.state.layoutSaving),
        'aria-label': text,
        onclick: () => { onPick?.(); ctx.changeLayout(value, source); }
      }, text))));
}

function personBlock(state, current, extraClass = '') {
  const detail = state.account?.email_normalized || (current ? ROLE_LABELS[current.role] || current.role : null);
  return h('div', { class: extraClass ? `theme-person ${extraClass}` : 'theme-person' },
    h('span', { class: 'theme-person-name' }, state.account.display_name),
    detail ? h('span', { class: 'theme-person-role' }, detail) : null);
}

function accountMenu(ctx, current, { tab = false, menus = null } = {}) {
  const { state } = ctx;
  const menuId = uid('account-menu');
  let menu;
  let toggle;
  let container;
  let cleanup = null;
  const setOpen = (open, restoreFocus = false) => {
    if (open) {
      menu.removeAttribute('hidden');
      toggle.setAttribute('aria-expanded', 'true');
      if (menus) cleanup = menus.open(focusToggle => setOpen(false, focusToggle), container);
    } else {
      cleanup?.();
      cleanup = null;
      menu.setAttribute('hidden', '');
      toggle.setAttribute('aria-expanded', 'false');
      if (restoreFocus) toggle.focus();
    }
  };
  const person = personBlock(state, current, 'theme-mobile-person');
  const mobileLayout = layoutToggle(ctx, 'mobile', {
    options: [['a', 'Side rail'], ['c', 'Top bar'], ['original', 'Original']],
    label: 'Mobile layout switch',
    attr: 'data-mobile-layout',
    source: 'mobile-menu',
    onPick: () => setOpen(false, true)
  });
  const signout = h('button', {
    type: 'button', class: 'theme-signout theme-mobile-signout',
    onclick: () => { setOpen(false, true); ctx.signOut(); }
  }, 'Sign out');
  menu = h('div', { class: 'theme-mobile-menu', id: menuId, hidden: true }, person, mobileLayout, signout);
  toggle = h('button', {
    type: 'button',
    class: 'theme-more-toggle',
    'data-test': 'account-menu',
    'aria-expanded': 'false',
    'aria-controls': menuId,
    onclick: () => setOpen(menu.hasAttribute('hidden'))
  }, tab ? h('span', { class: 'theme-tab-label' }, 'Menu') : 'Menu');
  container = h('div', {
    class: 'theme-more',
    onkeydown: event => {
      if (event.key === 'Escape' && !menu.hasAttribute('hidden')) {
        event.preventDefault();
        setOpen(false, true);
      }
    }
  }, toggle, menu);
  return container;
}

function originalHeader(ctx, current) {
  const { state } = ctx;
  const brand = h('div', { class: 'brand' },
    h('img', { class: 'brand-mark', src: '/assets/icon.svg', alt: '', width: 38, height: 38 }),
    h('div', { class: 'brand-text' },
      h('span', { class: 'brand-name' }, 'Sermon Bank'),
      current ? h('span', { class: 'brand-workspace' }, current.name) : null));
  const signedIn = Boolean(state.account && current);
  return h('div', { class: 'header-inner' },
    brand,
    signedIn ? mainNav(ctx.route) : null,
    h('div', { class: 'header-right' },
      signedIn ? headerSearch(ctx) : null,
      workspaceSwitcher(ctx, current),
      state.account ? h('span', { class: 'who' }, state.account.display_name, current ? h('span', { class: 'pill' }, ROLE_LABELS[current.role] || current.role) : null) : null,
      state.account ? h('button', { type: 'button', class: 'btn btn-quiet', onclick: ctx.signOut }, 'Sign out') : null));
}

export function header(ctx) {
  const { state } = ctx;
  const current = state.workspaces.find(w => w.id === state.workspaceId);
  if (!['a', 'c'].includes(state.layout)) return originalHeader(ctx, current);

  const authenticated = Boolean(state.account) && state.phase !== 'signedout';
  const signedIn = Boolean(authenticated && current);
  const brand = h('a', { class: 'theme-brand', href: hrefFor({ name: 'library', view: 'covers' }), 'aria-label': 'Sermon Bank, Library' },
    h('img', { class: 'theme-book-mark', src: '/assets/icon.svg', alt: '', width: 32, height: 32 }),
    h('span', { class: 'theme-brand-name' }, 'Sermon Bank'));
  const menus = createMenuCoordinator();
  const switcher = signedIn ? workspaceSwitcher(ctx, current, { className: 'theme-switcher', themed: true, menus }) : null;
  const person = authenticated ? personBlock(state, current) : null;
  const signout = authenticated ? h('button', { type: 'button', class: 'theme-signout', onclick: ctx.signOut }, 'Sign out') : null;
  const quickLayout = authenticated ? layoutToggle(ctx, state.layout === 'a' ? 'rail' : 'topbar') : null;
  if (state.layout === 'a') {
    const mobileMenu = authenticated ? accountMenu(ctx, current, { tab: signedIn, menus }) : null;
    return h('aside', { class: authenticated ? 'theme-shell theme-rail has-mobile-menu' : 'theme-shell theme-rail', 'aria-label': 'Workspace navigation' },
      brand, switcher, signedIn ? mainNav(ctx.route, 'theme-nav', mobileMenu) : mobileMenu,
      authenticated ? h('div', { class: 'theme-rail-footer' }, quickLayout, person, signout) : null);
  }
  const mobileMenu = authenticated ? accountMenu(ctx, current, { menus }) : null;
  return h('div', { class: 'theme-shell theme-topbar' },
    brand, switcher, signedIn ? mainNav(ctx.route, 'theme-nav') : null,
    h('div', { class: 'theme-topbar-right' }, quickLayout, person, signout, mobileMenu));
}
