#!/usr/bin/env bash
# =====================================================================
# Ship server/ and vendor/ to the running instance and restart them.
#
#     source deploy/aws-env.sh
#     ./deploy/deploy-api.sh              # both services
#     ./deploy/deploy-api.sh server       # just one
#     ./deploy/deploy-api.sh --dry-run    # show what would change
#
# Deliberately rsync rather than `git pull` on the box: the repo is
# private, and a deploy key or token stored on the instance is one more
# credential to rotate and one more thing that can be read by anything
# running there. What ships is your working tree, so what you tested is
# what runs.
#
# .env files are NEVER copied. The box keeps its own in /etc/silla/,
# outside the code directory, precisely so a deploy cannot clobber them.
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

DRY=""
ARGS=()
for a in "$@"; do
  case "$a" in
    --dry-run) DRY="--dry-run" ;;
    *) ARGS+=("$a") ;;
  esac
done
SERVICES=("${ARGS[@]:-server vendor}")
[ ${#ARGS[@]} -eq 0 ] && SERVICES=(server vendor)

: "${SILLA_HOST:?source deploy/aws-env.sh first}"
: "${SILLA_SSH_KEY:?source deploy/aws-env.sh first}"

SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i "$SILLA_SSH_KEY")
remote() { ssh "${SSH_OPTS[@]}" "ec2-user@$SILLA_HOST" "$@"; }

echo "  host     : $SILLA_HOST"
echo "  services : ${SERVICES[*]}"
[ -n "$DRY" ] && echo "  DRY RUN — nothing will be changed"
echo

# ---------------------------------------------------------------------
# 1. Upload
# ---------------------------------------------------------------------
for svc in "${SERVICES[@]}"; do
  [ -d "$svc" ] || { echo "no such service: $svc" >&2; exit 1; }
  echo "[upload] $svc"
  rsync -az $DRY --delete --itemize-changes \
    --exclude 'node_modules' --exclude '.git' --exclude 'dist' \
    --exclude '.env' --exclude '*.log' --exclude '.DS_Store' \
    -e "ssh ${SSH_OPTS[*]}" \
    "$svc/" "ec2-user@$SILLA_HOST:/tmp/deploy-$svc/" | sed 's/^/    /'
done

[ -n "$DRY" ] && { echo; echo "Dry run complete."; exit 0; }

# ---------------------------------------------------------------------
# 2. Swap into place, install only if the lockfile moved, restart
#
# Comparing the lockfile rather than always running npm ci: a full
# install takes about a minute and most deploys are code-only, so paying
# it every time trains you not to deploy.
# ---------------------------------------------------------------------
for svc in "${SERVICES[@]}"; do
  echo "[install] $svc"
  remote "set -e
    OLD=\$(sha1sum /opt/silla/$svc/package-lock.json 2>/dev/null | cut -d' ' -f1 || echo none)
    NEW=\$(sha1sum /tmp/deploy-$svc/package-lock.json | cut -d' ' -f1)
    # --exclude node_modules is NOT optional here. The upload above
    # excludes it, so the staged copy has none — and --delete would
    # therefore remove the installed dependencies from the box, leaving
    # a service that cannot start. Excluding it from the swap makes
    # --delete mean 'remove source files that were deleted', which is
    # what it is for, rather than 'remove everything I did not upload'.
    sudo rsync -a --delete --exclude 'node_modules' /tmp/deploy-$svc/ /opt/silla/$svc/
    sudo chown -R silla:silla /opt/silla/$svc
    rm -rf /tmp/deploy-$svc
    # Reinstall when the lockfile moved OR when node_modules is simply
    # absent — a missing tree must never be silently skipped over.
    if [ \"\$OLD\" != \"\$NEW\" ] || [ ! -d /opt/silla/$svc/node_modules ]; then
      echo '    installing dependencies'
      cd /opt/silla/$svc && sudo -u silla env MONGOMS_DISABLE_POSTINSTALL=1 npm ci --omit=dev >/dev/null 2>&1
    else
      echo '    dependencies unchanged — skipping npm ci'
    fi"
done

echo
echo "[restart]"
UNITS=""
for svc in "${SERVICES[@]}"; do UNITS="$UNITS silla-$svc"; done
remote "sudo systemctl restart$UNITS
  # The app connects to Atlas BEFORE it listens, so a fixed sleep either
  # wastes time or reports a false failure. Poll instead.
  for i in \$(seq 1 20); do
    sleep 3
    all=yes
    for u in$UNITS; do [ \"\$(systemctl is-active \$u)\" = active ] || all=no; done
    [ \"\$all\" = yes ] && break
  done
  for u in$UNITS; do printf '    %-14s %s\n' \"\$u\" \"\$(systemctl is-active \$u)\"; done"

# ---------------------------------------------------------------------
# 3. Prove it, from the outside — a unit can be "active" while the app
#    inside it is failing every request.
# ---------------------------------------------------------------------
echo
echo "[verify]"
for path in /api/health /api/vendor/health; do
  code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "${API_URL:-http://$SILLA_HOST}$path")
  printf "    %-22s %s%s\n" "$path" "$code" "$([ "$code" = 200 ] || echo '   <-- CHECK THE LOGS')"
done
echo
echo "If something is wrong:"
echo "  ssh -i $SILLA_SSH_KEY ec2-user@$SILLA_HOST"
echo "  sudo journalctl -u silla-server -n 100 --no-pager"
