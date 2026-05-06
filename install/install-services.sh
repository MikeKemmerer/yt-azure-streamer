#!/usr/bin/env bash
set -euo pipefail

# Master installer for yt-azure-streamer
# Runs inside the VM via cloud-init after repo clone to /opt/yt.
# Installs all packages, configures blobfuse2, deploys scripts/units,
# and enables all services.

echo "=== yt-azure-streamer installer ==="

PREFIX=$(cat /etc/yt/nameprefix)
RG=$(cat /etc/yt/resourcegroup)
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
DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs npm ffmpeg fuse3 caddy blobfuse2 azure-cli fonts-dejavu-core

# Disable the default apt-installed caddy service; we use our own unit
systemctl stop caddy.service 2>/dev/null || true
systemctl disable caddy.service 2>/dev/null || true

# --- Blobfuse2 Configuration ---

echo "Configuring blobfuse2..."
STORAGE_NAME="${PREFIX,,}"  # lowercase
mkdir -p /etc/yt/blobfuse2
sed "s/STORAGE_ACCOUNT/${STORAGE_NAME}/g" /opt/yt/blobfuse2/blobfuse2.yaml > /etc/yt/blobfuse2/blobfuse2.yaml
chmod 644 /etc/yt/blobfuse2/blobfuse2.yaml

mkdir -p /mnt/blobfuse2
mkdir -p /mnt/blobfuse2_cache

# --- Caddy / TLS Configuration ---

CUSTOM_DOMAIN=$(cat /etc/yt/customdomain 2>/dev/null | tr -d '[:space:]')
if [[ -n "$CUSTOM_DOMAIN" ]]; then
  echo "Custom domain: $CUSTOM_DOMAIN — Caddy will auto-provision Let's Encrypt TLS"
  SITE_ADDRESS="$CUSTOM_DOMAIN"
else
  # Auto-detect Azure DNS FQDN from instance metadata
  # Note: Azure DNS names (*.cloudapp.azure.com) cannot get Let's Encrypt certs,
  # so we serve plain HTTP when using the auto-detected name.
  NAME_PREFIX=$(cat /etc/yt/nameprefix 2>/dev/null | tr -d '[:space:]')
  REGION=$(curl -s -H Metadata:true --noproxy "*" \
    "http://169.254.169.254/metadata/instance/compute/location?api-version=2021-02-01&format=text" 2>/dev/null || true)
  if [[ -n "$NAME_PREFIX" && -n "$REGION" ]]; then
    SITE_ADDRESS="http://${NAME_PREFIX}-vm.${REGION}.cloudapp.azure.com"
    echo "No custom domain — using Azure DNS (plain HTTP): $SITE_ADDRESS"
  else
    SITE_ADDRESS=":80"
    echo "No custom domain and cannot detect Azure DNS — serving plain HTTP on :80"
  fi
fi
mkdir -p /etc/yt/caddy
sed "s|CADDY_SITE_ADDRESS|${SITE_ADDRESS}|g" /opt/yt/caddy/Caddyfile > /etc/yt/caddy/Caddyfile
chmod 644 /etc/yt/caddy/Caddyfile

# --- Caddy / Basic Auth ---

# Web UI credentials are written to Key Vault by deploy.sh AFTER the ARM
# deployment completes, so they won't be available during cloud-init.
# We write a no-auth placeholder now and let a systemd timer (caddy-auth-setup)
# retry until the secrets appear, then configure auth and reload Caddy.
echo "Web UI auth will be configured automatically once Key Vault secrets are available."
mkdir -p /etc/yt/caddy
echo "# No auth configured — caddy-auth-setup.timer will populate this" > /etc/yt/caddy/auth.conf

# --- Install Scripts ---

echo "Installing service scripts into /usr/local/bin..."
install -m 755 /opt/yt/services/streamer/streamer.sh  /usr/local/bin/streamer.sh
install -m 755 /opt/yt/services/scheduler/scheduler.sh /usr/local/bin/scheduler.sh
install -m 755 /opt/yt/scripts/schedule-sync.sh        /usr/local/bin/schedule-sync.sh
install -m 755 /opt/yt/scripts/generate-playlist.sh    /usr/local/bin/generate-playlist.sh
install -m 755 /opt/yt/scripts/setup-caddy-auth.sh     /usr/local/bin/setup-caddy-auth.sh
install -m 755 /opt/yt/scripts/update.sh               /usr/local/bin/yt-update.sh

# schedule.json ships with the repo — copy initial version to /etc/yt/
if [[ ! -f /etc/yt/schedule.json ]]; then
  cp /opt/yt/schedule.json /etc/yt/schedule.json
  echo "Initial schedule copied to /etc/yt/schedule.json"
fi

# --- Install Systemd Units ---

echo "Installing systemd units..."
install -m 644 /opt/yt/systemd/streamer.service        /etc/systemd/system/streamer.service
install -m 644 /opt/yt/systemd/scheduler.service       /etc/systemd/system/scheduler.service
install -m 644 /opt/yt/systemd/schedule-sync.service   /etc/systemd/system/schedule-sync.service
install -m 644 /opt/yt/systemd/schedule-sync.timer     /etc/systemd/system/schedule-sync.timer
install -m 644 /opt/yt/systemd/caddy.service           /etc/systemd/system/caddy.service
install -m 644 /opt/yt/systemd/caddy-auth-setup.service /etc/systemd/system/caddy-auth-setup.service
install -m 644 /opt/yt/systemd/caddy-auth-setup.timer  /etc/systemd/system/caddy-auth-setup.timer
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
systemctl enable caddy-auth-setup.timer
systemctl enable web-backend.service
systemctl enable mnt-blobfuse2.mount

echo "Starting services..."
systemctl start mnt-blobfuse2.mount
systemctl start web-backend.service
systemctl start caddy.service
systemctl start caddy-auth-setup.timer
systemctl start schedule-sync.timer

# --- Deploy Automation Runbooks ---

echo "Deploying Automation runbooks..."
AA="${PREFIX}-automation"

az login --identity >/dev/null 2>&1

SUB=$(az account show --query id -o tsv)

BASE_URL="/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Automation/automationAccounts/$AA"
LOCATION=$(az rest --method GET --url "$BASE_URL?api-version=2023-11-01" --query location -o tsv 2>/dev/null || echo "westus2")

for RUNBOOK in Start-StreamerVM Stop-StreamerVM; do
  RUNBOOK_FILE="/opt/yt/runbooks/${RUNBOOK}.ps1"
  DEPLOYED=false

  for attempt in $(seq 1 10); do
    # Create runbook via REST API
    if az rest --method PUT \
        --url "$BASE_URL/runbooks/${RUNBOOK}?api-version=2023-11-01" \
        --body "{\"properties\":{\"runbookType\":\"PowerShell\",\"description\":\"Manages the streamer VM lifecycle\",\"logProgress\":false,\"logVerbose\":false},\"location\":\"$LOCATION\"}" \
        >/dev/null 2>&1; then

      # Upload draft content
      az rest --method PUT \
        --url "$BASE_URL/runbooks/${RUNBOOK}/draft/content?api-version=2023-11-01" \
        --headers "Content-Type=text/powershell" \
        --body @"${RUNBOOK_FILE}" >/dev/null 2>&1

      # Publish runbook
      az rest --method POST \
        --url "$BASE_URL/runbooks/${RUNBOOK}/publish?api-version=2023-11-01" \
        >/dev/null 2>&1

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
