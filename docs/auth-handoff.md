# Google auth and private-workspace boundary

**Scope:** Google sign-in and the server-side role/tenant gate that every other route sits behind. Any verified Google account may sign in and explicitly create workspaces; existing account-disable and identity-conflict checks still apply. Workspace content remains private to accepted, active members. The library, search, PDF, import and UI routes are documented in [library-api.md](library-api.md), [search.md](search.md), [sources.md](sources.md), [import-review.md](import-review.md) and [ui.md](ui.md), and the review path is [pilot.md](pilot.md). Invitations are not sent by email. Email magic-link sign-in is separate later work.

This is the current source contract. The former pilot allowlist (`PILOT_OWNER_EMAILS`) is no longer read by `src/auth/app.ts`; an invitation is needed to join someone else's workspace, not to sign in or create one's own. This documentation does not establish which source version is deployed in either environment.

## Endpoints (JSON and no-store unless indicated)

- `GET /health`: public minimal health response.
- `GET /signin`: minimal sign-in page; no content or account list.
- `GET /auth/google/start`: one-time state and nonce in D1, PKCE S256, HTTP-only callback cookie, redirect to Google's server-side authorization-code flow.
- `GET /auth/google/callback`: one-time state consumption, server code exchange, Google JWKS RSA verification, issuer/audience/nonce/time/email-verified checks, account provisioning or existing-identity checks, hashed session token and host-only cookie. Never stores OAuth access tokens or authorization codes.
- `POST /auth/logout`: requires exact Origin header, revokes server session and clears cookie.
- `GET /api/me`: authenticated account identity, plus the account's saved `layout` and view `prefs` (an object).
- `PATCH /api/me`: accepts `{layout}`, `{prefs: <partial object>}` or both, and returns the full account. `prefs` keys come from a closed list: `libraryView` (`covers`, `rows`, `table`, `calendar`), `sort` (`recent`, `title`, `added`), `archive` (`active`, `archived`), `series` (string up to 200 characters, or null), `searchScope` (`everything`, `bible`, `notes`) and `workspaceId` (string up to 64 characters, or null). Partial prefs merge into the stored object, and a key set to null clears it. An unknown key or a bad value returns `400` with nothing written. The stored JSON is capped at 2 KB. A prefs-only patch never writes the layout.
- `GET /api/workspaces`: accepted, active memberships only.
- `POST /api/workspaces`: any signed-in Google account may explicitly create another workspace and becomes its Owner. Names are trimmed and must be 3 to 120 characters. Migration `0007` removed the one-active-workspace-per-owner index; creating a workspace grants no access to another workspace.
- `GET /api/workspaces/:uuid/sermons` and every other path under `/api/workspaces/:uuid/` (library, search, imports, PDFs): session plus active membership check, and an explicit `workspace_id = ?` parameter is **also** included in each SQL query. Sermon lists return only metadata, not note contents or links.
- `GET /api/workspaces/:uuid/members`: Owner and Admin only. Accepted, unrevoked members.
- `POST /api/workspaces/:uuid/invitations`: Owner may invite Admin/Editor/Viewer; Admin may invite Editor/Viewer; Editor/Viewer cannot invite. Rate capped at 20 invitations per workspace in 24 hours. Returns a one-time opaque token to the authorized inviter only; **no email is sent**.
- `POST /api/invitations/accept`: requires signed-in account whose Google verified email exactly matches the invitation; one-time, 7-day expiration; membership transaction and audit.
- `PATCH /api/workspaces/:uuid/members/:accountUuid`: Owner may manage Admin/Editor/Viewer; Admin may manage Editor/Viewer only. Nobody can demote/revoke Owner using this endpoint. Membership revocation removes access on the next request; other workspaces remain unaffected.

All JSON mutation routes require `Origin` equal to the configured `PUBLIC_ORIGIN`, and no cross-origin CORS is enabled. Non-members receive `404` on workspace paths, never the requested workspace's data. Session tokens, invite tokens, OAuth codes, verified ID tokens, and raw note text must not be logged. All source records remain private and unassigned pending migration review.

## Real Google OAuth / Cloudflare configuration (must be performed before deployment)

