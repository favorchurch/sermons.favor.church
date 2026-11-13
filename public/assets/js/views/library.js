// Library page: hero, toolbar and the Covers / Quick rows / Table views.
import { h } from '../dom.js';
import { VIEWS, VIEW_LABELS, hrefFor, sermonHref } from '../router.js';
import { SORTS, filterAndSort, libraryTotals } from '../library-model.js';
import { coverFor } from '../covers.js';
import { formatWhenShort, formatDay, plural } from '../format.js';
import { canEdit } from '../permissions.js';
import { coverArt, shelf } from './covers.js';
import { emptyState } from './states.js';

const lastPreachedText = item => item.last ? `Last preached ${formatWhenShort(item.last.date, item.last.precision)}` : 'Not yet preached';

function statusChip(item) {
  return item.archived_at ? h('span', { class: 'pill pill-warn' }, 'Archived') : null;
}

function card(item, order) {
  return h('article', { class: 'sermon-card', style: { '--order': Math.min(order, 24) } },
    coverArt(item),
    h('div', { class: 'card-body' },
      h('h3', null, h('a', { class: 'card-link', href: sermonHref(item.id) }, item.title)),
      item.scripture_references?.length ? h('p', { class: 'card-scripture' }, item.scripture_references.join(' · ')) : null,
      h('p', { class: 'card-meta' }, lastPreachedText(item), item.preachCount ? ` · ${item.preachCount}×` : ''),
      statusChip(item)));
}

function quickRow(item) {
  const cover = coverFor(item);
  return h('li', null,
    h('a', { class: 'quick-row', href: sermonHref(item.id) },
      h('span', { class: `row-dot cover-${cover.palette}`, 'aria-hidden': 'true' }),
      h('span', { class: 'row-main' },
        h('strong', null, item.title),
        h('span', { class: 'row-sub' }, [item.scripture_references?.join(' · '), item.series_name].filter(Boolean).join(' · ') || 'No Scripture or series')),
      h('span', { class: 'row-last' }, item.last ? formatWhenShort(item.last.date, item.last.precision) : 'Not yet preached'),
      h('span', { class: 'row-count' }, plural(item.preachCount, 'time')),
      statusChip(item)));
}

function table(items) {
  const head = ['Title', 'Series', 'Scripture', 'Tags', 'Last preached', 'Times', 'Added'];
  return h('div', { class: 'table-wrap' },
    h('table', { class: 'sermon-table' },
      h('caption', { class: 'sr-only' }, 'Sermons'),
      h('thead', null, h('tr', null, ...head.map(label => h('th', { scope: 'col' }, label)))),
      h('tbody', null, ...items.map(item => h('tr', null,
        h('th', { scope: 'row', 'data-label': 'Title' }, h('a', { href: sermonHref(item.id) }, item.title), item.archived_at ? h('span', { class: 'pill pill-warn' }, 'Archived') : null),
        h('td', { 'data-label': 'Series' }, item.series_name || '—'),
        h('td', { 'data-label': 'Scripture' }, item.scripture_references?.join(', ') || '—'),
        h('td', { 'data-label': 'Tags' }, item.tags?.join(', ') || '—'),
        h('td', { 'data-label': 'Last preached' }, item.last ? formatWhenShort(item.last.date, item.last.precision) : 'Not yet'),
        h('td', { 'data-label': 'Times' }, String(item.preachCount)),
        h('td', { 'data-label': 'Added' }, item.created_at ? formatDay(item.created_at.slice(0, 10)) : '—'))))));
}

/**
 * Build the library page. The toolbar is built once and only the results area is rebuilt while
 * typing, so the search box keeps focus. `ctx` supplies state and actions from app.js.
 */
