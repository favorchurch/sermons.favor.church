// The four non-happy-path screens every view shares: loading, empty, error and access denied.
import { h } from '../dom.js';
import { emptyBooksArt, isThemed } from './covers.js';

// Not a live region (QA12): a status node inserted with its text is not reliably announced, so the app
// announces the label through the persistent #announcer when the loading screen first appears.
export function loadingState(label = 'Loading…') {
  if (isThemed()) {
    return h('section', { class: 'state state-loading skeleton-list edge-list-mobile', 'aria-busy': 'true' },
      h('p', { class: 'sr-only' }, label),
      ...Array.from({ length: 6 }, () => h('div', { class: 'skeleton-row', 'aria-hidden': 'true' },
        h('div', { class: 'skel-stack' },
          h('div', { class: 'skel-bar skel-title' }),
          h('div', { class: 'skel-bar skel-sub' })),
        h('div', { class: 'skel-bar skel-meta' }),
        h('div', { class: 'skel-bar skel-meta' }))));
  }
  return h('section', { class: 'state state-loading', 'aria-busy': 'true' },
    h('p', { class: 'sr-only' }, label),
    h('div', { class: 'skeleton-grid', 'aria-hidden': 'true' },
      ...Array.from({ length: 8 }, () => h('div', { class: 'skeleton-card' }))));
}

function stateBox(kind, { title, body, actions = [], role }) {
  if (isThemed()) {
    const isError = kind === 'error';
    return h('section', { class: `state state-${kind} state-panel${isError ? ' state-panel-error' : ''}`, role },
      !isError ? emptyBooksArt() : null,
      h('h2', { class: 'section-heading' }, title),
      body ? h('p', { class: isError ? 'body-copy' : 'body-copy muted' }, body) : null,
      actions.length ? h('div', { class: 'state-actions' }, ...actions) : null);
  }
  return h('section', { class: `state state-${kind}`, role },
    h('div', { class: 'state-mark', 'aria-hidden': 'true' }, kind === 'empty' ? h('img', { src: '/assets/icon.svg', alt: '', width: 30, height: 30 }) : kind === 'denied' ? '◌' : '!'),
    h('h2', null, title),
    body ? h('p', null, body) : null,
    actions.length ? h('div', { class: 'state-actions' }, ...actions) : null);
}

export const emptyState = options => stateBox('empty', { ...options, role: 'status' });
export const errorState = options => stateBox('error', { ...options, role: 'alert' });
export const deniedState = options => stateBox('denied', { ...options, role: 'alert' });
