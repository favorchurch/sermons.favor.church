// Import Review (Owner only): stage the canonical history CSV, review each row's flags, then
// attest, ignore, approve or roll back. Attesting and approving are separate, explicit steps.
import { h } from '../dom.js';
import { describeError, ApiError } from '../api.js';
import { hrefFor } from '../router.js';
import { formatDay, plural } from '../format.js';
import { FILTERS, MAX_ATTEST, filterRows, flagLabel, pageOf, rowActions, statusInfo } from '../import-model.js';
import { confirmDialog } from './dialogs.js';
import { panel, notice, sectionBox } from './panel.js';

const MAX_CSV_CHARS = 9 * 1024 * 1024;

function uploadCard(ctx) {
  const input = h('input', { id: 'import-file', type: 'file', accept: '.csv,text/csv' });
  const message = h('div', { class: 'upload-message' });
  const button = h('button', { type: 'button', class: 'btn btn-primary', 'data-action': 'stage' }, 'Stage file');
  const show = (text, tone) => message.replaceChildren(text ? notice(text, tone) : '');
  button.addEventListener('click', async () => {
    const file = input.files?.[0];
    if (!file) { show('Choose the history CSV first.'); return; }
    button.setAttribute('disabled', '');
    show('');
    try {
      const csv = await file.text();
      if (csv.length > MAX_CSV_CHARS) { show('That file is too large (limit about 9 MB).'); return; }
      const result = await ctx.client.uploadImport(csv);
      ctx.toast(result.reused ? 'That file was already staged. Opening it.' : 'File staged for review. Nothing has been imported yet.');
      ctx.setHash(hrefFor({ name: 'settings', section: 'import', batch: result.id }));
    } catch (error) {
      show(error instanceof ApiError && (error.field === 'csv' || error.field === 'body') && error.status === 400
        ? 'That file could not be read as the history export. Check that it is the unedited CSV.'
        : describeError(error));
    } finally { button.removeAttribute('disabled'); }
  });
  return h('div', { class: 'upload-card' },
    h('div', { class: 'field' },
      h('label', { for: 'import-file' }, 'History CSV'), input,
      h('p', { class: 'hint' }, 'Uploading only stages the rows for review. The same file uploaded twice opens the existing review.')),
    button, message);
}

const SUMMARY = [['total', 'Rows'], ['parsed', 'Readable'], ['invalid', 'Could not be read'], ['flagged', 'Flagged'], ['attested', 'Attested'], ['approved', 'Approved']];

function summaryList(summary) {
  return h('dl', { class: 'import-summary' }, ...SUMMARY.flatMap(([key, label]) => [
    h('div', { class: 'tile', 'data-count': key }, h('dd', null, String(summary?.[key] ?? 0)), h('dt', null, label))]));
}

