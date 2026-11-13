// A region that loads its own data: a status line while loading, an alert with Try again on
// failure, then the rendered content. `reload({quiet: true})` refreshes without the loading line.
import { h } from '../dom.js';
import { describeError } from '../api.js';

export function panel({ label, load, render }) {
  const node = h('div', { class: 'panel-body' });
  let generation = 0;
  async function reload({ quiet = false } = {}) {
    const mine = ++generation;
    if (!quiet) node.replaceChildren(h('p', { class: 'muted', role: 'status' }, `Loading ${label}…`));
    try {
      const data = await load();
      if (mine === generation) node.replaceChildren(render(data, reload));
    } catch (error) {
      if (mine !== generation) return;
      node.replaceChildren(h('div', { class: 'inline-error', role: 'alert' },
        h('p', null, `${label[0].toUpperCase()}${label.slice(1)} could not be loaded. ${describeError(error)}`),
        h('button', { type: 'button', class: 'btn', onclick: () => reload() }, 'Try again')));
    }
  }
  reload();
  return { node, reload };
}

/** Inline, non-modal failure text for a button action that has no dialog. */
export function notice(message, tone = 'error') {
  return h('p', { class: tone === 'error' ? 'form-error' : 'hint', role: tone === 'error' ? 'alert' : 'status' }, message);
}

/** A titled settings section with an optional lead paragraph. */
export function sectionBox(id, title, lead, ...children) {
  return h('section', { class: 'settings-section', 'aria-labelledby': id },
    h('h2', { id }, title),
    lead ? h('p', { class: 'muted lead' }, lead) : null,
    ...children);
}
