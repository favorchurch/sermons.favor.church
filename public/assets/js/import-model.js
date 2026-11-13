// Pure helpers for Import Review: labels, which actions a row allows, filtering and paging.
export const FLAG_LABELS = {
  ownership_unverified: 'Ownership not verified',
  unknown_owner: 'Owner unknown',
  invalid_or_missing_date: 'Date missing or invalid',
  first_day_precision_review: 'Dated the 1st: check precision',
  missing_title: 'No title',
  missing_place: 'No place',
  missing_category: 'No category',
  missing_tags: 'No tags',
  undated: 'Undated',
  venue_alias: 'Place matches an existing alias',
  suspected_duplicate_event: 'Possible duplicate'
};
export const flagLabel = flag => FLAG_LABELS[flag] || String(flag).replace(/_/g, ' ');

export const STATUS_LABELS = {
  unreviewed: ['Needs review', 'neutral'],
  attested: ['Attested', 'warn'],
  ignored: ['Ignored', 'neutral'],
  approved: ['Approved', 'good'],
  rolled_back: ['Rolled back', 'neutral'],
  rollback_conflict: ['Rollback blocked', 'bad']
};
export const statusInfo = status => { const [label, tone] = STATUS_LABELS[status] || ['Unknown', 'neutral']; return { label, tone }; };

const parsed = row => row.parse_outcome === 'parsed';

/** What the Owner can do with one row, mirroring the server's state rules. */
export function rowActions(row) {
  const status = row.status;
  return {
    attest: parsed(row) && ['unreviewed', 'ignored', 'rolled_back'].includes(status),
    ignore: ['unreviewed', 'attested'].includes(status),
    approve: status === 'attested' && parsed(row) && Boolean(row.proposed_title),
    rollback: status === 'approved' || status === 'rollback_conflict'
  };
}

export const FILTERS = [
  ['all', 'All rows'],
  ['unreviewed', 'Needs review'],
  ['attested', 'Attested'],
  ['flagged', 'Flagged'],
  ['invalid', 'Could not be read'],
  ['approved', 'Approved'],
  ['ignored', 'Ignored'],
  ['blocked', 'Rolled back or blocked']
];

export function filterRows(rows, filter) {
  switch (filter) {
    case 'flagged': return rows.filter(row => row.flags?.length > 0);
    case 'invalid': return rows.filter(row => !parsed(row));
    case 'blocked': return rows.filter(row => row.status === 'rolled_back' || row.status === 'rollback_conflict');
    case 'all': return rows;
    default: return rows.filter(row => row.status === filter);
  }
}

export const PAGE_SIZE = 50;
export const MAX_ATTEST = 500;

export function pageOf(rows, page, size = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const index = Math.min(Math.max(0, page), pages - 1);
  return { rows: rows.slice(index * size, index * size + size), page: index, pages, total: rows.length };
}