export function libraryPage(ctx) {
  const { state, view } = ctx;
  const totals = libraryTotals(state.items);
  const editor = canEdit(state.role);

  const results = h('div', { class: 'results', id: 'results' });
  const count = h('p', { class: 'result-count', id: 'result-count' });
  const search = h('input', {
    id: 'sermon-search', type: 'search', placeholder: 'Title, series, Scripture or tag', value: state.query, autocomplete: 'off',
    'aria-controls': 'results',
    oninput: event => { state.query = event.target.value; refresh(); }
  });
  const archiveButtons = ['active', 'archived'].map(key => h('button', {
    type: 'button', 'aria-pressed': String(state.archive === key),
    onclick: () => { state.archive = key; refresh(); }
  }, key === 'active' ? 'Active' : 'Archived'));
  const sortSelect = h('select', { id: 'sermon-sort', onchange: event => { state.sort = event.target.value; refresh(); } },
    ...SORTS.map(([value, label]) => h('option', { value, selected: state.sort === value }, label)));

  function refresh() {
    const shown = filterAndSort(state.items, state);
    archiveButtons.forEach((button, i) => button.setAttribute('aria-pressed', String(state.archive === ['active', 'archived'][i])));
    count.textContent = plural(shown.length, 'sermon') + (state.query ? ` matching “${state.query}”` : '');
    ctx.announce(count.textContent);
    if (!shown.length) {
      results.replaceChildren(state.items.length === 0
        ? emptyState({
          title: 'Your library is ready for its first sermon',
          body: editor ? 'Start with a title. Add Scripture, versions and where it was preached whenever you are ready.' : 'Nothing has been added to this archive yet. Editors and owners can add sermons.',
          actions: editor ? [h('button', { type: 'button', class: 'btn btn-primary', onclick: ctx.newDraft }, 'New draft')] : []
        })
        : emptyState({
          title: state.query ? 'No sermons match your search' : state.archive === 'archived' ? 'No archived sermons' : 'No active sermons',
          body: state.query ? 'Try a different word, or clear the search.' : state.archive === 'archived' ? 'Archived sermons keep their history and can be restored.' : 'Everything here has been archived. Switch to Archived to restore one.',
          actions: state.query ? [h('button', { type: 'button', class: 'btn', onclick: () => { state.query = ''; search.value = ''; refresh(); } }, 'Clear search')] : []
        }));
      return;
    }
    if (view === 'rows') results.replaceChildren(h('ul', { class: 'quick-rows' }, ...shown.map(quickRow)));
    else if (view === 'table') results.replaceChildren(table(shown));
    else results.replaceChildren(h('div', { class: 'cards-grid' }, ...shown.map(card)));
  }

  const page = h('div', { class: 'library' },
    h('section', { class: 'hero' },
      h('div', { class: 'hero-copy' },
        h('p', { class: 'eyebrow' }, 'THE LIVING LIBRARY'),
        h('h1', null, 'Every message, ', h('em', null, 'kept and found.')),
        h('p', { class: 'hero-lede' },
          `${plural(totals.sermons, 'sermon')} · ${plural(totals.preachings, 'preaching')}`,
          totals.latest ? ` · last preached ${formatWhenShort(totals.latest.date, totals.latest.precision)}` : ''),
        h('div', { class: 'hero-actions' },
          editor ? h('button', { type: 'button', class: 'btn btn-primary', onclick: ctx.newDraft }, 'New draft') : null,
          h('a', { class: 'btn', href: hrefFor({ name: 'library', view: 'calendar' }) }, 'Open the calendar'),
          !editor ? h('span', { class: 'hint' }, 'You have view-only access.') : null)),
      shelf(filterAndSort(state.items, { archive: 'active', sort: 'recent' }))),
    h('div', { class: 'toolbar' },
      libraryTabs(view),
      h('div', { class: 'toolbar-controls' },
        h('div', { class: 'search' }, h('label', { for: 'sermon-search' }, 'Search sermons'), search),
        h('div', { class: 'segmented', role: 'group', 'aria-label': 'Show' }, ...archiveButtons),
        h('div', { class: 'sort' }, h('label', { for: 'sermon-sort' }, 'Sort by'), sortSelect))),
    count,
    results);
  refresh();
  return page;
}

export function libraryTabs(active) {
  return h('nav', { class: 'view-tabs', 'aria-label': 'Library views' },
    ...VIEWS.map(view => h('a', { href: hrefFor({ name: 'library', view }), 'aria-current': view === active ? 'page' : null }, VIEW_LABELS[view])));
}
