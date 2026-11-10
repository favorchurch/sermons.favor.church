# Sermon Bank — Product Requirements Document

**Status:** Requirements baseline v1.0 — 10 executive decisions locked; Phase B prototyping next  
**Prepared:** 10 November 2026  
**Product URL (proposed):** `https://sermons.favor.church`  
**Source repository:** `favorchurch/sermons.favor.church` (public; requirements developed on a non-default branch)  
**Operator / open-source publisher:** Favor Church  
**Launch sequence:** (A) requirements and decisions → (B) interactive prototypes → (C) flow refinements and approval → implementation → private pilot → wider release.

## 1. Product vision

**Sermon Bank** is a beautifully simple, private, searchable archive for a pastor's entire preaching life. A pastor or authorized assistant can add a sermon once, attach read-only source-document references or new immutable uploads, manage explicit versions, log each time and place it was preached, and later rediscover it by title, theme, Scripture, date, venue, event, or words inside its notes.

Favor Church will host the service and publish its application code as open source. The app is independent of Rock RMS, Favor staff accounts, and all existing Favor identity or church data services. After an invite-only five-pastor pilot, anyone internationally may self-register for free, subject to reasonable anti-abuse controls and service limits. Private sermon notes, metadata, index contents, Google tokens, and user data must **never** be published to the open-source repository.

### In-scope outcomes
- A pastor can find an old sermon or past preaching engagement in seconds.
- A pastor or assistant can add a sermon, version, document, or preaching history with minimal steps.
- An existing church/venue name can be corrected once and immediately appear correctly throughout history, filters, and search.
- Text within authorized PDF and Google Docs notes is searchable **only** by people authorized for the owning workspace.
- Every person owns one default personal workspace; additional owned workspaces, where supported, live in Settings, and shared workspaces are accessible without duplicating data.
- The application is usable for unrelated international pastors while operating on infrastructure paid for or provided by Favor Church.
- Existing Google Docs and PDFs are never modified by the application. Managing an archive record changes its metadata and references, not the source document.

### Explicit non-goals for v1
- Rock integration, favor.church SSO, sermon publishing, a public sermon catalog, social discovery, live-streaming/video hosting, a sermon marketplace, auto-generated sermon writing, translation, AI embeddings/chat, OCR of scanned PDFs, cross-workspace search, and bulk admin access to user sermons.
- An unconditional promise of zero cost or automatic legal compliance in every jurisdiction.

## 2. Source evidence and starting point

The product requirements are based on an internal single-file sermon archive prototype and a private workflow request from pastoral administration. The prototype supports title and location search, cards, history, adding/re-preaching sermons, browser-local persistence, and export. It has no durable database, login, permissions, document indexing, or true uploaded-file storage.

**Public-source boundary:** The original HTML prototype and private preaching-history inventory are confidential input material. Do not commit, mirror, publish, or generate static seeds from them. Pilot migration must occur in private infrastructure, with source integrity checks and owner authorization. Any examples in this public PRD are generic or fictional.

## 3. Users, workspaces and delegated access — DECISIONS 1, 2, 5, 10

**Account boundary:** Sermon Bank has its own identity and user store, including Google SSO and an alternate verified-email sign-in method. It does **not** use Rock RMS accounts, roles, APIs, or data. After the five-pastor invited pilot, registration is available internationally without manual pastoral verification, protected by anti-abuse controls, account verification and fair usage limits.

**Workspace boundary:** Each signed-up person has at most one default personal workspace. Additional user-owned workspaces are available by explicit creation under Settings, not surfaced as the primary onboarding flow. A person invited only as an assistant lands in the pastor's shared workspace and need not create their own archive. Membership in one workspace never reveals another; the same person can be a member of multiple workspaces.

### Authorization matrix (server-enforced)

| Capability | Owner | Delegated Admin | Editor | Viewer |
|---|:---:|:---:|:---:|:---:|
| Search/read sermon records, preaching history and authorized indexed document text | Yes | Yes | Yes | Yes |
| Add/edit sermon metadata, preaching instances, places and version references | Yes | Yes | Yes | No |
| Attach new document references or upload new immutable PDFs | Yes | Yes | Yes | No |
| Archive/restore records (reversible) | Yes | Yes | Yes | No |
| Invite, remove or change access for Editors and Viewers | Yes | Yes | No | No |
| Grant/revoke Admin access | Yes | No | No | No |
| Transfer ownership, permanently erase records, delete workspace | Yes | No | No | No |
| Initiate complete workspace export | Yes | No | No | No |
| Change or overwrite original Google Docs or original uploaded PDF bytes | **No app role** | **No app role** | **No app role** | **No app role** |

