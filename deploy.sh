#!/usr/bin/env bash
set -euo pipefail

# Zero-touch deployment script for yt-azure-streamer.
# Prompts for required parameters (or reads from .deploy-config.json),
# runs pre-flight checks, deploys the ARM template, and sets the
# YouTube stream key in Key Vault.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/.deploy-config.json"
ARM_TEMPLATE="${SCRIPT_DIR}/arm/azuredeploy.json"

# Colours for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No colour

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
fatal() { error "$@"; exit 1; }

# ─── Load config defaults ───────────────────────────────────────────

cfg_get() {
  # Read a key from .deploy-config.json, return empty string if missing
  local key="$1"
  if [[ -f "$CONFIG_FILE" ]]; then
    python3 - "$CONFIG_FILE" "$key" <<'PYEOF' 2>/dev/null || true
import json, sys
try:
  cfg = json.load(open(sys.argv[1]))
  print(cfg.get(sys.argv[2], ''))
except: pass
PYEOF
  fi
}

cfg_save() {
  # Save current config values to .deploy-config.json
  python3 - "$NAME_PREFIX" "$REGION" "$SSH_KEY_PATH" "$CUSTOM_DOMAIN" "$CONFIG_FILE" <<'PYEOF'
import json, sys
namePrefix, region, sshKeyPath, customDomain, configFile = sys.argv[1:6]
cfg = {
  'namePrefix': namePrefix,
  'region': region,
  'sshKeyPath': sshKeyPath,
  'customDomain': customDomain,
}
with open(configFile, 'w') as f:
  json.dump(cfg, f, indent=2)
  f.write('\n')
print('Config saved to ' + configFile)
PYEOF
}

prompt() {
  # prompt VARNAME "Question text" "default"
  local varname="$1" question="$2" default="${3:-}"
  local input
  if [[ -n "$default" ]]; then
    read -rp "$(echo -e "${CYAN}?${NC} ${question} [${default}]: ")" input
    printf -v "$varname" '%s' "${input:-$default}"
  else
    while true; do
      read -rp "$(echo -e "${CYAN}?${NC} ${question}: ")" input
      if [[ -n "$input" ]]; then
        printf -v "$varname" '%s' "$input"
        break
      fi
      warn "This field is required."
    done
  fi
}

# ─── Pre-flight: az CLI ─────────────────────────────────────────────

info "Checking prerequisites..."

if ! command -v az &>/dev/null; then
  warn "Azure CLI (az) is not installed."
  echo ""
  echo "  [1] Install automatically (recommended — uses the official Microsoft install script)"
  echo "  [2] I'll install it myself (opens docs link)"
  echo ""
  read -rp "$(echo -e "${CYAN}?${NC} Choose [1/2]: ")" AZ_INSTALL_CHOICE
  case "${AZ_INSTALL_CHOICE}" in
    1)
      info "Installing Azure CLI via https://aka.ms/InstallAzureCLIDeb ..."
      if ! command -v curl &>/dev/null; then
        info "Installing curl first..."
        if ! { sudo apt-get update -y && sudo apt-get install -y curl; }; then
          fatal "Failed to install curl."
        fi
      fi
      curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash || fatal "Azure CLI installation failed."
      # Verify it's now available
      if ! command -v az &>/dev/null; then
        fatal "Azure CLI still not found after installation. Try restarting your shell."
      fi
      ok "Azure CLI installed successfully."
      ;;
    *)
      echo ""
      echo "  Install instructions: https://learn.microsoft.com/en-us/cli/azure/install-azure-cli-linux"
      echo "  Re-run this script after installing."
      exit 0
      ;;
  esac
fi
ok "Azure CLI found: $(az version --query '"azure-cli"' -o tsv 2>/dev/null)"

if ! command -v python3 &>/dev/null; then
  warn "python3 is not installed."
  echo ""
  echo "  [1] Install automatically (via apt)"
  echo "  [2] I'll install it myself"
  echo ""
  read -rp "$(echo -e "${CYAN}?${NC} Choose [1/2]: ")" PY_INSTALL_CHOICE
  case "${PY_INSTALL_CHOICE}" in
    1)
      info "Installing python3..."
      if ! { sudo apt-get update -y && sudo apt-get install -y python3; }; then
        fatal "Failed to install python3."
      fi
      if ! command -v python3 &>/dev/null; then
        fatal "python3 still not found after installation."
      fi
      ok "python3 installed successfully."
      ;;
    *)
      echo ""
      echo "  Install python3 with your package manager, then re-run this script."
      exit 0
      ;;
  esac
