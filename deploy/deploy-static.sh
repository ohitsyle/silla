#!/usr/bin/env bash
# =====================================================================
# SILLA — build and ship both SPAs to S3, then invalidate CloudFront.
#
# Run this from your LAPTOP, not the EC2 box. The frontends are static;
# nothing about them needs a server.
#
# THE ORDER MATTERS. Vite inlines VITE_* at BUILD time — `localhost:4000`
# is literally baked into the JS bundle. So the CloudFront distributions
# must exist and their URLs must be known BEFORE you build. You cannot
# build now and configure later.
#
#   export API_URL=https://dXXXX.cloudfront.net        # API distribution
#   export DEMO_ORG_ID=6a8ed2b8587f249ffe338781
#   export CLIENT_BUCKET=silla-client-xxxx
#   export PORTAL_BUCKET=silla-portal-xxxx
#   export CLIENT_DIST_ID=E1234ABCD
#   export PORTAL_DIST_ID=E5678EFGH
#   ./deploy-static.sh              # or --dry-run to see what it would do
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

DRY_RUN=false
[ "${1:-}" = "--dry-run" ] && DRY_RUN=true && echo "[dry-run] nothing will be uploaded"

run() { if $DRY_RUN; then echo "  would run: $*"; else "$@"; fi; }

require() {
  local missing=0
  for v in "$@"; do
    if [ -z "${!v:-}" ]; then echo "  MISSING: $v" >&2; missing=1; fi
  done
  [ "$missing" -eq 0 ] || { echo "Set the variables above and re-run." >&2; exit 1; }
}
require API_URL DEMO_ORG_ID CLIENT_BUCKET PORTAL_BUCKET CLIENT_DIST_ID PORTAL_DIST_ID

# VITE_VENDOR_API_URL defaults to the same origin as the product API,
# because nginx routes /api/vendor/* to :4100 on the same box.
VENDOR_API_URL="${VENDOR_API_URL:-$API_URL}"

echo "  API        : $API_URL"
echo "  vendor API : $VENDOR_API_URL"
echo "  org id     : $DEMO_ORG_ID"
echo

# ---------------------------------------------------------------------
# Build. The env vars are set inline so they cannot leak into a later
# build from a stale shell.
# ---------------------------------------------------------------------
echo "[1/4] building client/"
( cd client && VITE_API_URL="$API_URL" VITE_DEMO_ORG_ID="$DEMO_ORG_ID" npm run build )

echo "[2/4] building portal/"
( cd portal && VITE_VENDOR_API_URL="$VENDOR_API_URL" npm run build )

# Fail loudly rather than shipping a bundle still pointing at localhost.
for d in client portal; do
  if grep -rqs "localhost:4000\|localhost:4100" "$d/dist/assets/"*.js 2>/dev/null; then
    echo "REFUSING TO UPLOAD: $d/dist still contains a localhost URL." >&2
    echo "The build did not pick up the VITE_* variables." >&2
    exit 1
  fi
done
echo "  no localhost URLs in either bundle"

# ---------------------------------------------------------------------
# Upload. Two passes per bucket, because the cache rules differ:
#
#   /assets/*   content-hashed by Vite, so the name changes whenever the
#               bytes change -> cache for a year, immutable.
#   index.html  the ONLY unhashed file, and the one that points at the
#               current asset names -> must never be cached, or users
#               keep loading yesterday's app forever after a redeploy.
# ---------------------------------------------------------------------
upload() {
  local dist="$1" bucket="$2"
  echo "  -> s3://$bucket"
  run aws s3 sync "$dist" "s3://$bucket" \
      --delete \
      --exclude "index.html" \
      --cache-control "public,max-age=31536000,immutable"
  run aws s3 cp "$dist/index.html" "s3://$bucket/index.html" \
      --cache-control "no-cache,no-store,must-revalidate" \
      --content-type "text/html"
}

echo "[3/4] uploading"
upload client/dist "$CLIENT_BUCKET"
upload portal/dist "$PORTAL_BUCKET"

# ---------------------------------------------------------------------
# Invalidate. ONLY /index.html — the hashed assets are new filenames, so
# CloudFront has never seen them and there is nothing stale to purge.
# Invalidating /* on every deploy is wasteful: the free tier covers 1000
# invalidation paths a month, and /* burns one path per deploy while
# also throwing away a perfectly warm cache.
# ---------------------------------------------------------------------
echo "[4/4] invalidating index.html"
run aws cloudfront create-invalidation --distribution-id "$CLIENT_DIST_ID" --paths /index.html
run aws cloudfront create-invalidation --distribution-id "$PORTAL_DIST_ID" --paths /index.html

echo
echo "Done. Give CloudFront a minute, then hard-reload."
