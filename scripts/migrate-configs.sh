#!/usr/bin/env bash
set -euo pipefail

# One-time migration: moves deployment-specific configs to /etc/yt/
# and updates systemd units to reference the new paths.
#
# Run this ONCE on the existing VM after pulling the new code:
#   sudo bash /opt/yt/scripts/migrate-configs.sh
#
# After this, git pull will never conflict with local configs again.

echo "=== Migrating configs to /etc/yt/ ==="
mkdir -p /etc/yt/blobfuse2
mkdir -p /etc/yt/caddy

# --- Identity files (from /etc/ → /etc/yt/) ---
echo "Migrating identity files..."
for f in nameprefix resourcegroup customdomain; do
  if [[ -f "/etc/$f" ]]; then
    cp "/etc/$f" "/etc/yt/$f"
    echo "  /etc/$f → /etc/yt/$f"
  fi
done

# --- Blobfuse2 ---
echo "Migrating blobfuse2 config..."
if [[ -f /opt/yt/blobfuse2/blobfuse2.yaml ]] && ! grep -q "STORAGE_ACCOUNT" /opt/yt/blobfuse2/blobfuse2.yaml; then
  # The repo file has already been sed'd with the real account name
  cp /opt/yt/blobfuse2/blobfuse2.yaml /etc/yt/blobfuse2/blobfuse2.yaml
  echo "  Copied deployed blobfuse2.yaml to /etc/yt/blobfuse2/"
elif [[ -f /etc/blobfuse2/blobfuse2.yaml ]]; then
  # Already in /etc/ from earlier migration attempt
  cp /etc/blobfuse2/blobfuse2.yaml /etc/yt/blobfuse2/blobfuse2.yaml
  echo "  Moved /etc/blobfuse2/blobfuse2.yaml → /etc/yt/blobfuse2/"
else
  # Generate from template
  PREFIX=$(cat /etc/yt/nameprefix 2>/dev/null || cat /etc/nameprefix)
  STORAGE_NAME="${PREFIX,,}"
  sed "s/STORAGE_ACCOUNT/${STORAGE_NAME}/g" /opt/yt/blobfuse2/blobfuse2.yaml > /etc/yt/blobfuse2/blobfuse2.yaml
  echo "  Generated /etc/yt/blobfuse2/blobfuse2.yaml from template"
fi
chmod 644 /etc/yt/blobfuse2/blobfuse2.yaml

# --- Caddy ---
echo "Migrating Caddyfile..."
if [[ -f /opt/yt/caddy/Caddyfile ]] && ! grep -q "CADDY_SITE_ADDRESS" /opt/yt/caddy/Caddyfile; then
  # The repo file has the real address
  cp /opt/yt/caddy/Caddyfile /etc/yt/caddy/Caddyfile
  echo "  Copied deployed Caddyfile to /etc/yt/caddy/"
elif [[ -f /etc/caddy/Caddyfile ]]; then
  # Already in /etc/ from earlier migration attempt
  cp /etc/caddy/Caddyfile /etc/yt/caddy/Caddyfile
  echo "  Moved /etc/caddy/Caddyfile → /etc/yt/caddy/"
else
  # Generate from template
  PREFIX=$(cat /etc/yt/nameprefix 2>/dev/null || cat /etc/nameprefix)
  CUSTOM_DOMAIN=$(cat /etc/yt/customdomain 2>/dev/null || cat /etc/customdomain 2>/dev/null || true)
  CUSTOM_DOMAIN=$(echo "$CUSTOM_DOMAIN" | tr -d '[:space:]')
  if [[ -n "$CUSTOM_DOMAIN" ]]; then
    SITE_ADDRESS="$CUSTOM_DOMAIN"
  else
    REGION=$(curl -s -H Metadata:true --noproxy "*" \
      "http://169.254.169.254/metadata/instance/compute/location?api-version=2021-02-01&format=text" 2>/dev/null || true)
    if [[ -n "$PREFIX" && -n "$REGION" ]]; then
      SITE_ADDRESS="${PREFIX}.${REGION}.cloudapp.azure.com"
    else
      SITE_ADDRESS=":80"
    fi
  fi
  sed "s/CADDY_SITE_ADDRESS/${SITE_ADDRESS}/g" /opt/yt/caddy/Caddyfile > /etc/yt/caddy/Caddyfile
  echo "  Generated /etc/yt/caddy/Caddyfile from template"
fi
chmod 644 /etc/yt/caddy/Caddyfile

# --- Auth conf ---
echo "Migrating auth.conf..."
if [[ -f /etc/caddy/auth.conf ]]; then
  cp /etc/caddy/auth.conf /etc/yt/caddy/auth.conf
  chmod 600 /etc/yt/caddy/auth.conf
  echo "  Moved /etc/caddy/auth.conf → /etc/yt/caddy/"
else
  echo "# No auth configured — caddy-auth-setup.timer will populate this" > /etc/yt/caddy/auth.conf
  echo "  Created placeholder /etc/yt/caddy/auth.conf"
fi

# --- Schedule + playlist state ---
echo "Migrating schedule and playlist state..."
for f in schedule.json playlist-config.json playlist-state.json playlist.txt; do
  if [[ -f "/opt/yt/$f" ]]; then
    cp "/opt/yt/$f" "/etc/yt/$f"
    echo "  /opt/yt/$f → /etc/yt/$f"
  fi
done

# --- Restore repo templates (so git is clean) ---
echo "Restoring repo templates..."
git -C /opt/yt checkout -- blobfuse2/blobfuse2.yaml caddy/Caddyfile 2>/dev/null || true
# Remove runtime state files from repo dir (they now live in /etc/yt/)
for f in schedule.json playlist-config.json playlist-state.json playlist.txt; do
  if [[ -f "/opt/yt/$f" ]] && ! git -C /opt/yt ls-files --error-unmatch "$f" &>/dev/null; then
    # Only remove if it's not tracked by git
    :
  fi
done

# --- Update systemd units ---
echo "Updating systemd units..."
install -m 644 /opt/yt/systemd/blobfuse2.mount /etc/systemd/system/mnt-blobfuse2.mount
install -m 644 /opt/yt/systemd/caddy.service /etc/systemd/system/caddy.service
systemctl daemon-reload

# --- Re-install scripts ---
echo "Re-installing scripts..."
install -m 755 /opt/yt/services/streamer/streamer.sh  /usr/local/bin/streamer.sh
install -m 755 /opt/yt/services/scheduler/scheduler.sh /usr/local/bin/scheduler.sh
install -m 755 /opt/yt/scripts/schedule-sync.sh        /usr/local/bin/schedule-sync.sh
install -m 755 /opt/yt/scripts/generate-playlist.sh    /usr/local/bin/generate-playlist.sh
install -m 755 /opt/yt/scripts/setup-caddy-auth.sh     /usr/local/bin/setup-caddy-auth.sh
install -m 755 /opt/yt/scripts/update.sh               /usr/local/bin/yt-update.sh

# --- Restart affected services ---
echo "Restarting services..."
systemctl restart mnt-blobfuse2.mount
systemctl restart caddy
systemctl restart web-backend
systemctl restart scheduler

echo ""
echo "=== Migration complete ==="
echo "All configs now in /etc/yt/:"
ls -la /etc/yt/
echo ""
ls -la /etc/yt/blobfuse2/
echo ""
ls -la /etc/yt/caddy/
echo ""
echo "Repo files restored to templates — git status should be clean."
echo "Future updates via 'yt-update.sh' or the web UI will not touch /etc/yt/."
