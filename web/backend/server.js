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
const PREVIEW_FILE = '/opt/yt/web/frontend/stream-preview.jpg';
const VIDEO_DIR = '/mnt/blobfuse2';
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
  try {
    const raw = fs.readFileSync(PLAYLIST_FILE, 'utf8');
    return raw.split('\n')
      .filter(l => l.startsWith("file '"))
      .map(l => path.basename(l.replace(/^file '/, '').replace(/'$/, '')));
  } catch { return []; }
}

function readPlaybackState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch { return null; }
}

const server = http.createServer(async (req, res) => {
  try {
    // ─── GET /api/info ─────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/api/info') {
      const prefix = readPrefix();
      const storage = config.storageAccountTemplate.replace("STORAGE_ACCOUNT", prefix.toLowerCase());
      const automation = config.automationAccountTemplate.replace("AUTOMATION_ACCOUNT", prefix + "-automation");
      const keyVault = prefix.toLowerCase() + '-kv';
      let hostname = '';
      try { hostname = require('os').hostname(); } catch {}
      jsonResponse(res, 200, { prefix, storageAccount: storage, automationAccount: automation, keyVault, hostname });
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
      if (!key || typeof key !== 'string' || key.length < 4 || key.length > 256) {
        return jsonResponse(res, 400, { error: 'streamKey must be 4-256 characters' });
      }
      const vault = kvName();
      execFile('az', [
        'keyvault', 'secret', 'set',
        '--vault-name', vault, '--name', 'youtube-stream-key',
        '--value', key, '-o', 'none'
      ], { timeout: 30000 }, (err) => {
        if (err) return jsonResponse(res, 500, { error: 'Failed to update stream key in Key Vault' });
        jsonResponse(res, 200, { ok: true });
      });
      return;
    }

    // ─── GET /api/settings ─────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/api/settings') {
      const schedule = readSchedule();
      jsonResponse(res, 200, {
        max_resolution: schedule.stream?.max_resolution || '720p',
        shuffle: schedule.stream?.shuffle || false,
        watermark: schedule.stream?.watermark || false
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
      writeSchedule(schedule);
      jsonResponse(res, 200, {
        max_resolution: schedule.stream.max_resolution,
        shuffle: schedule.stream.shuffle,
        watermark: schedule.stream.watermark
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
          .map(v => ({ file: v.file, enabled: v.enabled !== false }));
        // Append any new files not yet in config
        for (const f of allFiles) {
          if (!known.has(f)) videos.push({ file: f, enabled: true });
        }
      } else {
        videos = allFiles.map(f => ({ file: f, enabled: true }));
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
      const videos = parsed.videos
        .filter(v => v.file && typeof v.file === 'string' && allFiles.has(v.file))
        .map(v => ({ file: v.file, enabled: v.enabled !== false }));

      writePlaylistConfig({ videos });

      // Regenerate the ffmpeg playlist immediately
      try {
        execFileSync('/usr/local/bin/generate-playlist.sh', [], { timeout: 15000 });
      } catch { /* non-fatal */ }

      jsonResponse(res, 200, { ok: true, count: videos.length });
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
        const playlist = readPlaylistOrder();
        const state = readPlaybackState();
        const result = { active, uptimeSeconds, nowPlaying: null, upNext: [], progress: null };

        if (state && playlist.length > 0) {
          // The state file records the LAST COMPLETED video's index.
          // While streaming, the streamer is playing the NEXT one after the bookmark.
          const lastIdx = state.index;
          const lastFile = path.basename(state.file || '');

          // Find the bookmarked video's position in the current playlist
          let bookmarkIdx = -1;
          if (lastIdx < playlist.length && playlist[lastIdx] === lastFile) {
            bookmarkIdx = lastIdx;
          } else {
            bookmarkIdx = playlist.indexOf(lastFile);
          }

          if (active && bookmarkIdx >= 0) {
            // Currently streaming: now playing is the one AFTER the bookmark
            const nowIdx = (bookmarkIdx + 1) % playlist.length;
            result.nowPlaying = playlist[nowIdx];
            // Up next: the 5 videos after now playing, with durations
            for (let i = 1; i <= 5 && i < playlist.length; i++) {
              const name = playlist[(nowIdx + i) % playlist.length];
              const dur = probeDuration(path.join(VIDEO_DIR, name));
              result.upNext.push({ name, duration: dur });
            }
          } else if (active) {
            // Active but no valid bookmark — assume index 0
            result.nowPlaying = playlist[0] || null;
            for (let i = 1; i <= 5 && i < playlist.length; i++) {
              const name = playlist[i];
              const dur = probeDuration(path.join(VIDEO_DIR, name));
              result.upNext.push({ name, duration: dur });
            }
          } else {
            // Stopped: show what will play next on resume
            const resumeIdx = bookmarkIdx >= 0 ? (bookmarkIdx + 1) % playlist.length : 0;
            result.nowPlaying = null;
            const slice = playlist.slice(resumeIdx, resumeIdx + 5);
            if (slice.length < 5 && playlist.length > 0) {
              const need = 5 - slice.length;
              slice.push(...playlist.slice(0, need));
            }
            result.upNext = slice.map(name => ({
              name, duration: probeDuration(path.join(VIDEO_DIR, name))
            }));
          }

          // Progress of current video (from /run/streamer-now.json)
          if (active) {
            const now = readNowPlaying();
            if (now && now.startedAt && now.duration) {
              const elapsed = Math.floor(Date.now() / 1000) - now.startedAt;
              result.progress = {
                elapsed: Math.min(elapsed, now.duration),
                duration: now.duration
              };
            }
          }
        }

        jsonResponse(res, 200, result);
      });
      return;
    }

    // ─── POST /api/streamer/start ──────────────────────────────────
    if (req.method === 'POST' && req.url === '/api/streamer/start') {
      // Set manual override so the scheduler won't auto-stop
      try { fs.writeFileSync('/run/streamer-manual-override', ''); } catch {};
      execFile('systemctl', ['start', 'streamer.service'], { timeout: 15000 }, (err) => {
        if (err) return jsonResponse(res, 500, { error: 'Failed to start streamer' });
        jsonResponse(res, 200, { ok: true, active: true });
      });
      return;
    }

    // ─── POST /api/streamer/stop ───────────────────────────────────
    if (req.method === 'POST' && req.url === '/api/streamer/stop') {
      // Clear manual override so the scheduler resumes control
      try { fs.unlinkSync('/run/streamer-manual-override'); } catch {};
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

    // ─── GET /api/health ───────────────────────────────────────────
    // Returns status of all systemd units at a glance
    if (req.method === 'GET' && req.url === '/api/health') {
      const units = [
        'streamer.service', 'scheduler.service', 'schedule-sync.timer',
        'caddy.service', 'web-backend.service', 'mnt-blobfuse2.mount'
      ];
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
      const allowed = [
        'streamer.service', 'scheduler.service', 'schedule-sync.service',
        'caddy.service', 'web-backend.service', 'mnt-blobfuse2.mount'
      ];
      if (!allowed.includes(service)) {
        return jsonResponse(res, 400, { error: 'Invalid service. Allowed: ' + allowed.join(', ') });
      }
      execFile('journalctl', ['-u', service, '-n', String(lines), '--no-pager', '-o', 'short-iso'],
        { timeout: 10000, maxBuffer: 1024 * 512 }, (err, stdout) => {
          jsonResponse(res, 200, { service, lines: stdout || '' });
        });
      return;
    }

    // ─── GET /api/schedule ─────────────────────────────────────────
    // Returns the full schedule with computed next start/stop times
    if (req.method === 'GET' && req.url === '/api/schedule') {
      const schedule = readSchedule();
      // Compute next event from schedule
      const now = new Date();
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      let nextStart = null, nextStop = null;

      for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
        const d = new Date(now.getTime() + dayOffset * 86400000);
        const dayName = dayNames[d.getDay()];
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

      jsonResponse(res, 200, {
        timezone: schedule.timezone || 'UTC',
        events: schedule.events || [],
        stream: schedule.stream || {},
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
        schedule.events = parsed.events
          .filter(e => e.name && e.start && e.stop && Array.isArray(e.days))
          .map(e => ({
            name: String(e.name).slice(0, 100),
            start: String(e.start).slice(0, 5),
            stop: String(e.stop).slice(0, 5),
            days: e.days.filter(d => validDays.includes(d))
          }));
      }
      writeSchedule(schedule);
      jsonResponse(res, 200, { ok: true });
      return;
    }

    // ─── POST /api/update ─────────────────────────────────────────
    // Pull latest code and re-deploy changed files
    if (req.method === 'POST' && req.url === '/api/update') {
      execFile('/usr/local/bin/yt-update.sh', [], {
        timeout: 60000,
        maxBuffer: 1024 * 256,
        env: { ...process.env, HOME: '/root', GIT_TERMINAL_PROMPT: '0' }
      }, (err, stdout, stderr) => {
        const output = (stdout || '') + (stderr || '');
        if (err && !stdout) {
          return jsonResponse(res, 500, { error: 'Update failed', output: output || err.message });
        }
        jsonResponse(res, 200, { ok: true, output });
      });
      return;
    }

    // ─── POST /api/videos/upload ─────────────────────────────────
    // Stream-upload a video file to the blobfuse2 mount
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

server.listen(config.port, () => {
  console.log(`Backend listening on port ${config.port}`);
});
