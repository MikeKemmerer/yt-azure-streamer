#!/usr/bin/env node

/**
 * Backend API for yt-azure-streamer
 * - Reads namePrefix from /etc/yt/nameprefix
 * - Stream key management (Key Vault)
 * - Settings management (schedule.json)
 * - Video / playlist management (blobfuse2 mount + playlist-config.json)
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const config = require('./config.json');

const SCHEDULE_FILE = '/etc/yt/schedule.json';
const PLAYLIST_CONFIG = '/etc/yt/playlist-config.json';
const PLAYLIST_FILE = '/etc/yt/playlist.txt';
const STATE_FILE = '/etc/yt/playlist-state.json';
const NOW_FILE = '/run/streamer-now.json';
const RUNTIME_PLAYLIST_FILE = '/run/streamer-playlist.json';
const PREVIEW_FILE = '/opt/yt/web/frontend/stream-preview.jpg';
const MODE_FILE = '/etc/yt/mode';
const LOCAL_CONF = '/etc/yt/local.conf';
const ACTIVE_LANDSCAPE = '/run/streamer-active-landscape';
const ACTIVE_PORTRAIT = '/run/streamer-active-portrait';
const UPNEXT_FILE = '/tmp/streamer-upnext.txt';
const PORT_UPNEXT_FILE = '/tmp/streamer-upnext-portrait.txt';

function readMode() {
  try { return fs.readFileSync(MODE_FILE, 'utf8').trim(); } catch { return 'azure'; }
}

function readLocalConf() {
  try {
    const lines = fs.readFileSync(LOCAL_CONF, 'utf8').split('\n');
    const conf = {};
    for (const line of lines) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) conf[m[1]] = m[2];
    }
    return conf;
  } catch { return {}; }
}

function getVideoDir() {
  if (readMode() === 'local') {
    return readLocalConf().VIDEO_DIR || '/mnt/videos';
  }
  return '/mnt/blobfuse2';
}

// Returns mode-appropriate service lists.
// healthUnits: systemd units checked for active state in /api/health.
// logServices: units whose journal logs are exposed via /api/logs.
// The schedule-sync timer and service are intentionally separated:
// the .timer unit reflects scheduling health; the .service unit carries the log output.
function getServiceConfig() {
  const mode = readMode();
  if (mode === 'local') {
    const services = ['streamer.service', 'scheduler.service', 'caddy.service', 'web-backend.service'];
    return { healthUnits: services, logServices: services };
  }
  return {
    healthUnits: ['streamer.service', 'scheduler.service', 'schedule-sync.timer', 'caddy.service', 'web-backend.service', 'mnt-blobfuse2.mount'],
    logServices:  ['streamer.service', 'scheduler.service', 'schedule-sync.service', 'caddy.service', 'web-backend.service', 'mnt-blobfuse2.mount']
  };
}

const VIDEO_DIR = getVideoDir();
const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.mov', '.avi', '.ts', '.flv'];

// Duration cache: filename → seconds (avoids repeated ffprobe calls)
const durationCache = new Map();

function probeDuration(filePath) {
  const basename = path.basename(filePath);
  if (durationCache.has(basename)) return durationCache.get(basename);
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'csv=p=0', filePath
    ], { timeout: 10000 }).toString().trim();
    const seconds = Math.round(parseFloat(out) || 0);
    durationCache.set(basename, seconds);
    return seconds;
  } catch { return 0; }
}

function readNowPlaying() {
  try {
    return JSON.parse(fs.readFileSync(NOW_FILE, 'utf8'));
  } catch { return null; }
}

function readPrefix() {
  try {
    return fs.readFileSync(config.prefixFile, 'utf8').trim();
  } catch {
    return "unknown";
  }
}

function kvName() {
  return readPrefix().toLowerCase() + '-kv';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 65536) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function jsonResponse(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readSchedule() {
  try {
    return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
  } catch {
    return { timezone: 'UTC', events: [], stream: { max_resolution: '720p', shuffle: false } };
  }
}

function writeSchedule(schedule) {
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2) + '\n');
}

function listVideoFiles() {
  try {
    return fs.readdirSync(VIDEO_DIR)
      .filter(f => {
        const ext = path.extname(f).toLowerCase();
        return VIDEO_EXTENSIONS.includes(ext);
      })
      .sort();
  } catch {
    return [];
  }
}

function readPlaylistConfig() {
  try {
    return JSON.parse(fs.readFileSync(PLAYLIST_CONFIG, 'utf8'));
  } catch {
    return null;
  }
}

function writePlaylistConfig(cfg) {
  fs.writeFileSync(PLAYLIST_CONFIG, JSON.stringify(cfg, null, 2) + '\n');
}

const VALID_RESOLUTIONS = ['144p', '240p', '360p', '480p', '720p', '1080p', '1440p', '2160p'];

function readPlaylistOrder() {
  // Parse the ffmpeg concat playlist file into an array of basenames
  // ffmpeg concat format escapes single quotes as: '\''
  try {
    const raw = fs.readFileSync(PLAYLIST_FILE, 'utf8');
    return raw.split('\n')
      .filter(l => l.startsWith("file '"))
      .map(l => {
        const unquoted = l.replace(/^file '/, '').replace(/'$/, '');
        const unescaped = unquoted.replace(/'\\''/g, "'");
        return path.basename(unescaped);
      });
  } catch { return []; }
}

function readPlaybackState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch { return null; }
}

function readRuntimePlaylist() {
  try {
    const playlist = JSON.parse(fs.readFileSync(RUNTIME_PLAYLIST_FILE, 'utf8'));
    return Array.isArray(playlist) ? playlist.map(file => path.basename(file)) : [];
  } catch { return []; }
}

function moveVideoNext(videos, targetFile, referenceFile) {
  const reordered = videos.map(video => ({ ...video }));
  const targetIndex = reordered.findIndex(video => video.file === targetFile);
  if (targetIndex < 0 || targetFile === referenceFile) return reordered;

  const [target] = reordered.splice(targetIndex, 1);
  target.enabled = true;
  const referenceIndex = reordered.findIndex(
    video => video.file === referenceFile && video.enabled !== false
  );
  reordered.splice(referenceIndex >= 0 ? referenceIndex + 1 : 0, 0, target);
  return reordered;
}

function buildRuntimePlaylist(savedPlaylist, currentFile) {
  if (!currentFile) return [...savedPlaylist];
  const currentIndex = savedPlaylist.indexOf(currentFile);
  if (currentIndex < 0) return [...savedPlaylist];
  return [
    ...savedPlaylist.slice(currentIndex),
    ...savedPlaylist.slice(0, currentIndex)
  ];
}

function isStreamerActive() {
  try {
    execFileSync('systemctl', ['is-active', '--quiet', 'streamer.service'], { timeout: 5000 });
    return true;
  } catch { return false; }
}

function writeAtomic(file, content) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, file);
}

function wrapOverlayText(text, maxLine) {
  if (text.length <= maxLine) return text;
  const midpoint = Math.floor(text.length / 2);
  for (let distance = 0; distance < text.length; distance++) {
    const forward = midpoint + distance;
    const backward = midpoint - distance;
    if (forward < text.length && text[forward] === ' ') {
      return `${text.slice(0, forward)}\n${text.slice(forward + 1)}`;
    }
    if (backward > 0 && text[backward] === ' ') {
      return `${text.slice(0, backward)}\n${text.slice(backward + 1)}`;
    }
  }
  return text;
}

function syncActivePlaylist(videos) {
  if (!isStreamerActive()) return { updated: false, pending: false, nextFile: null };

  const now = readNowPlaying();
  const currentFile = now ? path.basename(now.file || '') : '';
  if (!currentFile) return { updated: false, pending: true, nextFile: null };

  const runtimePlaylist = buildRuntimePlaylist(readPlaylistOrder(), currentFile);
  const runtimePaths = runtimePlaylist.map(file => path.join(VIDEO_DIR, file));
  writeAtomic(RUNTIME_PLAYLIST_FILE, JSON.stringify(runtimePaths) + '\n');

  const currentIndex = runtimePlaylist.indexOf(currentFile);
  const nextFile = currentIndex >= 0
    ? runtimePlaylist[(currentIndex + 1) % runtimePlaylist.length]
    : runtimePlaylist[0] || null;
  const titleMap = new Map(videos.filter(video => video.title).map(video => [video.file, video.title]));
  const displayTitle = nextFile
    ? titleMap.get(nextFile) || nextFile.replace(/\.[^.]+$/, '')
    : '';
  const overlayText = displayTitle ? `Up Next: ${displayTitle}` : '';
  writeAtomic(UPNEXT_FILE, wrapOverlayText(overlayText, 55));
  writeAtomic(PORT_UPNEXT_FILE, wrapOverlayText(overlayText, 22));

  return { updated: true, pending: false, nextFile };
}

function buildPlaybackPosition(active, playlist, state, now) {
  const position = { nowPlaying: null, upNext: [] };
  if (playlist.length === 0) return position;

  if (active) {
    const nowFile = now ? path.basename(now.file || '') : null;
    const nowIdx = nowFile ? playlist.indexOf(nowFile) : -1;
    if (nowIdx >= 0) {
      position.nowPlaying = playlist[nowIdx];
      for (let i = 1; i <= 5 && i < playlist.length; i++) {
        position.upNext.push(playlist[(nowIdx + i) % playlist.length]);
      }
      return position;
    }

    position.nowPlaying = nowFile || playlist[0];
    const firstUpcoming = nowFile ? 0 : 1;
    for (let i = firstUpcoming; i < firstUpcoming + 5 && i < playlist.length; i++) {
      position.upNext.push(playlist[i]);
    }
    return position;
  }

  const lastIdx = state ? state.index : -1;
  const lastFile = state ? path.basename(state.file || '') : '';
  let bookmarkIdx = -1;
  if (lastIdx >= 0 && lastIdx < playlist.length && playlist[lastIdx] === lastFile) {
    bookmarkIdx = lastIdx;
  } else if (lastFile) {
    bookmarkIdx = playlist.indexOf(lastFile);
  }

  const resumeIdx = bookmarkIdx >= 0 ? (bookmarkIdx + 1) % playlist.length : 0;
  for (let i = 0; i < 5 && i < playlist.length; i++) {
    position.upNext.push(playlist[(resumeIdx + i) % playlist.length]);
  }
  return position;
}

const server = http.createServer(async (req, res) => {
  try {
    // ─── GET /api/info ─────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/api/info') {
      const prefix = readPrefix();
      const mode = readMode();
      let hostname = '';
      try { hostname = require('os').hostname(); } catch {}
      let version = '';
      try { version = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: '/opt/yt', timeout: 5000 }).toString().trim(); } catch {}
      let branch = '';
      try { branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: '/opt/yt', timeout: 5000 }).toString().trim(); } catch {}
      const info = { prefix, mode, hostname, version, branch };
      if (mode === 'azure') {
        info.storageAccount = config.storageAccountTemplate.replace("STORAGE_ACCOUNT", prefix.toLowerCase());
        info.automationAccount = config.automationAccountTemplate.replace("AUTOMATION_ACCOUNT", prefix + "-automation");
        info.keyVault = prefix.toLowerCase() + '-kv';
      } else {
        info.videoDir = getVideoDir();
      }
      jsonResponse(res, 200, info);
      return;
    }

    // ─── POST /api/stream-key ──────────────────────────────────────
    if (req.method === 'POST' && req.url === '/api/stream-key') {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        return jsonResponse(res, 400, { error: 'Invalid JSON' });
      }
      const key = parsed.streamKey;
      const profile = parsed.profile || 'landscape';  // 'landscape' or 'portrait'
      if (!key || typeof key !== 'string' || key.length < 4 || key.length > 256) {
        return jsonResponse(res, 400, { error: 'streamKey must be 4-256 characters' });
      }
      if (!['landscape', 'portrait'].includes(profile)) {
        return jsonResponse(res, 400, { error: 'profile must be "landscape" or "portrait"' });
      }

      // Determine key name from streams config
      const schedule = readSchedule();
      const streams = schedule.streams || {};
      const streamCfg = streams[profile] || {};
      const keyName = streamCfg.stream_key_name || (profile === 'portrait' ? 'youtube-stream-key-portrait' : 'youtube-stream-key');

      if (readMode() === 'local') {
        try {
          const keyFile = `/etc/yt/secrets/${keyName}`;
          fs.writeFileSync(keyFile, key + '\n', { mode: 0o600 });
          return jsonResponse(res, 200, { ok: true, profile });
        } catch (e) {
          return jsonResponse(res, 500, { error: 'Failed to write stream key: ' + e.message });
        }
      }
      const vault = kvName();
      execFile('az', [
        'keyvault', 'secret', 'set',
        '--vault-name', vault, '--name', keyName,
        '--value', key, '-o', 'none'
      ], { timeout: 30000 }, (err) => {
        if (err) return jsonResponse(res, 500, { error: `Failed to update stream key '${keyName}' in Key Vault` });
        jsonResponse(res, 200, { ok: true, profile });
      });
      return;
    }

    // ─── GET /api/settings ─────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/api/settings') {
      const schedule = readSchedule();
      jsonResponse(res, 200, {
        max_resolution: schedule.stream?.max_resolution || '720p',
        shuffle: schedule.stream?.shuffle || false,
        watermark: schedule.stream?.watermark || false,
        branding_name: schedule.stream?.branding_name || '',
        branding_location: schedule.stream?.branding_location || '',
        streams: schedule.streams || {}
      });
      return;
    }

    // ─── PUT /api/settings ─────────────────────────────────────────
    if (req.method === 'PUT' && req.url === '/api/settings') {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        return jsonResponse(res, 400, { error: 'Invalid JSON' });
      }
      const schedule = readSchedule();
      if (!schedule.stream) schedule.stream = {};
      if (parsed.max_resolution !== undefined) {
        if (!VALID_RESOLUTIONS.includes(parsed.max_resolution)) {
          return jsonResponse(res, 400, { error: 'Invalid resolution. Valid: ' + VALID_RESOLUTIONS.join(', ') });
        }
        schedule.stream.max_resolution = parsed.max_resolution;
      }
      if (parsed.shuffle !== undefined) {
        schedule.stream.shuffle = !!parsed.shuffle;
      }
      if (parsed.watermark !== undefined) {
        schedule.stream.watermark = !!parsed.watermark;
      }
      if (parsed.branding_name !== undefined) {
        schedule.stream.branding_name = String(parsed.branding_name).slice(0, 200);
      }
      if (parsed.branding_location !== undefined) {
        schedule.stream.branding_location = String(parsed.branding_location).slice(0, 200);
      }
      // Per-stream config updates
      if (parsed.streams && typeof parsed.streams === 'object') {
        if (!schedule.streams) schedule.streams = {};
        for (const profile of ['landscape', 'portrait']) {
          if (parsed.streams[profile] && typeof parsed.streams[profile] === 'object') {
            if (!schedule.streams[profile]) schedule.streams[profile] = {};
            const src = parsed.streams[profile];
            const dst = schedule.streams[profile];
            if (src.name !== undefined) dst.name = String(src.name).slice(0, 100);
            if (src.stream_key_name !== undefined) dst.stream_key_name = String(src.stream_key_name).slice(0, 100);
            if (src.max_resolution !== undefined) {
              if (!VALID_RESOLUTIONS.includes(src.max_resolution)) {
                return jsonResponse(res, 400, { error: `Invalid ${profile} resolution. Valid: ${VALID_RESOLUTIONS.join(', ')}` });
              }
              dst.max_resolution = src.max_resolution;
            }
            if (src.watermark !== undefined) dst.watermark = !!src.watermark;
            if (src.church_name !== undefined) dst.church_name = String(src.church_name).slice(0, 200);
            if (src.church_location !== undefined) dst.church_location = String(src.church_location).slice(0, 200);
          }
        }
      }
      writeSchedule(schedule);
      jsonResponse(res, 200, {
        max_resolution: schedule.stream.max_resolution,
        shuffle: schedule.stream.shuffle,
        watermark: schedule.stream.watermark,
        streams: schedule.streams || {}
      });
      return;
    }

    // ─── GET /api/videos ───────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/api/videos') {
      const allFiles = listVideoFiles();
      const playlistCfg = readPlaylistConfig();

      let videos;
      if (playlistCfg && Array.isArray(playlistCfg.videos)) {
        // Start from saved config, preserving order
        const known = new Set(playlistCfg.videos.map(v => v.file));
        videos = playlistCfg.videos
          .filter(v => allFiles.includes(v.file))  // remove deleted files
          .map(v => ({ file: v.file, enabled: v.enabled !== false, title: v.title || '' }));
        // Append any new files not yet in config
        for (const f of allFiles) {
          if (!known.has(f)) videos.push({ file: f, enabled: true, title: '' });
        }
      } else {
        videos = allFiles.map(f => ({ file: f, enabled: true, title: '' }));
      }
      jsonResponse(res, 200, { videos });
      return;
    }

    // ─── PUT /api/videos ───────────────────────────────────────────
    if (req.method === 'PUT' && req.url === '/api/videos') {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        return jsonResponse(res, 400, { error: 'Invalid JSON' });
      }
      if (!Array.isArray(parsed.videos)) {
        return jsonResponse(res, 400, { error: 'videos must be an array' });
      }
      const allFiles = new Set(listVideoFiles());
      let videos = parsed.videos
        .filter(v => v.file && typeof v.file === 'string' && allFiles.has(v.file))
        .map(v => ({ file: v.file, enabled: v.enabled !== false, title: v.title ? String(v.title).slice(0, 200) : '' }));

      const playNext = typeof parsed.playNext === 'string' ? parsed.playNext : '';
      if (playNext) {
        if (!videos.some(video => video.file === playNext)) {
          return jsonResponse(res, 400, { error: 'Play Next video is not in the playlist' });
        }
        const active = isStreamerActive();
        const reference = active ? readNowPlaying() : readPlaybackState();
        const referenceFile = reference ? path.basename(reference.file || '') : '';
        if (playNext === referenceFile) {
          return jsonResponse(res, 409, { error: 'That video is already playing' });
        }
        videos = moveVideoNext(videos, playNext, referenceFile);
      }

      writePlaylistConfig({ videos });

      // Regenerate the ffmpeg playlist immediately
      try {
        execFileSync('/usr/local/bin/generate-playlist.sh', [], { timeout: 15000 });
      } catch {
        return jsonResponse(res, 500, { error: 'Playlist was saved but could not be regenerated' });
      }

      const runtime = syncActivePlaylist(videos);
      jsonResponse(res, 200, {
        ok: true,
        count: videos.length,
        videos,
        runtimeUpdated: runtime.updated,
        runtimePending: runtime.pending,
        nextFile: runtime.nextFile
      });
      return;
    }

    // ─── GET /api/streamer ──────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/api/streamer') {
      execFile('systemctl', ['show', 'streamer.service', '--property=ActiveState,ActiveEnterTimestamp'],
        { timeout: 5000 }, (err, stdout) => {
        const props = {};
        for (const line of stdout.trim().split('\n')) {
          const [k, ...v] = line.split('=');
          props[k] = v.join('=');
        }
        const active = props.ActiveState === 'active';
        let uptimeSeconds = null;
        if (active && props.ActiveEnterTimestamp) {
          const entered = new Date(props.ActiveEnterTimestamp);
          if (!isNaN(entered)) uptimeSeconds = Math.floor((Date.now() - entered.getTime()) / 1000);
        }
        const savedPlaylist = readPlaylistOrder();
        const runtimePlaylist = active ? readRuntimePlaylist() : [];
        const playlist = active && runtimePlaylist.length > 0 ? runtimePlaylist : savedPlaylist;
        const state = readPlaybackState();
        const now = active ? readNowPlaying() : null;
        const stopPending = fs.existsSync('/run/streamer-stop-after-current');
        const activeStreams = {
          landscape: fs.existsSync(ACTIVE_LANDSCAPE),
          portrait: fs.existsSync(ACTIVE_PORTRAIT)
        };
        const result = { active, uptimeSeconds, nowPlaying: null, upNext: [], progress: null, stopPending, activeStreams };
        const position = buildPlaybackPosition(active, playlist, state, now);
        result.nowPlaying = position.nowPlaying;
        result.upNext = position.upNext.map(name => ({
          name, duration: probeDuration(path.join(VIDEO_DIR, name))
        }));

        // Progress of current video (from /run/streamer-now.json)
        if (active && now && now.startedAt && now.duration) {
          const elapsed = Math.floor(Date.now() / 1000) - now.startedAt;
          result.progress = {
            elapsed: Math.min(elapsed, now.duration),
            duration: now.duration
          };
        }

        // Resolve display titles from playlist config
        const cfg = readPlaylistConfig();
        const titleMap = new Map();
        if (cfg && Array.isArray(cfg.videos)) {
          for (const v of cfg.videos) {
            if (v.title) titleMap.set(v.file, v.title);
          }
        }
        const displayName = (filename) => titleMap.get(filename) || filename.replace(/\.[^.]+$/, '');
        if (result.nowPlaying) result.nowPlaying = displayName(result.nowPlaying);
        result.upNext = result.upNext.map(item => ({
          ...item, name: displayName(item.name)
        }));

        jsonResponse(res, 200, result);
      });
      return;
    }

    // ─── POST /api/streamer/start ──────────────────────────────────
    if (req.method === 'POST' && req.url === '/api/streamer/start') {
      // Set manual override so the scheduler won't auto-stop
      try { fs.writeFileSync('/run/streamer-manual-override', ''); } catch {};
      // Clear manual stop in case user is re-starting after a manual stop
      try { fs.unlinkSync('/run/streamer-manual-stop'); } catch {};
      // Parse which streams to activate (default: both)
      let streams = ['landscape', 'portrait'];
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body);
        if (Array.isArray(parsed.streams)) {
          streams = parsed.streams.filter(s => ['landscape', 'portrait'].includes(s));
        }
      } catch { /* use defaults */ }
      // Write stream signal files
      try { fs.unlinkSync(ACTIVE_LANDSCAPE); } catch {}
      try { fs.unlinkSync(ACTIVE_PORTRAIT); } catch {}
      if (streams.includes('landscape')) {
        try { fs.writeFileSync(ACTIVE_LANDSCAPE, ''); } catch {}
      }
      if (streams.includes('portrait')) {
        try { fs.writeFileSync(ACTIVE_PORTRAIT, ''); } catch {}
      }
      execFile('systemctl', ['start', 'streamer.service'], { timeout: 15000 }, (err) => {
        if (err) return jsonResponse(res, 500, { error: 'Failed to start streamer' });
        jsonResponse(res, 200, { ok: true, active: true, streams });
      });
      return;
    }

    // ─── POST /api/streamer/stop ───────────────────────────────────
    if (req.method === 'POST' && req.url === '/api/streamer/stop') {
      // Clear manual override so the scheduler resumes control
      try { fs.unlinkSync('/run/streamer-manual-override'); } catch {};
      // Set manual stop so the scheduler won't restart during current window
      try { fs.writeFileSync('/run/streamer-manual-stop', ''); } catch {};
      execFile('systemctl', ['stop', 'streamer.service'], { timeout: 15000 }, (err) => {
        if (err) return jsonResponse(res, 500, { error: 'Failed to stop streamer' });
        jsonResponse(res, 200, { ok: true, active: false });
      });
      return;
    }

    // ─── POST /api/streamer/restart ────────────────────────────────
    if (req.method === 'POST' && req.url === '/api/streamer/restart') {
      execFile('systemctl', ['restart', 'streamer.service'], { timeout: 30000 }, (err) => {
        if (err) return jsonResponse(res, 500, { error: 'Failed to restart streamer' });
        jsonResponse(res, 200, { ok: true });
      });
      return;
    }

    // ─── POST /api/streamer/skip ───────────────────────────────────
    // Kill the current ffmpeg stream process, causing the loop to advance
    if (req.method === 'POST' && req.url === '/api/streamer/skip') {
      execFile('pkill', ['-f', 'ffmpeg.*flv.*rtmp'], { timeout: 5000 }, (err) => {
        // pkill returns 1 if no process found — not a real error for us
        jsonResponse(res, 200, { ok: true });
      });
      return;
    }

    // ─── POST /api/streamer/stop-after-current ─────────────────────
    // Signal the streamer to stop gracefully after the current video ends
    if (req.method === 'POST' && req.url === '/api/streamer/stop-after-current') {
      const signal = '/run/streamer-stop-after-current';
      try {
        fs.writeFileSync(signal, '');
        jsonResponse(res, 200, { ok: true, pending: true });
      } catch (e) {
        jsonResponse(res, 500, { error: 'Failed to write stop signal' });
      }
      return;
    }

    // ─── DELETE /api/streamer/stop-after-current ────────────────────
    // Cancel a pending stop-after-current
    if (req.method === 'DELETE' && req.url === '/api/streamer/stop-after-current') {
      try { fs.unlinkSync('/run/streamer-stop-after-current'); } catch {}
      jsonResponse(res, 200, { ok: true, pending: false });
      return;
    }

    // ─── GET /api/health ───────────────────────────────────────────
    // Returns status of all systemd units at a glance
    if (req.method === 'GET' && req.url === '/api/health') {
      const { healthUnits: units } = getServiceConfig();
      execFile('systemctl', ['is-active', ...units], { timeout: 5000 }, (err, stdout) => {
        const states = stdout.trim().split('\n');
        const result = {};
        units.forEach((u, i) => { result[u] = states[i] || 'unknown'; });
        jsonResponse(res, 200, result);
      });
      return;
    }

    // ─── GET /api/logs?service=...&lines=... ───────────────────────
    // Tail journalctl logs for a given service
    if (req.method === 'GET' && req.url.startsWith('/api/logs')) {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const service = params.get('service') || 'streamer.service';
      const lines = Math.min(Math.max(parseInt(params.get('lines')) || 100, 10), 500);
      // Whitelist allowed services
      const { logServices: allowed } = getServiceConfig();
      if (!allowed.includes(service)) {
        return jsonResponse(res, 400, { error: 'Invalid service. Allowed: ' + allowed.join(', ') });
      }
      execFile('journalctl', ['-u', service, '-n', String(lines), '--no-pager', '-o', 'short-iso'],
        { timeout: 10000, maxBuffer: 1024 * 512 }, (err, stdout) => {
          jsonResponse(res, 200, { service, lines: stdout || '' });
        });
      return;
    }

    // ─── POST /api/vm/deallocate ──────────────────────────────────
    // Deallocate the VM via Azure Automation (stops billing)
    if (req.method === 'POST' && req.url === '/api/vm/deallocate') {
      if (readMode() !== 'azure') {
        return jsonResponse(res, 400, { error: 'VM deallocate is only available in Azure mode' });
      }
      let prefix, rg;
      try {
        prefix = fs.readFileSync('/etc/yt/nameprefix', 'utf8').trim();
        rg = fs.readFileSync('/etc/yt/resourcegroup', 'utf8').trim();
      } catch (e) {
        return jsonResponse(res, 500, { error: 'Cannot read VM config: ' + e.message });
      }
      const aa = prefix + '-automation';
      const vm = prefix + '-vm';
      // Trigger the Stop-StreamerVM runbook via Azure Automation
      execFile('az', [
        'automation', 'runbook', 'start',
        '--automation-account-name', aa,
        '--resource-group', rg,
        '--name', 'Stop-StreamerVM',
        '--parameters', `ResourceGroupName=${rg}`, `VMName=${vm}`
      ], { timeout: 30000 }, (err, stdout, stderr) => {
        if (err) {
          console.error('VM deallocate failed:', stderr || err.message);
          return jsonResponse(res, 500, { error: 'Failed to trigger VM deallocate: ' + (stderr || err.message).slice(0, 500) });
        }
        jsonResponse(res, 200, { ok: true, message: 'VM deallocate triggered. The VM will shut down and stop billing shortly.' });
      });
      return;
    }

    // ─── GET /api/schedule ─────────────────────────────────────────
    // Returns the full schedule with computed next start/stop times
    if (req.method === 'GET' && req.url === '/api/schedule') {
      const schedule = readSchedule();
      // Compute next event from schedule (considering overrides)
      const now = new Date();
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      let nextStart = null, nextStop = null;

      // Build a set of override dates for quick lookup
      const overrideMap = {};
      for (const o of (schedule.overrides || [])) {
        overrideMap[o.date] = o;
      }

      for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
        const d = new Date(now.getTime() + dayOffset * 86400000);
        const dateStr = d.toISOString().slice(0, 10);
        const dayName = dayNames[d.getDay()];

        // Check if this date has an override
        if (overrideMap[dateStr]) {
          const o = overrideMap[dateStr];
          if (o.start && o.stop) {
            const [sh, sm] = o.start.split(':').map(Number);
            const [eh, em] = o.stop.split(':').map(Number);
            const startTime = new Date(d); startTime.setHours(sh, sm, 0, 0);
            const stopTime = new Date(d); stopTime.setHours(eh, em, 0, 0);
            if (stopTime <= startTime) stopTime.setDate(stopTime.getDate() + 1);
            if (!nextStart && startTime > now) nextStart = startTime.toISOString();
            if (!nextStop && stopTime > now) nextStop = stopTime.toISOString();
          }
          // Override replaces weekly schedule for this date — skip events
          if (nextStart && nextStop) break;
          continue;
        }

        for (const evt of (schedule.events || [])) {
          if (!evt.days || !evt.days.includes(dayName)) continue;
          const [sh, sm] = (evt.start || '00:00').split(':').map(Number);
          const [eh, em] = (evt.stop || '00:00').split(':').map(Number);
          const startTime = new Date(d); startTime.setHours(sh, sm, 0, 0);
          const stopTime = new Date(d); stopTime.setHours(eh, em, 0, 0);
          if (!nextStart && startTime > now) nextStart = startTime.toISOString();
          if (!nextStop && stopTime > now) nextStop = stopTime.toISOString();
          if (nextStart && nextStop) break;
        }
        if (nextStart && nextStop) break;
      }

      let todayLocal;
      try {
        todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: schedule.timezone || 'UTC' }).format(now);
      } catch {
        todayLocal = now.toISOString().slice(0, 10);
      }
      jsonResponse(res, 200, {
        timezone: schedule.timezone || 'UTC',
        events: schedule.events || [],
        overrides: (schedule.overrides || []).filter(o => o.date >= todayLocal),
        stream: schedule.stream || {},
        streams: schedule.streams || {},
        nextStart,
        nextStop
      });
      return;
    }

    // ─── PUT /api/schedule ─────────────────────────────────────────
    // Update the full schedule (events + timezone)
    if (req.method === 'PUT' && req.url === '/api/schedule') {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        return jsonResponse(res, 400, { error: 'Invalid JSON' });
      }
      const schedule = readSchedule();
      if (parsed.timezone !== undefined) {
        schedule.timezone = String(parsed.timezone);
      }
      if (Array.isArray(parsed.events)) {
        const validDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        const validStreams = ['landscape', 'portrait'];
        schedule.events = parsed.events
          .filter(e => e.name && e.start && e.stop && Array.isArray(e.days))
          .map(e => ({
            name: String(e.name).slice(0, 100),
            start: String(e.start).slice(0, 5),
            stop: String(e.stop).slice(0, 5),
            days: e.days.filter(d => validDays.includes(d)),
            streams: Array.isArray(e.streams) ? e.streams.filter(s => validStreams.includes(s)) : ['landscape']
          }));
      }
      writeSchedule(schedule);

      // In local mode, scheduler.service reads schedule.json directly — no sync needed
      if (readMode() === 'local') {
        return jsonResponse(res, 200, { ok: true, synced: true });
      }

      // Trigger immediate sync to Azure Automation Account
      execFile('/usr/local/bin/schedule-sync.sh', [], { timeout: 60000 }, (err, stdout, stderr) => {
        if (err) {
          console.error('schedule-sync failed:', stderr || err.message);
          return jsonResponse(res, 200, { ok: true, syncError: (stderr || err.message).slice(0, 500) });
        }
        jsonResponse(res, 200, { ok: true, synced: true });
      });
      return;
    }

    // ─── GET /api/overrides ───────────────────────────────────────
    // Returns the list of schedule overrides (future only)
    if (req.method === 'GET' && req.url === '/api/overrides') {
      const schedule = readSchedule();
      let today;
      try {
        today = new Intl.DateTimeFormat('en-CA', { timeZone: schedule.timezone || 'UTC' }).format(new Date());
      } catch {
        today = new Date().toISOString().slice(0, 10);
      }
      const overrides = (schedule.overrides || []).filter(o => o.date >= today);
      jsonResponse(res, 200, { overrides });
      return;
    }

    // ─── PUT /api/overrides ───────────────────────────────────────
    // Add or update a one-time schedule override for a specific date
    if (req.method === 'PUT' && req.url === '/api/overrides') {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        return jsonResponse(res, 400, { error: 'Invalid JSON' });
      }
      if (!parsed.date || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) {
        return jsonResponse(res, 400, { error: 'date is required (YYYY-MM-DD)' });
      }
      const schedule = readSchedule();
      if (!Array.isArray(schedule.overrides)) schedule.overrides = [];
      const tz = parsed.timezone || schedule.timezone || 'UTC';
      let today;
      try {
        today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
      } catch {
        today = new Date().toISOString().slice(0, 10);
      }
      if (parsed.date < today) {
        return jsonResponse(res, 400, { error: 'Cannot create override in the past' });
      }
      // Validate start/stop if provided (both or neither, unless startNow)
      const hasStart = parsed.start !== undefined && parsed.start !== null;
      const hasStop = parsed.stop !== undefined && parsed.stop !== null;
      const startNow = !!parsed.startNow;
      if (!startNow && hasStart !== hasStop) {
        return jsonResponse(res, 400, { error: 'Provide both start and stop, or neither (to skip the day)' });
      }
      if (!hasStart && !hasStop && !startNow) {
        // skip-day override — no times needed
      } else if (!hasStop) {
        return jsonResponse(res, 400, { error: 'Provide a stop time' });
      }
      if (hasStart && !/^\d{2}:\d{2}$/.test(parsed.start)) {
        return jsonResponse(res, 400, { error: 'start must be HH:MM format' });
      }
      if (hasStop && !/^\d{2}:\d{2}$/.test(parsed.stop)) {
        return jsonResponse(res, 400, { error: 'stop must be HH:MM format' });
      }

      // Prune past overrides
      schedule.overrides = schedule.overrides.filter(o => o.date >= today);

      // Upsert by date
      const idx = schedule.overrides.findIndex(o => o.date === parsed.date);
      // Validate streams if provided
      const VALID_STREAMS = ['landscape', 'portrait'];
      let streams;
      if (Array.isArray(parsed.streams) && parsed.streams.length > 0) {
        streams = parsed.streams.filter(s => VALID_STREAMS.includes(s));
        if (streams.length === 0) streams = undefined;
      }
      const entry = {
        date: parsed.date,
        start: hasStart ? String(parsed.start).slice(0, 5) : null,
        stop: hasStop ? String(parsed.stop).slice(0, 5) : null,
        startNow: startNow || undefined,
        name: parsed.name ? String(parsed.name).slice(0, 100) : undefined,
        timezone: parsed.timezone ? String(parsed.timezone).slice(0, 50) : undefined,
        streams
      };
      if (idx >= 0) {
        schedule.overrides[idx] = entry;
      } else {
        schedule.overrides.push(entry);
      }
      // Sort by date
      schedule.overrides.sort((a, b) => a.date.localeCompare(b.date));
      writeSchedule(schedule);

      // Trigger sync in Azure mode
      if (readMode() === 'local') {
        return jsonResponse(res, 200, { ok: true, synced: true });
      }
      execFile('/usr/local/bin/schedule-sync.sh', [], { timeout: 60000 }, (err, stdout, stderr) => {
        if (err) {
          console.error('schedule-sync failed:', stderr || err.message);
          return jsonResponse(res, 200, { ok: true, syncError: (stderr || err.message).slice(0, 500) });
        }
        jsonResponse(res, 200, { ok: true, synced: true });
      });
      return;
    }

    // ─── DELETE /api/overrides ────────────────────────────────────
    // Remove an override by date (query param: ?date=YYYY-MM-DD)
    if (req.method === 'DELETE' && req.url.startsWith('/api/overrides')) {
      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      const date = urlObj.searchParams.get('date');
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return jsonResponse(res, 400, { error: 'date query param required (YYYY-MM-DD)' });
      }
      const schedule = readSchedule();
      if (!Array.isArray(schedule.overrides)) schedule.overrides = [];
      const before = schedule.overrides.length;
      schedule.overrides = schedule.overrides.filter(o => o.date !== date);
      if (schedule.overrides.length === before) {
        return jsonResponse(res, 404, { error: 'No override found for that date' });
      }
      writeSchedule(schedule);

      // Trigger sync in Azure mode
      if (readMode() === 'local') {
        return jsonResponse(res, 200, { ok: true, synced: true });
      }
      execFile('/usr/local/bin/schedule-sync.sh', [], { timeout: 60000 }, (err, stdout, stderr) => {
        if (err) {
          console.error('schedule-sync failed:', stderr || err.message);
          return jsonResponse(res, 200, { ok: true, syncError: (stderr || err.message).slice(0, 500) });
        }
        jsonResponse(res, 200, { ok: true, synced: true });
      });
      return;
    }

    // ─── GET /api/branches ──────────────────────────────────────────
    // List remote branches from origin
    if (req.method === 'GET' && req.url === '/api/branches') {
      const repoDir = '/opt/yt';
      const gitOpts = { cwd: repoDir, timeout: 30000, env: { ...process.env, HOME: '/root', GIT_TERMINAL_PROMPT: '0' } };
      try {
        execFileSync('git', ['fetch', '--prune', 'origin'], gitOpts);
      } catch (e) {
        return jsonResponse(res, 500, { error: 'Fetch failed', output: e.stderr ? e.stderr.toString() : e.message });
      }
      let branches = [];
      try {
        const raw = execFileSync('git', ['branch', '-r', '--format=%(refname:short)'], gitOpts).toString().trim();
        branches = raw.split('\n')
          .map(b => b.replace(/^origin\//, ''))
          .filter(b => b && b !== 'HEAD');
      } catch (e) {
        return jsonResponse(res, 500, { error: 'Failed to list branches', output: e.message });
      }
      let currentBranch = 'main';
      try {
        currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], gitOpts).toString().trim();
      } catch {}
      return jsonResponse(res, 200, { branches, currentBranch });
    }

    // ─── POST /api/update/check ───────────────────────────────────
    // Fetch latest and show what would change (without applying)
    if (req.method === 'POST' && req.url === '/api/update/check') {
      const body = await readBody(req);
      let branch = 'main';
      try {
        const parsed = JSON.parse(body);
        if (parsed.branch) {
          if (/^[a-zA-Z0-9._/-]+$/.test(parsed.branch)) {
            branch = parsed.branch;
          } else {
            return jsonResponse(res, 400, { error: `Invalid branch name: ${parsed.branch}` });
          }
        }
      } catch { /* default to main */ }

      const repoDir = '/opt/yt';
      const gitOpts = { cwd: repoDir, timeout: 30000, env: { ...process.env, HOME: '/root', GIT_TERMINAL_PROMPT: '0' } };

      try {
        execFileSync('git', ['fetch', 'origin', branch], gitOpts);
      } catch (e) {
        return jsonResponse(res, 500, { error: 'Fetch failed', output: e.stderr ? e.stderr.toString() : e.message });
      }

      let localHead, remoteHead;
      try {
        localHead = execFileSync('git', ['rev-parse', 'HEAD'], gitOpts).toString().trim();
        remoteHead = execFileSync('git', ['rev-parse', `origin/${branch}`], gitOpts).toString().trim();
      } catch (e) {
        return jsonResponse(res, 500, { error: 'Failed to read refs', output: e.message });
      }

      if (localHead === remoteHead) {
        return jsonResponse(res, 200, { upToDate: true, branch, localHead });
      }

      let commits = '', diffStat = '';
      try {
        commits = execFileSync('git', ['log', '--oneline', `${localHead}..origin/${branch}`], gitOpts).toString().trim();
        diffStat = execFileSync('git', ['diff', '--stat', `${localHead}..origin/${branch}`], gitOpts).toString().trim();
      } catch { /* non-fatal */ }

      return jsonResponse(res, 200, {
        upToDate: false,
        branch,
        localHead: localHead.slice(0, 7),
        remoteHead: remoteHead.slice(0, 7),
        commits,
        diffStat
      });
    }

    // ─── POST /api/update ─────────────────────────────────────────
    // Pull latest code and re-deploy changed files
    if (req.method === 'POST' && req.url === '/api/update') {
      const body = await readBody(req);
      let branch = 'main';
      try {
        const parsed = JSON.parse(body);
        if (parsed.branch) {
          if (/^[a-zA-Z0-9._/-]+$/.test(parsed.branch)) {
            branch = parsed.branch;
          } else {
            return jsonResponse(res, 400, { error: `Invalid branch name: ${parsed.branch}` });
          }
        }
      } catch { /* default to main */ }
      const args = ['--branch', branch];
      execFile('/usr/local/bin/yt-update.sh', args, {
        timeout: 60000,
        maxBuffer: 1024 * 256,
        env: { ...process.env, HOME: '/root', GIT_TERMINAL_PROMPT: '0' }
      }, (err, stdout, stderr) => {
        const output = (stdout || '') + (stderr || '');
        if (err && !stdout) {
          return jsonResponse(res, 500, { error: 'Update failed', output: output || err.message });
        }
        // Check if streamer-related files were updated (indicates restart needed)
        const streamerPending = /services\/streamer\/|streamer\.sh|streamer\.service/.test(output);
        jsonResponse(res, 200, { ok: true, output, streamerPending });
      });
      return;
    }

    // ─── POST /api/streamer/restart-after-current ─────────────────
    // Signal the streamer to restart after the current video finishes
    if (req.method === 'POST' && req.url === '/api/streamer/restart-after-current') {
      const signalFile = '/run/streamer-restart-requested';
      try {
        fs.writeFileSync(signalFile, new Date().toISOString());
        jsonResponse(res, 200, { ok: true, message: 'Restart scheduled after current video.' });
      } catch (e) {
        jsonResponse(res, 500, { error: 'Failed to write signal file', detail: e.message });
      }
      return;
    }

    // ─── GET /api/streamer/restart-pending ────────────────────────
    // Check if a restart is already pending
    if (req.method === 'GET' && req.url === '/api/streamer/restart-pending') {
      const pending = fs.existsSync('/run/streamer-restart-requested');
      jsonResponse(res, 200, { pending });
      return;
    }

    // ─── POST /api/videos/upload ─────────────────────────────────
    // Stream-upload a video file to the video directory
    if (req.method === 'POST' && req.url.startsWith('/api/videos/upload')) {
      const filename = decodeURIComponent(req.headers['x-filename'] || '').replace(/[/\\]/g, '');
      if (!filename) return jsonResponse(res, 400, { error: 'Missing X-Filename header' });
      const ext = path.extname(filename).toLowerCase();
      if (!VIDEO_EXTENSIONS.includes(ext)) {
        return jsonResponse(res, 400, { error: `Invalid extension: ${ext}. Allowed: ${VIDEO_EXTENSIONS.join(', ')}` });
      }
      const dest = path.join(VIDEO_DIR, filename);
      if (fs.existsSync(dest)) {
        return jsonResponse(res, 409, { error: 'File already exists' });
      }
      const tmpDest = dest + '.uploading';
      const ws = fs.createWriteStream(tmpDest);
      let bytes = 0;
      req.on('data', chunk => { bytes += chunk.length; ws.write(chunk); });
      req.on('end', () => {
        ws.end(() => {
          try {
            fs.renameSync(tmpDest, dest);
            jsonResponse(res, 200, { ok: true, file: filename, bytes });
          } catch (e) {
            try { fs.unlinkSync(tmpDest); } catch {}
            jsonResponse(res, 500, { error: 'Failed to finalize upload: ' + e.message });
          }
        });
      });
      req.on('error', () => {
        ws.destroy();
        try { fs.unlinkSync(tmpDest); } catch {}
        jsonResponse(res, 500, { error: 'Upload stream error' });
      });
      return;
    }

    // ─── GET /api/storage ──────────────────────────────────────────
    // File count and total size of videos on blobfuse2 mount
    if (req.method === 'GET' && req.url === '/api/storage') {
      const files = listVideoFiles();
      let totalBytes = 0;
      for (const f of files) {
        try {
          const st = fs.statSync(path.join(VIDEO_DIR, f));
          totalBytes += st.size;
        } catch { /* skip */ }
      }
      jsonResponse(res, 200, {
        fileCount: files.length,
        totalBytes,
        totalGB: +(totalBytes / (1024 * 1024 * 1024)).toFixed(2)
      });
      return;
    }

    // ─── GET /api/system ───────────────────────────────────────────
    // Basic VM stats: uptime, memory, disk, cpu
    if (req.method === 'GET' && req.url === '/api/system') {
      const result = { uptime: '', memory: {}, disk: {}, cpu: {} };
      try {
        result.uptime = fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0];
      } catch {}
      try {
        const loadavg = fs.readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/);
        const numCpus = require('os').cpus().length;
        result.cpu = {
          load1m: parseFloat(loadavg[0]),
          load5m: parseFloat(loadavg[1]),
          load15m: parseFloat(loadavg[2]),
          cores: numCpus
        };
      } catch {}
      try {
        const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
        const totalMatch = meminfo.match(/MemTotal:\s+(\d+)/);
        const availMatch = meminfo.match(/MemAvailable:\s+(\d+)/);
        if (totalMatch && availMatch) {
          const totalMB = Math.round(parseInt(totalMatch[1]) / 1024);
          const availMB = Math.round(parseInt(availMatch[1]) / 1024);
          result.memory = { totalMB, availMB, usedMB: totalMB - availMB };
        }
      } catch {}
      try {
        const dfOut = execFileSync('df', ['-B1', '--output=size,used,avail', '/'], { timeout: 5000 }).toString();
        const lines = dfOut.trim().split('\n');
        if (lines.length >= 2) {
          const [size, used, avail] = lines[1].trim().split(/\s+/).map(Number);
          result.disk = {
            totalGB: +(size / (1024 ** 3)).toFixed(1),
            usedGB: +(used / (1024 ** 3)).toFixed(1),
            availGB: +(avail / (1024 ** 3)).toFixed(1)
          };
        }
      } catch {}
      jsonResponse(res, 200, result);
      return;
    }

    // ─── GET /api/preview ──────────────────────────────────────────
    // Serve the latest stream preview screenshot (JPEG)
    if (req.method === 'GET' && req.url === '/api/preview') {
      try {
        const stat = fs.statSync(PREVIEW_FILE);
        // Only serve if less than 30s old
        if (Date.now() - stat.mtimeMs < 30000) {
          res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Content-Length': stat.size,
            'Cache-Control': 'no-cache'
          });
          fs.createReadStream(PREVIEW_FILE).pipe(res);
          return;
        }
      } catch {}
      res.writeHead(204);
      res.end();
      return;
    }

    jsonResponse(res, 404, { error: 'Not found' });
  } catch (e) {
    jsonResponse(res, 500, { error: e.message });
  }
});

if (require.main === module) {
  server.listen(config.port, () => {
    console.log(`Backend listening on port ${config.port}`);
  });
}

module.exports = {
  buildPlaybackPosition,
  buildRuntimePlaylist,
  moveVideoNext,
  wrapOverlayText
};
