import { createHash } from 'node:crypto';

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
      else if (ch === '"') {
        quote = false;
        const next = text[i + 1];
        if (next !== undefined && next !== ',' && next !== '\r' && next !== '\n') {
          throw new Error('Unexpected character after closing quote in CSV field');
        }
      } else field += ch;
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
  const headers = csv[0];
  if ((headers.length === 2 && csv.slice(1).some(row => row.length > 2)) ||
      (headers.length > 2 && ['Category', 'Tags', 'Stories Shared', 'Location'].some((name, index) =>
        String(headers[index + 2] ?? '').trim().toLowerCase() !== name.toLowerCase()))) {
    throw new Error('Unexpected source headers; use the canonical All History export');
  }
  const fingerprint = sha256(csvText);
  const rows = [], titleKeys = new Set(), placeNames = new Set(), keySet = new Set();
  const flagCounts = {};
  let duplicateCandidates = 0;
  for (let i = 1; i < csv.length; i++) {
    const values = Array.from({ length: Math.max(6, csv[i].length) }, (_, c) => String(csv[i][c] ?? ''));
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