fi
ok "python3 found: $(python3 --version 2>/dev/null)"

# ─── Pre-flight: Azure login ────────────────────────────────────────

if ! az account show &>/dev/null; then
  warn "Not logged in to Azure. Opening login..."
  # Use device code flow when there's no usable display (WSL, SSH, headless, containers)
  if [[ -z "${DISPLAY:-}" && -z "${WAYLAND_DISPLAY:-}" ]] \
     || grep -qi microsoft /proc/version 2>/dev/null \
     || [[ -f /.dockerenv ]] \
     || ! command -v xdg-open &>/dev/null; then
    info "No GUI detected — using device code flow."
    az login --use-device-code || fatal "Azure login failed."
  else
    az login || fatal "Azure login failed."
  fi
fi

ACCOUNT_NAME=$(az account show --query name -o tsv) || fatal "Failed to retrieve account info. Try 'az login' first."
ACCOUNT_ID=$(az account show --query id -o tsv) || fatal "Failed to retrieve account info. Try 'az login' first."
ok "Logged in: ${ACCOUNT_NAME} (${ACCOUNT_ID})"

# ─── Pre-flight: Subscription selection ─────────────────────────────

SUB_COUNT=$(az account list --query "length([])" -o tsv) || fatal "Failed to list subscriptions."
if [[ "$SUB_COUNT" -gt 1 ]]; then
  echo ""
  info "Multiple subscriptions found:"
  az account list --query "[].{Name:name, ID:id, Default:isDefault}" -o table
  echo ""
  read -rp "$(echo -e "${CYAN}?${NC} Use current subscription (${ACCOUNT_NAME})? [Y/n]: ")" USE_CURRENT
  if [[ "${USE_CURRENT,,}" == "n" ]]; then
    prompt SUB_ID "Enter subscription ID to use"
    az account set --subscription "$SUB_ID" || fatal "Failed to set subscription."
    ACCOUNT_NAME=$(az account show --query name -o tsv) || fatal "Failed to retrieve account info after subscription switch."
    ACCOUNT_ID=$(az account show --query id -o tsv) || fatal "Failed to retrieve account info after subscription switch."
    ok "Switched to: ${ACCOUNT_NAME} (${ACCOUNT_ID})"
  fi
fi

# ─── Get deployer object ID ─────────────────────────────────────────

DEPLOYER_OID=$(az ad signed-in-user show --query id -o tsv 2>/dev/null || true)
if [[ -n "$DEPLOYER_OID" ]]; then
  ok "Deployer Object ID: ${DEPLOYER_OID}"
else
  warn "Could not determine deployer Object ID (service principal login?)."
  warn "You may need to manually grant Key Vault Secrets Officer to write the stream key."
  DEPLOYER_OID=""
fi

# ─── Prompt: namePrefix ─────────────────────────────────────────────

echo ""
info "=== Deployment Parameters ==="
echo ""

DEFAULT_PREFIX=$(cfg_get namePrefix)
while true; do
  prompt NAME_PREFIX "Name prefix (alphanumeric, 3-20 chars, globally unique)" "$DEFAULT_PREFIX"

  # Validate format
  if [[ ! "$NAME_PREFIX" =~ ^[a-zA-Z0-9]{3,20}$ ]]; then
    error "Prefix must be 3-20 alphanumeric characters (no hyphens or underscores)."
    continue
  fi

  # Check storage account name availability
  info "Checking name availability..."
  STORAGE_NAME="${NAME_PREFIX,,}"
  AVAIL=$(az storage account check-name-availability --name "$STORAGE_NAME" --query nameAvailable -o tsv 2>/dev/null || echo "unknown")
  if [[ "$AVAIL" == "false" ]]; then
    REASON=$(az storage account check-name-availability --name "$STORAGE_NAME" --query reason -o tsv 2>/dev/null) || true
    error "Storage account name '${STORAGE_NAME}' is not available: ${REASON}"
    error "Try a different prefix."
    continue
  fi

  # Check for soft-deleted Key Vault with same name
  KV_NAME="${NAME_PREFIX,,}-kv"
  DELETED_KV=$(az keyvault list-deleted --query "[?name=='${KV_NAME}'].name" -o tsv 2>/dev/null || true)
  if [[ -n "$DELETED_KV" ]]; then
    warn "A soft-deleted Key Vault named '${KV_NAME}' exists."
    read -rp "$(echo -e "${CYAN}?${NC} Purge it to reuse the name? [Y/n]: ")" PURGE_KV
    if [[ "${PURGE_KV,,}" != "n" ]]; then
      info "Purging deleted Key Vault '${KV_NAME}'..."
      az keyvault purge --name "$KV_NAME" 2>/dev/null || fatal "Failed to purge Key Vault. You may need Owner permissions."
      ok "Purged."
    else
      error "Cannot create Key Vault with that name. Try a different prefix."
      continue
    fi
  fi

  ok "Name '${NAME_PREFIX}' is available."
  break
