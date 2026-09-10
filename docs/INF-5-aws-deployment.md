# INF-5 — Deploy to AWS: status record

**Story:** INF-5 — "As a developer, I want the app deployed to AWS with the
worker running so it is demoable on staging."
**AC:** Deployed; worker runs; meets the 'demo-able on staging' DoD.

**Date:** 2026-09-10  **Status: DEPLOYED — live and verified end to end**

---

## Live

| | |
|---|---|
| Product | https://d3ttts3ghharsa.cloudfront.net |
| Storefront | https://d3jtrqcm6l2crg.cloudfront.net |
| API | https://d7w5zy7mzwali.cloudfront.net |

Account 813578204603, region `ap-southeast-1` (Singapore).

| Resource | Id |
|---|---|
| EC2 (t3.micro, AL2023, 16 GB gp3) | `i-03965ef2bfef96606` |
| Elastic IP | `13.251.74.151` |
| Origin hostname | `ec2-13-251-74-151.ap-southeast-1.compute.amazonaws.com` |
| Security group | `sg-03be50d24f6d69c1c` |
| CloudFront — API | `EW97K1LVLRDL9` |
| CloudFront — client | `ERWHO88XIMD9H` |
| CloudFront — portal | `E1TF02WVIQ8GQL` |
| S3 — client | `silla-client-204603` |
| S3 — portal | `silla-portal-204603` |

**Verified in a browser, not inferred:** signed in as the seeded superadmin
and the map drew 98 elements with zones, labels and per-seat state, from
Atlas, with zero console errors. SPA deep links (`/map`, `/admin/reports`,
`/kiosk`) all return 200, so the 403/404 → `/index.html` rule is working.
HTTP 301s to HTTPS. The CORS preflight returns 204 and names the real
client origin. **The Socket.io WebSocket upgrade completes through
CloudFront**, which was the single riskiest part of this shape. The
doorway dialog works on the deployed storefront and carries the plan.

`TZ=Asia/Manila` and `NODE_ENV=production` confirmed by reading
`/proc/<pid>/environ` of the running process — the box clock is UTC but
the app evaluates operating hours against Manila, which is the trap that
would otherwise refuse every booking through the working day.
`[scheduler] started` is in the journal, so INF-5's "worker runs" holds.

### Operating it

    ssh -i <key>.pem ec2-user@13.251.74.151
    sudo systemctl status silla-server silla-vendor nginx
    sudo journalctl -u silla-server -n 100 --no-pager

Redeploy the APIs: rsync `server/` and `vendor/` to `/opt/silla/`, then
`sudo systemctl restart silla-server silla-vendor`.
Redeploy the frontends: `./deploy/deploy-static.sh` with the bucket and
distribution ids above.

**Secrets live in `/etc/silla/*.env`, mode 640 root:silla, outside the
code directory** so a redeploy cannot clobber them. The JWT secrets were
generated fresh on the box and differ per service; the laptop's dev
secrets never travelled.

### Deliberately not done

No custom domain, so the URLs are `*.cloudfront.net`. No ALB — one
instance is the free-tier ceiling and CloudFront terminates TLS anyway.
Provisioning is still manual. The items in `deploy/PRE-DEPLOY-CHECKS.md`
under SHOULD FIX remain: the onboarding guards are client-side only, and
the seeded `admin@demo.test` / `123456` is now a live superadmin on a
public URL.

## How it got here

**Not deployed.** No AWS resource has been created. Nothing is billing.

Everything needed to deploy lives in `deploy/` and is committed. The work
that remains is provisioning — clicking through the console and running
two scripts — not design or research. Picking this back up should be an
afternoon, not a project.

**The one blocker:** the AWS credentials on this machine are invalid.
`aws sts get-caller-identity` returns `InvalidClientTokenId`. `~/.aws/credentials`
holds a long-lived key (`AKIA…`, dated January 2026) that no longer works,
consistent with a new account having been created since. A fresh access key
must be made in the console before anything else can happen.

---

## The architecture, and why

```
CloudFront (HTTPS, no domain required)
 ├── dXXXX.cloudfront.net ──► S3 ──► client/dist    the product
 ├── dYYYY.cloudfront.net ──► S3 ──► portal/dist    the storefront
 └── dZZZZ.cloudfront.net ──► EC2 ─► nginx ─┬─► :4000  server + cron worker
                                             └─► :4100  vendor
MongoDB Atlas M0 (unchanged)
```

