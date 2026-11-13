# Sermon Bank

An open-source, private-by-default sermon archive for pastors and their teams.

**Status:** Greenfield pilot. Production pilot at https://sermons.favor.church (invite-only); staging at https://sermons-preview.favor.church. Implemented and tested in this repository: Google sign-in with invite-only access and roles, the Living Library app (library, calendar, sermon detail, search and Find in notes, places, people and access, import review, private PDFs with Owner consent and revoke), and a seed and QA script for staging. Not built: Google Doc ingest, email delivery. To review it, start at the [pilot guide](docs/pilot.md). Contracts: [auth handoff](docs/auth-handoff.md), [library API](docs/library-api.md), [search](docs/search.md), [PDF sources](docs/sources.md), [UI](docs/ui.md), [import review](docs/import-review.md).

- Product decisions: [PRD draft #1](https://github.com/favorchurch/sermons.favor.church/pull/1)
- Selected UX: [Living Library + Chronicle draft #4](https://github.com/favorchurch/sermons.favor.church/pull/4)
- Engineering work: [issue #5](https://github.com/favorchurch/sermons.favor.church/issues/5)

## Local foundation

Requires Node.js 22.6+, Python 3.12+, and pnpm (version pinned in `packageManager`). Run:

```sh
pnpm install
pnpm run check
pnpm run migrate:local
pnpm run dev
```

The top level of `wrangler.jsonc` deliberately contains a **non-deployable D1 database ID** and a non-provisioned private R2 bucket name, for local development only. Deploy only with `--env staging` or `--env production`; see [docs/auth-handoff.md](docs/auth-handoff.md).

A private staging environment (`env.staging` in `wrangler.jsonc`, synthetic data only) exists for the pilot. Setup, secrets handling and deploy are in [docs/auth-handoff.md](docs/auth-handoff.md). Two scripts run against it (both need a logged-in `wrangler`, both refuse anything but staging):

```sh
pnpm seed:staging --workspace "<archive name or id>" [--dry-run]   # fictional demo sermons, events, places and indexed notes
pnpm qa:staging                                                    # end-to-end auth, access and search-isolation checks
```

Production (`env.production`: Worker `sermon-bank`, D1 `sermon-bank`, R2 `sermon-bank-private-pdfs`) holds real data. Neither script runs against it. `pnpm run check` and `pnpm run dev` need macOS 13.5 or newer (workerd); CI runs the checks on Ubuntu.

## Private historic import

Use a **private export** of the canonical history tab to dry-run the importer, **outside this public repository**:

```sh
node scripts/dry-run-import.mjs --input /private/path/history.csv --tab 'All History'
```

The default result prints *aggregate counts only*. For an authorized private local review file, optionally add `--private-output /private/path/migration-review.json` **outside** the repository. That file contains raw source rows and must never be committed, shared through public CI artifacts, or placed in a public storage bucket. The command never calls an online API or modifies the source spreadsheet. It never assigns ownership to a pastor.

The workbook also contains historical subtabs, which should be used for reconciliation and not blindly reimported. The source workbook URL and raw values must not be embedded in this public repository.

## Safe architecture boundary

- Separate private pastor workspaces; Owner, Admin, Editor, Viewer.
- One sermon master with named versions and many preaching occasions.
- Google Docs remain read-only originals; uploaded PDFs are private immutable objects.
- Owner consent before exposing extracted Google Doc text to workspace members.
- No unauthenticated title/count/snippet/download API; indexes must honor workspace and source grants.
- Staging records require human-verified ownership before assignment.

The D1 migration is a schema baseline, **not** evidence of working application authorization. See `docs/greenfield.md` for the remaining implementation gates.

## Auth and tenancy implementation

See [docs/auth-handoff.md](docs/auth-handoff.md) for the API contract, local tests, Google OAuth and Cloudflare prerequisites. This code will reject requests unless the exact HTTPS `PUBLIC_ORIGIN` and private sign-in credentials are configured. Email-link login and Google Doc indexing are **not** built. Note text is indexed only from uploaded PDFs after an Owner consents.

## Reviewing the pilot

[docs/pilot.md](docs/pilot.md) is the review path: operator checklist, sign in, what to try, known limits and what is deferred.
