# Deploying SILLA to AWS (INF-5)

The story: *"deployed to AWS with the worker running so it is demoable
on staging."* The worker comes for free — `startScheduler()` runs
in-process inside the API (`server/src/server.js:43`), so there is no
second thing to supervise.

## The shape

```
CloudFront (HTTPS, no domain needed)
 ├── dXXXX.cloudfront.net ──► S3 ──► client/dist    the product
 ├── dYYYY.cloudfront.net ──► S3 ──► portal/dist    the storefront
 └── dZZZZ.cloudfront.net ──► EC2 ─► nginx ─┬─► :4000  server + cron worker
                                             └─► :4100  vendor
MongoDB Atlas M0  (unchanged, already yours)
```

**Why one EC2 for two APIs:** the free tier is 750 EC2 hours a month,
which is exactly one instance running 24/7. Two instances is 1500 and
you get billed.

**Why CloudFront in front of the API:** it gives you real HTTPS on a
`*.cloudfront.net` name without owning a domain. Skip it and you have an
HTTPS page calling an HTTP API, which browsers block as mixed content.

## Files here

| File | What it is |
|---|---|
| `bootstrap.sh` | EC2 user-data. Installs Node 22, nginx, the units; clones and starts. Re-runnable. |
| `silla-server.service` | systemd unit for the product API + worker |
| `silla-vendor.service` | systemd unit for the commerce API |
| `nginx.conf` | reverse proxy, incl. the WebSocket upgrade the live map needs |
| `etc-silla-*.env.example` | templates for `/etc/silla/*.env` — every variable the code actually reads |
| `deploy-static.sh` | builds both SPAs and ships them to S3 + invalidates |
| `s3-cloudfront-setup.md` | the console clicking, in order |
| `PRE-DEPLOY-CHECKS.md` | **read this before exposing anything** |

## Order of operations

Not negotiable — Vite bakes `VITE_*` in at build time, so the API URL
must exist before the frontends are built.

1. Read `PRE-DEPLOY-CHECKS.md`.
2. Set a zero-spend budget alert in Billing.
3. Launch EC2 with `bootstrap.sh` as user data. Attach an Elastic IP.
4. Allowlist that Elastic IP in Atlas → Network Access.
5. Fill in `/etc/silla/server.env` and `/etc/silla/vendor.env` on the
   box, then `sudo systemctl restart silla-server silla-vendor`.
6. Confirm: `curl http://<elastic-ip>/api/health` and `/api/vendor/health`.
7. Create the API CloudFront distribution → note its URL.
8. Create the two S3 buckets and their distributions.
9. `./deploy-static.sh` with the URLs from 7 and 8.
10. Put the two SPA URLs into `CORS_ORIGINS` on the box and restart.

## When something is wrong

```bash
sudo systemctl status silla-server silla-vendor
sudo journalctl -u silla-server -n 100 --no-pager
sudo nginx -t && sudo systemctl reload nginx
```

| Symptom | Almost always |
|---|---|
| Service won't start | `/etc/silla/*.env` still holds the blank template |
| Hangs connecting to Mongo | Elastic IP not allowlisted in Atlas |
| Every write returns 403 | API distribution allows only GET/HEAD |
| Logged in, then 401 everywhere | origin request policy isn't AllViewer — `Authorization` is being stripped |
| App loads, map never updates | WebSocket upgrade — check `nginx.conf` is installed and `CORS_ORIGINS` is set |
| Refresh on `/admin` gives an error page | the 403/404 → `/index.html` custom error responses are missing |
| Kiosk says "must fall between 08:00 and 19:00" mid-morning | `TZ=Asia/Manila` isn't set |
| Deployed but users see the old app | `index.html` got cached — `deploy-static.sh` handles this |

## Not done here

Nothing in this directory hardens the app beyond staging. The items in
`PRE-DEPLOY-CHECKS.md` under **SHOULD FIX** — the client-side-only
onboarding guards, the published demo superadmin — are real and stay
real. This gets INF-5 demoable, which is what INF-5 asks for.
