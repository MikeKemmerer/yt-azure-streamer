# Streaming diagnostics contract v1

`GET /api/streamer/diagnostics` is a read-only operational snapshot. Caddy's existing authentication protects browser access. A local Monitoring agent may read the fixed loopback endpoint `http://127.0.0.1:8080/api/streamer/diagnostics` on a host configured with `YT_BACKEND_HOST=127.0.0.1`; do not expose the backend or bypass Monitoring's existing mTLS transport.

The HTTP response is JSON with:

| Field | Meaning |
|---|---|
| `schema_version` | Integer `1`; reject unsupported major versions as unknown, not healthy. |
| `generated_at` | UTC ISO timestamp when the snapshot was assembled. |
| `mode` | `local` or `azure`. |
| `severity` | Worst component severity: `error`, `unknown`, `warn`, `ok` in descending priority. Unknown must be displayed as uncertainty/warning, never green. |
| `summary` | Safe human-readable worst reason, or healthy playback intent. |
| `next_action` | `{action, at}`; `at` is ISO UTC or null for a waiting condition. This is an observed policy projection, not authorization to execute an action. |
| `components` | Object keyed by `playback`, `encoder`, `storage`, `scheduling`, `services`, `resources`, `auth`. |
| `limitations` | Human-readable observation limitations. |

Each component contains `severity`, `reason`, `observed_at` (UTC ISO or null), `age_seconds` (number or null), and `stale` (boolean), plus the details below. Missing/malformed/unavailable observations produce unknown, not healthy. A successful HTTP response alone does not imply a healthy appliance.

## Component details

- **playback:** `expected` (`running`, `stopped`, `unknown`), `actual` (systemd state), `intentional_pause`, `transition_grace`, `current_title`, `outputs`. Unexpected running/stopped is error except an observed startup/stop transition, which warns. Manual stop, explicit queue hold, church pause and handoff are reflected separately in the reason. A fresh actual scheduler observation supplies weekly intent; the monitor never executes scheduler decisions.
- **encoder:** `status` (existing player health), `speed`, `sample_age_seconds`, `elapsed_seconds`, `duration_seconds`, `generation`, `encoder_pid`, `telemetry_pid`. Fresh stalled progress is error, sustained slow or starting is warning, missing/invalid telemetry is unknown. Intentionally stopped encoder is healthy. PID identity validation and startup/transition grace reuse existing player health. Media times include resume offsets; health generation remains separate.
- **storage:** probe result, `available_count`, `saved_enabled_count`, `read_bytes`, `remote_roundtrip_verified` (false for FUSE reads), `mount` (`mounted`, `required`), `upcoming_count`, `explicit_empty`. Absent required mount/no media/failed read is error; timed-out or unavailable probe is unknown. Directory listings and a small recording read are bounded. Enabled count is config membership, not a promise every queued item is playable. `selection_source` distinguishes saved-playlist selection from the supported directory-scan fallback.
- **scheduling:** source/provider, discovery freshness and age, last scan duration/error, calendar requirement/age/readiness, church block, handoff reason/wait/disconnect/completed IDs, Studio acknowledgement, observed broadcasts with lifecycle/windows/errors, tracked IDs/live start/deadline, scheduler decision and timestamp, weekly observation timestamp, same-live church-resume setting. Calendar fields are not applicable in Azure. Unavailable/stale calendar/discovery/scheduler data is unknown; missing Studio acknowledgement is a warning blocking NEW automatic starts, not a missing stream key.
- **services:** allowlisted `units` with state and systemd restart count. Streamer restart count is informational; an intentionally stopped streamer does not make this component fail. Required control services not observed active are unknown, explicitly failed units are error. The discovery timer is required only for YouTube scheduling.
- **resources:** one-minute host load/core count, available/total memory MB, root disk available bytes/percent, thermal temperature where available. Low memory/root disk or high temperature warns; a single high CPU load is displayed, not treated as a proven sustained encoding failure. Root disk values are not a dedicated Blob cache quota.
- **auth:** safe Blob authentication `mode`, optional `expires_at`/`days_remaining`. SAS warns within 30 days and errors within 7 days or once expired. Managed authentication has no SAS expiry. Missing/invalid expiry is unknown; no configured local Blob storage is not applicable. Never emit the token, signature or credential configuration contents.

Consumers should preserve unknown extra fields for forwards-compatible v1 parsing, but display only their explicit allowlist. Never derive a command from `next_action`, execute provider-supplied text, or assume `live` proves RTMP ingest.

## Cadence and compatibility

