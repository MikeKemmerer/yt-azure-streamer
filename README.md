# yt-azure-streamer

A parameterized, prefix-driven Azure deployment that provisions a YouTube streaming VM with a single ARM template command. The VM streams a video file from Azure Blob Storage to YouTube Live via ffmpeg, starting and stopping automatically on a configurable weekly schedule to minimise cost.

**What gets deployed:**
- Ubuntu 24.04 VM (Standard_B2s) — auto-deallocates when not streaming
- Azure Blob Storage (`recordings` container) — source video lives here via blobfuse2
- Azure Key Vault — holds the YouTube stream key (read via managed identity; no key on disk)
- Azure Automation Account — triggers VM start/stop 2 minutes before/after each stream
- All role assignments wired into ARM — zero manual steps after `az deployment group create`

---

## Prerequisites

- **Azure CLI** ≥ 2.50 installed and logged in (`az login`)
- An Azure **subscription** where you have `Owner` or `User Access Administrator` + `Contributor` rights (needed for the ARM role assignments)
- An **SSH key pair** — the public key is passed to the template; the private key is used to SSH into the VM
- **Git** (to clone this repo)

```bash
# Generate an SSH key if you don't have one
ssh-keygen -t ed25519 -C "yt-streamer"
```

---

## Deployment

### 1. Clone the repo

```bash
git clone https://github.com/MikeKemmerer/yt-azure-streamer.git
cd yt-azure-streamer
```

### 2. Create a resource group

```bash
az group create \
  --name streamer-rg \
  --location westus2
```

### 3. Deploy the ARM template

> **`namePrefix` rules:** alphanumeric only (no hyphens or underscores), 3–20 characters,
> must be **globally unique** — it forms the storage account name and Key Vault name directly.

```bash
az deployment group create \
  --resource-group streamer-rg \
  --template-file arm/azuredeploy.json \
  --parameters namePrefix=stdemo \
               adminPublicKey="$(cat ~/.ssh/id_ed25519.pub)" \
               repoUrl="https://github.com/MikeKemmerer/yt-azure-streamer"
```

| Parameter | Default | Description |
|---|---|---|
| `namePrefix` | *(required)* | Alphanumeric prefix for all resource names |
| `adminUsername` | `azureuser` | SSH login username |
| `adminPublicKey` | *(required)* | SSH public key string |
| `repoUrl` | *(required)* | Git URL the VM clones at first boot |
| `location` | resource group location | Azure region |

The deployment creates and wires together: VNet, NSG (SSH/HTTP/HTTPS), public IP, NIC, Storage Account + `recordings` container, Automation Account, Key Vault, VM, and three role assignments.

Cloud-init then clones the repo and runs `install/install-services.sh` automatically — all services are running within ~10 minutes of the ARM deployment completing.

### 4. Store your YouTube stream key

The ARM deployment outputs a ready-to-run command. Copy it from the deployment output:

```bash
az deployment group show \
  --resource-group streamer-rg \
  --name azuredeploy \
  --query properties.outputs.setStreamKeyCmd.value \
  -o tsv
```

Or run the command directly (replace `stdemo` with your prefix):

```bash
az keyvault secret set \
  --vault-name stdemo-kv \
  --name youtube-stream-key \
  --value <YOUR_YOUTUBE_STREAM_KEY>
```

