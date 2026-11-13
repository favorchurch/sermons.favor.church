// Global search page and the per-sermon "Find in notes" panel. Passage matches (from a sermon's
// own Scripture references) and note matches (from indexed text) are always shown apart.
import { h } from '../dom.js';
import { describeError } from '../api.js';
import { SCOPES, notesHref } from '../router.js';
import { highlightParts, shapeResults, noteReason, VERSION_STATUS } from '../search-model.js';
import { SOURCE_LABELS, plural } from '../format.js';
import { loadingLine } from './states.js';

/** Excerpt text with matches wrapped in <mark>. Text goes in as text nodes only. */
export function excerptNode(excerpt) {
  return h('p', { class: 'excerpt' }, ...highlightParts(excerpt?.text, excerpt?.highlights)
    .map(part => part.mark ? h('mark', null, part.text) : part.text));
}

const errorBox = (error, retry) => h('div', { class: 'inline-error', role: 'alert' },
  h('p', null, `Search could not run. ${describeError(error)}`),
  retry ? h('button', { type: 'button', class: 'btn', onclick: retry }, 'Try again') : null);

function metadataItem(hit, q) {
  return h('li', { class: 'result-item' },
    h('a', { class: 'result-title', href: notesHref(hit.sermon_id, q) }, hit.sermon_title),
    h('p', { class: 'result-meta' }, h('span', { class: 'pill pill-neutral' }, 'Sermon passage (metadata)'), ' ', h('span', { class: 'chip-ref chip' }, hit.passage)),
    h('p', { class: 'hint' }, 'Matches the Scripture the sermon is about. Its notes were not read for this result.'));
}

function noteItem(hit, q) {
  return h('li', { class: 'result-item' },
    h('a', { class: 'result-title', href: notesHref(hit.sermon_id, q) }, hit.sermon_title),
    h('p', { class: 'result-meta' },
      h('span', { class: 'pill pill-good' }, 'Found in notes'), ' ',
      h('strong', null, hit.version_label), ' ',
      h('span', { class: 'muted' }, `· ${SOURCE_LABELS[hit.source_type] || 'Source'} · ${plural(hit.match_count, 'match', 'matches')}`)),
    hit.excerpt ? excerptNode(hit.excerpt) : null);
}

/** ctx: { route, result: {phase, data?, error?}, search(route), retry() } */
export function searchPage(ctx) {
  const { route, result } = ctx;
  const input = h('input', { id: 'search-q', name: 'q', type: 'search', value: route.q, maxlength: 200, autocomplete: 'off', placeholder: 'A phrase or a reference like John 3:16' });
  const archived = h('input', { id: 'search-archived', type: 'checkbox', checked: route.archived });
  const go = scope => ctx.search({ q: input.value, scope, archived: Boolean(archived.checked) });
  const scopes = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Search in' },
    ...SCOPES.map(([key, label]) => h('button', {
      type: 'button', 'aria-pressed': String(route.scope === key), 'data-scope': key, onclick: () => go(key)
    }, label)));
  const form = h('form', { class: 'search-form', role: 'search', onsubmit: event => { event.preventDefault(); go(route.scope); } },
    h('div', { class: 'search-row' },
      h('div', { class: 'field' }, h('label', { for: 'search-q' }, 'Search the archive'), input),
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Search')),
    h('div', { class: 'search-options' }, scopes,
      h('label', { class: 'check', for: 'search-archived' }, archived, ' Include archived sermons')));

  let body;
  if (!route.q) {
    body = h('p', { class: 'muted' }, 'Search sermon titles’ Scripture passages and the text of indexed notes. Words are matched as a phrase, in order. Notes only appear once an Owner has allowed them to be searched.');
  } else if (!result || result.phase === 'loading') {
    body = loadingLine('Searching…');
  } else if (result.phase === 'failed') {
    body = errorBox(result.error, ctx.retry);
  } else {
    body = resultsView(result.data, route);
  }
  return h('section', { class: 'search-page', 'aria-labelledby': 'page-title' },
    h('h1', { id: 'page-title', tabindex: '-1' }, 'Search'),
    form,
    h('div', { class: 'search-results', id: 'search-results' }, body));
}

