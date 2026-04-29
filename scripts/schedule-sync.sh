#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./schedule-sync.sh <resource-group> <namePrefix>
#
# This script runs inside the VM OR from your workstation.
# It updates Azure Automation schedules based on local config.

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <resource-group> <namePrefix>"
  exit 1
fi

RG="$1"
PREFIX="$2"
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
