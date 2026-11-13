# Private import review

Only workspace Owners can access these endpoints. Send same-origin JSON requests under `/api/workspaces/:workspaceId`.

1. `POST /imports` with `{ "csv": "...", "source_sheet": "All History" }` stages the canonical CSV. The sheet is optional and defaults to All History. Re-uploading identical content returns the existing batch ID. The maximum JSON body is 10 MiB.
2. `GET /imports/:batchId/summary` returns total, parsed, invalid, flagged, attested and approved counts. `GET /imports/:batchId/rows` returns proposed values, provenance, flags and status; original source cells remain private in staging.
3. Review each row and its flags. `POST /imports/:batchId/attest` with `{ "row_ids": ["..."] }` records the Owner's explicit ownership attestation. `POST /imports/:batchId/rows/:rowId/ignore` excludes a row from approval. Attesting an ignored or fully rolled-back row explicitly starts a new review of that row.
4. `POST /imports/:batchId/rows/:rowId/approve` creates a sermon and event, reusing a matching place or alias where available. An undated event remains undated; a first-of-month date retains a needs-review precision. Repeated approval does not create another event.
5. `POST /imports/:batchId/rows/:rowId/rollback` removes the records created for that row only when they remain unedited and unreferenced. If they have been edited or acquired dependencies, the row enters `rollback_conflict` and remains available for manual review. A previously existing place is never removed.

Flags are review prompts, not automatic decisions. In particular, a title alone is never considered a duplicate; the title, date and place must all match. Approval is separate from attestation, and no owner is inferred from the source file.
