# Sermon Bank — Selected Phase B direction

## Status

**Living Library + Chronicle** ([LIVING-LIBRARY-CHRONICLE.md](LIVING-LIBRARY-CHRONICLE.md), [living-library-chronicle.html](living-library-chronicle.html)) is the locked direction from issue #2 and is implemented on `main`. See [ui.md](../../ui.md) and [search.md](../../search.md).

**C-neutral** (`phase-c-*`, `selected-workspace.*`, [PHASE-C-CONTRACT.md](PHASE-C-CONTRACT.md)) and [explorations.html](explorations.html) are **superseded history**, kept for reference only.

> **Superseded history.** Everything below the Status section records the earlier C-neutral selection. It is kept for reference only and is not the implementation target. Use the Living Library + Chronicle direction above.

**Historical: selected on 10 November 2026:** **C — Quiet Workspace, neutral palette**. This was the visual direction at that time. It was later superseded by Living Library + Chronicle.

## Phase C refined experience — 10 November 2026 (superseded)

**Historical source of truth (superseded):** [Phase C interaction and state contract](PHASE-C-CONTRACT.md). C-neutral's responsive interactions, permission rules, document-source safeguards, and error states were refined into a connected offline demonstration.

**Open [Phase C standalone interactive prototype](phase-c-standalone.html).** Download the raw HTML and open it locally in a modern browser; no installation or companion files are required. For engineering inspection, the modular [HTML](phase-c.html), [CSS](phase-c.css), and [JS](phase-c.js) sources are also preserved. No real OAuth, uploads, emails, database or live document reads happen.

The mock tested create/edit draft, add document version, consent, repeat preaching with a version, search and highlights, place rename/merge, archive/restore and Owner delete confirmation, membership role gates and revocation, workspace switching, private migration review, and loading/empty/error/denied/revoked states. All changes reset on refresh. **These are simulations; do not treat them as production security or persistence.**

**Original concept C reference:** selected-workspace.html. It preserves the earlier layout and was superseded for interactions by phase-c.html, and both are now superseded by Living Library + Chronicle. A/B alternatives remain historical only.

## Historical references (superseded)

