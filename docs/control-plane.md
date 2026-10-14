# Control plane, tenancy, plans and the staff console

How SILLA (the company) runs many customer deployments from one place.
This is the contract between the four parts of the system; code in each
part links back here.

    portal/   SILLA's storefront, the buyer's account, the staff console
    vendor/   SILLA's commerce API — accounts, orders, billing, staff   (CONTROL PLANE)
    server/   the product API every customer organization runs on       (DATA PLANE)
    client/   the product every customer organization's people use

The rules from CLAUDE.md still hold: no imports across services, separate
JWT secrets, and the customer list never ships to customers.

---

## 1. Tenancy — one product, many organizations

Every organization has an address: `<product URL>/<slug>/…`, for example
`https://d3ttts3ghharsa.cloudfront.net/harborview/map`.

- `Organization.slug` (server) — 3–40 lowercase letters, digits and
  hyphens; unique; reserved words in `server/src/lib/slug.js`
  (`RESERVED_SLUGS`) can never be slugs because they are the client's own
  routes (`login`, `map`, `kiosk`, …).
- `GET /api/organizations/by-slug/:slug/config` — the public config the
  client boots from (same shape as `/:id/config`, plus `_id`, `slug` and
  public `entitlements`).
- The client reads the first path segment at boot, resolves it, and mounts
  its router with `basename="/<slug>"`, so every existing route and link
  keeps working unchanged inside the organization.
- Legacy addresses with no slug (`/map`, `/login`, `/kiosk`, … — kiosks
  and bookmarks point there today) redirect to the default organization:
  the one `VITE_DEMO_ORG_ID` names, by its slug.
- Sessions are per organization: the token is stored under
  `silla_token:<organizationId>`, so signing in to one never signs you in
  to another.
- `npm run migrate:slugs` (server) gives every existing organization a
  slug derived from its name. Idempotent; `--apply` to write.

## 2. Entitlements — what a plan allows

The keys are in `server/src/lib/plans.js` and its copy
`vendor/src/lib/planKeys.js`:

| features (true/false) | limits (number, or null = unlimited) |
|---|---|
| `kiosk` — kiosk check-in and self-registration | `buildings` |
| `reports` — reports and CSV export | `floors` |
| `customBranding` — colours and logo | `rooms` |
| `wholeRoomBooking` — rooms booked whole | `resources` — bookable units |
| `emailReminders` — starting-soon emails | `members` |
| | `staff` — staff and superadmin accounts |

The snapshot the control plane pushes, stored as `Organization.entitlements`:

```json
{
  "managed": true,
  "plan": "building",
  "planName": "Whole Building",
  "status": "trialing | active | past_due | suspended | cancelled",
  "features": { "kiosk": true, "reports": true, "customBranding": true, "wholeRoomBooking": true, "emailReminders": true },
  "limits": { "buildings": 1, "floors": null, "rooms": null, "resources": 600, "members": null, "staff": null },
  "currentPeriodEnd": "2026-11-14T00:00:00.000Z",
  "graceEndsAt": null,
  "notice": null,
  "version": 1760455200000
}
```

Semantics — enforced ONLY through `server/src/services/entitlements.js`:

- `managed: false` (every organization that predates this, and the demo):
  every feature, no limits.
- A feature or limit the snapshot does not mention is allowed. To withhold
  something, the control plane must say `false` or a number.
- `trialing`, `active` and `past_due` work normally (`past_due` is the
  grace period). `suspended` and `cancelled` are READ-ONLY: anyone can
  sign in and look, nothing changes (`operationalGuard`, mounted once in
  app.js). Errors carry `code: "ORG_SUSPENDED"`.
- Limits block NEW creation only (`assertWithinLimit`, `code:
  "PLAN_LIMIT"`, with `limit`, `max`, `used`). A downgrade never deletes or
  hides anything.
- Withheld features answer `code: "PLAN_FEATURE"` with `feature`.
- An older snapshot (lower `version`) arriving after a newer one is
  ignored.
- The client mirrors the reading in `client/src/lib/OrgContext.jsx`
  (`entitlementsOf`) only to EXPLAIN limits before they are hit — upgrade
  prompts instead of buttons that fail. The server is the control.

## 3. The control-plane API (server, `/api/internal`)

Signed with `CONTROL_PLANE_SECRET` (32+ characters, set on both services):

    Authorization: SILLA-HMAC t=<unix seconds>,sig=<hex>
    sig = HMAC-SHA256(secret, `${t}\n${METHOD}\n${path incl. query}\n${sha256hex(raw body)}`)

