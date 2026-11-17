# Browser and accessibility QA, Living Library (issue 2, task T2)

Real-browser pass over the shipped app against a **local** instance only (`pnpm migrate:local`, `wrangler dev --local --local-protocol https`, a session from `node scripts/dev-session.mjs`, fictional data from a local-only seed). Nothing touched staging or production. Screenshots (fictional data only) are in `/Users/rico/Git/rico-mode/state/evidence/sermons-2/`, named `<code>-<view>-<before|after>-<desktop|phone>.png`, plus `baseline-<view>-baseline-<desktop|phone>.png` for every main view.

## Method

- Chrome driven through ego-browser, with an in-page audit run on every view at **1440**, **820** and **390 px**, and at **200% zoom** (720 CSS px wide, which is what 1440 px at 200% gives). The audit reports horizontal overflow, h1 count and heading order, controls without an accessible name, placeholder-only labels, live regions, landmarks, targets under 24 px, text contrast (computed from rendered colours, alpha composited, over every sermon palette) and form-control border contrast.
- Keyboard-only runs: Tab order and `:focus-visible` outline on the first 16 stops, every dialog (open from the keyboard, Tab and Shift+Tab wrap, Escape, focus return), form validation, the search flow, Settings invitation flow.
- Reduced motion: `prefers-reduced-motion: reduce` emulated. No element has an animation or transition afterwards (the default page has the shelf sway and rise-ins).
- Not done: a screen reader run (no VoiceOver/NVDA pass), Safari and Firefox, real phone hardware. Live-region behaviour is checked as DOM and ARIA structure, not as spoken output.

## Coverage

| Area | 1440 | 820 | 390 | 200% | Keyboard | Notes |
|---|---|---|---|---|---|---|
| Library: covers, rows, table | yes | yes | yes | yes | yes | no horizontal scroll at any width |
| Library: calendar, year, month, selected day | yes | yes | yes | yes | yes | |
| Sermon detail (all 11 palettes), Find in notes | yes | yes | yes | yes | yes | revoked and pending versions included |
| Global search: Everything, Bible verses, Inside notes, empty | yes | yes | yes | yes | yes | |
| Settings: Places, People & Access, Import Review, Docs & Privacy, Workspace | yes | yes | yes | yes | partly | invite dialog and one-time code dialog exercised by keyboard |
| Dialogs and sheets: New draft, Log preaching, Invite, one-time code | yes | | | | yes | trap, Escape, focus return, field errors |

## Search contract (checked in the browser against indexed fictional notes)

| Query | Result |
|---|---|
| `Jn 3:16` | finds the note containing `John 3:16-18` and the note containing `John 3:16`; sermon with passage `John 3:16-21` listed under "Sermon passage (metadata)" |
| `John 3:16` | same three results |
| `Jn 3:16-18` | same, the label reads `John 3:16–18` |
| `Joshua 1:2` | one result, **Sermon passage (metadata)** for `Joshua 1:1-9`, "Its notes were not read for this result", **Found in notes (0)**. The sermon's notes contain `Joshua 1:9` and `John 3:16-18`, neither matches |
| `grace is not a reward` | one phrase match with a highlighted excerpt |
| `reward a not` (same words, wrong order) | 0 results: only indexed words in order match |
| Revoked version (`Find in notes`, sermon "Hope in the Waiting") | status "Not searchable", "Access was revoked, so its text has been removed from search." No excerpt in the DOM. The API body is `{"status":"not_searchable","reason":"revoked"}` with no text field |
| Pending version (PDF awaiting consent) | status "Not searchable", "Waiting for an Owner to consent…". Same, no text in DOM or API |
| Result link | opens `#/sermons/<id>?tab=notes&q=<query>`, Find in notes with the query prefilled and the search run |

## Measured contrast (WCAG AA: 4.5 text, 3 large text and controls)

| Pair | Before | After |
|---|---|---|
| Calendar day number `#6b7d6e` on `#fbfdfb` | 4.29 | 5.55 (`--muted`) |
| Sermon header tag chip text on header | 2.59 to 3.39 depending on palette | 7.2 to 11.7 (`#26392c` on the chip over each palette) |
| Sermon header eyebrow (faded to 85%) | 3.3 to 4.6 depending on palette | 4.80 to 8.56 (no fade) |
| `.cover-pine` white text | 3.96 | 4.80 (`#587a63`) |
| `.cover-clay` text | 4.27 | 5.00 (`#54402f`) |
| Other cover palettes, text | moss 5.66, linen 4.80, night 8.56, sage 5.00, paper 5.13 | unchanged |
| Input, select and textarea border on paper | 1.43 to 1.73 | 3.2 to 3.5 (`--control-edge: #7a8d7c`, on paper, panel and background) |
| Lowest remaining rendered text pair in the app | | 4.80 (eyebrow on the lightest palettes), pills 4.98 |
| Focus outline `#1d5fa8`, 3 px | 6.4 on paper | unchanged |

