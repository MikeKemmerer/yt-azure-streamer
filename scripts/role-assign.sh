#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <resource-group> <namePrefix>"
  exit 1
fi

RG="$1"
PREFIX="$2"

AA="${PREFIX}-automation"
VM="${PREFIX}-vm"

echo "Fetching VM managed identity principalId..."
MI=$(az vm show \
  --resource-group "$RG" \
  --name "$VM" \
  --query identity.principalId \
  -o tsv)

if [[ -z "$MI" ]]; then
  echo "ERROR: VM has no system-assigned managed identity enabled."
  exit 1
fi

echo "Fetching Automation Account resource ID..."
AA_ID=$(az automation account show \
  --resource-group "$RG" \
  --name "$AA" \
  --query id \
  -o tsv)

if [[ -z "$AA_ID" ]]; then
  echo "ERROR: Automation Account '$AA' not found in resource group '$RG'."
  exit 1
fi

echo "Assigning 'Automation Contributor' role to VM identity on Automation Account scope..."
az role assignment create \
  --assignee "$MI" \
  --role "Automation Contributor" \
  --scope "$AA_ID"

echo "Done. VM identity can now manage Automation schedules/runbooks."
