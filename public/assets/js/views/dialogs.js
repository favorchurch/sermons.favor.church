// Dialogs for every write: new draft, edit, log a preaching, archive/restore confirmation.
// Each shows server errors inline (plain language only) and disables its button while saving.
import { h, field, openDialog } from '../dom.js';
import { describeError, ApiError } from '../api.js';
import { PRECISION_OPTIONS, plural } from '../format.js';

/** Thrown by a save() that has already shown its own inline message. */
export class Handled extends Error {}

export function setHidden(el, hidden) {
  if (hidden) el.setAttribute('hidden', ''); else el.removeAttribute('hidden');
}

export function actions(dialogApi, submitLabel, { danger = false, cancelFirst = false } = {}) {
  const submit = h('button', { type: 'submit', class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary') }, submitLabel);
  // For destructive confirmations the safe choice gets focus, so Enter cannot archive by accident.
  const cancel = h('button', { type: 'button', class: 'btn', 'data-autofocus': cancelFirst, onclick: () => dialogApi.close() }, 'Cancel');
  return { submit, cancel, node: h('div', { class: 'dialog-actions' }, cancel, submit) };
}

/** Wire a form: run `save`, map failures to inline messages, close on success. */
export function wireForm({ form, submit, formError, fields, save, dialog, onDone }) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    formError.textContent = '';
    formError.setAttribute('hidden', '');
    Object.values(fields).forEach(f => f.setError(''));
    submit.setAttribute('disabled', '');
    form.setAttribute('aria-busy', 'true');
    try {
      await save();
      dialog.close();
      await onDone?.();
    } catch (error) {
      submit.removeAttribute('disabled');
      form.removeAttribute('aria-busy');
      if (error instanceof Handled) return;
      const named = error instanceof ApiError && error.field && fields[error.field];
      if (named) { named.setError(describeError(error)); named.control.focus(); }
      else { formError.textContent = describeError(error); formError.removeAttribute('hidden'); formError.focus?.(); }
      if (error instanceof ApiError && error.status === 401) formError.append(' ', h('a', { href: '/' }, 'Sign in'));
    }
  });
}

export const formErrorBox = () => h('p', { class: 'form-error', role: 'alert', tabindex: '-1', hidden: true });

export function newDraftDialog({ client, onCreated }) {
  const title = field({ label: 'Title', name: 'title', required: true, maxlength: 200, autofocus: true, hint: 'Just a title is enough. You can add the rest later.' });
  const formError = formErrorBox();
  let created = null;
  const dialogApi = { close: () => {} };
  const { submit, node } = actions(dialogApi, 'Create draft');
  const form = h('form', { novalidate: true }, title.wrapper, formError, node);
  const opened = openDialog({ title: 'New sermon draft', body: form });
  dialogApi.close = opened.close;
  wireForm({
    form, submit, formError, fields: { title }, dialog: opened,
    save: async () => { created = await client.createSermon(title.control.value); },
    onDone: () => onCreated(created)
  });
  return opened;
}

const splitLines = text => text.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
const splitTags = text => text.split(',').map(item => item.trim()).filter(Boolean);

export function editSermonDialog({ client, sermon, onSaved }) {
  const fields = {
    title: field({ label: 'Title', name: 'title', value: sermon.title, required: true, maxlength: 200, autofocus: true }),
    series_name: field({ label: 'Series', name: 'series_name', value: sermon.series_name || '', maxlength: 200 }),
    scripture_references: field({ label: 'Scripture references', name: 'scripture_references', multiline: true, rows: 3, value: (sermon.scripture_references || []).join('\n'), hint: 'One per line, for example John 3:16–21.' }),
    tags: field({ label: 'Tags', name: 'tags', value: (sermon.tags || []).join(', '), hint: 'Separate with commas.' }),
    description: field({ label: 'Description', name: 'description', multiline: true, rows: 5, value: sermon.description || '' })
  };
  const formError = formErrorBox();
  const dialogApi = { close: () => {} };
  const { submit, node } = actions(dialogApi, 'Save changes');
  const form = h('form', { novalidate: true }, ...Object.values(fields).map(f => f.wrapper), formError, node);
  const opened = openDialog({ title: 'Edit sermon', body: form });
  dialogApi.close = opened.close;
  wireForm({
    form, submit, formError, fields, dialog: opened,
    save: () => client.updateSermon(sermon.id, {
      title: fields.title.control.value,
      series_name: fields.series_name.control.value,
      scripture_references: splitLines(fields.scripture_references.control.value),
      tags: splitTags(fields.tags.control.value),
      description: fields.description.control.value
    }),
    onDone: onSaved
  });
  return opened;
}

/** Build preached_on from the precision the person picked. `null` means the date is unknown. */
export function preachedOnFor(precision, { day, month, year }) {
  if (precision === 'unknown') return null;
  const value = precision === 'exact' ? day : precision === 'month' ? month : year;
  return value || undefined;
}

