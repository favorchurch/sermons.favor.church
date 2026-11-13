// "Join with a code": redeem the one-time invitation code an Owner or Admin handed over.
import { h, field } from '../dom.js';
import { ApiError, describeError } from '../api.js';

/** `join(token)` redeems the code and may throw an ApiError. */
export function joinForm({ join }) {
  const code = field({ label: 'Invitation code', name: 'token', required: true, maxlength: 80, hint: 'Sign in with the Google account the invitation was made for.' });
  const message = h('p', { class: 'form-error', role: 'alert', hidden: true });
  return h('form', {
    class: 'state-form join-form', novalidate: true,
    onsubmit: async event => {
      event.preventDefault();
      message.setAttribute('hidden', '');
      try {
        await join(code.control.value.trim());
      } catch (error) {
        message.textContent = error instanceof ApiError && [400, 404, 409].includes(error.status)
          ? 'That code does not work. It may be mistyped, expired, already used, or made for a different email address.'
          : describeError(error);
        message.removeAttribute('hidden');
      }
    }
  }, code.wrapper, message, h('button', { type: 'submit', class: 'btn' }, 'Join with code'));
}
