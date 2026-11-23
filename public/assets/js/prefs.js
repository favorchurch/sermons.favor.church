// View preferences that follow the person. localStorage paints the first frame, the account is the
// source of truth once /api/me answers, and every change is written to both. A change the account
// could not take (offline, a server error) stays "pending" and is sent again on the next load or
// when the browser comes back online.
import { ApiError } from './api.js';
import { isLayout, initLayout, applyLayout } from './layout.js';
import { SCOPES, VIEWS } from './router.js';
import { SORTS } from './library-model.js';

export const PREFS_KEY = 'sb_prefs';

const oneOf = list => value => list.includes(value);
const text = max => value => typeof value === 'string' && value.length > 0 && value.length <= max;
// The same allow-list the server enforces on PATCH /api/me, plus the layout, which has its own field there.
const VALID = {
  layout: isLayout,
  libraryView: oneOf(VIEWS),
  sort: oneOf(SORTS.map(([key]) => key)),
  archive: oneOf(['active', 'archived']),
  series: text(200),
  searchScope: oneOf(SCOPES.map(([key]) => key)),
  workspaceId: text(64)
};
const KEYS = Object.keys(VALID);
const accept = (key, value) => Object.hasOwn(VALID, key) && VALID[key](value);
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

/** What localStorage holds, or nothing at all when storage throws or holds something unusable. */
function readLocal(storage) {
  const local = { account: null, values: {}, pending: new Set() };
  let parsed;
  try { parsed = JSON.parse(storage?.getItem(PREFS_KEY) ?? 'null'); } catch { return local; }
  if (!isObject(parsed)) return local;
  if (typeof parsed.account === 'string') local.account = parsed.account;
  if (isObject(parsed.values)) {
    for (const key of KEYS) if (Object.hasOwn(parsed.values, key) && accept(key, parsed.values[key])) local.values[key] = parsed.values[key];
  }
  if (Array.isArray(parsed.pending)) {
    for (const key of parsed.pending) if (typeof key === 'string' && Object.hasOwn(local.values, key)) local.pending.add(key);
  }
  return local;
}

/**
 * storage: a Storage-like object (getItem/setItem) or null. api: the same-origin client.
 * win: an event target that fires "online".
 */
export function createPrefs({ storage = null, api, win = null } = {}) {
  const local = readLocal(storage);
  const values = local.values;
  const pending = local.pending;
  let account = local.account;
  // What the account is known to hold, so a change it refuses can go back to it.
  const synced = {};
  for (const key of Object.keys(values)) if (!pending.has(key)) synced[key] = values[key];

  function persist() {
    try { storage?.setItem(PREFS_KEY, JSON.stringify({ account, values, pending: [...pending] })); } catch { /* storage unavailable: the choice still goes to the account */ }
  }

  async function sendPending() {
    const keys = [...pending];
    if (!keys.length) return { ok: true };
    const sent = Object.fromEntries(keys.map(key => [key, values[key]]));
    const body = {};
    if (keys.includes('layout')) body.layout = sent.layout;
    const rest = keys.filter(key => key !== 'layout');
    if (rest.length) body.prefs = Object.fromEntries(rest.map(key => [key, sent[key]]));
    let result;
    try {
      result = await api.patch('/api/me', body);
    } catch (error) {
      // A 400 means the account will never take this value, so retrying is pointless: go back to what it holds.
      if (!(error instanceof ApiError) || error.status !== 400) return { ok: false, rejected: false, error };
      for (const key of keys) {
        if (values[key] !== sent[key]) continue;
        pending.delete(key);
        if (Object.hasOwn(synced, key)) values[key] = synced[key]; else delete values[key];
      }
      persist();
      return { ok: false, rejected: true, error };
    }
    for (const key of keys) {
      synced[key] = sent[key];
      if (values[key] === sent[key]) pending.delete(key); // changed again while this was in flight: still pending
    }
    persist();
    return { ok: true, result };
  }

  // Sends run one at a time, the first at once. Changes made while one is in flight share the next send.
  let inFlight = null;
  let queued = null;
  function flush() {
    if (!inFlight) {
      inFlight = sendPending().finally(() => { inFlight = null; });
      return inFlight;
    }
    queued ||= inFlight.then(() => { queued = null; return flush(); });
    return queued;
  }

  win?.addEventListener?.('online', () => { flush(); });

  return {
    get: key => values[key],
    pendingKeys: () => [...pending],
    flush,

    /** Applies the saved layout (else the cookie's) to the page and reports what the first render needs. */
    boot() {
      const layout = isLayout(values.layout) ? values.layout : initLayout();
      applyLayout(layout);
      return { layout, libraryView: values.libraryView ?? 'covers' };
    },

    /**
     * Saves choices now and sends them to the account. Resolves { ok, result? } or { ok: false, rejected, error },
     * and never rejects. Values the account cannot hold are ignored.
     */
    set(changes) {
      let changed = false;
      for (const [key, value] of Object.entries(changes)) {
        if (!accept(key, value) || (values[key] === value && !pending.has(key))) continue;
        values[key] = value;
        pending.add(key);
        changed = true;
      }
      if (!changed) return Promise.resolve({ ok: true });
      persist();
      return flush();
    },

    /** Takes in the account from /api/me. The account wins, except for choices still waiting to be sent. */
    merge(remote) {
      const id = typeof remote?.id === 'string' ? remote.id : null;
      if (id && account && account !== id) { // another person used this browser: their choices are not these
        for (const store of [values, synced]) for (const key of Object.keys(store)) delete store[key];
        pending.clear();
      }
      if (id) account = id;
      const theirs = isObject(remote?.prefs) ? remote.prefs : {};
      for (const key of KEYS) {
        if (pending.has(key)) continue;
        const value = key === 'layout' ? remote?.layout : Object.hasOwn(theirs, key) ? theirs[key] : undefined;
        if (accept(key, value)) { values[key] = value; synced[key] = value; } else { delete values[key]; delete synced[key]; }
      }
      persist();
    }
  };
}
