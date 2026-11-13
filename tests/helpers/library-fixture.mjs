// Two workspaces: w1 (owner, admin, editor, viewer) and w2 (its own owner). `outsider`
// has a session but no membership anywhere. Each workspace has one sermon, version,
// place and event so cross-workspace ids can be probed on every route.
import { handleRequest } from '../../src/auth/app.ts';
import { sha256, randomToken, SESSION_COOKIE } from '../../src/auth/security.ts';
import { DatabaseMock } from './d1.mjs';

export const origin = 'https://sermons.example.org';
const uuid = (group, n) => `${group}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const ids = {
  owner: uuid('a', 1), admin: uuid('a', 2), editor: uuid('a', 3), viewer: uuid('a', 4), outsider: uuid('a', 5), owner2: uuid('a', 6),
  w1: uuid('b', 1), w2: uuid('b', 2),
  sermon1: uuid('c', 1), sermon2: uuid('c', 2),
  version1: uuid('d', 1), version2: uuid('d', 2),
  place1: uuid('e', 1), place2: uuid('e', 2),
  event1: uuid('f', 1), event2: uuid('f', 2)
};
export const ROLES = ['owner', 'admin', 'editor', 'viewer'];

export async function fixture() {
  const db = new DatabaseMock();
  const accounts = [['owner', 'owner@example.test'], ['admin', 'admin@example.test'], ['editor', 'editor@example.test'],
    ['viewer', 'viewer@example.test'], ['outsider', 'outsider@example.test'], ['owner2', 'owner2@example.test']];
  for (const [key, email] of accounts) db.execute('INSERT INTO user_accounts(id,email_normalized,display_name) VALUES (?,?,?)', [ids[key], email, key]);
  db.execute('INSERT INTO workspaces(id,name,owner_account_id) VALUES (?,?,?),(?,?,?)', [ids.w1, 'Private Alpha', ids.owner, ids.w2, 'Private Beta', ids.owner2]);
  for (const [w, key, role] of [[ids.w1, 'owner', 'owner'], [ids.w1, 'admin', 'admin'], [ids.w1, 'editor', 'editor'], [ids.w1, 'viewer', 'viewer'], [ids.w2, 'owner2', 'owner']]) {
    db.execute('INSERT INTO workspace_memberships(workspace_id,account_id,role,accepted_at) VALUES (?,?,?,CURRENT_TIMESTAMP)', [w, ids[key], role]);
  }
  db.execute(`INSERT INTO sermons(id,workspace_id,title,scripture_passage) VALUES (?,?,?,?),(?,?,?,?)`,
    [ids.sermon1, ids.w1, 'Alpha Hope Sermon', 'John 3:16', ids.sermon2, ids.w2, 'Beta Secret Sermon', 'Psalm 23']);
  db.execute(`INSERT INTO sermon_scripture_refs(workspace_id,sermon_id,position,reference_text) VALUES (?,?,0,?),(?,?,0,?)`,
    [ids.w1, ids.sermon1, 'John 3:16', ids.w2, ids.sermon2, 'Psalm 23']);
  db.execute(`INSERT INTO sermon_versions(id,workspace_id,sermon_id,label,source_type,google_document_id) VALUES (?,?,?,?,?,?),(?,?,?,?,?,?)`,
    [ids.version1, ids.w1, ids.sermon1, 'Original Alpha', 'google_doc', 'alphaDocId0001', ids.version2, ids.w2, ids.sermon2, 'Original Beta', 'google_doc', 'betaDocId00002']);
  db.execute(`INSERT INTO places(id,workspace_id,display_name) VALUES (?,?,?),(?,?,?)`, [ids.place1, ids.w1, 'Harbor Chapel', ids.place2, ids.w2, 'Beta Chapel']);
  db.execute(`INSERT INTO preaching_events(id,workspace_id,sermon_id,version_id,place_id,preached_on,date_precision) VALUES (?,?,?,?,?,?,?),(?,?,?,?,?,?,?)`,
    [ids.event1, ids.w1, ids.sermon1, ids.version1, ids.place1, '2025-03-09', 'exact', ids.event2, ids.w2, ids.sermon2, ids.version2, ids.place2, '2025-03-09', 'exact']);
  const env = { DB: db, PUBLIC_ORIGIN: origin, GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fake-unit-secret', PILOT_OWNER_EMAILS: 'owner@example.test' };
  const tokens = {};
  for (const [key] of accounts) {
    tokens[key] = randomToken();
    db.execute('INSERT INTO auth_sessions(token_hash,account_id,expires_at) VALUES (?,?,?)', [await sha256(tokens[key]), ids[key], Math.floor(Date.now() / 1000) + 86400]);
  }
  const request = (method, path, actor, body, headers = {}) => new Request(origin + path, {
    method,
    headers: {
      ...(actor ? { cookie: SESSION_COOKIE + '=' + tokens[actor] } : {}),
      ...(method === 'GET' ? {} : { origin, 'content-type': 'application/json' }),
      ...headers
    },
    body: method === 'GET' || body === undefined ? undefined : JSON.stringify(body)
  });
  /** Send a request and return { status, body (parsed or raw text), text }. */
  const call = async (method, path, actor, body, headers) => {
    const response = await handleRequest(request(method, path, actor, body, headers), env);
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    return { status: response.status, json, text, headers: response.headers };
  };
  const auditActions = () => db.query('SELECT action FROM audit_events ORDER BY rowid').map(row => row.action);
  return { env, db, tokens, request, call, auditActions, w: path => `/api/workspaces/${ids.w1}${path}` };
}
