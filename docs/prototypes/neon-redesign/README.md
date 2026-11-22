# Sermon Bank — Neon Redesign Prototype

Throwaway interactive UI prototype exploring a fresh, unconstrained redesign of Sermon Bank (`sermons.favor.church`). No production code, auth, API, schema, or worker files were modified.

## How to preview locally

Serve this directory over HTTP (ES modules require an HTTP origin):

```bash
python3 -m http.server 4179 --bind 127.0.0.1 --directory docs/prototypes/neon-redesign
```

Then open:

- **Default (Variant A — Editorial Rail)**: `http://127.0.0.1:4179/#/library`
- **Variant B — Split Studio**: `http://127.0.0.1:4179/?variant=B#/library`
- **Variant C — Top Command Bar**: `http://127.0.0.1:4179/?variant=C#/library`
- **Other screens**:
  - Sign-in: `#/signin`
  - Preaching Calendar: `#/calendar?y=2026&m=11&d=2026-11-08`
  - Sermon Detail (Details & Find in notes): `#/sermon/sermon-grace` and `#/sermon/sermon-grace?tab=notes&q=grace`
  - Search: `#/search?q=John%203%3A16&scope=everything`
  - New workspace onboarding: `#/onboarding`
  - Panel states: `?state=loading#/library`, `?state=empty#/library`, `?state=error#/library`
  - Hide floating prototype switcher bar: append `&chrome=hide`

Use the floating bottom-right prototype bar (or `←` / `→` keyboard arrows outside text fields) to cycle between Variants A, B, and C.

## Five-line brief

1. **Purpose**: Private sermon library and preaching record for a pastor or teaching team to organize sermons, track preaching dates and places, search Scripture passages and indexed notes, and manage workspaces.
2. **Users & devices**: Pastors, teaching coordinators, and workspace viewers — desktop (`1280px+`) for weekly prep and planning, phone (`390px`) on Sundays and midweek meetings for quick lookup.
3. **Single next action per screen**: Continue with Google (Sign-in), New draft (Library), Log preaching (Preaching Calendar & Sermon Detail), Find (Find in notes), Search (Search), Create workspace (New workspace).
4. **Density**: Medium-to-dense on data views (Library, Preaching Calendar, Search, Sermon record); calm and focused on Sign-in and dialogs.
5. **Motion**: Hover, press, and subtle disclosure transitions only (`150ms` ease-out, `transform` and `opacity`), with skeleton pulse disabled under `prefers-reduced-motion: reduce`. Removes idle bookshelf sway and spinning cover art.

## Chosen direction and why

Three structural variants were built and evaluated (`?variant=A|B|C`):

- **Variant A — Editorial Rail (Recommended)**: Sticky `252px` left rail on desktop with the workspace switcher anchored at the top, promoting **Library**, **Preaching Calendar**, and **Search** as co-equal top-level destinations with Workspace management grouped below. Eliminates the decorative desktop bookshelf hero and duplicate header/library search bars, bringing 8+ sermons immediately above the fold on desktop and 4+ edge-to-edge hairline rows above the fold on 390px mobile with a 4-item bottom tab bar.
- **Variant B — Split Studio**: Side-by-side master list and live sermon reader pane on desktop. Great for rapid triage across sermons, though tighter horizontally on 1280px laptops for wide metadata.
- **Variant C — Top Command Bar**: Horizontal top navigation with a series filter pill strip and full-width Scripture-indexed table. Maximizes tabular scanning width, at the cost of tucking workspace management into secondary settings nav.

**Why Variant A wins**: Pastors return daily across Library, Preaching Calendar, Search, and multiple workspaces. A persistent side rail makes the current workspace and role always legible without consuming vertical space above data tables, scales cleanly to a 4-tab bottom bar on phones, and preserves an ideal 60–68ch reading column on Sermon Detail and Search excerpts.

## Design tokens (`tokens.css`)

- **Palette**: Warm archival paper ground (`#f7f5f0`), crisp white working sheets (`#ffffff`), warm charcoal ink (`#1b1917`), muted ink (`#5c5750`, 6.3:1+ contrast), and deep terracotta accent (`#9e3a24`, 6.5:1 with white text; `#8c321e` for accent text at 7.0:1+). Status badges pair soft fills with >= 6.5:1 ink and always include a literal word.
- **Typography**: Display (`Plus Jakarta Sans`), UI (`Inter`), and Body (`Inter`, `16px/1.55`, `68ch` max-width), with `font-variant-numeric: tabular-nums` on all figures, counts, dates, and tables. Strict `13px` text floor (`11px` limited to mobile tab bar labels and compact count/day badges).
- **Spacing & Radius**: Strict `4 / 8 / 12 / 16 / 24 / 32 / 48 / 64px` scale; `6px` small radius, `10px` panel radius, `999px` pill radius.

## Evidence & self-check

Screenshots (desktop `1280×860` and mobile `390×844`) are stored in `/Users/rico/Git/rico-mode/state/evidence/sermons-neon-redesign/`. Three visual review passes were completed in `ego-browser`:

- **Pass 1 fixes**: Rebuilt Variant B left list as compact 3-column master rows to eliminate title/date overlap; constrained workspace switcher popover width inside desktop rail to stop right-edge clipping; shortened mobile calendar cell count tags (`1×`) to prevent truncation; paired mobile Library selects side-by-side and tightened the mobile Calendar year strip to 6×2 so the month grid fits above the fold; aligned Find-in-notes submit button with its input; synced empty/loading/error summaries; added `inert` on background shell when dialogs open.
- **Pass 2 fixes**: Added `flex: none` to `.segmented` and capped desktop select widths to `146px` so the `Active / Archived` control and search input fit cleanly on a single unclipped desktop toolbar row; hid stale rail count badges during loading and error states.

## Not verified

- Real backend API latency, live Google OAuth redirect, and live D1/R2 PDF upload/consent/rollback flows (prototype uses realistic in-memory sample data adapted from `scripts/seed-staging.mjs`).
- Screen reader announcements (VoiceOver / NVDA) and Safari / Firefox cross-browser rendering.
- Independent fresh-eyes visual review by a separate model/reviewer.
