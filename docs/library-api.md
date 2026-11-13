# Library API

Workspace-scoped CRUD for sermons, versions (metadata only), preaching events and places.
All routes live under `/api/workspaces/:workspaceId`. Ids are UUIDs.

## Access rules

- Session cookie required (`401` otherwise). Every non-GET request must be same-origin (`403 invalid_origin`).
- A caller who is not an active member of the workspace, or who names an id from another workspace, gets `404 {"error":"not_found"}` with no titles or counts.
- Read routes: any member. Mutations: Owner, Admin, Editor. Viewer gets `403 forbidden` before the body is read.
- Every mutation writes one `audit_events` row (ids, counts and field names only, never titles or notes).
- Bodies are strict JSON objects: unknown fields are `400 unknown_field`. Validation errors are `400 {"error","field"}`. State conflicts are `409`.

## Routes

| Method | Path | Notes |
|---|---|---|
| GET | `/sermons` | `archived=exclude\|include\|only` (default exclude), `limit` 1-100, `offset` |
| POST | `/sermons` | `title`, `scripture_references[]`, `series_name`, `description`, `tags[]` |
| GET | `/sermons/:id` | sermon plus `versions[]` and `preaching_events[]` |
| PATCH | `/sermons/:id` | any of the create fields; `scripture_references` replaces the list |
| POST | `/sermons/:id/archive`, `/restore` | `409` if already in that state |
| GET/POST | `/sermons/:id/versions` | `label`, `source_type` (`google_doc`\|`pdf`\|`external`), `source_url` (https), `google_document_id` |
| PATCH | `/sermons/:id/versions/:vid` | `label`; source fields only while `indexing_state` is `not_indexed` (else `409 source_locked`) |
| GET/POST | `/sermons/:id/events` | `preached_on`, `date_precision`, `raw_date`, `occasion`, `version_id`, `place_id` |
| GET | `/events` | calendar and filters: `year`, `month` (needs `year`), `sermon_id`, `place_id`, `limit`, `offset` |
| GET/PATCH/DELETE | `/events/:eid` | |
| GET/POST | `/places` | `display_name`; list includes `aliases[]` and `event_count` |
| PATCH | `/places/:id` | rename |
| GET | `/places/:id/merge-preview?target=:id` | events and aliases that would move; changes nothing |
| POST | `/places/:id/merge` | body `{"target_place_id"}`; source is deleted, its name becomes an alias, history goes to `place_merges` |

Version responses never include storage keys or consent identities. Version create cannot set `indexing_state`.

## Dates

`preached_on` is a date-only string. `YYYY` and `YYYY-MM` are stored as the first day of the period. If `date_precision` is omitted it is inferred from the shape (`exact`, `month`, `year`, or `unknown` when null). Explicit precisions must match the date. Calendar queries: a year returns every precision; a month returns `exact`, `month` and `needs_review` events only. Each event includes `date_precision`.

## Local use without Google sign-in

`node scripts/dev-session.mjs --email dev@example.test --workspace "Dev Archive"` inserts a normal hashed session row into the local wrangler D1 (`sermon-bank-local`) and prints how to call the API. It refuses `--remote`, `--env`, any other database and unknown flags, and the Worker has no bypass.

## Adding routes

Routes are registered in `src/api/routes.ts` (`ROUTES`, append below the marker). Paths are relative to the workspace, `:params` must be UUIDs, non-GET routes are refused for Viewers before the handler runs, and handlers may throw `Invalid` (400) or `Conflict` (409) from `src/api/http.ts`.