- **[Selected interactive concept — Quiet Workspace / neutral](selected-workspace.html)** — the former design baseline, now superseded (open the raw HTML in a browser).
- **[Static desktop reference](selected-workspace.svg)** — fictional sample data, neutral color and layout.
- [Exploration archive — A/B/C](explorations.html) — historic comparison only; **not** the implementation target.
- [Canonical design issue #2](https://github.com/favorchurch/sermons.favor.church/issues/2) — approvals, constraints and remaining refinements.
- [Product requirements (PRD v1.0)](../../PRD.md).

## Former C-neutral visual direction (superseded)

- **Navigation:** persistent left sidebar on desktop for Archive, History, Places and Settings; on mobile, sidebar becomes a compact, horizontally scrollable header navigation. Other owned/shared workspaces are managed in Settings (not a distracting daily global switcher).
- **Density:** compact, scannable tabular archive with predictable title, Scripture, preaching, version and action columns. Mobile prioritizes sermon title, date, and view action instead of shrinking the full desktop layout; desktop stays horizontally stable with scoped responsive reductions.
- **Styling:** internationally neutral identity — warm-neutral/soft sage canvas, white utility surfaces, charcoal text, restrained borders, clear typographic hierarchy, subtle green action color. Do **not** make orange, Favor-specific logos, proprietary Favor typefaces, church-specific language or decorative motifs required by the interface.
- **Detail interaction:** focused dialog on desktop, bottom-aligned scrollable sheet on mobile. Default view separates versions, read-only source status, and each preaching event. Permit an Editor to record another preaching from that context; prevent duplication of master sermon.
- **Search:** prominent title/scripture/tag/location/full-text query, church/year filters with clear action, highlighted excerpts only when indexed and authorized; revoked and indexing content never appear as matching excerpts.
- **Permission UX:** role-aware Owner/Admin/Editor/Viewer controls. Viewer reads; Editor manages archive metadata; Admin also invites Editor/Viewer; Owner alone delegates Admin, transfers ownership, or authorizes permanent deletion. Hide or disable action controls with explanations, and enforce rules server-side later.
- **Source safety:** modifying app records does not modify original Google Docs or PDF bytes. Version references are explicit and pastor-managed. Indexing and searchable text require explicit owner consent, with revoked access removing derived index content.
- **Migration:** private provisional review queue; preserve original identifiers, attribution uncertainty, possible duplicates, and historical data; only assign ownership after verification. Never expose actual source archive in the public repository.

## Former Phase C refinement list (superseded, not carried forward)

- Validate dialogs with full keyboard focus trapping, escape/focus return, screen readers, and touch targets.
- Design intentional loading skeletons, authorization errors, retry/fallback, stale/indexing permission revoked, blank archive and destructive confirmation/recovery.
- Finalize table sticky/responsive behavior and deep-links, repeat-preaching association to explicit document version, full page Settings flows.
- Validate the original pilot workflows with authorized reviewers without putting identifiable archival records in public artifacts.
- Production will require Google OAuth read-only consent, server role checks, persistent data and real search; **this standalone HTML has none**.

---

## Historical exploration notes

## Earlier A/B/C explorations

**Archive status:** C-neutral was selected at the time and is now itself superseded; A, B and C remain as historical comparisons.

This directory is a **public-safe prototype** using entirely fictional data. It is not a production application and contains no real sermon notes, Google tokens, private pilot records, or imported content.

## Open the prototype

Download `explorations.html` and open it in a modern desktop or mobile browser. No build system, backend, network access or sign-in is required.

Use the three top switches to compare:

| Concept | Navigation | Core strength | Trade-off |
|---|---|---|---|
| A — Editorial Archive | Header navigation, prominent search, warm serif cards | Familiar to the original single-file inspiration, minimal learning curve | Cards require more scrolling as archives grow |
| B — Preaching Timeline | Timeline-led archive with each preaching as an event | Makes repeat preaching, dates, and churches immediately visible | Less emphasis on notes/versions as primary organizing units |
| C — Quiet Workspace | Sidebar on desktop, compact data-oriented list | Best for assistants managing large libraries and detailed metadata | More of an administration-tool feel |

## Try these flows

1. Search by sermon title, Scripture, tag, or church; change year/church filters; clear filters.
2. Add a sermon (a title alone is enough). It creates a **new in-memory draft** without mutating an original document.
3. Log a new preaching for an existing sermon. This adds a history record, not a duplicate sermon.
4. Visit **Places**, rename a fictional church, and return to the archive to see the update.
5. Switch **Demo as** to Owner, Admin, Editor, or Viewer and see write controls change.
6. In **Settings**, preview team invitations, read-only document consent, and private migration review.
7. Switch layouts at desktop width and on a narrow phone-sized browser.

## Explicit boundaries

- No network calls or real persistence; actions are session-only and refresh resets demo state.
- No file upload, Google authorization, real full-text index or backend. These are described, not simulated as successful live operations.
- The application **must not edit original Google Docs or overwrite original PDFs**, regardless of role.
- Owner controls Admin delegation and permanent data deletion; Admin can invite Editors/Viewers; Editor maintains records; Viewer reads/searches only.
- C-neutral was approved as the visual direction; capture Phase C refinements in [design issue #2](https://github.com/favorchurch/sermons.favor.church/issues/2).
- Source requirements: [PRD v1.0](../../PRD.md).

## Before implementing

The selected concept is C-neutral. Refine responsive behavior, accessible forms, empty/error/indexing/revoked states, permission boundaries, workspace onboarding and non-destructive document version semantics. The interactive concept page is a conversation aid, **not** an executable functional specification.

Public examples may never be replaced with real pilot sermon records in GitHub.