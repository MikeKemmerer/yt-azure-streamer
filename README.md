# yt-azure-streamer

A parameterized, prefix-driven Azure deployment that provisions a YouTube streaming VM with a single ARM template command. The VM streams a video file from Azure Blob Storage to YouTube Live via ffmpeg, starting and stopping automatically on a configurable weekly schedule to minimise cost.

**What gets deployed:**
- Ubuntu 24.04 VM (Standard_F2s_v2) — auto-deallocates when not streaming
- Azure Blob Storage (`recordings` container) — source video lives here via blobfuse2
- Azure Key Vault — holds the YouTube stream key and web UI credentials (managed identity; no secrets on disk)
- Azure Automation Account — triggers VM start/stop 2 minutes before/after each stream
- **Web management UI** — password-protected dashboard for streamer control, playlist editing, schedule management, logs, and system monitoring
- All role assignments wired into ARM — zero manual steps after `az deployment group create`

---

## Prerequisites

- **Azure CLI** ≥ 2.50 installed and logged in (`az login`)
- An Azure **subscription** where you have `Owner` or `User Access Administrator` + `Contributor` rights (needed for the ARM role assignments)
- An **SSH key pair** — the public key is passed to the template; the private key is used to SSH into the VM
- **Git** (to clone this repo)

```bash
# Generate an SSH key if you don't have one (default path: ~/.ssh/id_ed25519)
ssh-keygen -t ed25519 -C "yt-streamer"
```

---

## Deployment

### Quick Start (recommended)

Clone the repo and run the interactive deployment script — it handles all pre-flight
checks, prompts, resource creation, and post-deploy configuration in one pass:

```bash
git clone https://github.com/MikeKemmerer/yt-azure-streamer.git
cd yt-azure-streamer

# Linux / macOS / WSL
./deploy.sh

# Windows (PowerShell 7+)
./deploy.ps1
```

The script will:
1. Verify Azure CLI is installed and you're logged in
2. Prompt for a globally unique name prefix, region, SSH key, stream key, and optional custom domain
3. Validate name availability (storage account + Key Vault soft-delete check)
4. Validate region (VM SKU + Automation Account availability)
5. Deploy the ARM template
6. Write the YouTube stream key to Key Vault (with RBAC retry)
7. Print connection details and next steps

Settings are saved to `.deploy-config.json` (git-ignored) for easy re-runs.

> **After `deploy.sh` finishes:** The VM starts running cloud-init in the background to install packages and configure all services. This takes approximately **10 minutes**. The web UI will not be reachable until cloud-init completes. You can monitor progress via SSH: `sudo tail -f /var/log/cloud-init-output.log`.

### Manual Deployment

<details>
<summary>Click to expand manual step-by-step instructions</summary>

#### 1. Clone the repo

```bash
git clone https://github.com/MikeKemmerer/yt-azure-streamer.git
cd yt-azure-streamer
```

#### 2. Create a resource group

```bash
az group create \
  --name streamer-rg \
  --location westus2
```

