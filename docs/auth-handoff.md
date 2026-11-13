# Greenfield auth and private-workspace boundary (pilot)

**Scope:** the Google-only pilot sign-in and the server-side role/tenant gate that every other route sits behind. The library, search, PDF, import and UI routes are documented in [library-api.md](library-api.md), [search.md](search.md), [sources.md](sources.md), [import-review.md](import-review.md) and [ui.md](ui.md), and the review path is [pilot.md](pilot.md). Invitations are not sent by email. Email magic-link sign-in and full self-registration are separate later work.

## Endpoints (JSON and no-store unless indicated)

- `GET /health`: public minimal health response.
- `GET /signin`: minimal pilot sign-in page; no content or account list.
- `GET /auth/google/start`: one-time state and nonce in D1, PKCE S256, HTTP-only callback cookie, redirect to Google's server-side authorization-code flow.
- `GET /auth/google/callback`: one-time state consumption, server code exchange, Google JWKS RSA verification, issuer/audience/nonce/time/email-verified checks, allowlist/invitation eligibility, hashed session token and host-only cookie. Never stores OAuth access tokens or authorization codes.
- `POST /auth/logout`: requires exact Origin header, revokes server session and clears cookie.
- `GET /api/me`: authenticated account identity only.
- `GET /api/workspaces`: accepted, active memberships only.
- `POST /api/workspaces`: only a verified Google user whose email is privately included in `PILOT_OWNER_EMAILS` can create the first personal workspace (Owner role).
- `GET /api/workspaces/:uuid/sermons` and every other path under `/api/workspaces/:uuid/` (library, search, imports, PDFs): session plus active membership check, and an explicit `workspace_id = ?` parameter is **also** included in each SQL query. Sermon lists return only metadata, not note contents or links.
- `GET /api/workspaces/:uuid/members`: Owner and Admin only. Accepted, unrevoked members.
- `POST /api/workspaces/:uuid/invitations`: Owner may invite Admin/Editor/Viewer; Admin may invite Editor/Viewer; Editor/Viewer cannot invite. Rate capped at 20 invitations per workspace in 24 hours. Returns a one-time opaque token to the authorized inviter only; **no email is sent**.
- `POST /api/invitations/accept`: requires signed-in account whose Google verified email exactly matches the invitation; one-time, 7-day expiration; membership transaction and audit.
- `PATCH /api/workspaces/:uuid/members/:accountUuid`: Owner may manage Admin/Editor/Viewer; Admin may manage Editor/Viewer only. Nobody can demote/revoke Owner using this endpoint. Membership revocation removes access on the next request; other workspaces remain unaffected.

All JSON mutation routes require `Origin` equal to the configured `PUBLIC_ORIGIN`, and no cross-origin CORS is enabled. Non-members receive `404` on workspace paths, never the requested workspace's data. Session tokens, invite tokens, OAuth codes, verified ID tokens, and raw note text must not be logged. All source records remain private and unassigned pending migration review.

## Real Google OAuth / Cloudflare configuration (must be performed before deployment)

1. Create a Google Cloud **Web application OAuth client** under a trusted project with appropriate consent-screen settings. Register the exact `https://<pilot-host>/auth/google/callback` redirect URI; no wildcard. Use only `openid email profile` for **sign-in**. This does not grant Google Drive document access. Docs linking/indexing will be a distinct read-only authorization and Owner consent flow.
2. Configure `PUBLIC_ORIGIN=https://<pilot-host>` with no trailing path or port mismatch; set secret/runtime bindings `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PILOT_OWNER_EMAILS` through private Cloudflare secrets/vars. **Do not commit credentials or real pilot emails**. Provision real isolated D1 and private R2 resources, replacing the all-zero D1 placeholder and unprovisioned R2 bucket name in Wrangler config. The Worker intentionally refuses non-HTTPS origin and unconfigured environments.
3. Install Wrangler and run `pnpm run types` (generates authoritative `worker-configuration.d.ts` from config) before `pnpm run typecheck`; never hand-maintain a shadow `Env` declaration. Apply every D1 migration (`0001` to `0006`) to a local or controlled preview database only, before testing login. Protect `/auth/*` with application rate limits / Cloudflare rules before exposing a public login endpoint.
4. Bootstrap the pilot using a verified pastor email privately listed in `PILOT_OWNER_EMAILS`, then `POST /api/workspaces` with a confirmed workspace name. Once created, invite only verified assistants. **Do not** add a generic staff-access bypass or automatically assign imported records to the signed-in account.
5. Add a secure invitation-delivery UI and verified email magic-link sign-in (with an email provider), plus owner consent/revocation of Google Doc index before opening registrations globally. In this PR, invitations are token-based API-only and Owner/Admin must deliver the token securely outside the app if testing; no mailer exists yet.

