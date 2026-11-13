-- Library CRUD support: sermon scripture references, update timestamps, place merge
-- history and the indexes the workspace-scoped API relies on. Migrations 0001-0003 are
-- never edited. Every row stays workspace-scoped through composite foreign keys.
PRAGMA foreign_keys = ON;

-- ALTER TABLE cannot add a non-constant default, so updated_at stays NULL until the
-- first API edit. Readers fall back to created_at.
ALTER TABLE sermons ADD COLUMN updated_at TEXT;
ALTER TABLE sermon_versions ADD COLUMN updated_at TEXT;
ALTER TABLE preaching_events ADD COLUMN updated_at TEXT;
ALTER TABLE places ADD COLUMN updated_at TEXT;

-- Ordered scripture references for a sermon. sermons.scripture_passage remains as the
-- joined display text for the legacy column; this table is the structured source.
-- The API caps new references at 120 characters, but the backfill below copies legacy
-- free text verbatim, so the table does not cap length (truncating would lose data).
CREATE TABLE sermon_scripture_refs (
  workspace_id TEXT NOT NULL,
  sermon_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position >= 0),
  reference_text TEXT NOT NULL CHECK(length(trim(reference_text)) > 0),
  PRIMARY KEY(workspace_id, sermon_id, position),
  FOREIGN KEY(workspace_id, sermon_id) REFERENCES sermons(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_scripture_refs_text ON sermon_scripture_refs(workspace_id, reference_text COLLATE NOCASE);

INSERT INTO sermon_scripture_refs(workspace_id, sermon_id, position, reference_text)
SELECT workspace_id, id, 0, trim(scripture_passage)
FROM sermons WHERE scripture_passage IS NOT NULL AND trim(scripture_passage) <> '';

-- Aliases must be unique per workspace ignoring case, matching place display names.
CREATE UNIQUE INDEX idx_place_alias_nocase ON place_aliases(workspace_id, alias COLLATE NOCASE);
CREATE INDEX idx_aliases_place ON place_aliases(workspace_id, place_id);
CREATE INDEX idx_preaching_place ON preaching_events(workspace_id, place_id);

-- One row per merged place. The source place row is deleted by a merge, so ids here are
-- plain text rather than foreign keys. target_place_id is re-pointed if the target is
-- itself merged later, so history always resolves to a live place.
CREATE TABLE place_merges (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_place_id TEXT NOT NULL,
  source_display_name TEXT NOT NULL,
  target_place_id TEXT NOT NULL,
  merged_by_account_id TEXT REFERENCES user_accounts(id),
  moved_event_count INTEGER NOT NULL CHECK(moved_event_count >= 0),
  moved_aliases_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(moved_aliases_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(source_place_id <> target_place_id),
  UNIQUE(workspace_id, source_place_id)
);
CREATE INDEX idx_place_merges_target ON place_merges(workspace_id, target_place_id);

-- Archive, restore and every other mutation are recorded in audit_events; this index
-- serves per-record history lookups.
CREATE INDEX idx_audit_target ON audit_events(workspace_id, target_type, target_id, created_at);