#### 3. Deploy the ARM template

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
| `customDomain` | *(empty)* | Your own domain for automatic TLS via Let's Encrypt (see [TLS with Let's Encrypt](#tls-with-lets-encrypt)). Leave empty for plain HTTP |
| `deployerObjectId` | *(empty)* | Your Azure AD object ID — grants Key Vault Secrets Officer so you can write the stream key after deployment |
| `location` | resource group location | Azure region |

The deployment creates and wires together: VNet, NSG (SSH/HTTP/HTTPS), public IP, NIC, Storage Account + `recordings` container, Automation Account, Key Vault, VM, and up to four role assignments.

Cloud-init then clones the repo and runs `install/install-services.sh` automatically — all services are running within ~10 minutes of the ARM deployment completing.

**Accessing the web UI:** Your VM is automatically assigned the DNS name `{namePrefix}.{region}.cloudapp.azure.com` — for example, `stdemo.westus2.cloudapp.azure.com`. The installer detects this automatically and configures Caddy to serve on it over HTTP.

#### 4. Store your YouTube stream key

> **Tip:** If you passed `deployerObjectId` during deployment, you already have Key Vault Secrets Officer.
> Otherwise you'll need to grant yourself access first.

```bash
# Get your object ID (skip if you passed deployerObjectId)
az ad signed-in-user show --query id -o tsv

# Grant yourself Key Vault Secrets Officer (skip if you passed deployerObjectId)
az role assignment create \
  --role "Key Vault Secrets Officer" \
  --assignee <YOUR_OBJECT_ID> \
  --scope $(az keyvault show --name stdemo-kv --query id -o tsv)

# Set the stream key
az keyvault secret set \
  --vault-name stdemo-kv \
  --name youtube-stream-key \
  --value <YOUR_YOUTUBE_STREAM_KEY>
```

Get your stream key from [YouTube Studio → Go Live → Stream](https://studio.youtube.com/).

</details>

### 5. Upload your source videos

Upload one or more video files to the `recordings` container in your storage account. They are mounted at `/mnt/blobfuse2/` on the VM and streamed as a playlist. Files with date-prefixed names (e.g. `January 2, 2025 - Sermon.mp4`) are sorted **chronologically**; other files sort alphabetically after all dated files.

**Recommended upload methods:**

| Method | Best for |
|---|---|
| [Azure Storage Explorer](https://azure.microsoft.com/products/storage/storage-explorer/) (desktop app) | Drag-and-drop bulk uploads with progress tracking |
| [VS Code Azure Storage extension](https://marketplace.visualstudio.com/items?itemName=ms-azuretools.vscode-azurestorage) | Upload directly from your editor |
| `az storage blob upload-batch` (below) | Scripted / CLI bulk uploads |
| `az storage blob upload` (below) | Single file uploads |

```bash
# Upload an entire directory of videos at once
az storage blob upload-batch \
  --account-name stdemo \
  --destination recordings \
  --source /path/to/videos/ \
  --auth-mode login

# Or upload a single file
az storage blob upload \
  --account-name stdemo \
  --container-name recordings \
  --name "January 2, 2025 - Sermon.mp4" \
  --file /path/to/video.mp4 \
  --auth-mode login
```

Supported formats: `.mp4`, `.mkv`, `.mov`, `.avi`, `.ts`, `.flv`. The playlist is regenerated each time the streamer starts, so new/deleted files are picked up automatically. Set `stream.shuffle` to `true` in `schedule.json` to randomize playback order instead of chronological/alphabetical.

> **Playlist resume:** The streamer bookmarks its position after each video. On restart (e.g. after scheduled downtime), it resumes from the *next* video — so the playlist makes forward progress across stop/start cycles rather than always restarting from the beginning.

### 6. (Optional) Configure the stream schedule

The default schedule is Mon/Wed/Fri 18:00–20:00 UTC. You can edit it from the **web UI** (Schedule card → Edit Schedule) or via SSH:

```bash
# Get the VM's public IP
VM_IP=$(az vm show -d --resource-group streamer-rg --name stdemo-vm --query publicIps -o tsv)

# SSH in (use your adminUsername, default: azureuser)
ssh azureuser@$VM_IP

# Edit the schedule on the VM
sudo nano /etc/yt/schedule.json
```

See the [Schedule Configuration](#schedule-configuration) section below for the file format. Saving from the web UI syncs to Azure immediately; SSH edits are picked up within 10 minutes by the timer.

---

## Schedule Configuration

Edit `/etc/yt/schedule.json` on the VM to define when streams happen:

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
  ],
  "stream": {
    "max_resolution": "720p"
  }
}
```

| Field | Description |
|---|---|
| `timezone` | Any [IANA timezone name](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) (e.g. `"America/New_York"`, `"Europe/London"`) |
| `start` / `stop` | 24-hour `HH:MM` in the specified timezone |
| `days` | Any subset of `Mon`, `Tue`, `Wed`, `Thu`, `Fri`, `Sat`, `Sun` |
| `stream.max_resolution` | Maximum output resolution: `144p`, `240p`, `360p`, `480p`, `720p` (default), `1080p`, `1440p`, `2160p` |
| `stream.shuffle` | `true` to randomize playlist order, `false` (default) for date/alphabetical sort |
| `stream.watermark` | `true` to overlay the video filename as a lower-third title, `false` (default) to disable |

**Resolution behavior:** Videos at or below `max_resolution` are passed through without re-encoding. Videos above it are downscaled. Videos are never upsampled.

**Encoding details:** The streamer uses `libx264` with `veryfast` preset and forced keyframes every 2 seconds (`-force_key_frames "expr:gte(t,n_forced*2)"`). This satisfies YouTube's requirement of keyframe interval ≤ 4 seconds for stable ingest.

**Shuffle behavior:** When `shuffle` is `true`, the playlist is randomized instead of sorted. The random order is written to disk and preserved across streamer restarts — it only changes when the playlist is regenerated (i.e. when the streamer is started fresh after new files are added or removed).

**Watermark behavior:** When `watermark` is `true`, a broadcast-style lower third is rendered with the church name, current video title (cycling with "Up Next" on a 41-second crossfade), elapsed/total time display, and a semi-transparent background bar. Long titles auto-wrap to two lines and font size adapts. Custom display titles from the playlist config override filenames.

**Audio normalization:** All audio is normalized to -14 LUFS (YouTube standard) with -1 dBTP true peak using ffmpeg's `loudnorm` filter. Videos without audio tracks automatically get a silent audio stream generated so the stream never drops.

**How the schedule works end-to-end:**

1. `schedule-sync.timer` fires every 10 minutes and runs `schedule-sync.sh`
2. `schedule-sync.sh` reads `schedule.json`, fetches existing Azure Automation schedules, **diffs** the desired vs. current state, and only creates/updates/deletes what actually changed — unchanged schedules are left alone for speed
3. Saving the schedule from the web UI triggers `schedule-sync.sh` **immediately** (no 10-minute wait)
4. The VM is **started 2 minutes before** each event's `start` time and **deallocated 2 minutes after** each event's `stop` time (billing stops on deallocation)
5. `scheduler.service` runs as a daemon on the VM, checking every 30 seconds whether the current time is inside a stream window, then starting or stopping `streamer.service` accordingly
6. Removing an event or day from the schedule automatically cleans up the corresponding Azure Automation schedules

To manually trigger a schedule sync from the VM:

```bash
sudo /usr/local/bin/schedule-sync.sh
```

---

## Cost Model

All costs approximate (West US 2, pay-as-you-go, 2026 pricing):

| Resource | SKU | Approx. cost |
|---|---|---|
| VM (Standard_F2s_v2) | Compute-optimised, 2 vCPU, 4 GB; auto-deallocated when idle | ~$0.085/hr while running |
| OS disk (StandardSSD_LRS) | 30 GB | ~$2.40/month |
| Storage account (Standard_LRS) | Per-use | ~$0.02/GB stored + egress |
| Automation Account (Basic) | ≤500 job min/month free | $0 |
| Key Vault (Standard) | ~$0.03/10k operations | ~$0 |
| Public IP (Static Standard) | Always allocated | ~$3.65/month |

**Example:** streaming 6 h/week → VM runs ~26 h/month → **~$2.20/month compute**, ~$8 total.

> **Why F2s_v2?** The streamer uses ffmpeg with libx264 for real-time transcoding when downscaling. Burstable VMs (B-series) exhaust CPU credits under sustained encoding and throttle to ~40% baseline. The F2s_v2 provides dedicated compute cores at a modest price premium. If all your source videos are already at or below `max_resolution` (passthrough only), you could use `Standard_B2s` (~$0.042/hr) to save costs — change the `vmSize` variable in `azuredeploy.json`.

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

### Update to latest code

```bash
# Preferred: one-click update (safe, doesn't restart streamer)
sudo /usr/local/bin/update.sh

# Full reinstall (only needed for major changes)
cd /opt/yt && sudo git pull && sudo bash install/install-services.sh
```

---

## Web UI

```
http://<vm-public-ip>/          # without customDomain
https://stream.example.com/     # with customDomain
```

The web UI is protected by HTTP basic auth. Credentials are set during deployment (the deploy script prompts for a username and password, which are stored in Key Vault and fetched at install time). Caddy serves the frontend and reverse-proxies `/api/*` to the Node.js backend on port 8080.

![Web UI Screenshot](docs/web-ui-screenshot.png)

### Features

| Card | Description |
|---|---|
| **Streamer** | Live status indicator (green/grey dot), stream uptime, now-playing title with progress bar, up-next queue, manual Start / Stop / Stop After Current / Skip buttons |
| **Service Health** | At-a-glance status of all 6 systemd units (streamer, scheduler, schedule-sync, caddy, web-backend, blobfuse2) |
| **Schedule** | Next start/stop times, event table, inline editor to add/remove/edit events with day-of-week checkboxes and timezone |
| **System** | VM uptime, memory usage, disk usage |
| **Storage** | Video file count and total size on the blobfuse2 mount |
| **Stream Key** | Update the YouTube stream key stored in Key Vault (takes effect on next stream start) |
| **Stream Settings** | Max resolution selector (144p–2160p), shuffle toggle, watermark (lower-third title) toggle |
| **Playlist** | Touch-friendly drag-and-drop reorder (SortableJS), per-video enable/disable checkboxes, inline title editing, search filter, Select All / Deselect All, sort by name / sort by date / shuffle buttons, instant playlist regeneration on save |
| **Logs** | Service log viewer with service selector (streamer, scheduler, schedule-sync, caddy, web-backend, blobfuse2), configurable line count (50–500), dark terminal-style output |
| **Update** | Two-step update: check for changes first, then apply — re-deploys changed scripts, units, and frontend files without interrupting a live stream. Auto-reloads frontend after successful update |
| **Deployment Info** | JSON dump of prefix, storage account, automation account, key vault, and hostname |

### API Endpoints

All endpoints are served under `/api/` and require authentication.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/info` | Deployment metadata |
| `GET` | `/api/streamer` | Streamer status, uptime, now-playing, up-next |
| `POST` | `/api/streamer/start` | Start the streamer service |
| `POST` | `/api/streamer/stop` | Stop the streamer service |
| `POST` | `/api/streamer/skip` | Skip to the next video (kills current ffmpeg) |
| `POST` | `/api/streamer/stop-after-current` | Signal the streamer to stop after the current video ends |
| `DELETE` | `/api/streamer/stop-after-current` | Cancel a pending stop-after-current |
| `POST` | `/api/streamer/restart` | Restart the streamer service |
| `POST` | `/api/stream-key` | Update YouTube stream key in Key Vault |
| `GET` | `/api/settings` | Read max_resolution and shuffle from schedule.json |
| `PUT` | `/api/settings` | Update max_resolution and shuffle |
| `GET` | `/api/videos` | List videos with enabled/order from playlist config |
| `PUT` | `/api/videos` | Save playlist config and regenerate ffmpeg playlist |
| `GET` | `/api/health` | Systemd unit states for all services |
| `GET` | `/api/logs` | Journalctl output for a given service (query: `service`, `lines`) |
| `GET` | `/api/schedule` | Read schedule with next start/stop times |
| `PUT` | `/api/schedule` | Update schedule.json and immediately sync to Azure Automation |
| `POST` | `/api/update/check` | Fetch latest from GitHub and report what would change |
| `GET` | `/api/storage` | Video file count and total size |
| `GET` | `/api/system` | VM uptime, memory, and disk stats |
| `POST` | `/api/update` | Pull latest code from GitHub, redeploy changed scripts/units |

### TLS with Let's Encrypt

By default the VM serves plain HTTP on its auto-assigned Azure DNS name (`{namePrefix}.{region}.cloudapp.azure.com`). If you have your own domain, you can enable automatic HTTPS by passing the `customDomain` parameter during deployment:

```bash
az deployment group create \
  --resource-group streamer-rg \
  --template-file arm/azuredeploy.json \
  --parameters namePrefix=stdemo \
               adminPublicKey="$(cat ~/.ssh/id_ed25519.pub)" \
               repoUrl="https://github.com/MikeKemmerer/yt-azure-streamer" \
               customDomain="stream.example.com"
```

Caddy automatically provisions a Let's Encrypt certificate — no manual steps required.

**Prerequisites:**
1. Point a DNS A record (or CNAME to the Azure DNS name) for your domain at the VM's public IP **before** deploying (or within the first few minutes while cloud-init runs).
2. Ports 80 and 443 must be open (the NSG allows both by default).

> **Note:** The Azure DNS name (`{prefix}.{region}.cloudapp.azure.com`) cannot be used for Let's Encrypt since Azure owns the parent domain. TLS requires your own domain.

**Without `customDomain`:** Caddy serves plain HTTP on the auto-detected Azure DNS name (the default).

---

## Directory Layout

```
yt-azure-streamer/
  deploy.sh                   # Interactive deployment script (bash)
  deploy.ps1                  # Interactive deployment script (PowerShell 7+)
  arm/
    azuredeploy.json          # ARM template — all resources + role assignments
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
  schedule.json               # Stream schedule + resolution config (template — deployed to /etc/yt/)
  scripts/
    generate-playlist.sh      # Scans blobfuse2 mount, writes ffmpeg concat playlist
    migrate-configs.sh        # Upgrade helper: moves configs from /opt/yt/ → /etc/yt/ (not needed on fresh installs)
    role-assign.sh            # (legacy) manual role assignment — superseded by ARM
    schedule-sync.sh          # Syncs schedule.json → Azure Automation weekly schedules
    setup-caddy-auth.sh       # Fetches web UI credentials from Key Vault → /etc/yt/caddy/auth.conf
    update.sh                 # One-click update: git pull, redeploy changed scripts/units
  services/
    streamer/
      streamer.sh             # Playlist streamer: bookmark resume, resolution cap, ffmpeg → YouTube RTMP
    scheduler/
      scheduler.sh            # Daemon: checks schedule every 30 s, starts/stops streamer
  systemd/
    streamer.service          # ExecStart=streamer.sh; Requires=mnt-blobfuse2.mount
    scheduler.service         # Type=simple, Restart=always
    schedule-sync.service     # Type=oneshot; called by timer
    schedule-sync.timer       # OnBootSec=2min, OnUnitActiveSec=10min
    caddy.service             # Custom Caddy unit (disables default apt unit)
    caddy-auth-setup.service  # Type=oneshot; fetches web UI credentials from Key Vault
    caddy-auth-setup.timer    # Retries every 5 min until secrets are available, then stops
    web-backend.service       # Node.js backend on port 8080
    blobfuse2.mount           # Installed as mnt-blobfuse2.mount; Type=fuse3
  tools/
    clean.sh                  # Remove build/temp artefacts
    package.sh                # Package repo for deployment
  web/
    backend/
      server.js               # Express-less Node.js API (16 endpoints)
      config.json             # Port and template strings
    frontend/
      index.html
      app.js
      style.css
  docs/
    mockup.html               # Self-contained HTML mockup of the web UI
    web-ui-screenshot.png     # Screenshot embedded in this README
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

No manual steps are required. ARM creates three role assignments at deploy time (plus an optional fourth):

| Principal | Role | Scope | Purpose |
|---|---|---|---|
| VM managed identity | Automation Contributor | Automation Account | `schedule-sync.sh` can upsert schedules |
| Automation Account managed identity | Virtual Machine Contributor | VM | Start/Stop runbooks can manage the VM |
| VM managed identity | Key Vault Secrets Officer | Key Vault | `streamer.sh` reads the stream key; web backend writes stream key updates |
| Deployer (optional) | Key Vault Secrets Officer | Key Vault | You can write the stream key after deployment (only if `deployerObjectId` is provided) |

---

## Configuration Files (`/etc/yt/`)

All deployment-specific configuration lives under `/etc/yt/`, separate from the code in `/opt/yt/`. This means `git pull` never overwrites local settings, and `update.sh` is always safe to run.

| File | Purpose |
|---|---|
| `/etc/yt/nameprefix` | Name prefix for all Azure resources |
| `/etc/yt/resourcegroup` | Azure resource group name |
| `/etc/yt/customdomain` | Custom domain for TLS (empty = use Azure DNS name) |
| `/etc/yt/schedule.json` | Stream schedule, events, resolution, shuffle, watermark |
| `/etc/yt/playlist.txt` | ffmpeg concat playlist (auto-generated) |
| `/etc/yt/playlist-config.json` | Per-video enable/disable and order |
| `/etc/yt/playlist-state.json` | Resume bookmark (last played index) |
| `/etc/yt/blobfuse2/blobfuse2.yaml` | Blobfuse2 mount config (generated from template at install) |
| `/etc/yt/caddy/Caddyfile` | Caddy reverse proxy config (generated from template at install) |
| `/etc/yt/caddy/auth.conf` | HTTP basic auth credentials (fetched from Key Vault) |

These files are created by `install-services.sh` on first boot. The `update.sh` script intentionally never touches `/etc/yt/` — only code under `/opt/yt/` is updated.

---

## Updating a Running VM

Use the **Update** button in the web UI, or from SSH:

```bash
sudo /usr/local/bin/update.sh
```

The update script:
1. Fetches and resets to `origin/{branch}` in `/opt/yt/`
2. Compares changed files against the previous commit
3. Re-installs any changed scripts to `/usr/local/bin/`
4. Reloads changed systemd units
5. Restarts affected services (except the streamer — pass `--restart-streamer` to include it)
6. Never touches `/etc/yt/` configuration files
7. Self-updates: if `update.sh` itself changed, re-installs and re-execs automatically

The web UI supports two-step updates: **Check for Updates** fetches the latest code and shows a diff summary before applying. After a successful update, the page auto-reloads to pick up frontend changes.

```bash
sudo /usr/local/bin/yt-update.sh --branch beta    # deploy from a specific branch
sudo /usr/local/bin/yt-update.sh --restart-streamer  # include streamer restart
```

> **Upgrading from an older install** (before the `/etc/yt/` config split): Run `sudo bash /opt/yt/scripts/migrate-configs.sh` **once** after pulling the new code. This moves all deployment-specific configs from `/opt/yt/` to `/etc/yt/` so future `git pull`s never conflict with local settings.

---

## Troubleshooting

### Web UI not reachable after deploy

Cloud-init runs in the background for ~10 minutes after `deploy.sh` finishes. Monitor progress:

```bash
sudo tail -f /var/log/cloud-init-output.log
```

The web UI becomes available once `install-services.sh` completes. If it still doesn't load after 15 minutes, check the Caddy service:

```bash
systemctl status caddy.service
journalctl -u caddy.service -n 50
```

### Web UI shows "Unauthorized" or no auth prompt

The `caddy-auth-setup.timer` fetches web UI credentials from Key Vault and writes `/etc/yt/caddy/auth.conf`. It retries every 5 minutes until the Key Vault secrets are available. Force a retry immediately:

```bash
sudo systemctl start caddy-auth-setup.service
journalctl -u caddy-auth-setup.service -n 20
```

### Streamer fails to start — "stream key not found"

The YouTube stream key must be stored in Key Vault before the streamer can start:

```bash
az keyvault secret set \
  --vault-name <prefix>-kv \
  --name youtube-stream-key \
  --value <YOUR_STREAM_KEY>
```

### No videos in playlist / blobfuse2 mount not working

Check that the blobfuse2 mount is up and that videos are uploaded:

```bash
systemctl status mnt-blobfuse2.mount
ls /mnt/blobfuse2/
```

If the mount is failed, check logs and verify the VM managed identity has **Storage Blob Data Reader** on the storage account:

```bash
journalctl -u mnt-blobfuse2.mount -n 50
```

### Stream starts but YouTube shows no signal

1. Confirm the stream key matches the active YouTube Live event in [YouTube Studio](https://studio.youtube.com/).
2. Check ffmpeg output in the streamer log — look for RTMP connection errors:
   ```bash
   journalctl -u streamer.service -n 100
   ```
3. Outbound TCP on port 1935 (RTMP) must not be blocked. The default NSG only restricts inbound traffic; outbound is unrestricted.

### Schedule sync not updating Azure Automation

The schedule sync is now **diff-based** — it only modifies schedules that actually changed. If the web UI shows "Schedule saved and synced to Azure." but the portal looks unchanged, the schedule might already be correct. To debug:

```bash
# Run manually — it will print what it created/updated/deleted (or "No changes needed")
sudo /usr/local/bin/schedule-sync.sh

# Check recent sync logs
journalctl -u schedule-sync.service -n 50
```

Ensure the VM managed identity has **Automation Contributor** on the Automation Account (wired by ARM automatically).