**Role semantics:** A pastor is the Owner and can explicitly delegate Admin, Editor or Viewer roles to named, verified accounts. Delegated Admins can operate the archive and manage Editor/Viewer memberships but cannot appoint Admins, change the Owner, authorize permanent destruction, escalate their own permissions or grant general Favor staff access. Editors can fully manage **app records** and archive operations, not original files. Viewers can read and search only. Owner cannot be removed by Admin. All membership operations are logged; access revocations take effect immediately for app APIs, snippets and file-download grants. A person who edits an original Google Doc *outside Sermon Bank* does so under their independent Google permission; this application does not provide a write path to that file.

**Indexed-document disclosure:** With explicit Owner consent and clear explanation at attachment/indexing time, Admins, Editors and Viewers of the workspace may search/read the indexed text of an authorized Google Doc, even if they cannot open the source directly in Google Drive. Opening/editing the original follows Google's separate file permissions. Without the required owner consent and valid source authorization, the link is unindexed. Revoked Google source access removes derived searchable contents; the UI reflects the permission failure. This rule also applies to excerpts and cached previews.

**Favor operator boundary:** Favor staff have no routine in-app access to sermon content or search indexes. Exceptional access is narrowly scoped, justified, time-limited and audited; infrastructure operators may have limited technical capabilities to service encrypted managed storage. No general admin browse feature or cross-workspace search.

## 4. Core jobs and navigation

### Suggested top-level layout
**Archive** (default home); **Preaching History** (timeline and filters); **Places** (editable churches, campuses and venues); **Settings** (Members & permissions, Integrations, Imports/Exports, Profile, Workspace selector). A prominent **+ Add Sermon** action persists in desktop and mobile views.

### Primary flow: add a new sermon
1. Click `+ Add Sermon` and enter a title. This alone is enough to save a draft.
2. Optionally add series, Scripture references, themes/tags, synopsis, and workspace-shared descriptive notes. This never edits the original source document.
3. Upload a new immutable PDF, select an existing Google Doc using a read-only authorization flow, or store another link. Do not overwrite, modify, or convert-and-replace any original source file.
4. Optionally record the first preaching: local date (or uncertain date), church/venue, event/occasion, and which version was used.
5. Save. The archive updates immediately; document search shows `Indexing` until content is available.

**Usability aim:** under 30 seconds to log a title, date, and venue when the notes are already available; drafts and absent notes are allowed. Autosave where safe, clear undo/confirmation for destructive actions, keyboard-friendly entry, accessible mobile layout.

### Primary flow: re-preach an existing sermon
Search/select an existing sermon → `+ Preaching` → date, venue, event, optional version and note → Save. This adds a new preaching engagement rather than duplicating the sermon. Do **not** deduplicate across different pastors' workspaces.

### Primary flow: edit a church everywhere
Places → select canonical church/venue → rename or merge → review impacted records → confirm. All sermon histories, filters, and result summaries use the same place ID, so the edit propagates without editing every sermon. Renames keep aliases for search. Merges are logged and undoable when feasible.

### Primary flow: find an older sermon
Search by phrase, title, Scripture, tag, notes body, church, city, date/year, event or series. Show clear matches with an excerpt when matched inside notes, which document/version matched, and the linked preaching occurrences. Filters may include location, event type, year range, document presence, and version. Search never leaks snippets, counts or suggestions from another workspace.

### Primary flow: invite an assistant
Settings → Members → Invite by email → Owner chooses Admin, Editor or Viewer (delegated Admins may invite only Editor or Viewer) → email invite → the person signs up or signs in (Google or email) → access to the invited workspace only. Revocation removes app data access immediately, including notes preview, indexed snippets, downloads, and all versions.

## 5. Functional requirements by priority

