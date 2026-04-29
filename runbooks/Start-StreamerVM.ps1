<#
.SYNOPSIS
    Starts the streaming VM.
.DESCRIPTION
    Triggered by an Azure Automation schedule (2 minutes before stream start).
    Authenticates using the Automation Account's system-assigned managed identity.
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$ResourceGroupName,

    [Parameter(Mandatory = $true)]
    [string]$VMName
)

Connect-AzAccount -Identity | Out-Null

Write-Output "Starting VM '$VMName' in resource group '$ResourceGroupName'..."
Start-AzVM -ResourceGroupName $ResourceGroupName -Name $VMName -NoWait
Write-Output "Start request sent."
