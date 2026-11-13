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
  async function request(method, path, body) {
    let response;
    try {
      response = await fetchImpl(path, {
        method,
        credentials: 'same-origin',
        headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body)
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
    patch: (path, body) => request('PATCH', path, body)
  };
}

const FIELD_LABELS = {
  title: 'title', series_name: 'series', description: 'description', tags: 'tags', scripture_references: 'Scripture references',
  preached_on: 'date', date_precision: 'date precision', occasion: 'occasion', place_id: 'place', version_id: 'version', display_name: 'place name', name: 'name'
};

/** Plain-language message for an ApiError. Only the status and a known code ever shape the text. */
export function describeError(error) {
  if (!(error instanceof ApiError)) return 'Something went wrong. Try again in a moment.';
  const { status, code, field } = error;
  if (status === 401) return 'Your session has ended. Sign in again to continue.';
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
