#!/usr/bin/env node
/**
 * Seed fictional demo data into ONE staging workspace so the pilot can be reviewed with something to look at.
 *
 *   pnpm seed:staging --workspace "<workspace name or id>" [--dry-run]
 *
 * - Writes only to the STAGING D1 (`wrangler d1 execute --env staging --remote`) and only into the workspace
 *   named on the command line. It never creates a workspace, account, session or membership.
 * - Refuses any other environment (`--env` other than staging, `--local`, `--remote`, `--preview`, `--db`,
 *   `--database-id`, `--config`, `--persist-to`) and any unknown argument. It also refuses to run if
 *   wrangler.jsonc's staging block no longer points at the staging D1 database and origin.
 * - Idempotent: every row has an id derived from the workspace id and a fixed key, and every statement is an
 *   INSERT OR IGNORE or a guarded INSERT ... SELECT. Running it again adds nothing, and it never overwrites a
 *   demo row someone has edited, never re-indexes a version whose consent was revoked and never recreates a
 *   place that was merged away.
 * - Everything is fictional: invented sermons, notes, places and dates. Demo sermons carry the tag `demo-data`.
 * - Note text is stored the way src/search/index.ts stores it (text, full-text row via trigger, reference
 *   tokens from src/search/bible.ts), with consent attributed to the workspace's active Owner. No PDF objects
 *   are created in R2, so PDF demo versions are left without a file for you to upload one.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = new URL('..', import.meta.url).pathname;
const WRANGLER = join(ROOT, 'node_modules', '.bin', 'wrangler');
export const STAGING_DATABASE = 'sermon-bank-staging';
export const STAGING_HOST = 'sermons-preview.favor.church';
export const DEMO_TAG = 'demo-data';
const SEED_VERSION = 'v1';
const REFUSED_FLAGS = new Set(['--remote', '--local', '--preview', '--db', '--database-id', '--config', '-c', '--persist-to', '-e']);

export class SeedRefusal extends Error {}

/** Pure: flags to settings. Anything that could aim the script elsewhere is refused. */
export function parseArgs(argv) {
  const out = { workspace: null, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const eq = argv[i].startsWith('--') ? argv[i].indexOf('=') : -1;
    const flag = eq < 0 ? argv[i] : argv[i].slice(0, eq);
    const inline = eq < 0 ? undefined : argv[i].slice(eq + 1);
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined || v.startsWith('--')) throw new SeedRefusal(`${flag} needs a value.`);
      return v;
    };
    if (flag === '--help') out.help = true;
    else if (flag === '--dry-run') out.dryRun = true;
    else if (flag === '--workspace') out.workspace = value().trim();
    else if (flag === '--env') {
      const env = value();
      if (env !== 'staging') throw new SeedRefusal(`Refusing --env ${env}: this script only seeds the staging environment.`);
    } else if (REFUSED_FLAGS.has(flag)) throw new SeedRefusal(`Refusing ${flag}: this script always writes to the staging D1 remote and takes no other target.`);
    else throw new SeedRefusal(`Unknown argument "${flag}". Allowed: --workspace, --env staging, --dry-run.`);
  }
  if (!out.help && !out.workspace) throw new SeedRefusal('--workspace "<name or id>" is required: say which staging workspace to seed.');
  return out;
}