### P0 — essential for a private pilot
- `FR-01` Independent app account, verified email, Google SSO, and one non-Google sign-in method (proposed email magic link); no Rock connection.
- `FR-02` Default workspace provisioning and fully server-enforced Owner/Admin/Editor/Viewer permissions; invitations and revocation.
- `FR-03` Durable sermon create/edit/archive/restore, series, themes/tags, Scripture, speaking notes, version history.
- `FR-04` Distinct preaching events with preached date/precision, event type, church/venue, campus/location, optional version used and occasion notes.
- `FR-05` Normalized place directory with rename/merge/aliases and immediate propagation.
- `FR-06` PDF upload and private R2 storage. Uploaded PDF byte streams are immutable; an updated document is a new file/version. Never modify existing pilot pastors PDFs.
- `FR-07` Search titles, metadata, venues and extracted text from text-based PDFs; highlight source and matching version.
- `FR-08` Read-only Google Docs linking via least-privilege file-specific authorization and explicit Owner consent to workspace-visible indexing; revoke indexes when source access is lost. No Google Docs write scopes or edits.
- `FR-09` Safe, auditable, provisional import into a private migration workspace, preserving originals, relationships and uncertain records. Do not assign pilot pastors ownership without verification; never mutate original sources or publish seed data.
- `FR-10` Owner-initiated export/download of workspace records and stored uploads, clearly identifying linked Google Docs that are not copied; deletion request and backup/restore procedures.
- `FR-11` Terms of Service, privacy notice, data processing explanation, consent/acknowledgement records, contact for privacy requests, and basic anti-abuse controls.
- `FR-12` Responsive, accessible archive UI with polished typography, fast search, clear empty/error states, and add-sermon-first onboarding.

### P1 — before public self-registration
- Self-service onboarding, email change and account recovery; quota dashboard with clear and fair caps.
- Refined import wizard (CSV, JSON, and selected original HTML export); duplicate detection with preview/undo.
- Bulk place correction, sermon editing, and export; membership audit history; per-workspace usage and cost controls.
- Text-file and DOCX extraction if libraries and resource limits allow; scheduled/manual Google reindex; safe import permission errors.
- Support process, incident response, abuse reporting, verified legal pages and appropriate processor contracts. Public free self-signup is gated on these controls.

### Later / optional
- OCR for scanned PDF, audio/transcript ingestion, structured scripture extraction, semantic search, sermon preparation planner, consent-based sharing of a single sermon, end-to-end encryption mode (with substantial search tradeoffs), self-hosting install templates.

## 6. Original documents, versions and private full-text search — DECISIONS 3, 5, 6, 7

**Non-destructive source rule (critical):** pilot pastors' current Google Docs and PDFs must remain exactly as they are. Sermon Bank reads an authorized source or attaches a new upload; it never edits, rewrites, re-encodes or overwrites that source. Editing a sermon in the app means changing the application's metadata, relationships, locations, and manually maintained version references. Any new or replacement PDF is stored as a distinct immutable object, not as an in-place overwrite. The private v14 HTML and original Google Sheet, if supplied, are also retained unchanged as import evidence.

**Sources of truth:** Google Drive remains authoritative for linked Google Docs. Sermon Bank stores only a reference, permission/consent metadata and a privately derived searchable text index; it does not archive a duplicate original Google Doc or create automatic snapshots. For new PDF uploads, private R2 holds the original uploaded bytes. D1 owns the searchable derived text/index and app-managed records. The Owner (or permitted Admin/Editor) owns human-curated sermon metadata, explicit versions, preaching events and place changes.

**Versions are explicit, not immutable Google snapshots.** One sermon record may have named versions such as Original, Manila 2025, Brisbane 2026, each with a Google Doc, new immutable PDF, and/or external reference. A preaching occurrence may identify which version was used. Updating an existing linked Google Doc outside the app changes what the historical link displays; UI explains this limitation. The service does not automatically capture historical Google Doc states.

**Google authorization:** Google SSO is separate from Drive authorization. For a linked Doc, use a read-only, file-scoped consent flow (e.g. Google Picker plus the least-privilege supported scope), and store the granted source access and Owner's separate consent to index/disclose derived text to workspace members. Request no Drive write permission. If authorization is revoked or invalid, remove its indexed contents and snippets, stop serving cached previews, mark the source `Permission needed`, and require renewed authorization to index again. Synchronization must revalidate access and correctly handle delayed revocation detection; access removal is a privacy-critical operation, not just a display badge. Admins/Editors can propose links; indexing that exposes text to the workspace requires valid authorization and Owner consent.

