#!/usr/bin/env bash
set -euo pipefail

# One-time migration: moves deployment-specific configs from /opt/yt/ to /etc/
# and updates systemd units to reference the new paths.
#
# Run this ONCE on the existing VM after pulling the new code:
#   sudo bash /opt/yt/scripts/migrate-configs.sh
#
# After this, git pull will never conflict with local configs again.

echo "=== Migrating configs to /etc/ ==="

# --- Blobfuse2 ---
echo "Moving blobfuse2 config to /etc/blobfuse2/..."
mkdir -p /etc/blobfuse2

if [[ -f /opt/yt/blobfuse2/blobfuse2.yaml ]] && ! grep -q "STORAGE_ACCOUNT" /opt/yt/blobfuse2/blobfuse2.yaml; then
  # The repo file has already been sed'd with the real account name — move it
  cp /opt/yt/blobfuse2/blobfuse2.yaml /etc/blobfuse2/blobfuse2.yaml
  echo "  Copied deployed blobfuse2.yaml to /etc/blobfuse2/"
else
  echo "  /opt/yt/blobfuse2/blobfuse2.yaml still has placeholders — generating from template..."
  PREFIX=$(cat /etc/nameprefix)
  STORAGE_NAME="${PREFIX,,}"
  sed "s/STORAGE_ACCOUNT/${STORAGE_NAME}/g" /opt/yt/blobfuse2/blobfuse2.yaml > /etc/blobfuse2/blobfuse2.yaml
fi
chmod 644 /etc/blobfuse2/blobfuse2.yaml

# Restore the template in the repo (so git is clean)
git -C /opt/yt checkout -- blobfuse2/blobfuse2.yaml

# --- Caddy ---
echo "Moving Caddyfile to /etc/caddy/..."
mkdir -p /etc/caddy

if [[ -f /opt/yt/caddy/Caddyfile ]] && ! grep -q "CADDY_SITE_ADDRESS" /opt/yt/caddy/Caddyfile; then
  # The repo file has the real address — move it
  cp /opt/yt/caddy/Caddyfile /etc/caddy/Caddyfile
  echo "  Copied deployed Caddyfile to /etc/caddy/"
else
  echo "  /opt/yt/caddy/Caddyfile still has placeholders — generating from template..."
  CUSTOM_DOMAIN=$(cat /etc/customdomain 2>/dev/null | tr -d '[:space:]' || true)
  if [[ -n "$CUSTOM_DOMAIN" ]]; then
    SITE_ADDRESS="$CUSTOM_DOMAIN"
  else
    NAME_PREFIX=$(cat /etc/nameprefix 2>/dev/null | tr -d '[:space:]')
    REGION=$(curl -s -H Metadata:true --noproxy "*" \
      "http://169.254.169.254/metadata/instance/compute/location?api-version=2021-02-01&format=text" 2>/dev/null || true)
    if [[ -n "$NAME_PREFIX" && -n "$REGION" ]]; then
      SITE_ADDRESS="${NAME_PREFIX}.${REGION}.cloudapp.azure.com"
    else
      SITE_ADDRESS=":80"
    fi
  fi
  sed "s/CADDY_SITE_ADDRESS/${SITE_ADDRESS}/g" /opt/yt/caddy/Caddyfile > /etc/caddy/Caddyfile
fi
chmod 644 /etc/caddy/Caddyfile

# Restore the template in the repo
git -C /opt/yt checkout -- caddy/Caddyfile

# --- Update systemd units to point at /etc/ paths ---
echo "Updating systemd units..."
install -m 644 /opt/yt/systemd/blobfuse2.mount /etc/systemd/system/mnt-blobfuse2.mount
install -m 644 /opt/yt/systemd/caddy.service /etc/systemd/system/caddy.service
systemctl daemon-reload

# --- Restart affected services ---
echo "Restarting caddy and remounting blobfuse2..."
systemctl restart caddy
systemctl restart mnt-blobfuse2.mount

# --- Install update script ---
echo "Installing update script..."
install -m 755 /opt/yt/scripts/update.sh /usr/local/bin/yt-update.sh

echo ""
echo "=== Migration complete ==="
echo "  /etc/blobfuse2/blobfuse2.yaml — deployment-specific, survives git pull"
echo "  /etc/caddy/Caddyfile           — deployment-specific, survives git pull"
echo "  Repo files restored to templates — git status should be clean"
