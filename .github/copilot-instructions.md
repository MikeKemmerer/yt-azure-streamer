# Repository instructions

## Commands

Run these from the repository root. Bash commands target Linux/WSL; service and installation commands require a Linux host with systemd.

| Purpose | Command | Requirements |
| --- | --- | --- |
| Playback/API regression tests | `node tools/test-streamer-state.js` | Node.js; tests backend helpers, mocked API routes, and frontend update error handling without starting the server |
| Playback control regression tests | `bash tools/test-streamer-skip.sh` | Bash; simulates ffmpeg completion/failure, skip, deferred stop/restart, and bookmark handling |
| Session queue regression tests | `python3 tools/test-streamer-control.py` | Python 3; queue transitions, revisions, requests, empty intent and acknowledgements |
| Progress integration tests | `python3 tools/test-streamer-progress.py` | Linux, Python 3, ffmpeg with libx264; finite completion and telemetry-reader failure |
| Live playback integration tests | `bash tools/test-streamer-playback.sh` | Linux, Bash, Python 3, ffmpeg with libx264; real queue reorder, on-air requests/return order, bookmarks, empty stop |
| Encoding regression tests | `bash tools/test-static-video-cfr.sh` | Bash, Python 3, ffmpeg with libx264, ffprobe; generates temporary media, checks landscape and portrait outputs, and cleans up |
| Deployment ZIP | `bash tools/package.sh` | `zip`; writes `yt-azure-streamer.zip` |
| Interactive Azure deployment | `./deploy.sh` or `.\deploy.ps1` | Azure CLI >= 2.50, Azure login, SSH public key; PowerShell variant requires 7+ |
| Local installation | `sudo bash install/install-local.sh` | Dedicated Linux host; installs packages and configures storage, credentials, and services |
| Update an installed host | `sudo /usr/local/bin/yt-update.sh` | Installed checkout at `/opt/yt`; optionally `--branch <name>` or `--restart-streamer` |

For a single targeted test script, run any regression command independently. Cases execute together within their respective scripts; the scripts do not provide named-case filtering.

The encoding test checks 1 fps input with 96 kHz audio, silent 1 fps input, and normal 30 fps input. It also checks source-level streamer contracts, so encoding refactors may require updating its contract assertions as well as output expectations.

## Architecture

This is a systemd-managed streaming appliance, not a bundled web application. Bash services embed Python for JSON, date/time, and Azure schedule processing. The backend uses CommonJS and Node's built-in HTTP/filesystem/child-process modules; the frontend is plain HTML/CSS/JavaScript with SortableJS loaded from a CDN.

### Provisioning and deployment

`deploy.sh` and `deploy.ps1` are parallel interactive entry points to `arm/azuredeploy.json`. ARM provisions the VM, network, Blob Storage, Key Vault, Automation Account, and managed-identity role assignments. Its inline `customData` writes deployment configuration, clones the repository to `/opt/yt`, and runs `install/install-services.sh`. `cloud-init/cloud-init.yaml` is a reference mirror, not the deployment input: change ARM's inline data when changing bootstrap behavior.

The Azure installer renders blobfuse2/Caddy templates, installs scripts into `/usr/local/bin` and units into `/etc/systemd/system`, and publishes the PowerShell start/deallocate runbooks. The `recordings` container is mounted at `/mnt/blobfuse2`. Azure operations on the host use managed identity, including access to stream keys and web credentials in Key Vault. Authentication setup retries through `caddy-auth-setup.timer` because deployment writes credentials after provisioning.

Local installation reuses the streamer, scheduler, backend, and frontend. `/etc/yt/mode` selects `local` (missing defaults to Azure); `/etc/yt/local.conf` supplies `VIDEO_DIR`, defaulting to `/mnt/videos`. Local stream keys are files under `/etc/yt/secrets/`. Local mode installs `streamer-local.service` as `streamer.service`, omitting the Azure mount dependency and Automation services. Preserve mode-aware storage, credential, health, and log handling when changing shared code.

### Scheduling and playback

There are two scheduling layers: `scripts/schedule-sync.sh` reconciles Azure Automation schedules for VM power, while `services/scheduler/scheduler.sh` checks every 30 seconds and controls streaming on the running host. The sync timer runs every 10 minutes; Azure schedule saves through the API trigger an immediate sync. VM starts/stops are padded by two minutes around stream windows; the stop runbook deallocates the VM.

`schedule.json` is the initial template. Its deployed schema includes IANA `timezone`, weekly `events`, date-specific `overrides`, shared `stream` settings, and per-profile `streams.landscape` / `streams.portrait` settings. Events select outputs using a `streams` array, defaulting to landscape for legacy events. Preserve legacy shared-setting fallbacks, overnight windows, and override precedence across scheduler, sync, API, and UI changes.

