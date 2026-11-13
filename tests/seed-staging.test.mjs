// scripts/seed-staging.mjs against the in-memory D1 and the real request handler. Fictional data only, no network,
// no wrangler: the script's `exec` seam is backed by the same in-memory database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture, ids } from './helpers/library-fixture.mjs';
import * as seed from '../scripts/seed-staging.mjs';
import { extractReferences } from '../src/search/bible.ts';

const WRANGLER_JSONC = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const execFor = f => async sql => {
  if (/^\s*SELECT/i.test(sql)) return f.db.connection.prepare(sql).all().map(row => ({ ...row }));
  f.db.connection.exec(sql);
  return [];
};
const count = (f, sql) => Number(f.db.connection.prepare(sql).get().n);
const quiet = t => t.mock.method(console, 'log', () => {});

async function seeded() {
  const f = await fixture();
  const exec = execFor(f);
  const workspace = await seed.findWorkspace(exec, 'Private Alpha');
  const statements = seed.buildSeedStatements(workspace.id, workspace.ownerId, extractReferences);
  const run = () => exec(statements.join(';\n') + ';');
  return { f, exec, workspace, run };
}
const TABLES = ['sermons', 'sermon_versions', 'preaching_events', 'places', 'place_aliases', 'note_texts', 'note_reference_tokens', 'sermon_scripture_refs', 'audit_events', 'note_fts_docsize'];
const snapshot = f => JSON.stringify(TABLES.map(table => count(f, `SELECT COUNT(*) AS n FROM ${table}`)));

test('arguments: anything that could aim the script away from staging is refused', () => {
  for (const argv of [['--env', 'production', '--workspace', 'x'], ['--env=prod', '--workspace', 'x'], ['--remote', '--workspace', 'x'], ['--local', '--workspace', 'x'],
    ['--db', 'other', '--workspace', 'x'], ['-e', 'production', '--workspace', 'x'], ['--database-id', 'abc', '--workspace', 'x'], ['--bogus'], [], ['--workspace']]) {
    assert.throws(() => seed.parseArgs(argv), seed.SeedRefusal, argv.join(' '));
  }
  assert.deepEqual(seed.parseArgs(['--workspace', ' Some Archive ', '--env=staging', '--dry-run']), { workspace: 'Some Archive', dryRun: true, help: false });
});

test('config guard: wrangler.jsonc must still describe the staging database and origin', () => {
  seed.assertStagingConfig(WRANGLER_JSONC);
  assert.throws(() => seed.assertStagingConfig(WRANGLER_JSONC.replaceAll('sermon-bank-staging', 'sermon-bank-prod')), seed.SeedRefusal);
  // Any database id other than the pinned one is refused: all-zero, another real-looking id, and a wrong account.
  for (const other of ['00000000-0000-0000-0000-000000000000', '11111111-2222-4333-8444-555555555555', seed.STAGING_DATABASE_ID.toUpperCase().replace(/^9/, '8')]) {
    assert.throws(() => seed.assertStagingConfig(WRANGLER_JSONC.replace(seed.STAGING_DATABASE_ID, other)), seed.SeedRefusal, other);
  }
  assert.throws(() => seed.assertStagingConfig(WRANGLER_JSONC.replace(seed.STAGING_ACCOUNT_ID, '7eeeea8eb48ea2c7c3f17f4a54a7d3ca')), seed.SeedRefusal);
  // Structural edits, made on the parsed config so they cannot silently no-op.
  const mutated = change => { const config = JSON.parse(WRANGLER_JSONC); change(config); return JSON.stringify(config); };
  assert.throws(() => seed.assertStagingConfig(mutated(c => delete c.env.staging.account_id)), seed.SeedRefusal);
  assert.throws(() => seed.assertStagingConfig(mutated(c => delete c.env.staging)), seed.SeedRefusal);
  assert.throws(() => seed.assertStagingConfig(mutated(c => c.env.staging.d1_databases.unshift({ binding: 'OTHER', database_name: 'DB', database_id: '11111111-2222-4333-8444-555555555555' }))), seed.SeedRefusal);
  assert.throws(() => seed.assertStagingConfig(mutated(c => c.env.staging.d1_databases.push({ ...c.env.staging.d1_databases[0] }))), seed.SeedRefusal);
  assert.throws(() => seed.assertStagingConfig(mutated(c => { c.env.staging.d1_databases[0].binding = 'OTHER'; })), seed.SeedRefusal);
  assert.throws(() => seed.assertStagingConfig(mutated(c => { c.env.staging.d1_databases[0].database_id += ' '; })), seed.SeedRefusal);
  assert.throws(() => seed.assertStagingConfig(WRANGLER_JSONC.replace('sermons-preview.favor.church"', 'sermons.favor.church"')), seed.SeedRefusal);
  assert.throws(() => seed.assertStagingConfig('not json'), seed.SeedRefusal);
});