Get your stream key from [YouTube Studio → Go Live → Stream](https://studio.youtube.com/).

### 5. Upload your source video

The streamer loops `/mnt/blobfuse2/stream.mp4` on the VM, which maps to the `recordings` container in your storage account.

```bash
az storage blob upload \
  --account-name stdemo \
  --container-name recordings \
  --name stream.mp4 \
  --file /path/to/your/video.mp4 \
  --auth-mode login
```

> The file must be named `stream.mp4`. It is looped indefinitely during the stream window.

### 6. (Optional) Configure the stream schedule

The default schedule is Mon/Wed/Fri 18:00–20:00 UTC. SSH into the VM and edit the schedule:

```bash
# Get the VM's public IP
VM_IP=$(az vm show -d --resource-group streamer-rg --name stdemo-vm --query publicIps -o tsv)

# SSH in (use your adminUsername, default: azureuser)
ssh azureuser@$VM_IP

# Edit the schedule on the VM
sudo nano /opt/yt/schedule.json
```

See the [Schedule Configuration](#schedule-configuration) section below for the file format. The schedule-sync timer picks up changes within 10 minutes.

---

## Schedule Configuration

Edit `/opt/yt/schedule.json` on the VM to define when streams happen:

```json
{
  "timezone": "America/New_York",
  "events": [
    {
      "name": "Evening Stream",
      "start": "18:00",
      "stop": "20:00",
      "days": ["Mon", "Wed", "Fri"]
    }
  ]
}
```

| Field | Description |
|---|---|
| `timezone` | Any [IANA timezone name](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) (e.g. `"America/New_York"`, `"Europe/London"`) |
| `start` / `stop` | 24-hour `HH:MM` in the specified timezone |
| `days` | Any subset of `Mon`, `Tue`, `Wed`, `Thu`, `Fri`, `Sat`, `Sun` |

**How the schedule works end-to-end:**

1. `schedule-sync.timer` fires every 10 minutes and runs `schedule-sync.sh`
2. `schedule-sync.sh` reads `schedule.json` and upserts Azure Automation weekly schedules — the VM is **started 2 minutes before** each event's `start` time and **deallocated 2 minutes after** each event's `stop` time (billing stops on deallocation)
3. `scheduler.service` runs as a daemon on the VM, checking every 30 seconds whether the current time is inside a stream window, then starting or stopping `streamer.service` accordingly

To manually trigger a schedule sync from the VM:

```bash
sudo /usr/local/bin/schedule-sync.sh
```

---

## Cost Model

All costs approximate (West US 2, 2025 pricing):

| Resource | SKU | Approx. monthly cost |
|---|---|---|
| VM (Standard_B2s) | Pay-per-use; auto-deallocated when idle | ~$0.04/hr while running |
| OS disk (StandardSSD_LRS) | 30 GB | ~$2.40 |
| Storage account (Standard_LRS) | Per-use | ~$0.02/GB stored + egress |
| Automation Account (Basic) | ≤500 job min/month free | $0 |
| Key Vault (Standard) | ~$0.03/10k operations | ~$0 |
| Public IP (Static Standard) | Always allocated | ~$3.65 |

**Example:** streaming 6 h/week → VM runs ~26 h/month → **~$1/month compute**, ~$6 total.

To further reduce costs, choose a smaller VM (e.g. `Standard_B1ms` at ~$0.02/hr) if your stream resolution/bitrate allows it, or use a dynamic public IP (requires DNS update on each boot).

---

## Operational Commands

Run these on the VM after SSH-ing in.

### Check service status

```bash
systemctl status streamer.service
systemctl status scheduler.service
systemctl status schedule-sync.timer
systemctl status mnt-blobfuse2.mount
systemctl status caddy.service
systemctl status web-backend.service
```

### View logs

```bash
# Streamer (ffmpeg output)
journalctl -u streamer.service -f

# Scheduler daemon
journalctl -u scheduler.service -f

# Schedule sync (last run)
journalctl -u schedule-sync.service -n 50

# Blobfuse2 mount
journalctl -u mnt-blobfuse2.mount -n 50

# Cloud-init installer log (first boot only)
sudo cat /var/log/cloud-init-output.log
```

### Manually start/stop the stream

```bash
sudo systemctl start streamer.service
sudo systemctl stop streamer.service
```

### Re-run the installer (e.g. after a code update)

```bash
cd /opt/yt && sudo git pull && sudo bash install/install-services.sh
```

---

## Web UI

```
http://<vm-public-ip>/
```

The UI displays the deployment's prefix, storage account name, and automation account name. It is served by Caddy on port 80 (HTTP).

> **HTTPS / TLS:** Caddy's automatic Let's Encrypt requires a real domain name pointed at the VM's public IP. Add a DNS A record for your domain and replace `:80` with your domain in `caddy/Caddyfile`, then restart the caddy service.

---

## Directory Layout

```
yt-azure-streamer/
  arm/
    azuredeploy.json          # ARM template — all resources + 3 role assignments
  blobfuse2/
    blobfuse2.yaml            # blobfuse2 config template (MSI auth, filled in at install)
  caddy/
    Caddyfile                 # Reverse proxy: / → frontend, /api/* → backend:8080
  cloud-init/
    cloud-init.yaml           # Reference only — mirrors what ARM customData produces
  install/
    install-services.sh       # Master installer (run once by cloud-init at first boot)
  runbooks/
    Start-StreamerVM.ps1      # Azure Automation runbook: start VM (MSI auth)
    Stop-StreamerVM.ps1       # Azure Automation runbook: deallocate VM (MSI auth)
  schedule.json               # Stream schedule — edit to customise times/days
  scripts/
    role-assign.sh            # (legacy) manual role assignment — superseded by ARM
    schedule-sync.sh          # Syncs schedule.json → Azure Automation weekly schedules
  services/
    streamer/
      streamer.sh             # Fetches stream key from KV, runs ffmpeg → YouTube RTMP
    scheduler/
      scheduler.sh            # Daemon: checks schedule every 30 s, starts/stops streamer
  systemd/
    streamer.service          # ExecStart=streamer.sh; Requires=mnt-blobfuse2.mount
    scheduler.service         # Type=simple, Restart=always
    schedule-sync.service     # Type=oneshot; called by timer
    schedule-sync.timer       # OnBootSec=2min, OnUnitActiveSec=10min
    caddy.service             # Custom Caddy unit (disables default apt unit)
    web-backend.service       # Node.js backend on port 8080
    blobfuse2.mount           # Installed as mnt-blobfuse2.mount; Type=fuse3
  tools/
    clean.sh                  # Remove build/temp artefacts
    package.sh                # Package repo for deployment
  web/
    backend/
      server.js               # Express-less Node.js API (/api/info)
      config.json             # Port and template strings
    frontend/
      index.html
      app.js
      style.css
```

---

## Resource Naming

All names derive from `namePrefix` (must be alphanumeric, 3–20 chars):

| Resource | Name |
|---|---|
| VM | `{prefix}-vm` |
| Storage account | `{lowercase prefix, hyphens stripped}` |
| Key Vault | `{lowercase prefix}-kv` |
| Automation Account | `{prefix}-automation` |
| VNet | `{prefix}-vnet` |
| NSG | `{prefix}-nsg` |
| Public IP | `{prefix}-pip` |

Example with `namePrefix=stdemo`: VM=`stdemo-vm`, storage=`stdemo`, KV=`stdemo-kv`, automation=`stdemo-automation`.

---

## Role Assignments (created by ARM)

No manual steps are required. ARM creates three role assignments at deploy time:

| Principal | Role | Scope | Purpose |
|---|---|---|---|
| VM managed identity | Automation Contributor | Automation Account | `schedule-sync.sh` can upsert schedules |
| Automation Account managed identity | Virtual Machine Contributor | VM | Start/Stop runbooks can manage the VM |
| VM managed identity | Key Vault Secrets User | Key Vault | `streamer.sh` can read the stream key |
