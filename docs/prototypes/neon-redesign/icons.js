// Single-weight (1.75px stroke) line icon set + original Sermon Bank book art.
// Zero stars, sparkles, bursts, or emoji glyphs.

const SVG_NS = 'http://www.w3.org/2000/svg';

const PATHS = {
  library: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><path d="M8 7h8"/><path d="M8 11h6"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/><path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M16 14h.01"/><path d="M8 18h.01"/><path d="M12 18h.01"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  places: '<path d="M12 21s-6-5.3-6-10a6 6 0 1 1 12 0c0 4.7-6 10-6 10z"/><circle cx="12" cy="11" r="2.2"/>',
  docs: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/>',
  people: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
  external: '<path d="M14 4h6v6"/><path d="M10 14 20 4"/><path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  menu: '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  rows: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M9 4v16"/>',
  folder: '<path d="M4 6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>',
  layoutRail: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  layoutTop: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>'
};

export function icon(name, size = 18) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('ic');
  svg.innerHTML = PATHS[name] || '';
  return svg;
}

/** Exact original Sermon Bank mark (three shelf spines + brass ribbon, public/assets/icon.svg) */
export function brandMark(size = 32) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('brand-mark');
  svg.innerHTML =
    '<rect width="32" height="32" rx="7" fill="var(--accent)"/>' +
    '<rect x="6.5" y="9" width="4.6" height="15" rx="1" fill="#eef4ea"/>' +
    '<rect x="12.4" y="6.5" width="4.6" height="17.5" rx="1" fill="#cfe0cc"/>' +
    '<rect x="18.6" y="9.4" width="4.6" height="15" rx="1" transform="rotate(14 20.9 24)" fill="#eef4ea"/>' +
    '<path d="M13.6 6.5h2.2v6.4l-1.1-1-1.1 1z" fill="var(--book-ribbon)"/>' +
    '<rect x="5" y="24" width="22" height="2.4" rx="1.2" fill="var(--book-shelf)"/>';
  return svg;
}

/** Compact architectural bookshelf illustration for Library header & Sign-in banner */
export function shelfBooksArt({ width = 108, height = 44 } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', '0 0 108 44');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('shelf-art');
  svg.innerHTML =
    '<rect x="10" y="10" width="11" height="28" rx="2" fill="var(--book-moss-bg)"/>' +
    '<rect x="12" y="14" width="7" height="1.2" rx=".6" fill="var(--book-moss-fg)" opacity=".55"/>' +
    '<rect x="23" y="6" width="12" height="32" rx="2" fill="var(--book-linen-bg)" stroke="var(--rule)" stroke-width=".75"/>' +
    '<path d="M27.5 6h3v9.5l-1.5-1.4-1.5 1.4z" fill="var(--book-ribbon)"/>' +
    '<rect x="37" y="12" width="10" height="26" rx="2" fill="var(--book-night-bg)"/>' +
    '<rect x="39" y="16" width="6" height="1.2" rx=".6" fill="var(--book-night-fg)" opacity=".5"/>' +
    '<rect x="49" y="8" width="12" height="30" rx="2" fill="var(--book-sage-bg)"/>' +
    '<rect x="51" y="12" width="8" height="1.2" rx=".6" fill="var(--book-sage-fg)" opacity=".45"/>' +
    '<rect x="63" y="11" width="11" height="27" rx="2" fill="var(--book-pine-bg)"/>' +
    '<rect x="78" y="11" width="10" height="27" rx="2" transform="rotate(13 83 38)" fill="var(--book-clay-bg)"/>' +
    '<rect x="4" y="38" width="100" height="4" rx="2" fill="var(--book-clay-bg)"/>' +
    '<rect x="4" y="38" width="100" height="1.2" rx=".6" fill="var(--book-shelf)" opacity=".28"/>';
  return svg;
}

