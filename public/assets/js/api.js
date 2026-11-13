// Thin same-origin JSON client. Errors carry only the status, the server's error code and
// the offending field name. Server text is never shown to people, so nothing sensitive can leak into the UI.
export class ApiError extends Error {
  constructor(status, code = 'error', field = null) {
    super(code);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

export function createApi({ fetchImpl = (...args) => fetch(...args) } = {}) {
  async function request(method, path, body, rawType) {
    let response;
    try {
      response = await fetchImpl(path, {
        method,
        credentials: 'same-origin',
        headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': rawType || 'application/json' }) },
        body: body === undefined ? undefined : rawType ? body : JSON.stringify(body)
      });
    } catch {
      throw new ApiError(0, 'network');
    }
    let data = null;
    try { data = await response.json(); } catch { /* empty or non-JSON body */ }
    if (!response.ok) throw new ApiError(response.status, typeof data?.error === 'string' ? data.error : 'error', typeof data?.field === 'string' ? data.field : null);
    return data;
  }
  return {
    get: path => request('GET', path),
    post: (path, body) => request('POST', path, body ?? {}),
    patch: (path, body) => request('PATCH', path, body),
    /** Raw bytes (a File or ArrayBuffer), for PDF upload. */
    postBinary: (path, body, contentType) => request('POST', path, body, contentType)
  };
}

const FIELD_LABELS = {
  title: 'title', series_name: 'series', description: 'description', tags: 'tags', scripture_references: 'Scripture references',
  preached_on: 'date', date_precision: 'date precision', occasion: 'occasion', place_id: 'place', version_id: 'version', display_name: 'place name', name: 'name',
  q: 'search', label: 'version name', target_place_id: 'place to merge into', email: 'email', role: 'role'
};

// Fixed text for the codes the Settings screens can meet. Anything unknown falls back to the status text.
const CODE_TEXT = {
  invite_limit_reached: 'This archive has reached its limit of 20 invitations a day. Try again tomorrow.',
  invalid_invitation: 'Check the email address and role, then try again.',
  invalid_membership_change: 'That role change is not allowed.',
  membership_changed: 'That person’s access changed while you were working. Reload and try again.',
  invalid_row_state: 'That row changed while you were working. Reload the list and try again.',
  not_a_pdf: 'That file is not a PDF.',
  unsupported_media_type: 'That file is not a PDF.',
  too_large: 'That file is over the size limit.',
  pdf_already_uploaded: 'This version already has a file. Add a new version to use a different one.',
  not_pdf_version: 'Only PDF versions can hold an uploaded file.',
  not_awaiting_consent: 'This version is not waiting for consent any more. Reload and try again.',
  nothing_to_revoke: 'There is nothing to revoke for this version.',
  state_changed: 'This version changed while you were working. Reload and try again.',
  revoked: 'Access to this version has been revoked.',
  place_changed: 'That place changed while you were working. Reload and try again.',
  label_in_use: 'This sermon already has a version with that name.',
  source_locked: 'This version’s source can no longer be changed.'
};

/** Plain-language message for an ApiError. Only the status and a known code ever shape the text. */
export function describeError(error) {
  if (!(error instanceof ApiError)) return 'Something went wrong. Try again in a moment.';
  const { status, code, field } = error;
  if (status === 401) return 'Your session has ended. Sign in again to continue.';
  if (Object.hasOwn(CODE_TEXT, code) && (status !== 400 || field === null)) return CODE_TEXT[code];
  if (status === 413) return CODE_TEXT.too_large;
  if (status === 415) return CODE_TEXT.not_a_pdf;
  if (status === 403) return 'You don’t have permission to change this archive.';
  if (status === 404) return 'That item no longer exists, or you don’t have access to it.';
  if (status === 400) {
    const label = FIELD_LABELS[field];
    if (code === 'precision_mismatch') return 'The date doesn’t match the precision you chose.';
    return label ? `Check the ${label} and try again.` : 'Check what you entered and try again.';
  }
  if (status === 409) {
    if (code === 'already_archived') return 'That sermon is already archived.';
    if (code === 'not_archived') return 'That sermon is not archived.';
    if (code === 'name_in_use' || code === 'name_taken') return 'That name is already in use.';
    return 'That changed while you were working. Reload and try again.';
  }
  if (status === 429) return 'Too many requests. Wait a moment and try again.';
  return 'Something went wrong on our side. Try again in a moment.';
}
