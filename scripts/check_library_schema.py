#!/usr/bin/env python3
"""Apply all migrations and verify the library schema (0004) guards."""
import sqlite3
from pathlib import Path

root = Path(__file__).resolve().parent.parent
c = sqlite3.connect(':memory:')
c.execute('PRAGMA foreign_keys=ON')
for path in sorted((root / 'migrations').glob('*.sql')):
    c.executescript(path.read_text())
c.execute("INSERT INTO user_accounts(id,email_normalized,display_name) VALUES('u1','a@example.test','A'),('u2','b@example.test','B')")
c.execute("INSERT INTO workspaces(id,name,owner_account_id) VALUES('w1','One','u1'),('w2','Two','u2')")
c.execute("INSERT INTO sermons(id,workspace_id,title) VALUES('s1','w1','S1')")
c.execute("INSERT INTO places(id,workspace_id,display_name) VALUES('p1','w1','Harbor'),('p2','w1','Main')")
blocked = 0
def expect_block(sql, args=()):
    global blocked
    try:
        c.execute(sql, args)
    except sqlite3.IntegrityError:
        blocked += 1
    else:
        raise AssertionError('Invalid write unexpectedly succeeded: ' + sql)
R = "INSERT INTO sermon_scripture_refs(workspace_id,sermon_id,position,reference_text) VALUES(?,?,?,?)"
c.execute(R, ('w1', 's1', 0, 'John 3:16'))
expect_block(R, ('w2', 's1', 0, 'John 3:16'))   # cross-workspace FK
expect_block(R, ('w1', 's1', 0, 'Dup'))          # position unique
expect_block(R, ('w1', 's1', 1, '  '))           # blank
A = "INSERT INTO place_aliases(workspace_id,place_id,alias) VALUES(?,?,?)"
c.execute(A, ('w1', 'p1', 'The Harbor'))
expect_block(A, ('w1', 'p2', 'the harbor'))      # alias unique ignoring case
M = "INSERT INTO place_merges(id,workspace_id,source_place_id,source_display_name,target_place_id,moved_event_count) VALUES(?,?,?,?,?,?)"
c.execute(M, ('m1', 'w1', 'x1', 'Old', 'p1', 0))
expect_block(M, ('m2', 'w1', 'x1', 'Old', 'p2', 0))  # one merge per source
expect_block(M, ('m3', 'w1', 'p2', 'Main', 'p2', 0))  # self merge
c.execute("DELETE FROM sermons WHERE id='s1'")
assert c.execute('SELECT COUNT(*) FROM sermon_scripture_refs').fetchone()[0] == 0, 'refs must cascade'
assert blocked == 6, blocked
assert c.execute('PRAGMA foreign_key_check').fetchall() == []
print('Library schema verified; invalid writes blocked:', blocked)
