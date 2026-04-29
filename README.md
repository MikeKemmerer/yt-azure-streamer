# yt-azure-streamer

A parameterized, prefix-driven Azure deployment for a YouTube streaming VM with:

- ARM template (parameterized with "namePrefix") — provisions all resources in one command
- cloud-init provisioning + master installer
- streamer + scheduler services (fully implemented)
- Azure Automation schedule sync (VM start/stop on a weekly schedule)
- blobfuse2 mount (managed-identity auth, no keys on disk)
- Key Vault for YouTube stream key
- Web UI (frontend + backend)
- Caddy reverse proxy
- All role assignments wired into ARM template (zero manual steps)

---

## Deployment

### 1. Create a resource group

```bash
az group create \
  --name <resource-group> \
  --location westus2
```

### 2. Deploy the ARM template

> **Important:** `namePrefix` must be **alphanumeric only** (no hyphens/underscores),
> 3–20 characters, and globally unique — it is used directly as the storage account
> and Key Vault name.

```bash
az deployment group create \
  --resource-group streamer-rg \
  --template-file arm/azuredeploy.json \
  --parameters namePrefix=stdemo \
               adminPublicKey="$(cat ~/.ssh/id_rsa.pub)" \
               repoUrl="https://github.com/<org>/yt-azure-streamer"
```

The deployment output includes `setStreamKeyCmd` with the exact command to store your stream key.

### 3. Store your YouTube stream key

```bash
az keyvault secret set \
  --vault-name stdemo-kv \
  --name youtube-stream-key \
  --value <YOUR_YOUTUBE_STREAM_KEY>
```

That's it. The VM provisions itself, all services start automatically, and role
assignments are created by ARM — no manual steps required.

---

## Schedule Configuration

Edit `schedule.json` on the VM at `/opt/yt/schedule.json` (or commit changes
and re-clone) to define when streams happen:

```json
{
  "timezone": "UTC",
  "events": [
    {
      "name": "Stream Session",
      "start": "18:00",
      "stop": "20:00",
      "days": ["Mon", "Wed", "Fri"]
    }
  ]
}
```

- `timezone`: any IANA timezone name (e.g. `"America/New_York"`)
- `start` / `stop`: 24-hour `HH:MM` in the specified timezone
- `days`: any combination of `Mon`, `Tue`, `Wed`, `Thu`, `Fri`, `Sat`, `Sun`

`schedule-sync.sh` runs every 10 minutes via systemd timer and pushes the schedule
to Azure Automation, which starts the VM **2 minutes before** each stream and
deallocates it **2 minutes after** (stopping compute billing).

The local `scheduler.service` daemon reads the same file and starts/stops
`streamer.service` at the precise scheduled times.

---

## Cost Model

| Resource | SKU | Approx. monthly cost |
|---|---|---|
| VM (Standard_B2s) | Pay-per-use, auto-deallocate | ~$0.04/hr while running |
| OS disk (StandardSSD_LRS) | 30 GB | ~$2.40 |
| Storage account (Standard_LRS) | Per-use | ~$0.02/GB |
| Automation Account (Basic) | Up to 500 min/month free | $0 |
| Key Vault (Standard) | ~$0.03/10k ops | ~$0 |
| Public IP (Static Standard) | | ~$3.65 |

If you stream 6 hours/week the VM runs ≈26 hours/month → **~$1/month compute**.

---

## Directory Layout

```
repo/
  arm/
    azuredeploy.json          # ARM template (all resources + role assignments)
  blobfuse2/
    blobfuse2.yaml            # blobfuse2 config template (MSI auth)
  caddy/
    Caddyfile                 # Reverse proxy: / → frontend, /api/* → backend
  cloud-init/
    cloud-init.yaml           # Reference: mirrors what ARM customData produces
  install/
    install-services.sh       # Master installer (run once by cloud-init)
  runbooks/
    Start-StreamerVM.ps1      # Azure Automation runbook: start VM
    Stop-StreamerVM.ps1       # Azure Automation runbook: deallocate VM
  schedule.json               # Stream schedule (edit to customise)
  scripts/
    role-assign.sh            # (legacy) manual role assignment — no longer needed
    schedule-sync.sh          # Syncs schedule.json → Azure Automation schedules
  services/
    streamer/
      streamer.sh             # ffmpeg pipeline → YouTube RTMP
    scheduler/
      scheduler.sh            # Daemon: start/stop streamer.service on schedule
  systemd/
    streamer.service
    scheduler.service
    schedule-sync.service
    schedule-sync.timer
    caddy.service
    web-backend.service
    blobfuse2.mount
  web/
    backend/
      server.js
      config.json
    frontend/
      index.html
      app.js
      style.css
```

---

## Web UI

```
http://<vm-public-ip>/
```

Shows prefix, storage account name, and automation account name.

---

## Notes

- `namePrefix` must be alphanumeric only — no hyphens or underscores
- Storage account name = lowercase `namePrefix` with hyphens stripped (e.g. `stdemo`)
- Key Vault name = `{lowercase-prefix}-kv` (e.g. `stdemo-kv`)
- Automation Account = `{prefix}-automation`; VM = `{prefix}-vm`
- Three role assignments are created by ARM (no manual steps):
  - VM identity → **Automation Contributor** on the Automation Account (for schedule-sync)
  - Automation Account identity → **Virtual Machine Contributor** on the VM (for Start/Stop runbooks)
  - VM identity → **Key Vault Secrets User** on the Key Vault (for stream key read)
- Upload your source video to `/mnt/blobfuse2/stream.mp4` (blobfuse2 container: `recordings`)


