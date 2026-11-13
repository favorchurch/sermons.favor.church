# Living Library UI

A private, signed-in single-page app on top of the [library API](library-api.md). Vanilla ES modules, plain CSS, no framework, no build step and no dependencies. A bundler was not needed: about 20 small modules load over HTTP/2 from the same Worker, and keeping the source as shipped makes the CSP trivial (`script-src 'self'`).

## Serving and access

- `wrangler.jsonc` declares `assets: { directory: "./public", binding: "ASSETS", run_worker_first: true }`. The Worker runs first for every request, so nothing in `public/` is reachable without passing the Worker. `env.staging` inherits it.
- Only `GET`/`HEAD` of `/` (the shell) and `/assets/*` are routed to `ASSETS` (`src/ui/assets.ts`). Anything else, including `/index.html`, is a 404 JSON `not_found` and never reaches the binding.
- Signed out: `/` returns the existing sign-in page, `/assets/*` returns 404. Signed in (valid, unrevoked session): the static shell and assets, with `cache-control: private, no-cache` (revalidated on every load so the session is re-checked), `x-content-type-options: nosniff`, `x-frame-options: DENY`, `referrer-policy: no-referrer` and a CSP of `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`.
- No data is embedded in the HTML. Account, workspaces, sermons and events all arrive through the authenticated API after load.
- The Google sign-in callback now redirects to `/` (the app) instead of `/welcome`. `/welcome` itself is unchanged.
- The UI hides write controls from Viewers, but that is presentation only. Every write is checked by the server (`403 forbidden` for Viewers before the body is read).

## Routes (hash based, so the Worker only serves `/`)

| Hash | View |
|---|---|
| `#/library/covers` (default), `rows`, `table` | Library views |
| `#/library/calendar[?y=2026&m=10&d=2026-10-04]` | Calendar, month and selected day |
| `#/sermons/<uuid>` | Sermon detail (Details tab) |
| `#/sermons/<uuid>?tab=notes&q=grace` | Sermon detail, Find in notes tab with the query prefilled |
| `#/search?q=John+3%3A16&scope=everything\|bible\|notes[&archived=1]` | Global search |
| `#/settings/places` (default), `people`, `import[?batch=<uuid>]`, `docs[?sermon=<uuid>]`, `workspace` | Settings sections |

The header carries Library, Search and Settings links and a search box that opens `#/search`.

## Views

- **Covers**: hero with a decorative animated bookshelf, then a grid of illustrated covers. Palette and motif (rings, rays, hills, waves) come from a hash of the sermon id, so a sermon always looks the same. Motion is CSS only (shelf sway, card rise-in, slow-turning motifs) and is switched off by `prefers-reduced-motion: reduce`.
- **Quick rows** and **Table**: same data. The table turns into stacked labelled rows at 720px so a phone never scrolls sideways.
- **Calendar**: 12-month year overview with counts, month grid with markers, selected-day inspector, month arrows and year navigation. Controls are links to hash routes. It follows the server's date rules: month-precision events appear as "recorded for the month without a day", year-precision events as "recorded for the year", undated events are counted in a note, and `needs_review` events get a distinct marker. It opens on the current month if it has events, otherwise the latest past event.
- **Sermon detail**: metadata, versions with indexing status, preaching history. Editors, Admins and Owners get Edit, Log preaching and Archive/Restore. Archive and Restore ask for confirmation, with focus on Cancel.
- Library data loads once per workspace (all sermons with `archived=include`, all events, paged) and is reloaded after each write. Search, the Active/Archived toggle and sorting are client-side.

### Search and Find in notes

- **Scopes** (client-side, over one response): *Everything* shows both groups, *Bible verses* needs a Bible reference (otherwise it says so and shows nothing), *Inside notes* hides passage matches. Changing scope does not search again. "Include archived sermons" is part of the address.
- Results are always in two visibly separate groups. **Sermon passage (metadata)** comes from a sermon's own Scripture references and says its notes were not read. **Found in notes** shows the version name, source, match count and an excerpt with `<mark>` highlights built from the response's `highlights` offsets (text nodes only, bad or overlapping ranges are dropped or merged).
- Every result links to `#/sermons/<id>?tab=notes&q=<query>`, so the sermon opens on **Find in notes** with the query already in the box and the search run.
- **Find in notes** lists every version of the sermon with one status: *Found in notes* (count and excerpts), *Not in notes* (searchable, no match) or *Not searchable* (waiting for consent, revoked, or not indexed) with no excerpt.