/** wrangler.jsonc must still describe staging as the staging database and origin, or nothing is written. */
export function assertStagingConfig(text) {
  let config;
  try { config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')); } catch { throw new SeedRefusal('Cannot read wrangler.jsonc; refusing to write.'); }
  const staging = config?.env?.staging;
  const database = staging?.d1_databases?.find(d => d.binding === 'DB');
  if (database?.database_name !== STAGING_DATABASE || !database.database_id || /^0+(-0+)*$/.test(database.database_id) ||
      new URL(staging?.vars?.PUBLIC_ORIGIN ?? 'https://invalid.invalid').host !== STAGING_HOST) {
    throw new SeedRefusal(`wrangler.jsonc env.staging no longer points at ${STAGING_DATABASE} / ${STAGING_HOST}; refusing to write.`);
  }
}

// ---------- fictional content ----------
const PLACES = [
  { key: 'riverbend', name: 'Riverbend Chapel' },
  { key: 'riverbend-short', name: 'Riverbend' }, // a near-duplicate, so the merge preview has something to show
  { key: 'lakeside', name: 'Lakeside Hall', aliases: ['Lakeside'] },
  { key: 'hilltop', name: 'Hilltop Community Center' }
];

const NOTES = {
  grace: `Opening. Paul asks three times for the thorn to be removed and hears one answer: "My grace is sufficient for you" (2 Corinthians 12:9). Grace is not a reward for strength. It arrives where strength runs out.
Point one: weakness is not a disqualification. Gideon, Moses and Ruth all began from a place they would not have chosen. Compare Philippians 4:13, which is about contentment, not winning.
Point two: sufficient does not mean easy. The daily bread of Exodus 16 came one morning at a time and could not be stored. Grace for today is for today.
Point three: boast in what you cannot fix. Strength shared is a gift to the room, and weakness shared is how a room becomes a family.
Closing question for the table: where are you asking for the thorn to be removed, and what would it look like to receive grace there instead?`,
  water: `Opening. The boat is already far from land and the wind is against it. Jesus comes to them in the fourth watch of the night, walking on the sea (Matthew 14:25).
Point one: Peter asks for the invitation before he steps out. "Lord, if it is you, command me to come to you on the water" (Matthew 14:28). Faith here is a response to a word, not a stunt.
Point two: he sinks when he looks at the wind. Notice that Jesus catches him at once and does not wait for him to be embarrassed enough.
Point three: the boat worships at the end. The ones who stayed put were not lesser, they were present.
Story: a lighthouse keeper on a small island who kept a lamp lit for boats that never came. Some years later one did.
Reference for further reading: Psalm 107:23-30.`,
  shepherd: `Opening. Psalm 23 is read at funerals and sung at weddings because it holds both. The shepherd is not only a guide. The shepherd stays.
Verse by verse: green pastures and still waters are the rest he provides, the valley of the shadow is the place he walks beside us, the table is set in front of those who trouble us.
Cross reference: John 10:11, "I am the good shepherd." The good shepherd lays down his life, so staying is costly.
Application one: name a valley you are in this week and say out loud that you are not walking it alone.
Application two: who in the congregation needs someone to stay? Sit with them. Do not fix it.
Prayer: Lord, you stay. Teach us to stay with one another.`,
  love: `Opening. First Corinthians 13 is the most quoted chapter nobody finishes reading. It was written to a church full of gifted, divided people.
Point one: gifts without love are noise. A gong and a cymbal can be heard across a room and warm no one.
Point two: love is patient and kind, and the list is practical. It does not keep a record of wrongs (1 Corinthians 13:5). Keeping score is the opposite of forgiving.
Point three: love is what remains. "Faith, hope and love abide, and the greatest of these is love" (1 Corinthians 13:13).
Exercise: write down the last three scores you were keeping. Burn the page together at the end of the service in the fire bowl outside.
Look ahead to Romans 12:9-18 for what this looks like on an ordinary Monday.`,
  well: `Opening. A woman comes to a well at noon, the hour when nobody else is there. Jesus is already sitting at it (John 4:6).
Point one: he crosses every line of the day to be there, speaking to a Samaritan and a woman. Mercy goes first to the person we planned to avoid.
Point two: he tells her what she has done and does not leave. Truth and mercy arrive in the same sentence.
Point three: she leaves her water jar. She runs back to the town that shunned her and becomes the first preacher in the chapter.
Cross reference: compare John 3:16, "God so loved the world", spoken at night to a teacher. The same love is spoken at noon to an outcast.
Closing: who is at your well at noon?`,
  hope: `Opening. Romans 8 does not say that all things are good. It says that God works in all things for the good of those who love him (Romans 8:28).
Point one: creation groans and so do we. Waiting is not weakness, it is the posture of people who expect something (Romans 8:23-25).
Point two: the Spirit prays when we cannot. Some seasons the best prayer is a sigh, and it is heard.
Point three: nothing separates us. Read Romans 8:38-39 slowly, with the lights low.
Application: choose one waiting room in your life, whether a diagnosis, a job or a reconciliation, and pray the groaning prayer there every morning for a week.`,
  table: `Opening. In the wilderness of Sin the people complain about hunger and God answers with bread. Exodus 16:4 says it rains from heaven, enough for the day.
Point one: manna is not a stockpile. Anything saved overnight spoiled, except on the sixth day. God teaches trust by teaching rhythm.
Point two: the bread points to a person. "I am the bread of life" (John 6:35).
Point three: the table is a place of belonging. Whoever comes is fed and nobody is counted.
Practical: this month we will bring a dish to share and keep one chair empty for whoever walks in.`
};

// Each sermon shows a different state: indexed notes, notes not indexed, revoked, archived, PDF with no file yet.
const SERMONS = [
  { key: 'grace', title: 'Grace Enough for Today', refs: ['2 Corinthians 12:7-10'], series: 'Enough', created: '2026-09-01 09:00:00',
    description: 'A short series opener on weakness and sufficiency.',
    versions: [
      { key: 'original', label: 'Original', type: 'google_doc', doc: 'demo-doc-grace-original', notes: 'grace' },
      { key: 'short', label: 'Short edit', type: 'google_doc', doc: 'demo-doc-grace-short-edit' }
    ] },
  { key: 'water', title: 'Walking on Water', refs: ['Matthew 14:22-33'], series: 'Enough', created: '2026-09-08 09:00:00',
    versions: [{ key: 'original', label: 'Original', type: 'google_doc', doc: 'demo-doc-water-original', notes: 'water' }] },
  { key: 'shepherd', title: 'The Shepherd Who Stays', refs: ['Psalm 23'], created: '2026-08-04 09:00:00',
    versions: [
      { key: 'original', label: 'Original', type: 'google_doc', doc: 'demo-doc-shepherd-original', notes: 'shepherd' },
      { key: 'handout', label: 'Printed handout', type: 'pdf' }
    ] },
  { key: 'love', title: 'Love That Does Not Keep Score', refs: ['1 Corinthians 13:1-13'], series: 'Everyday Love', created: '2026-07-14 09:00:00',
    versions: [{ key: 'original', label: 'Original', type: 'google_doc', doc: 'demo-doc-love-original', notes: 'love' }] },
  { key: 'well', title: 'Mercy at the Well', refs: ['John 4:1-26'], created: '2026-06-02 09:00:00',
    versions: [{ key: 'original', label: 'Original', type: 'google_doc', doc: 'demo-doc-well-original', notes: 'well' }] },
  { key: 'hope', title: 'Hope in the Waiting', refs: ['Romans 8:18-30'], series: 'Enough', created: '2026-05-12 09:00:00',
    versions: [
      { key: 'original', label: 'Original', type: 'google_doc', doc: 'demo-doc-hope-original', notes: 'hope' },
      { key: 'revised', label: '2024 revision', type: 'google_doc', doc: 'demo-doc-hope-2024-revision', revoked: true }
    ] },
  { key: 'table', title: 'A Table in the Wilderness', refs: ['Exodus 16:1-18', 'John 6:35'], created: '2026-04-07 09:00:00',
    versions: [{ key: 'original', label: 'Original', type: 'google_doc', doc: 'demo-doc-table-original', notes: 'table' }] },
  { key: 'quiet', title: 'Quiet Faith', refs: ['1 Kings 19:9-13'], created: '2025-11-03 09:00:00', archived: '2026-01-15 10:00:00',
    versions: [{ key: 'original', label: 'Original', type: 'external', url: 'https://example.com/demo/quiet-faith' }] },
  { key: 'seeds', title: 'Seeds and Soil', refs: ['Mark 4:1-20'], created: '2026-03-03 09:00:00',
    versions: [{ key: 'original', label: 'Original', type: 'pdf' }] },
  { key: 'loved', title: 'For God So Loved', refs: ['John 3:16-21'], created: '2026-02-10 09:00:00',
    description: 'Passage metadata only: its notes are not indexed, so it shows up under "Sermon passage" in search.',
    versions: [{ key: 'original', label: 'Original', type: 'google_doc', doc: 'demo-doc-loved-original' }] }
];

// [sermon, version, place, date, precision, raw date, occasion]
const EVENTS = [
  ['grace', 'original', 'riverbend', '2026-11-08', 'exact', null, 'Sunday morning'],
  ['grace', 'original', 'lakeside', '2026-10-11', 'exact', null, 'Evening service'],
  ['water', 'original', 'riverbend', '2026-09-27', 'exact', null, 'Sunday morning'],
  ['shepherd', 'original', 'hilltop', '2026-08-16', 'exact', null, 'Memorial gathering'],
  ['shepherd', 'original', 'riverbend-short', '2026-02-01', 'needs_review', '1 Feb 2026', 'Sunday morning'],
  ['love', 'original', 'lakeside', '2026-07-19', 'exact', null, 'Sunday morning'],
  ['well', 'original', 'hilltop', '2026-06-07', 'exact', null, 'Women\'s retreat'],
  ['well', 'original', null, '2025-06-01', 'month', 'June 2025', 'Summer series'],
  ['hope', 'original', 'riverbend', '2026-05-17', 'exact', null, 'Sunday morning'],
  ['hope', null, 'lakeside', '2024-01-01', 'year', '2024', null],
  ['table', 'original', 'riverbend-short', '2026-04-12', 'exact', null, 'Community meal'],
  ['quiet', 'original', 'hilltop', '2025-11-09', 'exact', null, 'Sunday morning'],
  ['seeds', 'original', 'riverbend', '2026-03-08', 'exact', null, 'Sunday morning'],
  ['loved', null, null, null, 'unknown', 'sometime in spring', null]
];

// ---------- SQL ----------
export const q = value => (value === null || value === undefined ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replace(/'/g, "''")}'`);

/** A stable UUID-shaped id for one seeded row in one workspace. */
export function seedId(workspaceId, key) {
  const hex = createHash('sha256').update(`sermon-bank-demo-seed:${SEED_VERSION}:${workspaceId}:${key}`).digest('hex');
  const variant = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Every id this seed owns in a workspace, by table, for counting what is already there. */
export function seedIds(workspaceId) {
  const ids = { places: [], sermons: [], versions: [], events: [], notes: [] };
  for (const place of PLACES) ids.places.push(seedId(workspaceId, `place:${place.key}`));
  for (const s of SERMONS) {
    ids.sermons.push(seedId(workspaceId, `sermon:${s.key}`));
    for (const v of s.versions) {
      ids.versions.push(seedId(workspaceId, `version:${s.key}:${v.key}`));
      if (v.notes) ids.notes.push(seedId(workspaceId, `version:${s.key}:${v.key}`));
    }
  }
  EVENTS.forEach((_, i) => ids.events.push(seedId(workspaceId, `event:${i}`)));
  return ids;
}

/**
 * Pure: the statements that seed one workspace. `extractReferences` is src/search/bible.ts's, passed in so the
 * script reuses the exact parser the search index uses.
 */
export function buildSeedStatements(workspaceId, ownerAccountId, extractReferences) {
  const w = q(workspaceId);
  const out = [];
  const placeId = key => seedId(workspaceId, `place:${key}`);
  // A place is found by name or by an alias a merge left behind, so renamed or merged places are never recreated.
  const placeRef = key => {
    const name = PLACES.find(p => p.key === key).name;
    return `COALESCE((SELECT p.id FROM places p WHERE p.workspace_id = ${w} AND p.display_name = ${q(name)} COLLATE NOCASE),
      (SELECT a.place_id FROM place_aliases a WHERE a.workspace_id = ${w} AND a.alias = ${q(name)} COLLATE NOCASE))`;
  };

  for (const place of PLACES) {
    out.push(`INSERT OR IGNORE INTO places(id, workspace_id, display_name)
      SELECT ${q(placeId(place.key))}, ${w}, ${q(place.name)}
      WHERE NOT EXISTS (SELECT 1 FROM place_merges m WHERE m.workspace_id = ${w} AND m.source_place_id = ${q(placeId(place.key))})
        AND NOT EXISTS (SELECT 1 FROM place_aliases a WHERE a.workspace_id = ${w} AND a.alias = ${q(place.name)} COLLATE NOCASE)`);
    for (const alias of place.aliases ?? []) {
      out.push(`INSERT OR IGNORE INTO place_aliases(workspace_id, place_id, alias)
        SELECT ${w}, ${q(placeId(place.key))}, ${q(alias)} WHERE EXISTS (SELECT 1 FROM places p WHERE p.workspace_id = ${w} AND p.id = ${q(placeId(place.key))})`);
    }
  }

  for (const s of SERMONS) {
    const sid = seedId(workspaceId, `sermon:${s.key}`);
    out.push(`INSERT OR IGNORE INTO sermons(id, workspace_id, title, scripture_passage, series_name, description, tags_json, created_at, archived_at)
      VALUES (${q(sid)}, ${w}, ${q(s.title)}, ${q(s.refs.join('; '))}, ${q(s.series ?? null)}, ${q(s.description ?? null)},
        ${q(JSON.stringify([DEMO_TAG]))}, ${q(s.created)}, ${q(s.archived ?? null)})`);
    s.refs.forEach((ref, position) => out.push(`INSERT OR IGNORE INTO sermon_scripture_refs(workspace_id, sermon_id, position, reference_text)
      SELECT ${w}, ${q(sid)}, ${position}, ${q(ref)} WHERE EXISTS (SELECT 1 FROM sermons s WHERE s.workspace_id = ${w} AND s.id = ${q(sid)})
        AND NOT EXISTS (SELECT 1 FROM sermon_scripture_refs r WHERE r.workspace_id = ${w} AND r.sermon_id = ${q(sid)})`));
    for (const v of s.versions) {
      const vid = seedId(workspaceId, `version:${s.key}:${v.key}`);
      const state = v.notes ? 'indexed' : v.revoked ? 'revoked' : 'not_indexed';
      const consented = state !== 'not_indexed';
      out.push(`INSERT OR IGNORE INTO sermon_versions(id, workspace_id, sermon_id, label, source_type, source_url, google_document_id,
          indexing_state, index_consent_by, index_consent_at, created_at)
        SELECT ${q(vid)}, ${w}, ${q(sid)}, ${q(v.label)}, ${q(v.type)}, ${q(v.url ?? null)}, ${q(v.doc ?? null)},
          ${q(state)}, ${consented ? q(ownerAccountId) : 'NULL'}, ${consented ? q(s.created) : 'NULL'}, ${q(s.created)}
        WHERE EXISTS (SELECT 1 FROM sermons s WHERE s.workspace_id = ${w} AND s.id = ${q(sid)})`);
      if (!v.notes) continue;
      const body = NOTES[v.notes].normalize('NFC').replace(/\r\n?/g, '\n').trim();
      const tokens = extractReferences(body).map(ref => ({
        book: ref.book, chapter: ref.chapter, verse_start: ref.verseStart, verse_end: ref.verseEnd, text_start: ref.start, text_end: ref.end
      }));
      // Only while the version is still indexed with consent: a revoked demo version is never re-indexed.
      out.push(`INSERT OR IGNORE INTO note_texts(workspace_id, sermon_id, version_id, body, consent_at)
        SELECT v.workspace_id, v.sermon_id, v.id, ${q(body)}, v.index_consent_at FROM sermon_versions v
        WHERE v.workspace_id = ${w} AND v.id = ${q(vid)} AND v.indexing_state = 'indexed' AND v.index_consent_at IS NOT NULL`);
      out.push(`INSERT INTO note_reference_tokens(workspace_id, version_id, book, chapter, verse_start, verse_end, text_start, text_end, consent_at)
        SELECT t.workspace_id, t.version_id, json_extract(j.value, '$.book'), json_extract(j.value, '$.chapter'),
          json_extract(j.value, '$.verse_start'), json_extract(j.value, '$.verse_end'),
          json_extract(j.value, '$.text_start'), json_extract(j.value, '$.text_end'), t.consent_at
        FROM note_texts t, json_each(${q(JSON.stringify(tokens))}) j
        WHERE t.workspace_id = ${w} AND t.version_id = ${q(vid)}
          AND NOT EXISTS (SELECT 1 FROM note_reference_tokens r WHERE r.workspace_id = t.workspace_id AND r.version_id = t.version_id)`);
    }
  }

  EVENTS.forEach(([sermon, version, place, date, precision, raw, occasion], i) => {
    const sid = seedId(workspaceId, `sermon:${sermon}`);
    const vid = version ? seedId(workspaceId, `version:${sermon}:${version}`) : null;
    out.push(`INSERT OR IGNORE INTO preaching_events(id, workspace_id, sermon_id, version_id, place_id, preached_on, raw_date, date_precision, occasion)
      SELECT ${q(seedId(workspaceId, `event:${i}`))}, s.workspace_id, s.id,
        ${vid ? `(SELECT v.id FROM sermon_versions v WHERE v.workspace_id = s.workspace_id AND v.sermon_id = s.id AND v.id = ${q(vid)})` : 'NULL'},
        ${place ? placeRef(place) : 'NULL'}, ${q(date)}, ${q(raw)}, ${q(precision)}, ${q(occasion)}
      FROM sermons s WHERE s.workspace_id = ${w} AND s.id = ${q(sid)}`);
  });

  out.push(`INSERT OR IGNORE INTO audit_events(id, workspace_id, actor_account_id, action, target_type, target_id, details_json)
    VALUES (${q(seedId(workspaceId, 'audit'))}, ${w}, NULL, 'seed.demo', 'workspace', ${w},
      ${q(JSON.stringify({ seed: SEED_VERSION, sermons: SERMONS.length, events: EVENTS.length }))})`);
  return out;
}

// ---------- D1 (staging only) ----------
async function d1(sql) {
  try {
    const { stdout } = await run(WRANGLER, ['d1', 'execute', 'DB', '--env', 'staging', '--remote', '--command', sql, '--json'],
      { cwd: ROOT, maxBuffer: 16 << 20, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' } });
    return JSON.parse(stdout).flatMap(statement => statement.results || []);
  } catch (error) {
    // Only wrangler's own message: never echo the SQL, which holds the demo text.
    throw new Error(`wrangler d1 execute failed: ${String(error.stderr || error.message).split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 400)}`);
  }
}

export async function findWorkspace(exec, nameOrId) {
  const rows = await exec(`SELECT w.id, (SELECT m.account_id FROM workspace_memberships m WHERE m.workspace_id = w.id AND m.role = 'owner'
      AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL LIMIT 1) AS owner_id
    FROM workspaces w WHERE w.deleted_at IS NULL AND (w.id = ${q(nameOrId)} OR w.name = ${q(nameOrId)})`);
  if (rows.length === 0) throw new SeedRefusal('No active staging workspace has that name or id. Nothing was written.');
  if (rows.length > 1) throw new SeedRefusal(`${rows.length} staging workspaces share that name. Pass the workspace id instead. Nothing was written.`);
  if (!rows[0].owner_id) throw new SeedRefusal('That workspace has no active Owner to attribute the demo notes consent to. Nothing was written.');
  return { id: rows[0].id, ownerId: rows[0].owner_id };
}

const list = ids => ids.map(q).join(', ');
/** How many of this seed's rows exist in the workspace, by kind. */
export async function countPresent(exec, workspaceId) {
  const ids = seedIds(workspaceId), w = q(workspaceId);
  const [row] = await exec(`SELECT
    (SELECT COUNT(*) FROM places WHERE workspace_id = ${w} AND id IN (${list(ids.places)})) AS places,
    (SELECT COUNT(*) FROM sermons WHERE workspace_id = ${w} AND id IN (${list(ids.sermons)})) AS sermons,
    (SELECT COUNT(*) FROM sermon_versions WHERE workspace_id = ${w} AND id IN (${list(ids.versions)})) AS versions,
    (SELECT COUNT(*) FROM preaching_events WHERE workspace_id = ${w} AND id IN (${list(ids.events)})) AS events,
    (SELECT COUNT(*) FROM note_texts WHERE workspace_id = ${w} AND version_id IN (${list(ids.notes)})) AS notes`);
  return row;
}

const describe = counts => `${counts.sermons} sermons, ${counts.versions} versions, ${counts.notes} indexed notes, ${counts.events} events, ${counts.places} places`;

export async function main(argv = process.argv.slice(2), exec = d1) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('Usage: pnpm seed:staging --workspace "<name or id>" [--dry-run]\nSeeds fictional demo sermons, versions, events, places and indexed notes into that one STAGING workspace. Idempotent.');
    return;
  }
  assertStagingConfig(await readFile(join(ROOT, 'wrangler.jsonc'), 'utf8'));
  const { extractReferences } = await import('../src/search/bible.ts');
  const workspace = await findWorkspace(exec, args.workspace);
  const statements = buildSeedStatements(workspace.id, workspace.ownerId, extractReferences);
  const before = await countPresent(exec, workspace.id);
  console.log(`Staging workspace ${workspace.id}: ${describe(before)} of the demo set already present.`);
  if (args.dryRun) { console.log(`Dry run: would run ${statements.length} idempotent statements. Nothing written.`); return; }
  await exec(statements.join(';\n') + ';');
  const after = await countPresent(exec, workspace.id);
  console.log(`Seeded. Now present: ${describe(after)}.`);
  console.log(after.sermons === before.sermons && after.versions === before.versions && after.events === before.events && after.notes === before.notes
    ? 'Nothing new was added (already seeded).' : 'Done. Run it again any time: it only adds what is missing.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof SeedRefusal ? `Refused: ${error.message}` : `seed-staging failed: ${error.message}`);
    process.exit(error instanceof SeedRefusal ? 2 : 1);
  });
}
