#!/usr/bin/env python3
"""Validate D1 schema with local SQLite, including cross-workspace FK barriers."""
import sqlite3
from pathlib import Path

migration = Path(__file__).resolve().parents[1] / "migrations" / "0001_initial.sql"
connection = sqlite3.connect(":memory:")
connection.execute("PRAGMA foreign_keys = ON")
connection.executescript(migration.read_text(encoding="utf-8"))
connection.execute("INSERT INTO user_accounts(id,email_normalized,display_name) VALUES('u1','one@example.test','Fictional One'),('u2','two@example.test','Fictional Two')")
connection.execute("INSERT INTO workspaces(id,name,owner_account_id) VALUES('w1','Test One','u1'),('w2','Test Two','u2')")
connection.execute("INSERT INTO sermons(id,workspace_id,title) VALUES('s1','w1','Sample Sermon'),('s2','w2','Another Fictional Sermon')")
connection.execute("INSERT INTO places(id,workspace_id,display_name) VALUES('p1','w1','Harbor Chapel'),('p2','w2','River Chapel')")
connection.execute("INSERT INTO sermon_versions(id,workspace_id,sermon_id,label,source_type) VALUES('v1','w1','s1','Original','google_doc')")
connection.execute("INSERT INTO preaching_events(id,workspace_id,sermon_id,version_id,place_id,preached_on,date_precision) VALUES('e1','w1','s1','v1','p1','2025-01-01','needs_review')")

failed = 0

def expect_block(sql, args):
    global failed
    try:
        connection.execute(sql, args)
    except sqlite3.IntegrityError:
        failed += 1
    else:
        raise AssertionError("Cross-tenant or invalid write unexpectedly succeeded")

expect_block("INSERT INTO preaching_events(id,workspace_id,sermon_id,version_id,place_id) VALUES(?,?,?,?,?)", ('bad1','w2','s1',None,None))
expect_block("INSERT INTO preaching_events(id,workspace_id,sermon_id,version_id,place_id) VALUES(?,?,?,?,?)", ('bad2','w2','s2','v1','p2'))
expect_block("INSERT INTO preaching_events(id,workspace_id,sermon_id,version_id,place_id) VALUES(?,?,?,?,?)", ('bad3','w1','s1','v1','p2'))
expect_block("INSERT INTO sermon_versions(id,workspace_id,sermon_id,label,source_type) VALUES(?,?,?,?,?)", ('bad4','w2','s1','Other','pdf'))
expect_block("INSERT INTO sermon_versions(id,workspace_id,sermon_id,label,source_type) VALUES(?,?,?,?,?)", ('bad5','w1','s1','original','pdf'))
expect_block("INSERT INTO import_rows(id,batch_id,source_row_number,original_values_json,review_status) VALUES(?,?,?,?,?)", ('bad6','missing',42,'[]','verified'))

print("Schema created. Cross-workspace and invalid insert guards verified:", failed)
connection.close()
