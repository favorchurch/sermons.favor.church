#!/usr/bin/env python3
"""Apply all migrations and verify the notes index schema (0005) guards."""
import sqlite3
from pathlib import Path

root = Path(__file__).resolve().parent.parent
c = sqlite3.connect(':memory:')
c.execute('PRAGMA foreign_keys=ON')
for path in sorted((root / 'migrations').glob('*.sql')):
    c.executescript(path.read_text())
c.execute("INSERT INTO user_accounts(id,email_normalized,display_name) VALUES('u1','a@example.test','A'),('u2','b@example.test','B')")
c.execute("INSERT INTO workspaces(id,name,owner_account_id) VALUES('w1','One','u1'),('w2','Two','u2')")
c.execute("INSERT INTO sermons(id,workspace_id,title) VALUES('s1','w1','S1'),('s2','w2','S2')")
c.execute("INSERT INTO sermon_versions(id,workspace_id,sermon_id,label,source_type) VALUES('v1','w1','s1','Orig','pdf'),('v2','w2','s2','Orig','pdf')")
blocked = 0
def expect_block(sql, args=()):
    global blocked
    try:
        c.execute(sql, args)
    except sqlite3.IntegrityError:
        blocked += 1
    else:
        raise AssertionError('Invalid write unexpectedly succeeded: ' + sql)

T = "INSERT INTO note_texts(workspace_id,sermon_id,version_id,body,consent_at) VALUES(?,?,?,?,?)"
c.execute(T, ('w1', 's1', 'v1', 'God so loved the world, John 3:16', '2025-06-01'))
expect_block(T, ('w2', 's1', 'v1', 'x', '2025-06-01'))        # cross-workspace FK
expect_block(T, ('w1', 's2', 'v1', 'x', '2025-06-01'))        # sermon must own the version
expect_block(T, ('w1', 's1', 'v1', 'again', '2025-06-01'))    # one text per version
expect_block(T, ('w2', 's2', 'v2', '', '2025-06-01'))         # empty body
expect_block(T, ('w2', 's2', 'v2', 'x', ''))                  # consent timestamp required
expect_block(T, ('w2', 's2', 'v2', 'x', None))

K = ("INSERT INTO note_reference_tokens(workspace_id,version_id,book,chapter,verse_start,verse_end,text_start,text_end,consent_at)"
     " VALUES(?,?,?,?,?,?,?,?,?)")
c.execute(K, ('w1', 'v1', 'John', 3, 16, 16, 24, 33, '2025-06-01'))
c.execute(K, ('w1', 'v1', 'Romans', 8, None, None, 0, 9, '2025-06-01'))   # whole chapter
expect_block(K, ('w2', 'v1', 'John', 3, 16, 16, 0, 9, '2025-06-01'))      # token in another workspace
expect_block(K, ('w1', 'v1', 'John', 3, 18, 16, 0, 9, '2025-06-01'))      # inverted range
expect_block(K, ('w1', 'v1', 'John', 3, 16, None, 0, 9, '2025-06-01'))    # half a range
expect_block(K, ('w1', 'v1', 'John', 0, 16, 16, 0, 9, '2025-06-01'))      # chapter bounds
expect_block(K, ('w1', 'v1', 'John', 3, 16, 16, 9, 9, '2025-06-01'))      # empty span
expect_block(K, ('w1', 'v1', 'John', 3, 16, 16, 0, 9, None))              # consent timestamp required
expect_block(K, ('w1', 'missing', 'John', 3, 16, 16, 0, 9, '2025-06-01'))  # needs indexed text

def fts(word):
    return c.execute('SELECT count(*) FROM note_fts WHERE note_fts MATCH ?', ('"%s"' % word,)).fetchone()[0]
assert fts('loved') == 1, 'insert trigger must feed the full-text index'
assert fts('LOVED') == 1
c.execute("UPDATE note_texts SET body='Grace alone' WHERE version_id='v1'")
assert fts('loved') == 0 and fts('grace') == 1, 'update trigger must replace full-text entries'
c.execute("DELETE FROM sermon_versions WHERE id='v1'")
assert fts('grace') == 0, 'deleting a version must remove its full-text entries'
assert c.execute('SELECT count(*) FROM note_texts').fetchone()[0] == 0, 'texts must cascade'
assert c.execute('SELECT count(*) FROM note_reference_tokens').fetchone()[0] == 0, 'tokens must cascade'

c.execute(T, ('w2', 's2', 'v2', 'Psalm 23 shepherd', '2025-06-01'))
c.execute("DELETE FROM workspaces WHERE id='w2'")
assert fts('shepherd') == 0 and c.execute('SELECT count(*) FROM note_texts').fetchone()[0] == 0, 'workspace delete must cascade'
assert blocked == 13, blocked
assert c.execute('PRAGMA foreign_key_check').fetchall() == []
c.execute("INSERT INTO note_fts(note_fts) VALUES('integrity-check')")
print('Search schema verified; invalid writes blocked:', blocked)