1. Create a Google Cloud **Web application OAuth client** under a trusted project with appropriate consent-screen settings. Register the exact `https://<environment-host>/auth/google/callback` redirect URI; no wildcard. Use only `openid email profile` for **sign-in**. This does not grant Google Drive document access. Docs linking/indexing will be a distinct read-only authorization and Owner consent flow.
2. Configure `PUBLIC_ORIGIN=https://<environment-host>` with no trailing path or port mismatch; set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` through private Cloudflare secrets. **Do not commit credentials or real account emails**. Use the intended environment's isolated D1 and private R2 resources; the top-level config contains deliberately non-deployable placeholders. The Worker refuses non-HTTPS origin and unconfigured environments.
3. Install Wrangler and run `pnpm run types` (generates authoritative `worker-configuration.d.ts` from config) before `pnpm run typecheck`; never hand-maintain a shadow `Env` declaration. Before testing login, verify every migration in the checked-out `migrations/` directory is applied to the local or controlled preview database. Current source has nine (`0001` to `0009`), including multiple workspaces (`0007`), account layout (`0008`) and view preferences (`0009`). A script's older table-presence check is not proof that the current schema is complete. Confirm `/auth/*` rate limits / Cloudflare rules for the deployed environment.
4. Sign in with the reviewer's verified Google account, then use **Create workspace** on the empty state or **New workspace** in the header switcher. An invitation to an existing workspace must be accepted by the account with the matching verified email. **Do not** add a generic staff-access bypass or automatically assign imported records to the signed-in account.
5. Owner/Admin can create an invitation in **Settings → People & Access** and deliver the one-time token securely outside the app. There is no mailer. Email magic-link sign-in and Google Doc authorization/indexing remain separate work, not prerequisites for the current Google sign-in flow.

## Privacy, permission and rollback gates

- Backend D1 query tenancy covers metadata, search, PDF download and import routes. Each is scoped by workspace in its queries, tested in `tests/`, and exercised against staging by `pnpm qa:staging` (unauthenticated 401/404, cross-workspace 404, Viewer 403 on mutations, search that never crosses a workspace or returns revoked text). Any new route must be added to the route table in `scripts/staging-qa.mjs`.
- Signing in grants **zero** access to another person's workspace. Access requires an accepted, active membership; a pending invitation grants no workspace access until accepted.
- Server-side sessions are valid for 7 days and hashed in D1. Revoking membership immediately prevents subsequent access; session logout invalidates the server-side token. Google subject is canonical; changing the verified email or linking a different subject to an already linked account requires manual review.
- Source originals (Google Docs / PDFs) are never modified. Public repository holds synthetic fixtures only; no private spreadsheet rows or client secrets.
- D1 `batch` transactional writes must be reviewed against live binding behavior. The local integration tests use Node's experimental SQLite with a thin D1 API shim, **not** a deployed Worker.
- After configuring staging, run negative tests with two workspaces, non-member direct URL access, guest/Editor/Admin matrix, invitation token replays, logout, OAuth state replays, and session/role revocations. Review DB backups and emergency audit/recovery before pilot.
- Block merge/release if GitHub Actions startup failure persists, Google settings are missing, consent/source revocation tests are absent, or credential/billing/preview status is unclear. Production was first deployed on 2026-11-14 with Rico's approval (see Production below).

## Local validation (without Google/Cloudflare accounts)

```sh
node --experimental-strip-types --experimental-sqlite --test tests/*.test.mjs
python3 scripts/check_schema.py
python3 scripts/check_auth_schema.py
```

Real CI should run `pnpm run check` after `pnpm install --frozen-lockfile`; it invokes Wrangler type generation (needs network-installed packages) and TypeScript, followed by the same tests. A temporary local `worker-configuration.d.ts` used to test compilation without network access to the package registry must **not** be committed.

## Staging (sermons-preview.favor.church)

Staging holds synthetic data only. Never import real sermon, member or PDF data into it.

- Cloudflare account: FAVOR CHURCH. Wrangler env: `staging` (Worker `sermon-bank-staging`, `workers_dev: false`).
- Origin: `https://sermons-preview.favor.church` (custom domain route, `PUBLIC_ORIGIN` var).
- D1: `sermon-bank-staging` (binding `DB`). R2: `sermon-bank-private-pdfs-staging` (binding `PRIVATE_PDFS`), private: r2.dev access disabled, no custom domains.
- Required Google sign-in secrets are set by the operator, never committed. Names only: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Set each with `pnpm exec wrangler secret put <NAME> --env staging`.
- Migrate: `pnpm exec wrangler d1 migrations apply DB --env staging --remote`, then verify with `pnpm exec wrangler d1 migrations list DB --env staging --remote`.
- Deploy: `pnpm exec wrangler deploy --env staging`. Check `/health`.
- Never pass `--remote` without `--env staging`. The top-level env holds placeholders only.
- Without the secrets set, `/health` works but sign-in does not.
- QA: `pnpm qa:staging` seeds synthetic `*.test` rows (two workspaces with sermons, versions, places, an event and indexed note text, including a revoked version whose text was never purged) in the staging D1 only, exercises the deployed Worker over HTTP, prints a PASS/FAIL/SKIP/WARN table, exits non-zero on failure and removes its rows, then checks that no account, workspace, library, note text or search index row is left. Needs a logged-in `wrangler` and resolves DNS through DoH (`QA_DOH_URL`). It stops before writing anything if migrations `0004` to `0006` are not applied. The `/auth/google/start` checks report SKIP while Google secrets are unset. The real Google sign-in round trip is done by hand in a browser. Coverage beyond the auth checks:
  - Unauthenticated: 401 on every library, search, import, PDF, member and invitation route, and 404 for `/assets/*` and `/index.html` (the sign-in page at `/`).
  - Signed in: the app shell with a strict CSP and no embedded data.
  - Viewer: reads work and every mutation is 403, and afterwards nothing in the database has changed. Editor and Admin are 403 on Owner-only routes.
  - A member of another workspace, and the Owner under another workspace's URL, get 404 on every route. Other-workspace ids inside the Owner's own workspace are 404 or refused.
  - Search and Find in notes never return another workspace's text, titles or ids, ignore search operators and never return revoked text.
- Seed: `pnpm seed:staging --workspace "<name or id>" [--dry-run]` adds fictional demo sermons, versions, events, places and indexed note text to that one staging workspace. It needs the same migrations, refuses any other environment, is idempotent and creates no accounts, sessions or PDF objects. See [pilot.md](pilot.md#demo-data).

## Production (sermons.favor.church)

Production holds real data. Never run the seed or QA scripts against it, and never import synthetic data into it.

- Wrangler env: `production` (Worker `sermon-bank`, `workers_dev: false`, `preview_urls: false`).
- Origin: `https://sermons.favor.church` (custom domain route, `PUBLIC_ORIGIN` var).
- D1: `sermon-bank` (binding `DB`). R2: `sermon-bank-private-pdfs` (binding `PRIVATE_PDFS`), private: r2.dev access disabled, no custom domains.
- Required Google sign-in secrets, names only: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Set each with `pnpm exec wrangler secret put <NAME> --env production`. The Google OAuth client must list `https://sermons.favor.church/auth/google/callback` as an authorized redirect URI.
- Before migrating: `pnpm exec wrangler d1 time-travel info DB --env production` and record the bookmark. Migrate: `pnpm exec wrangler d1 migrations apply DB --env production --remote`.
- Deploy: `pnpm exec wrangler deploy --env production`. Check `/health`, the signed-out page and an API 401.
- Rollback: `pnpm exec wrangler rollback --env production` to the previous Worker version; restore data with `pnpm exec wrangler d1 time-travel restore DB --env production --bookmark <bookmark>`. A restore discards every write made after the bookmark (invites, role changes, consent and revoke records), so a restored revoke can make revoked text searchable again. Before restoring, export the audit log, and after restoring, re-apply any revokes recorded after the bookmark.
- Logging: production disables invocation logs and traces so request URLs (search text in `?q=`, OAuth `?code=`) are not stored in Cloudflare logs. Keep it that way.
- The top-level Worker name is `sermon-bank-local`, so a wrangler command without `--env` cannot act on the production Worker `sermon-bank`. Always pass `--env staging` or `--env production`.
