# AI Agent Instructions — yt-azure-streamer

## Project Overview

Infrastructure-as-code deployment for an Azure VM that streams pre-recorded video to YouTube on a weekly schedule. Supports dual landscape + portrait streams with text overlays.

## Quick Start

```bash
# Deploy (interactive — prompts for config)
./deploy.sh       # Linux/WSL
./deploy.ps1      # Windows PowerShell 7+

# Requires: Azure CLI 2.50+, logged in via `az login`
```

## Architecture

| Directory | Purpose |
|-----------|---------|
| `arm/` | ARM template — provisions entire stack in one deployment |
| `cloud-init/` | VM first-boot configuration scripts |
| `scripts/` | Deployment orchestration, schedule sync, updates |
| `services/` | systemd unit files for streaming services |
| `web/` | Password-protected management dashboard |
| `tools/` | Helper utilities (ffprobe, playlist generation) |
| `runbooks/` | Azure Automation runbooks (VM start/stop) |

## Key Conventions

- **Bash scripts**: Always `set -euo pipefail`
- **No credentials on disk**: All secrets in Azure Key Vault (managed identity)
- **IaC-first**: No manual steps after ARM deployment
- **Config**: `.deploy-config.json` is gitignored, regenerated on each deploy
- **Branches**: `main` (production), `feature/*` (development)
- **Parameterized**: `namePrefix` (3–20 alphanumeric) drives all resource names

## Streaming Features

- FFmpeg-based streaming with blobfuse2-mounted video source
- Dual output: landscape (16:9) + portrait (9:16) with text overlays
- Sermon title cycling with alpha crossfade (33s title / 7s up-next)
- Elapsed/total time display, church name header
- All dimensions scale with `MAX_RES` setting (720p/1080p)

## Terminal Notes

- `rm`, `git branch -D`, `curl` blocked by policy
- WSL path: `/mnt/c/Users/michael.kemmerer/Desktop/yt-azure-streamer/`
- Use `fetch_webpage` instead of `curl` for HTTP requests
