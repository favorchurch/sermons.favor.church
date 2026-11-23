// Cover art: spines for the hero shelf, illustrated covers for the grid, and SVG book art
// and line icons for layouts A and C. All art is decorative (aria-hidden) and built via DOM
// nodes (never innerHTML) so it stays strict-CSP safe.
import { h } from '../dom.js';
import { coverFor } from '../covers.js';

// W3C SVG XML namespace URI (not a network URL).
const SVG_NS = ['http:', '', 'www.w3.org', '2000', 'svg'].join('/');

export function layoutOf(explicit) {
  const value = explicit || globalThis.document?.documentElement?.getAttribute?.('data-layout');
  return value === 'a' || value === 'c' ? value : 'original';
}

export const isThemed = explicit => layoutOf(explicit) !== 'original';

function svgEl(tag, attrs = {}, ...children) {
  const el = typeof document.createElementNS === 'function'
    ? document.createElementNS(SVG_NS, tag)
    : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined && v !== false) el.setAttribute(k, String(v));
  }
  for (const child of children.flat(Infinity)) {
    if (child) el.append(child);
  }
  return el;
}

const LINE_ICONS = {
  plus: [
    ['path', { d: 'M12 5v14' }],
    ['path', { d: 'M5 12h14' }]
  ],
  search: [
    ['circle', { cx: '11', cy: '11', r: '7' }],
    ['path', { d: 'm20 20-3.5-3.5' }]
  ],
  chevronLeft: [
    ['path', { d: 'm15 18-6-6 6-6' }]
  ],
  chevronRight: [
    ['path', { d: 'm9 18 6-6-6-6' }]
  ],
  arrowLeft: [
    ['path', { d: 'M19 12H5' }],
    ['path', { d: 'm12 19-7-7 7-7' }]
  ],
  external: [
    ['path', { d: 'M14 4h6v6' }],
    ['path', { d: 'M10 14 20 4' }],
    ['path', { d: 'M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5' }]
  ],
  edit: [
    ['path', { d: 'M12 20h9' }],
    ['path', { d: 'M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z' }]
  ],
  archive: [
    ['rect', { x: '3', y: '4', width: '18', height: '4', rx: '1' }],
    ['path', { d: 'M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8' }],
    ['path', { d: 'M10 12h4' }]
  ],
  rows: [
    ['path', { d: 'M4 6h16' }],
    ['path', { d: 'M4 12h16' }],
    ['path', { d: 'M4 18h16' }]
  ],
  table: [
    ['rect', { x: '3', y: '4', width: '18', height: '16', rx: '2' }],
    ['path', { d: 'M3 10h18' }],
    ['path', { d: 'M9 4v16' }]
  ],
  covers: [
    ['rect', { x: '3', y: '4', width: '7', height: '7', rx: '1' }],
    ['rect', { x: '14', y: '4', width: '7', height: '7', rx: '1' }],
    ['rect', { x: '3', y: '14', width: '7', height: '7', rx: '1' }],
    ['rect', { x: '14', y: '14', width: '7', height: '7', rx: '1' }]
  ],
  calendar: [
    ['rect', { x: '3', y: '4', width: '18', height: '18', rx: '2' }],
    ['path', { d: 'M16 2v4' }],
    ['path', { d: 'M8 2v4' }],
    ['path', { d: 'M3 10h18' }]
  ]
};

export function lineIcon(name, size = 18) {
  const shapes = LINE_ICONS[name] || [];
  return svgEl('svg', {
    class: 'ic',
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.75',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true'
  }, ...shapes.map(([tag, attrs]) => svgEl(tag, attrs)));
}

/** Exact Sermon Bank book mark (three shelf spines + brass ribbon). */
export function brandMarkArt(size = 40) {
  return svgEl('svg', {
    class: 'brand-mark',
    width: size,
    height: size,
    viewBox: '0 0 32 32',
    'aria-hidden': 'true'
  },
  svgEl('rect', { width: '32', height: '32', rx: '7', fill: 'var(--theme-accent)' }),
  svgEl('rect', { x: '6.5', y: '9', width: '4.6', height: '15', rx: '1', fill: '#eef4ea' }),
  svgEl('rect', { x: '12.4', y: '6.5', width: '4.6', height: '17.5', rx: '1', fill: '#cfe0cc' }),
  svgEl('rect', { x: '18.6', y: '9.4', width: '4.6', height: '15', rx: '1', transform: 'rotate(14 20.9 24)', fill: '#eef4ea' }),
  svgEl('path', { d: 'M13.6 6.5h2.2v6.4l-1.1-1-1.1 1z', fill: 'var(--book-ribbon)' }),
  svgEl('rect', { x: '5', y: '24', width: '22', height: '2.4', rx: '1.2', fill: 'var(--book-shelf)' }));
}