test('workspace lookup: exact name or id, never ambiguous, needs an active Owner', async () => {
  const f = await fixture();
  const exec = execFor(f);
  assert.equal((await seed.findWorkspace(exec, 'Private Alpha')).id, ids.w1);
  assert.equal((await seed.findWorkspace(exec, ids.w2)).ownerId, ids.owner2);
  await assert.rejects(seed.findWorkspace(exec, 'private'), seed.SeedRefusal);
  f.db.connection.exec(`INSERT INTO user_accounts(id,email_normalized,display_name) VALUES ('a0000000-0000-4000-8000-000000000099','third@example.test','third');
    INSERT INTO workspaces(id,name,owner_account_id) VALUES ('b0000000-0000-4000-8000-000000000099','Private Alpha','a0000000-0000-4000-8000-000000000099')`);
  await assert.rejects(seed.findWorkspace(exec, 'Private Alpha'), /share that name/);
  // The workspace row above has no owner membership at all.
  await assert.rejects(seed.findWorkspace(exec, 'b0000000-0000-4000-8000-000000000099'), /no active Owner/);
});

test('seeding is idempotent and writes every row the script owns', async () => {
  const { f, exec, workspace, run } = await seeded();
  const before = snapshot(f);
  await run();
  const first = snapshot(f);
  assert.notEqual(first, before);
  await run();
  assert.equal(snapshot(f), first);
  const present = await seed.countPresent(exec, workspace.id);
  assert.deepEqual({ ...present }, seed.expectedCounts(workspace.id));
  // Every multi-reference sermon keeps all of its references, in order, and the legacy column agrees.
  const table = seed.seedId(workspace.id, 'sermon:table');
  assert.deepEqual(f.db.connection.prepare('SELECT reference_text AS t FROM sermon_scripture_refs WHERE sermon_id = ? ORDER BY position').all(table).map(r => r.t), ['Exodus 16:1-18', 'John 6:35']);
  assert.equal(f.db.connection.prepare('SELECT scripture_passage AS p FROM sermons WHERE id = ?').get(table).p, 'Exodus 16:1-18; John 6:35');
  assert.equal(count(f, `SELECT COUNT(*) AS n FROM sermons WHERE id IN (SELECT id FROM sermons) AND tags_json = '["demo-data"]' AND workspace_id = '${ids.w1}'`), 10);
});

test('seeded notes are searchable through the real API and demo consent belongs to the Owner', async () => {
  const { f, workspace, run } = await seeded();
  await run();
  const reference = await f.call('GET', f.w('/search?q=' + encodeURIComponent('John 3:16')), 'viewer');
  assert.equal(reference.status, 200);
  assert.ok(reference.json.metadataMatches.some(m => m.sermon_title === 'For God So Loved'));
  assert.ok(reference.json.notesMatches.some(m => m.sermon_id === seed.seedId(workspace.id, 'sermon:well')));
  const phrase = await f.call('GET', f.w('/search?q=' + encodeURIComponent('grace is sufficient')), 'viewer');
  assert.equal(phrase.json.notesMatches.length, 1);
  assert.equal((await f.call('GET', f.w('/search?q=' + encodeURIComponent('sufficient grace')), 'viewer')).json.notesMatches.length, 0);
  const revoked = await f.call('GET', f.w(`/sermons/${seed.seedId(workspace.id, 'sermon:hope')}/find-in-notes?q=waiting`), 'viewer');
  const byLabel = Object.fromEntries(revoked.json.versions.map(v => [v.label, v]));
  assert.equal(byLabel['Original'].status, 'matched');
  assert.deepEqual([byLabel['2024 revision'].status, byLabel['2024 revision'].reason], ['not_searchable', 'revoked']);
  assert.equal(count(f, `SELECT COUNT(*) AS n FROM sermon_versions WHERE indexing_state = 'indexed' AND index_consent_by <> '${ids.owner}'`), 0);
});

