# Sermon Bank — Phase B interaction explorations

**Status:** Design exploration; no visual direction approved.

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
- No one has approved one of these visual directions. Capture review feedback in [design issue #2](https://github.com/favorchurch/sermons.favor.church/issues/2).
- Source requirements: [draft PRD #1](https://github.com/favorchurch/sermons.favor.church/pull/1).

## Before implementing

Choose a concept or a hybrid. Lock responsive behavior, accessible forms, empty/error/indexing/revoked states, permission boundaries, workspace onboarding and non-destructive document version semantics. The interactive concept page is a conversation aid, **not** an executable functional specification.

Public examples may never be replaced with real pilot sermon records in GitHub.