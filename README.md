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

## How eForm discovery works

There's no operation named anything like "list eForms" in Therefore's REST API or WSDL — but
`GetObjects` with `{"Flags": 1, "Type": 47}` turns out to return every eForm in the tenant in
one call (`ID` = FormNo, plus `Name`, `FolderNo`, `Guid`, and a `Flags` bit that's set exactly
when `AnonymousAccessEnabled` is true). Type 47 is documented as `eForm` in the official
[`GetObjects` reference](https://therefore.net/help/2023/en-us/AR/SDK/WebAPI/the_webapi_operation_getobjects.html)
(the Type parameter's value table) — though only as one enumerated Type value, with no
elaboration there that this is *the* way to list every eForm tenant-wide, which is the part
verified here against a live tenant (an identical set of forms as an exhaustive `FormNo` scan).
`src/lib/scanner.js` uses it as the primary discovery path (`listFormsViaObjects`), doing
one extra `GetEForm(FormNo, 0)` per form (in parallel batches) only to pick up each form's
latest version number, which `GetObjects` doesn't include.

If `GetObjects(Type:47)` ever errors or comes back empty on some server version/configuration,
the app falls back to the old brute-force approach (`scanFormsByProbing`): since `FormNo` is a
plain sequential integer, it probes `GetEForm(FormNo, 0)` across a range and collects the hits,
stopping once it sees a long enough run of consecutive misses past the highest hit found. This
path is slower (network round trips scale with the FormNo range, not the form count) and is
only expected to run if the primary path breaks.

Either way, results are cached locally (SQLite) and shown instantly after the first fetch —
click **Refresh eForms list** any time new forms are added.

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
  Puppeteer isn't installed or a render fails, since it's not core to versioning. In Docker,
  Puppeteer is pointed at the apt-installed system `chromium` package (`PUPPETEER_EXECUTABLE_PATH`)
  instead of downloading its own — Puppeteer's own "Chrome for Testing" download has no
  linux-arm64 build, so it can't run unmodified on an arm64 host (e.g. Apple Silicon); the
  system package is built for whatever architecture the image actually is.
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

### With Docker Compose (recommended)

```bash
cp .env.example .env
# then edit .env and set SESSION_SECRET to a real random value, e.g.:
#   SESSION_SECRET=$(openssl rand -base64 32)

docker compose up -d --build
```

This builds the image, starts the app on http://localhost:3000, persists `/app/data` in a
named volume (`eform-versioner-data`), restarts automatically unless stopped, and wires up
a health check against `/healthz`. `SESSION_SECRET` is required — compose refuses to start
without it (see `.env.example`).

```bash
docker compose logs -f      # tail logs
docker compose down         # stop (data volume is kept)
```

### With plain `docker run`

```bash
docker build -t eform-versioner .
docker run -p 3000:3000 \
  -e SESSION_SECRET="$(openssl rand -base64 32)" \
  -v eform-versioner-data:/app/data \
  eform-versioner
```

### Notes

- The container runs as a non-root user (`eformv`); the image sets up `/app/data`'s
  ownership so a fresh named volume inherits the right permissions automatically.
- Screenshot rendering needs outbound internet access at render time — both to the
  Therefore tenant and to the form.io JS CDN (jsdelivr).
- Mount `/app/data` as a persistent volume (compose does this for you) so offline
  snapshots and the forms catalog cache survive container restarts.

## Security notes

- Credentials are only ever held in server-side session memory for the lifetime of the
  browser session (default 8h) — never written to disk, never sent to the frontend after
  the initial connect.
- This app is intended as an internal admin tool. Put it behind your own authentication /
  network restriction (VPN, reverse proxy auth, etc.) before exposing it beyond localhost —
  it has no login system of its own beyond the Therefore credentials, and `SESSION_SECRET`
  should be set to a real random value in any shared deployment.
