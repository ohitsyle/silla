#!/usr/bin/env bash
# =====================================================================
# SILLA — one-shot provisioning for a single Amazon Linux 2023 instance.
#
# Runs BOTH Node APIs on ONE box, because the AWS free tier gives 750
# EC2 hours a month and that is exactly one instance running 24/7. Two
# instances would be 1500 and you would be billed.
#
# Usage — paste into "User data" when launching the instance, or:
#   sudo REPO_URL=https://github.com/ohitsyle/silla.git bash bootstrap.sh
#
# Safe to re-run: it updates the checkout and restarts, it does not
# rebuild the box. It deliberately does NOT write /etc/silla/*.env —
# you install those by hand so secrets never pass through user-data,
# which is readable from the instance metadata service by anything
# running on the box.
# =====================================================================
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/ohitsyle/silla.git}"
BRANCH="${BRANCH:-main}"
APP_DIR=/opt/silla
APP_USER=silla

log() { echo "[bootstrap] $*"; }

# ---------------------------------------------------------------------
# 1. Packages
# ---------------------------------------------------------------------
log "installing packages"
dnf -y update
dnf -y install git nginx tar gzip

# Node 22. AL2023's own repo tops out below what this repo needs
# (package.json declares engines node>=20), so use NodeSource.
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  log "installing Node 22 from NodeSource"
  curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
  dnf -y install nodejs
fi
log "node $(node -v), npm $(npm -v)"

# ---------------------------------------------------------------------
# 2. Service account
# ---------------------------------------------------------------------
if ! id "$APP_USER" >/dev/null 2>&1; then
  log "creating $APP_USER"
  useradd --system --create-home --home-dir /var/lib/silla --shell /usr/sbin/nologin "$APP_USER"
fi

# ---------------------------------------------------------------------
# 3. Code
# ---------------------------------------------------------------------
if [ -d "$APP_DIR/.git" ]; then
  log "updating existing checkout"
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  log "cloning $REPO_URL"
  # A private repo needs credentials here. Simplest for a demo: make a
  # read-only deploy key, or clone once by hand over HTTPS with a PAT.
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ---------------------------------------------------------------------
# 4. Dependencies
#
# --omit=dev because nothing here builds; and MONGOMS_DISABLE_POSTINSTALL
# stops mongodb-memory-server downloading a ~100MB mongod binary that
# nothing in the repo imports and that would fill a free-tier root volume.
# ---------------------------------------------------------------------
for svc in server vendor; do
  log "npm ci in $svc"
  ( cd "$APP_DIR/$svc" \
    && sudo -u "$APP_USER" env MONGOMS_DISABLE_POSTINSTALL=1 npm ci --omit=dev )
done

# ---------------------------------------------------------------------
# 5. Secrets directory (contents installed manually — see
#    etc-silla-server.env.example / etc-silla-vendor.env.example)
# ---------------------------------------------------------------------
install -d -m 750 -o root -g "$APP_USER" /etc/silla
for f in server vendor; do
  if [ ! -f "/etc/silla/$f.env" ]; then
    log "NOTE: /etc/silla/$f.env is missing — the service will not start until you create it"
    install -m 640 -o root -g "$APP_USER" \
      "$APP_DIR/deploy/etc-silla-$f.env.example" "/etc/silla/$f.env"
  fi
done

# ---------------------------------------------------------------------
# 6. systemd + nginx
# ---------------------------------------------------------------------
log "installing units"
install -m 644 "$APP_DIR/deploy/silla-server.service" /etc/systemd/system/
install -m 644 "$APP_DIR/deploy/silla-vendor.service" /etc/systemd/system/
systemctl daemon-reload

log "installing nginx config"
install -m 644 "$APP_DIR/deploy/nginx.conf" /etc/nginx/conf.d/silla.conf
# AL2023's stock nginx.conf ships its own `server {}` on :80, which would
# race ours for default_server. Neutralise it.
if grep -q "listen       80;" /etc/nginx/nginx.conf; then
  log "disabling the stock default server block"
  sed -i '/^    server {/,/^    }/ s/^/#/' /etc/nginx/nginx.conf
fi
nginx -t

log "starting services"
systemctl enable --now silla-server silla-vendor
systemctl enable --now nginx
systemctl reload nginx

# ---------------------------------------------------------------------
# 7. Report
# ---------------------------------------------------------------------
sleep 3
log "--- status ---"
systemctl is-active silla-server silla-vendor nginx || true
log "product API : $(curl -s -o /dev/null -w '%{http_code}' localhost/api/health)  (expect 200)"
log "commerce API: $(curl -s -o /dev/null -w '%{http_code}' localhost/api/vendor/health)  (expect 200)"
log ""
log "If either is not 200:  journalctl -u silla-server -n 50 --no-pager"
log "Most likely cause: /etc/silla/*.env still holds the blank template."
