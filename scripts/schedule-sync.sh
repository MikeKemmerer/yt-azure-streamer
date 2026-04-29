#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./schedule-sync.sh                          (reads from /etc config files)
#   ./schedule-sync.sh <resource-group> <namePrefix>   (CLI override)
#
# When run via systemd timer, uses 0-arg mode.
# When run manually from a workstation, pass both arguments.

if [[ $# -eq 0 ]]; then
  PREFIX=$(cat /etc/nameprefix)
  RG=$(cat /etc/resourcegroup)
elif [[ $# -eq 2 ]]; then
  RG="$1"
  PREFIX="$2"
else
  echo "Usage: $0 [<resource-group> <namePrefix>]"
  exit 1
fi
AA="${PREFIX}-automation"

echo "Logging in with managed identity (if inside VM)..."
az login --identity >/dev/null 2>&1 || true

echo "Fetching Automation Account ID..."
AA_ID=$(az automation account show \
  --resource-group "$RG" \
  --name "$AA" \
  --query id \
  -o tsv)

if [[ -z "$AA_ID" ]]; then
  echo "ERROR: Automation Account '$AA' not found."
  exit 1
fi

echo "Updating schedules..."
# Extend this with your real schedule logic
echo "(stub) schedule-sync executed for prefix: $PREFIX"