function reviewPanel(ctx, batchId) {
  const { client } = ctx;
  const view = { filter: 'all', page: 0, selected: new Set(), busy: false, message: '' };
  let rows = [];
  let summary = null;

  const summaryBox = h('div', { class: 'summary-box' });
  const status = h('p', { class: 'review-status', role: 'status', tabindex: '-1' });
  const bar = h('div', { class: 'bulk-bar' });
  const tableBox = h('div', { class: 'table-box' });
  const checkboxes = new Map();

  const actionsFor = id => { const row = rows.find(r => r.id === id); return row ? rowActions(row) : {}; };
  const selectedWith = key => [...view.selected].filter(id => actionsFor(id)[key]);

  function say(text) { status.textContent = text; }
  function drawBar() {
    const attest = selectedWith('attest'), approve = selectedWith('approve');
    const tooMany = attest.length > MAX_ATTEST;
    bar.replaceChildren(
      h('span', { class: 'muted' }, `${plural(view.selected.size, 'row')} selected`),
      h('button', { type: 'button', class: 'btn', 'data-action': 'attest-selected', disabled: view.busy || !attest.length || tooMany, onclick: () => attestDialog(attest) }, `Attest selected (${attest.length})`),
      h('button', { type: 'button', class: 'btn', 'data-action': 'approve-selected', disabled: view.busy || !approve.length, onclick: () => approveMany(approve) }, `Approve selected (${approve.length})`),
      tooMany ? h('span', { class: 'hint' }, `Select at most ${MAX_ATTEST} rows to attest at once.`) : null);
  }

  function drawSummary() { summaryBox.replaceChildren(summaryList(summary)); }

  async function refresh() {
    [summary, rows] = await Promise.all([client.importSummary(batchId), client.importRows(batchId)]);
    const ids = new Set(rows.map(row => row.id));
    for (const id of [...view.selected]) if (!ids.has(id)) view.selected.delete(id);
    drawSummary(); drawTable(); drawBar();
  }

  /** Run one write, then reload so the screen shows what the server now holds. */
  async function run(task, success) {
    if (view.busy) return;
    view.busy = true; say(''); drawTable(); drawBar();
    try {
      await task();
      say(success);
    } catch (error) {
      say(describeError(error));
    }
    try { await refresh(); } catch (error) { say(`${status.textContent} The list could not be refreshed. ${describeError(error)}`); }
    view.busy = false; drawTable(); drawBar();
    status.focus?.();
    await ctx.refreshLibrary();
  }

  const attestDialog = ids => confirmDialog({
    title: `Attest ${plural(ids.length, 'row')}?`,
    body: [
      `By attesting, you confirm that you, as Owner of this archive, are responsible for importing ${ids.length === 1 ? 'this sermon record' : 'these sermon records'}.`,
      'Nothing is created yet. Approving is a separate step, and no owner is assumed from the file.'
    ],
    confirmLabel: `Attest ${plural(ids.length, 'row')}`,
    save: () => client.attestRows(batchId, ids),
    onDone: async () => { view.selected.clear(); say(`${plural(ids.length, 'row')} attested.`); await refresh(); status.focus?.(); }
  });

  const rollbackDialog = row => {
    let outcome = null;
    return confirmDialog({
      title: 'Roll back this row?',
      body: [
        `This removes the sermon and preaching created from row ${row.source_row}, but only if nobody has edited or used them since.`,
        'If they have changed, nothing is deleted and the row is marked as blocked for manual review. A place that already existed is never removed.'
      ],
      confirmLabel: 'Roll back', danger: true,
      save: async () => { outcome = await client.rollbackRow(batchId, row.id); },
      onDone: async () => {
        say(outcome?.conflict ? 'That row was edited or is in use, so it was not rolled back. It is marked for manual review.' : 'Row rolled back.');
        await refresh(); status.focus?.(); await ctx.refreshLibrary();
      }
    });
  };

  async function approveMany(ids) {
    let done = 0;
    await run(async () => {
      for (const id of ids) { await client.approveRow(batchId, id); done += 1; view.selected.delete(id); }
    }, `Approved ${plural(ids.length, 'row')}.`);
    if (done < ids.length) say(`Approved ${done} of ${ids.length}. ${status.textContent}`);
  }

  function actionButtons(row) {
    const can = rowActions(row);
    const button = (label, key, onclick, extra = {}) => h('button', { type: 'button', class: 'btn', 'data-action': key, disabled: view.busy, onclick, ...extra }, label);
    return h('div', { class: 'row-actions' },
      can.attest ? button(row.status === 'unreviewed' ? 'Attest' : 'Review again', 'attest', () => attestDialog([row.id]), { 'aria-label': `${row.status === 'unreviewed' ? 'Attest' : 'Review again'} row ${row.source_row}` }) : null,
      can.approve ? button('Approve', 'approve', () => run(() => client.approveRow(batchId, row.id), `Row ${row.source_row} approved.`), { 'aria-label': `Approve row ${row.source_row}` }) : null,
      can.ignore ? button('Ignore', 'ignore', () => run(() => client.ignoreRow(batchId, row.id), `Row ${row.source_row} ignored.`), { 'aria-label': `Ignore row ${row.source_row}` }) : null,
      can.rollback ? button(row.status === 'rollback_conflict' ? 'Try rollback again' : 'Roll back', 'rollback', () => rollbackDialog(row), { 'aria-label': `Roll back row ${row.source_row}` }) : null);
  }

  function rowNode(row) {
    const can = rowActions(row);
    const info = statusInfo(row.status);
    let select = null;
    if (can.attest || can.approve) {
      select = h('input', { type: 'checkbox', 'aria-label': `Select row ${row.source_row}`, 'data-row': row.id });
      select.checked = view.selected.has(row.id);
      select.addEventListener('change', () => { if (select.checked) view.selected.add(row.id); else view.selected.delete(row.id); drawBar(); });
      checkboxes.set(row.id, select);
    }
    return h('tr', { 'data-status': row.status },
      h('td', { 'data-label': 'Select' }, select),
      h('th', { scope: 'row', 'data-label': 'Row' }, String(row.source_row)),
      h('td', { 'data-label': 'Sermon' }, row.proposed_title || h('span', { class: 'muted' }, 'No title')),
      h('td', { 'data-label': 'Date' }, row.proposed_date ? formatDay(row.proposed_date) : h('span', { class: 'muted' }, 'No date')),
      h('td', { 'data-label': 'Place' }, row.proposed_place || h('span', { class: 'muted' }, 'No place')),
      h('td', { 'data-label': 'Flags' }, h('ul', { class: 'flag-list' }, ...(row.flags || []).map(flag => h('li', { class: 'pill pill-warn', 'data-flag': flag }, flagLabel(flag))))),
      h('td', { 'data-label': 'Status' },
        h('span', { class: `pill pill-${info.tone}` }, info.label),
        row.parse_outcome !== 'parsed' ? h('span', { class: 'pill pill-bad' }, 'Could not be read') : null,
        row.status === 'rollback_conflict' ? h('p', { class: 'hint' }, 'Edited or in use. Resolve it by hand, then try again.') : null),
      h('td', { 'data-label': 'Actions' }, actionButtons(row)));
  }

  function drawTable() {
    checkboxes.clear();
    const shown = filterRows(rows, view.filter);
    const page = pageOf(shown, view.page);
    view.page = page.page;
    const allBox = h('input', { type: 'checkbox', 'aria-label': 'Select every row on this page that can be selected' });
    allBox.addEventListener('change', () => {
      for (const [id, box] of checkboxes) { box.checked = allBox.checked; if (allBox.checked) view.selected.add(id); else view.selected.delete(id); }
      drawBar();
    });
    const body = page.rows.map(rowNode);
    tableBox.replaceChildren(
      h('p', { class: 'result-count' }, `${plural(page.total, 'row')}${view.filter === 'all' ? '' : ' match this filter'}`),
      page.total
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'sermon-table import-table' },
          h('caption', { class: 'sr-only' }, 'Rows staged for review'),
          h('thead', null, h('tr', null,
            h('th', { scope: 'col' }, allBox),
            ...['Row', 'Sermon', 'Date', 'Place', 'Flags', 'Status', 'Actions'].map(label => h('th', { scope: 'col' }, label)))),
          h('tbody', null, ...body)))
        : h('p', { class: 'muted' }, 'No rows to show.'),
      page.pages > 1 ? h('div', { class: 'pager' },
        h('button', { type: 'button', class: 'btn', 'data-action': 'prev', disabled: page.page === 0, onclick: () => { view.page -= 1; drawTable(); } }, 'Previous'),
        h('span', { class: 'muted' }, `Page ${page.page + 1} of ${page.pages}`),
        h('button', { type: 'button', class: 'btn', 'data-action': 'next', disabled: page.page >= page.pages - 1, onclick: () => { view.page += 1; drawTable(); } }, 'Next')) : null);
  }

  const filter = h('select', { id: 'import-filter', onchange: event => { view.filter = event.target.value; view.page = 0; drawTable(); } },
    ...FILTERS.map(([value, label]) => h('option', { value }, label)));

  const { node } = panel({
    label: 'the import review',
    load: async () => { await refresh(); return true; },
    render: () => h('div', { class: 'review' },
      summaryBox,
      h('div', { class: 'review-controls' },
        h('div', { class: 'field' }, h('label', { for: 'import-filter' }, 'Show'), filter),
        bar),
      status, tableBox)
  });
  return node;
}

export function importSection(ctx) {
  const { route } = ctx;
  return sectionBox('import-title', 'Import Review',
    'Only Owners see this. Review the staged history row by row. Attest that you are responsible for it, then approve the rows you want in the archive.',
    uploadCard(ctx),
    route.batch ? reviewPanel(ctx, route.batch) : h('p', { class: 'muted' }, 'No file is open. Stage a CSV above to start a review.'));
}
