#!/usr/bin/env node
// Create a login session in the LOCAL wrangler D1 database only, so the authenticated API
// can be exercised from curl without a Google sign-in. The Worker gains no bypass: this
// inserts an ordinary hashed auth_sessions row, exactly what a real sign-in would create.
//
//   node scripts/dev-session.mjs --email you@example.test [--workspace "Name"] [--ttl-hours 8]
//
// Refused by design: --remote, --preview, --env/-e, --db other than the local database,
// --database-id, --config, --persist-to and any unknown argument.
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const LOCAL_DB = 'sermon-bank-local';
export const LOCAL_ORIGIN = 'https://localhost:8787';
const FLAGS = new Set(['--email', '--workspace', '--ttl-hours', '--db', '--help']);
const REMOTE_FLAGS = new Set(['--remote', '--preview', '--env', '-e', '--database-id', '--config', '-c', '--persist-to', '--local']);
const EMAIL = /^[a-z0-9._+-]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const WORKSPACE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._'-]{2,119}$/;

export class DevSessionRefusal extends Error {}

export function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].startsWith('--') && argv[i].includes('=') ? [argv[i].slice(0, argv[i].indexOf('=')), argv[i].slice(argv[i].indexOf('=') + 1)] : [argv[i], undefined];
    if (REMOTE_FLAGS.has(flag)) throw new DevSessionRefusal(`Refusing ${flag}: this script only writes to the local D1 database "${LOCAL_DB}".`);
    if (!FLAGS.has(flag)) throw new DevSessionRefusal(`Unknown argument "${flag}". Allowed: --email, --workspace, --ttl-hours.`);
    if (flag === '--help') { values.help = true; continue; }
    const value = inline ?? argv[++i];
    if (value === undefined || value.startsWith('--')) throw new DevSessionRefusal(`${flag} needs a value.`);
    values[flag.slice(2)] = value;
  }
  if (values.help) return { help: true };
  if (values.db !== undefined && values.db !== LOCAL_DB) throw new DevSessionRefusal(`Refusing --db "${values.db}": only "${LOCAL_DB}" is allowed.`);
  const email = String(values.email ?? '').trim().toLowerCase();
  if (!EMAIL.test(email)) throw new DevSessionRefusal('--email is required and must be a plain address like dev@example.test.');
  if (values.workspace !== undefined && !WORKSPACE_NAME.test(values.workspace)) {
    throw new DevSessionRefusal('--workspace must be 3-120 characters: letters, digits, spaces and . _ \' -');
  }
  const ttlHours = values['ttl-hours'] === undefined ? 8 : Number(values['ttl-hours']);
  if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > 168) throw new DevSessionRefusal('--ttl-hours must be a whole number from 1 to 168.');
  return { email, workspace: values.workspace ?? null, ttlHours };
}

const quote = text => `'${String(text).replaceAll("'", "''")}'`;

/** Pure: turns arguments into the SQL to run and the one-time token. Never touches a database. */
export function planDevSession(argv, now = Date.now()) {
  const args = parseArgs(argv);
  if (args.help) return args;
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('base64url');
  const expiresAt = Math.floor(now / 1000) + args.ttlHours * 3600;
  const email = quote(args.email);
  const statements = [
    `INSERT OR IGNORE INTO user_accounts(id, email_normalized, display_name) VALUES (${quote(randomUUID())}, ${email}, ${quote(args.email.split('@')[0])})`
  ];
  if (args.workspace) {
    statements.push(
      `INSERT INTO workspaces(id, name, owner_account_id) SELECT ${quote(randomUUID())}, ${quote(args.workspace)}, a.id FROM user_accounts a
        WHERE a.email_normalized = ${email} AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.owner_account_id = a.id AND w.deleted_at IS NULL)`,
      `INSERT OR IGNORE INTO workspace_memberships(workspace_id, account_id, role, accepted_at)
        SELECT w.id, a.id, 'owner', CURRENT_TIMESTAMP FROM user_accounts a
        JOIN workspaces w ON w.owner_account_id = a.id AND w.deleted_at IS NULL WHERE a.email_normalized = ${email}`
    );
  }
  statements.push(
    `INSERT INTO auth_sessions(token_hash, account_id, expires_at) SELECT ${quote(tokenHash)}, a.id, ${expiresAt}
      FROM user_accounts a WHERE a.email_normalized = ${email} AND a.disabled_at IS NULL`
  );
  return { ...args, token, expiresAt, sql: statements.join(';\n') + ';' };
}

function usage(plan) {
  return `Local session created for ${plan.email} (expires in ${plan.ttlHours}h).

Session token (shown once, local database only):
  ${plan.token}

The Worker only serves HTTPS on its configured PUBLIC_ORIGIN, so run it with a local HTTPS origin:
  pnpm run migrate:local          # once, applies migrations to the local D1
  pnpm exec wrangler dev --local --local-protocol https --var PUBLIC_ORIGIN:${LOCAL_ORIGIN}

Then call the API with the cookie (-k accepts wrangler's self-signed certificate):
  curl -k -H 'cookie: __Host-sb_session=${plan.token}' ${LOCAL_ORIGIN}/api/workspaces
Mutations also need a same-origin header and a JSON body:
  curl -k -X POST -H 'cookie: __Host-sb_session=${plan.token}' -H 'origin: ${LOCAL_ORIGIN}' \\
    -H 'content-type: application/json' -d '{"title":"Test"}' ${LOCAL_ORIGIN}/api/workspaces/<workspace-id>/sermons
`;
}

function main() {
  let plan;
  try { plan = planDevSession(process.argv.slice(2)); } catch (error) {
    if (error instanceof DevSessionRefusal) { console.error(error.message); process.exit(2); }
    throw error;
  }
  if (plan.help) { console.log('Usage: node scripts/dev-session.mjs --email you@example.test [--workspace "Name"] [--ttl-hours 8]'); return; }
  // Drop Cloudflare credentials and environment selectors so this cannot reach a remote account.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLOUDFLARE_|CF_|WRANGLER_)/.test(key)));
  execFileSync('pnpm', ['exec', 'wrangler', 'd1', 'execute', LOCAL_DB, '--local', '--command', plan.sql.replace(/\s*\n\s*/g, ' ')], { stdio: ['ignore', 'ignore', 'inherit'], env });
  console.log(usage(plan));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