**Document coverage:** Text-based PDF and Google Docs are P0. Other links can be saved as references but remain `Link only` until an explicit, safe, supported importer is added. Scanned/image-only PDFs clearly show `No searchable text` in V1 (OCR deferred). File types, size, content signatures, malware risks and untrusted remote URLs are validated; do not server-fetch arbitrary user URLs or allow SSRF. Uploaded objects use private keys and authenticated short-lived delivery URLs.

**Search V1:** Exact/full-text and ranked keyword/phrase search across metadata, titles, categories, Scripture references, series, tags, places, preaching dates/events and derived indexed Google Docs and PDF text. SQLite FTS5 or equivalent, scoped by workspace and current membership, powers snippets/highlighting and optional match-in-version details. Server authorization gates result rows, suggestions, snippets, downloads, export, cache and background processing. No semantic embeddings, LLMs, or AI-powered document processing in V1.

**Index states:** `Ready`, `Indexing`, `Link only`, `Permission needed`, `Unsupported/scanned`, `Failed—retry`. Reindex on authorized source updates, new uploads, explicit version changes and permission transitions. Remove derived text when the Google authorization is revoked; file removal/retention follows the published data policy. No document contents are sent to general-purpose third-party AI providers.

**Collaboration consequence:** An Owner who authorizes indexing also authorizes displayed text/snippets for all their currently invited Admins, Editors and Viewers. A collaborator still needs separate Google Drive rights to open/edit the original Doc. The UI must make this distinction unmistakable before indexing.

## 7. Conceptual data model

- `users` and `auth_accounts` (owned by this app, Google as external login identity only).
- `workspaces` (owner, label, default flag); `workspace_members` (Owner/Admin/Editor/Viewer role, invite source, status); `invitations`.
- `sermons` (workspace_id, stable UUID, title, description, series, topic tags, scripture refs, draft/active/archive state).
- `sermon_versions` (sermon_id, explicit label, optional parent, reference changes, created_by; no automatic Google snapshot).
- `sources` (version_id, type/upload/Drive/link, immutable upload key or Google file ID, source authorization, Owner indexing consent, checksum, access/index status; write to originals prohibited).
- `document_chunks` and `search_index` (always workspace_id + document/version reference; no public endpoint).
- `places` (workspace_id, church name, optional campus, locality/country, aliases); `preaching_events` (sermon_id, place_id, local date, precision, event type, version_id, notes).
- `audit_events` (workspace/actor/action/object/time, avoiding full sermon body in logs); `privacy_consents` and `data_requests`.

All resources must be workspace-scoped at the data access boundary, including counts, search, autocomplete, file URLs, exports and background jobs. Protect against insecure direct object references. Atomic membership and content mutations need authorization at the server, not merely hidden buttons. Only Owners can delegate Admin, transfer ownership or hard-delete; Admins can manage Editor/Viewer membership. Any mutation of existing Google Docs or stored PDF bytes is forbidden. Favor infrastructure credentials are separate from user credentials; there is no Rock key anywhere in this app.

## 8. Privacy, security, legal and content ownership