/** Compact architectural bookshelf illustration for the Library header in layouts A and C. */
export function shelfBooksArt({ width = 108, height = 44 } = {}) {
  return svgEl('svg', {
    class: 'shelf-art',
    width,
    height,
    viewBox: '0 0 108 44',
    'aria-hidden': 'true'
  },
  svgEl('rect', { x: '10', y: '10', width: '11', height: '28', rx: '2', fill: 'var(--book-moss-bg)' }),
  svgEl('rect', { x: '12', y: '14', width: '7', height: '1.2', rx: '.6', fill: 'var(--book-moss-fg)', opacity: '.55' }),
  svgEl('rect', { x: '23', y: '6', width: '12', height: '32', rx: '2', fill: 'var(--book-linen-bg)', stroke: 'var(--theme-line)', 'stroke-width': '.75' }),
  svgEl('path', { d: 'M27.5 6h3v9.5l-1.5-1.4-1.5 1.4z', fill: 'var(--book-ribbon)' }),
  svgEl('rect', { x: '37', y: '12', width: '10', height: '26', rx: '2', fill: 'var(--book-night-bg)' }),
  svgEl('rect', { x: '39', y: '16', width: '6', height: '1.2', rx: '.6', fill: 'var(--book-night-fg)', opacity: '.5' }),
  svgEl('rect', { x: '49', y: '8', width: '12', height: '30', rx: '2', fill: 'var(--book-sage-bg)' }),
  svgEl('rect', { x: '51', y: '12', width: '8', height: '1.2', rx: '.6', fill: 'var(--book-sage-fg)', opacity: '.45' }),
  svgEl('rect', { x: '63', y: '11', width: '11', height: '27', rx: '2', fill: 'var(--book-pine-bg)' }),
  svgEl('rect', { x: '78', y: '11', width: '10', height: '27', rx: '2', transform: 'rotate(13 83 38)', fill: 'var(--book-clay-bg)' }),
  svgEl('rect', { x: '4', y: '38', width: '100', height: '4', rx: '2', fill: 'var(--book-clay-bg)' }),
  svgEl('rect', { x: '4', y: '38', width: '100', height: '1.2', rx: '.6', fill: 'var(--book-shelf)', opacity: '.28' }));
}

/** Calm open-book & shelf illustration for empty states in layouts A and C. */
export function emptyBooksArt() {
  return svgEl('svg', {
    class: 'empty-books-art',
    width: '76',
    height: '52',
    viewBox: '0 0 76 52',
    'aria-hidden': 'true'
  },
  svgEl('path', { d: 'M12 14c0-2.2 1.8-4 4-4h18c2.2 0 4 1.8 4 4v26c0-1.6-1.4-3-3-3H14a2 2 0 0 1-2-2V14z', fill: 'var(--theme-active)', stroke: 'var(--theme-accent)', 'stroke-width': '1.5' }),
  svgEl('path', { d: 'M64 14c0-2.2-1.8-4-4-4H42c-2.2 0-4 1.8-4 4v26c0-1.6 1.4-3 3-3h21a2 2 0 0 0 2-2V14z', fill: 'var(--theme-paper)', stroke: 'var(--theme-accent)', 'stroke-width': '1.5' }),
  svgEl('path', { d: 'M46 10h4v12l-2-1.8-2 1.8z', fill: 'var(--book-ribbon)' }),
  svgEl('path', { d: 'M18 19h12M18 24h10M18 29h8', stroke: 'var(--theme-accent)', 'stroke-width': '1.4', 'stroke-linecap': 'round', opacity: '.55' }),
  svgEl('path', { d: 'M46 25h11M46 30h9', stroke: 'var(--theme-muted)', 'stroke-width': '1.4', 'stroke-linecap': 'round', opacity: '.45' }),
  svgEl('rect', { x: '6', y: '43', width: '64', height: '3.5', rx: '1.75', fill: 'var(--book-clay-bg)' }));
}

