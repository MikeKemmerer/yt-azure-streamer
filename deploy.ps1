#Requires -Version 7.0
<#
.SYNOPSIS
    Zero-touch deployment script for yt-azure-streamer (PowerShell variant).
.DESCRIPTION
    Prompts for required parameters (or reads from .deploy-config.json),
    runs pre-flight checks, deploys the ARM template, and sets the
    YouTube stream key in Key Vault.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir = $PSScriptRoot
$ConfigFile = Join-Path $ScriptDir '.deploy-config.json'
$ArmTemplate = Join-Path $ScriptDir 'arm' 'azuredeploy.json'

# ─── Helpers ────────────────────────────────────────────────────────

function Write-Info  { param([string]$Msg) Write-Host "[INFO]  $Msg" -ForegroundColor Cyan }
function Write-Ok    { param([string]$Msg) Write-Host "[OK]    $Msg" -ForegroundColor Green }
function Write-Warn  { param([string]$Msg) Write-Host "[WARN]  $Msg" -ForegroundColor Yellow }
function Write-Err   { param([string]$Msg) Write-Host "[ERROR] $Msg" -ForegroundColor Red }
function Write-Fatal { param([string]$Msg) Write-Err $Msg; exit 1 }

function Get-ConfigValue {
    param([string]$Key)
    if (Test-Path $ConfigFile) {
        try {
            $cfg = Get-Content $ConfigFile -Raw | ConvertFrom-Json
            $val = $cfg.$Key
            if ($null -ne $val) { return [string]$val }
        } catch {}
    }
    return ''
}

function Save-Config {
    $cfg = @{
        namePrefix   = $script:NamePrefix
        region       = $script:Region
        sshKeyPath   = $script:SshKeyPath
        customDomain = $script:CustomDomain
    }
    $cfg | ConvertTo-Json -Depth 2 | Set-Content $ConfigFile -Encoding utf8
    Write-Host "Config saved to $ConfigFile"
}

function Read-Prompt {
    param(
        [string]$Question,
        [string]$Default = '',
        [switch]$Required,
        [switch]$Secret
    )
    while ($true) {
        if ($Secret) {
            $secStr = Read-Host -Prompt "? $Question (hidden; press Enter to skip)" -AsSecureString
            $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secStr)
            $val = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
            return $val
        }
        $prompt = if ($Default) { "? $Question [$Default]" } else { "? $Question" }
        $val = Read-Host -Prompt $prompt
        if ([string]::IsNullOrWhiteSpace($val)) { $val = $Default }
        if ([string]::IsNullOrWhiteSpace($val) -and $Required) {
            Write-Warn 'This field is required.'
            continue
        }
        return $val
    }
}

# ─── Pre-flight: az CLI ─────────────────────────────────────────────

Write-Info 'Checking prerequisites...'

$azPath = Get-Command az -ErrorAction SilentlyContinue
if (-not $azPath) {
    Write-Warn 'Azure CLI (az) is not installed.'
    Write-Host ''
    Write-Host '  [1] Install automatically via winget (recommended)'
    Write-Host '  [2] I''ll install it myself (opens docs link)'
    Write-Host ''
    $azChoice = Read-Prompt 'Choose' -Default '1'
    switch ($azChoice) {
        '1' {
            $wingetPath = Get-Command winget -ErrorAction SilentlyContinue
            if (-not $wingetPath) {
                Write-Fatal 'winget is not available. Install Azure CLI manually: https://learn.microsoft.com/en-us/cli/azure/install-azure-cli-windows'
            }
            Write-Info 'Installing Azure CLI via winget...'
            winget install --exact --id Microsoft.AzureCLI --accept-source-agreements --accept-package-agreements
            if ($LASTEXITCODE -ne 0) { Write-Fatal 'Azure CLI installation failed.' }
            # Refresh PATH so az is available in this session
            $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
            $azPath = Get-Command az -ErrorAction SilentlyContinue
            if (-not $azPath) {
                Write-Warn 'Azure CLI installed, but not yet visible in this session.'
                Write-Fatal 'Close and reopen your terminal, then re-run this script.'
            }
            Write-Ok 'Azure CLI installed successfully.'
        }
        default {
            Write-Host ''
            Write-Host '  Install instructions: https://learn.microsoft.com/en-us/cli/azure/install-azure-cli-windows'
            Write-Host '  Re-run this script after installing.'
            exit 0
        }
    }
}
$azVer = (az version 2>$null | ConvertFrom-Json).'azure-cli'
Write-Ok "Azure CLI found: $azVer"