- **Default privacy:** every sermon, file, version, extracted text and search index is private to its workspace; no public directory, search-engine indexing, public share link or cross-workspace recommendation. The static marketing/login page may be public.
- **Content ownership:** pastors or rightful copyright holders retain the rights to their sermons; Favor receives a narrowly scoped license to host, process, index and display content according to owner settings and Terms. Favor's open-source license covers **application code only**, not imported sermons, user notes, uploads, or seed records.
- **User data:** collect only what the service needs. Identify processor/subprocessor locations, lawful bases and role allocation with counsel; provide published Privacy Policy and Terms; controls for access, correction, export, erasure, retention, and contact for requests. An international launch needs a jurisdictional privacy review (including potentially applicable EU/UK GDPR, Philippine DPA, Australian Privacy Act, etc.), cross-border transfers and provider contracts. Do not claim automatic global compliance.
- **Third-party stories:** sermons may include personal testimonies or sensitive information about other people. Inform uploaders they must have rights and permissions to upload/process it; provide private-by-default warning, delete/rectify mechanism, and policy for highly sensitive or minor-related content.
- **Security:** verified invitations; encrypted transport, secrets, backups and provider tokens; least-privilege roles; rate limits, bot protection, account recovery controls, secure sessions, CSRF and upload validation, security logging without content leakage; dependency/security scanning; incident response; two-factor for owners if feasible; admin support through time-bounded approved access, not blanket content browse.
- **Operator trust boundary — DECISION 1 LOCKED:** managed encrypted private storage with strict workspace isolation; no routine Favor staff access to sermon content. Exceptional infrastructure operator access only with narrow scope, justification, time limits, and audit records. End-to-end encryption is not a V1 requirement.
- **Original document integrity:** every app role has a read-only relationship to linked Google Docs; newly uploaded PDFs are immutable, and version changes add new objects instead of overwriting existing source bytes.
- **Backups & deletion:** choose documented backups and restoration tests; user-requested deletion cascades through index, blobs, previews and active data, with a stated separate backup expiry. Keep access/error logs minimal and time-limited. Workspace export includes structured records and original owned uploads; external linked Docs must be clearly identified rather than silently copied.

## 9. UX direction and prototype design brief

Design for a focused writing and retrieval tool, not church administration software. Warm neutral backgrounds, excellent editorial typography, clear whitespace, purposeful accent color, calm icons, readable mobile cards and strong keyboard accessibility. Keep the existing v14 strengths — search-forward home, summary stats, card browsing and chronological preaching history — but replace the modal-heavy edit path with obvious task-oriented flows.

**Prototype surfaces:** (1) public landing/login; (2) new-user onboarding; (3) archive/search; (4) sermon detail, versions and document viewer; (5) add/edit sermon drawer/wizard; (6) add preaching instance; (7) history timeline; (8) places editor/rename; (9) Owner/Admin/Editor/Viewer members, invitations and delegated permissions; (10) workspace switcher/settings; (11) read-only Google attach, owner consent, file integrity and permission status; (12) empty, indexing, error, access denied states.

**Test scripts:** pastor adds a sermon in under a minute; assistant records a repeat preaching; rename "Favor Church Manila" and see changes everywhere; viewer searches a phrase in a PDF but cannot edit; owner revokes editor and search disappears; delegated Admin invites a Viewer but cannot grant Admin or remove Owner; changes to a sermon do not modify the linked Google Doc or uploaded original PDF; pastor switches between two shared workspaces without cross-leakage. Test desktop and small phone layouts.

## 10. Architecture options

### A. SELECTED: Cloudflare-native, modular and low-cost — DECISION 8

```text
Browser (React/Vite, accessible design system)
   → Cloudflare Workers + Static Assets / API (Hono or compatible framework)
        → Better Auth (app-owned users; Google OIDC; email method)
        → D1 SQLite (workspaces, sermons, versions, places, FTS5 index)
        → private R2 (PDF and original uploads)
        → Google Picker + per-file OAuth `drive.file` (authorized Docs export)
        → optional Cloudflare Queues / paid Worker processing when necessary
```

**Why:** one platform, minimal recurring spend, native DB and private file storage, no separate managed Postgres, native full-text search for a small archive. At current published allowances, Workers Free includes up to 100,000 requests/day with 10 ms CPU/request; D1 Free provides 5 GB total storage, 5 million rows read/day and 100,000 rows written/day; R2 includes 10 GB-month standard storage and limited free operations. This makes **near-$0 marginal platform cost plausible for five users**, *not guaranteed*, excluding domain, email, unexpected file volume, overages, provider changes and operator time. Keep document parsing within free CPU constraints: extract text-based PDF text in the client where appropriate, securely validate uploads server-side, and queue/retry heavier work on a paid Worker or other background processor if needed. Do not run unbounded PDF extraction in a 10 ms Free Worker.

**Risk:** more Cloudflare-specific deployment and backend patterns, carefully planned document indexing/background jobs; free-plan limits and provider caps can change.

### B. Rejected for the initial production baseline: Vercel Pro + separate SQL + R2

```text
Browser (Next.js / React)
   → Existing Favor Vercel Pro account (API routes / server-side auth)
        → dedicated Neon/Supabase Postgres project (not shared Rock DB)
        → PostgreSQL full-text search (plus pg_trgm if warranted)
        → private Cloudflare R2
        → Google Picker and Drive API
        → Vercel scheduled/background indexing as supported by plan
```