The streamer generates a playlist, resumes after the bookmarked video, and sends synchronized landscape/portrait outputs to separate RTMP keys. Output selection is communicated through `/run/streamer-active-landscape` and `/run/streamer-active-portrait`. Both profiles share playback order, not independent playlists.

### Web control

Caddy serves `/opt/yt/web/frontend` and proxies `/api/*` unchanged to the backend on port 8080. Basic auth is configured in Caddy via `/etc/yt/caddy/auth.conf`, not implemented in Node. Backend routes invoke systemd, journalctl, ffprobe, Azure CLI, and installed helper scripts, so exercising operational routes requires the installed host environment. Keep frontend calls and backend route/JSON contracts consistent; use the existing `api()` helper and `esc()` for interpolated display text.

## Cross-file conventions

- Keep code in `/opt/yt` separate from deployment configuration and persistent playback data in `/etc/yt`. Initial templates must not overwrite existing settings. `/run` holds transient playback/control state; `/tmp/streamer-*.txt` files feed reloadable ffmpeg overlays.
- `scripts/update.sh` fetches and hard-resets the installed checkout to the selected remote branch, then redeploys only changed files. Do not use it as a development-checkout validation command. Extend its script/unit maps and the relevant installers together when adding deployed components. The installed updater is named `yt-update.sh`, despite older README examples using `update.sh`.
- Live updates do not restart the streamer by default. Preserve this behavior and the explicit restart flag. Caddy/blobfuse2 template changes only produce update notices; they do not overwrite generated `/etc/yt` configuration.
- Replacing the installed streamer script does not replace an already-running Bash process. After a control-protocol change, restart the streamer before expecting the new backend signals to work.
- Install `systemd/blobfuse2.mount` as `mnt-blobfuse2.mount`: the systemd mount unit name must match `/mnt/blobfuse2`. Keep unit references, backend service health, and log lists consistent; health checks use `schedule-sync.timer`, whereas logs use `schedule-sync.service`.
- Playlist config entries identify videos by basename and contain `file`, `enabled`, and optional display `title`. A nonempty matching enabled config takes priority over shuffle/date sorting. Otherwise generation scans supported files, sorts date-prefixed names chronologically before undated names, or shuffles. Preserve ffmpeg concat single-quote escaping when generating/parsing playlist paths.
- Keep saved playlist, ordinary resume bookmark, current playback, and temporary queue distinct. `streamer-control.py` owns applied `/run/streamer-control-state.json`, legacy runtime playlist and Up Next overlays; backend writes only the versioned command mailbox. Require session/revision checks and player acknowledgements. Live edits affect the upcoming pass; natural exhaustion refills saved ordering, explicit empty sets the scheduler-respected queue hold. One-off requests must not advance ordinary bookmarks. UI library saves use `applyToLive: false`; legacy live saves submit player commands. Preserve same-directory atomic replacement.
- SSE uses a shared bounded observer and cached operational status, not subprocesses per browser/tick. Progress is advisory, generation-tagged and delivered over loopback UDP; reader/backend failure must not block ffmpeg or trigger recovery. Health verifies encoder/reader process-start identities and treats absent collectors as unknown, not stalled; invalidate identities when preparing a new generation.
- Manual start/stop, skip, stop-after-current, and graceful restart use `/run/streamer-*` signals shared by the backend, scheduler, and streamer. Skip uses `/run/streamer-skip`; the streamer terminates its own ffmpeg PID and advances, while unrequested ffmpeg failures retry the current video. Update all participants together rather than replacing these with isolated service calls; `streamer.service` has `Restart=always`.
- Stop After Current must submit an explicit systemd stop job and set the manual-stop marker, not merely exit the streamer. Deferred stop/restart requests are handled on failed playback too; failed videos must retain the previous bookmark.
- Encoding normalizes video to 30 fps CFR before output splitting, uses libx264 CBR HRD filler and a fixed 60-frame GOP with scene-cut keyframes disabled, and normalizes audio to -14 LUFS / -1 dBTP with 44.1 kHz resampling. Silent inputs receive generated audio. Preserve these contracts when changing filters or output arguments.
- Resource names derive from the alphanumeric 3-20 character prefix: VM `{prefix}-vm`, Automation `{prefix}-automation`, storage lowercase prefix, Key Vault `{lowercase-prefix}-kv`. Keep ARM, both deployment scripts, installers, backend, and runbook/sync naming consistent.
- `.gitattributes` requires LF for text files and CRLF for PowerShell scripts.
