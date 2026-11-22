// The four non-happy-path screens every view shares: loading, empty, error and access denied.
import { h } from '../dom.js';

// Not a live region (QA12): a status node inserted with its text is not reliably announced, so the app
// announces the label through the persistent #announcer when the loading screen first appears.
export function loadingState(label = 'Loading…') {
  return h('section', { class: 'state state-loading', 'aria-busy': 'true' },
    h('p', { class: 'sr-only' }, label),
    h('div', { class: 'skeleton-grid', 'aria-hidden': 'true' },
      ...Array.from({ length: 8 }, () => h('div', { class: 'skeleton-card' }))));
}

function stateBox(kind, { title, body, actions = [], role }) {
  return h('section', { class: `state state-${kind}`, role },
    h('div', { class: 'state-mark', 'aria-hidden': 'true' }, kind === 'empty' ? h('img', { src: '/assets/icon.svg', alt: '', width: 30, height: 30 }) : kind === 'denied' ? '◌' : '!'),
    h('h2', null, title),
    body ? h('p', null, body) : null,
    actions.length ? h('div', { class: 'state-actions' }, ...actions) : null);
}

export const emptyState = options => stateBox('empty', { ...options, role: 'status' });
export const errorState = options => stateBox('error', { ...options, role: 'alert' });
export const deniedState = options => stateBox('denied', { ...options, role: 'alert' });