The backend maintains one shared snapshot every five seconds regardless of browser presence. Playback/service state reuses the existing bounded four-second cache; a separate Python probe refreshes storage, resources, credential expiry and control-unit state every 60 seconds, with an eight-second outer deadline and three-second individual service/storage deadlines. No request initiates these slow probes. A storage-worker lock prevents another read piling up behind a stuck FUSE operation.

Storage/resources/services/auth observations are stale after 120 seconds. Weekly scheduler observations are stale after 90 seconds. YouTube discovery has the existing ten-minute freshness limit; calendar data has the existing three-minute limit; scheduler decision freshness is checked independently. Encoder health is evaluated with each shared snapshot; `progress_observed_at` and `sample_age_seconds` retain actual progress age. A healthy reader/encoder with old progress may be diagnosed stalled; a missing reader remains unknown, not assumed stalled.

A consumer should reject future/invalid timestamps and mark a fetched snapshot unknown after 90 seconds without a new `generated_at` (and immediately report an unreachable backend). Do not reset component timestamps when merging into Monitoring's host cache. A native five-minute host-cache interval is insufficient: use an optional separate 60-second provider snapshot.

Existing API endpoints and payloads are unchanged. An older backend returns 404 for this endpoint; the Monitoring adapter must show integration unavailable/unsupported, not silently green. A newly installed helper may require no player restart, but updated scheduler observation writing requires the scheduler process to run the updated script. Deployment should restart scheduler/backend only with authorization, not the active encoder or kiosk.

## Non-secret example and failure fixtures

This abbreviated fixture illustrates intent; real responses include all seven components and per-component timestamp fields:

```json
{
  "schema_version": 1,
  "generated_at": "2026-11-24T18:00:00.000Z",
  "mode": "local",
  "severity": "ok",
  "summary": "Scheduled broadcast should be streaming",
  "next_action": {"action": "stop_at_deadline", "at": "2026-11-24T23:00:00.000Z"},
  "components": {
    "playback": {
      "severity": "ok", "reason": "Scheduled broadcast should be streaming",
      "observed_at": "2026-11-24T18:00:00.000Z", "age_seconds": 0, "stale": false,
      "expected": "running", "actual": "active", "intentional_pause": false,
      "transition_grace": false, "current_title": "Example sermon", "outputs": ["portrait"]
    }
  }
}
```

Failure fixtures are exercised against the actual builder in `tools/test-streamer-state.js` (`testDiagnosticsContract`):

| Scenario | Required result |
|---|---|
| Expected running, actual inactive | playback error |
| Church blocked, actual inactive | playback/encoder healthy intentional pause |
| Queue hold while encoder remains active | playback error |
| Telemetry reader unavailable | encoder unknown, not stalled |
| Stalled valid encoder progress | encoder error |
| Probe older than 120 seconds | storage stale/unknown |
| Missing Studio acknowledgement | scheduling warning |
| Calendar older than 180 seconds | scheduling unknown |
| Scheduler decision older than 90 seconds | scheduling unknown |
| Azure outside weekly window | healthy stopped intent; church calendar not required |

`tools/test-streamer-diagnostics.py` covers SAS warning boundaries and secret redaction, bounded small recording reads, overlapping-probe lock, empty media, and storage timeout. Endpoint tests verify v1 output and no slow request-driven filesystem probe. Frontend tests exercise actual rendering, escaping and retained section expansion.

## Monitoring presentation

Map playback, encoder, storage and scheduling to subordinate Streaming rows; summary includes the worst actionable reason. Keep services/resources as detail where appropriate because Monitoring already has host metrics. Export the safe auth expiry as a **Blob access** maintenance metric, distinct from its mTLS **Cert**. Retain observation ages and show unsupported/unreachable/stale as uncertainty.

The streaming page pairs full details with existing Service Health, System and Storage cards. Streamer combines playback intent and encoder health (an active unit alone cannot hide stalled playback); Scheduler pairs its service state with actual scheduling observations. Each other control unit has one row; the Azure mount is paired with storage instead of repeated as a standalone service. System resources, recording count/size/readability and Blob expiry appear only in their respective cards. Native expanders retain their state across refresh; lost diagnostics marks retained values last-known/unknown rather than leaving green service indicators.

The page no longer polls `/api/health`, `/api/system`, or `/api/storage` separately. Those legacy APIs remain available for compatibility. The bounded shared probes now also export resources `uptime_seconds`, `disk_total_bytes`, `disk_used_bytes`, and storage `total_bytes`, preserving the original useful system/storage information from the same observation. No additional browser-triggered directory scan is introduced.

Diagnostic failure does not restart or stop the player. Existing operator/timeout/church policy remains authoritative.
