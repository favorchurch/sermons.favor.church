# Sermon Bank

An open-source, private-by-default sermon archive for pastors and their teams.

**Status:** Greenfield Phase 1 / unmerged authentication and tenancy implementation. A Google OIDC pilot sign-in, session handling, membership-scoped metadata routes and manual invitation API are implemented, but no online application, email delivery, private data import, PDF upload or document search is deployed. See [auth handoff](docs/auth-handoff.md).

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

`wrangler.jsonc` deliberately contains a **non-deployable D1 database ID** and a non-provisioned private R2 bucket name. Local development is allowed; **do not deploy** until separate private Cloudflare resources are provisioned, actual IDs/bucket names are configured, authenticated endpoints and tenant isolation tests pass, and release gates are approved. The Workers D1/R2 bindings are present to define the intended topology, not to claim production provisioning.

A private staging environment (`env.staging` in `wrangler.jsonc`, synthetic data only) exists for the auth pilot. Setup, secrets handling, deploy and the `pnpm qa:staging` end-to-end auth check are documented in [docs/auth-handoff.md](docs/auth-handoff.md). There is no production environment.

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

See [docs/auth-handoff.md](docs/auth-handoff.md) for the API contract, local tests, Google OAuth and Cloudflare prerequisites. This code will reject requests unless the exact HTTPS `PUBLIC_ORIGIN` and private sign-in credentials are configured. Email-link login and any real note indexing are **not** live.