### Settings

Sections are shown by role. A hidden section that is opened by address says it is not available and makes no request. This is presentation only: the server still answers `403` to the same calls.

| Section | Who sees it | What it does |
|---|---|---|
| Places | everyone (view-only for Viewers) | Aliases and usage. Editors and above: rename (a taken name is shown on the field), merge with an **impact preview** (events and aliases that move, the alias that is kept, the resulting count). Merge stays disabled until the chosen target has been previewed, and changing the target clears the preview. |
| People & Access | Owner, Admin | Members from `GET /members`, invite (email and role, roles the actor may grant), change role, revoke with confirmation. The invitation token is shown once in a dialog with a Copy button and exists nowhere else. No email is sent. A person with no archive can redeem the code on the "no archive yet" screen. |
| Import Review | Owner only | Upload the history CSV (only stages rows), summary counts, a row table with flags, filter and 50-row pages, attest (explicit confirmation, one row or the selection), ignore, approve (single or the attested selection) and rollback with confirmation (a blocked rollback is reported as a conflict). The batch id lives in the address (`?batch=`), so a reload reopens the review. |
| Docs & Privacy | everyone (controls by role) | Pick a sermon, see each version's state. Editors and above upload a PDF (checked locally for type and 10 MB, the server decides) or add a PDF version in one step. Owners consent (confirmation) and revoke (final, deletes the text). Download shows while a file exists and access is not revoked. |
| Workspace | everyone | Archive name, your role, counts, what each role can do, and switching archives. |

### API addition

`GET /api/workspaces/:id/members` (Owner and Admin, `403` for Editor and Viewer, `404` outside the workspace) returns `{"members":[{"account_id","display_name","email","role","accepted_at"}]}` for every accepted, unrevoked member (no row cap), Owner first. It is the read side of the existing `PATCH /members/:accountUuid`. Pending invitations are not listed.

## States and accessibility

- Loading (`role=status`, `aria-busy`), empty, error (`role=alert`, retry), access denied (404/403 from the workspace) and signed out (401, link back to sign-in). A signed-in account with no workspace gets a create-archive form (pilot owners only, the server decides).
- Errors shown to people come from fixed text keyed on HTTP status and error code. Server text is never displayed.
- Dialogs use native `<dialog>.showModal()` (page behind is inert, Escape closes), wrap Tab and Shift+Tab, label themselves from their title and return focus to the opener.
- Visible `:focus-visible` outline, skip link, one `<h1>` per page, labelled controls, `aria-current` for the current view, month and day.
- All API text is inserted as text nodes. The code base has no `innerHTML`, inline styles or inline scripts (a test enforces this).
- Visual direction follows the Living Library + Chronicle prototype: sage, paper and moss palette, Georgia for headings and the system sans for UI. No Favor logo or fonts.

## Tests

`tests/ui-shell.test.mjs` and `tests/ui-pages.test.mjs` run under `pnpm test` with no extra dependencies. It covers Worker gating, static-asset hygiene (no external URLs, no injection sinks, reduced-motion and focus CSS), the pure models, and the whole app under a small fake DOM against the real API handler and the in-memory D1 (roles, create/edit/log/archive flows, calendar, states, focus handling). `ui-pages.test.mjs` covers search, Find in notes, the members route and every Settings section the same way, including role gating, confirmations and the one-time token.

## Not covered yet

- Real-browser verification. The checks above use a fake DOM, so layout, phone-width overflow and real focus behaviour need a manual pass in a browser (`pnpm run dev` needs macOS 13.5+ for workerd).
- Version editing, deleting a preaching, creating Google Doc versions, renaming an archive and listing pending invitations. There is no API for the last two, and Google Doc ingest is not built.
