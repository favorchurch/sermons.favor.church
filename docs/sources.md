# Private PDF versions

A version with `source_type: "pdf"` can hold one uploaded PDF in the private R2 bucket (`PRIVATE_PDFS`). Its text
is extracted on the server, held unindexed until an Owner consents, and deleted everywhere on revoke. Routes live
under `/api/workspaces/:workspaceId` and follow [library-api.md](library-api.md): session, active membership and
same-origin for non-GET. Another workspace's ids resolve to `404 {"error":"not_found"}`.

## Routes

All paths start `/sermons/:sermonId/versions/:versionId`.

| Method | Path | Who | Result |
|---|---|---|---|
| POST | `/pdf` | Editor, Admin, Owner | Raw `application/pdf` body. `201 {version_id, indexing_state, bytes, characters}` |
| GET | `/pdf` | any member | The file, streamed |
| POST | `/consent` | Owner only | Indexes the held text. `200 {indexing_state: "indexed", characters, references, held_text_deleted}` |
| POST | `/revoke` | Owner only | `200 {indexing_state: "revoked"}` |

Viewers get `403` on the three POST routes before the body is read.

## Upload

- Refused before anything is stored: wrong content type (`415`), body that does not start with `%PDF-` (`415 not_a_pdf`),
  more than 10 MiB (`413`, checked on `Content-Length` and again while reading), a version that is not `pdf`
  (`409 not_pdf_version`), or a version that already has a file (`409 pdf_already_uploaded`).
- The object key is `workspaces/<workspaceId>/pdfs/<sha256 of the bytes>.pdf`. If that object exists it is reused and
  never rewritten (a head check plus an R2 `etagDoesNotMatch: "*"` conditional put). Identical files in different
  workspaces get different keys.
- `sermon_versions.r2_object_key` is set once, in a statement guarded by `r2_object_key IS NULL`. The key is never
  returned by any route. A second upload, even of different bytes, is `409`. To replace a file, create a new version.
- Text extraction uses [`unpdf`](https://github.com/unjs/unpdf) (pdf.js built for Workers, pinned in `package.json`).
  It is all or nothing:
  - success: the text is written to `workspaces/<workspaceId>/extracted/<versionId>.txt` and the version becomes
    `awaiting_consent`. Nothing is added to `note_texts`, `note_fts` or `note_reference_tokens`, so search cannot see it.
  - failure (`unreadable`, `no_text` for scanned or empty PDFs, `text_too_large` over 400,000 characters, or `storage`):
    the version becomes `failed`, no text is stored anywhere, and the response is still `201` with `indexing_state: "failed"`
    and a `reason`. The PDF itself stays stored and downloadable. A `failed` version is final because its file is set once.
- If the move to `awaiting_consent` fails after the text was held (database error, or a revoke landed first), the held
  text is deleted at once and the version becomes `failed` (`reason: "storage"`), or stays `revoked`.
- If the Worker stops between storing the file and extracting, or after holding the text, the version keeps its key and
  stays `not_indexed`, possibly with held text. An Owner revoke is the purge route for it (see Revoke).

## Consent

Only an Owner can consent (`can(role, "consent")`). It requires `awaiting_consent` (`409 not_awaiting_consent`
otherwise). In order: the version moves to `queued` with `index_consent_by` and `index_consent_at` set, the held
text is read and passed to `indexVersion` (see [search.md](search.md)), then the held copy is deleted. A failed delete
is not an error: the index is already committed, the response is `200` with `held_text_deleted: false`, and the Owner
repeats `POST /consent` to retry. On an `indexed` version that call never reindexes. It only deletes the held copy and
reports `held_text_deleted` (`403` for non-Owners). Revoke also deletes the held copy. If the held
text is missing or unusable the version becomes `failed` and the consent fields are cleared. A revoke that lands
in between wins: indexing refuses and the version stays `revoked`. A storage or database error (not a refusal) puts
the version back to `awaiting_consent` with consent cleared (`version.consent_reset`) so the Owner can retry.

## Revoke

Only an Owner can revoke. It works from `awaiting_consent`, `queued`, `indexed`, `failed` and `not_indexed` with a stored PDF
(an interrupted upload), and is `409 nothing_to_revoke` for `not_indexed` with no PDF. The version is set to `revoked` first, so search and download stop at once.
Then `purgeVersionIndex` deletes the text, full-text entry and reference tokens, and the held text is deleted.
Calling revoke again finishes any deletion that failed. Revoked is final: consent, upload and indexing are refused.
The stored PDF object is kept but cannot be downloaded.

## Download

Any member. `404` when the version has no file, `410 {"error":"revoked"}` after revoke. The body is streamed from
R2 with `Content-Type: application/pdf`, `Content-Disposition: attachment; filename="sermon-version-<id>.pdf"`,
`Cache-Control: no-store, private`, `X-Content-Type-Options: nosniff` and a sandboxing CSP.

## Audit

`version.pdf_upload` (bytes), `version.pdf_extracted` (characters), `version.pdf_extract_failed` (reason),
`version.consent`, `version.consent_reset`, `version.index` (counts, written by the index), `version.index_failed` (reason),
`version.revoke` (previous state). Details hold ids, counts and reason codes only.
