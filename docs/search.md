# Notes index and search API

Search over sermon metadata and over indexed note text. Routes live under
`/api/workspaces/:workspaceId` and follow the access rules in [library-api.md](library-api.md):
session required, active membership required, any member (Viewer included) may search, and
another workspace's ids or text produce `404 {"error":"not_found"}` or empty arrays with no counts.

## Routes

| Method | Path | Notes |
|---|---|---|
| GET | `/search?q=` | `archived=exclude\|include` (default exclude), `limit` 1-50 (default 20) |
| GET | `/sermons/:sermonId/find-in-notes?q=` | per-version status for one sermon (archived sermons allowed) |

`q` is required, at most 200 characters and 12 words, otherwise `400 {"error","field":"q"}`.

## Query semantics

- A Bible reference (`John 3:16`, `Jn 3:16-18`, `Romans 8`) is resolved by `src/search/bible.ts` and matched by
  overlap of canonical book/chapter/verse ranges. A whole-chapter reference overlaps any verse in that chapter.
- Anything else is **one phrase** of its words. Words must appear in that order and adjacent in the indexed text.
  Matching is case-insensitive and folds diacritics, with no prefix or fuzzy matching.
- User input never reaches FTS5 as syntax. Each word is reduced to letters and digits and the whole phrase is
  double-quoted, so `OR`, `NEAR(...)`, `*`, `^`, `-`, `col:` and unbalanced quotes are plain words or punctuation
  and cannot error or widen the search. Candidates from FTS5 are re-verified against the stored text.

## `GET /search`

```json
{
  "query": {"kind": "reference", "label": "John 3:16"},
  "metadataMatches": [
    {"sermon_id": "…", "sermon_title": "…", "source": "sermon_passage", "label": "Sermon passage", "passage": "John 3:14-17"}
  ],
  "notesMatches": [
    {"sermon_id": "…", "sermon_title": "…", "version_id": "…", "version_label": "Original", "source_type": "google_doc",
     "match_count": 2, "offset": 38,
     "excerpt": {"text": "…", "text_offset": 0, "highlights": [{"start": 29, "end": 38}]}}
  ],
  "limit": 20
}
```

- `metadataMatches` come from the sermon's own scripture references and only exist for reference queries. They never
  read note text.
- `notesMatches` come from indexed note text, one entry per version, best match first.
- A sermon whose passage overlaps the query but whose notes do not contain it appears only in `metadataMatches`.
- `offset` is the start of the first match in the full stored text. `excerpt.text_offset` is where the excerpt starts
  in that text and `highlights` are offsets inside `excerpt.text`. All offsets are UTF-16 code units (JavaScript string indexes).

## `GET /sermons/:sermonId/find-in-notes`

Returns every version of the sermon with one status:

| `status` | Meaning | Extra fields |
|---|---|---|
| `matched` | Indexed and the query is in the notes | `match_count`, `excerpts[]` (up to 10) |
| `not_in_notes` | Indexed and the query is not in the notes | `match_count: 0` |
| `not_searchable` | No searchable text | `reason` only: `pending`, `revoked` or `unindexed` |

`reason`: `pending` for `awaiting_consent` and `queued`, `revoked` for `revoked`, `unindexed` for `not_indexed`,
`failed`, and `indexed` with no stored text (for example after a purge). Non-searchable versions never include an
excerpt or count.

## Indexing (module API, no HTTP route yet)

`src/search/index.ts` exports what the Google Doc ingest and consent flows will call:

- `indexVersion(db, {workspaceId, versionId, text, actorId?})` replaces the version's stored text, full-text entry
  and reference tokens, sets `indexing_state = 'indexed'` and writes a `version.index` audit row (counts only).
  It throws `IndexRefused` with `version_not_found`, `consent_required`, `empty_text` or `text_too_large`
  (400,000 characters). Consent means `index_consent_at` is set, `index_consent_by` is an active, accepted Owner of
  the same workspace, the state is `queued` or `indexed`, and the sermon is not deleted. The check is repeated inside the
  write, so nothing is stored if consent disappears in between.
- `purgeVersionIndex(db, workspaceId, versionId)` deletes the text, tokens and full-text entry. It does not change
  `indexing_state`: the revoke flow sets that. Search ignores any version whose state is not `indexed`, so a revoked
  version is invisible even before its purge runs.

## Tables (migration 0005)

- `note_texts`: one row per indexed version (`workspace_id`, `sermon_id`, `version_id`, `body`, `consent_at`).
- `note_fts`: FTS5 external-content index over `note_texts.body` kept in sync by triggers.
- `note_reference_tokens`: `workspace_id`, `version_id`, canonical `book`, `chapter`, `verse_start`/`verse_end`
  (both NULL for a whole chapter), `text_start`/`text_end` offsets and `consent_at`.

Composite foreign keys keep every row in its workspace, and deleting a version, sermon or workspace cascades to the
text, tokens and full-text entries. FTS5 and `json_each` are used, both available in D1.
