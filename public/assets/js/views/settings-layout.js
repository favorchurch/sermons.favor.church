import { h } from '../dom.js';
import { describeError } from '../api.js';
import { LAYOUTS, LAYOUT_LABELS } from '../layout.js';
import { hrefFor } from '../router.js';

const DESCRIPTIONS = {
  a: 'Navigation on the side',
  c: 'Navigation across the top',
  original: 'The original Sermon Bank header'
};

export function layoutSection({ state, changeLayout }) {
  return h('section', { class: 'settings-section theme-layout-settings' },
    h('h2', null, 'Layout'),
    h('p', { class: 'lead' }, 'Choose how workspace navigation is arranged. Your choice follows you across devices.'),
    h('div', { class: 'layout-options switch-list', role: 'group', 'aria-label': 'Layout' },
      ...LAYOUTS.map(value => h('button', {
        type: 'button',
        class: state.layout === value ? 'btn btn-primary place-main layout-option' : 'btn place-main layout-option',
        'data-layout-option': value,
        'aria-pressed': String(state.layout === value),
        disabled: Boolean(state.layoutSaving),
        onclick: () => changeLayout(value, 'settings')
      },
      h('span', { class: 'layout-option-title' }, LAYOUT_LABELS[value]),
      h('span', { class: 'layout-option-description' }, DESCRIPTIONS[value])))),
    state.layoutSaving ? h('p', { class: 'layout-saving', role: 'status' }, 'Saving layout…') : null,
    state.layoutError ? h('p', { class: 'form-error', role: 'alert' }, describeError(state.layoutError)) : null,
    state.phase === 'no-workspace' ? h('a', { href: hrefFor({ name: 'library', view: 'covers' }) }, 'Back to workspace setup') : null);
}
