-- Notes index: consented, extracted note text with full-text search and structured
-- Bible reference tokens. Migrations 0001-0004 are never edited. Every row stays
-- workspace-scoped through composite foreign keys, and deleting a version, sermon or
-- workspace removes its indexed text, tokens and full-text entries.
PRAGMA foreign_keys = ON;

-- One row per indexed version. Rows are written only by src/search/index.ts, which
-- refuses unless an active Owner consented (sermon_versions.index_consent_by/at).
-- consent_at is copied from the version at indexing time.
CREATE TABLE note_texts (
  id INTEGER PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  sermon_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK(length(body) > 0),
  consent_at TEXT NOT NULL CHECK(length(consent_at) > 0),
  indexed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id, version_id),
  FOREIGN KEY(workspace_id, sermon_id, version_id)
    REFERENCES sermon_versions(workspace_id, sermon_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_note_texts_sermon ON note_texts(workspace_id, sermon_id);

-- Full-text index over note_texts.body. External content: the text is stored once.
CREATE VIRTUAL TABLE note_fts USING fts5(
  body, content='note_texts', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER note_texts_fts_insert AFTER INSERT ON note_texts BEGIN
  INSERT INTO note_fts(rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER note_texts_fts_delete AFTER DELETE ON note_texts BEGIN
  INSERT INTO note_fts(note_fts, rowid, body) VALUES ('delete', old.id, old.body);
END;
CREATE TRIGGER note_texts_fts_update AFTER UPDATE OF body ON note_texts BEGIN
  INSERT INTO note_fts(note_fts, rowid, body) VALUES ('delete', old.id, old.body);
  INSERT INTO note_fts(rowid, body) VALUES (new.id, new.body);
END;

-- Bible references found in indexed text. verse_start/verse_end are both NULL for a
-- whole-chapter reference. text_start/text_end are UTF-16 offsets into note_texts.body.
CREATE TABLE note_reference_tokens (
  id INTEGER PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  book TEXT NOT NULL CHECK(length(book) > 0),
  chapter INTEGER NOT NULL CHECK(chapter BETWEEN 1 AND 150),
  verse_start INTEGER CHECK(verse_start IS NULL OR verse_start BETWEEN 1 AND 999),
  verse_end INTEGER CHECK(verse_end IS NULL OR verse_end BETWEEN 1 AND 999),
  text_start INTEGER NOT NULL CHECK(text_start >= 0),
  text_end INTEGER NOT NULL,
  consent_at TEXT NOT NULL CHECK(length(consent_at) > 0),
  CHECK((verse_start IS NULL) = (verse_end IS NULL)),
  CHECK(verse_end IS NULL OR verse_end >= verse_start),
  CHECK(text_end > text_start),
  FOREIGN KEY(workspace_id, version_id)
    REFERENCES note_texts(workspace_id, version_id) ON DELETE CASCADE
);
CREATE INDEX idx_note_tokens_lookup ON note_reference_tokens(workspace_id, book, chapter, verse_start, verse_end);
CREATE INDEX idx_note_tokens_version ON note_reference_tokens(workspace_id, version_id);
