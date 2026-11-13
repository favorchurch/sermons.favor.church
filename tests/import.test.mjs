import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspectHistory, parseCsv, normalizeDate } from '../scripts/dry-run-import.mjs';

const fixture = new URL('./fixtures/anonymous-history.csv', import.meta.url);

test('parses quoted commas and row positions without shifting source provenance', async () => {
  const rows = parseCsv(await readFile(fixture, 'utf8'));
  assert.equal(rows[4][1], 'A New Beginning, Again');
  assert.equal(rows[4][0], '1/1/2025');
  const out = inspectHistory(await readFile(fixture, 'utf8'));
  assert.equal(out.rows[0].source_row, 5);
  assert.equal(out.rows.length, 4);
});

test('never assigns ownership and keeps original source cells', async () => {
  const out = inspectHistory(await readFile(fixture, 'utf8'));
  assert.equal(out.summary.ownership_assigned, 0);
  for (const row of out.rows) {
    assert.equal(row.owner_workspace_id, null);
    assert.ok(row.flags.includes('ownership_unverified'));
    assert.equal(row.raw.length, 6);
  }
});

test('keeps repeated sermons as distinct preaching rows, not auto-deduped', async () => {
  const out = inspectHistory(await readFile(fixture, 'utf8'));
  assert.equal(out.summary.rows, 4);
  assert.equal(out.summary.unique_title_spellings, 2);
  assert.equal(out.summary.exact_duplicate_candidates, 0);
});

test('flags date day one without deciding it is inaccurate', () => {
  const date = normalizeDate('1/1/2025');
  assert.equal(date.date, '2025-01-01');
  assert.deepEqual(date.flags, ['first_day_precision_review']);
  assert.equal(normalizeDate('2/29/2023').date, null);
  assert.equal(normalizeDate('2/29/2024').date, '2024-02-29');
});

test('missing title becomes review flag without fabricating a sermon', async () => {
  const out = inspectHistory(await readFile(fixture, 'utf8'));
  assert.equal(out.summary.complete_date_title, 3);
  assert.equal(out.summary.flag_counts.missing_title, 1);
  assert.equal(out.rows.at(-1).proposed_title, null);
});

test('rejects other tab exports and malformed CSV', () => {
  assert.throws(() => inspectHistory('DATE,SERMON\n1/1/2025,Test'), /Unexpected source headers/);
  assert.throws(() => inspectHistory('Date Preached,Sermon Title\n1/1/2025,Test', { tab: 'Dashboard' }), /Only canonical/);
  assert.throws(() => parseCsv('header\n"unfinished'), /Unterminated quoted/);
  assert.throws(() => parseCsv('a\n"abc"def\n'), /after closing quote/);
  assert.deepEqual(parseCsv('"a","b"\r\n"c"'), [['a', 'b'], ['c']]);
});

test('idempotent row keys are stable for identical source exports', async () => {
  const source = await readFile(fixture, 'utf8');
  assert.deepEqual(inspectHistory(source), inspectHistory(source));
  assert.notEqual(inspectHistory(source).rows[0].id, inspectHistory(source + '\n').rows[0].id);
});

test('short rows are flagged for review instead of crashing the preflight', () => {
  const out = inspectHistory('Date Preached,Sermon Title\n1/2/2024,Only Two Columns\n3/4/2024\n');
  assert.equal(out.summary.rows, 2);
  assert.equal(out.summary.flag_counts.missing_place, 2);
  assert.equal(out.rows[1].proposed_title, null);
});

test('preserves additional source columns in the original values', () => {
  const out = inspectHistory('Date Preached,Sermon Title,Category,Tags,Stories Shared,Location,Extra\n1/2/2024,Title,c,t,n,Place,extra value\n');
  assert.equal(out.rows[0].raw[6], 'extra value');
});

test('rejects reordered or partial positional source headers', () => {
  assert.throws(() => inspectHistory('Date Preached,Sermon Title,Category,Tags,Location,Stories Shared\n1/2/2024,T,c,t,Here,Story'), /Unexpected source headers/);
  assert.throws(() => inspectHistory('Date Preached,Sermon Title,Category\n1/2/2024,T,c'), /Unexpected source headers/);
});