# ─── Pre-flight: Azure login ────────────────────────────────────────

$acct = az account show 2>$null | ConvertFrom-Json -ErrorAction SilentlyContinue
if (-not $acct) {
    Write-Warn 'Not logged in to Azure. Opening login...'
    az login | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Fatal 'Azure login failed.' }
    $acct = az account show 2>$null | ConvertFrom-Json
}
$AccountName = $acct.name
$AccountId   = $acct.id
Write-Ok "Logged in: $AccountName ($AccountId)"

# ─── Pre-flight: Subscription selection ─────────────────────────────

$subs = az account list 2>$null | ConvertFrom-Json
if ($subs.Count -gt 1) {
    Write-Host ''
    Write-Info 'Multiple subscriptions found:'
    az account list --query "[].{Name:name, ID:id, Default:isDefault}" -o table
    Write-Host ''
    $useCurrent = Read-Prompt "Use current subscription ($AccountName)?" -Default 'Y'
    if ($useCurrent -eq 'n') {
        $subId = Read-Prompt 'Enter subscription ID to use' -Required
        az account set --subscription $subId
        if ($LASTEXITCODE -ne 0) { Write-Fatal 'Failed to set subscription.' }
        $acct = az account show 2>$null | ConvertFrom-Json
        $AccountName = $acct.name
        $AccountId   = $acct.id
        Write-Ok "Switched to: $AccountName ($AccountId)"
    }
}

# ─── Get deployer object ID ─────────────────────────────────────────

$DeployerOid = (az ad signed-in-user show --query id -o tsv 2>$null)
if ($DeployerOid) {
    Write-Ok "Deployer Object ID: $DeployerOid"
} else {
    Write-Warn 'Could not determine deployer Object ID (service principal login?).'
    Write-Warn 'You may need to manually grant Key Vault Secrets Officer to write the stream key.'
    $DeployerOid = ''
}

# ─── Prompt: namePrefix ─────────────────────────────────────────────

Write-Host ''
Write-Info '=== Deployment Parameters ==='
Write-Host ''

$defaultPrefix = Get-ConfigValue 'namePrefix'
while ($true) {
    $script:NamePrefix = Read-Prompt 'Name prefix (alphanumeric, 3-20 chars, globally unique)' -Default $defaultPrefix -Required

    # Validate format
    if ($NamePrefix -notmatch '^[a-zA-Z0-9]{3,20}$') {
        Write-Err 'Prefix must be 3-20 alphanumeric characters (no hyphens or underscores).'
        continue
    }

    # Check storage account name availability
    Write-Info 'Checking name availability...'
    $storageName = $NamePrefix.ToLower()
    $availJson = az storage account check-name-availability --name $storageName 2>$null | ConvertFrom-Json
    if (-not $availJson.nameAvailable) {
        Write-Err "Storage account name '$storageName' is not available: $($availJson.reason)"
        Write-Err 'Try a different prefix.'
        continue
    }

    # Check for soft-deleted Key Vault with same name
    $kvName = "$($NamePrefix.ToLower())-kv"
    $deletedKv = az keyvault list-deleted --query "[?name=='$kvName'].name" -o tsv 2>$null
    if ($deletedKv) {
        Write-Warn "A soft-deleted Key Vault named '$kvName' exists."
        $purge = Read-Prompt 'Purge it to reuse the name?' -Default 'Y'
        if ($purge -ne 'n') {
            Write-Info "Purging deleted Key Vault '$kvName'..."
            az keyvault purge --name $kvName 2>$null
            if ($LASTEXITCODE -ne 0) { Write-Fatal 'Failed to purge Key Vault. You may need Owner permissions.' }
            Write-Ok 'Purged.'
        } else {
            Write-Err 'Cannot create Key Vault with that name. Try a different prefix.'
            continue
        }
    }

    Write-Ok "Name '$NamePrefix' is available."
    break
}

# ─── Prompt: Region ─────────────────────────────────────────────────

$defaultRegion = Get-ConfigValue 'region'
if (-not $defaultRegion) { $defaultRegion = 'eastus2' }

