// Docs & Privacy: per-sermon versions, PDF upload, Owner consent to index, and revoke.
// Extracted PDF text stays private until an Owner consents, and revoke deletes it for good.
import { h, field, uid, mount } from '../dom.js';
import { describeError } from '../api.js';
import { hrefFor } from '../router.js';
import { SOURCE_LABELS, indexingStatus } from '../format.js';
import { canEdit, isOwner } from '../permissions.js';
import { confirmDialog } from './dialogs.js';
import { panel, notice, sectionBox } from './panel.js';

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const HAS_FILE = ['awaiting_consent', 'queued', 'indexed', 'failed'];
const REVOCABLE = ['awaiting_consent', 'queued', 'indexed', 'failed'];

const STATE_NOTES = {
  not_indexed: 'Not searchable.',
  awaiting_consent: 'The text was read from the PDF and is held privately. It is not searchable until an Owner consents.',
  queued: 'Consent was given and indexing is in progress.',
  indexed: 'Searchable by everyone in this archive.',
  failed: 'The file is stored, but its text could not be read or indexed, so it cannot be searched.',
  revoked: 'Access was revoked. The text has been removed from search and cannot be indexed again.'
};
const FAILURE_TEXT = {
  unreadable: 'That PDF could not be read.',
  no_text: 'That PDF has no text to read. A scan or an image-only file cannot be searched.',
  text_too_large: 'That PDF has too much text to index.',
  storage: 'The text could not be stored. Try a new version.'
};

/** Local checks for a quick, friendly message. The server remains the authority on type and size. */
export function pdfProblem(file) {
  if (!file) return 'Choose a PDF file first.';
  const named = /\.pdf$/i.test(file.name || '');
  if (file.type ? file.type !== 'application/pdf' : !named) return 'That file is not a PDF.';
  if (file.size > MAX_PDF_BYTES) return 'That PDF is over 10 MB.';
  if (file.size === 0) return 'That file is empty.';
  return null;
}

function uploadResultText(result) {
  if (result?.indexing_state === 'failed') return `Stored, but not searchable. ${FAILURE_TEXT[result.reason] || 'Its text could not be read.'}`;
  return 'PDF uploaded. Its text is held privately until an Owner consents.';
}

/** File picker + button. `send(file)` performs the upload and returns the API result. */
function uploader({ label, buttonLabel, send, onDone, toast }) {
  const input = h('input', { type: 'file', accept: 'application/pdf,.pdf', 'aria-label': label });
  const message = h('div', { class: 'upload-message' });
  const button = h('button', { type: 'button', class: 'btn', 'data-action': 'upload' }, buttonLabel);
  button.addEventListener('click', async () => {
    const file = input.files?.[0];
    const problem = pdfProblem(file);
    mount(message, problem && notice(problem));
    if (problem) return;
    button.setAttribute('disabled', '');
    try {
      const result = await send(file);
      toast(uploadResultText(result));
      await onDone();
    } catch (error) {
      mount(message, notice(describeError(error)));
    } finally { button.removeAttribute('disabled'); }
  });
  return h('div', { class: 'uploader' }, input, button, message);
}

function consentDialog({ client, sermon, version, onDone }) {
  return confirmDialog({
    title: 'Let this PDF be searched?',
    body: [
      `Everyone in this archive will be able to find text from “${version.label}” in search. Only you, as an Owner, can allow this.`,
      'You can revoke it later. Revoking deletes the extracted text and cannot be undone.'
    ],
    confirmLabel: 'Allow search', onDone, save: () => client.consentToIndex(sermon.id, version.id)
  });
}

function revokeDialog({ client, sermon, version, onDone }) {
  return confirmDialog({
    title: 'Revoke access and delete the text?',
    body: [
      `Search and download of “${version.label}” stop immediately, and its extracted text is deleted.`,
      'This is final: this version can never be searched again. To use the file again, add it as a new version.'
    ],
    confirmLabel: 'Revoke and delete text', danger: true, onDone, save: () => client.revokeIndexing(sermon.id, version.id)
  });
}

