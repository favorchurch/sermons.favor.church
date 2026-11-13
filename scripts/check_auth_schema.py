#!/usr/bin/env python3
"""Exercise auth D1 migrations and owner/member protections in local SQLite."""
import sqlite3
from pathlib import Path
root=Path(__file__).resolve().parent.parent
connection=sqlite3.connect(':memory:')
connection.execute('PRAGMA foreign_keys=ON')
for path in sorted((root/'migrations').glob('*.sql')): connection.executescript(path.read_text())
connection.execute("INSERT INTO user_accounts(id,email_normalized,display_name) VALUES('owner','owner@example.test','Owner'),('viewer','viewer@example.test','Viewer')")
connection.execute("INSERT INTO workspaces(id,name,owner_account_id) VALUES('workspace','Private Test Archive','owner')")
connection.execute("INSERT INTO workspace_memberships(workspace_id,account_id,role,accepted_at) VALUES('workspace','owner','owner',CURRENT_TIMESTAMP),('workspace','viewer','viewer',CURRENT_TIMESTAMP)")
blocked=0
for statement in [
  "UPDATE workspace_memberships SET role='viewer' WHERE account_id='owner'",
  "UPDATE workspace_memberships SET revoked_at=CURRENT_TIMESTAMP WHERE account_id='owner'",
  "DELETE FROM workspace_memberships WHERE account_id='owner'",
  "INSERT INTO workspace_invitations(id,workspace_id,email_normalized,invited_role,token_hash,invited_by_account_id,expires_at) VALUES('i1','workspace','other@example.test','owner','secret-hash','owner',1890000000)",
  "INSERT INTO auth_sessions(token_hash,account_id,expires_at) VALUES('token-hash','absent',1890000000)",
  "INSERT INTO google_identities(subject,account_id) VALUES('google-subject','absent')"
]:
  try: connection.execute(statement)
  except sqlite3.IntegrityError: blocked+=1
  else: raise AssertionError('Invalid membership or credential write succeeded')
try: connection.execute("INSERT INTO workspaces(id,name,owner_account_id) VALUES('second','Second Archive','owner')")
except sqlite3.IntegrityError: blocked+=1
else: raise AssertionError('A second active workspace for one Owner was created')
assert blocked == 7
connection.execute("INSERT INTO auth_sessions(token_hash,account_id,expires_at) VALUES('hashed-only','owner',1890000000)")
assert connection.execute("SELECT token_hash FROM auth_sessions").fetchone()[0]=='hashed-only'
assert connection.execute("PRAGMA foreign_key_check").fetchall()==[]
print('Auth schema applied; invalid role/identity/session writes blocked:',blocked)
connection.close()
