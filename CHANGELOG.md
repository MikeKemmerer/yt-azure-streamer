# Changelog

## [Unreleased] — 2026-05-02

> Release candidate on `beta` branch. 36 commits since `main` (5597830).

### Features

- **Stop After Current** — new button in the Streamer card that gracefully stops the stream after the current video finishes (no mid-stream cut). Toggles to "Cancel" when a stop is pending.
- **Immediate schedule sync** — saving the schedule from the web UI now triggers `schedule-sync.sh` immediately instead of waiting up to 10 minutes for the timer.
- **Diff-based schedule sync** — `schedule-sync.sh` now fetches existing Azure Automation schedules first and only creates/updates/deletes what actually changed. Unchanged schedules are left alone, making saves near-instant.
- **Stale schedule cleanup** — removing an event or day from the schedule automatically deletes the corresponding Azure Automation schedules.
- **Audio normalization** — all audio is normalized to -14 LUFS (YouTube standard) with -1 dBTP true peak via ffmpeg's `loudnorm` filter.
- **Silent audio generation** — videos without an audio track automatically get a silent audio stream so the stream never drops.
- **Broadcast lower third** — watermark mode now renders a broadcast-style lower third with church name, current title, "Up Next" cycling on a 41-second crossfade, elapsed/total time display, and auto-wrapping multi-line titles.
- **Elapsed/total time overlay** — bottom-right time display showing current progress through the video.
- **Two-step updates** — web UI "Check for Updates" fetches latest code and shows a diff summary before applying. Auto-reloads frontend after a successful update.
- **Graceful streamer restart** — update can signal the streamer to restart between videos instead of killing mid-stream.
- **Playlist search filter** — filter videos by name in the playlist editor.
- **Inline title editing** — rename videos directly in the playlist editor (display title stored in playlist config).
- **Auto-refresh on video end** — streamer card refreshes automatically when the current video's duration expires.
- **Footer with version** — shows current branch and commit hash.

### Improvements

- **SortableJS for playlist drag-and-drop** — replaced HTML5 DnD with SortableJS for mobile/touch support.
- **No-cache headers** — Caddy now sends `Cache-Control: no-cache` for `.js`/`.css` so frontend updates take effect without hard-refresh.
- **Schedule save UX** — button disables and shows "Saving and syncing to Azure…" immediately; message persists until the result arrives; final status distinguishes success from partial failure.
- **Progress bar** — stream preview shows video progress in real-time with local ticker (syncs on API poll).
- **Copyright footer** — Kemmerer Automations.

### Fixes

- **jobSchedule ID lookup** — Azure jobSchedules API returns the GUID in `properties.jobScheduleId`, not a top-level `name` field.
- **Duplicate `esc()` function** — removed redundant declaration that shadowed the global helper.
- **Apostrophes in filenames** — ffmpeg concat playlist escaping now handles single quotes correctly.
- **Time display escaping** — multiple iterations to get `drawtext` time expressions working reliably in ffmpeg 6.1 (final: `textfile=` mode bypasses escaping entirely).
- **Progress bar rendering** — removed broken drawbox overlay; time display repositioned below channel watermark area.
- **Title suggestions** — skip videos that already have custom titles when suggesting display names.
- **Update branch tracking** — `git checkout` target branch so the reported branch name is accurate.

---

## Previous releases

All prior work is on the `main` branch at commit 5597830.
