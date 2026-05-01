#!/usr/bin/env bash
set -euo pipefail

# Update script: pulls latest code and re-deploys changed scripts/units.
# Safe to run while streaming — only restarts services whose files changed.
# Usage: update.sh [--branch <branch>] [--restart-streamer]
#
# By default, streamer.service is NOT restarted (to avoid interrupting a live stream).
# Pass --restart-streamer to force a restart.
# --branch <name> selects which branch to pull (default: main)

RESTART_STREAMER=false
BRANCH="main"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --restart-streamer) RESTART_STREAMER=true; shift ;;
    --branch) BRANCH="${2:-main}"; shift 2 ;;
    *) shift ;;
  esac
done

REPO_DIR="/opt/yt"
cd "$REPO_DIR"

echo "=== yt-azure-streamer update ==="
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Starting update..."
echo "Target branch: $BRANCH"

# --- Pull latest code ---
echo "Pulling latest from origin/$BRANCH..."
git fetch origin "$BRANCH"
BEFORE=$(git rev-parse HEAD)
git reset --hard "origin/$BRANCH"
AFTER=$(git rev-parse HEAD)

if [[ "$BEFORE" == "$AFTER" ]]; then
  echo "Already up to date ($BEFORE)."
  exit 0
fi

echo "Updated: $BEFORE → $AFTER"
CHANGED=$(git diff --name-only "$BEFORE" "$AFTER")
echo "Changed files:"
echo "$CHANGED"
echo ""

# --- Re-install scripts if changed ---
SCRIPTS_CHANGED=false
declare -A SCRIPT_MAP=(
  ["services/streamer/streamer.sh"]="/usr/local/bin/streamer.sh"
  ["services/scheduler/scheduler.sh"]="/usr/local/bin/scheduler.sh"
  ["scripts/schedule-sync.sh"]="/usr/local/bin/schedule-sync.sh"
  ["scripts/generate-playlist.sh"]="/usr/local/bin/generate-playlist.sh"
  ["scripts/setup-caddy-auth.sh"]="/usr/local/bin/setup-caddy-auth.sh"
  ["scripts/update.sh"]="/usr/local/bin/yt-update.sh"
)

for src in "${!SCRIPT_MAP[@]}"; do
  if echo "$CHANGED" | grep -q "^${src}$"; then
    dest="${SCRIPT_MAP[$src]}"
    echo "Updating script: $src → $dest"
    install -m 755 "$REPO_DIR/$src" "$dest"
    SCRIPTS_CHANGED=true
  fi
done

# --- Re-install systemd units if changed ---
UNITS_CHANGED=false
declare -A UNIT_MAP=(
  ["systemd/streamer.service"]="/etc/systemd/system/streamer.service"
  ["systemd/scheduler.service"]="/etc/systemd/system/scheduler.service"
  ["systemd/schedule-sync.service"]="/etc/systemd/system/schedule-sync.service"
  ["systemd/schedule-sync.timer"]="/etc/systemd/system/schedule-sync.timer"
  ["systemd/caddy.service"]="/etc/systemd/system/caddy.service"
  ["systemd/caddy-auth-setup.service"]="/etc/systemd/system/caddy-auth-setup.service"
  ["systemd/caddy-auth-setup.timer"]="/etc/systemd/system/caddy-auth-setup.timer"
  ["systemd/web-backend.service"]="/etc/systemd/system/web-backend.service"
  ["systemd/blobfuse2.mount"]="/etc/systemd/system/mnt-blobfuse2.mount"
)

for src in "${!UNIT_MAP[@]}"; do
  if echo "$CHANGED" | grep -q "^${src}$"; then
    dest="${UNIT_MAP[$src]}"
    echo "Updating unit: $src → $dest"
    install -m 644 "$REPO_DIR/$src" "$dest"
    UNITS_CHANGED=true
  fi
done

if [[ "$UNITS_CHANGED" == true ]]; then
  echo "Reloading systemd daemon..."
  systemctl daemon-reload
fi

# --- Re-install Caddyfile if changed ---
# The Caddyfile in the repo is a TEMPLATE (contains CADDY_SITE_ADDRESS placeholder).
# The deployed config lives at /etc/yt/caddy/Caddyfile.
# We do NOT overwrite it. If the template structure changes, log a notice.
if echo "$CHANGED" | grep -q "^caddy/Caddyfile$"; then
  echo "NOTE: caddy/Caddyfile template changed. Review /etc/yt/caddy/Caddyfile manually if needed."
fi

# Same for blobfuse2 config
if echo "$CHANGED" | grep -q "^blobfuse2/blobfuse2.yaml$"; then
  echo "NOTE: blobfuse2/blobfuse2.yaml template changed. Review /etc/yt/blobfuse2/blobfuse2.yaml manually if needed."
fi

# --- Restart affected services ---
# Determine which services need restarting based on what changed.
RESTART_LIST=()

# Backend
if echo "$CHANGED" | grep -qE "^web/backend/"; then
  RESTART_LIST+=("web-backend.service")
fi

# Scheduler
if echo "$CHANGED" | grep -q "^services/scheduler/"; then
  RESTART_LIST+=("scheduler.service")
fi

# Streamer (only if flag passed)
if echo "$CHANGED" | grep -q "^services/streamer/" && [[ "$RESTART_STREAMER" == true ]]; then
  RESTART_LIST+=("streamer.service")
elif echo "$CHANGED" | grep -q "^services/streamer/"; then
  echo "NOTE: streamer.sh changed but streamer NOT restarted (pass --restart-streamer to force)."
fi

for unit in "${RESTART_LIST[@]}"; do
  echo "Restarting $unit..."
  systemctl restart "$unit" || true
done

# --- Summary ---
echo ""
echo "=== Update complete ==="
echo "Commit: $(git rev-parse --short HEAD)"
echo "Scripts updated: $SCRIPTS_CHANGED"
echo "Units updated: $UNITS_CHANGED"
echo "Services restarted: ${RESTART_LIST[*]:-none}"
if echo "$CHANGED" | grep -qE "^web/frontend/"; then
  echo "Frontend updated: yes (live immediately via Caddy)"
fi
