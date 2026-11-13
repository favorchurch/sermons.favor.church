// Cover art: spines for the hero shelf and illustrated covers for the grid. Both are built
// from CSS only and are decorative (aria-hidden), the real content is the text beside them.
import { h } from '../dom.js';
import { coverFor } from '../covers.js';

export function coverArt(sermon) {
  const cover = coverFor(sermon);
  const first = sermon.scripture_references?.[0];
  return h('div', { class: `bookcover cover-${cover.palette} motif-${cover.motif}`, 'aria-hidden': 'true' },
    h('span', { class: 'cover-line' }),
    h('span', { class: 'cover-art' }, h('i'), h('i'), h('i')),
    h('span', { class: 'cover-edge' }),
    h('span', { class: 'cover-index' }, first ? first.toUpperCase() : 'SERMON'),
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
