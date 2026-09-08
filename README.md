# SILLA — Space Intelligence & Live Layout Administration

A white-label reservation and occupancy platform for physical space —
library seats, office hot-desks, lab benches. SILLA is the product we
sell; what a buyer gets is their own deployment of it, under their own
name, colours and vocabulary.

Nothing here is tied to a vertical. The two demo profiles (`library`
and `office`) differ only in data, and swapping between them is the
regression test for that claim:

```bash
cd server && npm run profile office
```

If a change makes one profile work and the other break, the change
hardcoded something it shouldn't have.

## The four pieces

**`server/`** — Node + Express + Mongoose, Socket.io, and a scheduled
worker. `Organization` is the white-label config record (spec §16) that
almost everything else reads from instead of hardcoding values; then
`Site → Floor → Resource`, the `ResourceType` catalog, `Zone`/`Label`
map layers, `User` (member and staff origins), and `Reservation`.

Implemented: authentication with lockout and rate limiting, kiosk
registration and email verification, the check-in interface, the
reservation engine, occupancy, the map editor's write side, the admin
surface, reporting and export, and the notification jobs. 41 of the 42
backlog stories are built — see `CLAUDE.md` for the story-by-story map.

**`client/`** — React + Vite + Tailwind + Motion + Lucide. Five
surfaces: `/` landing, `/map` booking, `/kiosk` tap-to-check-in,
`/admin` console, `/editor` map editor, shown by role. Colour never
appears literally anywhere — every value resolves through CSS custom
properties fed from the organization's config, which is what makes the
branding swap above a data change rather than a rebuild.

**`portal/`** — the storefront. A seven-step wizard where a buyer
configures the deployment they are purchasing (name, vocabulary,
colours, policy, catalog, floors) and downloads a provisioning profile.
The profile is the entire interface between the portal and the
platform; the seeder consumes it directly.

**`vendor/`** — SILLA's own commerce API, on `:4100`, in its own
database with its own signing secret. Buyer accounts and the order
queue. It is a separate service rather than routes in `server/` for one
reason: `server/` is what a buyer is given, and putting our order queue
inside it would ship the customer list to every customer.

## Running it

You'll need a MongoDB Atlas connection string (free tier is fine).

```bash
# server
cd server
cp .env.example .env       # fill in MONGO_URI and JWT_SECRET
npm install
npm run seed               # creates the demo org, catalog, layout and logins
npm run dev                # :4000

# client, in a second terminal
cd client
cp .env.example .env       # set VITE_DEMO_ORG_ID to the id the seed printed
npm install
npm run dev                # :5173

# portal, optional, in a third
cd portal && npm install && npm run dev   # :5174
```

`npm run seed` is **create-only** — running it twice mints a second
organization with a new id and silently invalidates the client's
`VITE_DEMO_ORG_ID`. To refresh map data on an existing database use
`npm run seed:layout`; to switch verticals in place use `npm run
profile <library|office>`.

Seeded logins: `admin@demo.test` / `123456` (superadmin),
`staff@demo.test` / `654321` (hits the first-login terms gate),
`member@demo.test` / `111111` with card `DEADBEEF` for the kiosk.

## Moving it to another machine

The database lives in MongoDB Atlas, not on your laptop, so this is not
a data migration — it is the code plus four `.env` files. Both machines
talk to the same cluster and see the same data.

Two consequences worth reading before you start:

- **Do not run `npm run seed` on the second machine.** The data is
  already in Atlas. `seed` is create-only, so a second run mints a
  second organization with a new id and silently invalidates
  `VITE_DEMO_ORG_ID` — the map goes blank and the demo logins stop
  resolving. There is nothing to seed; just point at the cluster.
- **Atlas will refuse the new machine until you allow its IP.** This is
  the single most likely thing to break, and the error looks like a
  hang or `ECONNREFUSED` rather than "you are not allowed". In Atlas →
  **Network Access → Add IP Address**, add the new machine (or
  `0.0.0.0/0` while developing, which is fine for a free-tier demo
  cluster and nothing else).

`.env` files are gitignored on purpose and will **not** arrive with the
clone. Move them across by hand — a password manager, a USB stick, or
retyping. Not email, not chat, not a GitHub file.