const MINI_PALETTES = [
  ['var(--book-moss-bg)', 'var(--book-moss-fg)'],
  ['var(--book-night-bg)', 'var(--book-night-fg)'],
  ['var(--book-pine-bg)', 'var(--book-pine-fg)'],
  ['var(--book-clay-bg)', 'var(--book-clay-fg)'],
  ['var(--book-sage-bg)', 'var(--book-sage-fg)'],
  ['var(--book-linen-bg)', 'var(--book-linen-fg)']
];

/** Tactile mini book cover for Sermon Detail header in layouts A and C. */
export function miniBookCover(swatchIndex) {
  const idx = Math.abs(Number(swatchIndex) || 0);
  const [bg, fg] = MINI_PALETTES[idx % MINI_PALETTES.length];
  const motifShapes = idx % 3 === 0
    ? [
      svgEl('circle', { cx: '42', cy: '48', r: '18', stroke: fg, 'stroke-width': '1.1', fill: 'none', opacity: '.32' }),
      svgEl('circle', { cx: '42', cy: '48', r: '11', stroke: fg, 'stroke-width': '1.1', fill: 'none', opacity: '.32' })
    ]
    : idx % 3 === 1
      ? [
        svgEl('path', { d: 'M8 58 Q 22 40 36 58 T 56 54', stroke: fg, 'stroke-width': '1.2', fill: 'none', opacity: '.35' }),
        svgEl('path', { d: 'M14 64 Q 28 48 44 64', stroke: fg, 'stroke-width': '1.2', fill: 'none', opacity: '.28' })
      ]
      : [
        svgEl('path', { d: 'M14 26h28M14 33h20M14 40h24', stroke: fg, 'stroke-width': '1.3', 'stroke-linecap': 'round', opacity: '.36' })
      ];
  return svgEl('svg', {
    class: 'detail-book-thumb',
    width: '54',
    height: '72',
    viewBox: '0 0 54 72',
    'aria-hidden': 'true'
  },
  svgEl('rect', { x: '1', y: '1', width: '52', height: '70', rx: '5', fill: bg }),
  svgEl('rect', { x: '1', y: '1', width: '6', height: '70', rx: '2', fill: '#000', opacity: '.12' }),
  svgEl('line', { x1: '7', y1: '15', x2: '53', y2: '15', stroke: fg, 'stroke-width': '.9', opacity: '.3' }),
  svgEl('path', { d: 'M14 1h5v11l-2.5-2-2.5 2z', fill: 'var(--book-ribbon)' }),
  ...motifShapes,
  svgEl('rect', { x: '49', y: '1', width: '4', height: '70', rx: '1', fill: '#fff', opacity: '.2' }));
}

export function coverArt(sermon) {
  const cover = coverFor(sermon);
  const first = sermon.scripture_references?.[0];
  return h('div', { class: `bookcover cover-${cover.palette} motif-${cover.motif}`, 'aria-hidden': 'true' },
    h('span', { class: 'cover-line' }),
    h('span', { class: 'cover-art' }, h('i'), h('i'), h('i')),
    h('span', { class: 'cover-edge' }),
    h('span', { class: 'cover-index' }, first ? first.toUpperCase() : null),
    h('span', { class: 'cover-series' }, sermon.series_name || sermon.title));
}

/** Decorative shelf for the hero. Pads with blank spines so an empty library still looks like a shelf. */
export function shelf(sermons) {
  const picks = sermons.slice(0, 7);
  const blanks = Math.max(0, 7 - picks.length);
  return h('div', { class: 'books-figure', 'aria-hidden': 'true' },
    h('div', { class: 'books-shelf' },
      ...picks.map(sermon => {
        const cover = coverFor(sermon);
        return h('div', { class: `book-spine cover-${cover.palette}`, style: { '--spine-height': cover.height + '%', '--tilt': cover.tilt + 'deg' } },
          h('i'), h('span', null, sermon.title.slice(0, 28)));
      }),
      ...Array.from({ length: blanks }, (_, i) => h('div', { class: `book-spine cover-${['sage', 'linen', 'moss'][i % 3]}`, style: { '--spine-height': (78 + i * 5) + '%', '--tilt': '0deg' } }, h('i')))),
    h('div', { class: 'shelf-base' }));
}
