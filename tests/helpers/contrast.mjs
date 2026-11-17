// WCAG 2.x contrast helpers for the CSS tests. Colours are read from the shipped stylesheet, so a palette
// edit that drops text below AA fails a test instead of waiting for a browser pass.

/** "#rgb", "#rrggbb" or "#rrggbbaa" to [r, g, b, a] with a in 0..1. */
export function hex(value) {
  let h = value.trim().replace('#', '');
  if (h.length === 3 || h.length === 4) h = [...h].map(c => c + c).join('');
  const n = i => parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
}

/** `top` painted over an opaque `base`. */
export const over = (top, base) => [0, 1, 2].map(i => top[i] * top[3] + base[i] * (1 - top[3]));

const channel = v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The declarations of the first top-level rule for `selector` (a rule that starts a line), as { property: value }. */
export function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\:]/g, '\\$&');
  const match = new RegExp(`^${escaped} \\{([^}]*)\\}`, 'm').exec(css);
  if (!match) throw new Error(`no top-level rule for ${selector}`);
  return Object.fromEntries(match[1].split(';').map(d => d.split(/:(.*)/s).map(x => x?.trim())).filter(([p, v]) => p && v));
}

/** Custom properties declared on :root, so `var(--muted)` can be resolved. */
export const variables = css => Object.fromEntries(Object.entries(rule(css, ':root')).filter(([name]) => name.startsWith('--')));
