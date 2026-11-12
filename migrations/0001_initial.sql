-- Sermon Bank foundational data model. Private data belongs in D1, never source control.
-- No public content endpoints are permitted before workspace authorization is implemented.
PRAGMA foreign_keys = ON;

CREATE TABLE user_accounts (
  id TEXT PRIMARY KEY,
  email_normalized TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  disabled_at TEXT
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(trim(name)) > 0),
  owner_account_id TEXT NOT NULL REFERENCES user_accounts(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);

CREATE TABLE workspace_memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES user_accounts(id),
  role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'editor', 'viewer')),
  accepted_at TEXT,
  revoked_at TEXT,
  PRIMARY KEY(workspace_id, account_id)
);
CREATE INDEX idx_membership_account ON workspace_memberships(account_id, revoked_at);

CREATE TABLE places (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL CHECK(length(trim(display_name)) > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id, id)
);
CREATE UNIQUE INDEX idx_places_normalized_name ON places(workspace_id, display_name COLLATE NOCASE);

CREATE TABLE place_aliases (
  workspace_id TEXT NOT NULL,
  place_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  PRIMARY KEY(workspace_id, alias),
  FOREIGN KEY(workspace_id, place_id) REFERENCES places(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE sermons (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK(length(trim(title)) > 0),
  scripture_passage TEXT,
  series_name TEXT,
  description TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_at TEXT,
  deleted_at TEXT,
  UNIQUE(workspace_id, id)
);
CREATE INDEX idx_sermons_workspace ON sermons(workspace_id, archived_at, created_at);

CREATE TABLE sermon_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  sermon_id TEXT NOT NULL,
  label TEXT NOT NULL CHECK(length(trim(label)) > 0),
  source_type TEXT NOT NULL CHECK(source_type IN ('google_doc', 'pdf', 'external')),
  source_url TEXT,
  google_document_id TEXT,
  r2_object_key TEXT,
  indexing_state TEXT NOT NULL DEFAULT 'not_indexed'
    CHECK(indexing_state IN ('not_indexed','awaiting_consent','queued','indexed','failed','revoked')),
  index_consent_by TEXT REFERENCES user_accounts(id),
  index_consent_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id, id),
  UNIQUE(workspace_id, sermon_id, id),
  FOREIGN KEY(workspace_id, sermon_id) REFERENCES sermons(workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_version_label ON sermon_versions(workspace_id, sermon_id, label COLLATE NOCASE);
CREATE INDEX idx_versions_sermon ON sermon_versions(workspace_id, sermon_id);

CREATE TABLE preaching_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  sermon_id TEXT NOT NULL,
  version_id TEXT,
  place_id TEXT,
  preached_on TEXT,
  raw_date TEXT,
  date_precision TEXT NOT NULL DEFAULT 'unknown'
    CHECK(date_precision IN ('exact','month','year','unknown','needs_review')),
  occasion TEXT,
  source_import_row_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id, id),
  FOREIGN KEY(workspace_id, sermon_id) REFERENCES sermons(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id, sermon_id, version_id)
    REFERENCES sermon_versions(workspace_id, sermon_id, id),
  FOREIGN KEY(workspace_id, place_id) REFERENCES places(workspace_id, id)
);
CREATE INDEX idx_preaching_by_date ON preaching_events(workspace_id, preached_on);
CREATE INDEX idx_preaching_sermon ON preaching_events(workspace_id, sermon_id);

-- Migration rows remain unassigned until a human verifies ownership.
-- Never directly expose raw_json through a client-readable endpoint.
CREATE TABLE import_batches (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('private_csv', 'google_sheets_readonly')),
  source_tab TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'staged' CHECK(state IN ('staged','reviewing','closed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_kind, source_tab, source_fingerprint)
);

CREATE TABLE import_rows (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  source_row_number INTEGER NOT NULL CHECK(source_row_number > 0),
  original_values_json TEXT NOT NULL CHECK(json_valid(original_values_json)),
  proposed_title TEXT,
  proposed_date TEXT,
  proposed_place TEXT,
  review_flags_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(review_flags_json)),
  review_note TEXT,
  review_status TEXT NOT NULL DEFAULT 'unreviewed'
    CHECK(review_status IN ('unreviewed','needs_review','verified','ignored')),
  verified_workspace_id TEXT REFERENCES workspaces(id),
  verified_by_account_id TEXT REFERENCES user_accounts(id),
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(batch_id, source_row_number),
  CHECK(review_status <> 'verified' OR
    (verified_workspace_id IS NOT NULL AND verified_by_account_id IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE INDEX idx_import_review ON import_rows(batch_id, review_status);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id),
  actor_account_id TEXT REFERENCES user_accounts(id),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(details_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_audit_workspace ON audit_events(workspace_id, created_at);
