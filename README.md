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

> **Playlist resume:** Stops and restarts resume the interrupted video with a two-second rewind. Measured playback position is saved durably every five seconds and again during a controlled service stop, so crashes and reboots can also recover (with a few extra seconds replayed). Completed or intentionally skipped videos advance using the separate ordinary-playlist bookmark.

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

**Encoding details:** Every RTMP output is normalized to 30 fps CFR before the
landscape/portrait split. This duplicates frames from sparse sources such as the
historical 1 fps static-image videos without spatially upscaling them. Each
output uses `libx264` with the `veryfast` preset, its resolution-specific target
as `b:v`, `minrate`, and `maxrate`, x264 CBR HRD filler, and a fixed 60-frame
(two-second) GOP with scene-cut keyframes disabled. This keeps frame cadence,
bitrate, and keyframe delivery stable for YouTube ingest even when the picture
does not change.

Run the offline cadence/CBR regression test with:

```bash
bash tools/test-static-video-cfr.sh
```

The test generates temporary 1 fps fixtures with audio and generated silence,
plus a normal 30 fps control. It validates simultaneous landscape and portrait
FLV outputs for frame count, timestamps, audio, CBR packet windows, and
two-second keyframes, then removes all generated media.

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

## YouTube-driven scheduling (on-prem only)

In local mode, **Schedule > YouTube-driven scheduling** can replace weekly schedules/overrides with scheduled YouTube Studio broadcasts. Configure exact title rules (case and extra whitespace are ignored), a landscape or portrait output, and a fallback duration. The default fallback is **eight hours after the scheduled start**; a valid YouTube scheduled end takes precedence. The existing saved playlist/resume position is used, without modifying the library.

This integration is **read-only**. In Studio, bind each event to the output's configured stream key and enable **Auto-start and Auto-stop**. Local RTMP starts at the due time; YouTube goes live after receiving the input. Local checks, media opening/Blobfuse, and YouTube processing introduce delay, so publication is not frame-accurate.

**Important:** Auto-stop can irreversibly end the broadcast after roughly a minute without input. A long per-sermon reconnect, encoder retry, or network/storage outage may therefore end an eight-hour show prematurely. Use an unlisted multi-sermon trial before enabling production scheduling. This does not introduce a continuous encoder or write-enabled lifecycle control.

### One-time read-only authorization

The host must already have the local installation, be awake/network-connected, and have its media mount ready. Do not run the dedicated-host installer blindly on a shared kiosk.

On shared hosts, set `YT_BACKEND_HOST=127.0.0.1` in the backend's systemd environment and expose the authenticated frontend proxy on an unused port/interface. This keeps the API private without taking over an existing web server's ports 80/443.

If an SSH user owns `/opt/yt` but the backend/updater runs as root, Git can reject the checkout with **detected dubious ownership**, breaking both Refresh branches and Check for Updates. After verifying that this is your trusted installed checkout and its `origin` is correct, allow only that directory for root:

```bash
sudo -H git config --global --add safe.directory /opt/yt
```

Do not use a wildcard trust exception. This repairs Git access without changing file ownership, applying an update, or restarting playback. Commit and push a locally deployed branch before using Apply Update: the updater resets the installed checkout to the selected remote branch.

The streamer defaults to a thumbnail every ten seconds. If FFmpeg 7 buffers live output around this low-rate preview, set `YT_PREVIEW_FPS=1` in the streamer's systemd environment and deliberately restart it. This changes only thumbnail cadence, not the 30 fps stream, resolution, bitrate, or encoder count; verify sustained output on the installed host.

1. Enable the YouTube Data API in your Google Cloud project. Create an OAuth **Desktop app** client and download its client JSON outside the repository.
2. Configure the consent screen for unattended use. External applications left in **Testing** generally receive refresh authorizations that expire after seven days for these scopes; review Google's publishing/verification requirements. Tokens can also be revoked or expire later.
3. On the installed Linux host, create an isolated environment and install the declared OAuth dependencies. `python3-venv` must be available:

```bash
sudo python3 -m venv /etc/yt/youtube-venv
sudo /etc/yt/youtube-venv/bin/pip install -r /opt/yt/services/scheduler/youtube-requirements.txt
sudo /etc/yt/youtube-venv/bin/python /usr/local/bin/youtube-schedule.py authorize --client-file /path/to/client.json
```

For a headless host, first establish SSH forwarding from the browser workstation:

```bash
ssh -L 8765:127.0.0.1:8765 your-user@your-streamer-host
```