Five-minute window, each signature accepted once, 503 when the secret is
unset. Verifier: `server/src/lib/controlPlane.js`; signer:
`vendor/src/lib/controlPlane.js` (`callDeployment(method, path, body)`).
nginx refuses `/api/internal/` from the internet; vendor calls the server
on `SERVER_INTERNAL_URL` (default `http://127.0.0.1:4000`).

| method & path | body | answer |
|---|---|---|
| `GET /api/internal/ping` | — | `{ ok: true }` |
| `GET /api/internal/slugs/:slug` | — | `{ available, problem, suggestion }` |
| `POST /api/internal/organizations` | `{ profile, slug, entitlements, source: { orderId } }` | `201 { organizationId, slug, owner: { email, temporaryPin } \| null, summary }` — `400 { error, fields }` for a bad profile, `409 { error, code: "SLUG_TAKEN", suggestion }` |
| `GET /api/internal/organizations/:id` | — | `{ organization: { id, name, slug, createdAt }, entitlements, usage: { buildings, floors, rooms, resources, members, staff }, activity: { reservations30d, checkIns30d, lastReservationAt }, owners: [{ email, firstName, lastName, mustChangePin }] }` |
| `PUT /api/internal/organizations/:id/entitlements` | the snapshot | `{ entitlements, ignored? }` |
| `POST /api/internal/organizations/:id/owner-access` | `{ email? }` | `{ email, temporaryPin }` — re-issues a temporary PIN to that superadmin (default: the earliest), forces a PIN change, emails it |

`profile` is exactly what the configurator emits and `importProfile.js`
validates — the same path `npm run seed:file` takes, extracted into
`server/src/services/provisioning.js` so the CLI and the API cannot
drift. The temporary PIN is returned ONCE so staff have a fallback when
the founder email (fire-and-forget) does not arrive — the same reason the
CLI prints it. It is never stored by the vendor.

Deployment URL for an organization: `${PRODUCT_URL}/${slug}` (vendor env
`PRODUCT_URL`; the server's founder email uses its own `APP_URL`).

## 4. Billing (vendor)

Models: `Plan`, `Subscription`, `Invoice`, `Counter`, `Settings` in
`vendor/src/models/`. Their header comments are the specification.

Lifecycle:

1. Buyer submits an order → `billing.onOrderSubmitted(order)` creates a
   `pending` subscription and the first invoice (due in
   `Settings.invoice.dueDays`), emailed with payment instructions.
2. Staff provision the deployment → `billing.onProvisioned(order, orgId)`:
   `trialing` (until `Settings.billing.trialDays`) unless the first invoice
   is already paid, in which case `active`.
3. Staff record a payment against an invoice → `active`, period starts (or
   extends), receipt emailed. A buyer's "I've paid" is a CLAIM staff
   confirm; it never activates anything by itself.
4. The billing job (vendor/src/workers/billing.jobs.js) issues the renewal
   invoice `renewalNoticeDays` before the period ends; an unpaid period end
   → `past_due` with `graceEndsAt`; grace over → `suspended`; reminder
   emails at each step, each sent once.
5. Every status change pushes the snapshot (`billing.syncDeployment`);
   failures are recorded on `subscription.sync.error` and retried by the
   job.

Payments are recorded by staff (bank transfer, GCash, Maya, cash) — Stripe
does not serve Philippine businesses, and a processor (PayMongo or Xendit)
is a later step behind the same seam: it would call the same "record a
payment" path from a webhook.

The functions other code may call are exported from
`vendor/src/services/billing.js`; nothing outside billing touches its
models directly except to READ them for display.

## 5. Staff console

`portal` routes `#/staff/<section>[/<id>]`, sign-in at `#/staff/sign-in`.
Sections are listed once in `portal/src/staff/sections.js`, each tied to a
permission from `vendor/src/middleware/staff.js`:

| role | may |
|---|---|
| owner | everything, including staff and settings |
| admin | orders, provisioning, deployments, billing, plans, settings, activity |
| billing | billing and plans read, invoices and payments |
| support | orders, clients, conversations, owner-access resets |

The console asks `GET /api/vendor/staff/me` for the signed-in person's
permissions and shows only those sections; every route checks again with
`requirePermission`. Every staff mutation writes an `AuditEvent` through
`vendor/src/lib/audit.js`. The first owner still comes from
`npm run seed:staff`; owners invite the rest from the console.

Conversations (`Conversation`, `Message`): a buyer can start one from
their account or an order; staff answer from the console. Internal notes
(`internal: true`) are excluded in the QUERY, never filtered afterwards.
Each side is emailed about unread replies at most once per quiet period.