done

# ─── Prompt: Region ─────────────────────────────────────────────────

DEFAULT_REGION=$(cfg_get region)
[[ -z "$DEFAULT_REGION" ]] && DEFAULT_REGION="eastus2"

while true; do
  prompt REGION "Azure region" "$DEFAULT_REGION"

  # Validate region exists
  VALID_REGION=$(az account list-locations --query "[?name=='${REGION}'].name" -o tsv 2>/dev/null) || true
  if [[ -z "$VALID_REGION" ]]; then
    error "Invalid region '${REGION}'. Run 'az account list-locations -o table' for valid names."
    continue
  fi

  # Check VM SKU availability
  info "Checking Standard_F2s_v2 availability in ${REGION}..."
  SKU_EXISTS=$(az vm list-skus --location "$REGION" --resource-type virtualMachines \
    --query "[?name=='Standard_F2s_v2'].name | [0]" -o tsv 2>/dev/null) || true
  if [[ -z "$SKU_EXISTS" ]]; then
    error "Standard_F2s_v2 is not available in '${REGION}' (or could not be verified). Choose a different region."
    continue
  fi
  ok "VM SKU available in ${REGION}."

  # Check Automation Account availability
  info "Checking Automation Account availability in ${REGION}..."
  REGION_DISPLAY=$(az account list-locations --query "[?name=='${REGION}'].displayName | [0]" -o tsv 2>/dev/null) || true
  if [[ -n "$REGION_DISPLAY" ]]; then
    AA_AVAILABLE=$(az provider show -n Microsoft.Automation \
      --query "resourceTypes[?resourceType=='automationAccounts'].locations[] | [?contains(@, '${REGION_DISPLAY}')] | [0]" \
      -o tsv 2>/dev/null) || true
  else
    AA_AVAILABLE=""
  fi
  if [[ -z "$AA_AVAILABLE" ]]; then
    warn "Could not confirm Automation Account availability in '${REGION}'. Deployment may fail if unsupported."
  else
    ok "Automation Account available in ${REGION}."
  fi

  break
done

# ─── Prompt: SSH key ────────────────────────────────────────────────

DEFAULT_SSH_PATH=$(cfg_get sshKeyPath)
[[ -z "$DEFAULT_SSH_PATH" ]] && DEFAULT_SSH_PATH="$HOME/.ssh/id_ed25519.pub"

prompt SSH_KEY_PATH "SSH public key path" "$DEFAULT_SSH_PATH"

if [[ ! -f "$SSH_KEY_PATH" ]]; then
  PRIVATE_KEY="${SSH_KEY_PATH%.pub}"
  warn "SSH key not found at '${SSH_KEY_PATH}'."
  read -rp "$(echo -e "${CYAN}?${NC} Generate a new key pair at ${PRIVATE_KEY}? [Y/n]: ")" GEN_KEY
  if [[ "${GEN_KEY,,}" != "n" ]]; then
    ssh-keygen -t ed25519 -C "yt-streamer" -f "$PRIVATE_KEY" -N "" || fatal "SSH key generation failed."
    ok "Generated ${SSH_KEY_PATH}"
  else
    fatal "SSH public key is required. Provide a valid path."
  fi
fi

SSH_PUBLIC_KEY=$(cat "$SSH_KEY_PATH") || fatal "Could not read SSH public key from '${SSH_KEY_PATH}'."
ok "SSH key loaded (${#SSH_PUBLIC_KEY} chars)"

# ─── Prompt: YouTube stream key ─────────────────────────────────────

echo ""
read -rsp "$(echo -e "${CYAN}?${NC} YouTube stream key (hidden; press Enter to skip and set later): ")" STREAM_KEY
echo ""
if [[ -n "$STREAM_KEY" ]]; then
  ok "Stream key provided (will be stored in Key Vault after deployment)."
else
  warn "No stream key provided. You can set it later with:"
  echo "    az keyvault secret set --vault-name ${KV_NAME} --name youtube-stream-key --value <KEY>"
fi

# ─── Prompt: Web UI credentials ─────────────────────────────────────

