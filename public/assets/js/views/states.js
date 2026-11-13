// The four non-happy-path screens every view shares: loading, empty, error and access denied.
import { h } from '../dom.js';

export function loadingState(label = 'Loading…') {
  return h('section', { class: 'state state-loading', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' },
    h('p', { class: 'sr-only' }, label),
    h('div', { class: 'skeleton-grid', 'aria-hidden': 'true' },
      ...Array.from({ length: 8 }, () => h('div', { class: 'skeleton-card' }))));
}

function stateBox(kind, { title, body, actions = [], role }) {
  return h('section', { class: `state state-${kind}`, role },
    h('div', { class: 'state-mark', 'aria-hidden': 'true' }, kind === 'empty' ? '✳' : kind === 'denied' ? '◌' : '!'),
    h('h2', null, title),
    body ? h('p', null, body) : null,
    actions.length ? h('div', { class: 'state-actions' }, ...actions) : null);
}

export const emptyState = options => stateBox('empty', { ...options, role: 'status' });
export const errorState = options => stateBox('error', { ...options, role: 'alert' });
export const deniedState = options => stateBox('denied', { ...options, role: 'alert' });

/** A one-line polite status for a region that is loading, without replacing the whole page. */
export const loadingLine = label => h('p', { class: 'muted', role: 'status', 'aria-busy': 'true' }, label);
