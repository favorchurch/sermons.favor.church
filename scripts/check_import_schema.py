#!/usr/bin/env python3
"""Verify import staging isolation and attribution constraints."""
import sqlite3
from pathlib import Path

c = sqlite3.connect(':memory:')
c.execute('PRAGMA foreign_keys=ON')
for path in sorted((Path(__file__).resolve().parent.parent / 'migrations').glob('*.sql')):
    c.executescript(path.read_text())
c.executescript("""
INSERT INTO user_accounts(id,email_normalized,display_name) VALUES('u','u@example.test','U'),('v','v@example.test','V');
INSERT INTO workspaces(id,name,owner_account_id) VALUES('w','W','u'),('x','X','v');
INSERT INTO import_review_batches(id,workspace_id,source_sheet,source_fingerprint,created_by) VALUES('b','w','All History','hash','u'),('c','x','All History','hash','u');
""")
blocked = 0
for sql in [
    "INSERT INTO import_review_batches(id,workspace_id,source_sheet,source_fingerprint,created_by) VALUES('d','w','All History','hash','u')",
    "INSERT INTO import_review_rows(id,workspace_id,batch_id,source_sheet,source_row,source_hash,original_values_json,parse_outcome,review_flags_json) VALUES('r','x','b','All History',1,'h','[]','parsed','[]')",
    "INSERT INTO import_review_rows(id,workspace_id,batch_id,source_sheet,source_row,source_hash,original_values_json,parse_outcome,review_flags_json,status) VALUES('r','w','b','All History',1,'h','[]','parsed','[]','attested')",
]:
    try:
        c.execute(sql)
    except sqlite3.IntegrityError:
        blocked += 1
    else:
        raise AssertionError('invalid import write succeeded')
assert blocked == 3
assert not c.execute('PRAGMA foreign_key_check').fetchall()
print('Import schema verified; invalid writes blocked:', blocked)
