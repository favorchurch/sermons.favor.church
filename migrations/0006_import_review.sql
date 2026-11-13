ALTER TABLE sermons ADD COLUMN source_import_row_id TEXT;
ALTER TABLE places ADD COLUMN source_import_row_id TEXT;
CREATE TABLE import_review_batches (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_sheet TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES user_accounts(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id, source_sheet, source_fingerprint),
  UNIQUE(workspace_id, id)
);
CREATE TABLE import_review_rows (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  source_sheet TEXT NOT NULL,
  source_row INTEGER NOT NULL CHECK(source_row > 0),
  source_hash TEXT NOT NULL,
  original_values_json TEXT NOT NULL CHECK(json_valid(original_values_json)),
  proposed_title TEXT,
  proposed_date TEXT,
  proposed_place TEXT,
  parse_outcome TEXT NOT NULL CHECK(parse_outcome IN ('parsed','invalid')),
  review_flags_json TEXT NOT NULL CHECK(json_valid(review_flags_json)),
  status TEXT NOT NULL DEFAULT 'unreviewed' CHECK(status IN ('unreviewed','attested','ignored','approved','rollback_conflict','rolled_back')),
  attested_by TEXT REFERENCES user_accounts(id),
  attested_at TEXT,
  sermon_id TEXT,
  event_id TEXT,
  place_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(batch_id, source_row),
  FOREIGN KEY(workspace_id, batch_id) REFERENCES import_review_batches(workspace_id, id) ON DELETE CASCADE,
  CHECK(status NOT IN ('attested','approved','rollback_conflict','rolled_back') OR (attested_by IS NOT NULL AND attested_at IS NOT NULL))
);
CREATE INDEX idx_import_review_rows_batch ON import_review_rows(workspace_id, batch_id, source_row);
CREATE UNIQUE INDEX idx_import_sermon_source ON sermons(workspace_id, source_import_row_id) WHERE source_import_row_id IS NOT NULL;
CREATE UNIQUE INDEX idx_import_event_source ON preaching_events(workspace_id, source_import_row_id) WHERE source_import_row_id IS NOT NULL;