/** Calm open-book & shelf illustration for empty states */
export function emptyBooksArt() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '76');
  svg.setAttribute('height', '52');
  svg.setAttribute('viewBox', '0 0 76 52');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('empty-books-art');
  svg.innerHTML =
    '<path d="M12 14c0-2.2 1.8-4 4-4h18c2.2 0 4 1.8 4 4v26c0-1.6-1.4-3-3-3H14a2 2 0 0 1-2-2V14z" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="1.5"/>' +
    '<path d="M64 14c0-2.2-1.8-4-4-4H42c-2.2 0-4 1.8-4 4v26c0-1.6 1.4-3 3-3h21a2 2 0 0 0 2-2V14z" fill="var(--bg-surface)" stroke="var(--accent)" stroke-width="1.5"/>' +
    '<path d="M46 10h4v12l-2-1.8-2 1.8z" fill="var(--book-ribbon)"/>' +
    '<path d="M18 19h12M18 24h10M18 29h8" stroke="var(--accent)" stroke-width="1.4" stroke-linecap="round" opacity=".55"/>' +
    '<path d="M46 25h11M46 30h9" stroke="var(--muted)" stroke-width="1.4" stroke-linecap="round" opacity=".45"/>' +
    '<rect x="6" y="43" width="64" height="3.5" rx="1.75" fill="var(--book-clay-bg)"/>';
  return svg;
}

/** Tactile mini book cover for Sermon Detail header (deterministic original palette + line motif) */
export function miniBookCover(swatchIndex) {
  const palettes = [
    ['var(--book-moss-bg)', 'var(--book-moss-fg)'],
    ['var(--book-night-bg)', 'var(--book-night-fg)'],
    ['var(--book-pine-bg)', 'var(--book-pine-fg)'],
    ['var(--book-clay-bg)', 'var(--book-clay-fg)'],
    ['var(--book-sage-bg)', 'var(--book-sage-fg)'],
    ['var(--book-linen-bg)', 'var(--book-linen-fg)']
  ];
  const [bg, fg] = palettes[swatchIndex % palettes.length];
  const motifs = [
    `<circle cx="42" cy="48" r="18" stroke="${fg}" stroke-width="1.1" fill="none" opacity=".32"/><circle cx="42" cy="48" r="11" stroke="${fg}" stroke-width="1.1" fill="none" opacity=".32"/>`,
    `<path d="M8 58 Q 22 40 36 58 T 56 54" stroke="${fg}" stroke-width="1.2" fill="none" opacity=".35"/><path d="M14 64 Q 28 48 44 64" stroke="${fg}" stroke-width="1.2" fill="none" opacity=".28"/>`,
    `<path d="M14 26h28M14 33h20M14 40h24" stroke="${fg}" stroke-width="1.3" stroke-linecap="round" opacity=".36"/>`
  ];
  const motif = motifs[swatchIndex % motifs.length];
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '54');
  svg.setAttribute('height', '72');
  svg.setAttribute('viewBox', '0 0 54 72');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('detail-book-thumb');
  svg.innerHTML =
    `<rect x="1" y="1" width="52" height="70" rx="5" fill="${bg}"/>` +
    `<rect x="1" y="1" width="6" height="70" rx="2" fill="#000" opacity=".12"/>` +
    `<line x1="7" y1="15" x2="53" y2="15" stroke="${fg}" stroke-width=".9" opacity=".3"/>` +
    `<path d="M14 1h5v11l-2.5-2-2.5 2z" fill="var(--book-ribbon)"/>` +
    motif +
    `<rect x="49" y="1" width="4" height="70" rx="1" fill="#fff" opacity=".2"/>`;
  return svg;
}

export function googleMark() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('viewBox', '0 0 18 18');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    '<path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/>' +
    '<path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 0 0 9 18z"/>' +
    '<path fill="#FBBC05" d="M3.96 10.71A5.41 5.41 0 0 1 3.68 9c0-.6.1-1.17.28-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.04l3-2.33z"/>' +
    '<path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.66 3.58 9 3.58z"/>';
  return svg;
}
