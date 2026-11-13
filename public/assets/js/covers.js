// Deterministic cover art: the same sermon id always gets the same palette and motif.
export const PALETTES = ['moss', 'linen', 'night', 'sage', 'clay', 'pine', 'paper'];
export const MOTIFS = ['rings', 'rays', 'hills', 'waves'];

export function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function coverFor(sermon) {
  const h = hash(String(sermon.id));
  return {
    palette: PALETTES[h % PALETTES.length],
    motif: MOTIFS[(h >>> 8) % MOTIFS.length],
    height: 76 + ((h >>> 16) % 25),
    tilt: ((h >>> 24) % 9) - 4
  };
}
