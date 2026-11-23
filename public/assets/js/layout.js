export const LAYOUTS = ['a', 'c', 'original'];
export const LAYOUT_LABELS = { a: 'Default (side rail)', c: 'Top bar', original: 'Original' };
export const isLayout = value => LAYOUTS.includes(value);

export function applyLayout(value) {
  if (isLayout(value)) globalThis.document?.documentElement?.setAttribute('data-layout', value);
}
