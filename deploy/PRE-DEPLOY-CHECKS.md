# Before you put this on the public internet

Every item below was checked against the code as it stands, not copied
from CLAUDE.md — that file has been wrong in both directions before.
File:line references are real; go read them if you doubt a call.

Target is INF-5's bar: *"deployed to AWS with the worker running so it
is demoable on staging."* Staging, not production. Some real weaknesses
are listed as accepted risks on that basis, and each says so explicitly.

---

## MUST FIX BEFORE EXPOSING

### 1. `TZ=Asia/Manila` on both services
`services/reservations/availability.js:94` computes the operating-hours
window with `date.getHours()` — process-local time. An AWS box is UTC.
Your seeded hours are 08:00–19:00, so on UTC the building is "open"
16:00–03:00 Manila, and the kiosk refuses every booking during the
entire Philippine working day:

| Manila | box thinks | kiosk |
|---|---|---|
| 09:00 | 01:00 UTC | refused |
| 13:00 | 05:00 UTC | refused |
| 15:00 | 07:00 UTC | refused |
| 17:00 | 09:00 UTC | works |

Set in both systemd units and both env files. This is the single most
likely thing to ruin a daytime demo.

### 2. Atlas Network Access must allow the instance
Attach an **Elastic IP** to the EC2 instance first, then allowlist that
one address in Atlas → Network Access. Without an Elastic IP the public
address changes on every stop/start and you will be re-allowlisting
constantly. Symptom of getting this wrong is a hang, not a permission
error.

### 3. Rotate the Atlas credential
CLAUDE.md records that the original credential sat in a committed
`.env.example` before this repo existed. It has still not been rotated.
Do it in Atlas → Database Access before the URI goes onto a box you do
not physically control, and update `/etc/silla/*.env`.

### 4. Two different `JWT_SECRET`s
`server` and `vendor` must not share one. A token minted for the buyer's
deployment must not be accepted by our order queue — that separation is
the entire reason `vendor/` is not just routes inside `server/`.
`openssl rand -hex 32` twice.

### 5. `CORS_ORIGINS` must name the CloudFront URLs
`app.js:15-16` allowlists these for REST; `server.js` now uses the same
list for Socket.io. Leave it empty and REST still works (it reflects the
origin) but you lose the allowlist entirely. Set it once the
distributions exist.

---

## SHOULD FIX

### 6. Change the seeded superadmin PIN
`admin@demo.test` / `123456` is seeded by `npm run seed` and printed in
`README.md`. Brute force is not the risk — AUTH-2 gives 10 attempts per
identity per 15 minutes plus a 15-minute account lockout, so a 6-digit
PIN would take years. The risk is that it is a *published* credential:
anyone who reads the repo or watches your demo has superadmin on a live
system. The demo org id is also public — it is baked into the client
bundle by Vite, which is by design.

Decide deliberately. For a graded demo you may *want* your instructor to
log in. If not, change it after seeding.

### 7. Onboarding guards are client-side only
`RequireAuth` in `client/src/App.jsx` enforces the AUTH-3 terms gate and
`mustChangePin`, and `/api/auth/me` reports both — but **no route
enforces them**. A provisioned staff account that has accepted nothing
and still holds its emailed temporary PIN has full API access. Verified,
not theorised.

Closing it means a `requireOnboarded` guard on the admin/resource/floor
write routers that still lets `/api/auth/me`, `/accept-terms` and
`/change-pin` through. For staging with a handful of known accounts this
is an accepted risk; do not carry it into a real deployment.

---

## ACCEPTED FOR STAGING

### 8. `/api/floors/:id/layout` is unauthenticated
`floor.routes.js:95` has no `requireAuth`. Confirmed live: returns 200
with no token. It leaks the floor plan — grid, piece placement, zones,
labels and per-unit availability — for any floor id someone can guess.
It does correctly withhold the staff-only `overstay` flag (`:128`).

Floor ids are ObjectIds, so not guessable in practice, and the map is
information a visitor standing in the building can see anyway. Fine for
staging; move it behind `requireAuth` when member sessions are
finalised.

### 9. Rate limiting is in-memory
`middleware/rateLimit.js` keeps buckets in process memory, so limits are
per-process. **On one instance that is not a limitation at all** — there
is only one process. It becomes one the moment you scale past a single
box, which the free tier prevents anyway. No action.

---

## CHECKED AND ALREADY FINE

- **Dev verification codes are not leaked.** The guard is
  `NODE_ENV !== "production" && !emailConfigured`
  (`registration.routes.js:175`, `:281`, `auth.routes.js:157`). Setting
  `NODE_ENV=production` closes all three on its own, independently of
  the mail provider. Both are true in the supplied env templates.
- **No stack traces escape.** `app.js:38-41` logs the error server-side
  and returns a bare `{"error":"Internal server error"}`.
- **Request bodies are bounded.** `server` uses Express's 100 KB
  default; `vendor` sets 1 MB explicitly for provisioning profiles.
- **Standing is re-read per request.** `middleware/auth.js` reloads the
  account on every authenticated call rather than trusting the token, so
  deactivating or demoting an account takes effect immediately instead
  of when a 12-hour token expires.
- **Cross-org isolation holds.** Every structural write resolves its
  `floorId` through `floorInOrg()`.
- **The worker needs no separate process.** `startScheduler()` is called
  from `server.js:43`, so `silla-server.service` running satisfies
  INF-5's "worker runs" on its own.
- **Test emails cannot escape.** Both transports refuse `@test.silla`
  and `@example.*`.
