# SILLA — Project Context

SILLA (Space Intelligence & Live Layout Administration) is a white-label
resource-reservation and occupancy management platform — library seats,
office hot-desks, etc. It is NOT tied to any one institution or vertical.

Full specs are in the project root:
- SILLA_System_Specifications.docx — architecture, data model, config schema
- SILLA_Scrum_Workflow.docx — backlog (story IDs like RES-1, MAP-2) + the
  3-sprint, 6-week plan

Read both before making changes. Code stubs reference story IDs in comments
(e.g. "MAP-3" or "OCC-1") — match new work to the right one.

## Current status: Sprint 0 complete — Foundation, Identity & Map
All 12 Sprint 0 stories (51 pts) are implemented and verified:

- **INF-1** org/site/floor model · **INF-2** white-label config schema
- **INF-3** check-in interface — `resolveCheckIn({credential})` in
  `server/src/services/checkin/`. Resolves a credential to a member and
  NOTHING else; RFID is the only registered implementation. Adding QR
  later is `registerResolver("qr", …)`, not a rewrite.
- **INF-4** RFID read spike — `npm run spike:rfid`, record in
  `docs/INF-4-rfid-spike.md`. Verdict: GO on the software path; the
  physical reader is still unconfirmed (none attached). Key finding:
  USB RFID readers are HID keyboard-wedge devices, so no driver is needed.
- **ID-1/ID-2** kiosk registration + email verification —
  `/api/registration/*` and `KioskPage.jsx` (tap → details → code → verify)
- **ID-3** org-scoped unique indexes on email / memberId / cardUid, with
  duplicates rejected by field name rather than a raw E11000
- **AUTH-1** login (`LoginPage.jsx`) · **AUTH-2** per-account lockout AND
  per-IP+email rate limiting · **AUTH-3** first-login terms gate
  (`TermsPage.jsx`, enforced by `RequireAuth` in `App.jsx`)
- **CAT-1** vendor catalog · **MAP-1** read-only multi-floor map
  (`SpaceMap.jsx`, `MapPage.jsx`, `GET /api/floors/:id/layout`)

## Sprints 2 & 3 complete — everything except INF-5

**Sprint 2 — Reservation engine & physical loop (76 pts):**
- **RES-1..RES-3, RES-5, RES-7** — `services/reservations/`. RES-2 now
  commits claims inside a transaction after an actual shared write to
  `Organization.spaceRevision`. Transactions alone still permit write
  skew; the shared write creates a conflict and a retry against a fresh
  snapshot. The old lowest-`_id` tie-break only compared identical units,
  so it could not protect a room booking racing a seat booking inside it.
  Structural map writes and availability changes share the same guard.
  Read the header comment before touching it. Eight racing room/seat
  claims produce exactly one winner; a member racing two resources also
  gets only one reservation.
- **OCC-1..OCC-6** — `services/reservations/occupancy.js`. This sits
  DOWNSTREAM of the check-in interface on purpose: `services/checkin/`
  answers "who is this?" and stops. Do not move reservation logic into
  the resolver, or QR becomes a rewrite instead of a new implementation.
- **MAP-2** — `services/realtime.js` + `client/src/lib/useFloorSocket.js`.
  Only the `status` half is ever streamed; layout is fetched once.
- **MAP-3** — `routes/resource.routes.js` + `pages/EditorPage.jsx`.
- **AUTH-4, NOT-1..NOT-3** — PIN reset, async email, reminders.
- **RES-4 (booking with others) was REMOVED**, not deferred or disabled.
  Group codes are gone from the Reservation model, the reservation
  service, `reservation.routes.js`, the admin CSV export, the email
  templates, `ReservePanel.jsx` and the suite. Nothing reads a
  `groupCode`, so adding the field back gets you a column and not a
  feature — the join endpoint and the neighbour lookup are gone too.

**Sprint 3 — Admin surface & delivery (52 pts):**
- **ADM-1..ADM-5, RPT-1** — `routes/admin.routes.js` + `pages/AdminPage.jsx`.
- **MAP-4/MAP-5** — zones and labels in the editor.
- **RES-6, NOT-4, NOT-5** — grace change notifies today's reservers;
  closures cancel and email with the staff-entered reason.

**INF-5 (deploy to AWS) is DONE** — live, and recorded in
`docs/INF-5-aws-deployment.md` with every resource id and the operating
notes. Product, storefront and API are on CloudFront over HTTPS, backed
by one free-tier t3.micro in Singapore running both Node services behind
nginx, with the two SPAs static in S3.

Verified in a browser rather than inferred: the map draws from Atlas with
no console errors, SPA deep links resolve, HTTP redirects to HTTPS, the
CORS preflight names the real origin, and the Socket.io WebSocket upgrade
completes through CloudFront. `TZ=Asia/Manila` and `NODE_ENV=production`
were confirmed by reading the running process's own environment — a
default-UTC box would refuse every booking through the Philippine working
day.

### Email — live, over Gmail SMTP
`server/src/services/email/index.js` picks a transport at import time:

    SMTP_USER + SMTP_PASSWORD  →  nodemailer over smtp.gmail.com   (in use)
    EMAIL_API_KEY              →  Resend's HTTP API
    neither                    →  console, and the dev codes come back

SMTP won because Resend will not send from a domain you have not
verified, and there is no silla.app to verify — Gmail with an App
Password (not the account password; needs 2-Step Verification) sends as
a real address today. Swapping to a provider later is a .env change.

`npm run email:test -- you@example.com` sends one message through the
configured transport and reports the actual failure. It calls the
provider DIRECTLY rather than through `sendEmail`, because that queue is
fire-and-forget by design (spec §15) — a broken provider is silently
swallowed there, which is exactly what you do not want from a test.

**Both transports refuse to send to `@test.silla` and `@example.*`.**
The suites create accounts at that domain on every run; without the
guard each run became dozens of real delivery attempts, three retries
each, against a 500/day quota, every one bouncing against the sender's
reputation. It is enforced in the transport so a new test cannot forget.

`vendor/` has its own COPY of this service, not an import — see the
no-cross-imports rule in the portal section. It sends the buyer a
welcome, an order receipt, and a mail on each status change, plus an
internal notice to `SILLA_ORDERS_EMAIL` when an order is submitted.
Status mails fire only on an actual transition, so re-saving a
deployment URL does not email somebody twice.

**Every email is HTML now, with a plain-text part rendered from the same
blocks** (`services/email/layout.js` in each service — a copy, per the
no-cross-imports rule). Codes are six boxed digits, details are a
labelled table, and every footer says the message is automated and why
it was sent. The two copies differ on purpose:
- `vendor/` is SILLA speaking, so it is SILLA-branded and sent as
  "SILLA" (`EMAIL_FROM_NAME`).
