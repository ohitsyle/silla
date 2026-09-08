# The AWS console bits

Three CloudFront distributions, two S3 buckets, one EC2 instance. Do
them in this order — the frontends cannot be built until the API's URL
exists.

Region: **ap-southeast-2** (or `ap-southeast-1`, closer to Manila).
CloudFront itself is global; only the buckets and EC2 have a region.

---

## 1. EC2 instance

**EC2 → Launch instance**

| Field | Value |
|---|---|
| AMI | Amazon Linux 2023 |
| Type | `t4g.micro` (ARM) or `t3.micro` (x86) — whichever your free tier covers |
| Key pair | create one, download the `.pem`, keep it |
| Storage | 8–16 GB gp3 |
| User data | paste `deploy/bootstrap.sh` |

**Security group** — inbound:

| Port | Source | Why |
|---|---|---|
| 80 | `0.0.0.0/0` | CloudFront reaches the origin over HTTP |
| 22 | **your IP only** | SSH. Never `0.0.0.0/0` |

Do **not** open 4000 or 4100. nginx is the only thing that should be
reachable; the Node processes listen on localhost behind it.

**Then attach an Elastic IP** (EC2 → Elastic IPs → Allocate → Associate).
Without it the public address changes on every stop/start and you will
be re-allowlisting it in Atlas forever. An Elastic IP is free *while
attached to a running instance* — you get charged if you allocate one
and leave it unattached.

Add that Elastic IP to **Atlas → Network Access** before expecting
anything to work.

Check it: `curl http://<elastic-ip>/api/health` → `{"ok":true,...}`

---

## 2. The API distribution

This is what gives you HTTPS without owning a domain. CloudFront serves
the browser over `https://dXXXX.cloudfront.net` and talks plain HTTP to
your EC2 origin.

**CloudFront → Create distribution**

- **Origin domain**: your Elastic IP (type it in; it will not be in the
  dropdown)
- **Protocol**: **HTTP only** — the origin has no certificate, and
  "Match viewer" makes CloudFront try HTTPS and fail
- **Viewer protocol policy**: Redirect HTTP to HTTPS
- **Allowed HTTP methods**: **GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE**
  — the default is GET/HEAD only, and every login, booking and admin
  write will return **403** until you change it. This is the single most
  common way this setup fails.
- **Cache policy**: **CachingDisabled**. An API response cached for even
  a minute means one member sees another's reservation state.
- **Origin request policy**: **AllViewer** — forwards headers, cookies
  and query strings. Without it the `Authorization` header is stripped
  and every authenticated request is a 401.

WebSockets need no separate switch — CloudFront supports them natively
as long as the methods and origin-request policy above are right, and
nginx sends the upgrade headers (`deploy/nginx.conf` does).

Note the domain it gives you. That is your `API_URL`.

Check it: `curl https://dXXXX.cloudfront.net/api/health`

---

## 3. Two S3 buckets

**S3 → Create bucket**, once for the client and once for the portal.

- Name them something unique: `silla-client-<random>`, `silla-portal-<random>`
- **Leave "Block all public access" ON.** The buckets stay private;
  CloudFront reads them through an Origin Access Control. Public buckets
  and the legacy static-website endpoint are the old way and neither
  gives you HTTPS on your own.
- No other settings need changing. Do not enable static website hosting.

---

## 4. Two SPA distributions

One per bucket. **CloudFront → Create distribution**:

- **Origin domain**: pick the bucket from the dropdown (the S3 REST
  endpoint, not a website endpoint)
- **Origin access**: **Origin access control** → create one → then click
  the banner CloudFront shows and **copy the bucket policy it generates
  into the bucket**. Skip this and every request is 403.
- **Viewer protocol policy**: Redirect HTTP to HTTPS
- **Default root object**: `index.html`

Then the part everyone forgets — **Error pages → Create custom error
response**, twice:

| HTTP error code | Response page path | HTTP response code |
|---|---|---|
| 403 | `/index.html` | **200** |
| 404 | `/index.html` | **200** |

Both apps do client-side routing. Without this, `/admin/reports` or a
refresh anywhere other than `/` returns S3's error page instead of the
app. S3 returns 403 rather than 404 for a missing key when the bucket is
private, which is why you need both rows.

Note both domains and both distribution IDs.

---

## 5. Wire it together

Now the URLs exist, so the frontends can be built:

```bash
export API_URL=https://<api-distribution>.cloudfront.net
export DEMO_ORG_ID=6a8ed2b8587f249ffe338781
export CLIENT_BUCKET=silla-client-xxxx
export PORTAL_BUCKET=silla-portal-xxxx
export CLIENT_DIST_ID=E...
export PORTAL_DIST_ID=E...

./deploy/deploy-static.sh --dry-run   # check it first
./deploy/deploy-static.sh
```

Then put the two SPA URLs into `CORS_ORIGINS` in `/etc/silla/server.env`
and `/etc/silla/vendor.env` on the box, and:

```bash
sudo systemctl restart silla-server silla-vendor
```

---

## What "free" depends on

| Thing | Free-tier position |
|---|---|
| EC2 | 750 hours/month = **one** instance 24/7. A second box bills. |
| Elastic IP | Free **only while attached to a running instance**. |
| S3 | 5 GB. Both builds together are a couple of MB. |
| CloudFront | 1 TB out + 10M requests/month, always-free. |
| Atlas M0 | Free, unchanged. |
| Data transfer out of EC2 | Small but not zero — CloudFront caches the SPAs, so most traffic never reaches the box. |

AWS changed the free tier in 2025: newer accounts get credit-based plans
that expire rather than the old 12-month allowances. Check **Billing →
Free tier** to see which you are on, and set a **zero-spend budget
alert** (Billing → Budgets) before you launch anything. That is the
difference between finding out now and finding out on a statement.