Three constraints drove this shape:

1. **Free tier only.** 750 EC2 hours a month is exactly one instance running
   24/7, so both Node APIs share one box. Two instances would be 1500 hours
   and would bill. This rules out ECS/Fargate, an ALB, RDS/DocumentDB and
   ElastiCache.
2. **No domain name.** CloudFront terminates HTTPS on a `*.cloudfront.net`
   name and speaks plain HTTP to the EC2 origin. Without it you have an
   HTTPS page calling an HTTP API, which browsers block as mixed content —
   the usual way this setup dies. ACM cannot issue a certificate for an
   `*.elb.amazonaws.com` name, so an ALB would not solve it either.
3. **INF-5's "worker runs" is already satisfied.** `startScheduler()` is
   called in-process from `server/src/server.js:43`, so `silla-server.service`
   covers it. There is no second process to supervise.

---

## Findings that changed the design

**Operating hours break on a UTC box.** `services/reservations/availability.js:94`
computes the window with `date.getHours()` — process-local time. Seeded hours
are 08:00–19:00. On a default-UTC instance the building reads as open
16:00–03:00 Manila, so the kiosk refuses every booking through the entire
Philippine working day:

| Manila | box thinks | kiosk |
|---|---|---|
| 09:00 | 01:00 UTC | refused |
| 13:00 | 05:00 UTC | refused |
| 17:00 | 09:00 UTC | works |

`TZ=Asia/Manila` is set in both systemd units and both env templates. This
would have silently ruined a daytime demo.

**Vite bakes `VITE_*` at build time.** `localhost:4000` is literally inlined
in the current `client/dist` bundle. So the CloudFront distributions must
exist *before* the frontends are built — the order is forced, and
`deploy-static.sh` refuses to upload a bundle still containing a localhost URL.

**The env templates were rebuilt from the code.** `server/.env.example` had no
SMTP block at all and `vendor/.env.example` was missing six variables, so
copying them would have left email silently console-logging. The templates in
`deploy/` were derived by grepping `process.env` across each service and
verified complete.

---

## What is in `deploy/`

| File | Purpose |
|---|---|
| `README.md` | the shape, the ordered runbook, symptom→cause table |
| `PRE-DEPLOY-CHECKS.md` | what is safe to expose and what is not |
| `bootstrap.sh` | EC2 user-data: Node 22, nginx, units, clone, start. Re-runnable |
| `silla-server.service` / `silla-vendor.service` | systemd, `TZ` and `NODE_ENV` set |
| `nginx.conf` | reverse proxy incl. the WebSocket upgrade the live map needs |
| `etc-silla-*.env.example` | `/etc/silla/*.env` templates, verified complete |
| `deploy-static.sh` | builds both SPAs, ships to S3, invalidates CloudFront |
| `s3-cloudfront-setup.md` | console steps in order, with the settings that break things |

Verified before committing: nginx routing matches the real Express mounts
(`/api/vendor/*` → :4100, the other nine `/api/*` mounts → :4000, longest
prefix wins); both shell scripts parse; the upload guard fires against the
current localhost bundles; `ProtectSystem=strict` is safe because the app
performs zero filesystem writes; no secret appears in any file.

**Untested:** the nginx config has never been parsed by nginx — there is none
on the dev machine. `bootstrap.sh` runs `nginx -t` before starting, so a
syntax error fails loudly on the box rather than silently.

---

## To resume

1. Console → Security credentials → Create access key → `aws configure`.
   Verify with `aws sts get-caller-identity`.
2. Decide the region. Currently `ap-southeast-2` (Sydney);
   `ap-southeast-1` (Singapore) is closer to Manila and will feel faster.
   Cheaper to change now than after resources exist.
3. Check **Billing → Free tier** for which plan the account is on. AWS moved
   newer accounts to credit-based plans that expire rather than the old
   12-month allowances. Set a zero-spend budget alert first.
4. Follow `deploy/README.md` from step 3.

## Decisions deferred, not resolved

- **`admin@demo.test` / `123456` becomes a live superadmin login** the moment
  this is public. Lockout makes brute force impractical, but the credential is
  *published* — it is in `README.md`. For a graded demo that may be wanted.
- **Onboarding guards are client-side only.** A provisioned staff account that
  accepted nothing and still holds its temporary PIN has full API access.
  Tracked separately as a system gap, not a deployment one.
- **The Atlas credential still needs rotating** before the URI goes onto a box
  we do not physically control.
