#!/usr/bin/env bash
# setup-caddy-auth.sh — Fetches web UI credentials from Key Vault and
# configures Caddy basic auth.  Designed to run as a oneshot service
# triggered by a timer, retrying until secrets are available (they are
# written by deploy.sh AFTER the ARM deployment completes, so cloud-init
# cannot read them during initial boot).

set -euo pipefail

PREFIX=$(cat /etc/nameprefix 2>/dev/null | tr -d '[:space:]')
KV_NAME="${PREFIX,,}-kv"

# Already configured?
if [[ -f /etc/caddy/auth.conf ]] && grep -q "basic_auth" /etc/caddy/auth.conf 2>/dev/null; then
  echo "Caddy auth already configured, nothing to do."
  exit 0
fi

# Ensure we're logged in with managed identity
az login --identity >/dev/null 2>&1 || { echo "Failed to authenticate with managed identity"; exit 1; }

WEB_USER=$(az keyvault secret show --vault-name "$KV_NAME" --name "web-ui-user" --query value -o tsv 2>/dev/null) || true
WEB_PASS=$(az keyvault secret show --vault-name "$KV_NAME" --name "web-ui-password" --query value -o tsv 2>/dev/null) || true

if [[ -z "$WEB_USER" || -z "$WEB_PASS" ]]; then
  echo "Secrets not yet available in Key Vault. Will retry on next timer tick."
  exit 1
fi

# Generate bcrypt hash and write Caddy auth snippet
HASH=$(caddy hash-password --plaintext "$WEB_PASS")
mkdir -p /etc/caddy
cat > /etc/caddy/auth.conf <<EOF
basic_auth {
  ${WEB_USER} ${HASH}
}
EOF
chmod 600 /etc/caddy/auth.conf
echo "Web UI authentication configured for user: $WEB_USER"

# Reload Caddy to pick up the new auth config
systemctl reload caddy.service 2>/dev/null || systemctl restart caddy.service 2>/dev/null || true
echo "Caddy reloaded with authentication enabled."
