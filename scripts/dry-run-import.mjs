#!/usr/bin/env node
// Strictly offline, conservative private-source migration preflight.
// Default stdout has aggregate counts only; never echo a sermon title or raw row.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

// RFC-4180-style CSV reader. Handles quoted commas, newlines, escaped quotes,
// CRLF and blank rows. Rejects an unfinished quoted field rather than guessing.
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], field = '', quote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quote = false;
      else field += ch;
    } else if (ch === '"') {
      if (field !== '') throw new Error('Unexpected quote in CSV field');
      quote = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (quote) throw new Error('Unterminated quoted CSV field');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function normalizeDate(input) {
  const raw = String(input ?? '').trim();
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (!match) return { date: null, flags: ['invalid_or_missing_date'] };
  const month = Number(match[1]), day = Number(match[2]), year = Number(match[3]);
  const valid = year >= 1900 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 &&
    day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (!valid) return { date: null, flags: ['invalid_or_missing_date'] };
  return {
    date: year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0'),
    flags: day === 1 ? ['first_day_precision_review'] : []
  };
}

function titleKey(title) {
  return String(title ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function inspectHistory(csvText, options = {}) {
  const tab = options.tab || 'All History';
  if (tab !== 'All History') throw new Error('Only canonical All History is accepted for the first import');
  const csv = parseCsv(csvText);
  if (!/^date preached$/i.test(String(csv[0]?.[0] ?? '').trim()) ||
      !/^sermon title$/i.test(String(csv[0]?.[1] ?? '').trim())) {
    throw new Error('Unexpected source headers; use the canonical All History export');
  }
  const fingerprint = sha256(csvText);
  const rows = [], titleKeys = new Set(), placeNames = new Set(), keySet = new Set();
  const flagCounts = {};
  let duplicateCandidates = 0;
  for (let i = 1; i < csv.length; i++) {
    const values = csv[i].slice(0, 6).map(v => String(v ?? ''));
    if (!values.some(x => x.trim())) continue;
    if (/^please insert rows below this row/i.test(values[0])) continue;
    const date = normalizeDate(values[0]);
    const title = values[1].trim(), venue = values[5].trim();
    const flags = ['ownership_unverified', ...date.flags];
    if (!title) flags.push('missing_title');
    if (!venue) flags.push('missing_place');
    if (!values[2].trim()) flags.push('missing_category');
    if (!values[3].trim()) flags.push('missing_tags');
    for (const flag of flags) flagCounts[flag] = (flagCounts[flag] || 0) + 1;
    if (title) titleKeys.add(titleKey(title));
    if (venue) placeNames.add(venue);
    const signature = [date.date || values[0], titleKey(title), venue.toLowerCase()].join('|');
    if (keySet.has(signature)) duplicateCandidates++;
    keySet.add(signature);
    const sourceRow = i + 1;
    rows.push({
      id: sha256([fingerprint, tab, sourceRow, JSON.stringify(values)].join(':')),
      source_tab: tab,
      source_row: sourceRow,
      raw: values,
      proposed_date: date.date,
      proposed_title: title || null,
      proposed_place: venue || null,
      flags,
      owner_workspace_id: null,
      review_status: 'unreviewed'
    });
  }
  return {
    summary: {
      source_tab: tab,
      rows: rows.length,
      complete_date_title: rows.filter(r => r.proposed_date && r.proposed_title).length,
      unique_title_spellings: titleKeys.size,
      venue_variants: placeNames.size,
      exact_duplicate_candidates: duplicateCandidates,
      flag_counts: flagCounts,
      source_sha256: fingerprint,
      ownership_assigned: 0
    },
    rows
  };
}

export async function preflightFile(input, tab = 'All History') {
  const stat = await readFile(input);
  if (stat.byteLength > 10 * 1024 * 1024) throw new Error('Source exceeds 10 MiB safety limit');
  return inspectHistory(stat.toString('utf8'), { tab });
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!['--input','--tab','--private-output'].includes(key) || !argv[i + 1]) {
      throw new Error('Usage: --input /private/history.csv [--tab "All History"] [--private-output /private/review.json]');
    }
    out[key.slice(2)] = argv[++i];
  }
  if (!out.input) throw new Error('Missing --input');
  return out;
}

export async function main(argv) {
  const args = parseArgs(argv);
  const result = await preflightFile(args.input, args.tab || 'All History');
  if (args['private-output']) {
    const path = resolve(args['private-output']);
    const repo = resolve(process.cwd());
    if (path === repo || path.startsWith(repo + sep)) {
      throw new Error('Refusing to write private review data inside the working repository');
    }
    await writeFile(path, JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx' });
  }
  // Avoid source titles, venues, row contents, and source paths in logs.
  console.log(JSON.stringify({ ...result.summary, source_sha256: result.summary.source_sha256.slice(0, 12) }, null, 2));
  return result.summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch(err => {
    console.error('Import preflight failed: ' + (err instanceof Error ? err.message : 'unknown error'));
    process.exitCode = 1;
  });
}