**Why:** familiar to the Favor engineering team; mature Next.js ecosystem; may be **low incremental spend** within an existing Vercel Pro allowance. There is still a separate SQL database to operate and secure, and compute/bandwidth/database fees may accrue. Do not attach the app to a busy existing Favor/Postgres pool solely to save a few dollars; user data separation matters more than a tiny free-tier saving.

**Trade-off:** easiest for a Next.js-heavy team, but more providers and likely more operational dependencies than option A.

### Architecture decision rule
Decision 8 chooses **A** for production. A material limit found during the document-ingestion spike must be documented and explicitly escalated before changing platforms. Keep business logic and source indexing behind adapters so a later move to Vercel/Postgres does not change the domain model or users' exported data. Avoid AI search or vector databases until exact full-text search is insufficient and funding/privacy is explicitly approved.

## 11. Rollout, migration and verification — DECISION 9

1. **Phase A complete:** ten executive choices are locked below; this PRD is the provisional implementation baseline. Verify provider terms, quotas, OAuth policy, and applicable privacy requirements before production.
2. **Phase B prototypes:** create interactive surfaces based on v14, with workspace roles, concise add/re-preach flows, non-destructive document references, locations management, and migration review. Review with pilot pastor A, pilot pastor B and a pilot assistant.
3. **Phase C refinements:** test key workflows with pastors and assistants, settle flow/visual feedback, and freeze acceptance criteria. Do not start a production import or modify originals during prototype work.
4. **Engineering:** create/confirm the intended Apache-2.0 public repository without any real sermon data; implement Cloudflare Workers + D1 + private R2, Google SSO, app-owned auth, audit controls, and documented self-hosting. Verify costs, PDF processing CPU and quota limits with a realistic spike.
5. **Private import/staging:** with the relevant owners' permission, import the original v14 records provisionally into a **private migration workspace** with source IDs/metadata and immutable copy of import evidence. Run a dry-run reconciliation for every source sermon record, preaching entry and raw location, preserving source spellings, relationships and uncertain dates. Flag speaker attributions, duplicates, missing titles/categories and ambiguous locations. **Do not edit existing original documents/PDFs.** No record is assigned to pilot pastors personal workspaces until ownership is verified, then perform a documented reviewed assignment. Authorized Editors may progressively clean up app metadata and associations, with reversibility and an audit trail.
6. **Five-pastor pilot:** invited access only; demonstrate role isolation, owner-approved indexed Google content sharing, permitted source reindex/removal, immutable PDF uploads, search and recovery, and non-destructive editing. Keep staging, previews and production separate.
7. **Public self-service:** after safety, privacy, usage-quota, backup/restore, and security gates pass, open free international signup with no manual pastoral approval and reasonable anti-abuse protections.

## 12. Pilot acceptance criteria

- A pastor can create an account without Rock, log in through Google, and access only their default workspace.
- An invited assistant can read or edit only the invited pastor's space; Viewer cannot mutate. Owner can grant Admin/Editor/Viewer. Admin can invite Editor/Viewer only and cannot grant Admin, remove Owner, transfer ownership, permanently delete, or export the whole workspace.
- A new sermon, an explicitly named version reference, and a second preaching instance persist across browsers/devices with audit trails. Existing linked Google Docs and uploaded original PDFs never change as a result of app metadata edits.
- Renaming/merging a place updates all prior preachings, filters and search without modifying each sermon independently.
- Searching a phrase found only in an uploaded **text-based** PDF returns the correct sermon/version and authorized snippet; another user searching the same phrase gets no result or count leakage.
- Google Docs are indexed only with valid read-only source access and the Owner's informed choice to share indexed text with all workspace roles; revoked source access triggers index/snippet removal. The app never requests write scopes or edits an original document.
- Deleting or revoking access removes authorized app visibility and invalidates file-download links; workspace deletion follows published retention behavior.
- Provisional private migration proves accurate source record counts, zero silent dropping, explicit exceptions, and zero source modification; records enter pilot pastors personal workspaces only upon verified attribution.
- A user can export all owned sermon metadata and original uploads in a usable portable format.
- App remains usable on small mobile screens, keyboard and assistive technology. No private seed data is present in the public GitHub repo or browser static assets.

