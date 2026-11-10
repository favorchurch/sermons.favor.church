# Sermon Bank — Selected Hybrid: The Living Library + Chronicle

**Status:** New user-selected visual direction for Phase C refinement (10 November 2026). Supersedes C-neutral Quiet Workspace as the preferred overall layout, while retaining the calm, church-neutral color palette and the consolidated navigation.

**Interactive prototype:** [living-library-chronicle.html](living-library-chronicle.html) — one offline HTML file. Contains fictional data only and no requests to Google, Rock, D1 or R2.

## Visual direction

- The Living Library (concept A) is the core identity: tactile animated bookshelf, illustrated book covers, spacious editorial hero, gentle CSS motion, reduced-motion fallback.
- The Memory Atlas (concept B) contributes its **month-by-month calendar**: a 12-month year overview, a full monthly grid with preaching markers, selected-day inspector, month arrows, year navigation and links back to the same canonical sermon record.
- **My Sermons ▾** opens the workspace selector. Top navigation has only **Library** and **Settings**. Library has Covers / Quick rows / Table / Calendar; Settings contains Places, People & Access, Import Review, Docs & Privacy, Preferences and Workspace.
- Keep soft sage / paper / moss colors and generic product identity, not heavy Favor branding or protected church font assets.

## The new crucial search contract: Bible verses in the **notes**

### Two different kinds of evidence

1. **Sermon Scripture (metadata):** the record lists a passage, e.g., `Joshua 1:1–9`. Searching `Joshua 1:2` can match the range and will be visibly labeled **Sermon passage — not necessarily a notes match**.
2. **Indexed source text:** an authorized, indexed PDF or read-only Google Doc version actually contains an explicit reference or queried wording. Return the *named version*, source type and a highlighted excerpt from that indexed text. This is the answer to “Is this verse in my notes for this particular sermon?”

Do **not** present a metadata passage match as proof that the verse appears in the attached notes. Do **not** infer an occurrence merely because a known Bible translation includes that verse. Phrase search only matches words actually contained in the indexed document; translation/licensing remains separate.

### Query and UX expectations

- Global search scopes: **Everything**, **Bible verses**, **Inside notes only**.
- The reference resolver accepts common book aliases (`John`, `Jn`; `Romans`, `Rom`), standard chapter:verse notation and same-chapter verse ranges. Searching `John 3:16` should find an indexed text reference `John 3:16–18`; searching `Joshua 1:2` should match sermon-passage metadata `Joshua 1:1–9` but **not** invent a notes hit.
- Users can instead search literal wording such as `God so loved` in accessible indexed notes. For text that uses no explicit reference, reference-to-verse-**wording** matching would require a trusted, translation-specific Bible text index and user language selection; **not promised in V1**.
- Per-sermon detail includes a **Find in notes** tab. It searches every authorized, indexed version of that sermon, shows version-specific hits and unavailable version statuses, and distinguishes “not in indexed notes” from “not searchable due to pending/revoked authorization.”
- A global verse search should deep-open a sermon into Find in notes with the query pre-filled. Clear filters and change search scope without losing the sermon’s identity.
- Search operates under current workspace permissions and Owner consent. No cross-workspace result counts, snippets or autocomplete. A revoked original removes derived index text before results are returned. Show pending, revoked and unindexed statuses without leaking content.

### Production implementation notes (not yet implemented)

- Build a real version-scoped search index in D1/FTS5 containing extracted text, source offsets, reference tokens (canonical book/chapter/verse), normalized aliases, source grant/consent version and indexing timestamps.
- Store reference ranges and provenance: precise source file/version, matched text span, permission gate. Don't claim a match to unseen scanned/image-only PDFs; OCR remains deferred.
- Google Docs only through least-privilege authorized read flows; originals stay in Google Drive. R2 PDFs immutable. No auto-sync of edited Google Docs and no app write path to original notes.
- Workspaces are authenticated on the server. The static demo’s editable records, role selector, source excerpts and simulated results are not production logic.

## Prototype QA

Chromium execution test: **37 checks passed, zero failures**, covering A’s bookshelf, role-aware tabs, 3 search lenses, John/Jn alias matching, range-overlap metadata, version-labeled indexed note excerpts, refusal to expose revoked-only note text, within-sermon positive/negative searches, phrase search, year mosaic, month navigation, marked-day inspector, create draft, Viewer restrictions, Settings consolidation, workspace isolation and phone overflow.

**Not verified / still required:** production APIs, genuine PDF/Google Docs extraction, live permission revocation propagation, actual account sessions, server-side RBAC, external Bible text licensing, OCR, screen-reader review and formal release QA.

## Decision

**Selected for further refinement:** A + the monthly calendar from B + notes-first Bible verse search. This is a user-directed update to the previously selected C-neutral UX. Keep the predecessor branches and prototype references as history; do not merge the stacked design PRs until the new direction is reviewed.

Source of locked business/privacy decisions: [PRD #1](https://github.com/favorchurch/sermons.favor.church/pull/1). Existing canonical design issue: [#2](https://github.com/favorchurch/sermons.favor.church/issues/2).
