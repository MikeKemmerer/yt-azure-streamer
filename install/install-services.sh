#!/usr/bin/env bash
set -euo pipefail

# Master installer for yt-azure-streamer
# Runs inside the VM via cloud-init after repo clone to /opt/yt.
# Installs all packages, configures blobfuse2, deploys scripts/units,
# and enables all services.

echo "=== yt-azure-streamer installer ==="

PREFIX=$(cat /etc/nameprefix)
RG=$(cat /etc/resourcegroup)
echo "Prefix: $PREFIX  Resource Group: $RG"

# --- Package Repositories ---

echo "Installing prerequisites..."
DEBIAN_FRONTEND=noninteractive apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gpg lsb-release

echo "Adding Caddy apt repository..."
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list

echo "Adding Microsoft apt repository..."
curl -sL https://packages.microsoft.com/keys/microsoft.asc \
  | gpg --dearmor -o /usr/share/keyrings/microsoft-archive-keyring.gpg
DISTRO=$(lsb_release -cs)
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/microsoft-archive-keyring.gpg] https://packages.microsoft.com/repos/azure-cli/ $DISTRO main" \
  | tee /etc/apt/sources.list.d/azure-cli.list
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/microsoft-archive-keyring.gpg] https://packages.microsoft.com/repos/microsoft-ubuntu-$DISTRO-prod $DISTRO main" \
  | tee /etc/apt/sources.list.d/microsoft-prod.list

echo "Updating package lists..."
apt-get update

echo "Installing packages..."
DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs npm ffmpeg fuse3 caddy blobfuse2 azure-cli

# Disable the default apt-installed caddy service; we use our own unit
systemctl stop caddy.service 2>/dev/null || true
systemctl disable caddy.service 2>/dev/null || true

# --- Blobfuse2 Configuration ---

echo "Configuring blobfuse2..."
STORAGE_NAME="${PREFIX,,}"  # lowercase
sed -i "s/STORAGE_ACCOUNT/${STORAGE_NAME}/g" /opt/yt/blobfuse2/blobfuse2.yaml

mkdir -p /mnt/blobfuse2
mkdir -p /mnt/blobfuse2_cache

# --- Caddy / TLS Configuration ---

CUSTOM_DOMAIN=$(cat /etc/customdomain 2>/dev/null | tr -d '[:space:]')
if [[ -n "$CUSTOM_DOMAIN" ]]; then
  echo "Custom domain: $CUSTOM_DOMAIN — Caddy will auto-provision Let's Encrypt TLS"
  sed -i "s/CADDY_SITE_ADDRESS/${CUSTOM_DOMAIN}/g" /opt/yt/caddy/Caddyfile
else
  echo "No custom domain — serving plain HTTP on :80"
  sed -i "s/CADDY_SITE_ADDRESS/:80/g" /opt/yt/caddy/Caddyfile
fi

# --- Install Scripts ---

echo "Installing service scripts into /usr/local/bin..."
install -m 755 /opt/yt/services/streamer/streamer.sh  /usr/local/bin/streamer.sh
install -m 755 /opt/yt/services/scheduler/scheduler.sh /usr/local/bin/scheduler.sh
install -m 755 /opt/yt/scripts/schedule-sync.sh        /usr/local/bin/schedule-sync.sh
install -m 755 /opt/yt/scripts/generate-playlist.sh    /usr/local/bin/generate-playlist.sh

# schedule.json ships with the repo at /opt/yt/schedule.json — edit to customise stream times
echo "Schedule template at /opt/yt/schedule.json — edit to customise."

# --- Install Systemd Units ---

echo "Installing systemd units..."
install -m 644 /opt/yt/systemd/streamer.service        /etc/systemd/system/streamer.service
install -m 644 /opt/yt/systemd/scheduler.service       /etc/systemd/system/scheduler.service
install -m 644 /opt/yt/systemd/schedule-sync.service   /etc/systemd/system/schedule-sync.service
install -m 644 /opt/yt/systemd/schedule-sync.timer     /etc/systemd/system/schedule-sync.timer
install -m 644 /opt/yt/systemd/caddy.service           /etc/systemd/system/caddy.service
install -m 644 /opt/yt/systemd/web-backend.service     /etc/systemd/system/web-backend.service
# Mount unit name must match Where= path: /mnt/blobfuse2 → mnt-blobfuse2.mount
install -m 644 /opt/yt/systemd/blobfuse2.mount         /etc/systemd/system/mnt-blobfuse2.mount

# --- Enable & Start Services ---

echo "Reloading systemd..."
systemctl daemon-reload

echo "Enabling services..."
systemctl enable streamer.service
systemctl enable scheduler.service
systemctl enable schedule-sync.timer
systemctl enable caddy.service
systemctl enable web-backend.service
systemctl enable mnt-blobfuse2.mount

echo "Starting services..."
systemctl start mnt-blobfuse2.mount
systemctl start web-backend.service
systemctl start caddy.service
systemctl start schedule-sync.timer

# --- Deploy Automation Runbooks ---

echo "Deploying Automation runbooks..."
AA="${PREFIX}-automation"

az login --identity >/dev/null 2>&1

for RUNBOOK in Start-StreamerVM Stop-StreamerVM; do
  RUNBOOK_FILE="/opt/yt/runbooks/${RUNBOOK}.ps1"
  DEPLOYED=false

  for attempt in $(seq 1 10); do
    # Create runbook if it doesn't already exist
    if az automation runbook show \
        --resource-group "$RG" \
        --automation-account-name "$AA" \
        --name "$RUNBOOK" >/dev/null 2>&1 \
      || az automation runbook create \
        --resource-group "$RG" \
        --automation-account-name "$AA" \
        --name "$RUNBOOK" \
        --type "PowerShell" \
        --description "Manages the streamer VM lifecycle" >/dev/null 2>&1; then

      az automation runbook replace-content \
        --resource-group "$RG" \
        --automation-account-name "$AA" \
        --name "$RUNBOOK" \
        --content "@${RUNBOOK_FILE}" >/dev/null

      az automation runbook publish \
        --resource-group "$RG" \
        --automation-account-name "$AA" \
        --name "$RUNBOOK" >/dev/null

      echo "  Runbook $RUNBOOK deployed."
      DEPLOYED=true
      break
    fi

    echo "  Waiting for RBAC propagation (attempt $attempt/10)..."
    sleep 30
  done

  if [[ "$DEPLOYED" != "true" ]]; then
    echo "  WARNING: Could not deploy runbook $RUNBOOK. Re-run install-services.sh after role propagation."
  fi
done

echo "=== Installation complete ==="