function group(title, id, items, empty) {
  return h('section', { class: 'result-group', 'aria-labelledby': id },
    h('h2', { id }, title, ' ', h('span', { class: 'count' }, `(${items.length})`)),
    items.length ? h('ul', { class: 'result-list' }, ...items) : h('p', { class: 'muted' }, empty));
}

function resultsView(data, route) {
  const shaped = shapeResults(data, route.scope);
  const label = data?.query?.kind === 'reference' ? `Bible reference ${data.query.label}` : `“${route.q}”`;
  if (shaped.needsReference) {
    return h('p', { class: 'notice', role: 'status' }, `“${route.q}” is not a Bible reference. Try a reference like John 3:16, or switch to Everything.`);
  }
  const total = shaped.metadata.length + shaped.notes.length;
  const sections = [];
  if (shaped.showMetadata) {
    sections.push(group('Sermon passage (metadata)', 'group-passages', shaped.metadata.map(hit => metadataItem(hit, route.q)),
      'No sermon is about this passage.'));
  }
  sections.push(group('Found in notes', 'group-notes', shaped.notes.map(hit => noteItem(hit, route.q)),
    'No indexed notes contain this.'));
  return h('div', null,
    h('p', { class: 'result-count', role: 'status' }, `${plural(total, 'result')} for ${label}`),
    ...sections);
}

/** The "Find in notes" tab of a sermon. ctx: { sermon, route, result, find(q), retry() } */
export function notesPanel(ctx) {
  const { sermon, route, result } = ctx;
  const input = h('input', { id: 'notes-q', name: 'q', type: 'search', value: route.q || '', maxlength: 200, autocomplete: 'off', placeholder: 'A phrase or a reference like John 3:16' });
  const form = h('form', { class: 'search-form', role: 'search', onsubmit: event => { event.preventDefault(); ctx.find(input.value); } },
    h('div', { class: 'search-row' },
      h('div', { class: 'field' },
        h('label', { for: 'notes-q' }, 'Find in this sermon’s notes'), input,
        h('p', { class: 'hint' }, 'Words are matched as a phrase, in order. A Bible reference also works.')),
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Find')));
  let body;
  if (!route.q) body = h('p', { class: 'muted' }, `Type something to see which versions of “${sermon.title}” contain it.`);
  else if (!result || result.phase === 'loading') body = loadingLine('Searching this sermon…');
  else if (result.phase === 'failed') body = errorBox(result.error, ctx.retry);
  else body = versionList(result.data);
  return h('section', { class: 'notes-panel', 'aria-labelledby': 'notes-title' },
    h('h2', { id: 'notes-title' }, 'Find in notes'), form, h('div', { class: 'notes-results', id: 'notes-results' }, body));
}

function versionList(data) {
  const versions = Array.isArray(data?.versions) ? data.versions : [];
  if (!versions.length) return h('p', { class: 'muted' }, 'This sermon has no versions yet, so there are no notes to search.');
  const matched = versions.filter(v => v.status === 'matched').length;
  return h('div', null,
    h('p', { class: 'result-count', role: 'status' }, `Found in ${plural(matched, 'version')} of ${versions.length}`),
    h('ul', { class: 'version-results' }, ...versions.map(version => {
      const [label, tone] = VERSION_STATUS[version.status] || ['Unknown', 'neutral'];
      return h('li', { class: 'version-result', 'data-status': version.status },
        h('div', { class: 'version-head' },
          h('strong', null, version.label),
          h('span', { class: `pill pill-${tone}` }, label)),
        h('p', { class: 'muted' }, SOURCE_LABELS[version.source_type] || 'Source',
          version.status === 'matched' ? ` · ${plural(version.match_count, 'match', 'matches')}` : ''),
        version.status === 'not_in_notes' ? h('p', null, 'This version is searchable, and the notes do not contain it.') : null,
        version.status === 'not_searchable' ? h('p', null, noteReason(version.reason)) : null,
        version.status === 'matched'
          ? h('ul', { class: 'excerpts' }, ...(version.excerpts || []).map(excerpt => h('li', null, excerptNode(excerpt))))
          : null);
    })));
}
