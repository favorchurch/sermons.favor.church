# Pilot review guide (staging)

For the person reviewing the private pilot of Sermon Bank at **https://sermons-preview.favor.church**. Staging holds synthetic data only. Do not import real sermon, member or PDF data into it.

## Before you start (operator)

The review needs a staging Worker that matches this code, a migrated staging database, the Google sign-in secrets and some demo data. In order:

1. Check what staging has: `pnpm exec wrangler d1 migrations list DB --env staging --remote`. All six migrations (`0001` to `0006`) must be applied. The new tables are additive, so applying them before deploying is safe for the older Worker.
2. Apply any that are missing: `pnpm exec wrangler d1 migrations apply DB --env staging --remote`.
3. Deploy: `pnpm exec wrangler deploy --env staging`. Check `https://sermons-preview.favor.church/health`.
4. Confirm the three secrets exist (`pnpm exec wrangler secret list --env staging`): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PILOT_OWNER_EMAILS`. The reviewer's Google account email must be in `PILOT_OWNER_EMAILS` (to create or own an archive) or have an invitation. If sign-in answers `503 identity_provider_not_configured`, the Google secrets are not set.
5. Run the automated checks: `pnpm qa:staging`. It adds and removes its own `*.test` rows and never touches real rows. `SKIP` lines for Google are expected until the secrets are set. A `WARN NEW-3` line about X-Frame-Options is also expected on live staging: the edge strips that header, and framing is still blocked by the CSP `frame-ancestors 'none'`.
6. Add the demo data to the reviewer's archive: `pnpm seed:staging --workspace "<archive name or id>"` (add `--dry-run` first to see what it would do). It is idempotent. See [Demo data](#demo-data).

## Sign in

1. Open the staging address and choose **Continue with Google**. Use the Google account that is on the pilot list.
2. You land in the Living Library for your archive. If you have no archive yet, the screen offers to create one (pilot owners only). If you were invited, redeem the invitation code on the "no archive yet" screen instead.
3. Choose **Sign out** in the header. Reloading afterwards shows the sign-in page again.

## What to try

Work through these in a real browser, on a laptop and then on a phone. Expected results are in brackets.

1. **Library.** Switch between Covers, Rows and Table. Toggle Active and Archived. Sort. [Same data in each view. The table becomes stacked rows on a phone without sideways scrolling. With the demo data, *Quiet Faith* is archived.]
2. **Calendar.** Open Calendar, move between months and years, select a day. [The current month opens if it has events. A month-only event reads "recorded for the month", a year-only event "recorded for the year", the undated one is counted in a note, and a first-of-month date is marked for review.]
3. **Sermon detail.** Open a sermon. Edit it, log a preaching, archive it and restore it. [Archive and restore ask for confirmation. Every change shows after a reload.]
4. **Search a Bible reference.** Search `John 3:16`. [Two separate groups: **Sermon passage (metadata)** for *For God So Loved* (its notes are not indexed) and **Found in notes** for *Mercy at the Well* with the reference highlighted.]
5. **Search a phrase.** Search `grace is sufficient`, then `sufficient grace`. [The first finds the notes, the second does not: a phrase must match whole words in order. No prefix or fuzzy matching.]
6. **Find in notes.** Open a result. [The sermon opens on Find in notes with the query filled in. Each version says *Found in notes*, *Not in notes* or *Not searchable* (waiting for consent, revoked or not indexed), and a version that is not searchable never shows text.]
7. **Places.** Settings, Places. Rename one. Preview a merge of *Riverbend* into *Riverbend Chapel*, then merge. [The preview lists events and aliases that move and changes nothing. Merge stays disabled until the chosen target has been previewed. After the merge the old name is an alias.]
8. **Invitations and roles.** Settings, People & Access (Owner and Admin). Invite a second Google account as Viewer. [The code is shown once with a Copy button and nothing is emailed: send it yourself.] Sign in as that account, redeem the code, and check that write controls are hidden. Then change the role and revoke the access. [Access ends on the next request.]
9. **Private PDF.** Settings, Docs & Privacy. On a PDF version, upload a short text PDF with fictional content (not a scan, under 10 MB). As Owner, give consent, search for a phrase from it, then revoke. [After upload the version waits for consent and is not searchable. After consent it is searchable. After revoke it disappears from search and download, and revoke is final.]
10. **Import review (Owner).** Settings, Import Review. Upload `tests/fixtures/anonymous-history.csv` from this repository. Attest and approve one row and roll it back. [Upload only stages rows. Approval needs a separate attestation. Nothing appears in the library until a row is approved.]
11. **Access boundaries.** Open a sermon address from one archive while signed in as an account with no access to it. Open the app address signed out. [Signed out shows the sign-in page. An archive you do not belong to shows an access-denied message with no title or count.]
12. **Keyboard and screen reader.** Tab through the library, a dialog and the search box. [Visible focus, a skip link, dialogs trap focus and return it on close.]

## Demo data

`pnpm seed:staging` adds ten fictional sermons, thirteen versions, fourteen preaching events, four places and seven indexed notes to one named staging workspace. Every demo sermon has the tag `demo-data`. It never creates accounts or workspaces, refuses any environment other than staging, and re-running it only adds what is missing. It does not recreate a place you merged away or re-index a version whose consent you revoked.

It writes no PDF files, so PDF versions (for example *Printed handout*) start empty for you to upload to. The indexed notes are loaded directly into the index, attributed to the archive's Owner, to show what an indexed version looks like. Real Google Doc ingest does not exist yet.

To remove the demo sermons (and their versions, events and notes), an operator can run, after checking the select returns only demo rows:

```sh
pnpm exec wrangler d1 execute DB --env staging --remote --command "SELECT id, title FROM sermons WHERE workspace_id = '<workspace id>' AND tags_json LIKE '%\"demo-data\"%'"
pnpm exec wrangler d1 execute DB --env staging --remote --command "DELETE FROM sermons WHERE workspace_id = '<workspace id>' AND tags_json LIKE '%\"demo-data\"%'"
```

Demo places remain and can be renamed or merged in Settings.

## Known limits

- **PDF with no retry.** A PDF version whose Worker died between storing the PDF and extracting its text, or whose extraction failed, has no retry route. The workaround is to create a new version and upload again.
- **Failed is final per version.** A PDF is stored once per version. Scanned PDFs have no text layer (no OCR), text over 400,000 characters is refused, and either leaves the version `failed`. The stored file stays downloadable.
- **Only PDFs can be indexed.** Google Doc versions are links with no text read: Google Doc ingest, Picker and the read-only authorization are not built, so a Google Doc version is never searchable.
- **No email.** Invitation codes are shown once to the person who creates them and must be passed on outside the app. Pending invitations cannot be listed, codes expire after 7 days, and a workspace is limited to 20 invitations in 24 hours.
- **One archive per Owner.** The database allows one active workspace per owner, and only pilot-listed emails can create one.
- **Search is plain.** One phrase of whole words in order, up to 12 words and 200 characters, no prefix or fuzzy matching. Bible references use the 66 Protestant books.
- **Revoke keeps the file.** Revoke deletes extracted text and index entries and blocks download, but the stored PDF object stays in the private bucket. Deleting it is manual.
- **Gaps in the interface.** No version editing, no deleting a preaching, no creating Google Doc versions, no renaming an archive, no session list.
- **Not yet checked in a real browser.** The interface tests use a fake DOM. Layout, phone width and focus behaviour are part of this review.
- **Local tooling.** `pnpm run check` and `pnpm run dev` need macOS 13.5 or newer (workerd). Foundation CI runs `pnpm run check` on Ubuntu and is the source of truth for the checks.
- **Sign-in protection.** Rate limiting for `/auth/*` is a Cloudflare setting that this repository does not configure. Confirm it before widening access.
- **Staging only.** There is no production environment and no production deploy is authorized.

## Deferred

- Production Workers, D1 and R2, budget alerts and a quota and latency review.
- Google Docs: read-only Picker and authorization, Owner consent for Doc text, indexing and source-revoke deletion.
- Email delivery of invitations and email magic-link sign-in. Opening registration beyond the pilot list.
- Importing the real history workbook (needs a freshness check, ownership review and sign-off).
- Export and deletion of an archive, backup and recovery drills, and an accessibility pass with assistive technology.

## What was verified

- Unit and integration tests (`pnpm test`) run the real request handler against an in-memory database. Foundation CI runs them with Wrangler type generation and the TypeScript check on Ubuntu.
- `pnpm qa:staging` exercises the deployed staging Worker: unauthenticated access gets 401 (or 404 for app files) on every route, a member of another workspace gets 404 on every route, a Viewer gets 403 on every mutation with nothing changed, search never returns another workspace's titles or text or revoked text, and all rows it created are removed. The real Google round trip and everything in "What to try" is checked by hand.

## Feedback

Note what you tried, what you expected and what happened, with the time and the page address. Do not paste invitation codes, session cookies or real names.