export function logPreachingDialog({ client, sermon, onSaved }) {
  const precision = field({
    label: 'How precisely do you know the date?', name: 'date_precision', required: true, autofocus: true,
    children: PRECISION_OPTIONS.map(([value, label]) => h('option', { value, selected: value === 'exact' }, label))
  });
  const day = field({ label: 'Date', name: 'preached_on', type: 'date', required: true });
  const month = field({ label: 'Month', name: 'preached_on_month', type: 'month', required: true });
  const year = field({ label: 'Year', name: 'preached_on_year', type: 'number', required: true });
  year.control.setAttribute('min', '1900'); year.control.setAttribute('max', '2100');
  const placeChoices = places => [
    h('option', { value: '' }, 'No place recorded'),
    ...places.map(p => h('option', { value: p.id }, p.display_name)),
    h('option', { value: '__new__' }, 'Add a new place\u2026')
  ];
  const place = field({ label: 'Place', name: 'place_id', children: placeChoices([]) });
  const newPlace = field({ label: 'New place name', name: 'display_name', maxlength: 120 });
  const occasion = field({ label: 'Occasion', name: 'occasion', maxlength: 200, hint: 'For example Sunday gathering or Youth night.' });
  const version = field({
    label: 'Version used', name: 'version_id',
    children: [h('option', { value: '' }, 'Not specified'), ...(sermon.versions || []).map(v => h('option', { value: v.id }, v.label))]
  });
  const groups = { exact: day, month, year };
  const syncPrecision = () => {
    for (const [key, f] of Object.entries(groups)) setHidden(f.wrapper, key !== precision.control.value);
  };
  precision.control.addEventListener('change', syncPrecision);
  // The server reports a bad date as `preached_on` whichever input was used, so show it on the visible one.
  const visibleDate = () => groups[precision.control.value] || day;
  const dateField = {
    control: { focus: () => visibleDate().control.focus() },
    setError: message => { for (const f of Object.values(groups)) f.setError(''); if (message) visibleDate().setError(message); }
  };
  newPlace.wrapper.setAttribute('hidden', '');
  place.control.addEventListener('change', () => setHidden(newPlace.wrapper, place.control.value !== '__new__'));
  syncPrecision();

  const formError = formErrorBox();
  const dialogApi = { close: () => {} };
  const { submit, node } = actions(dialogApi, 'Log preaching');
  const form = h('form', { novalidate: true },
    h('p', { class: 'hint' }, `Record another time “${sermon.title}” was preached. The sermon itself does not change.`),
    precision.wrapper, day.wrapper, month.wrapper, year.wrapper, place.wrapper, newPlace.wrapper, occasion.wrapper, version.wrapper, formError, node);
  const opened = openDialog({ title: 'Log a preaching', body: form });
  dialogApi.close = opened.close;

  // Place options load after the dialog opens, so a slow list never blocks the form.
  let knownPlaces = [];
  client.listPlaces().then(places => {
    knownPlaces = [...places, ...knownPlaces.filter(k => !places.some(p => p.id === k.id))];
    const current = place.control.value;
    place.control.replaceChildren(...placeChoices(knownPlaces));
    if (current !== '') place.control.value = current;
  }).catch(() => { /* the form still works without existing places; "Add a new place" remains */ });

  wireForm({
    form, submit, formError, dialog: opened, onDone: onSaved,
    fields: { preached_on: dateField, date_precision: precision, place_id: place, version_id: version, occasion, display_name: newPlace },
    save: async () => {
      const kind = precision.control.value;
      const preachedOn = preachedOnFor(kind, { day: day.control.value, month: month.control.value, year: year.control.value.trim() });
      if (preachedOn === undefined) {
        const missing = groups[kind];
        missing.setError('Enter a date, or choose “Date unknown”.');
        missing.control.focus();
        throw new Handled();
      }
      let placeId = place.control.value || null;
      if (placeId === '__new__') {
        // Keep the created place selected, so a retry after a failed save reuses it instead of hitting name_in_use.
        const created = await client.createPlace(newPlace.control.value);
        knownPlaces = [...knownPlaces, created];
        place.control.replaceChildren(...placeChoices(knownPlaces));
        place.control.value = placeId = created.id;
        setHidden(newPlace.wrapper, true);
      }
      await client.logPreaching(sermon.id, {
        preached_on: preachedOn, date_precision: kind,
        place_id: placeId, version_id: version.control.value || null, occasion: occasion.control.value
      });
    }
  });
  return opened;
}

export function confirmArchiveDialog({ client, sermon, restore, onDone }) {
  const formError = formErrorBox();
  const dialogApi = { close: () => {} };
  const verb = restore ? 'Restore' : 'Archive';
  const { submit, node } = actions(dialogApi, verb + ' sermon', { danger: !restore, cancelFirst: true });
  const times = plural(sermon.preaching_events?.length || 0, 'preaching');
  const form = h('form', { novalidate: true },
    h('p', null, restore
      ? `Restore “${sermon.title}” to the active library?`
      : `Archive “${sermon.title}”? It leaves the active library, but its ${times} and versions are kept and you can restore it at any time.`),
    formError, node);
  const opened = openDialog({ title: `${verb} this sermon?`, body: form });
  dialogApi.close = opened.close;
  wireForm({
    form, submit, formError, fields: {}, dialog: opened, onDone,
    save: () => restore ? client.restoreSermon(sermon.id) : client.archiveSermon(sermon.id)
  });
  return opened;
}

/**
 * Generic confirmation for a consequential action. Cancel has focus, so Enter cannot confirm by
 * accident. `body` is a string or nodes; `save` runs the write and may throw an ApiError.
 */
export function confirmDialog({ title, body, confirmLabel, danger = false, save, onDone }) {
  const formError = formErrorBox();
  const dialogApi = { close: () => {} };
  const { submit, node } = actions(dialogApi, confirmLabel, { danger, cancelFirst: true });
  const form = h('form', { novalidate: true }, ...[body].flat().map(item => typeof item === 'string' ? h('p', null, item) : item), formError, node);
  const opened = openDialog({ title, body: form });
  dialogApi.close = opened.close;
  wireForm({ form, submit, formError, fields: {}, dialog: opened, onDone, save });
  return opened;
}