- `server/` speaks AS the buyer's organization. The masthead, pills and
  buttons are painted from `org.branding` and the From name is the
  organization's — a white-label product that signs its mail "SILLA" is
  not white-label. Only `founderWelcomeEmail` passes `SILLA_BRAND`,
  because that one is SILLA handing the deployment over.
  Branding colours are admin-typed and land in `style=""`, so only plain
  hex is accepted; text colours are kept only if they reach 4.5:1 on
  their background. Buttons link to `APP_URL`, else the first
  `CORS_ORIGINS` entry, else the message has no button.

`npm run email:preview [-- <dir>]` in either service writes every email
to HTML files with sample data. The server renders each one under BOTH
vertical profiles — the same regression test as `npm run profile`.
Everything interpolated goes through `esc()`: names, organization names
and closure reasons are user-typed.

### Scheduler
All jobs are implemented in `workers/scheduler.js` and wired with `io`,
so a seat the worker releases streams to the map like any other change.
Every job is idempotent and safe to re-run each minute.

### Tests — `server/tests/`, run with `npm test`
**117 checks** across four suites: identity/registration/auth, the
reservation engine and physical loop, role permissions, and the admin
surface. Idempotent and self-cleaning — the runner removes every
`@test.silla` account it made and restores the seeded demo state.

**4 of them SKIP while email is live**, and the runner reports that as
its own state — "113 passed, 0 failed, 4 skipped" — rather than folding
them into the pass count. The verification and PIN-reset codes are
bcrypt hashed in the database and only ever sent to an inbox, so once a
real provider is configured no test can read one back. The checks that
need the literal code therefore cannot run. Everything around them
still does: the code is issued, a WRONG code is rejected with attempts
remaining, and the account completes out of band so the flow after it
is still exercised. `check()` takes `"skip"` for this. Do not "fix"
these by asserting `true` — that was the previous state, and it printed
four green PASS lines for assertions that never executed.

    npm test              # everything
    npm test identity     # one suite by name
    npm run test:clean    # remove test leftovers manually

They run against a RUNNING server and the real database, deliberately:
the properties most worth testing — the atomic claim under genuine
concurrency, the org-scoped unique indexes, the role gates — are
properties of the real stack, not of a mocked one. Start the API first
(`npm run dev`), and seed once (`npm run seed`, `npm run seed:layout`).

`nodemon.json` limits the watcher to `src/`, so editing tests no longer
restarts the API mid-run.

A full run registers 25 accounts and logs in repeatedly, against an IP
ceiling of 60 registrations and 10 logins-per-email per 15 minutes. So
roughly two back-to-back runs fit in one window; a third fails with 429s
and `retryAfterSeconds`. That is the limiter working, not a broken
suite — wait it out rather than "fixing" the tests or raising the cap.

An earlier version of these suites lived only in a session scratchpad
and was lost when it was cleared. That is why they are in the repo now.

Keep this section honest — it was previously wrong in both directions
(claimed a map renderer that did not exist, claimed registration was
shipped when only the schema was), which sent work down the wrong path.

## The SILLA portal — `portal/`

SILLA is what WE sell; a buyer buys their own deployment of it, under
their own name. `portal/` is the storefront side of that: a React app
(`npm run dev`, port 5174) where a buyer configures the system they are
buying and walks out with a provisioning profile.

**The portal has two faces**, switched by hash in `App.jsx` (no router
— there are exactly two views and no nested state to express):

  `/`            the storefront — `marketing/Landing.jsx`
  `#/configure`  the wizard — `Wizard.jsx`

**They are ONE surface, not two.** Both are warm paper, rounded display
type and terracotta. The configurator used to keep the product's dark
chrome, which meant clicking "Build yours" dropped a buyer into what
felt like a different company's software. The palette now lives once, on
`:root` in `portal/src/index.css`; `.silla-marketing` ALIASES those
tokens rather than restating them (duplicating the values is how the two
drift apart). `.silla-preview` still overrides every one of those names,
so the BUYER's dark product renders correctly inside the light page —
and that contrast now works in our favour, because the preview reads as
an artefact sitting on the page rather than as more chrome.

`.silla-preview` also re-declares `color-scheme: dark`: that lives on
the document rather than on a token, so without it a select or a
scrollbar inside the preview would be drawn light.

Flow decisions worth keeping:
- **Errors are revealed, never pre-thrown.** The wizard used to render
  "Enter the organization's name" in red the instant it opened, scolding
  a buyer for not yet doing the thing they arrived to do. A step's
  errors appear only once its Continue has been pressed, and Continue is
  never disabled — it either advances or reveals, scrolling to the first
  `[data-field-error]`. A greyed-out button with no explanation is a
  worse dead end than an error message.
- **There is a doorway, and it is not a sign-up wall.** Six CTAs on the
  storefront all called one argument-less handler and dropped a stranger
  onto step 1 of a seven-step form with nothing explaining what it was.
  `marketing/EntryDialog.jsx` now opens instead: what is ahead, how long,
  that nothing is charged, and a choice between exploring (primary,
  needs nothing) and signing in first. The account is still asked for
  LAST — that rule is why "explore" is the default action.
  It also surfaces a saved draft, which was previously invisible from
  the storefront.
- **Intent travels with the click** (`lib/entryIntent.js`). Pressing
  "Configure this" on One Room used to be indistinguishable from
  pressing it on Whole Building, so the wizard's hardcoded
  `useState("building")` won and a buyer could place an order quoted at
  three times the plan they chose — `quotedAmount` is frozen onto the
  Order as the record of what they were offered.
  **The initialiser must stay pure.** It was `useState(takeIntent)`, and
  `takeIntent` clears the stored value: React 18's StrictMode
  double-invokes state initialisers precisely to surface that, so the
  first call consumed the intent and the second returned null. It reads
  with `peekIntent` and clears in an effect.
- **`formatMoney` in `lib/plans.js` is the only money formatter.**
  `priceFor` returns MINOR units (cents, what the Order stores) while
  the pricing cards read `plan.annual` in MAJOR units. Both are correct
  and they differ by 100x, which is how a $39 plan rendered as
  "$3900/month".
- **The intro collapses after step 1.** A three-line welcome that stays
  for all seven steps stops being a welcome and becomes furniture.
- **One heading per step, in the column your eye is already in.** Each
  step gets a chapter head — oversized faint numeral, kicker, display
  title, lead — sitting directly above the form. It replaced a centred
  `<h1>` that was immediately repeated as a 14px `<h2>` inside the card
  below it, which is the same title twice at two different sizes.
- **No card inside a card.** Every step is already Panel-rooted, so the
  wizard renders them straight onto the page rather than wrapping the
  lot in another `Card`.
