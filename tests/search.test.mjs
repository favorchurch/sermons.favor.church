import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, ids } from './helpers/library-fixture.mjs';
import { indexVersion, purgeVersionIndex, parseSearchQuery, IndexRefused } from '../src/search/index.ts';

const uuid = n => `d1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sermon3 = 'c1000000-0000-4000-8000-000000000003';

async function withFixture(run) {
  const f = await fixture();
  try { await run(f); } finally { f.db.close(); }
}

/** Record Owner consent the way the (separate) consent flow does. */
function consent(db, versionId, { by = ids.owner, state = 'queued', at = '2025-06-01 10:00:00' } = {}) {
  db.execute('UPDATE sermon_versions SET index_consent_by=?, index_consent_at=?, indexing_state=? WHERE id=?', [by, at, state, versionId]);
}
const stored = db => ({
  texts: db.query('SELECT version_id FROM note_texts').length,
  tokens: db.query('SELECT id FROM note_reference_tokens').length
});
const ftsHits = (db, word) => db.query('SELECT rowid FROM note_fts WHERE note_fts MATCH ?', [`"${word}"`]).length;
const search = (f, q, actor = 'owner', extra = '') => f.call('GET', f.w(`/search?q=${encodeURIComponent(q)}${extra}`), actor);
const findIn = (f, q, sermon = ids.sermon1, actor = 'owner') =>
  f.call('GET', f.w(`/sermons/${sermon}/find-in-notes?q=${encodeURIComponent(q)}`), actor);
const index = (f, versionId, text, workspaceId = ids.w1) => indexVersion(f.env.DB, { workspaceId, versionId, text, actorId: ids.owner });

const NOTES = 'Opening. For God so loved the world, John 3:16 says it plainly. Later we read Jn 3:16-18 again and Romans 8 closes the sermon.';

// ---------------------------------------------------------------------------------------
// Consent and indexing
// ---------------------------------------------------------------------------------------

test('indexing refuses without active Owner consent and stores nothing', async () => {
  const cases = {
    'no consent at all': () => {},
    'consent timestamp without a consenting account': f => f.db.execute("UPDATE sermon_versions SET index_consent_at='2025-06-01', indexing_state='queued' WHERE id=?", [ids.version1]),
    'consent given by an admin': f => consent(f.db, ids.version1, { by: ids.admin }),
    'consent given by a viewer': f => consent(f.db, ids.version1, { by: ids.viewer }),
    'consent by an Owner of another workspace': f => consent(f.db, ids.version1, { by: ids.owner2 }),
    'consent recorded but state not_indexed': f => consent(f.db, ids.version1, { state: 'not_indexed' }),
    'consent recorded but awaiting consent': f => consent(f.db, ids.version1, { state: 'awaiting_consent' }),
    'consent revoked': f => consent(f.db, ids.version1, { state: 'revoked' }),
    'sermon deleted': f => { consent(f.db, ids.version1); f.db.execute('UPDATE sermons SET deleted_at=CURRENT_TIMESTAMP WHERE id=?', [ids.sermon1]); }
  };
  for (const [name, setup] of Object.entries(cases)) {
    await withFixture(async f => {
      setup(f);
      const before = f.db.query('SELECT indexing_state FROM sermon_versions WHERE id=?', [ids.version1])[0].indexing_state;
      await assert.rejects(index(f, ids.version1, NOTES), error => error instanceof IndexRefused && error.code === 'consent_required', name);
      assert.deepEqual(stored(f.db), { texts: 0, tokens: 0 }, name);
      assert.equal(ftsHits(f.db, 'sermon'), 0, name);
      assert.equal(f.db.query('SELECT indexing_state FROM sermon_versions WHERE id=?', [ids.version1])[0].indexing_state, before, name);
      assert.equal(f.db.query("SELECT 1 FROM audit_events WHERE action='version.index'").length, 0, name);
    });
  }
});

test('indexing refuses unknown or cross-workspace versions, empty text and oversized text', async () => {
  await withFixture(async f => {
    consent(f.db, ids.version1);
    consent(f.db, ids.version2, { by: ids.owner2 });
    await assert.rejects(index(f, ids.version2, NOTES), error => error.code === 'version_not_found');
    await assert.rejects(index(f, uuid(99), NOTES), error => error.code === 'version_not_found');
    await assert.rejects(index(f, ids.version1, '  \n '), error => error.code === 'empty_text');
    await assert.rejects(index(f, ids.version1, 'x'.repeat(400_001)), error => error.code === 'text_too_large');
    assert.deepEqual(stored(f.db), { texts: 0, tokens: 0 });
  });
});

test('Owner consent allows indexing: text, canonical reference tokens, consent timestamp, state and audit', async () => {
  await withFixture(async f => {
    consent(f.db, ids.version1, { at: '2025-06-01 10:00:00' });
    const result = await index(f, ids.version1, NOTES);
    assert.equal(result.references, 3);
    const version = f.db.query('SELECT indexing_state, index_consent_at FROM sermon_versions WHERE id=?', [ids.version1])[0];
    assert.equal(version.indexing_state, 'indexed');
    const tokens = f.db.query('SELECT * FROM note_reference_tokens ORDER BY text_start');
    assert.deepEqual(tokens.map(t => [t.workspace_id, t.version_id, t.book, t.chapter, t.verse_start, t.verse_end, t.consent_at]), [
      [ids.w1, ids.version1, 'John', 3, 16, 16, '2025-06-01 10:00:00'],
      [ids.w1, ids.version1, 'John', 3, 16, 18, '2025-06-01 10:00:00'],
      [ids.w1, ids.version1, 'Romans', 8, null, null, '2025-06-01 10:00:00']
    ]);
    for (const t of tokens) assert.equal(NOTES.slice(t.text_start, t.text_end).length, t.text_end - t.text_start);
    assert.equal(NOTES.slice(tokens[0].text_start, tokens[0].text_end), 'John 3:16');
    assert.equal(NOTES.slice(tokens[1].text_start, tokens[1].text_end), 'Jn 3:16-18');
    assert.equal(f.db.query('SELECT consent_at FROM note_texts')[0].consent_at, '2025-06-01 10:00:00');
    const audit = f.db.query("SELECT actor_account_id, details_json FROM audit_events WHERE action='version.index'");
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor_account_id, ids.owner);
    assert.ok(!audit[0].details_json.includes('God'), 'audit details hold counts only');
  });
});

test('re-indexing replaces the previous text and tokens', async () => {
  await withFixture(async f => {
    consent(f.db, ids.version1);
    await index(f, ids.version1, 'First draft mentions Psalm 23 and lanterns.');
    await index(f, ids.version1, 'Second draft mentions Romans 8 and harbors.');
    assert.equal(ftsHits(f.db, 'lanterns'), 0);
    assert.equal(ftsHits(f.db, 'harbors'), 1);
    assert.deepEqual(f.db.query('SELECT book FROM note_reference_tokens').map(r => r.book), ['Romans']);
    assert.deepEqual(stored(f.db), { texts: 1, tokens: 1 });
  });
});

// ---------------------------------------------------------------------------------------
// Results: metadataMatches vs notesMatches
// ---------------------------------------------------------------------------------------

async function withLibrary(run) {
  await withFixture(async f => {
    consent(f.db, ids.version1);
    await index(f, ids.version1, NOTES);
    // A second w1 sermon whose passage is John 3 but whose notes never mention it.
    f.db.execute('INSERT INTO sermons(id,workspace_id,title,scripture_passage) VALUES (?,?,?,?)', [sermon3, ids.w1, 'Beta Light Sermon', 'John 3:14-17']);
    f.db.execute('INSERT INTO sermon_scripture_refs(workspace_id,sermon_id,position,reference_text) VALUES (?,?,0,?)', [ids.w1, sermon3, 'John 3:14-17']);
    f.db.execute(`INSERT INTO sermon_versions(id,workspace_id,sermon_id,label,source_type,google_document_id) VALUES (?,?,?,?,?,?)`,
      [uuid(3), ids.w1, sermon3, 'Original', 'google_doc', 'thirdDocId0003']);
    consent(f.db, uuid(3));
    await index(f, uuid(3), 'This message speaks about harbors, lanterns and Psalm 107 only.');
    await run(f);
  });
}

test('reference query returns separate metadataMatches and notesMatches; passage-only sermon is metadata only', async () => {
  await withLibrary(async f => {
    const res = await search(f, 'Jn 3:16');
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.query, { kind: 'reference', label: 'John 3:16' });
    assert.deepEqual(res.json.metadataMatches.map(m => m.sermon_id).sort(), [ids.sermon1, sermon3].sort());
    for (const m of res.json.metadataMatches) {
      assert.equal(m.source, 'sermon_passage');
      assert.equal(m.label, 'Sermon passage');
      assert.ok(m.passage && m.sermon_title);
      assert.ok(!('excerpt' in m) && !('version_id' in m));
    }
    assert.deepEqual(res.json.notesMatches.map(m => m.sermon_id), [ids.sermon1]);
    const note = res.json.notesMatches[0];
    assert.equal(note.version_id, ids.version1);
    assert.equal(note.version_label, 'Original Alpha');
    assert.equal(note.source_type, 'google_doc');
    assert.equal(note.match_count, 2);
    assert.equal(note.offset, NOTES.indexOf('John 3:16'));
    assert.ok(!('passage' in note));
    const highlighted = note.excerpt.highlights.map(h => note.excerpt.text.slice(h.start, h.end));
    assert.deepEqual(highlighted, ['John 3:16', 'Jn 3:16-18']);
    assert.equal(NOTES.slice(note.excerpt.text_offset, note.excerpt.text_offset + note.excerpt.text.length), note.excerpt.text);
    assert.ok(!res.json.notesMatches.some(m => m.sermon_id === sermon3));
  });
});

test('reference overlap uses canonical ranges and whole chapters', async () => {
  await withLibrary(async f => {
    const hits = async q => (await search(f, q)).json.notesMatches.map(m => m.sermon_id);
    assert.deepEqual(await hits('John 3:17'), [ids.sermon1], 'verse inside the 16-18 token');
    assert.deepEqual(await hits('John 3:19'), []);
    assert.deepEqual(await hits('John 3'), [ids.sermon1], 'whole chapter overlaps any verse');
    assert.deepEqual(await hits('Romans 8:28'), [ids.sermon1], 'whole-chapter token overlaps any verse');
    assert.deepEqual(await hits('Romans 9'), []);
    assert.deepEqual(await hits('Psalm 107:1'), [sermon3], 'whole-chapter token in another sermon');
  });
});

test('reference query that appears nowhere returns empty arrays', async () => {
  await withLibrary(async f => {
    const res = await search(f, 'Jude 1:3');
    assert.deepEqual([res.json.metadataMatches, res.json.notesMatches], [[], []]);
  });
});

test('text query searches notes only and returns excerpt with highlight offsets', async () => {
  await withLibrary(async f => {
    const res = await search(f, 'so loved the world');
    assert.equal(res.status, 200);
    assert.equal(res.json.query.kind, 'text');
    assert.deepEqual(res.json.metadataMatches, []);
    assert.equal(res.json.notesMatches.length, 1);
    const note = res.json.notesMatches[0];
    assert.equal(note.version_label, 'Original Alpha');
    assert.equal(note.offset, NOTES.indexOf('so loved'));
    const { text, highlights } = note.excerpt;
    assert.deepEqual(highlights.map(h => text.slice(h.start, h.end)), ['so loved the world']);
  });
});

// ---------------------------------------------------------------------------------------
// Phrase semantics and FTS escaping
// ---------------------------------------------------------------------------------------

const PHRASE_NOTES = 'Saved by grace alone, through faith. Graceful people have faith; Grace is not cheap. Café stories.';

test('phrase queries match only words present in order in the indexed text', async () => {
  await withFixture(async f => {
    consent(f.db, ids.version1);
    await index(f, ids.version1, PHRASE_NOTES);
    const count = async q => (await search(f, q)).json.notesMatches[0]?.match_count ?? 0;
    assert.equal(await count('grace alone'), 1);
    assert.equal(await count('GRACE ALONE'), 1, 'case-insensitive');
    assert.equal(await count('"grace alone"'), 1, 'quotes around a phrase are fine');
    assert.equal(await count('grace faith'), 0, 'words present but not adjacent');
    assert.equal(await count('alone grace'), 0, 'wrong order');
    assert.equal(await count('grace alone through faith'), 1);
    assert.equal(await count('grace alone through hope'), 0, 'one absent word fails the phrase');
    assert.equal(await count('grac'), 0, 'no prefix matching');
    assert.equal(await count('cafe'), 1, 'diacritics folded');
    const grace = (await search(f, 'grace')).json.notesMatches[0];
    assert.equal(grace.match_count, 2, 'Graceful is a different word');
    assert.deepEqual(grace.excerpt.highlights.map(h => grace.excerpt.text.slice(h.start, h.end)), ['grace', 'Grace']);
  });
});

test('FTS syntax in user input cannot error or widen the search', async () => {
  await withFixture(async f => {
    consent(f.db, ids.version1);
    await index(f, ids.version1, 'Saved by grace alone, through faith. Graceful people. NEAR NOT AND OR are words too.');
    const matches = async q => {
      const res = await search(f, q);
      assert.equal(res.status, 200, `${JSON.stringify(q)} -> ${res.status} ${res.text}`);
      return res.json.notesMatches.map(m => m.match_count);
    };
    // Each hostile input behaves exactly like the plain phrase of its own words, never as an operator.
    const pairs = [
      ['grace OR faith', 'grace or faith'], ['grace AND faith', 'grace and faith'], ['grace NOT faith', 'grace not faith'],
      ['grace NEAR faith', 'grace near faith'], ['NEAR(grace faith)', 'near grace faith'], ['zzz OR grace', 'zzz or grace'],
      ['grace*', 'grace'], ['^grace', 'grace'], ['-grace', 'grace'], ['(grace', 'grace'], ['grace)', 'grace'], ['"grace', 'grace'],
      ['grace"', 'grace'], ['gra*ce', 'gra ce'], ['body:grace', 'body grace'], ['{body}:grace', 'body grace'],
      ["grace' OR '1'='1", 'grace or 1 1'], ['grace; DROP TABLE note_texts', 'grace drop table note_texts'],
      ['grace\u0000faith', 'grace faith'], ['NEAR NOT AND OR', 'near not and or']
    ];
    for (const [hostile, plain] of pairs) assert.deepEqual(await matches(hostile), await matches(plain), JSON.stringify(hostile));
    assert.deepEqual(await matches('grace*'), [1], 'a star is not a prefix operator: Graceful does not match');
    assert.deepEqual(await matches('grace OR faith'), [], 'OR does not widen to either word');
    assert.deepEqual(await matches('NEAR(grace faith)'), [], 'NEAR is not a proximity operator');
    assert.deepEqual(await matches('NEAR NOT AND OR'), [1], 'operator words are plain words inside a phrase');
    assert.deepEqual(await matches('body:grace'), [], 'no column filter');
    assert.equal(f.db.query('SELECT 1 FROM note_texts').length, 1, 'table intact');
  });
});

test('queries with nothing searchable or too long are rejected without touching the index', async () => {
  await withFixture(async f => {
    for (const q of ['', '   ', '***', '"', '()', '-', 'a '.repeat(13), 'x'.repeat(201)]) {
      const res = await search(f, q);
      assert.equal(res.status, 400, JSON.stringify(q));
      assert.equal(res.json.field, 'q');
    }
    const missing = await f.call('GET', f.w('/search'), 'owner');
    assert.deepEqual([missing.status, missing.json], [400, { error: 'missing_query', field: 'q' }]);
    assert.equal(parseSearchQuery('1 John 3:16').kind, 'reference');
    assert.equal(parseSearchQuery('John 99:1').kind, 'text', 'invalid chapter is not a reference');
    assert.equal(parseSearchQuery('John').kind, 'text', 'a bare book name is text');
  });
});

// ---------------------------------------------------------------------------------------
// Find in notes: per-version status
// ---------------------------------------------------------------------------------------

test('find-in-notes reports matched, not_in_notes and not_searchable per version without leaking excerpts', async () => {
  await withFixture(async f => {
    const add = (n, label, state) => {
      f.db.execute(`INSERT INTO sermon_versions(id,workspace_id,sermon_id,label,source_type) VALUES (?,?,?,?,'pdf')`, [uuid(n), ids.w1, ids.sermon1, label]);
      if (state) f.db.execute('UPDATE sermon_versions SET indexing_state=? WHERE id=?', [state, uuid(n)]);
    };
    add(10, 'Indexed miss', null);
    add(11, 'Queued', 'queued');
    add(12, 'Awaiting', 'awaiting_consent');
    add(13, 'Revoked', 'revoked');
    add(14, 'Never indexed', 'not_indexed');
    add(15, 'Failed', 'failed');
    add(16, 'Purged', null);
    add(17, 'Indexed without text', 'indexed');
    for (const [id, text] of [[ids.version1, NOTES], [uuid(10), 'A sermon about harbors and nothing else.'], [uuid(16), 'Also mentions John 3:16 and God so loved.']]) {
      consent(f.db, id);
      await index(f, id, text);
    }
    // Revoked and queued versions keep stale text rows: they must still be invisible.
    for (const [n, text] of [[11, 'Queued text John 3:16 God so loved'], [13, 'Revoked text John 3:16 God so loved']]) {
      f.db.execute('INSERT INTO note_texts(workspace_id,sermon_id,version_id,body,consent_at) VALUES (?,?,?,?,?)', [ids.w1, ids.sermon1, uuid(n), text, '2025-01-01']);
      f.db.execute(`INSERT INTO note_reference_tokens(workspace_id,version_id,book,chapter,verse_start,verse_end,text_start,text_end,consent_at) VALUES (?,?,'John',3,16,16,12,21,'2025-01-01')`, [ids.w1, uuid(n)]);
    }
    await purgeVersionIndex(f.env.DB, ids.w1, uuid(16));

    for (const q of ['John 3:16', 'God so loved']) {
      const res = await findIn(f, q);
      assert.equal(res.status, 200, res.text);
      const by = Object.fromEntries(res.json.versions.map(v => [v.label, v]));
      assert.equal(by['Original Alpha'].status, 'matched');
      assert.ok(by['Original Alpha'].match_count >= 1);
      assert.ok(by['Original Alpha'].excerpts.length >= 1);
      for (const h of by['Original Alpha'].excerpts[0].highlights) assert.ok(h.end > h.start);
      assert.deepEqual(by['Indexed miss'], { version_id: uuid(10), label: 'Indexed miss', source_type: 'pdf', status: 'not_in_notes', match_count: 0 });
      const expectedReasons = { Queued: 'pending', Awaiting: 'pending', Revoked: 'revoked', 'Never indexed': 'unindexed', Failed: 'unindexed', Purged: 'unindexed', 'Indexed without text': 'unindexed' };
      for (const [label, reason] of Object.entries(expectedReasons)) {
        assert.deepEqual(Object.keys(by[label]).sort(), ['label', 'reason', 'source_type', 'status', 'version_id'], `${label} has no excerpt or count`);
        assert.deepEqual([by[label].status, by[label].reason], ['not_searchable', reason], label);
      }
      assert.equal(res.json.versions.length, 9);
      assert.ok(!res.text.includes('Queued text') && !res.text.includes('Revoked text') && !res.text.includes('Also mentions'));
    }
    const global = await search(f, 'John 3:16');
    assert.deepEqual(global.json.notesMatches.map(m => m.version_label), ['Original Alpha']);
  });
});

test('find-in-notes returns 404 for unknown, deleted and cross-workspace sermons', async () => {
  await withFixture(async f => {
    consent(f.db, ids.version2, { by: ids.owner2 });
    await indexVersion(f.env.DB, { workspaceId: ids.w2, versionId: ids.version2, text: 'Beta secret mentions Psalm 23 here.' });
    for (const sermon of [ids.sermon2, uuid(77)]) {
      const res = await findIn(f, 'Psalm 23', sermon);
      assert.deepEqual([res.status, res.json], [404, { error: 'not_found' }]);
    }
    assert.equal((await f.call('GET', f.w(`/sermons/not-a-uuid/find-in-notes?q=a`), 'owner')).status, 404);
    f.db.execute('UPDATE sermons SET deleted_at=CURRENT_TIMESTAMP WHERE id=?', [ids.sermon1]);
    assert.equal((await findIn(f, 'Psalm 23')).status, 404);
  });
});

// ---------------------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------------------

test('cross-workspace search returns nothing and no counts', async () => {
  await withFixture(async f => {
    consent(f.db, ids.version1);
    await index(f, ids.version1, 'Alpha notes mention lanterns and Romans 8.');
    consent(f.db, ids.version2, { by: ids.owner2 });
    await indexVersion(f.env.DB, { workspaceId: ids.w2, versionId: ids.version2, text: 'Beta secret notes mention zebras and Psalm 23 and Romans 8.' });
    // A w1 member searching for text that only exists in w2.
    for (const q of ['zebras', 'Psalm 23', 'Beta secret']) {
      const res = await search(f, q);
      assert.equal(res.status, 200);
      assert.deepEqual([res.json.metadataMatches, res.json.notesMatches], [[], []], q);
      assert.ok(!res.text.includes('Beta') && !/"(total|count)/.test(res.text.replace(/match_count/g, '')), q);
    }
    // Shared reference: each workspace only ever sees its own version.
    const own = await search(f, 'Romans 8');
    assert.deepEqual(own.json.notesMatches.map(m => m.version_id), [ids.version1]);
    // Non-members of w1 get 404 with no body content, even for text w1 holds.
    for (const actor of ['owner2', 'outsider']) {
      const res = await search(f, 'lanterns', actor);
      assert.deepEqual([res.status, res.json], [404, { error: 'not_found' }], actor);
      const find = await findIn(f, 'lanterns', ids.sermon1, actor);
      assert.deepEqual([find.status, find.json], [404, { error: 'not_found' }], actor);
    }
    const anonymous = await f.call('GET', f.w('/search?q=lanterns'));
    assert.equal(anonymous.status, 401);
    assert.ok(!anonymous.text.includes('lanterns'));
    // Direct SQL scoping: asking w2's scope for w1's text finds nothing either.
    const { searchNotes } = await import('../src/search/index.ts');
    const cross = await searchNotes(f.env.DB, ids.w2, parseSearchQuery('lanterns'), { limit: 20, maxExcerpts: 1 });
    assert.deepEqual(cross, []);
  });
});

test('Viewer, Editor and Admin can search and find in notes', async () => {
  await withFixture(async f => {
    consent(f.db, ids.version1);
    await index(f, ids.version1, NOTES);
    for (const actor of ['viewer', 'editor', 'admin', 'owner']) {
      const res = await search(f, 'John 3:16', actor);
      assert.equal(res.status, 200, actor);
      assert.equal(res.json.notesMatches.length, 1, actor);
      const find = await findIn(f, 'John 3:16', ids.sermon1, actor);
      assert.equal(find.status, 200, actor);
      assert.equal(find.json.versions[0].status, 'matched', actor);
    }
  });
});

test('search does not write: no audit rows, no data changes', async () => {
  await withFixture(async f => {
    consent(f.db, ids.version1);
    await index(f, ids.version1, NOTES);
    const before = JSON.stringify([f.db.query('SELECT * FROM audit_events'), f.db.query('SELECT * FROM note_texts')]);
    await search(f, 'John 3:16'); await findIn(f, 'John 3:16');
    assert.equal(JSON.stringify([f.db.query('SELECT * FROM audit_events'), f.db.query('SELECT * FROM note_texts')]), before);
  });
});

// ---------------------------------------------------------------------------------------
// Purge, cascades, archive
// ---------------------------------------------------------------------------------------

test('after purgeVersionIndex no excerpt or count for that version returns', async () => {
  await withLibrary(async f => {
    assert.equal((await search(f, 'John 3:16')).json.notesMatches.length, 1);
    assert.equal((await search(f, 'Romans 8')).json.notesMatches.length, 1);
    assert.equal(await purgeVersionIndex(f.env.DB, ids.w1, ids.version1), true);
    assert.equal(await purgeVersionIndex(f.env.DB, ids.w1, ids.version1), false, 'second purge is a no-op');

    for (const q of ['John 3:16', 'Romans 8', 'John 3', 'God so loved', 'sermon']) {
      const res = await search(f, q);
      assert.equal(res.status, 200);
      assert.ok(!res.json.notesMatches.some(m => m.version_id === ids.version1), q);
      assert.ok(!res.text.includes('God so loved'), 'no leftover excerpt for ' + q);
    }
    const find = await findIn(f, 'John 3:16');
    assert.deepEqual(find.json.versions, [{ version_id: ids.version1, label: 'Original Alpha', source_type: 'google_doc', status: 'not_searchable', reason: 'unindexed' }]);
    assert.equal(ftsHits(f.db, 'loved'), 0);
    assert.equal(f.db.query('SELECT 1 FROM note_reference_tokens WHERE version_id=?', [ids.version1]).length, 0);
    assert.equal(f.db.query('SELECT 1 FROM note_texts WHERE version_id=?', [ids.version1]).length, 0);
    // The other version is untouched.
    assert.equal((await search(f, 'lanterns')).json.notesMatches.length, 1);
    // Purge is workspace-scoped.
    assert.equal(await purgeVersionIndex(f.env.DB, ids.w2, uuid(3)), false);
    assert.equal(f.db.query('SELECT 1 FROM note_texts WHERE version_id=?', [uuid(3)]).length, 1);
  });
});

test('revoking consent state hides indexed text even before purge runs', async () => {
  await withLibrary(async f => {
    f.db.execute("UPDATE sermon_versions SET indexing_state='revoked' WHERE id=?", [ids.version1]);
    assert.deepEqual((await search(f, 'John 3:16')).json.notesMatches, []);
    assert.deepEqual((await search(f, 'God so loved')).json.notesMatches, []);
    assert.equal((await findIn(f, 'John 3:16')).json.versions[0].reason, 'revoked');
  });
});

test('deleting a sermon or version removes its index, tokens and full-text entries', async () => {
  await withLibrary(async f => {
    f.db.execute('DELETE FROM sermon_versions WHERE id=?', [uuid(3)]);
    assert.equal(ftsHits(f.db, 'psalm'), 0);
    assert.equal(f.db.query('SELECT 1 FROM note_reference_tokens WHERE version_id=?', [uuid(3)]).length, 0);
    assert.deepEqual(stored(f.db), { texts: 1, tokens: 3 }, 'other version untouched');
    f.db.execute('DELETE FROM sermons WHERE id=?', [ids.sermon1]);
    assert.deepEqual(stored(f.db), { texts: 0, tokens: 0 });
    assert.equal(ftsHits(f.db, 'loved'), 0);
  });
});

test('archived sermons are excluded unless requested, in notes and in metadata', async () => {
  await withLibrary(async f => {
    f.db.execute('UPDATE sermons SET archived_at=CURRENT_TIMESTAMP WHERE id=?', [ids.sermon1]);
    const hidden = await search(f, 'John 3:16');
    assert.deepEqual(hidden.json.metadataMatches.map(m => m.sermon_id), [sermon3]);
    assert.deepEqual(hidden.json.notesMatches, []);
    const shown = await search(f, 'John 3:16', 'owner', '&archived=include');
    assert.equal(shown.json.metadataMatches.length, 2);
    assert.equal(shown.json.notesMatches.length, 1);
    assert.equal((await search(f, 'John 3:16', 'owner', '&archived=bogus')).status, 400);
    assert.equal((await findIn(f, 'John 3:16')).json.versions[0].status, 'matched', 'explicit sermon lookup still works');
  });
});

test('limit is validated and applied', async () => {
  await withLibrary(async f => {
    assert.equal((await search(f, 'harbors', 'owner', '&limit=0')).status, 400);
    assert.equal((await search(f, 'harbors', 'owner', '&limit=51')).status, 400);
    assert.equal((await search(f, 'harbors', 'owner', '&limit=abc')).status, 400);
    const res = await search(f, 'lanterns', 'owner', '&limit=1');
    assert.equal(res.json.limit, 1);
    assert.equal(res.json.notesMatches.length, 1);
  });
});

// ---------------------------------------------------------------------------------------
// Review hardening
// ---------------------------------------------------------------------------------------

test('non-Latin and polytonic text is found: FTS folds the query exactly as it folded the body', async () => {
  await withFixture(async f => {
    consent(f.db, ids.version1);
    await index(f, ids.version1, 'ἐν ἀρχῇ ἦν ὁ λόγος. Ёлка и Иисус Христос. Zoë and Việt Nam.');
    for (const q of ['ἐν ἀρχῇ ἦν', 'ἀρχῇ', 'Ёлка', 'ёлка', 'Иисус Христос', 'ὁ λόγος', 'zoe', 'Viet Nam']) {
      const res = await search(f, q);
      assert.equal(res.json.notesMatches.length, 1, q);
      const { text, highlights } = res.json.notesMatches[0].excerpt;
      assert.equal(highlights.length, 1, q);
      assert.ok(highlights[0].end > highlights[0].start && highlights[0].end <= text.length, q);
    }
    assert.equal((await search(f, 'λόγος ἐν')).json.notesMatches.length, 0, 'order still matters');
  });
});

test('stray combining marks in notes do not hide a phrase from verification', async () => {
  await withFixture(async f => {
    consent(f.db, ids.version1);
    await index(f, ids.version1, 'alpha ́ beta gamma');
    assert.equal((await search(f, 'alpha beta')).json.notesMatches.length, 1);
  });
});

test('offsets stay exact with astral characters, CRLF, decomposed input and excerpt edges on surrogate pairs', async () => {
  await withFixture(async f => {
    consent(f.db, ids.version1);
    const body = `${'😀'.repeat(40)} x\r\ncafé notes\r\nJohn 3:16 end ${'🙂'.repeat(70)}`;
    await index(f, ids.version1, body);
    const stored = f.db.query('SELECT body FROM note_texts')[0].body;
    assert.ok(!stored.includes('\r') && stored.includes('café'), 'stored text is NFC with \\n newlines');
    for (const [q, expected] of [['John 3:16', 'John 3:16'], ['café notes', 'café notes'], ['end', 'end']]) {
      const note = (await search(f, q)).json.notesMatches[0];
      assert.equal(stored.slice(note.offset, note.offset + expected.length), expected, q);
      const { text, text_offset, highlights } = note.excerpt;
      assert.equal(stored.slice(text_offset, text_offset + text.length), text, q);
      assert.equal(text.slice(highlights[0].start, highlights[0].end), expected, q);
      assert.ok(!/(^[\udc00-\udfff])|([\ud800-\udbff]$)/.test(text), 'no split surrogate pair in ' + q);
    }
    const token = f.db.query('SELECT text_start, text_end FROM note_reference_tokens')[0];
    assert.equal(stored.slice(token.text_start, token.text_end), 'John 3:16');
  });
});

test('query word limit: 12 words accepted, 13 rejected', async () => {
  await withFixture(async f => {
    assert.equal((await search(f, 'a b c d e f g h i j k l')).status, 200);
    assert.equal((await search(f, 'a b c d e f g h i j k l m')).status, 400);
  });
});

test('Owner consent must come from an active, accepted membership', async () => {
  await withFixture(async f => {
    f.db.execute('INSERT INTO user_accounts(id,email_normalized,display_name) VALUES (?,?,?),(?,?,?)', [uuid(61), 'x1@example.test', 'x1', uuid(62), 'x2@example.test', 'x2']);
    const cases = [['revoked', uuid(61), "CURRENT_TIMESTAMP", "CURRENT_TIMESTAMP"], ['not accepted', uuid(62), 'NULL', 'NULL']];
    for (const [i, [name, account, accepted, revoked]] of cases.entries()) {
      const w = uuid(70 + i), s = uuid(80 + i), v = uuid(90 + i);
      f.db.execute('INSERT INTO workspaces(id,name,owner_account_id) VALUES (?,?,?)', [w, name, account]);
      f.db.execute(`INSERT INTO workspace_memberships(workspace_id,account_id,role,accepted_at,revoked_at) VALUES (?,?,'owner',${accepted},${name === 'revoked' ? revoked : 'NULL'})`, [w, account]);
      f.db.execute('INSERT INTO sermons(id,workspace_id,title) VALUES (?,?,?)', [s, w, 'S']);
      f.db.execute(`INSERT INTO sermon_versions(id,workspace_id,sermon_id,label,source_type,index_consent_by,index_consent_at,indexing_state) VALUES (?,?,?,?,'pdf',?,'2025-06-01','queued')`, [v, w, s, 'V', account]);
      await assert.rejects(indexVersion(f.env.DB, { workspaceId: w, versionId: v, text: 'Some notes' }), e => e.code === 'consent_required', name);
    }
    assert.deepEqual(stored(f.db), { texts: 0, tokens: 0 });
  });
});

test('consent revoked between the check and the write stores nothing and leaves nothing searchable', async () => {
  await withFixture(async f => {
    consent(f.db, ids.version1);
    await index(f, ids.version1, 'First text about lanterns and John 3:16.');
    assert.equal((await search(f, 'lanterns')).json.notesMatches.length, 1);
    const racing = {
      prepare: sql => f.db.prepare(sql),
      batch: async statements => {
        f.db.execute("UPDATE sermon_versions SET indexing_state='revoked' WHERE id=?", [ids.version1]);
        return f.db.batch(statements);
      }
    };
    const auditBefore = f.db.query("SELECT 1 FROM audit_events WHERE action='version.index'").length;
    await assert.rejects(indexVersion(racing, { workspaceId: ids.w1, versionId: ids.version1, text: 'Second text about harbors.' }),
      e => e instanceof IndexRefused && e.code === 'consent_required');
    assert.deepEqual(stored(f.db), { texts: 0, tokens: 0 });
    assert.equal(ftsHits(f.db, 'harbors'), 0);
    assert.equal(ftsHits(f.db, 'lanterns'), 0);
    assert.equal(f.db.query("SELECT 1 FROM audit_events WHERE action='version.index'").length, auditBefore);
    assert.deepEqual((await search(f, 'harbors')).json.notesMatches, []);
  });
});

test('soft-deleted sermons never appear in search results', async () => {
  await withLibrary(async f => {
    f.db.execute('UPDATE sermons SET deleted_at=CURRENT_TIMESTAMP WHERE id=?', [ids.sermon1]);
    for (const q of ['John 3:16', 'God so loved', 'Romans 8']) {
      for (const archived of ['', '&archived=include']) {
        const res = await search(f, q, 'owner', archived);
        assert.ok(!res.json.metadataMatches.some(m => m.sermon_id === ids.sermon1), q);
        assert.ok(!res.json.notesMatches.some(m => m.sermon_id === ids.sermon1), q);
      }
    }
  });
});

test('limit caps notesMatches and metadataMatches', async () => {
  await withLibrary(async f => {
    // "harbors" is in two sermons' notes; "John 3" passages exist in two sermons.
    await index(f, ids.version1, `${NOTES} We also sailed to the harbors.`);
    const all = await search(f, 'harbors');
    assert.equal(all.json.notesMatches.length, 2);
    assert.equal((await search(f, 'harbors', 'owner', '&limit=1')).json.notesMatches.length, 1);
    assert.equal((await search(f, 'John 3:16')).json.metadataMatches.length, 2);
    assert.equal((await search(f, 'John 3:16', 'owner', '&limit=1')).json.metadataMatches.length, 1);
    const refs = await search(f, 'John 3', 'owner', '&limit=1');
    assert.equal(refs.json.notesMatches.length, 1);
  });
});