Run authorization on the host and open the printed Google authorization URL in the workstation browser. The callback listens only on host loopback port 8765. Choose the intended channel/Brand Account. Credentials are saved with mode 0600 under `/etc/yt/secrets/youtube-oauth.json`; never commit or share either credential JSON. The application requests only `youtube.readonly`.

4. Enter the authorized channel ID and title/output rules in the schedule UI. Set the configured landscape/portrait keys using the existing stream-key UI. Stop the streamer before switching schedule sources, then switch to YouTube and verify the preview.
5. Local installation/updating installs `youtube-sync.service` and enables `youtube-sync.timer`. The timer runs approximately once per minute; the Python environment is required and the official API provider runs only while the YouTube source is enabled. Missing authorization is reported in discovery status. The existing scheduler checks local windows every 30 seconds.

```bash
sudo systemctl status youtube-sync.timer
sudo journalctl -u youtube-sync.service -n 50
```

The preview shows channel lifecycle separately from encoder health, matching windows, validation errors, and discovery freshness. Refresh Preview reads the latest cache; it does not force more Google requests. Official API requests are bounded, paginated, backed off on errors, and locally capped at 8,000/day using YouTube's Pacific-time reset boundary. This cap is not knowledge of other applications' use of the project's quota.

### Public discovery without Google authorization

Select **Public YouTube (yt-dlp)** to discover public upcoming and active livestreams without OAuth. Install the same declared dependencies into the isolated `/etc/yt/youtube-venv` above; skip the `authorize` command. Do not install into a shared kiosk's Python environment. Existing configurations default to the official API.

Enter the channel's `UC...` ID and exact title/output rules. You can save and inspect public discovery while **Weekly** remains selected, without changing playback or enabling YouTube automation. Saving requests an asynchronous scan; the timer subsequently runs 60 seconds after each completed scan. Refresh Preview only reads the cache. The status includes the last scan's actual runtime; channel size, network, throttling, and yt-dlp updates affect timing.

Only metadata is requested, never video downloads or browser cookies. Each scan lists at most 100 channel entries and inspects at most 32 matching/tracked IDs, with a 55-second metadata budget and individual process timeouts. Failed scans retain the last good snapshot. Public premieres, wrong channels, missing start times, and approximate title matches cannot authorize a start. Missing entries in a bounded listing do not prove cancellation.

**Reduced guarantees:** public discovery cannot see private broadcasts, check stream-key bindings or shared-key conflicts, or verify Studio Auto-start/Auto-stop. It uses each rule's duration because public metadata does not reliably expose scheduled ends. Verify these Studio settings yourself and check the confirmation box before enabling automatic starts. An already-live, unowned broadcast is not started or taken over by ordinary discovery.

### Local broadcast rollover and church-service exclusion

An optional root-managed `/etc/yt/youtube-local.json` enables rollover for the public provider while the schedule source is YouTube:

```json
{
  "rolloverEnabled": true,
  "controlManual": true,
  "disconnectSeconds": 30,
  "calendarUrl": "http://your-calendar-host:8000/api/events",
  "serviceCalendar": "Services",
  "standbyState": "/run/videokiosk2/standby.json"
}
```

Omit the calendar fields on hosts without this kiosk integration. This policy is **local mode only**; Azure scheduling is unchanged. The calendar URL must be a trusted, operator-configured endpoint returning the existing calendar app's `calendar`, `allDay`, `start`, and `end` fields. Only timed entries from `Services` are used; meetings, holidays, and announcements do not pause streaming. The integration reads the existing calendar and kiosk state; it does not restart or modify the kiosk.

With `controlManual`, a single unambiguous matching public live event for each currently selected output can be tracked even if started manually. This explicitly permits automatic stops of those sessions. Without that opt-in, manual sessions remain protected. The existing per-rule fallback remains in force (for example 12 hours), with an additional **24-hour maximum from the observed actual YouTube live start**. A successor's scheduled start shortens the preceding slot. Public upcoming-to-live timestamp changes do not move the committed window.

At a deadline or replacement start, the scheduler explicitly stops `streamer.service`, then waits **at least 30 seconds from successful service stop** and until direct metadata confirms every previous event has completed. Thirty seconds does not guarantee YouTube Auto-stop completion; discovery and the 30-second scheduler poll can extend the disconnect. Missing/stale metadata never counts as completion. If no eligible replacement exists, the service stays stopped. The appliance does not create broadcasts or transition their lifecycle.

Church-service blocking starts at the **calendar's scheduled start**, not an arbitrary early buffer. It remains latched until `/run/videokiosk2/standby.json` records a **new VLC-to-browser failover at or after that start**. The planned calendar end and an old browser/standby state cannot release the block. New starts are blocked when calendar refresh fails or becomes stale; already-known service starts still stop playback. Calendar refresh continues during YouTube discovery backoff. After actual failover, only another fresh, eligible matching broadcast can start; an ended event cannot be reused.