## Findings

| Code | Severity | Finding | Status |
|---|---|---|---|
| QA1 | low | Covers jumped from the h1 to an h3 per sermon card | fixed: cards use h2 |
| QA2 | medium | Calendar had no h1 (title was an h2, then h3s), and route changes had no heading to focus | fixed: h1 `#page-title`, month/day h2, undated groups h3 |
| QA3 | medium | Calendar day numbers 4.29:1 | fixed |
| QA4 | medium | Sermon header: tag chip, faded eyebrow, and the pine and clay palettes fell under 4.5:1, only on some sermons (the palette comes from a hash of the id) | fixed |
| QA5 | medium | On a phone the sticky header was 228 px tall (27% of a 390x844 screen) and stayed there while scrolling | fixed: static header at 720 px and below |
| QA6 | medium | Search and Find in notes counts, the "Searching…" state and the "not a Bible reference" notice were `role=status` nodes created together with their text on every render, which screen readers announce unreliably. The persistent `#announcer` stayed empty | fixed: they are spoken through `#announcer`, a repeat of the same text is announced again |
| QA7 | medium | Focus fell to `<body>` after searching (the form re-renders) and after a saved dialog (the opener was replaced) | fixed: focus returns to the same control, else the page heading |
| QA8 | low | Targets under 24 px: "Open original" link, calendar day event link (23 px) and the "Include archived" checkbox (20 px) | fixed |
| QA9 | medium | On a phone, Quick rows and Table started about 960 px down, below the fold, under the decorative shelf | fixed: the shelf is hidden on Rows and Table at 720 px and below (nothing added, 250 px removed) |
| QA13 | medium | At 390x844 the first Quick rows item started about 785 px down (header 228 px, full hero, tall toolbar) | fixed: phone header is brand + Sign out, search, nav (144 px); Rows and Table get a compact hero (`hero-compact`: one-line title, stats line, inline New draft / Open the calendar); tighter toolbar and Search page. First row/result now at 414 / 295 (Table) / 386 px; no horizontal scroll at 195, 320, 390 px. Screenshots `QA13-<rows|table|search>-<before|after>-<phone|desktop>.png`; desktop unchanged |
| QA10 | medium | Text input, select and textarea borders 1.43 to 1.73:1 against the 3:1 minimum for control boundaries | fixed |
| QA11 | low | "Invite someone" with an invalid email shows a form-level message, not one tied to the email field: the server answers `invalid_invitation` with no field name | follow-up: the fix is either a server `field` or a duplicate client email check, and the server contract is out of this task's scope |
| QA12 | low | Full-page loading skeletons are `role=status` nodes inserted with their text. The static "Loading your library…" in `index.html` covers first load, and loads after that are brief | follow-up: same class as QA6, fix by routing them through `#announcer` once a real screen reader pass confirms it is needed |

Checked and fine: one h1 on every view, labelled controls, `aria-current`, skip link, visible 3 px focus on every stop, dialog trap, Escape and focus return, native `<dialog>` modal, field errors tied with `aria-describedby` and `aria-invalid`, no horizontal scroll from 200% zoom to 390 px, reduced motion, 44 px header controls.

## Regression tests

| Code | Test |
|---|---|
| QA1, QA2 | `tests/ui-shell.test.mjs` "QA1/QA2: every library view and the sermon page have one h1…" |
| QA3, QA4 | `tests/ui-shell.test.mjs` "QA3/QA4: calendar numbers, sermon tag chips and every cover palette…" (colours read from `app.css`, helper in `tests/helpers/contrast.mjs`) |
| QA5, QA8, QA9 | `tests/ui-shell.test.mjs` "QA5/QA8/QA9: phones get a static header…" |
| QA10 | `tests/ui-shell.test.mjs` "QA10: text inputs, selects and textareas have a 3:1 border…" |
| QA6, QA7 (search) | `tests/ui-pages.test.mjs` "QA6/QA7: search results are spoken through the page live region…" and "QA6: Find in notes announces…" |
| QA7 (dialog) | `tests/ui-shell.test.mjs` "QA7: after a saved dialog…" |