echo ""
info "The web management UI uses HTTP basic auth."
info "Set a username and password now, or skip and configure later."
echo ""
read -rp "$(echo -e "${CYAN}?${NC} Web UI username (press Enter to skip): ")" WEB_UI_USER
if [[ -n "$WEB_UI_USER" ]]; then
  while true; do
    read -rsp "$(echo -e "${CYAN}?${NC} Web UI password (hidden): ")" WEB_UI_PASS
    echo ""
    if [[ -z "$WEB_UI_PASS" ]]; then
      warn "Password cannot be empty."
      continue
    fi
    read -rsp "$(echo -e "${CYAN}?${NC} Confirm password: ")" WEB_UI_PASS2
    echo ""
    if [[ "$WEB_UI_PASS" != "$WEB_UI_PASS2" ]]; then
      warn "Passwords do not match. Try again."
      continue
    fi
    break
  done
  ok "Web UI credentials set (will be stored in Key Vault after deployment)."
else
  WEB_UI_PASS=""
  warn "No web UI credentials set. You can add them later in Key Vault:"
  echo "    az keyvault secret set --vault-name ${KV_NAME} --name web-ui-user --value <USER>"
  echo "    az keyvault secret set --vault-name ${KV_NAME} --name web-ui-password --value <PASS>"
fi

# ─── Prompt: Custom domain ──────────────────────────────────────────

DEFAULT_DOMAIN=$(cfg_get customDomain)
read -rp "$(echo -e "${CYAN}?${NC} Custom domain for TLS (press Enter to skip): [${DEFAULT_DOMAIN}] ")" CUSTOM_DOMAIN
CUSTOM_DOMAIN="${CUSTOM_DOMAIN:-$DEFAULT_DOMAIN}"

if [[ -n "$CUSTOM_DOMAIN" ]]; then
  ok "Custom domain: ${CUSTOM_DOMAIN} (Caddy will auto-provision Let's Encrypt)"
else
  ok "No custom domain — plain HTTP on Azure DNS"
fi

# ─── Derive remaining values ────────────────────────────────────────

REPO_URL=$(git -C "$SCRIPT_DIR" remote get-url origin 2>/dev/null || true)
if [[ -z "$REPO_URL" ]]; then
  fatal "Could not determine repoUrl from git remote. Are you in the cloned repo?"
fi
# Convert SSH URL to HTTPS if needed (cloud-init needs HTTPS for unauthenticated clone)
if [[ "$REPO_URL" == git@* ]]; then
  REPO_URL="${REPO_URL/git@github.com:/https://github.com/}"
fi
ok "Repo URL: ${REPO_URL}"

RG_NAME="${NAME_PREFIX}-rg"

# ─── Save config ────────────────────────────────────────────────────

cfg_save

# ─── Summary ────────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${CYAN}Deployment Summary${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Name prefix:     ${NAME_PREFIX}"
echo "  Resource group:  ${RG_NAME}"
echo "  Region:          ${REGION}"
echo "  VM SKU:          Standard_F2s_v2"
echo "  SSH key:         ${SSH_KEY_PATH}"
echo "  Repo URL:        ${REPO_URL}"
echo "  Custom domain:   ${CUSTOM_DOMAIN:-none}"
if [[ -n "$STREAM_KEY" ]]; then
  echo "  Stream key:      provided"
else
  echo "  Stream key:      not set (set later)"
fi
if [[ -n "$WEB_UI_USER" ]]; then
  echo "  Web UI creds:    ${WEB_UI_USER} / ********"
else
  echo "  Web UI creds:    not set (set later)"
fi
echo "  Deployer OID:    ${DEPLOYER_OID:-not available}"
echo ""
echo "  Resources:"
echo "    Storage:       ${NAME_PREFIX,,}"
echo "    Key Vault:     ${KV_NAME}"
echo "    Automation:    ${NAME_PREFIX}-automation"
echo "    VM:            ${NAME_PREFIX}-vm"
DNS_NAME="${NAME_PREFIX,,}.${REGION}.cloudapp.azure.com"
echo "    DNS:           ${DNS_NAME}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

read -rp "$(echo -e "${CYAN}?${NC} Proceed with deployment? [Y/n]: ")" PROCEED
if [[ "${PROCEED,,}" == "n" ]]; then
  info "Deployment cancelled."
  exit 0
fi

# ─── Deploy ─────────────────────────────────────────────────────────

echo ""
info "Creating resource group '${RG_NAME}' in '${REGION}'..."
az group create --name "$RG_NAME" --location "$REGION" -o none || fatal "Failed to create resource group '${RG_NAME}'."

