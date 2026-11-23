export const LAYOUTS = ['a', 'c', 'original'];
export const DEFAULT_LAYOUT = 'a';
export const LAYOUT_COOKIE = 'sb_layout';
export const LAYOUT_LABELS = { a: 'Default (side rail)', c: 'Top bar', original: 'Original' };
export const isLayout = value => LAYOUTS.includes(value);

export function readLayoutCookie(cookieString) {
  let raw = cookieString;
  if (raw === undefined) {
    try { raw = globalThis.document?.cookie; } catch { return DEFAULT_LAYOUT; }
  }
  if (typeof raw !== 'string' || !raw) return DEFAULT_LAYOUT;
  let found = null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== LAYOUT_COOKIE) continue;
    if (found !== null) return DEFAULT_LAYOUT;
    let value = part.slice(eq + 1).trim();
    try { value = decodeURIComponent(value); } catch { return DEFAULT_LAYOUT; }
    found = value;
  }
  return found !== null && isLayout(found) ? found : DEFAULT_LAYOUT;
}

export function applyLayout(value) {
  if (isLayout(value)) globalThis.document?.documentElement?.setAttribute('data-layout', value);
}

export function initLayout(cookieString) {
  const layout = readLayoutCookie(cookieString);
  applyLayout(layout);
  return layout;
}
