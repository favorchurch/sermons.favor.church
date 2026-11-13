-- Authentication and pilot access. No source documents, plaintext session tokens or
-- invitation secrets are stored. JWTs and Google OAuth credentials are never saved.
PRAGMA foreign_keys = ON;

CREATE TABLE google_identities (
  subject TEXT PRIMARY KEY CHECK(length(subject) > 0),
  account_id TEXT NOT NULL UNIQUE REFERENCES user_accounts(id) ON DELETE CASCADE,
  connected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE oauth_login_attempts (
  state_hash TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_oauth_expiry ON oauth_login_attempts(expires_at);

CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT
);
CREATE INDEX idx_sessions_account ON auth_sessions(account_id, expires_at);

CREATE TABLE workspace_invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email_normalized TEXT NOT NULL,
  invited_role TEXT NOT NULL CHECK(invited_role IN ('admin','editor','viewer')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by_account_id TEXT NOT NULL REFERENCES user_accounts(id),
  expires_at INTEGER NOT NULL,
  accepted_by_account_id TEXT REFERENCES user_accounts(id),
  accepted_at TEXT,
  acceptance_attempt_id TEXT UNIQUE,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((accepted_at IS NULL AND accepted_by_account_id IS NULL)
      OR (accepted_at IS NOT NULL AND accepted_by_account_id IS NOT NULL))
);
CREATE INDEX idx_invite_email ON workspace_invitations(email_normalized, expires_at);
CREATE INDEX idx_invite_workspace ON workspace_invitations(workspace_id, created_at);

-- The workspace's Owner must never be demoted or revoked through ordinary
-- membership management. A future audited ownership-transfer flow needs a
-- separate migration and explicit transaction design.
CREATE TRIGGER protect_owner_membership_update
BEFORE UPDATE ON workspace_memberships
WHEN OLD.role = 'owner' AND (
  NEW.role <> 'owner' OR NEW.revoked_at IS NOT NULL OR NEW.account_id <> OLD.account_id
)
BEGIN SELECT RAISE(ABORT, 'owner membership cannot be modified'); END;

CREATE TRIGGER protect_owner_membership_delete
BEFORE DELETE ON workspace_memberships
WHEN OLD.role = 'owner'
BEGIN SELECT RAISE(ABORT, 'owner membership cannot be deleted'); END;