## 13. Executive decision register — ALL 10 LOCKED

| ID | Locked decision | Product implication |
|---|---|---|
| 1 | Managed private storage, strict access and narrowly audited exceptional operator access | No routine Favor staff sermon visibility; tenant-isolated content, indexes and downloads |
| 2 | Invite-only five-pastor pilot, then free international self-registration | No manual pastor approval after pilot; verify accounts, quotas and anti-abuse controls |
| 3 | Google Drive is the source of truth for linked Docs, with private derived index and access-revocation purging; uploaded PDFs in R2 | No duplicate Google document snapshots; separate source authorization and derived-index lifecycle |
| 4 | Apache-2.0 application license | Public Favor-maintained code, separate private content/copyright and trademarks |
| 5 | Invited Editors/Viewers can read indexed Google Doc text with informed Owner consent | Workspace index-sharing boundary, separate original Google Drive permissions |
| 6 | V1 full-text search, highlighted matches, filters, metadata/history and notes; AI semantic search deferred | D1/SQLite FTS5 or equivalent; no AI embeddings in V1 |
| 7 | Pastor-managed explicit versions; no automatic Google Doc snapshots | A version links documents; historical linked Docs can change if modified outside app |
| 8 | Cloudflare Workers + D1 + private R2 production | Lowest feasible cost, portability documented, provider quotas and PDF CPU verified |
| 9 | Private provisional migration; separate pilot pastors workspaces assigned only after ownership verification | Preserve original v14 data, flags, reconciliation and non-destructive progressive cleanup |
| 10 | Owner may delegate Admin, Editor and Viewer roles; Admins manage content/members within a defined limit; original notes never changed | Four-role matrix, Owner controls Admin delegation, ownership, full export and permanent deletion; no app source-file writes |

### Source-integrity clarification to Decision 10 (explicit instruction)

"Managing" a sermon in Sermon Bank **does not** mean editing pilot pastors' current Docs/PDFs. Even an Owner or Admin cannot change an existing source document through this app. For Google, authorize read-only content retrieval to the search index; direct Google editing remains outside the app and governed by Google permissions. For PDFs, preserve original uploaded bytes and create separate objects for updated versions. Renames, tags, location corrections, dates, version associations, and archive status only change Sermon Bank records.

### Remaining engineering and launch validation (not executive grilling)

- Confirm the target GitHub public repository's existence/access before creating or committing; ensure no real v14 sermon records enter any public repository, static assets, test fixture or build log.
- Validate Google Picker/file-scoped read authorization, OAuth review requirements, read-only scope availability, and reliable index purging after source revocation; avoid assuming every external Google Doc can be indexed.
- Select framework/auth library pinned versions compatible with Cloudflare Workers/D1, and design safe session and membership invalidation.
- Benchmark client-side versus asynchronous PDF text extraction, file quotas, D1 FTS5 behavior and R2 storage operations at realistic pilot sizes.
- Confirm data-processing terms, retention, international privacy notices and abuse-response processes with qualified counsel before public registration.
- Produce a private migration manifest and seek ownership authorization for pilot pastors before assigning, indexing or exposing any historical documents.

**Exit from Phase A:** No additional executive decisions are required to commence interactive prototyping. Prototype feedback can surface material product issues, but routine engineering choices should be resolved without further grilling.

## 14. References and validation notes

- Original requirements request: maintained privately by Favor Church; not included in this public repository.
- Existing single-file prototype: private source, excluded from this public repository.
- Cloudflare Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
- Vercel Pro pricing: https://vercel.com/pricing
- Google Drive API least-privilege scopes and Picker: https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- Google Docs file export: https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export
- Google OAuth verification: https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification
- Better Auth D1 support (library implementation to verify against pinned version): https://better-auth.com/blog/1-5
- Philippines Data Privacy Act: https://privacy.gov.ph/data-privacy-act/
- EU GDPR: https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679

**Requirements caveat:** This is the approved executive-decision baseline for design, not a legal opinion, cost guarantee, source-ownership adjudication or permission to import private materials without their owners' approval. Pricing and API scopes must be reverified during engineering; UX remains subject to Phase B/C review.