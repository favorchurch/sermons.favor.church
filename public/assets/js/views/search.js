// Global search page and the per-sermon "Find in notes" panel. The page runs two requests: a quick
// pass over sermon metadata ("Sermons") and a deep pass over indexed notes ("Found in notes"). Each
// group renders when its own request lands and fails on its own.
import { h } from '../dom.js';
import { describeError } from '../api.js';
import { SCOPES, notesHref } from '../router.js';
import { highlightParts, matchedOn, shapeSearch, noteReason, truncated, VERSION_STATUS } from '../search-model.js';
import { SOURCE_LABELS, plural } from '../format.js';

/** Excerpt text with matches wrapped in <mark>. Text goes in as text nodes only. */
export function excerptNode(excerpt) {
  return h('p', { class: 'excerpt' }, ...highlightParts(excerpt?.text, excerpt?.highlights)
    .map(part => part.mark ? h('mark', null, part.text) : part.text));
}

/** A one-line "in progress" message. It is spoken through the page's one live region, not a region of its own. */
function pendingLine(label, announce) {
  announce(label);
  return h('p', { class: 'muted', 'aria-busy': 'true' }, label);
}

const errorBox = (error, retry) => h('div', { class: 'inline-error', role: 'alert' },
  h('p', null, `Search could not run. ${describeError(error)}`),
  retry ? h('button', { type: 'button', class: 'btn', onclick: retry }, 'Try again') : null);

function sermonItem(hit, q) {
  const details = [hit.series_name ? `Series: ${hit.series_name}` : '', ...(hit.scripture_references || []), hit.archived ? 'Archived' : '']
    .filter(Boolean).join(' · ');
  return h('li', { class: 'result-item' },
    h('a', { class: 'result-title', href: notesHref(hit.sermon_id, q) }, hit.sermon_title),
    details ? h('p', { class: 'muted' }, details) : null,
    h('p', { class: 'muted' }, matchedOn(hit.matched_on),
      hit.passage ? ` (${hit.passage}). Its notes were not read for this result.` : ''));
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

/**
 * ctx: { route, quick, deep, search(route), retryQuick(), retryDeep() }. `quick` and `deep` are each
 * {phase, data?, error?}, or null when the scope did not ask for that stage.
 */
export function searchPage(ctx) {
  const { route } = ctx;
  const input = h('input', { id: 'search-q', name: 'q', type: 'search', value: route.q, maxlength: 200, autocomplete: 'off', placeholder: 'A phrase or a reference like John 3:16' });
  const archived = h('input', { id: 'search-archived', type: 'checkbox', checked: route.archived });
  const go = scope => ctx.search({ q: input.value, scope, archived: Boolean(archived.checked) });
  const scopes = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Search in' },
    ...SCOPES.map(([key, label]) => h('button', {
      type: 'button', 'aria-pressed': String(route.scope === key), 'data-scope': key, onclick: () => go(key)
    }, label)));
  const form = h('form', { class: 'search-form', role: 'search', onsubmit: event => { event.preventDefault(); go(route.scope); } },
    h('div', { class: 'search-row' },
      h('div', { class: 'field' }, h('label', { for: 'search-q' }, 'Search this workspace'), input),
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Search')),
    h('div', { class: 'search-options' }, scopes,
      h('label', { class: 'check', for: 'search-archived' }, archived, ' Include archived sermons')));

  const body = route.q
    ? resultsView(shapeSearch({ scope: route.scope, quick: ctx.quick, deep: ctx.deep, q: route.q }), route, ctx)
    : h('p', { class: 'muted' }, 'Searches sermon titles, series, Scripture, tags and the text of indexed notes. Titles, series, Scripture and tags match every word you type. Notes match the words as a phrase, in order. Notes only appear once an Owner has allowed them to be searched.');
  return h('section', { class: 'search-page', 'aria-labelledby': 'page-title' },
    h('h1', { id: 'page-title', tabindex: '-1' }, 'Search'),
    form,
    h('div', { class: 'search-results', id: 'search-results' }, body));
}

/** A result group: its own pending line, error with Try again, or its items. */
function group({ title, id, stage, items, pending, empty, retry, more }) {
  const state = !stage || stage.phase === 'loading' ? 'loading' : stage.phase;
  const head = h('h2', { id }, title, state === 'ready' ? [' ', h('span', { class: 'count' }, `(${items.length})`)] : null);
  let content;
  if (state === 'loading') content = h('p', { class: 'muted', 'aria-busy': 'true' }, pending);
  else if (state === 'failed') content = errorBox(stage.error, retry);
  else content = items.length ? h('ul', { class: 'result-list' }, ...items) : h('p', { class: 'muted' }, empty);
  return h('section', { class: 'result-group', 'aria-labelledby': id }, head, content, state === 'ready' ? more : null);
}

const moreLine = (stage, key) => truncated(stage, key)
  ? h('p', { class: 'muted' }, `Showing the first ${stage.data.limit}. Narrow your search to see the rest.`) : null;

function resultsView(shaped, route, ctx) {
  if (shaped.needsReference) return h('p', { class: 'notice' }, shaped.notice);
  const sections = [];
  if (shaped.showSermons) {
    sections.push(group({
      title: 'Sermons', id: 'group-sermons', stage: ctx.quick, items: shaped.sermons.map(hit => sermonItem(hit, route.q)),
      pending: 'Searching sermons…', empty: 'No sermon title, series, Scripture or tag matches this.',
      retry: ctx.retryQuick, more: moreLine(ctx.quick, 'sermonMatches')
    }));
  }
  sections.push(group({
    title: 'Found in notes', id: 'group-notes', stage: ctx.deep, items: shaped.notes.map(hit => noteItem(hit, route.q)),
    pending: 'Searching notes…', empty: 'No indexed notes contain this.',
    retry: ctx.retryDeep, more: moreLine(ctx.deep, 'notesMatches')
  }));
  return h('div', null, h('p', { class: 'result-count' }, shaped.summary), ...sections);
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
  else if (!result || result.phase === 'loading') body = pendingLine('Searching this sermon…', ctx.announce);
  else if (result.phase === 'failed') body = errorBox(result.error, ctx.retry);
  else body = versionList(result.data, ctx.announce);
  return h('section', { class: 'notes-panel', 'aria-labelledby': 'notes-title' },
    h('h2', { id: 'notes-title' }, 'Find in notes'), form, h('div', { class: 'notes-results', id: 'notes-results' }, body));
}

function versionList(data, announce) {
  const versions = Array.isArray(data?.versions) ? data.versions : [];
  if (!versions.length) return h('p', { class: 'muted' }, 'This sermon has no versions yet, so there are no notes to search.');
  const matched = versions.filter(v => v.status === 'matched').length;
  const summary = `Found in ${plural(matched, 'version')} of ${versions.length}`;
  announce(summary);
  return h('div', null,
    h('p', { class: 'result-count' }, summary),
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
