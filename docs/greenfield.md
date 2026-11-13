# Greenfield v0: engineering gates

## Scope of this foundation PR

- Public repository scaffold; private-by-default Worker with `/health` only.
- D1 schema for identity, owner-scoped workspaces, roles, canonical sermons, versions, preaching history, places, migration provenance and audit events.
- Offline importer that conservatively parses one private source export and emits only aggregated diagnostics by default.
- Pure tests and a schema integrity check; no secrets or actual pastoral data checked in.

## First online pilot, in order

1. Provision isolated Cloudflare staging and production Workers/D1/R2 resources, configure secrets outside GitHub and pin deployed IDs. Confirm free-tier limits and budget alerts.
2. Add Google/email authentication, session rotation, invitation acceptance and server-side tenant/RBAC checks. Create workspace-scoped queries and negative cross-tenant tests before exposing data APIs.
3. Implement private dry-run staging uploads and owner attribution review. The canonical workbook historical tab is source; overlapping hidden tabs are reconciliation only. Read-only importer, replay-safe keys, confidence flags, row-level audit and human approval.
4. Add sermon master/version/preaching CRUD, place alias merging, version-scoped monthly calendar and mobile Living Library. Original Docs/PDFs never edited.
5. Add read-only Google Picker/OAuth, explicit Owner indexed-text consent, private R2 PDFs and source-revoked index deletion. Enforce authorization in every search path, including counts and snippets.
6. Add Bible-reference aliases/range normalization, distinguish sermon passage metadata vs confirmed indexed-note occurrences, include the matched document version and offset.
7. Run pilot invite-only with pastoral reviewers, validate counts/ownership, recovery, access revocation, accessibility, data deletion/export, D1/R2 quotas and latency; then decide public onboarding.

## Backfill audit snapshot (aggregates only)

- Canonical history tab: 415 populated historical rows in the current workbook; 414 include a date and title.
- 299 case-folded distinct titles; 51 exact venue labels; repeated titles are legitimate preaching-history candidates, not automatically duplicates.
- 91 rows carry a date on day 1 of a month. Treat this as **possible** date-precision ambiguity, not proof of an incorrect day.
- There is no explicit owner column or source-document link in that tab; don't infer a private workspace owner or index a nonexistent Google Doc.
- Workbook timezone and date-only values must not be converted into a timestamp that shifts the calendar day.
- Workbook may have changes beyond its last audited historical preaching; freshness and sign-off required before importing.

## Data trust / implementation gates

- Store raw input rows and source provenance only in private data stores; `source_sheet`, `source_row`, source fingerprint and review flags survive deduplication attempts.
- Do not import source records directly into a pastor workspace. Keep unassigned staging until a human reviews ownership and duplicates.
- Keep every original source value; additions/alias merges do not overwrite raw history.
- Sensitive document text must never appear in public GitHub commits, client logs or observability events.
- `wrangler deploy` is forbidden until real resources, server RBAC, consent, tested migration path and domain configuration exist.

## Known Phase 0 limitations

- No real OAuth/session/permission enforcement, UI, D1 runtime query, R2 upload, Google indexing or backend import endpoint yet.
- The operator dry run can export a local private review payload; this is not a database import or ownership approval.
- Date precision and title normalization are deliberately conservative. An identical title does not imply identical sermon content or owner.
- CI installs with `pnpm install --frozen-lockfile` against the committed `pnpm-lock.yaml`.