Operator Stop and explicit-empty queue hold still win. A church pause ends the old broadcast, so schedule a replacement for resumption. There is no automatic broadcast creation, private Studio verification, or GPU/encoding change.

### Scheduling safeguards

- No new starts from discovery older than ten minutes, or more than ten minutes after the scheduled start. An already-owned session retains its end deadline during discovery failures. The deadline is a **hard stop**, even mid-sermon.
- Manual start remains a manual session; automatic deadlines do not stop it. Manual stop and explicit-empty queue hold win. A stopped/completed event is suppressed rather than repeatedly relaunched.
- A confirmed completed/revoked/deleted event ends only its owned local session. An API failure never means cancellation. Source/rule changes invalidate the discovery cache.
- Wrong channels/keys, missing readiness/Auto-start/Auto-stop, and ambiguous bindings are rejected. **Other upcoming/active events sharing the same ingestion key can also auto-start**, so they block eligibility even if their titles/times differ. Arrange dedicated bindings or keep only the intended auto-start event on that key.
- Paired landscape/portrait events must have distinct validated keys and identical windows. Same-output overlaps and staggered dual-output windows are rejected; outputs still share one saved video rotation.
- Disable YouTube mode to return to the preserved weekly schedule/overrides. No VM power operations are added in local mode.

Derived snapshots/status/quota accounting live under `/etc/yt/youtube-*.json`; temporary ownership/suppression lives under `/run/streamer-youtube-owner.json`. Restarting the backend does not reset ownership. After a reboot, stale discovery cannot launch an event, and an already-live unrelated broadcast is not taken over.

Focused offline verification:

```bash
python3 tools/test-youtube-schedule.py
node tools/test-streamer-state.js
bash tools/test-streamer-skip.sh
```

### Deferred Azure extension

A deallocated VM cannot discover new broadcasts. An independent **timer-triggered Azure Function**, or scheduled Automation watcher runbook, could reuse the eligibility rules and reconcile one-time VM start/deallocate runbooks. It must also publish dated streaming windows to durable storage for the VM's scheduler to obtain after boot; updating power schedules alone is insufficient.

That external controller needs protected Google OAuth credentials plus its own narrowly scoped Azure managed identity. VM power windows must be the union of all valid events with measured boot/mount lead time and stop padding. It must preserve manual sessions and unrelated schedules, reconcile cancellations idempotently, and replace rather than compete with the VM's existing `schedule-sync` power-schedule owner. No Function code, cloud infrastructure, or deployment is included here.

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
| **Streamer** | Live status, measured playback progress/health, temporary drag-and-drop upcoming queue, acknowledged Queue Next / Play Now / Skip, and manual start/stop controls |
| **Service Health** | At-a-glance status of all 6 systemd units (streamer, scheduler, schedule-sync, caddy, web-backend, blobfuse2) |
| **Schedule** | Next start/stop times, event table, inline editor to add/remove/edit events with day-of-week checkboxes and timezone |
| **System** | VM uptime, memory usage, disk usage |
| **Storage** | Video file count and total size on the blobfuse2 mount |
| **Stream Key** | Update the YouTube stream key stored in Key Vault (takes effect on next stream start) |
| **Stream Settings** | Max resolution selector (144p–2160p), shuffle toggle, watermark (lower-third title) toggle |
| **Saved Playlist** | Permanent order, enabled videos and titles, search and sorting; saving leaves the live upcoming queue unchanged |
| **Logs** | Service log viewer with service selector (streamer, scheduler, schedule-sync, caddy, web-backend, blobfuse2), configurable line count (50–500), dark terminal-style output |
| **Update** | Two-step update: check for changes first, then apply — re-deploys changed scripts, units, and frontend files without interrupting a live stream. Auto-reloads frontend after successful update |
| **Deployment Info** | JSON dump of prefix, storage account, automation account, key vault, and hostname |

### Live queue behavior

Queue Next, drag reorder, and removal change only the upcoming pass; the current sermon keeps playing. Play Now asks for confirmation, interrupts only the current ffmpeg child, and briefly reconnects RTMP. The requested video then returns to the ordinary upcoming queue, omitting the interrupted sermon and the request's previous pending occurrence.

Natural queue exhaustion refills from the saved playlist. Explicitly clearing the queue instead finishes the current sermon and stops, with a transient hold that prevents scheduled starts until manual Start. Restart and VM reboot discard temporary upcoming queue edits/requests and restore saved/bookmarked ordering, but first resume an interrupted current video at its saved timestamp. A current one-off can resume without changing the ordinary bookmark. Missing, changed-size, disabled ordinary, or invalid checkpoint media falls back to the saved rotation. Backend restart alone preserves the playback session. A reboot also clears the empty-queue hold.

