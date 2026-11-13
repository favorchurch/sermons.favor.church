// Tiny element builder. All text goes through text nodes, so nothing from the API is ever
// parsed as HTML. Styles are set through the CSSOM (allowed by the CSP), never as attributes.
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'style') for (const [name, v] of Object.entries(value)) el.style.setProperty(name, String(v));
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

export const mount = (root, ...nodes) => root.replaceChildren(...nodes.flat(Infinity).filter(Boolean));

let counter = 0;
export const uid = prefix => `${prefix}-${++counter}`;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Where Tab should land to keep focus inside a dialog, or null to let the browser move it normally. */
export function wrapFocus(index, count, shift) {
  if (count === 0) return 0;
  if (shift && index <= 0) return count - 1;
  if (!shift && index === count - 1) return 0;
  return null;
}

/**
 * Modal dialog on the native <dialog> element: the page behind it is inert, Escape closes it
 * and focus returns to whatever opened it. Tab is also wrapped explicitly so focus cannot
 * leave the dialog in browsers that let it reach the address bar.
 */
export function openDialog({ title, body }) {
  const opener = document.activeElement;
  const titleId = uid('dialog-title');
  let dialog;
  const close = () => { if (dialog.open) dialog.close(); };
  dialog = h('dialog', { class: 'dialog', 'aria-labelledby': titleId },
    h('div', { class: 'dialog-head' },
      h('h2', { id: titleId }, title),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close dialog', onclick: close }, '×')),
    body);
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const items = [...dialog.querySelectorAll(FOCUSABLE)].filter(item => !item.closest('[hidden]'));
    const target = wrapFocus(items.indexOf(document.activeElement), items.length, event.shiftKey);
    if (target !== null) { event.preventDefault(); items[target]?.focus(); }
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (opener && typeof opener.focus === 'function' && opener.isConnected !== false) opener.focus();
  });
  document.body.append(dialog);
  dialog.showModal();
  const first = dialog.querySelector('[data-autofocus]') || dialog.querySelector(FOCUSABLE);
  first?.focus();
  return { close, dialog };
}

/** Labelled form control with a hint and an error slot wired up through aria-describedby. */
export function field({ label, name, type = 'text', value = '', hint = '', required = false, maxlength, multiline = false, rows = 4, children = null, autofocus = false }) {
  const id = uid('f-' + name);
  const hintId = hint ? id + '-hint' : null;
  const errorId = id + '-error';
  const props = {
    id, name, required, maxlength, 'aria-describedby': [hintId, errorId].filter(Boolean).join(' '),
    'data-autofocus': autofocus
  };
  const control = children
    ? h('select', props, children)
    : multiline
      ? h('textarea', { ...props, rows }, value)
      : h('input', { ...props, type, value });
  const error = h('p', { class: 'field-error', id: errorId, hidden: true });
  const wrapper = h('div', { class: 'field' },
    h('label', { for: id }, label, required ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null),
    control,
    hint ? h('p', { class: 'hint', id: hintId }, hint) : null,
    error);
  return {
    wrapper, control,
    setError(message) {
      error.textContent = message || '';
      if (message) { error.removeAttribute('hidden'); control.setAttribute('aria-invalid', 'true'); }
      else { error.setAttribute('hidden', ''); control.removeAttribute('aria-invalid'); }
    }
  };
}
