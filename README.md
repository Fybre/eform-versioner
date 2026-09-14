# eForm Versioner

A small web app that adds version control on top of Therefore eForms, which have no
versioning UI of their own even though the underlying REST API (`GetEForm` / `SaveEForm`)
already supports a `VersionNo`.

## What it does

- Connect to a tenant with a tenant name (or full base URL for on-prem) + username/password.
- Discover the eForms on that tenant (see **How eForm discovery works** below).
- **Create a new version** of a form before editing it — duplicates the current content into
  a fresh version so you always have something to revert to. You then make your changes in
  Therefore's own eForm designer as normal.
- **Browse version history** for a form, with a quick structural **diff** (fields added /
  removed / changed) and an optional **screenshot render** of each version for a visual check.
- **Revert** to any older version, or to a locally-saved **offline snapshot** — reverting
  always creates a brand-new version in Therefore; nothing is ever overwritten or deleted.
- **Offline snapshots**: save a form's current definition into this app's own local database
  as an extra backup independent of Therefore, with a label/notes, and restore it later the
  same way as a revert.

## How eForm discovery works (and its limitation)

Therefore's REST API has no "list eForms" operation — confirmed against the live WSDL
(`GetEForm`, `SaveEForm`, `CopyEForm`, `DeleteEForm` and a few submission-related ops are the
only eForm operations that exist; `GetCategoriesTree` only returns document categories/cases,
not eForm folders).

`FormNo` is a plain sequential integer, so this app discovers forms by probing
`GetEForm(FormNo, 0)` across a range of numbers and collecting the hits, stopping once it sees
a long enough run of consecutive misses past the highest hit found. This means:

- The first "Scan for eForms" on a tenant takes a little while (a form or two per request).
- Results are cached locally (SQLite) and shown instantly after that — click **Scan for
  eForms** again any time new forms are added.
- It's a workaround for a genuine API gap, not a guess — verify against your own tenant if
  forms seem to be missing (very large `FormNo` gaps beyond the default miss-streak threshold
  won't be found automatically; the scan range/threshold are adjustable via the `/api/eforms/scan`
  request body if needed).

## Versioning semantics (verified against a live tenant)

- `GetEForm` with `VersionNo: 0` returns the latest version.
- `SaveEForm` with `VersionNo: 0` **always creates a new version** — it never overwrites an
  existing one. This is what "create new version to edit" and "revert" both use under the hood.
- Explicit version numbers (`VersionNo: 1`, `2`, ...) are individually retrievable forever, so
  full history is naturally preserved without this app needing to do anything special.
- There is no API operation to delete a single version (only `DeleteEForm`, which removes the
  whole form). Offline snapshots are stored entirely outside Therefore for this reason, and
  a "revert" is implemented as "create a new version with old content", never a destructive
  overwrite.

## Architecture

- **Backend**: Node.js + Express. Holds the connected tenant's credentials only in an
  in-memory session (cookie-based, `express-session`), never persisted to disk. All Therefore
  API calls are proxied server-side (`src/lib/thereforeClient.js`) — the browser never talks
  to Therefore directly.
- **Storage**: SQLite (`better-sqlite3`) for the scanned forms catalog cache and offline
  snapshots (`src/lib/db.js`), persisted under `DATA_DIR` (defaults to `./data`, mount this as
  a volume in Docker).
- **Diffing**: a structural form.io component diff (`src/lib/diff.js`) — flattens
  `components`/`columns`/`rows` into a keyed map and reports added/removed/changed fields
  plus top-level metadata changes (title, display, etc.), not a raw text diff.
- **Screenshots**: `src/lib/render.js` uses Puppeteer with a headless Chromium to render the
  form.io schema via `form.io`'s own JS renderer (loaded from jsdelivr) and screenshot it.
  This is a nice-to-have — it degrades gracefully (an "unavailable" state, not an error) if
  Puppeteer isn't installed or a render fails, since it's not core to versioning.
- **Frontend**: a small vanilla JS single-page app (`public/`), no build step.

`FormDefinition`/`DefaultSubmission` are base64-encoded JSON over the wire — handled in
`src/lib/formCodec.js`.

## Running locally

```bash
npm install
npm start
# or: npm run dev   (auto-restarts on file changes)
```

Then open http://localhost:3000 and connect with a tenant name (e.g. `craigdemo`) plus
username/password.

Environment variables (see `.env.example`) can be passed directly or loaded with
`node --env-file=.env src/server.js`.

## Running in Docker

```bash
docker build -t eform-versioner .
docker run -p 3000:3000 -v eform-versioner-data:/app/data eform-versioner
```

The container bundles Chromium (via Puppeteer) and the system libraries it needs, so
screenshot rendering works out of the box — it does need outbound internet access to
reach both the Therefore tenant and the form.io JS CDN (jsdelivr) at render time.

Mount `/app/data` as a persistent volume so offline snapshots and the forms catalog cache
survive container restarts.

## Security notes

- Credentials are only ever held in server-side session memory for the lifetime of the
  browser session (default 8h) — never written to disk, never sent to the frontend after
  the initial connect.
- This app is intended as an internal admin tool. Put it behind your own authentication /
  network restriction (VPN, reverse proxy auth, etc.) before exposing it beyond localhost —
  it has no login system of its own beyond the Therefore credentials, and `SESSION_SECRET`
  should be set to a real random value in any shared deployment.
