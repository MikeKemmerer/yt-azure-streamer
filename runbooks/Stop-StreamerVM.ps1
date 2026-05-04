<#
.SYNOPSIS
    Deallocates (stops billing for) the streaming VM.
.DESCRIPTION
    Triggered by an Azure Automation schedule (2 minutes after stream end).
    Deallocation stops compute billing. The streamer.service has already been
    stopped gracefully by the scheduler before this fires.
    Uses the REST API with managed identity to avoid Az module dependency issues.
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$ResourceGroupName,

    [Parameter(Mandatory = $true)]
    [string]$VMName
)

$ErrorActionPreference = 'Stop'

# Acquire token via Automation system-assigned managed identity
$resource = "https://management.azure.com/"
$url = "$($env:IDENTITY_ENDPOINT)?resource=$resource&api-version=2019-08-01"
$headers = @{ 'X-IDENTITY-HEADER' = $env:IDENTITY_HEADER }
$response = Invoke-RestMethod -Uri $url -Headers $headers -Method Get
$token = $response.access_token

$subscriptionId = (Invoke-RestMethod -Uri "https://management.azure.com/subscriptions?api-version=2022-12-01" `
    -Headers @{ Authorization = "Bearer $token" }).value[0].subscriptionId

$deallocateUri = "https://management.azure.com/subscriptions/$subscriptionId/resourceGroups/$ResourceGroupName/providers/Microsoft.Compute/virtualMachines/$VMName/deallocate?api-version=2024-03-01"

Write-Output "Deallocating VM '$VMName' in resource group '$ResourceGroupName'..."
Invoke-RestMethod -Method Post -Uri $deallocateUri -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json'
Write-Output "Deallocate request sent."