**Copy `MONGO_URI` across byte for byte — do not tidy it up.** `connectDB`
calls `mongoose.connect(uri)` with no `dbName`, and the working URI has
no database in its path, so Mongo falls back to its default and every
product collection (organizations, users, floors, resources,
reservations…) actually lives in a database named **`test`**. Adding a
tidier-looking database name to the URI silently connects you to an
empty database, and the demo looks wiped rather than misconfigured.
`vendor/` is unaffected — it passes `VENDOR_DB_NAME` (default
`silla_vendor`) explicitly, which is why it is a separate database.

```bash
# ---- on the new machine ----
git clone https://github.com/<you>/silla.git
cd silla

# 1. dependencies, four folders
for d in server client portal vendor; do (cd $d && npm install); done
#    Windows PowerShell:
#    foreach ($d in "server","client","portal","vendor") { cd $d; npm install; cd .. }

# 2. recreate the env files from the examples, then paste your real
#    values in. Do NOT re-seed.
cp server/.env.example server/.env
cp client/.env.example client/.env
cp vendor/.env.example vendor/.env
#    portal/ needs no .env — every value has a localhost default.

# 3. three terminals
cd server && npm run dev     # :4000
cd client && npm run dev     # :5173
cd vendor && npm run dev     # :4100   (only for the storefront's commerce side)
cd portal && npm run dev     # :5174   (optional)
```

`client/.env.example` already carries the live demo organization's id,
so copying it as-is is correct as long as you are pointing at the same
cluster. If you ever do start a fresh database, seed it and then put the
id `npm run seed` prints into `VITE_DEMO_ORG_ID` — and export
`TEST_ORG_ID` with the same id, or every test fails against the old
hardcoded default in `tests/helpers.mjs`.

Three Windows notes, none of them fatal:

- Every npm script here is a plain `node`/`nodemon`/`vite` call, so
  nothing needs porting. The unix-only syntax is in this README's own
  examples: use `copy` for `cp` in cmd, and set env vars the PowerShell
  way (`$env:FOO="bar"; npm test`) rather than the `FOO=bar npm test`
  form shown below.
- **Do not copy `node_modules` from the Mac.** esbuild and rollup
  resolve a per-platform binary, so a transplanted tree fails with
  "you installed esbuild for another platform". Install fresh. Nothing
  needs compiling — `bcryptjs` is pure JS, so no Build Tools or
  node-gyp.
- `npm install` in `server/` pulls `mongodb-memory-server`, whose
  postinstall downloads a mongod binary that corporate AV and proxies
  often block. Nothing in the repo imports it, so it is safe to skip
  with `$env:MONGOMS_DISABLE_POSTINSTALL=1` before installing. Do not
  reach for `--ignore-scripts` instead — esbuild's postinstall is
  required for Vite to run.
- Clone to a short path like `C:\dev\silla`, and not inside a
  OneDrive-synced folder — OneDrive breaks Vite and nodemon file
  watching and intermittently locks files under `node_modules`.

Check it worked by signing in at `http://localhost:5173/login` as
`admin@demo.test` / `123456`. If the map draws, the new machine is
talking to Atlas.

## Tests

```bash
cd server && npm test      # 117 checks against a running API
cd vendor && npm test      # 28 more, against :4100
```

Idempotent and self-cleaning — they use durable `@test.silla` accounts
and remove them afterwards. `npm run test:clean` if a run is interrupted.

With a live mail provider configured, four of the server's checks report
**SKIP** rather than PASS: verification and PIN-reset codes are bcrypt
hashed in the database and only ever sent to an inbox, so no test can
read one back. A clean run reads `113 passed, 0 failed, 4 skipped`.
Do not "fix" those by asserting `true` — that prints green for
assertions that never executed.

## Provisioning a buyer's system

Configure it in the portal, download the profile, then:

```bash
cd server && npm run seed:file ./their-profile.json
```

`node src/scripts/importProfile.js <path>` validates a profile without
seeding and prints a readable summary of what it would build.

## What's deliberately not here

INF-5 (the AWS deployment) needs credentials and an outward-facing
target, so it is a human call. Everything it depends on is ready, and
`CLAUDE.md` lists the things to settle before it — rate limiting is
in-memory and therefore per-process, operating hours use the server's
local clock, and `/api/floors/:id/layout` is still unauthenticated.

Everything in the spec's "Roadmap — Explicitly Deferred" section (QR
check-in, presence lookup, multi-site UI, audit logs, advanced
analytics, true multi-tenant) is intentionally absent. The check-in
interface is built so QR is a new implementation rather than a rewrite.
