// Places: list with aliases and usage, rename, and merge with an impact preview.
import { h, field, openDialog } from '../dom.js';
import { canEdit } from '../permissions.js';
import { plural } from '../format.js';
import { Handled, actions, formErrorBox, wireForm, setHidden } from './dialogs.js';
import { panel, sectionBox } from './panel.js';
import { ApiError, describeError } from '../api.js';

function renameDialog({ client, place, onDone }) {
  const name = field({ label: 'Place name', name: 'display_name', value: place.display_name, required: true, maxlength: 120, autofocus: true,
    hint: 'Past preachings keep pointing at this place under its new name.' });
  const formError = formErrorBox();
  const dialogApi = { close: () => {} };
  const { submit, node } = actions(dialogApi, 'Save name');
  const form = h('form', { novalidate: true }, name.wrapper, formError, node);
  const opened = openDialog({ title: 'Rename place', body: form });
  dialogApi.close = opened.close;
  wireForm({
    form, submit, formError, dialog: opened, onDone, fields: { display_name: name },
    save: async () => {
      try { await client.renamePlace(place.id, name.control.value); }
      catch (error) {
        // A taken name is about the field, not the whole form.
        if (!(error instanceof ApiError && error.status === 409)) throw error;
        name.setError(describeError(error));
        name.control.focus();
        throw new Handled();
      }
    }
  });
  return opened;
}

function impactBox(impact) {
  const aliases = impact.aliases_to_move || [];
  return h('div', { class: 'impact', role: 'status' },
    h('p', null, h('strong', null, `Merging “${impact.source.display_name}” into “${impact.target.display_name}” will:`)),
    h('ul', { class: 'bullets' },
      h('li', null, `move ${plural(impact.events_to_move, 'preaching')} to “${impact.target.display_name}” (${impact.resulting_event_count} in total afterwards)`),
      h('li', null, aliases.length ? `move ${plural(aliases.length, 'alias', 'aliases')}: ${aliases.join(', ')}` : 'move no existing aliases'),
      h('li', null, `keep “${impact.new_alias}” as an alias, so imports using that name still match`),
      h('li', null, `delete the place “${impact.source.display_name}”`)),
    h('p', { class: 'hint' }, 'The history of the merge is kept, but the merge cannot be undone here.'));
}

function mergeDialog({ client, place, others, onDone }) {
  const target = field({
    label: 'Merge into', name: 'target_place_id', required: true, autofocus: true,
    hint: 'Choose the place to keep. The one you are merging away is deleted.',
    children: [h('option', { value: '' }, 'Choose a place…'), ...others.map(p => h('option', { value: p.id }, p.display_name))]
  });
  const preview = h('div', { class: 'impact-slot' });
  const formError = formErrorBox();
  const dialogApi = { close: () => {} };
  const { submit, node } = actions(dialogApi, 'Merge places', { danger: true });
  submit.setAttribute('disabled', '');
  const previewButton = h('button', { type: 'button', class: 'btn', 'data-action': 'preview' }, 'Show what will change');
  let previewed = null;
  const reset = () => { previewed = null; preview.replaceChildren(); submit.setAttribute('disabled', ''); };
  target.control.addEventListener('change', reset);
  previewButton.addEventListener('click', async () => {
    const chosen = target.control.value;
    target.setError('');
    formError.setAttribute('hidden', '');
    if (!chosen) { target.setError('Choose the place to merge into.'); target.control.focus(); return; }
    previewButton.setAttribute('disabled', '');
    try {
      const impact = await client.previewMerge(place.id, chosen);
      if (target.control.value !== chosen) return; // the choice changed while loading
      previewed = chosen;
      preview.replaceChildren(impactBox(impact));
      submit.removeAttribute('disabled');
    } catch (error) {
      formError.textContent = describeError(error);
      setHidden(formError, false);
    } finally { previewButton.removeAttribute('disabled'); }
  });
  const form = h('form', { novalidate: true },
    h('p', null, `Merge “${place.display_name}” (${plural(place.event_count, 'preaching')}) into another place.`),
    target.wrapper, h('div', null, previewButton), preview, formError, node);
  const opened = openDialog({ title: 'Merge places', body: form });
  dialogApi.close = opened.close;
  wireForm({
    form, submit, formError, dialog: opened, onDone, fields: { target_place_id: target },
    save: async () => {
      // Only ever merge what was previewed, so the confirmation always matches the result.
      if (!previewed || previewed !== target.control.value) { target.setError('Show what will change first.'); throw new Handled(); }
      await client.mergePlaces(place.id, previewed);
    }
  });
  return opened;
}

function placeRow(place, ctx, others, reload) {
  const editor = canEdit(ctx.state.role);
  const done = message => async () => { ctx.toast(message); await ctx.refreshLibrary(); await reload({ quiet: true }); };
  return h('li', { class: 'place-row' },
    h('div', { class: 'place-main' },
      h('strong', null, place.display_name),
      h('span', { class: 'muted' }, plural(place.event_count, 'preaching')),
      place.aliases.length ? h('span', { class: 'aliases muted' }, `Also known as: ${place.aliases.join(', ')}`) : null),
    editor ? h('div', { class: 'row-actions' },
      h('button', { type: 'button', class: 'btn', 'data-action': 'rename', onclick: () => renameDialog({ client: ctx.client, place, onDone: done('Place renamed.') }) }, 'Rename'),
      others.length ? h('button', { type: 'button', class: 'btn', 'data-action': 'merge', onclick: () => mergeDialog({ client: ctx.client, place, others, onDone: done('Places merged.') }) }, 'Merge…') : null) : null);
}

export function placesSection(ctx) {
  const editor = canEdit(ctx.state.role);
  const { node } = panel({
    label: 'places',
    load: async () => (await ctx.client.listPlaces()).map(p => ({ ...p, aliases: p.aliases || [], event_count: p.event_count || 0 })),
    render: (places, reload) => places.length
      ? h('ul', { class: 'place-list' }, ...places.map(place => placeRow(place, ctx, places.filter(p => p.id !== place.id), reload)))
      : h('p', { class: 'muted' }, 'No places yet. They are added when you log where a sermon was preached.')
  });
  return sectionBox('places-title', 'Places',
    editor ? 'Rename a place or merge duplicates. A merged place’s name stays as an alias.' : 'Where sermons were preached. You have view-only access.', node);
}