test('re-running respects edits: renamed place keeps its events, revoked versions stay unindexed, merged places stay merged', async () => {
  const { f, workspace, run } = await seeded();
  await run();
  const nullPlaces = () => count(f, 'SELECT COUNT(*) AS n FROM preaching_events WHERE place_id IS NULL');
  const baseline = nullPlaces();
  // Rename a demo place (a rename leaves no alias) and delete its events: the re-created events still point at it.
  const riverbend = seed.seedId(workspace.id, 'place:riverbend');
  assert.equal((await f.call('PATCH', f.w(`/places/${riverbend}`), 'owner', { display_name: 'Renamed Chapel' })).status, 200);
  f.db.connection.prepare('DELETE FROM preaching_events WHERE place_id = ?').run(riverbend);
  await run();
  assert.equal(nullPlaces(), baseline);
  assert.ok(count(f, `SELECT COUNT(*) AS n FROM preaching_events WHERE place_id = '${riverbend}'`) > 0);
  assert.equal(count(f, `SELECT COUNT(*) AS n FROM places WHERE workspace_id = '${ids.w1}' AND display_name = 'Riverbend Chapel'`), 0);
  // Revoke a demo version (purging its text) and run again: it is not re-indexed.
  const grace = seed.seedId(workspace.id, 'version:grace:original');
  f.db.connection.exec(`DELETE FROM note_reference_tokens WHERE version_id = '${grace}'; DELETE FROM note_texts WHERE version_id = '${grace}'; UPDATE sermon_versions SET indexing_state = 'revoked' WHERE id = '${grace}'`);
  const afterRevoke = snapshot(f);
  await run();
  assert.equal(snapshot(f), afterRevoke);
  // Merge a demo place away and run again: it is not recreated.
  const short = seed.seedId(workspace.id, 'place:riverbend-short');
  assert.equal((await f.call('POST', f.w(`/places/${short}/merge`), 'owner', { target_place_id: riverbend })).status, 200);
  const afterMerge = snapshot(f);
  await run();
  assert.equal(snapshot(f), afterMerge);
});

test('main: dry run writes nothing, a run seeds, a second run adds nothing, and unapplied migrations stop it first', async t => {
  quiet(t);
  const f = await fixture();
  const exec = execFor(f);
  const before = snapshot(f);
  await seed.main(['--workspace', 'Private Alpha', '--dry-run'], exec);
  assert.equal(snapshot(f), before);
  await seed.main(['--workspace', 'Private Alpha'], exec);
  const seededState = snapshot(f);
  assert.notEqual(seededState, before);
  await seed.main(['--workspace', 'Private Alpha'], exec);
  assert.equal(snapshot(f), seededState);
  assert.ok(console.log.mock.calls.some(call => /Nothing new was added/.test(call.arguments[0])));
  const bare = await fixture();
  bare.db.connection.exec('DROP TABLE place_merges');
  await assert.rejects(seed.main(['--workspace', 'Private Alpha'], execFor(bare)), /missing migrations/);
  assert.equal(count(bare, 'SELECT COUNT(*) AS n FROM sermons WHERE tags_json LIKE \'%demo-data%\''), 0);
});

test('main: rows that clash with existing ones are reported instead of silently dropped', async t => {
  quiet(t);
  const f = await fixture();
  f.db.connection.exec(`INSERT INTO places(id,workspace_id,display_name) VALUES ('e0000000-0000-4000-8000-000000000077','${ids.w1}','Riverbend Chapel')`);
  await assert.rejects(seed.main(['--workspace', 'Private Alpha'], execFor(f)), /Some demo rows were not added \(places 3\/4\)/);
});
