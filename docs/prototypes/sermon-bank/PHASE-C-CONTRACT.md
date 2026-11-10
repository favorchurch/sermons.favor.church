# Sermon Bank — Phase C: Refined UX and implementation contract

**Date:** 10 November 2026  
**Selected direction:** C — Neutral Quiet Workspace (user-approved)  
**Requirements:** [PRD v1.0, draft PR #1](https://github.com/favorchurch/sermons.favor.church/pull/1)  
**Canonical interactive prototype:** [phase-c.html](phase-c.html) (uses [phase-c.css](phase-c.css) and [phase-c.js](phase-c.js))  
**Reference screenshot:** [selected-workspace.svg](selected-workspace.svg) · **Design issue:** [#2](https://github.com/favorchurch/sermons.favor.church/issues/2)

## 1. Product invariants

1. Private pastor workspaces, with no public sermon search, no cross-workspace results and no routine Favor Church operator visibility.
2. One canonical sermon master; multiple explicit named versions and multiple preaching occasions. Re-preaching never creates a duplicate master record.
3. **Never edit an existing Google Doc or overwrite an existing PDF**. All UI edits mutate only application-owned metadata, relations, and independent new uploads.
4. Google Docs remain in Google Drive; an Owner explicitly consents before extracted text may be indexed and searched by authorized workspace members. Original Google permissions are separate.
5. Source authorization loss means derived index and snippets are revoked promptly; never show unauthorized stale data.
6. Source files, migration evidence, names and real records remain private. This public prototype uses fictional samples, without OAuth tokens or personal information.
7. Roles are Owner, delegated Admin, Editor, Viewer. Only Owner can grant Admin, permanently delete, transfer ownership or initiate full export. No app role can change original source bytes.

## 2. Selected layout and navigation

Desktop: a left sidebar for **Archive, Preaching History, Places, Settings**, plus clearly labeled current workspace and a prominent Add Sermon action. Main archive is a compact, searchable row/list interface rather than a card gallery or timeline landing page. Each sermon row displays title, Scripture/series, last preached date, indexed-document status, version count and Open action. A separate History section shows chronological occurrences. Additional workspaces are under Settings, not on the primary daily navigation.

Tablet: narrow sidebar, trim secondary columns first; preserve title, date and action with comfortable tap targets. Mobile: horizontal top navigation, compact prioritized rows, stacked forms, and dialogs as scrollable bottom sheets. No five-column desktop table squeezed onto a small phone. Visual styling is neutral sage/gray and warm white, high-contrast charcoal type, restrained green accents and simple rules. Do not use Favor Church logos, proprietary fonts or dominant orange treatments.

## 3. Complete user journeys

### 0 — Onboarding and assistant invite acceptance

- Introduce independent Google sign-in or a verified email link; never require a Rock RMS account.
- Distinguish **I have my own sermons** (one private default workspace) from **A pastor invited me** (verify invitation, enter only that pastor's shared workspace, personal workspace optional).
- Keep extra owned/shared workspaces in Settings after the first-use decision. Verify target workspace, invitation expiry and role server-side before exposing any records or index snippets.
- The offline prototype simulates entry choices only. It neither sends verification email nor creates actual identity, invitation, or workspace records.



### A — Create a sermon and edit metadata

- Add Sermon → title required; Scripture, series, tags and description optional. A title alone creates a draft with zero preachings and zero versions.
- Later editing changes only database metadata, never the source PDF/Doc or historical snapshots.
- Confirm save; if a write fails, show an error and preserve form input, not simulated success.
- From a new sermon offer Add Version and Log Preaching as next actions.

### B — Attach a named version

- From a sermon choose Add Version; supply distinct label and source type: Google Doc, new PDF upload, or external HTTPS link.
- Google access in production is via file-scoped read-only Picker/OAuth. A pasted link never grants indexing authority by itself.
- Owner must explicitly approve disclosure that all authorized workspace roles can search the derived indexed text, even when they cannot open the Google source directly.
- Represent statuses: Awaiting Owner Consent, Awaiting Indexing, Indexed, Indexing Failed, Source Access Revoked, PDF Upload Pending, Link Only. Unauthorized or pending documents never contribute snippets.
- PDF bytes are immutable private uploads. Replacement is a separate attachment/version. No automatic Google Doc snapshot and no app mutation of originals.
- Prototype version creation only registers a fictional reference; no upload, source grant, or actual text extraction occurs.

### C — Log another preaching

- Select existing sermon, local preached date, church/venue, occasion, optional note, and an explicit named version from the same sermon (or Not Specified).
- The record is associated with the existing master; never copy the sermon.
- Show chronological history and totals; preserve uncertain date precision (exact day, month only, year only, unknown) in the form and importer instead of inventing an exact date.
- Restrict version selection to versions of the chosen sermon.

### D — Search and return

- Search title, Scripture, series, tags, event, church, year and private authorized note content. Show highlighted snippets and their version only when indexed and permitted.
- Provide church/year filters, sorting by latest preaching/title/number of preachings, and Clear Filters. Archived records are separate from active.
- Opening a sermon then returning keeps the current workspace, filters, search and scroll position; future implementation should serialize navigable query state into the URL.
- Distinguish an empty workspace from no search matches and from network error, denied access and revoked source.

### E — Places: rename or merge

- Select the canonical place, show number of affected preaching records, then rename or merge into an existing location.
- Confirm the impact before writing. Update all relationships, search and filter labels and retain aliases for lookup. Support a recovery/audit strategy in production.
- Do not edit text inside linked original Google Docs or PDFs.

### F — Members and workspace scope

| Action | Owner | Admin | Editor | Viewer |
|---|:---:|:---:|:---:|:---:|
| Read records and authorized index | Yes | Yes | Yes | Yes |
| Edit/app archive, versions, preachings, places | Yes | Yes | Yes | No |
| Invite/revoke Editor and Viewer | Yes | Yes | No | No |
| Grant/revoke Admin | Yes | No | No | No |
| Approve indexed-text sharing | Yes | No | No | No |
| Export entire workspace | Yes | No | No | No |
| Transfer ownership / permanent deletion | Yes | No | No | No |
| Edit original Doc / overwrite PDF through app | No | No | No | No |

Invitation preview identifies target workspace and role. In production, deliver email only when accepted by the server after authorization and expiry validation. Revocation invalidates current session/app access, index snippets, file downloads, and pending grants. Admin may not remove the Owner or another Admin. Workspace switching clears old filter/session UI and must not leak prior workspace counts or results. Invited assistants can default to the shared workspace without being forced into a personal archive first.

### G — Private migration and recovery

Import originals into private staging, preserving all records, IDs, source documents and uncertainties. Review probable duplicate, missing owner, missing title, ambiguous location and date flags. Editors can leave notes; Owner/authorized human checks provenance before assigning a record to a pastor workspace. No automatic destructive dedupe or ownership guesses. Keep originals read-only.

Archiving is reversible by Editor/Admin/Owner; permanent deletion and full export are Owner-only. Permanent deletion uses a high-friction confirmation, stated scope, recovery/retention policy and audit event. Export includes owned metadata and original stored PDFs; external Google Docs remain linked references, not copied originals.

## 4. States, errors and accessibility

| State | What to show | Safe next action |
|---|---|---|
| Loading | Busy/quiet skeleton, no stale protected data | Wait for result; retry if timed out |
| First-use empty | No sermons (not an error) | Add sermon, if Editor+ |
| Search no matches | Explicit zero results scoped to filters | Clear filters |
| Service error | No simulated success, no partial write claim | Retry, preserve unsaved form |
| Access denied | Zero titles, counts, snippets, file URLs | Return/switch workspace or reauthenticate |
| Awaiting Owner consent | Metadata/reference only, no index | Owner review and consent |
| Indexing queued | Pending label, no matching text snippet | Retry/await authorized processing |
| Source revoked | Index/snippet removed, metadata still scoped | Reauthorize with Owner's explicit consent |
| PDF upload pending | No claim that file was stored | Retry new immutable upload |
| Archived | Out of active list, included in archived view | Restore |
| Permanently deleted | Owner-only confirmed action | Respect retention, audit and backup lifecycle |

Accessible dialogs: focus at title/first field, focus trap, Escape close, return focus to trigger, visible focus ring, understandable headings and validation, high enough contrast, informative status labels beyond color. Keyboard and mobile usability are launch requirements, not decorative extras. The prototype demonstrates several states; real backend and assistive-technology testing remain required.

## 5. Prototype acceptance scripts

The interactive HTML includes a role selector and a Ready/Loading/Empty/Service Error/Access Denied/Source Revoked state switcher. All data and effects are **fictional, in-memory only**.

1. Owner creates a title-only draft; the archive shows Not Yet Preached and zero versions.
2. Editor updates sermon metadata and logs another preaching linked to a version; master count stays unchanged.
3. Owner attaches a Google Doc with explicit consent, but the mock clearly reports that no real indexing happened. Editor adds a Doc, leaves it awaiting Owner consent.
4. Search a fictional indexed excerpt and see a highlight; a revoked-only source does not produce search text.
5. Rename a fictional church after impact preview; history and filters update. Merge into another place only after confirmation.
6. Viewer can read records but not edit, archive, manage members or permanently delete.
7. Admin can invite Viewer/Editor but cannot create Admin or manage Owner. Owner can delegate Admin.
8. Switch to a second empty fictional shared workspace; prior workspace results and counts are not present.
9. Editor adds private migration review notes; only Owner can mark source attribution verified.
10. Cycle loading, empty, error, denial, and revoked states. Denial hides even counts/snippets.
11. Archive and restore with Editor permissions; Owner-only permanent delete requires typing DELETE.
12. Verify 320px phone, 768px tablet, 1280px desktop, keyboard, focus behavior and 200% zoom.

## 6. Implementation handoff

The selected design is the implementation visual contract unless a later user decision supersedes it. The prototype is **not** the implementation: do not copy its demo role switcher, in-memory data, simulated consent, offline file links, or fake mutation outcomes into production. Replace with authenticated server-boundary authorization, workspace-scoped D1 data and FTS5, read-only Google file grants, derived-index revocation, private immutable R2 objects, audit events, atomic place changes, and verified migration.

**Phase C review gate:**
- [x] C neutral visual direction selected by the user.
- [x] End-to-end UX flow and state contract documented.
- [x] Offline illustrative interaction source created on non-default design branch.
- [x] No live pastoral content included in public files.
- [ ] Browser screenshot and interaction QA at phone/tablet/desktop breakpoints.
- [ ] Accessibility and screen-reader validation of dialogs, form errors, and mobile navigation.
- [ ] Owner/assistant workflow review, including source consent and private migration.
- [ ] PR approval/merge; production code and deployment are separate later stages.

**Status:** Phase C design authored for review. Do not claim production security, backend completion, live Google access or PR merge.
