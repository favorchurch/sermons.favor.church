// Settings shell: a section nav (only the sections a role can use) and the active section.
// Hiding a section is presentation only; every call behind it is still checked by the server.
import { h } from '../dom.js';
import { SETTINGS_SECTIONS, hrefFor } from '../router.js';
import { canSeeSection } from '../permissions.js';
import { placesSection } from './settings-places.js';
import { peopleSection } from './settings-people.js';
import { importSection } from './settings-import.js';
import { docsSection } from './settings-docs.js';
import { workspaceSection } from './settings-workspace.js';
import { layoutSection } from './settings-layout.js';

const SECTIONS = { places: placesSection, people: peopleSection, import: importSection, docs: docsSection, workspace: workspaceSection, layout: layoutSection };

/** ctx: { route, state, client, toast, setHash, refreshLibrary } */
export function settingsPage(ctx) {
  const { route, state } = ctx;
  const visible = SETTINGS_SECTIONS.filter(([key]) => key !== 'layout' && canSeeSection(state.role, key));
  const label = (SETTINGS_SECTIONS.find(([key]) => key === route.section) || [])[1];
  const allowed = route.section === 'layout' || canSeeSection(state.role, route.section);
  const body = allowed
    ? SECTIONS[route.section](ctx)
    : h('div', { class: 'notice', role: 'status' },
      h('h2', null, `${label} is not available to your role`),
      h('p', null, 'Ask an Owner if you need access to this part of the workspace.'),
      h('p', null, h('a', { href: hrefFor({ name: 'settings', section: 'places' }) }, 'Back to Places')));
  return h('div', { class: 'settings' },
    h('h1', { id: 'page-title', tabindex: '-1' }, 'Settings'),
    h('div', { class: 'settings-layout' },
      h('div', { class: 'settings-nav settings-index' },
        h('nav', { class: 'settings-nav', 'aria-label': 'Settings sections' },
          ...visible.map(([key, text]) => h('a', { href: hrefFor({ name: 'settings', section: key }), 'aria-current': key === route.section ? 'page' : null }, text))),
        h('a', { class: 'settings-layout-link', href: hrefFor({ name: 'settings', section: 'layout' }), 'aria-current': route.section === 'layout' ? 'page' : null }, 'Layout')),
      h('div', { class: 'settings-body' }, body)));
}
