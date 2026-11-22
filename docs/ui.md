# Living Library UI

A private, signed-in single-page app on top of the [library API](library-api.md). Vanilla ES modules, plain CSS, no framework, no build step and no dependencies. A bundler was not needed: about 20 small modules load over HTTP/2 from the same Worker, and keeping the source as shipped makes the CSP trivial (`script-src 'self'`).

## Serving and access

- `wrangler.jsonc` declares `assets: { directory: "./public", binding: "ASSETS", run_worker_first: true }`. The Worker runs first for every request, so nothing in `public/` is reachable without passing the Worker. `env.staging` inherits it.
- Only `GET`/`HEAD` of `/` (the shell) and `/assets/*` are routed to `ASSETS` (`src/ui/assets.ts`). Anything else, including `/index.html`, is a 404 JSON `not_found` and never reaches the binding.
- Signed out: `/` returns the existing sign-in page, `/assets/*` returns 404. Signed in (valid, unrevoked session): the static shell and assets, with `cache-control: private, no-cache` (revalidated on every load so the session is re-checked), `x-content-type-options: nosniff`, `x-frame-options: DENY`, `referrer-policy: no-referrer` and a CSP of `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`.
- No data is embedded in the HTML. Account, workspaces, sermons and events all arrive through the authenticated API after load.
- The Google sign-in callback now redirects to `/` (the app) instead of `/welcome`. `/welcome` itself is unchanged.
- The UI hides write controls from Viewers, but that is presentation only. Every write is checked by the server (`403 forbidden` for Viewers before the body is read).

## Icon

The Sermon Bank mark is three shelf spines with a ribbon (`public/assets/icon.svg`, the source of truth). No asterisk or sparkle glyph ships in `public/`; a test enforces it.

- Generated from the SVG: `public/favicon.ico` (16, 32, 48), `assets/icon-32.png`, `icon-180.png` (apple-touch-icon), `icon-192.png`, `icon-512.png`. The 16px favicon frame comes from `assets/icon-16.svg`, a pixel-snapped variant (whole-pixel shapes) because the three spines blur together when the full mark is scaled to 16px. It keeps two upright spines of near-equal height, a third spine that leans as a stepped diagonal, a 1px brass ribbon on the middle spine, and the shelf, so it reads as books rather than a bar chart. Browsers use `icon.svg` for the tab (the 16px frame lives only in `public/favicon.ico`, which is not linked).
- The header, empty state and calendar header use the SVG as a decorative `<img alt="">`. The visible "Sermon Bank" text stays the accessible name.
- Signed-out visitors cannot fetch `/assets/*`, so the sign-in page inlines its favicon (SVG) and apple-touch-icon (PNG) as `data:` URIs and its CSP allows `img-src data:` only. A test checks the inlined SVG matches `icon.svg` and that no asset is public when signed out.
- `/favicon.ico` is not routed by the Worker (only `/` and `/assets/*` are), so browsers use the `<link>` tags. The file is committed for tooling and a future route.

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
| People & Access | Owner, Admin | Members from `GET /members`, invite (email and role, roles the actor may grant), change role, revoke with confirmation. The invitation token is shown once in a dialog with a Copy button and exists nowhere else. No email is sent. A person with no workspace can redeem the code on the "no workspace yet" screen. |
| Import Review | Owner only | Upload the history CSV (only stages rows), summary counts, a row table with flags, filter and 50-row pages, attest (explicit confirmation, one row or the selection), ignore, approve (single or the attested selection) and rollback with confirmation (a blocked rollback is reported as a conflict). The batch id lives in the address (`?batch=`), so a reload reopens the review. |
| Docs & Privacy | everyone (controls by role) | Pick a sermon, see each version's state. Editors and above upload a PDF (checked locally for type and 10 MB, the server decides) or add a PDF version in one step. Owners consent (confirmation) and revoke (final, deletes the text). Download shows while a file exists and access is not revoked. |
| Workspace | everyone | Workspace name, your role, counts, what each role can do, and switching workspaces. |

### API addition

`GET /api/workspaces/:id/members` (Owner and Admin, `403` for Editor and Viewer, `404` outside the workspace) returns `{"members":[{"account_id","display_name","email","role","accepted_at"}]}` for every accepted, unrevoked member (no row cap), Owner first. It is the read side of the existing `PATCH /members/:accountUuid`. Pending invitations are not listed.

## States and accessibility

- Loading (`role=status`, `aria-busy`), empty, error (`role=alert`, retry), access denied (404/403 from the workspace) and signed out (401, link back to sign-in). A signed-in account with no workspace gets a create-workspace form. Any signed-in account can create one. The name is checked like the server does (3 to 120 characters, trimmed). The header switcher lists the account's workspaces and ends with **New workspace**, which opens a dialog with the same name field. Creating one reloads the workspace list and opens the new workspace.
- Errors shown to people come from fixed text keyed on HTTP status and error code. Server text is never displayed.
- Search and Find in notes results, their loading line and the "not a Bible reference" notice are spoken through the one persistent `#announcer` live region (the page re-renders, so a region created with its text would not be reliably announced). The Library count uses it too.
- When a re-render replaces the focused control (a search run, a saved dialog) focus goes to its replacement (same id, name or label, and the same position among identical controls such as the Rename button of one row), else to the page heading, never to `<body>`. This holds for Settings sections too: a section reloads after a save, and focus follows the button that opened the dialog. A dialog whose opener was replaced while it was open does the same when it closes.
- Headings: one `<h1>` per view (the Calendar's is "Preaching calendar"), cards, month, year and day headings are `<h2>`, with no skipped level.
- Contrast: body text, chips and every cover palette are at least 4.5:1, form borders use `--control-edge` (at least 3:1). `tests/ui-shell.test.mjs` reads the colours from `app.css`.
- On a phone (720px and below) the header scrolls with the page: the brand and Sign out share a row, global search uses the next row, and the main nav follows. Quick rows and Table hide the decorative shelf and use a compact one-line hero with the stats and reachable actions; Search also tightens its form and result spacing. The desktop hero, Covers and Calendar remain full-sized.
- Dialogs use native `<dialog>.showModal()` (page behind is inert, Escape closes), wrap Tab and Shift+Tab, label themselves from their title and return focus to the opener.
- Visible `:focus-visible` outline, skip link, one `<h1>` per page, labelled controls, `aria-current` for the current view, month and day.
- All API text is inserted as text nodes. The code base has no `innerHTML`, inline styles or inline scripts (a test enforces this).
- Visual direction follows the Living Library + Chronicle prototype: sage, paper and moss palette, Georgia for headings and the system sans for UI. No Favor logo or fonts.

## Tests

`tests/ui-shell.test.mjs` and `tests/ui-pages.test.mjs` run under `pnpm test` with no extra dependencies. It covers Worker gating, static-asset hygiene (no external URLs, no injection sinks, reduced-motion and focus CSS), the pure models, and the whole app under a small fake DOM against the real API handler and the in-memory D1 (roles, create/edit/log/archive flows, calendar, states, focus handling). `ui-pages.test.mjs` covers search, Find in notes, the members route and every Settings section the same way, including role gating, confirmations and the one-time token.

## Not covered yet

- Screen reader, Safari and Firefox passes. The Chrome pass at 1440, 820, 390 px and 200% zoom is in [qa/issue-2-browser-a11y.md](qa/issue-2-browser-a11y.md). Follow-ups there: QA11 (invitation email error is not tied to its field) and QA12 (loading screens still use a region created with its text).
- Version editing, deleting a preaching, creating Google Doc versions, renaming a workspace and listing pending invitations. There is no API for the last two, and Google Doc ingest is not built.