## Privacy, permission and rollback gates

- Backend D1 query tenancy covers metadata, search, PDF download and import routes. Each is scoped by workspace in its queries, tested in `tests/`, and exercised against staging by `pnpm qa:staging` (unauthenticated 401/404, cross-workspace 404, Viewer 403 on mutations, search that never crosses a workspace or returns revoked text). Any new route must be added to the route table in `scripts/staging-qa.mjs`.
- Owner sign-in eligibility uses a private allowlist; a pending invitation permits sign-in but grants **zero** workspace access until accepted.
- Server-side sessions are valid for 7 days and hashed in D1. Revoking membership immediately prevents subsequent access; session logout invalidates the server-side token. Google subject is canonical; changing the verified email or linking a different subject to an already linked account requires manual review.
- Source originals (Google Docs / PDFs) are never modified. Public repository holds synthetic fixtures only; no private spreadsheet rows or client secrets.
- D1 `batch` transactional writes must be reviewed against live binding behavior. The local integration tests use Node's experimental SQLite with a thin D1 API shim, **not** a deployed Worker.
- After configuring staging, run negative tests with two workspaces, non-member direct URL access, guest/Editor/Admin matrix, invitation token replays, logout, OAuth state replays, and session/role revocations. Review DB backups and emergency audit/recovery before pilot.
- Block merge/release if GitHub Actions startup failure persists, Google settings are missing, consent/source revocation tests are absent, or credential/billing/preview status is unclear. No production deployment is authorized by this implementation slice.

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
- Secrets are set by the operator, never committed. Names only: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PILOT_OWNER_EMAILS`. Set each with `pnpm exec wrangler secret put <NAME> --env staging`.
- Migrate: `pnpm exec wrangler d1 migrations apply DB --env staging --remote`, then verify with `pnpm exec wrangler d1 migrations list DB --env staging --remote`.
- Deploy: `pnpm exec wrangler deploy --env staging`. Check `/health`.
- Never pass `--remote` without `--env staging`. The top-level env holds placeholders only.
- Without the secrets set, `/health` works but sign-in does not.
- QA: `pnpm qa:staging` seeds synthetic `*.test` rows (two workspaces with sermons, versions, places, an event and indexed note text, including a revoked version whose text was never purged) in the staging D1 only, exercises the deployed Worker over HTTP, prints a PASS/FAIL/SKIP table, exits non-zero on failure and removes its rows, then checks that no account, workspace, library, note text or search index row is left. Needs a logged-in `wrangler` and resolves DNS through DoH (`QA_DOH_URL`). It stops before writing anything if migrations `0004` to `0006` are not applied. The `/auth/google/start` checks report SKIP while Google secrets are unset. The real Google sign-in round trip is done by hand in a browser. Coverage beyond the auth checks:
  - Unauthenticated: 401 on every library, search, import, PDF, member and invitation route, and 404 for `/assets/*` and `/index.html` (the sign-in page at `/`).
  - Signed in: the app shell with a strict CSP and no embedded data.
  - Viewer: reads work and every mutation is 403, and afterwards nothing in the database has changed. Editor and Admin are 403 on Owner-only routes.
  - A member of another workspace, and the Owner under another workspace's URL, get 404 on every route. Other-workspace ids inside the Owner's own workspace are 404 or refused.
  - Search and Find in notes never return another workspace's text, titles or ids, ignore search operators and never return revoked text.
- Seed: `pnpm seed:staging --workspace "<name or id>" [--dry-run]` adds fictional demo sermons, versions, events, places and indexed note text to that one staging workspace. It needs the same migrations, refuses any other environment, is idempotent and creates no accounts, sessions or PDF objects. See [pilot.md](pilot.md#demo-data).
