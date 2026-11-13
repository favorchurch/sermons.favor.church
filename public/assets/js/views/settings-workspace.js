// Workspace: which archive this is, what the person's role allows, and switching archives.
import { h } from '../dom.js';
import { ROLE_ABILITIES, ROLE_LABELS, ROLE_ORDER } from '../permissions.js';
import { libraryTotals } from '../library-model.js';
import { plural } from '../format.js';
import { sectionBox } from './panel.js';
import { joinForm } from './join.js';

export function workspaceSection(ctx) {
  const { state } = ctx;
  const current = state.workspaces.find(w => w.id === state.workspaceId);
  const totals = libraryTotals(state.items);
  const others = state.workspaces.filter(w => w.id !== state.workspaceId);
  return sectionBox('workspace-title', 'Workspace', 'This archive and what your role can do in it.',
    h('dl', { class: 'facts' },
      h('dt', null, 'Archive'), h('dd', null, current?.name || '—'),
      h('dt', null, 'Your role'), h('dd', null, ROLE_LABELS[state.role] || '—'),
      h('dt', null, 'Signed in as'), h('dd', null, state.account?.display_name || '—'),
      h('dt', null, 'Contents'), h('dd', null, `${plural(totals.sermons, 'sermon')} · ${plural(totals.preachings, 'preaching')}`)),
    h('div', { class: 'table-wrap' }, h('table', { class: 'sermon-table abilities' },
      h('caption', null, 'What each role can do'),
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Ability'), ...ROLE_ORDER.map(role => h('th', { scope: 'col' }, ROLE_LABELS[role])))),
      h('tbody', null, ...ROLE_ABILITIES.map(([label, roles]) => h('tr', null,
        h('th', { scope: 'row', 'data-label': 'Ability' }, label),
        ...ROLE_ORDER.map(role => h('td', { 'data-label': ROLE_LABELS[role] }, roles.includes(role) ? 'Yes' : '—'))))))),
    others.length ? h('div', { class: 'switch-list' },
      h('h3', null, 'Other archives'),
      h('div', { class: 'row-actions' }, ...others.map(w => h('button', { type: 'button', class: 'btn', onclick: () => ctx.switchWorkspace(w.id) }, `Open ${w.name}`)))) : null,
    h('div', { class: 'join-box' }, h('h3', null, 'Join another archive'),
      h('p', { class: 'muted' }, 'Have an invitation code? Enter it here to add that archive to your list.'), joinForm({ join: ctx.join })));
}
