// Sermon detail: metadata, versions with indexing status, preaching events, and the write
// actions (edit, log preaching, archive/restore) which only editors, admins and owners see.
import { h } from '../dom.js';
import { hrefFor, sermonHref, notesHref } from '../router.js';
import { SOURCE_LABELS, formatStamp, formatWhen, indexingStatus, plural } from '../format.js';
import { canEdit } from '../permissions.js';
import { coverFor } from '../covers.js';

function versionCard(version) {
  const status = indexingStatus(version.indexing_state);
  const link = version.source_type === 'google_doc' && version.google_document_id
    ? `https://docs.google.com/document/d/${encodeURIComponent(version.google_document_id)}/edit`
    : version.source_type === 'external' && /^https:\/\//.test(version.source_url || '') ? version.source_url : null;
  return h('li', { class: 'version-card' },
    h('div', { class: 'version-head' },
      h('strong', null, version.label),
      h('span', { class: `pill pill-${status.tone}` }, status.label)),
    h('p', { class: 'muted' }, SOURCE_LABELS[version.source_type] || 'Source'),
    link ? h('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, 'Open original ', h('span', { class: 'sr-only' }, '(opens in a new tab)'), '↗') : null);
}

function eventRow(event, versionLabel) {
  const detail = [event.place_name, event.occasion, versionLabel && `Version: ${versionLabel}`].filter(Boolean);
  return h('li', { class: 'timeline-item' },
    h('div', { class: 'timeline-date' }, formatWhen(event.preached_on, event.date_precision),
      event.date_precision === 'needs_review' ? h('span', { class: 'pill pill-warn' }, 'Date needs review') : null),
    detail.length ? h('div', { class: 'timeline-detail' }, detail.join(' · ')) : null,
    event.raw_date ? h('div', { class: 'timeline-detail' }, `Recorded as “${event.raw_date}”`) : null);
}

function sermonTabs(sermon, tab, q) {
  return h('nav', { class: 'view-tabs sermon-tabs', 'aria-label': 'Sermon sections' },
    h('a', { href: sermonHref(sermon.id), 'aria-current': tab === 'notes' ? null : 'page' }, 'Details'),
    h('a', { href: notesHref(sermon.id, q || ''), 'aria-current': tab === 'notes' ? 'page' : null }, 'Find in notes'));
}

export function sermonPage(ctx) {
  const { sermon, role } = ctx;
  const editor = canEdit(role);
  const cover = coverFor(sermon);
  const labels = new Map((sermon.versions || []).map(version => [version.id, version.label]));
  const events = sermon.preaching_events || [];
  return h('article', { class: 'detail' },
    h('a', { class: 'back-link', href: hrefFor({ name: 'library', view: ctx.backView || 'covers' }) }, '← Library'),
    h('header', { class: `detail-head cover-${cover.palette}` },
      h('div', { class: 'detail-titles' },
        sermon.series_name ? h('p', { class: 'eyebrow' }, sermon.series_name) : h('p', { class: 'eyebrow' }, 'SERMON'),
        h('h1', { id: 'sermon-title', tabindex: '-1' }, sermon.title),
        sermon.archived_at ? h('p', null, h('span', { class: 'pill pill-warn' }, 'Archived')) : null,
        h('ul', { class: 'chips', 'aria-label': 'Scripture and tags' },
          ...(sermon.scripture_references || []).map(ref => h('li', { class: 'chip chip-ref' }, ref)),
          ...(sermon.tags || []).map(tag => h('li', { class: 'chip' }, tag)))),
      editor
        ? h('div', { class: 'detail-actions' },
          h('button', { type: 'button', class: 'btn', 'data-action': 'edit', onclick: ctx.edit }, 'Edit'),
          sermon.archived_at ? null : h('button', { type: 'button', class: 'btn', 'data-action': 'log', onclick: ctx.logPreaching }, 'Log preaching'),
          h('button', { type: 'button', class: 'btn', 'data-action': sermon.archived_at ? 'restore' : 'archive', onclick: sermon.archived_at ? ctx.restore : ctx.archive },
            sermon.archived_at ? 'Restore' : 'Archive'))
        : h('p', { class: 'view-only' }, 'View-only access')),
    sermonTabs(sermon, ctx.tab, ctx.q),
    ctx.tab === 'notes' ? ctx.notes : h('div', { class: 'detail-grid' },
      h('div', { class: 'detail-main' },
        h('section', { 'aria-labelledby': 'about-title' },
          h('h2', { id: 'about-title' }, 'About this sermon'),
          sermon.description ? h('p', { class: 'description' }, sermon.description) : h('p', { class: 'muted' }, 'No description yet.')),
        h('section', { 'aria-labelledby': 'history-title' },
          h('h2', { id: 'history-title' }, 'Preaching history ', h('span', { class: 'count' }, `(${events.length})`)),
          events.length
            ? h('ol', { class: 'timeline' }, ...[...events].reverse().map(event => eventRow(event, labels.get(event.version_id))))
            : h('p', { class: 'muted' }, 'Not preached yet.', editor && !sermon.archived_at ? ' Use “Log preaching” when it is.' : ''))),
      h('aside', { class: 'detail-side' },
        h('section', { 'aria-labelledby': 'versions-title' },
          h('h2', { id: 'versions-title' }, 'Versions'),
          (sermon.versions || []).length
            ? h('ul', { class: 'versions' }, ...sermon.versions.map(versionCard))
            : h('p', { class: 'muted' }, 'No versions attached yet.'),
          editor ? h('p', null, h('a', { href: hrefFor({ name: 'settings', section: 'docs', sermon: sermon.id }) }, 'Manage documents and privacy')) : null),
        h('section', { 'aria-labelledby': 'record-title' },
          h('h2', { id: 'record-title' }, 'Record'),
          h('dl', { class: 'facts' },
            h('dt', null, 'Added'), h('dd', null, formatStamp(sermon.created_at) || '—'),
            h('dt', null, 'Last edited'), h('dd', null, formatStamp(sermon.updated_at) || '—'),
            h('dt', null, 'Preached'), h('dd', null, plural(events.length, 'time')))))));
}
