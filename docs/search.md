# Notes index and search API

Search over sermon metadata and over indexed note text. Routes live under
`/api/workspaces/:workspaceId` and follow the access rules in [library-api.md](library-api.md):
session required, active membership required, any member (Viewer included) may search, and
another workspace's ids or text produce `404 {"error":"not_found"}` or empty arrays with no counts.

## Routes

| Method | Path | Notes |
|---|---|---|
| GET | `/search?q=` | deep pass over indexed notes. `archived=exclude\|include` (default exclude), `limit` 1-50 (default 20) |
| GET | `/search/quick?q=` | quick pass over sermon metadata, same parameters, never reads note text |
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

## `GET /search/quick`

The fast first stage. It answers from the sermon's own metadata and never reads `note_texts`, `note_fts` or
`note_reference_tokens`. Same access rules and the same `q` validation as `/search` (missing `q`, over 200
characters or over 12 words return `400 {"error","field":"q"}`). `archived` and `limit` work as for `/search`.

Matching is the library filter's (`matchesQuery` in `public/assets/js/library-model.js`): `q` is split on whitespace,
and every term must appear, case-insensitive and with diacritics folded, somewhere in the title, series, Scripture
references or tags. For a Bible reference query it also includes sermons whose own passage overlaps the reference
(the `searchPassages` result), marked `passage`. Archived sermons are left out unless `archived=include`. Deleted
sermons never appear. Results are newest first.

```json
{
  "query": {"kind": "reference", "label": "John 3:16"},
  "matches": [
    {"sermon_id": "…", "sermon_title": "…", "series_name": null, "scripture_references": ["John 3:14-17"],
     "tags": [], "archived": false, "matched_on": ["passage"], "passage": "John 3:14-17"}
  ],
  "limit": 20
}
```

- `matched_on` lists every field that matched, in this order: `title`, `series`, `scripture`, `tags`, `passage`.
  A field is listed when at least one term appears in it. `passage` means the sermon's passage overlaps the
  reference, and then `passage` holds that passage text. A sermon that matches both ways lists both.
- A reference query with no overlapping passage still runs as text, so `John 3:16` also finds a sermon whose
  Scripture text contains "3:16".

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
  read note text. The search page no longer reads this list: it takes sermons from `/search/quick`.
- `notesMatches` come from indexed note text, one entry per version, best match first.
- A sermon whose passage overlaps the query but whose notes do not contain it appears only in `metadataMatches`.
- `offset` is the start of the first match in the full stored text. `excerpt.text_offset` is where the excerpt starts
  in that text and `highlights` are offsets inside `excerpt.text`. All offsets are UTF-16 code units (JavaScript string indexes).

## Search page: two stages

The Search page (the **Everything** scope, which the header search box opens) sends `/search/quick` and `/search` at
the same time and shows each answer as it arrives:

- **Sermons** (quick pass) renders as soon as `/search/quick` resolves, even while `/search` is pending.
- **Found in notes** (deep pass) sits below it. Until `/search` resolves it shows one muted line, "Searching notes…"
  (`aria-busy`).
- Each stage fails on its own. A failed deep request shows an inline error with **Try again** in the notes group and
  keeps the sermons. A failed quick request does the same in the sermons group. Try again repeats only that stage.
- A response only counts while it is still the one the page waits for. A later search, or a retry, drops an earlier
  response that arrives late, for either stage.
- **Inside notes** shows only the notes group and does not send the quick request. **Bible verses** needs a Bible
  reference (and says so when it is not one), and otherwise shows both groups. Switching scope reuses answers already
  fetched and sends only the request the new scope still needs.
- Result items link to the sermon's notes tab as before. The count line ("5 results for “grace”") counts what is
  shown. While the deep pass is pending it reads "N results so far for …" and updates when the deep pass lands. The
  page's live region speaks once per stage that lands (and once on a scope change), not on every render.

## `GET /sermons/:sermonId/find-in-notes`

Returns every version of the sermon with one status:

| `status` | Meaning | Extra fields |
|---|---|---|
| `matched` | Indexed and the query is in the notes | `match_count`, `excerpts[]` (up to 10) |
| `not_in_notes` | Indexed and the query is not in the notes | `match_count: 0` |
| `not_searchable` | No searchable text | `reason` only: `pending`, `revoked` or `unindexed` |

`reason`: `pending` for `awaiting_consent` and `queued`, `revoked` for `revoked`, `unindexed` for `not_indexed`,
`failed`, and `indexed` with no stored text (for example after a purge). Non-searchable versions never include an
excerpt or count. Every version of the sermon is reported; there is no cap or pagination.

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