info "Deploying ARM template (this takes ~10-15 minutes)..."
DEPLOY_PARAMS=(
  --resource-group "$RG_NAME"
  --template-file "$ARM_TEMPLATE"
  --parameters
    "namePrefix=${NAME_PREFIX}"
    "adminPublicKey=${SSH_PUBLIC_KEY}"
    "repoUrl=${REPO_URL}"
)

if [[ -n "$CUSTOM_DOMAIN" ]]; then
  DEPLOY_PARAMS+=("customDomain=${CUSTOM_DOMAIN}")
fi

if [[ -n "$DEPLOYER_OID" ]]; then
  DEPLOY_PARAMS+=("deployerObjectId=${DEPLOYER_OID}")
fi

az deployment group create "${DEPLOY_PARAMS[@]}" -o none || fatal "ARM deployment failed."

ok "ARM deployment complete!"

# ─── Post-deploy: Set stream key in Key Vault ───────────────────────

if [[ -n "$STREAM_KEY" ]]; then
  info "Setting YouTube stream key in Key Vault '${KV_NAME}'..."
  # RBAC propagation can take up to 5 minutes; retry with backoff
  for attempt in {1..10}; do
    if az keyvault secret set \
        --vault-name "$KV_NAME" \
        --name "youtube-stream-key" \
        --value "$STREAM_KEY" \
        -o none 2>/dev/null; then
      ok "Stream key stored in Key Vault."
      break
    fi
    if [[ $attempt -eq 10 ]]; then
      warn "Could not write stream key after 10 attempts."
      warn "RBAC may still be propagating. Run manually:"
      echo "    az keyvault secret set --vault-name ${KV_NAME} --name youtube-stream-key --value <KEY>"
      break
    fi
    warn "Waiting for Key Vault RBAC propagation (attempt ${attempt}/10)..."
    sleep 30
  done
fi

# ─── Post-deploy: Set web UI credentials in Key Vault ────────────────

if [[ -n "$WEB_UI_USER" && -n "$WEB_UI_PASS" ]]; then
  info "Setting web UI credentials in Key Vault '${KV_NAME}'..."
  for attempt in {1..10}; do
    if az keyvault secret set \
        --vault-name "$KV_NAME" \
        --name "web-ui-user" \
        --value "$WEB_UI_USER" \
        -o none 2>/dev/null && \
       az keyvault secret set \
        --vault-name "$KV_NAME" \
        --name "web-ui-password" \
        --value "$WEB_UI_PASS" \
        -o none 2>/dev/null; then
      ok "Web UI credentials stored in Key Vault."
      break
    fi
    if [[ $attempt -eq 10 ]]; then
      warn "Could not write web UI credentials after 10 attempts."
      warn "Set them manually:"
      echo "    az keyvault secret set --vault-name ${KV_NAME} --name web-ui-user --value <USER>"
      echo "    az keyvault secret set --vault-name ${KV_NAME} --name web-ui-password --value <PASS>"
      break
    fi
    warn "Waiting for Key Vault RBAC propagation (attempt ${attempt}/10)..."
    sleep 30
  done
fi

# ─── Post-deploy: Summary ───────────────────────────────────────────

VM_IP=$(az vm show -d --resource-group "$RG_NAME" --name "${NAME_PREFIX}-vm" --query publicIps -o tsv 2>/dev/null || true)

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}Deployment Complete!${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
if [[ -n "$CUSTOM_DOMAIN" ]]; then
  echo "  Web UI:    https://${CUSTOM_DOMAIN}"
else
  echo "  Web UI:    http://${DNS_NAME}"
fi
echo "  SSH:       ssh azureuser@${VM_IP:-${DNS_NAME}}"
echo ""
echo "  Cloud-init is still running on the VM (~10 min)."
echo "  Check progress:"
echo "    ssh azureuser@${VM_IP:-${DNS_NAME}} tail -f /var/log/cloud-init-output.log"
echo ""
if [[ -z "$STREAM_KEY" ]]; then
  echo "  Set your YouTube stream key:"
  echo "    az keyvault secret set --vault-name ${KV_NAME} --name youtube-stream-key --value <KEY>"
  echo ""
fi
if [[ -z "$WEB_UI_USER" ]]; then
  echo "  Set web UI credentials:"
  echo "    az keyvault secret set --vault-name ${KV_NAME} --name web-ui-user --value <USER>"
  echo "    az keyvault secret set --vault-name ${KV_NAME} --name web-ui-password --value <PASS>"
  echo ""
fi
echo "  Upload videos to blob storage:"
echo "    az storage blob upload-batch --account-name ${NAME_PREFIX,,} --destination recordings --source /path/to/videos/ --auth-mode login"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