while ($true) {
    $script:Region = Read-Prompt 'Azure region' -Default $defaultRegion -Required

    # Validate region exists
    $validRegion = az account list-locations --query "[?name=='$Region'].name" -o tsv 2>$null
    if (-not $validRegion) {
        Write-Err "Invalid region '$Region'. Run 'az account list-locations -o table' for valid names."
        continue
    }

    # Check VM SKU availability
    Write-Info "Checking Standard_F2s_v2 availability in $Region..."
    $skuExists = az vm list-skus --location $Region --resource-type virtualMachines `
        --query "[?name=='Standard_F2s_v2'].name" -o tsv 2>$null
    if (-not $skuExists) {
        Write-Err "Standard_F2s_v2 is not available in '$Region'. Choose a different region."
        continue
    }
    Write-Ok "VM SKU available in $Region."

    # Check Automation Account availability
    Write-Info "Checking Automation Account availability in $Region..."
    $regionDisplay = az account list-locations --query "[?name=='$Region'].displayName" -o tsv 2>$null
    $aaAvailable = az provider show -n Microsoft.Automation `
        --query "resourceTypes[?resourceType=='automationAccounts'].locations[?contains(@, '$regionDisplay')]" `
        -o tsv 2>$null
    if (-not $aaAvailable) {
        Write-Warn "Could not confirm Automation Account availability in '$Region'. Deployment may fail if unsupported."
    } else {
        Write-Ok "Automation Account available in $Region."
    }

    break
}

# ─── Prompt: SSH key ────────────────────────────────────────────────

$defaultSshPath = Get-ConfigValue 'sshKeyPath'
if (-not $defaultSshPath) {
    $defaultSshPath = Join-Path $HOME '.ssh' 'id_ed25519.pub'
}

$script:SshKeyPath = Read-Prompt 'SSH public key path' -Default $defaultSshPath -Required

if (-not (Test-Path $SshKeyPath)) {
    $privateKey = $SshKeyPath -replace '\.pub$', ''
    Write-Warn "SSH key not found at '$SshKeyPath'."
    $genKey = Read-Prompt "Generate a new key pair at $privateKey?" -Default 'Y'
    if ($genKey -ne 'n') {
        ssh-keygen -t ed25519 -C 'yt-streamer' -f $privateKey -N '""'
        if ($LASTEXITCODE -ne 0) { Write-Fatal 'SSH key generation failed.' }
        Write-Ok "Generated $SshKeyPath"
    } else {
        Write-Fatal 'SSH public key is required. Provide a valid path.'
    }
}

$SshPublicKey = Get-Content $SshKeyPath -Raw
Write-Ok "SSH key loaded ($($SshPublicKey.Length) chars)"

# ─── Prompt: YouTube stream key ─────────────────────────────────────

Write-Host ''
$StreamKey = Read-Prompt 'YouTube stream key' -Secret
if ($StreamKey) {
    Write-Ok 'Stream key provided (will be stored in Key Vault after deployment).'
} else {
    Write-Warn 'No stream key provided. You can set it later with:'
    Write-Host "    az keyvault secret set --vault-name $kvName --name youtube-stream-key --value <KEY>"
}

# ─── Prompt: Custom domain ──────────────────────────────────────────

$defaultDomain = Get-ConfigValue 'customDomain'
$script:CustomDomain = Read-Prompt 'Custom domain for TLS (press Enter to skip)' -Default $defaultDomain

if ($CustomDomain) {
    Write-Ok "Custom domain: $CustomDomain (Caddy will auto-provision Let's Encrypt)"
} else {
    Write-Ok 'No custom domain - plain HTTP on Azure DNS'
}

# ─── Derive remaining values ────────────────────────────────────────

$RepoUrl = git -C $ScriptDir remote get-url origin 2>$null
if (-not $RepoUrl) {
    Write-Fatal 'Could not determine repoUrl from git remote. Are you in the cloned repo?'
}
# Convert SSH URL to HTTPS if needed
if ($RepoUrl -match '^git@') {
    $RepoUrl = $RepoUrl -replace 'git@github\.com:', 'https://github.com/'
}
Write-Ok "Repo URL: $RepoUrl"

$RgName = "$NamePrefix-rg"

# ─── Save config ────────────────────────────────────────────────────

Save-Config

# ─── Summary ────────────────────────────────────────────────────────

$DnsName = "$($NamePrefix.ToLower()).$Region.cloudapp.azure.com"

Write-Host ''
Write-Host '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' -ForegroundColor Cyan
Write-Host 'Deployment Summary' -ForegroundColor Cyan
Write-Host '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' -ForegroundColor Cyan
Write-Host "  Name prefix:     $NamePrefix"
Write-Host "  Resource group:  $RgName"
Write-Host "  Region:          $Region"
Write-Host "  VM SKU:          Standard_F2s_v2"
Write-Host "  SSH key:         $SshKeyPath"
Write-Host "  Repo URL:        $RepoUrl"
Write-Host "  Custom domain:   $(if ($CustomDomain) { $CustomDomain } else { 'none' })"
Write-Host "  Stream key:      $(if ($StreamKey) { 'provided' } else { 'not set (set later)' })"
Write-Host "  Deployer OID:    $(if ($DeployerOid) { $DeployerOid } else { 'not available' })"
Write-Host ''
Write-Host '  Resources:'
Write-Host "    Storage:       $($NamePrefix.ToLower())"
Write-Host "    Key Vault:     $kvName"
Write-Host "    Automation:    $NamePrefix-automation"
Write-Host "    VM:            $NamePrefix-vm"
Write-Host "    DNS:           $DnsName"
Write-Host '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' -ForegroundColor Cyan
Write-Host ''

$proceed = Read-Prompt 'Proceed with deployment?' -Default 'Y'
if ($proceed -eq 'n') {
    Write-Info 'Deployment cancelled.'
    exit 0
}

# ─── Deploy ─────────────────────────────────────────────────────────

Write-Host ''
Write-Info "Creating resource group '$RgName' in '$Region'..."
az group create --name $RgName --location $Region -o none

Write-Info 'Deploying ARM template (this takes ~10-15 minutes)...'
$deployArgs = @(
    'deployment', 'group', 'create',
    '--resource-group', $RgName,
    '--template-file', $ArmTemplate,
    '--parameters',
    "namePrefix=$NamePrefix",
    "adminPublicKey=$SshPublicKey",
    "repoUrl=$RepoUrl"
)

if ($CustomDomain) {
    $deployArgs += "customDomain=$CustomDomain"
}
if ($DeployerOid) {
    $deployArgs += "deployerObjectId=$DeployerOid"
}
$deployArgs += @('-o', 'none')

& az @deployArgs
if ($LASTEXITCODE -ne 0) { Write-Fatal 'ARM deployment failed.' }

Write-Ok 'ARM deployment complete!'

# ─── Post-deploy: Set stream key in Key Vault ───────────────────────

if ($StreamKey) {
    Write-Info "Setting YouTube stream key in Key Vault '$kvName'..."
    $stored = $false
    for ($attempt = 1; $attempt -le 10; $attempt++) {
        $result = az keyvault secret set --vault-name $kvName --name 'youtube-stream-key' --value $StreamKey -o none 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Ok 'Stream key stored in Key Vault.'
            $stored = $true
            break
        }
        if ($attempt -eq 10) {
            Write-Warn 'Could not write stream key after 10 attempts.'
            Write-Warn 'RBAC may still be propagating. Run manually:'
            Write-Host "    az keyvault secret set --vault-name $kvName --name youtube-stream-key --value <KEY>"
            break
        }
        Write-Warn "Waiting for Key Vault RBAC propagation (attempt $attempt/10)..."
        Start-Sleep -Seconds 30
    }
}

# ─── Post-deploy: Summary ───────────────────────────────────────────

$VmIp = az vm show -d --resource-group $RgName --name "$NamePrefix-vm" --query publicIps -o tsv 2>$null

Write-Host ''
Write-Host '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' -ForegroundColor Green
Write-Host 'Deployment Complete!' -ForegroundColor Green
Write-Host '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' -ForegroundColor Green
Write-Host ''
if ($CustomDomain) {
    Write-Host "  Web UI:    https://$CustomDomain"
} else {
    Write-Host "  Web UI:    http://$DnsName"
}
$sshHost = if ($VmIp) { $VmIp } else { $DnsName }
Write-Host "  SSH:       ssh azureuser@$sshHost"
Write-Host ''
Write-Host '  Cloud-init is still running on the VM (~10 min).'
Write-Host '  Check progress:'
Write-Host "    ssh azureuser@$sshHost tail -f /var/log/cloud-init-output.log"
Write-Host ''
if (-not $StreamKey) {
    Write-Host '  Set your YouTube stream key:'
    Write-Host "    az keyvault secret set --vault-name $kvName --name youtube-stream-key --value <KEY>"
    Write-Host ''
}
Write-Host '  Upload videos to blob storage:'
Write-Host "    az storage blob upload-batch --account-name $($NamePrefix.ToLower()) --destination recordings --source /path/to/videos/ --auth-mode login"
Write-Host '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' -ForegroundColor Green