Timestamp recovery does not change boot/start policy: the scheduler or an operator must still start playback after a reboot.

The upcoming queue starts collapsed: Show 5 reveals five entries, Show all reveals the full queue, and Collapse hides it again. The preview already shows the next five videos.

Select Horizontal (16:9), Vertical (9:16), or both beside playback controls. Start uses that selection. While running, Apply outputs & restart briefly reconnects RTMP and resets temporary upcoming edits, preserving the current video's timestamp. Each selected output requires its own configured key; both outputs share playback. Schedules may select different outputs later. Portrait title and Up Next overlays keep shorter titles on one or two lines, using a third only for longer text; landscape retains two.

Restore Saved Queue applies the saved ordering to upcoming playback without interrupting the current sermon. Removing a sermon is temporary; disable it in Saved Playlist to exclude it from future refills. Saving the library updates future refills but does not silently replace pending live edits.

Action acceptance is not proof of playback. The UI waits for player acknowledgement; Play Now and Skip require fresh encoder progress on the selected next video. Conflicting edits reload actual state. Unknown or unconfirmed results do not mean success.

Live status uses authenticated same-origin SSE with polling fallback. Encoder health is report-only: measured progress, sustained speed, startup grace, and sample freshness distinguish healthy/slow/stalled/unknown. The UI shows sample age and uncertainty reasons. Encoder/reader process-start identities distinguish a running encoder with missing progress from a failed telemetry reader or reused PID; completed videos are not reported as stalls. Telemetry uses a small loopback UDP reader so reader failure cannot block ffmpeg. No extra encoder, GPU, or recovery policy is added.

For an installed-host update, deploy backend, streamer, helper, and scheduler together and deliberately restart the streamer with the updater's `--restart-streamer` option. The default updater still does not interrupt playback. New live controls remain unavailable until an updated player is running, and restart resets session edits.

### API Endpoints

All endpoints are served under `/api/` and require authentication.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/info` | Deployment metadata |
| `GET` | `/api/streamer` | Streamer status, uptime, now-playing, up-next |
| `GET` | `/api/streamer/events` | Advisory SSE snapshots; refresh authoritative status on reconnect |
| `GET` | `/api/streamer/queue` | Applied session queue, revision, pending action and recent acknowledgements |
| `POST` | `/api/streamer/queue` | Submit `replace`, `next`, `now`, `reset` or `skip` with `id`, `session`, `revision`, and `files`/`file` as applicable; acceptance returns HTTP 202 |
| `GET` | `/api/streamer/actions/{id}` | Player acknowledgement; missing/session-ended actions are unconfirmed |
| `POST` | `/api/streamer/start` | Start the streamer service |
| `POST` | `/api/streamer/stop` | Stop the streamer service |
| `POST` | `/api/streamer/skip` | Skip to the next video (kills current ffmpeg) |
| `POST` | `/api/streamer/stop-after-current` | Signal the streamer to stop after the current video ends |
| `DELETE` | `/api/streamer/stop-after-current` | Cancel a pending stop-after-current |
| `POST` | `/api/streamer/restart` | Restart the streamer service |
| `POST` | `/api/streamer/outputs` | Apply a nonempty `streams` selection (`landscape`, `portrait`) and restart active playback |
| `POST` | `/api/stream-key` | Update YouTube stream key in Key Vault |
| `GET` | `/api/settings` | Read max_resolution and shuffle from schedule.json |
| `PUT` | `/api/settings` | Update max_resolution and shuffle |
| `GET` | `/api/videos` | List videos with enabled/order from playlist config |
| `PUT` | `/api/videos` | Save playlist config; `applyToLive: false` saves only (used by the UI); legacy callers can also request live application |
| `GET` | `/api/health` | Systemd unit states for all services |
| `GET` | `/api/logs` | Journalctl output for a given service (query: `service`, `lines`) |
| `GET` | `/api/schedule` | Read schedule with next start/stop times |
| `GET` | `/api/schedule/youtube` | Cached read-only eligibility/lifecycle/freshness preview; no credentials or ingestion keys |
| `PUT` | `/api/schedule` | Update schedule.json; Azure mode syncs Automation, local mode supports opt-in `scheduleSource: "youtube"` and `youtube: {channelId, rules: [{title, profile, durationSeconds}]}` |
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
| `/etc/yt/playback-resume.json` | Durable interrupted-video timestamp, separate from ordinary rotation |
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
