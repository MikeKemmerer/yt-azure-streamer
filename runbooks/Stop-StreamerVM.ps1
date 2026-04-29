<#
.SYNOPSIS
    Deallocates (stops billing for) the streaming VM.
.DESCRIPTION
    Triggered by an Azure Automation schedule (2 minutes after stream end).
    Deallocation stops compute billing. The streamer.service has already been
    stopped gracefully by the scheduler before this fires.
    Authenticates using the Automation Account's system-assigned managed identity.
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$ResourceGroupName,

    [Parameter(Mandatory = $true)]
    [string]$VMName
)

Connect-AzAccount -Identity | Out-Null

Write-Output "Deallocating VM '$VMName' in resource group '$ResourceGroupName'..."
Stop-AzVM -ResourceGroupName $ResourceGroupName -Name $VMName -Force -NoWait
Write-Output "Deallocate request sent."