- **The action bar floats.** Catalog and Floors scroll several screens
  and Continue used to sit wherever the form happened to end, so the way
  forward was off-screen for most of the time spent on the steps that
  needed it most. It is now `sticky bottom-4`, blurred, with a progress
  rail. Steps slide left or right by travel direction, so forward and
  back no longer look identical.
- **The preview is labelled and clears the header.** It reads "LIVE
  PREVIEW" with a pulse and a caption, because it is not obvious that
  the dark panel is the product being bought rather than an
  illustration. Its sticky offset is `lg:top-[88px]`, not `top-6` — the
  site header is sticky and 72px tall, and the old offset parked the
  preview underneath it.
- **The Review step's download button only exists if `onDownload` is
  passed.** The wizard rendered `<StepForm config update errors />` and
  passed neither `onDownload` nor `preview`, so the button never
  rendered — and the "That's your system" hand-off panel keys off
  `downloaded`, which could therefore never become true. Both the button
  and the panel were dead for as long as that prop was missing.
- **The Review step no longer prints `npm run seed:file`.** That is
  SILLA's provisioning step, and it was being shown to the customer
  buying the result of it — a librarian should not have to think about a
  terminal. The command lives here and in `importProfile.js`, where the
  people who run it will look.
- The download ends in a real hand-off ("send us the file → we
  provision it → you get your keys"), not a one-line "downloaded"
  notice that left a buyer holding an artefact with no next move.
  **The address in that panel (`hello@silla.app`) is invented** —
  replace it with the real SILLA address.

Things worth keeping about the storefront:
- The seat tile (`marketing/Chair.jsx`) is the mascot, drawn the way the
  real map draws it — rounded square, status colour, a glyph so colour
  is never the only signal. Every playful moment on the page is the
  actual product doing something, which is what keeps it from being twee.
- The white-label section is LIVE, not screenshots: one component
  rendered from three sets of values, so picking a vertical repaints
  colours, vocabulary, zone names and ID format. It is the page's whole
  argument, so it is demonstrated rather than claimed. It derives its
  article too ("a desk", "an employee") because the vocabulary is
  buyer-supplied.
- The pricing section sells the plans AND the catalogue (extra
  buildings, kiosks bought or rented, cards and readers, services,
  support tiers) from `GET /api/vendor/plans`, and says VAT once — see
  "Pricing" below for where the numbers live.

Eight steps — Details, Words, Branding, Policy, Catalog, Floors,
Hardware, Review. Hardware asks how many buildings (which suggests the
plan, and any extra buildings), kiosks, cards, readers, services and a
support tier, with a live quote beside it; the plan is chosen there now,
and Review shows the same quote.
Three starting presets (library, office, blank), then everything is
editable. The Review step emits the profile as JSON and offers it as a
download.

**`owner` is part of the profile contract**, and it is a security
boundary rather than a nicety. `seed.js` used to plant the SAME three
hardcoded accounts into every organization it created —
`admin@demo.test` / `123456`, `staff@demo.test` / `654321`, and
`member@demo.test` holding card `DEADBEEF` — and `seed:file` runs that
same path, so every provisioned customer received one published
superadmin credential and could sign into any other customer's
deployment. Those credentials are printed in this repo's README.

Now: a profile carrying `owner` (firstName, lastName, email) mints
exactly ONE account — that person, superadmin, holding a random
temporary PIN from the same generator AUTH-4 and ADM-4 use, with
`mustChangePin` set and terms unaccepted — and plants no demo
scaffolding at all. A profile WITHOUT an owner still gets the demo trio,
because the two built-in verticals legitimately want a walkable demo;
`importProfile`'s summary prints `owner  NONE — demo accounts will be
planted instead` so nobody discovers that after the fact.

The PIN is emailed via `founderWelcomeEmail` AND printed by the seeder.
Both, deliberately: `sendEmail` is fire-and-forget (spec §15), so a
silent delivery failure would otherwise leave a deployment nobody can
enter and no copy of the PIN anywhere — it is bcrypt hashed the moment
it is stored.

The wizard requires it (Details step, "Who will run it"), `validate()`
gates on it, and `buildProfile` omits the block entirely unless all
three fields are filled — a half-filled owner would fail
`importProfile` and refuse to provision, whereas an absent one is a
valid demo profile.

**The profile is the whole interface between the two halves.** The
portal writes the same shape `server/src/scripts/profiles.js` already
held, so the seeder needed no new creation path:

    cd server && npm run seed:file ./my-profile.json

`server/src/scripts/importProfile.js` validates the file first and
doubles as a CLI linter (`node src/scripts/importProfile.js <path>` —
prints a readable summary, or names every bad field). A buyer-authored
file is untrusted input, so a cast error mid-seed would be a terrible
error message.

Two things to keep true:
- The portal must never import from `server/` or `client/`. It talks to
  them only through the profile shape. If it starts needing server code,
  the profile has stopped being a complete description of a deployment.
- The portal's own chrome is SILLA-branded and stays that way. Buyer
  colours are scoped to `.silla-preview` in `portal/src/index.css` so a
  buyer previewing a dark teal scheme doesn't repaint the wizard around
  it.

Verified end to end: a wizard-authored profile ("Harborview Work
Commons" — 6 catalog types, 2 floors, 39 pieces, 85 units) provisioned a
second organization, and 28 API checks passed against it — buyer
terminology and branding served to the client, its own catalog on the
map, login, a booking made and cancelled on one of its desks, and the
admin surface. The test org was deleted afterwards; the demo org was
untouched.

## `vendor/` — SILLA's commerce API

Buyer accounts and the order queue, on **:4100**, in its own database
(`silla_vendor`) with its own `JWT_SECRET`.

**A separate service, not routes in `server/`.** That one IS a buyer's
deployment — putting our order queue in it would ship the customer list
to every customer. Nothing in `vendor/` is ever provisioned to a buyer,
and a token minted here must not be accepted there, which is why the
signing secrets differ.

    cd vendor && npm run dev                 # :4100
    npm run seed:staff -- <email> "<name>" <password>
    VENDOR_STAFF_EMAIL=… VENDOR_STAFF_PASSWORD=… npm test   # 74 checks

Decisions worth keeping:
- **One `Account` model, two roles** (`buyer` / `silla`). One login form,
  one session, one place authorization is decided. A second parallel
  auth system is how you get a back door nobody audits.
- **The FIRST staff owner exists only through `seed:staff`;** owners
  invite the rest from the console (Staff section). No route lets anyone
  grant THEMSELVES staff access: an invitation needs an existing owner's
  session (`staff.manage`), the code is single-use and expires, every
  invite, role change and deactivation is in the activity log, and the
  last active owner can be neither demoted nor deactivated.
- **A draft IS an order**, distinguished by `status`. A separate drafts
  collection would mean copying the profile on submit and reconciling
  two shapes forever.
- **The lifecycle is enforced server-side**: `ALLOWED_TRANSITIONS` in
  `models/Order.js`. An order that can jump `submitted` → `live` is one
  bad request from a deployment nobody built. Going live also requires a
  `deploymentUrl` — that is the field the customer actually needs.
- **Ownership is in the QUERY, not a check after it**
  (`findOne({ _id, account })`). A `findById` followed by an ownership
  test is one forgotten line from an IDOR.
- **A buyer's unsubmitted draft never appears in the queue.** It is not
  an order until they submit it. The guard was `ALLOWED_TRANSITIONS[
  status] !== undefined`, which reads like a validity check and is one —
  but `draft` IS a key in that table, so `?status=draft` sailed through
  and returned every buyer's private draft with their email attached.
  Verified against the running API, then fixed to an explicit allowlist.
  Being a known status and being listable are different questions.
- **`profile` is stored as free-form Mixed.** This service must not grow
  a second opinion about the profile's shape — `importProfile.js` is the
  one that matters, and two validators will disagree.
- **What an order costs is recorded ON the order** (a price will change;
  what this customer was offered must not): `quote`, frozen at
  submission, and `quotedAmount`, the PLAN's per-month figure — see
  "Pricing" below. Also `stripeCustomerId` on the Account
  (one customer across many orders), `stripeSubscriptionId` and
  `paidUntil` on the Order. **Stripe is chosen but not wired.**

### The portal's commerce screens

    /               storefront          #/sign-in · #/sign-up
    #/configure     the wizard          #/orders[/id]   a buyer's orders
                                        #/queue[/id]    SILLA's queue (staff)
    #/account       profile             #/terms         Terms & Conditions

Hash routing still (`lib/useHashRoute.js`) — a handful of flat views, one id
parameter, no nested layouts. If this grows nested routes or route-level
data loading, swap in a router.

- **The account is asked for LAST.** The wizard runs signed out; only
  "Save to my account" needs one. Asking first is how you lose people on
  step one — so the configuration is parked in sessionStorage
  (`lib/pendingConfiguration.js`), the auth screen sees it and returns
  them to the wizard instead of an empty orders list, and the wizard
  restores it on the last step. Both sides have to agree it exists,
  which is why the key is shared rather than living in the wizard.
- **`lib/plans.js` is the single source for plans and the catalogue** in
  the portal (live from the API, its seed files as the fallback), shared
  by the pricing section (which sells them) and the wizard (which records
  what an order is for). Same lesson as `adminSections.js`.
- **The provisioning command lives in the QUEUE**, not the buyer's
  review step. It was being shown to the customer buying the result of
  it; it belongs where the person who runs it will look.
- A buyer who guesses `#/queue` gets their own orders, not a dead end.
  The API refuses them regardless — this is only about not presenting a
  page that was never theirs.

### Buyer accounts — sign-up, verification, profile

Sign-up takes first / middle (optional) / last / suffix (optional),
email twice, a password of 10+ characters, and agreement to the terms.
The account is created UNVERIFIED and a 6-digit code is emailed at once.

- **Unverified buyers can explore, configure and save drafts, but not
  submit.** `POST /orders/:id/submit` answers 403 `EMAIL_UNVERIFIED`;
  `Orders.jsx` opens the verify dialog on that (and pre-emptively), then
  submits on success. The gate is on the server — the dialog is a
  courtesy, not the control.
- **Codes** (`vendor/src/lib/codes.js`): bcrypt hashed, 10-minute TTL, 5
  attempts, 60s resend cooldown, one live code per account tagged with
  its purpose (`signup` / `email-change` / `password-reset`), so a
  sign-up code cannot confirm an email change.
- **An email change sends the code to the NEW address** and completes
  only when it is entered; the OLD address is told afterwards. Password
  change and reset stamp `passwordChangedAt`, and `middleware/auth.js`
  refuses any token issued before it (`SESSION_REVOKED`) — that is what
  "signs out your other devices" means. The stamp is backdated by one
  second, or the session that made the change revokes itself.
- **Forgot-password answers identically for known and unknown emails**,
  and a wrong sign-in never says which half was wrong.
- **Billing refuses anything that passes a Luhn check.** SILLA never
  stores card numbers; a 14-digit Philippine TIN is not a card and
  must still save, which is why the check is Luhn and not "long digit
  string". Payment methods are an honest "coming soon".
- `termsAcceptedAt` + `termsVersion` are recorded at sign-up. Keep
  `TERMS_VERSION` (auth.routes.js) and `TERMS_UPDATED`
  (`portal/src/account/Terms.jsx`) in step. **The terms text is
  plain-language operating copy, NOT legal review.**
- Legacy accounts: `npm run migrate:accounts [-- --apply]` splits names
  and grandfathers them as verified. It does not invent a terms
  acceptance they never gave. Already applied to the shared database.
- Tests cannot read an emailed code, so `tests/helpers.mjs` `plantCode()`
  writes a KNOWN code's hash straight into the account (`node
  tests/plant.mjs <email> <purpose>` for browser walks).

Portal lessons from building it:
- **A code input must hold its value in a ref.** `OtpInput` read the
  value from props inside its key handler; typing faster than React
  re-rendered dropped digits, the same trap as the editor's drag
  rectangle. The live value is in a ref, mirrored to state for render.
- **The "already signed in" redirect is keyed on ARRIVING at a route,**
  not on the session changing. Keyed on the session, it fired the moment
  sign-up succeeded and unmounted the verify dialog that sign-up had
  just opened.
- **The page wipe is driven by the route, not by callers.** The branded
  terracotta wipe used to be a `transition()` only the doorway and the
  wizard's exit called, so two page changes wiped and every other one
  cut. `usePageWipe` in `App.jsx` now trails the hash: the panel closes,
  the page swaps and scrolls to top under it, the panel lifts. So links,
  the account menu, post-sign-in redirects and Back/Forward all get it
  without knowing it exists — render from `shown.page`, never `route`.
  The sign-in gate's state is part of the page key (signing in at
  `#/orders` changes the page without moving the hash), except while the
  session check is pending, so a refresh never wipes. Sign in ↔ sign up
  is a tab switch and deliberately does not. Early returns in `Routed`
  would skip the panel mid-animation, which is why the gate screens live
  inside `view()`.
- `Modal` autofocus prefers `[data-autofocus]` — without it the code
  dialog focused its Close button and the first keystroke went nowhere.
- A dialog keeps its task as its title and lets the success panel carry
  the outcome; the toast fires after the dialog closes. Title, panel and
  toast all saying "Password changed" at once read as a stutter.
- Errors are revealed on submit, never pre-thrown, same as the wizard.
  Email availability is checked live (debounced) and offers "Sign in
  instead"; the confirm-email field refuses paste.

Verified end to end in a browser, both directions: configure signed
out → prompted to sign up → configuration restored → saved as a draft →
submitted; then staff sign in → see it in the queue → download the
profile → mark provisioning → **refused for going live with no
deployment URL** → set it → live.

### Roadmap beyond the configurator
Today the profile is handed over as a file and provisioned by hand,
which is the honest shape while there is no billing and no deploy
target. Buyer accounts and saved drafts are done. Still to build: billing, and
automatic provisioning — that last one depends on INF-5.

## Running the demo

Three servers: `cd server && npm run dev` (:4000), `cd client && npm run dev`
(:5173), and optionally `cd portal && npm run dev` (:5174). Walked end to
end in a browser as all three roles — member, staff, superadmin — with no
console errors on any surface.

**The one thing that can break a demo: operating hours.** The seeded
library profile opens 08:00–19:00 on the SERVER'S LOCAL CLOCK, and
walk-in check-in is refused outside that window — correctly, since you
cannot occupy a seat in a closed building. Booking still works outside
hours (it schedules into the next open window), but the kiosk's
tap→pick-a-seat→checked-in flow, which is the best thing to show, fails
with "Reservations must fall between 08:00 and 19:00."

If you are demoing outside those hours, widen them first in
**Admin → Settings → Opens/Closes** (it takes seconds, and showing ADM-5
live is a decent beat in itself). Set them back afterwards, or run
`npm run profile library`.

**Demo path that is known to work:**
1. `/kiosk` — type `DEADBEEF` and press Enter. A USB RFID reader is a
   keyboard wedge, so typing IS the tap; no hardware needed. The card is
   recognised, then pick any green seat → "You're checked in". Tap again
   to check out.
2. `/login` as `member@demo.test` / `111111` → click a green seat → the
   panel scrolls into view → confirm with the PIN → "Your reservation".
3. `staff@demo.test` / `654321` → hits the terms gate first (AUTH-3),
   then Admin shows four tabs and the editor offers only Availability.
4. `admin@demo.test` / `123456` → all six admin tabs, every editor tool.
5. `npm run profile office` — the whole product becomes a workplace
   (teal, "desks", ENGINEERING/SALES zones, EMP- ids) with no code
   change. Switch back with `npm run profile library`.

## Spatial hierarchy — buildings, floors and rooms

The map now navigates site → building → floor → room → resource. Rooms can
have levels on several floors in one building — each level any
square-cornered shape (see Shapes below) — with booking mode
`individual`, `whole` or `either`. A whole-room reservation conflicts with all
contents on all levels; an individual reservation conflicts with its unit and
whole-room reservations. Buildings and floors are navigation containers.

Superadmins create buildings/floors and draw room boundaries in **Editor**.
Staff reach the same map through **Space controls**, with availability and
schedule controls only. Room schedules include individual resources, and
closing or changing a booked room/resource requires cancelling bookings first.
Room occupancy uses the existing reservation/check-in/worker lifecycle through
one internal target, excluded from furniture and physical-unit counts.

Existing floors remain readable under an unassigned building. **Set up building**
adopts them explicitly while preserving IDs and layout. No read reseeds or
migrates live data. See `docs/spatial-map.md` for the workflow and constraints.

**Shapes — floors, rooms and zones are not only rectangles.** An L-shaped
floor's missing corner used to read as floor, and an L-shaped room had to be
two rooms that booked separately. A shape is now a SET OF GRID CELLS, stored
as a short canonical list of rectangles: `Floor.shape.areas` (the cells that
ARE the floor), and `areas` on a room level and a zone, each beside the old
`bounds`, kept as their bounding box. Absent or empty means what it always
meant (the whole grid; the one bounds rectangle), so **nothing was
migrated** — legacy documents read and behave as before, asserted with the
fields unset in the database. The geometry lives once in `lib/cells.js`,
byte-identical in `server/` and `client/` (the geometry suite fails if they
drift). Rules, all server-side: everything placed sits inside the floor's
outline, not just its grid; a reshape or a smaller grid is refused while
anything would be left outside, naming what ("1 piece and the room
“Commons” are in the part you're removing", ids in `outside`); a smaller
grid trims a shaped outline; two rooms may not share one cell; a room may
not cut through a piece; membership is containment in the union, so a
whole-room booking covers every area of every level. Zone and label writes
moved inside `withSpaceTransaction` with this work — outside it, a zone
placed in a corner being cut away could commit beside the cut, and the
suite's race check fails every time against the old writes. Editing: the
**Shape** tool (Add/Cut area, Undo, Reset to rectangle, Save, refusals
inline with the map flagging what is in the way), the outline sketch in
**Add floor**, **Add to room / Cut from room** in room settings, the same
for zones from the zones list; drawn rooms and zones keep only floor cells,
so a box across an L's missing corner gives an L-shaped room. Out of scope:
curves and diagonals (they would be staircases of cells), and the portal
configurator, which still describes rectangular floors only.

SpaceMap now resolves clicks BY CELL on the `<svg>` rather than per drawn
element. Before, a room's or zone's fill sat over the grid and swallowed the
click, so the Place tool could not put a piece inside a room by clicking —
reproduced against main's SpaceMap, not theorised. Pieces stop their own
clicks so furniture is never mistaken for the cell beneath it.

`npm run test:spaces` runs 52 geometry checks (`tests/cells.test.mjs`, alone
as `npm run test:cells`) and then 110 named spatial checks in a temporary
replica set; `npm run test:isolated` runs the existing 117 checks in another
temporary database, including literal-code checks with console email.
Neither reads live credentials or touches Atlas. `test:spaces -- --serve`
keeps disposable fixture data on :4010 (`--port=<n>` when another worktree's
preview holds it) for the :5175 browser preview documented there.

Members read the map as building › floor › room: a breadcrumb, a building
switcher (only when there is more than one), floor tabs, a row of the
floor's rooms saying what each offers, and a room panel that answers "Book
the whole room" and/or "Pick a <resourceNoun> inside" for the chosen time.
Superadmins get the editor as three numbered steps (building, floors,
rooms). The scheduler's state moves are CONDITIONAL
(`services/reservations/lifecycle.js`): a stale decision can never
overwrite a newer one — a member who tapped in at the last second used to
be marked a no-show. Every suite now passes at any time of day; windows
are built by `tests/clock.mjs`, never "now + 1h", which crossed midnight.

**Live (deployed 16 Oct 2026, shapes included):** the demo organization
has two buildings, set up from the live editor on 15 Oct — "Building 1"
holding all nine of its floors, and an empty "Main Building" — and no
rooms yet. Every live floor is still a full rectangle (no outline saved).
Its floors are First Floor, Second Floor, Third and SILLA MAP; five
leftover test floors were removed on 16 Oct through the API (their pieces
first — nothing had a live booking).

## Tenancy and plans — live; billing and staff console in progress

`docs/control-plane.md` is the design. Tenancy and plan enforcement are
merged and LIVE (17 Oct 2026), both halves: the server (signed internal
API, provisioning shared with `seed:file`, `migrate:slugs`, limits and
features, the read-only guard — 56 checks in `tests/platform.test.mjs`)
and the client, below.

Live specifics: the demo is at `/demo-library` (assigned by `npm run
migrate:slugs --apply` on the box) and legacy paths (`/map`, `/kiosk`, …)
redirect to it. nginx was updated the same day — it no longer rewrites the
client address from X-Forwarded-For, it refuses `/api/internal/` from the
internet, and both apps trust exactly two proxy hops (`TRUST_PROXY_HOPS`);
the old config is on the box as `/etc/nginx/conf.d/silla.conf.bak-20261017`.
`CONTROL_PLANE_SECRET` is NOT set live yet — the internal API answers 503
until the staff console needs it. Still to do on AWS: restrict port 80 to
CloudFront's origin-facing prefix list; until then a request sent straight
to the origin can still pick its own X-Forwarded-For.

**Billing and the staff console are on main (17 Oct 2026) but NOT live
yet.** Staff sign in at `#/staff/sign-in` and land on `#/staff`; buyers
have `#/billing`, `#/invoices/<id>` and `#/messages`, all linked from the
account menu; `#/queue` redirects to `#/staff/orders`. Provisioning is a
button (Orders → Provision): address check, then the owner's one-time
PIN, then `billing.onProvisioned` starts the trial. Deploying needs
`CONTROL_PLANE_SECRET` on BOTH services and `PRODUCT_URL` on the vendor.
Vendor suite: 330 checks (`npm run test:isolated`); the billing and
pricing suites run their database-moving parts only there, because they
drive the billing job and edit prices.

## Pricing — the catalogue, quotes and add-ons

The agreed pricing (pesos, every price EXCLUDING VAT) is seeded, not
hardcoded: plans from `vendor/src/lib/defaultPlans.js` (keys `room`,
`building`, `campus` = Starter, Building, Campus) and everything else —
extra buildings, hardware, services, support tiers — from
`vendor/src/lib/defaultCatalog.js` into `CatalogItem`, each the first time
its collection is read empty. After that **staff own every number**
(console → Plans, and its Catalogue area; `plans.manage`, audited). A
database seeded before this keeps its old placeholder plans until `npm
run migrate:pricing -- --apply` (vendor; dry run without `--apply`) — it
must be run on the live box before these prices are.

- **The quote is computed on the server and frozen.** An order carries
  only `selections` — catalogue keys, quantities, buy or rent; prices sent
  by a browser are dropped. Every draft save is priced and refused by
  field when it can't be ordered (minimums, extra buildings only on
  Building/Campus, one support tier); submission prices it again and
  freezes `Order.quote`. A catalogue change reaches NEW quotes only.
  `quotedAmount` keeps its old meaning: the plan's price per month.
- **`lib/quote.js` exists twice, byte for byte** (vendor and portal), as do
  the two default files; the pricing suite fails when they differ. The
  configurator's live quote is the same function the server runs.
- **Billing.** The first invoice carries the plan's period, every add-on
  and rental for that period, and every one-time item; renewals carry the
  plan and add-ons, never the one-time items again. Add-ons live on the
  subscription with their agreed prices (staff edit them there; the next
  invoice and the entitlements follow), and the snapshot's limits are the
  plan's (or an override) PLUS what add-ons add — two extra buildings on
  Building is three. VAT only while `Settings.business.vatRegistered`.
- Onboarding is on every order and waived on yearly billing; Standard
  support is the default tier at ₱0. docs/control-plane.md §2 and §4.

### Organization addresses (client)

Every organization lives at `<product>/<slug>/…`. `App.jsx` resolves the
first path segment at boot (`lib/orgAddress.js`) and mounts the UNCHANGED
router with `basename="/<slug>"`, so no page knows about slugs — keep it
that way: links and `navigate()` stay `/map`, `/admin/plan`.
- The old paths (`/`, `/map`, `/kiosk`, `/login`, …) are rewritten to the
  default organization (`VITE_DEMO_ORG_ID`) by its slug. A default with no
  slug yet — before `migrate:slugs` — is served at the old paths
  unprefixed, so deploying ahead of the migration breaks nothing.
- No address and no default: "Find your organization". An unknown address:
  the same box, prefilled. Either continues to the page that was asked for
  (`/kiosk` → `/<slug>/kiosk`). Neither lists organizations — that is the
  customer list.
- A new TOP-LEVEL route is a word no slug may take: add it to
  `LEGACY_ROUTES` and the server's `RESERVED_SLUGS`, or nest it under an
  existing one as `/login/reset` (Forgot PIN) is.
- Sessions are per organization (`lib/session.js`,
  `silla_token:<organizationId>`); a token is never sent for an
  organization its own claim does not name, and the old single key is
  adopted once, by the organization it belongs to.
- `lib/api.js` errors carry `code` and `details`; PLAN_FEATURE and
  ORG_SUSPENDED make OrgProvider re-read the config. Plan wording lives in
  `lib/plan.js`. Upgrade prompts (`UpgradePrompt`, the console's Plan &
  usage page) are for staff and superadmins; members get their own words
  ("Booking is paused", "Check-in is paused"), never a sales pitch.
- Walk it: `node tests/tenancy-preview.mjs --port=<n>` (server/) serves the
  demo plus "Harborview", provisioned like a customer on a limited plan;
  `--plan=suspended` (and `--features`, `--limits`) pushes a plan to the
  running preview, signed like the control plane; `--legacy-demo` serves
  the default with no address. Disposable, like `test:isolated`.

## Role model (spec §14)
Who may do what to the map — enforced on the server, mirrored in the UI:

| | member | staff | superadmin |
|---|---|---|---|
| Reserve, check in/out | ✅ | ✅ | ✅ |
| Change a unit's availability / out-of-service | — | ✅ | ✅ |
| Place & remove pieces, zones, labels | — | — | ✅ |
| Add / rename / resize / reshape / delete floors | — | — | ✅ |
| Staff management, org settings, closures | — | — | ✅ |

**Cross-organization isolation.** The portal provisions a deployment per
buyer, so more than one organization really does share a database now —
which turned a latent bug into a live one. Floors hang off sites and
sites carry the organization, so a bare `Floor.findById` LOOKS org-scoped
and is not. Three structural writes trusted a client-supplied `floorId`
that way (`POST /api/resources`, `/resources/zones`, `/resources/labels`),
letting one deployment's superadmin place pieces, draw zones and drop
labels on ANOTHER deployment's floor: the map reads by floor, so they
rendered on the victim's map, and an injected piece carried a
`resourceType` the victim's catalog did not contain, so their client
received something it could not draw. Verified with two real orgs, not
theorised. `resource.routes.js` now resolves every floorId through
`floorInOrg()` — the same site→organization check `floor.routes.js`
already did before every structural write. Any new route taking a
floorId must use it. Asserted in the permissions suite via
`helpers.foreignFloor()`, which builds a throwaway org that the cleanup
sweep removes.

Standing is re-read from the database on every authenticated request
(`middleware/auth.js`), not trusted from the token. A 12h token is proof
of a past login only: before this, deactivating a staff account left the
holder full admin access — member PII, PIN resets, card reissue — until
the token expired, and a demotion left the old role in the signature
just as long. Both are exactly the moves made when someone leaves or an
account is compromised. `requireRole` therefore reads a live role, and
the permissions suite asserts both revocations from the outside.

Still client-side only: the AUTH-3 terms gate and `mustChangePin` are
enforced by `RequireAuth` in `App.jsx` and reported by `/api/auth/me`,
but **no route enforces them**. A provisioned staff account that has
accepted nothing and still holds its emailed temporary PIN has full API
access — verified, not theorised. Closing it means a `requireOnboarded`
guard on the admin/resource/floor-write routers that still lets
`/api/auth/me`, `/accept-terms` and `/change-pin` through.

Staff **operate** the space; the superadmin **defines** it. Structural
routes (`/api/resources/*`, and the write half of `/api/floors`) are
`requireRole("superadmin")`; unit availability lives on the admin router
at staff level deliberately. `EditorPage` shows staff only the
Availability tool so they aren't offered buttons that would 403.

Resizing a room is refused while anything would fall outside the new
bounds, and a floor with placed items or live reservations cannot be
deleted — silently orphaning bookable seats off the edge of the map is
worse than an error message.

## Known gaps to close before production
- Rate limiting is in-memory, so it is per-process. Needs a shared store
  before horizontal scaling on AWS (INF-5). Limits are deliberately
  scoped to the threat, not the endpoint: registration and code entry
  are capped per CARD and per REGISTRATION, with only a generous per-IP
  ceiling, because a kiosk is one shared IP that legitimately onboards
  dozens of people in a row.
- Operating-hours checks use the server's local clock. Correct for a
  single-site deployment; multi-site needs a per-site timezone field.
- `/api/floors/:id/layout` is unauthenticated. It withholds the
  staff-only overstay flag, but should move behind `requireAuth` when
  member sessions are finalised.
- Three endpoints return a live code in the response when NODE_ENV is
  not production AND no mail provider is configured, so the kiosk and
  reset flows are testable without one. The guard reads `emailConfigured`,
  which is true for EITHER transport — filling in SMTP_USER closes this
  the same way an API key does, and it is currently filled in:
  `POST /api/registration/start` and `/resend` (`devVerificationCode`,
  `registration.routes.js:175` and `:281`) and
  `POST /api/auth/request-pin-reset` (`devResetCode`,
  `auth.routes.js:157`). All three carry the same two-part guard and it
  currently holds in all three — re-verify ALL of them before any real
  deployment. This list previously named only `/start`, which would have
  sent an auditor to one of the three.
- `server/.env.example` used to contain a live-looking MongoDB Atlas
  credential. It is now a placeholder so it never enters git history —
  but **the original credential must still be rotated in Atlas**, since
  it was exposed before this repo existed.

## Conventions
- server/ = Node + Express + Mongoose. client/ = React + Vite + Tailwind +
  Motion + Lucide. portal/ = the buyer-facing configurator (same client
  stack, port 5174) — see its section above.
- **Design system.** The items spec §20 left open (type/spacing scale,
  motion-duration tokens, focus/disabled/elevation states) now exist:
  - Tokens in `client/src/index.css` — motion, elevation, radii, plus a
    global `:focus-visible` ring and a `prefers-reduced-motion` block.
  - Primitives in `client/src/components/ui/index.jsx` — Button, Card,
    Panel, Field, PinField, Select, Segmented, Notice, Badge, Stat,
    StatusDot, Skeleton, EmptyState, PageHeader, Page.
  - Motion vocabulary in `client/src/lib/motion.js` — every screen uses
    these variants so the product moves at one speed, and they strip
    translation when the OS asks for reduced motion.

  - `FloorBackdrop.jsx` — the decorative plate behind the gate screens.
    It draws a floor plan (SpaceMap's 40px cell, the same zone and state
    tokens) rather than a gradient wash, so the first screen anyone sees
    is already the product. Its mask is a RING, not a spotlight: the
    form sits dead centre, and a plate brightest in the middle puts its
    busiest area behind the thing people must read.
  - `HourHistogram.jsx` — RPT-1's by-hour chart. Every hour keeps a
    track whether or not anything happened in it, because the shape of a
    DAY is the point; without them a quiet day rendered as two
    rectangles floating in a box and read as a broken chart.
  - `Stat` counts up to its value and takes an optional `progress`
    (0..1) capacity bar, pinned to the card floor with `mt-auto` so a
    card with a sub-line and one without still line their bars up.

  Two field lessons worth keeping:
  - `Field` takes `className` for the WRAPPER and `inputClassName` for
    the control. They were one prop, and since `className` is
    destructured, `props.className` on the input was always undefined —
    so PinField's letter-spacing landed on the `<label>` and rendered
    "6 — d i g i t   P I N" on four screens while the digits it was
    written for stayed unspaced.
  - Internal shorthand kept reaching users. Ten rendered strings carried
    "(spec §N)", the terms screen told people "Versioned re-acceptance is
    future work", the reports API shipped a `note` field full of roadmap
    jargon, and the seeded terms text in `profiles.js` cited spec §16 —
    which a BUYER would read. Spec references belong in comments only;
    grep the rendered strings, the API responses AND the seed data.

  - `Modal` — a portalled dialog with Escape, backdrop dismiss, scroll
    lock (scrollbar-width compensated) and focus return. **Anything that
    interrupts goes in one.** Three exist: the kiosk's manual card entry
    (`KioskPage`), reissue-a-card (`AdminPage`) and add-a-floor
    (`EditorPage`). The three always-visible forms — create staff, org
    settings, add closure — are deliberately NOT dialogs: they are the
    content of the tab you navigated to, and hiding them behind a click
    would add a step to reach the thing you came for. Inline forms that grow out of a list push
    the page around under the reader and can open off screen on a long
    list; the kiosk's manual-entry was a native `<details>`, whose
    triangle no styling makes look deliberate. Note the kiosk's reader
    loop re-focuses its hidden input every 1.2s and must be paused while
    a dialog is open, or you cannot type in the field it just opened.

  **Never ship vendor scaffolding to a buyer's users.** The client had
  accumulated: a "Powered by SILLA" byline on a WHITE-LABEL product, a
  "This deployment's configuration" panel listing internal field names
  (Resource noun, Check-in method) on the public home page, three error
  states telling members to run `npm run seed` / `seed:layout` or to set
  `VITE_DEMO_ORG_ID`, and an admin note instructing a buyer's superadmin
  to run `npm run profile`. Whoever reads a client-side error is a member
  standing at a screen, not the engineer who deploys it. Grep rendered
  strings for `npm run`, `.env`, `server/` and the product name before
  any demo.

  - `AppShell` — the application layout: a persistent left rail, fixed
    chrome, and one viewport-height frame whose CONTENT scrolls, not the
    document. Everything used to be a centred `max-w-6xl` column under a
    top bar, which is why it read as a webpage: wasted margins on a wide
    display, content growing downward forever, and the map sitting as a
    card INSIDE a page instead of being the surface.
    `fill` hands a page the whole area (the map). The editor deliberately
    does NOT use it — `fill` means overflow-hidden, and its zone, label
    and floor panels sit below the map, so they became unreachable.
  - `Inspector` — the panel that opens BESIDE what you selected. A
    column next to the map above `lg`, a bottom sheet below it. Not a
    dialog: it does not trap focus, because you are meant to keep
    clicking seats and watch it follow. Selecting a seat used to append
    a panel under the map and push the map up the screen; scrolling to
    it was a patch on the wrong shape.

  **The console's sections are ROUTES**, in `lib/adminSections.js` and
  listed by both the shell and the page. They were tab pills in local
  state, so they could not be linked, bookmarked, reached from the
  sidebar, or reversed with the back button. `/admin/reports` is now a
  URL you can send; an unknown or forbidden section falls back to the
  dashboard rather than rendering nothing.

  - `SpaceMap`'s `regionMode` + `onRegionSelect` — drag a rectangle on
    the grid instead of panning. Zones are DRAWN now, not typed: the
    editor used to take a corner from a click and then width and height
    as numbers, which is the wrong instrument for a spatial tool. You
    know where the room is; you do not know it is 7 cells wide. The
    drag shows its size live and the naming dialog asks for the one
    thing a drag cannot express.
  - `GridSketch` — the same idea for a NEW floor, which has no map to
    draw on yet. A blank canvas capped at the server's own limit
    (`validateGrid` accepts 1–60; offering a 90-wide sketch it would
    reject is a trap). Only the extent is kept, because a floor's grid
    is a size and not a position. The number fields stay alongside for
    whoever does know the figure — each drives the other.

  Two traps this work walked into, both worth remembering:
  - **Duplicate `style` attributes in JSX are silent.** The last one
    wins and the earlier is dropped with no warning at runtime. It cost
    a grid cursor here, and it had already been costing every zone LABEL
    its colour — they were painting in default SVG black on a dark map,
    which is why they always looked muddy. `vite build` prints it as a
    warning; read them.
  - **A gesture must not depend on a re-render.** Reading the drag
    rectangle from state inside the move handler means the gesture only
    works if React has re-rendered between pointerdown and the first
    move — true in practice, false under fast input. It is held in a ref
    for the handlers and mirrored to state for the render, the same way
    the pan pointers already were.

  **Nav links must be filtered on an explicit role, never `!role ||`.**
  That form passes `undefined`, so a signed-out visitor saw every link
  including Console and Editor — the route guards still bounced them to
  /login, so nothing was exposed, but the landing page read as "straight
  into the superadmin app". Signed out, only `public: true` links show
  (the kiosk, which deliberately has no session) plus a Sign in action.

  **ADM-2 is chips, not buttons.** Resources & Rules was 6,000px of
  scrolling: every zone expanded, one full-width card per piece, and the
  word "Disable" printed once per unit — five times a row. Now zones
  collapse (first one open, the rest closed) with a live per-zone tally
  in the header, each piece is one row, and the unit chip IS the
  control — clicking it toggles availability, which removes five buttons
  per row and puts state and action in one place. 6,114px → 1,021px.
  Colour is still not the only signal: the chip carries the unit label,
  unavailable is struck through, out-of-service is outlined not filled.
  Occupied and reserved chips are disabled because those are DERIVED
  from a reservation — the honest action is to cancel it.

  Compose these rather than hand-rolling. Before this existed each page
  redefined its own buttons, cards and notices, so no two surfaces
  matched and a focus-style change meant editing nine files. Colour still
  never appears literally — everything resolves through the tokens so
  buyer branding drives the whole UI (spec §16), which
  `npm run profile office` will show you in one command.
- Terminology is generic on purpose — "resource" / "member", never hardcode
  "seat" or "student" in new code. This applies to DEFAULTS too: the
  Organization schema's terminology defaults and any `|| "…"` fallback
  must be vertical-neutral. A default of "seat" makes every unconfigured
  deployment a library, which is the same bug as hardcoding it.
- Two vertical profiles exist in `server/src/scripts/profiles.js`:
  `library` and `office`. Everything that differs between them is DATA —
  branding, terminology, identity format, policy, catalog, floors, terms.
  Switch the running demo in place, keeping the same organizationId:

      npm run profile library
      npm run profile office

  If a change makes one vertical work and the other break, the change
  hardcoded something it shouldn't have. Use it as the regression test
  for white-label claims rather than asserting them.
- .env files in both folders are already filled in locally with real
  MongoDB Atlas credentials. Don't regenerate them or print their contents.
- `npm run seed` is create-only — running it twice mints a second org
  with a new id and silently invalidates the client's VITE_DEMO_ORG_ID.
  To refresh map data on an existing database use `npm run seed:layout`,
  which is re-runnable and only touches resources/zones/labels. It takes
  an optional profile: `npm run seed -- office`.
- Demo logins, all created by `npm run seed`: `admin@demo.test` /
  `123456` (terms accepted), `staff@demo.test` / `654321` (first login
  hits the AUTH-3 terms gate), `member@demo.test` / `111111` with card
  **DEADBEEF** for the kiosk. The member's memberId is derived from the
  seeded profile's `memberIdFormat`, so it is `2024-000001`-shaped under
  `library` and `EMP-#####`-shaped under `office` — never hardcoded.
  Card UIDs must be hex — "DEMO0001" is rejected because M and O are not
  hex digits, which is the normaliser doing its job.
- Surfaces: `/` landing · `/map` book · `/kiosk` tap · `/admin` console ·
  `/editor` map editor. All reachable from the header (`AppNav`), shown
  by role.
- SILLA is the product name; deployments are white-label and branded per
  buying organization — don't reintroduce institution-specific references.