function versionCard(version, ctx, sermon, reload) {
  const { client, state } = ctx;
  const status = indexingStatus(version.indexing_state);
  const isPdf = version.source_type === 'pdf';
  const refresh = message => async () => { ctx.toast(message); await reload({ quiet: true }); };
  const owner = isOwner(state.role);
  return h('li', { class: 'version-card', 'data-state': version.indexing_state },
    h('div', { class: 'version-head' },
      h('strong', null, version.label),
      h('span', { class: `pill pill-${status.tone}` }, status.label)),
    h('p', { class: 'muted' }, SOURCE_LABELS[version.source_type] || 'Source'),
    h('p', null, STATE_NOTES[version.indexing_state] || ''),
    h('div', { class: 'row-actions' },
      isPdf && HAS_FILE.includes(version.indexing_state)
        ? h('a', { class: 'btn', href: client.pdfHref(sermon.id, version.id), download: '', 'data-action': 'download' }, 'Download PDF') : null,
      version.indexing_state === 'awaiting_consent' && owner
        ? h('button', { type: 'button', class: 'btn btn-primary', 'data-action': 'consent', onclick: () => consentDialog({ client, sermon, version, onDone: refresh('Search allowed for this version.') }) }, 'Allow search…') : null,
      REVOCABLE.includes(version.indexing_state) && owner
        ? h('button', { type: 'button', class: 'btn', 'data-action': 'revoke', onclick: () => revokeDialog({ client, sermon, version, onDone: refresh('Access revoked and text deleted.') }) }, 'Revoke…') : null),
    version.indexing_state === 'awaiting_consent' && !owner ? h('p', { class: 'hint' }, 'Waiting for an Owner to decide.') : null,
    isPdf && version.indexing_state === 'not_indexed' && canEdit(state.role)
      ? uploader({ label: `PDF file for ${version.label}`, buttonLabel: 'Upload PDF', toast: ctx.toast, onDone: () => reload({ quiet: true }),
        send: file => client.uploadPdf(sermon.id, version.id, file) }) : null);
}

function addPdfForm(ctx, sermon, reload) {
  const label = field({ label: 'Version name', name: 'label', maxlength: 120, value: 'Printed notes', hint: 'For example Printed notes or Final script.' });
  const fileId = uid('new-pdf');
  const input = h('input', { id: fileId, type: 'file', accept: 'application/pdf,.pdf' });
  const message = h('div', { class: 'upload-message' });
  const button = h('button', { type: 'button', class: 'btn btn-primary', 'data-action': 'add-pdf' }, 'Add PDF version');
  button.addEventListener('click', async () => {
    const file = input.files?.[0];
    const problem = pdfProblem(file);
    mount(message, problem && notice(problem));
    if (problem) return;
    button.setAttribute('disabled', '');
    let created = null;
    try {
      created = await ctx.client.createVersion(sermon.id, { label: label.control.value, source_type: 'pdf' });
      const result = await ctx.client.uploadPdf(sermon.id, created.id, file);
      ctx.toast(uploadResultText(result));
      await ctx.refreshLibrary();
      await reload({ quiet: true });
    } catch (error) {
      mount(message, notice(created
        ? `The version was created, but the file did not upload. ${describeError(error)} Use Upload PDF on it to try again.`
        : describeError(error)));
      if (created) await reload({ quiet: true });
    } finally { button.removeAttribute('disabled'); }
  });
  return h('div', { class: 'add-pdf' }, h('h3', null, 'Add a PDF version'), label.wrapper,
    h('div', { class: 'field' }, h('label', { for: fileId }, 'PDF file (up to 10 MB)'), input), button, message);
}

export function docsSection(ctx) {
  const { state, route } = ctx;
  const sermons = [...state.items].sort((a, b) => a.title.localeCompare(b.title));
  const lead = 'PDFs and the text read from them stay private. Text is only searchable after an Owner consents, and revoking deletes it.';
  if (!sermons.length) return sectionBox('docs-title', 'Docs & Privacy', lead, h('p', { class: 'muted' }, 'Add a sermon first. Documents belong to a sermon’s versions.'));
  const chosen = sermons.find(item => item.id === route.sermon) || null;
  const select = h('select', {
    id: 'docs-sermon',
    onchange: event => ctx.setHash(hrefFor({ name: 'settings', section: 'docs', sermon: event.target.value || null }))
  }, h('option', { value: '' }, 'Choose a sermon…'),
  ...sermons.map(item => h('option', { value: item.id, selected: chosen?.id === item.id }, item.archived_at ? `${item.title} (archived)` : item.title)));
  const picker = h('div', { class: 'field' }, h('label', { for: 'docs-sermon' }, 'Sermon'), select);
  if (!chosen) return sectionBox('docs-title', 'Docs & Privacy', lead, picker, h('p', { class: 'muted' }, 'Choose a sermon to see its versions.'));
  const { node } = panel({
    label: 'versions',
    load: () => ctx.client.getSermon(chosen.id),
    render: (sermon, reload) => h('div', null,
      (sermon.versions || []).length
        ? h('ul', { class: 'versions' }, ...sermon.versions.map(version => versionCard(version, ctx, sermon, reload)))
        : h('p', { class: 'muted' }, 'This sermon has no versions yet.'),
      canEdit(state.role) ? addPdfForm(ctx, sermon, reload) : h('p', { class: 'hint' }, 'You have view-only access, so you can see these documents but not change them.'))
  });
  return sectionBox('docs-title', 'Docs & Privacy', lead, picker, node);
}
