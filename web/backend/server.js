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
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { randomUUID, createHash } = require('crypto');

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
const CONTROL_STATE = '/run/streamer-control-state.json';
const CONTROL_REQUEST = '/run/streamer-control-request.json';
const PROGRESS_FILE = '/run/streamer-progress.json';
const QUEUE_HOLD = '/run/streamer-queue-hold';

function readMode() {
  try { return fs.readFileSync(MODE_FILE, 'utf8').trim(); } catch { return 'azure'; }
}

function checkoutInfo() {
  const options = {
    cwd: '/opt/yt', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, HOME: process.env.HOME || os.homedir(), GIT_OPTIONAL_LOCKS: '0' }
  };
  const git = (...args) => {
    try { return execFileSync('git', args, options).toString().trim(); } catch { return null; }
  };
  const version = git('rev-parse', '--short', 'HEAD') || '';
  if (!version) return { version, branch: '', tag: null, checkoutModified: null };
  // The updater sets executable bits in the checkout for installed scripts.
  const status = git('-c', 'core.fileMode=false', 'status', '--porcelain', '--untracked-files=no');
  return {
    version,
    branch: git('rev-parse', '--abbrev-ref', 'HEAD') || '',
    tag: git('describe', '--tags', '--exact-match', 'HEAD'),
    checkoutModified: status === null ? null : status !== ''
  };
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
    return {
      healthUnits: readSchedule().scheduleSource === 'youtube' ? [...services, 'youtube-sync.timer'] : services,
      logServices: [...services, 'youtube-sync.service']
    };
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
  const temp = `${SCHEDULE_FILE}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(schedule, null, 2) + '\n');
    fs.renameSync(temp, SCHEDULE_FILE);
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

function validateYouTubeConfig(value, required = true) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid YouTube configuration');
  const channelId = typeof value.channelId === 'string' ? value.channelId.trim() : '';
  const provider = value.provider ?? 'api';
  if (!['api', 'yt-dlp'].includes(provider)) throw new Error('Invalid YouTube discovery method');
  if (provider === 'yt-dlp' && channelId && !/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) {
    throw new Error('Public discovery requires the channel ID beginning with UC');
  }
  if (value.manualStudioChecks !== undefined && typeof value.manualStudioChecks !== 'boolean') {
    throw new Error('Invalid manual Studio confirmation');
  }
  const manualStudioChecks = value.manualStudioChecks === true;
  if (required && provider === 'yt-dlp' && !manualStudioChecks) {
    throw new Error('Confirm the stream keys and Auto-start/Auto-stop settings in Studio before enabling public scheduling');
  }
  if ((!channelId && required) || (channelId && !/^[A-Za-z0-9_-]{1,100}$/.test(channelId))) {
    throw new Error('Configure a valid YouTube channel ID');
  }
  if (!Array.isArray(value.rules) || value.rules.length > 32 || (required && !value.rules.length)) {
    throw new Error('Configure 1-32 title/output rules');
  }
  const seen = new Set();
  const rules = value.rules.map(rule => {
    if (!rule || typeof rule.title !== 'string' || !rule.title.trim() || rule.title.length > 200) {
      throw new Error('Each rule needs a title of 1-200 characters');
    }
    const title = rule.title.trim();
    const normalized = title.toLowerCase().replace(/\s+/gu, ' ');
    if (seen.has(normalized)) throw new Error('Duplicate title rules');
    seen.add(normalized);
    if (!['landscape', 'portrait'].includes(rule.profile)) throw new Error('Select landscape or portrait');
    const durationSeconds = rule.durationSeconds ?? 28800;
    if (!Number.isInteger(durationSeconds) || durationSeconds < 60 || durationSeconds > 86400) {
      throw new Error('Fallback duration must be 1 minute to 24 hours');
    }
    return { title, profile: rule.profile, durationSeconds };
  });
  return { channelId, rules, provider, manualStudioChecks };
}

function youtubeFingerprint(schedule) {
  function sorted(value) {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
    }
    return value;
  }
  const relevant = Object.fromEntries(['scheduleSource', 'youtube', 'streams'].map(key => [key, schedule[key] ?? null]));
  return createHash('sha256').update(JSON.stringify(sorted(relevant))).digest('hex');
}

function youtubePreview(schedule, now = Date.now() / 1000) {
  const provider = schedule.youtube?.provider || 'api';
  const enabled = schedule.scheduleSource === 'youtube';
  const cache = readJsonFile('/etc/yt/youtube-schedule.json');
  const sync = readJsonFile('/etc/yt/youtube-sync-status.json');
  const controlState = readJsonFile('/run/streamer-youtube-owner.json');
  const owner = controlState?.owner;
  const policy = readJsonFile('/etc/yt/youtube-local.json');
  const ownedEvents = Array.isArray(owner?.events) ? owner.events : [];
  const deadline = ownedEvents.length ? Math.min(...ownedEvents.map(event => event.end)) : null;
  const manualManaged = readMode() === 'local' && provider === 'yt-dlp' &&
    policy?.rolloverEnabled === true && policy?.controlManual === true;
  const owned = Number.isFinite(deadline) && (!fs.existsSync('/run/streamer-manual-override') || manualManaged) ? {
    broadcastIds: ownedEvents.map(event => String(event.id)),
    end: new Date(deadline * 1000).toISOString(), stopping: owner.stopping === true
  } : null;
  const keys = {};
  for (const profile of ['landscape', 'portrait']) {
    const name = schedule.streams?.[profile]?.stream_key_name || (profile === 'portrait' ? 'youtube-stream-key-portrait' : 'youtube-stream-key');
    keys[profile] = null;
    if (typeof name === 'string' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\')) {
      try { keys[profile] = fs.readFileSync(`/etc/yt/secrets/${name}`, 'utf8').replace(/\s+/gu, ''); } catch {}
    }
  }
  const keyFingerprint = createHash('sha256').update(JSON.stringify(keys)).digest('hex');
  const compatible = readMode() === 'local' && cache?.fingerprint === youtubeFingerprint(schedule) && cache?.keyFingerprint === keyFingerprint;
  const ageSeconds = cache && Number.isFinite(cache.fetchedAt) ? Math.max(0, now - cache.fetchedAt) : null;
  const fresh = compatible && ageSeconds !== null && now >= cache.fetchedAt && ageSeconds <= 600;
  const events = (Array.isArray(cache?.events) ? cache.events : []).slice(0, 500).map(event => ({
    id: String(event.id || ''), title: String(event.title || ''), profile: event.profile,
    start: Number.isFinite(event.start) ? new Date(event.start * 1000).toISOString() : null,
    end: Number.isFinite(event.end) ? new Date(event.end * 1000).toISOString() : null,
    lifecycle: event.status,
    errors: Array.isArray(event.errors) ? event.errors.map(String) : ['Invalid cached event'],
    eligible: enabled && fresh && !event.errors?.length && event.status === 'ready' && event.end > now && now - event.start <= 600
  }));
  return {
    available: readMode() === 'local',
    provider, enabled,
    control: {
      enabled: enabled && provider === 'yt-dlp' && readMode() === 'local' && policy?.rolloverEnabled === true,
      manualIncluded: policy?.controlManual === true,
      waiting: !!controlState?.handoff,
      churchBlocked: controlState?.controlStatus?.churchBlocked === true,
      calendarReady: controlState?.controlStatus?.calendarReady !== false,
      minimumDisconnectSeconds: Number.isInteger(policy?.disconnectSeconds) ? Math.max(30, policy.disconnectSeconds) : 30
    },
    authorized: fs.existsSync('/etc/yt/secrets/youtube-oauth.json'),
    channelId: compatible ? cache.channelId : null,
    fresh, ageSeconds, events, owned,
    activeBroadcasts: (Array.isArray(cache?.activeBroadcasts) ? cache.activeBroadcasts : []).map(event => ({
      id: String(event.id || ''), title: String(event.title || '')
    })),
    sync: sync ? { ok: sync.ok === true, checkedAt: sync.checkedAt, error: sync.error || null,
      retryAt: sync.retryAt || null, callsToday: sync.callsToday ?? null,
      durationSeconds: Number.isFinite(sync.durationSeconds) ? sync.durationSeconds : null } : null
  };
}

function validateOutputSelection(parsed, defaults = null) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('Invalid output selection'), { status: 400 });
  }
  const streams = parsed.streams === undefined ? defaults : parsed.streams;
  if (!Array.isArray(streams) || streams.length < 1 || streams.length > 2 ||
      streams.some(stream => !['landscape', 'portrait'].includes(stream)) ||
      new Set(streams).size !== streams.length) {
    throw Object.assign(new Error('Select horizontal, vertical, or both outputs'), { status: 400 });
  }
  return streams;
}

function selectManualOutputs(streams) {
  if (readMode() === 'local') {
    const schedule = readSchedule();
    for (const profile of streams) {
      const name = schedule.streams?.[profile]?.stream_key_name ||
        (profile === 'portrait' ? 'youtube-stream-key-portrait' : 'youtube-stream-key');
      if (typeof name !== 'string' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
        throw Object.assign(new Error(`Invalid ${profile} stream key configuration`), { status: 400 });
      }
      let key;
      try { key = fs.readFileSync(`/etc/yt/secrets/${name}`, 'utf8').trim(); } catch {}
      if (!key) throw Object.assign(new Error(`Configure the ${profile} stream key before activating it`), { status: 409 });
    }
  }
  fs.writeFileSync('/run/streamer-manual-override', '');
  for (const [profile, file] of [['landscape', ACTIVE_LANDSCAPE], ['portrait', ACTIVE_PORTRAIT]]) {
    if (streams.includes(profile)) fs.writeFileSync(file, '');
    else {
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  for (const file of ['/run/streamer-manual-stop', QUEUE_HOLD]) {
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
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

function wrapOverlayText(text, maxLine, maxLines = 2) {
  if (text.length <= maxLine) return text;
  if (maxLines > 2) {
    let remaining = text;
    const result = [];
    for (let count = Math.min(maxLines, Math.ceil(text.length / maxLine)); count > 1; count--) {
      const target = Math.floor(remaining.length / count);
      let split = -1;
      for (let i = 1; i < remaining.length - 1; i++) {
        if (remaining[i] === ' ' && (split < 0 || Math.abs(i - target) <= Math.abs(split - target))) split = i;
      }
      const boundary = split < 0 ? target : split;
      result.push(remaining.slice(0, boundary));
      remaining = remaining.slice(boundary + (split < 0 ? 0 : 1));
    }
    return [...result, remaining].join('\n');
  }
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

function displayTitle(text) {
  return text.trim().replace(/(?:\.(?:mp4|mkv|mov|avi|ts|flv))+$/i, '')
    .replace(/^\d{4}-\d{2}-\d{2}(?:\s*[-_]\s*|\s+)/, '').trim();
}

function syncActivePlaylist(videos) {
  if (!isStreamerActive()) return { updated: false, pending: false, nextFile: null };
  const control = readControlState();
  if (control) {
    const action = submitControl({
      id: `saved-${randomUUID()}`, operation: 'reset',
      session: control.session, revision: control.revision
    }, control);
    return { updated: false, pending: true, nextFile: null, actionId: action.id };
  }

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
    ? displayTitle(titleMap.get(nextFile) || nextFile)
    : '';
  const overlayText = displayTitle ? `Up Next: ${displayTitle}` : '';
  writeAtomic(UPNEXT_FILE, wrapOverlayText(overlayText, 55));
  writeAtomic(PORT_UPNEXT_FILE, wrapOverlayText(overlayText, 40, 3));

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

function readJsonFile(filename) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { return null; }
}

function processMatches(pid, started) {
  if (!Number.isInteger(pid) || pid <= 0 || typeof started !== 'string' || !started) return false;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    return fields[19] === started && !['Z', 'X'].includes(fields[0]);
  } catch { return false; }
}

function readControlState() {
  const state = readJsonFile(CONTROL_STATE);
  if (!state || state.version !== 1 || state.stopped || !Number.isInteger(state.ownerPid) ||
      typeof state.session !== 'string' || !Number.isInteger(state.revision) ||
      !state.current || typeof state.current.file !== 'string' ||
      !Array.isArray(state.upcoming) || state.upcoming.some(item => !item || typeof item.file !== 'string') ||
      !Array.isArray(state.actions) || state.actions.some(item => !item || typeof item.id !== 'string')) return null;
  if (!processMatches(state.ownerPid, state.ownerStart)) return null;
  return state;
}

function submitControl(command, state) {
  if (typeof command.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(command.id)) {
    throw Object.assign(new Error('Invalid action ID'), { status: 400 });
  }
  const previous = state.actions.find(action => action.id === command.id);
  if (previous) return previous;
  if (state.interrupt) {
    throw Object.assign(new Error('A playback interruption is already pending'), { status: 409 });
  }
  if (command.session !== state.session || command.revision !== state.revision) {
    throw Object.assign(new Error('Playback queue changed; reload before editing'), { status: 409 });
  }
  if (fs.existsSync(CONTROL_REQUEST)) {
    const pending = readJsonFile(CONTROL_REQUEST);
    if (pending && pending.id === command.id) return { id: command.id, status: 'accepted' };
    throw Object.assign(new Error('Another action is pending; reload and retry'), { status: 409 });
  }
  if (fs.existsSync('/run/streamer-stop-after-current') ||
      fs.existsSync('/run/streamer-restart-requested')) {
    throw Object.assign(new Error('Stop or restart is pending'), { status: 409 });
  }
  writeAtomic(CONTROL_REQUEST, JSON.stringify(command));
  return { id: command.id, status: 'accepted' };
}

function playbackHealth(current, sample, now, history = {}, processes = {}) {
  const generation = current && current.generation;
  if (history.generation !== generation) {
    history.generation = generation;
    history.elapsed = -1;
    history.lastAdvance = current ? current.startedAt : now;
    history.sampleAt = null;
    history.slowSince = null;
  }
  const starting = current && now - current.startedAt < 20;
  const valid = current && generation && sample && sample.generation === generation &&
    Number.isFinite(sample.at) && Number.isFinite(sample.elapsed) && sample.elapsed >= 0 &&
    Number.isFinite(sample.speed) && sample.speed >= 0 && sample.at <= now + 1;
  const info = valid ? { age: Math.max(0, now - sample.at), speed: sample.speed } : {};
  if (valid && sample.end) {
    return { status: info.age <= 6 ? 'starting' : 'unknown', reason: 'video ended; awaiting player state', ...info };
  }
  if (processes.encoderAlive === false || processes.telemetryAlive === false || !valid) {
    const reason = processes.encoderAlive === false ? 'encoder unavailable'
      : processes.telemetryAlive === false ? 'telemetry reader unavailable' : 'waiting for valid progress';
    return { status: starting ? 'starting' : 'unknown', reason, ...info };
  }
  if (info.age > 6) {
    const stalled = !starting && current.onAir === true && info.age >= 15 &&
      processes.encoderAlive === true && processes.telemetryAlive === true;
    return {
      status: stalled ? 'stalled' : starting ? 'starting' : 'unknown',
      reason: stalled ? 'no new encoder progress' : 'waiting for fresh progress', ...info
    };
  }
  if (sample.at !== history.sampleAt) {
    if (sample.elapsed > history.elapsed) history.lastAdvance = sample.at;
    history.elapsed = sample.elapsed;
    history.sampleAt = sample.at;
    if (sample.speed < 0.9) {
      if (history.slowSince === null) history.slowSince = sample.at;
    } else {
      history.slowSince = null;
    }
  }
  let status = 'healthy';
  if (now - current.startedAt < 20) status = 'starting';
  else if (now - history.lastAdvance >= 15) status = 'stalled';
  else if (history.slowSince !== null && now - history.slowSince >= 20) status = 'slow';
  return { status, ...info };
}

const healthHistory = {};
function streamerSnapshot(props, probe = false) {
  const active = props.ActiveState === 'active';
  const control = active ? readControlState() : null;
  const now = active ? readNowPlaying() : null;
  const runtime = active ? readRuntimePlaylist() : [];
  const saved = readPlaylistOrder();
  const position = buildPlaybackPosition(
    active, runtime.length ? runtime : saved, readPlaybackState(), now
  );
  if (control) {
    position.nowPlaying = path.basename(control.current.file);
    position.upNext = control.upcoming.slice(0, 5).map(item => path.basename(item.file));
  }
  const cfg = readPlaylistConfig();
  const titles = new Map((cfg && Array.isArray(cfg.videos) ? cfg.videos : [])
    .filter(video => video && video.title).map(video => [video.file, video.title]));
  const displayName = filename => displayTitle(titles.get(filename) || filename);
  const entered = new Date(props.ActiveEnterTimestamp || '');
  const result = {
    active, state: props.ActiveState || 'unknown',
    uptimeSeconds: active && !isNaN(entered) ? Math.floor((Date.now() - entered.getTime()) / 1000) : null,
    nowFile: position.nowPlaying,
    nowPlaying: position.nowPlaying ? displayName(position.nowPlaying) : null,
    upNext: position.upNext.map(filename => ({
      file: filename, name: displayName(filename),
      duration: probe ? probeDuration(path.join(VIDEO_DIR, filename)) : durationCache.get(filename) || 0
    })),
    activeStreams: {
      landscape: fs.existsSync(ACTIVE_LANDSCAPE), portrait: fs.existsSync(ACTIVE_PORTRAIT)
    },
    stopPending: fs.existsSync('/run/streamer-stop-after-current'),
    queueHold: fs.existsSync(QUEUE_HOLD),
    progress: null, playbackHealth: { status: props.ActiveState === 'inactive' ? 'stopped' : 'unknown' },
    queue: {
      ready: !!control, session: control ? control.session : null,
      revision: control ? control.revision : null,
      explicitEmpty: control ? control.explicitEmpty : false,
      items: control ? control.upcoming.map(item => ({
        file: path.basename(item.file), name: displayName(path.basename(item.file))
      })) : [],
      actions: control ? control.actions : [],
      pending: active ? readJsonFile(CONTROL_REQUEST) : null
    }
  };
  if (control) {
    const sample = readJsonFile(PROGRESS_FILE);
    result.playbackHealth = playbackHealth(control.current, sample, Date.now() / 1000, healthHistory, {
      encoderAlive: processMatches(control.current.encoderPid, control.current.encoderStart),
      telemetryAlive: processMatches(control.current.telemetryPid, control.current.telemetryStart)
    });
    if (sample && sample.generation === control.current.generation &&
        Number.isFinite(sample.elapsed) && now && typeof now.file === 'string' &&
        path.basename(now.file) === result.nowFile && now.duration) {
      result.progress = {
        elapsed: Math.min(sample.elapsed + (Number.isFinite(now.offsetSeconds) ? now.offsetSeconds : 0), now.duration), duration: now.duration,
        measured: true, speed: sample.speed,
        advancing: result.playbackHealth.status === 'healthy'
      };
    }
  } else if (active && now && now.startedAt && now.duration) {
    result.progress = {
      elapsed: Math.min(Math.floor(Date.now() / 1000) - now.startedAt + (Number.isFinite(now.offsetSeconds) ? now.offsetSeconds : 0), now.duration),
      duration: now.duration
    };
  }
  return result;
}

const eventClients = new Set();
let servicePropsCache = null;
let servicePropsAt = 0;
let serviceCallbacks = [];
function sampleServiceStatus(callback) {
  if (servicePropsCache && Date.now() - servicePropsAt < 4000) {
    callback(servicePropsCache);
    return;
  }
  serviceCallbacks.push(callback);
  if (serviceCallbacks.length > 1) return;
  execFile('systemctl', ['show', 'streamer.service', '--property=ActiveState,ActiveEnterTimestamp'],
    { timeout: 4000 }, (error, stdout = '') => {
      const props = {};
      for (const line of stdout.trim().split('\n')) {
        const [key, ...value] = line.split('=');
        props[key] = value.join('=');
      }
      servicePropsCache = error ? { ActiveState: 'unknown' } : props;
      servicePropsAt = Date.now();
      const callbacks = serviceCallbacks;
      serviceCallbacks = [];
      for (const waiting of callbacks) waiting(servicePropsCache);
    });
}

function buildDiagnostics(input, now = Date.now() / 1000) {
  const { player, youtube, state = {}, calendar, flags = {}, probes, mode, source, weekly } = input;
  const iso = value => Number.isFinite(value) && Math.abs(value) <= 8640000000000 ?
    new Date(value * 1000).toISOString() : null;
  const age = value => Number.isFinite(value) ? Math.max(0, now - value) : null;
  const components = {};
  const probeFresh = probes && Number.isFinite(probes.observed_at) && probes.observed_at <= now &&
    now - probes.observed_at <= 120;
  const component = (id, severity, reason, details = {}, observed = now, ttl = 15) => {
    const seconds = age(observed);
    const stale = seconds === null || observed > now || seconds > ttl;
    components[id] = { severity: stale ? 'unknown' : severity, reason: stale ? `${reason}; observation stale or unavailable` : reason,
      observed_at: iso(observed), age_seconds: seconds, stale, ...details };
  };
  const church = source === 'youtube' && state.controlStatus?.churchBlocked === true;
  const waiting = source === 'youtube' && !!state.handoff;
  const owned = source === 'youtube' ? state.owner : null;
  const decisionFresh = state.decision && Number.isFinite(state.decision.observedAt) &&
    age(state.decision.observedAt) <= 90 && state.decision.observedAt <= now;
  let expected = 'unknown', reason = 'Scheduling intent unavailable';
  if (flags.manualStop || flags.queueHold) {
    expected = 'stopped'; reason = flags.queueHold ? 'Queue hold' : 'Manually stopped';
  } else if (church) {
    expected = 'stopped'; reason = 'Paused for church; waiting for kiosk failover';
  } else if (waiting || owned?.stopping) {
    expected = 'stopped'; reason = state.handoff?.reason === 'church' ?
      'Church pause cleared; waiting for safe broadcast resumption' : 'Waiting for broadcast completion or replacement';
  } else if (source !== 'youtube' && weekly && weekly.observedAt <= now && age(weekly.observedAt) <= 90) {
    expected = weekly.expected; reason = weekly.reason;
  } else if (owned?.events?.length && decisionFresh) {
    expected = 'running'; reason = 'Scheduled broadcast should be streaming';
  } else if (decisionFresh && ['START', 'KEEP'].includes(state.decision.command)) {
    expected = 'running'; reason = 'Scheduler requests streaming';
  } else if (decisionFresh && ['IDLE', 'HOLD'].includes(state.decision.command)) {
    expected = 'stopped'; reason = 'Waiting for the next eligible scheduled broadcast';
  } else if (flags.manualOverride && player.active) {
    expected = 'running'; reason = 'Manually started';
  }
  const observedRunning = ['active', 'activating', 'reloading'].includes(player.state);
  const transitioning = ['activating', 'deactivating'].includes(player.state) || player.playbackHealth?.status === 'starting';
  const mismatch = expected !== 'unknown' && (expected === 'running') !== observedRunning;
  component('playback', player.state === 'unknown' || expected === 'unknown' ? 'unknown' :
    mismatch ? transitioning ? 'warn' : 'error' : 'ok',
    mismatch ? `${reason}; actual service is ${player.state}` : reason,
    { expected, actual: player.state, intentional_pause: expected === 'stopped', transition_grace: transitioning,
      current_title: player.nowPlaying || null, outputs: Object.entries(player.activeStreams || {})
        .filter(([, enabled]) => enabled).map(([profile]) => profile) });
  const health = player.playbackHealth || { status: 'unknown' };
  component('encoder', !player.active && expected === 'stopped' ? 'ok' : health.status === 'stalled' ? 'error' :
    health.status === 'slow' || health.status === 'starting' ? 'warn' : health.status === 'healthy' ? 'ok' : 'unknown',
    !player.active && expected === 'stopped' ? 'Encoder intentionally stopped' : health.reason || `Encoder ${health.status}`,
    { status: health.status, speed: health.speed ?? null, sample_age_seconds: health.age ?? null,
      elapsed_seconds: player.progress?.elapsed ?? null, duration_seconds: player.progress?.duration ?? null,
      generation: input.control?.current?.generation || null, progress_observed_at: iso(input.sample?.at),
      encoder_pid: input.control?.current?.encoderPid || null, encoder_start: input.control?.current?.encoderStart || null,
      telemetry_pid: input.control?.current?.telemetryPid || null, telemetry_start: input.control?.current?.telemetryStart || null });
  const probeFields = {
    storage: ['available_count', 'saved_enabled_count', 'read_bytes', 'remote_roundtrip_verified', 'selection_source', 'total_bytes'],
    resources: ['load_1m', 'cpu_cores', 'uptime_seconds', 'memory_available_mb', 'memory_total_mb', 'disk_available_bytes',
      'disk_total_bytes', 'disk_used_bytes',
      'disk_available_percent', 'temperature_c'],
    auth: ['mode', 'expires_at', 'days_remaining']
  };
  for (const id of ['storage', 'resources', 'auth']) {
    const value = probes?.[id] || {};
    component(id, probeFresh ? value.severity || 'unknown' : 'unknown', value.reason || `${id} probe unavailable`,
      Object.fromEntries(probeFields[id].filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])),
      probes?.observed_at, 120);
  }
  components.storage.mount = probes?.storage_mount ? {
    mounted: probes.storage_mount.mounted === true, required: probes.storage_mount.required === true
  } : null;
  components.storage.upcoming_count = input.control?.upcoming?.length ?? null;
  components.storage.explicit_empty = input.control?.explicitEmpty === true;
  const required = mode === 'local' ? ['scheduler.service', 'web-backend.service', 'caddy.service',
    ...(source === 'youtube' ? ['youtube-sync.timer'] : [])] :
    ['scheduler.service', 'web-backend.service', 'caddy.service', 'schedule-sync.timer', 'mnt-blobfuse2.mount'];
  const units = Object.fromEntries([...new Set(['streamer.service', ...required])].filter(unit => probes?.services?.[unit])
    .map(unit => [unit, { state: probes.services[unit].state, restarts: probes.services[unit].restarts }]));
  const failed = required.filter(unit => units[unit]?.state !== 'active');
  component('services', failed.length ? failed.some(unit => units[unit]?.state === 'failed') ? 'error' : 'unknown' : 'ok',
    failed.length ? `Required services unavailable: ${failed.join(', ')}` : 'Control services active',
    { units }, probes?.observed_at, 120);
  const calendarAge = age(calendar?.fetchedAt);
  const calendarRequired = mode === 'local' && source === 'youtube' && input.calendarRequired;
  const calendarReady = !calendarRequired || (calendar?.ok && calendarAge !== null && calendar.fetchedAt <= now && calendarAge <= 180);
  const weeklyFresh = weekly && weekly.observedAt <= now && age(weekly.observedAt) <= 90;
  const schedulingReady = source !== 'youtube' ? weeklyFresh : youtube.fresh && calendarReady && decisionFresh;
  component('scheduling', schedulingReady ? 'ok' : 'unknown',
    source !== 'youtube' ? weeklyFresh ? 'Weekly scheduler observation fresh' : 'Weekly scheduler observation unavailable or stale' :
      !calendarReady ? 'Local church calendar unavailable or stale' : !decisionFresh ? 'Scheduler decision unavailable or stale' :
        youtube.fresh ? 'Scheduling observations fresh' : 'YouTube discovery unavailable or stale',
    { source, discovery_fresh: youtube.fresh, discovery_age_seconds: youtube.ageSeconds,
      last_scan_seconds: youtube.sync?.durationSeconds ?? null, discovery_error: youtube.sync?.error || null,
      discovery_checked_at: iso(youtube.sync?.checkedAt), discovery_retry_at: iso(youtube.sync?.retryAt),
      discovery_calls_today: youtube.sync?.callsToday ?? null,
      calendar_required: !!calendarRequired, calendar_age_seconds: calendarAge, calendar_ready: !!calendarReady,
      church_pending_start: iso(state.calendarPendingStart),
      kiosk_failover_at: calendarRequired ? iso(input.standby?.failover_started) : null,
      kiosk_state: calendarRequired && ['counting', 'fired'].includes(input.standby?.state) ? input.standby.state : null,
      church_blocked: church, handoff_waiting: waiting, handoff_reason: state.handoff?.reason || null,
      disconnected_at: iso(state.handoff?.disconnectedAt), completed_ids: state.handoff?.completed || [],
      minimum_disconnect_seconds: youtube.control?.minimumDisconnectSeconds ?? null,
      studio_confirmed: input.studioConfirmed === true, provider: youtube.provider,
      observations: (youtube.events || []).map(event => ({ id: event.id, title: event.title, profile: event.profile,
        start: event.start, end: event.end, lifecycle: event.lifecycle, errors: event.errors })),
      broadcast_ids: owned?.events?.map(event => event.id) || [],
      live_started_at: iso(owned?.events?.[0]?.liveStart),
      deadline_at: iso(owned?.events?.length ? Math.min(...owned.events.map(event => event.end)) : null),
      decision: decisionFresh ? state.decision.command : null,
      decision_observed_at: iso(state.decision?.observedAt),
      weekly_observed_at: iso(weekly?.observedAt),
      resume_church_live: input.resumeChurchLive === true },
    source === 'youtube' ? now - (youtube.ageSeconds ?? Infinity) : weekly?.observedAt,
    source === 'youtube' ? 600 : 90);
  if (source === 'youtube' && !input.studioConfirmed) {
    components.scheduling.severity = components.scheduling.severity === 'ok' ? 'warn' : components.scheduling.severity;
    components.scheduling.reason += '; Studio acknowledgement blocks new automatic starts';
  }
  const next = (youtube.events || []).filter(event => youtube.fresh && event.eligible === true &&
    !state.suppressed?.[event.id] && event.lifecycle === 'ready' && event.start && Date.parse(event.start) / 1000 > now)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
  const nextChurch = calendarRequired ? (calendar?.windows || []).map(window => window.start).filter(start => start > now)
    .sort((a, b) => a - b)[0] : null;
  const deadline = owned?.events?.length ? Math.min(...owned.events.map(event => event.end)) : null;
  const nextAction = expected === 'running' && Number.isFinite(deadline) ?
    { action: nextChurch && nextChurch < deadline ? 'church_pause' : 'stop_at_deadline', at: iso(nextChurch && nextChurch < deadline ? nextChurch : deadline) } :
    church ? { action: 'wait_for_kiosk_failover', at: null } :
      waiting ? { action: 'wait_for_safe_broadcast', at: null } :
        flags.manualStop || flags.queueHold ? { action: 'wait_for_operator_release', at: null } :
          expected === 'unknown' ? { action: 'wait_for_scheduler_observation', at: null } :
            source !== 'youtube' ? { action: expected === 'running' ? 'continue_weekly_schedule' : 'wait_for_weekly_window', at: null } :
              !input.studioConfirmed ? { action: 'await_studio_confirmation', at: null } :
                next ? { action: 'scheduled_start', at: next.start } : { action: 'wait_for_eligible_broadcast', at: null };
  const ranks = { ok: 0, warn: 1, unknown: 2, error: 3 };
  const worst = Object.entries(components).sort((a, b) => ranks[b[1].severity] - ranks[a[1].severity])[0];
  return { schema_version: 1, generated_at: iso(now), mode, severity: worst[1].severity,
    summary: worst[1].severity === 'ok' ? reason : worst[1].reason, next_action: nextAction,
    components, limitations: ['Public YouTube live status does not verify RTMP ingest',
      'Recording reads may be served from FUSE cache', 'Diagnostics are read-only; no recovery actions'] };
}

let diagnosticProbes = null;
let diagnosticProbeBusy = false;
let diagnosticSnapshot = null;
function refreshDiagnosticProbes() {
  if (diagnosticProbeBusy) return;
  diagnosticProbeBusy = true;
  const helper = fs.existsSync('/usr/local/bin/streamer-diagnostics.py') ? '/usr/local/bin/streamer-diagnostics.py' :
    path.join(__dirname, '..', '..', 'services', 'streamer', 'streamer-diagnostics.py');
  execFile('python3', [helper, '--video-dir', VIDEO_DIR, '--mode', readMode()],
    { timeout: 8000, maxBuffer: 131072 }, (error, stdout) => {
      diagnosticProbeBusy = false;
      try {
        const value = JSON.parse(stdout);
        diagnosticProbes = !error && Number.isFinite(value.observed_at) ? value : null;
      } catch { diagnosticProbes = null; }
    });
}

function refreshDiagnostics(callback) {
  sampleServiceStatus(props => {
    const schedule = readSchedule();
    const mode = readMode();
    const policy = mode === 'local' ? readJsonFile('/etc/yt/youtube-local.json') || {} : {};
    diagnosticSnapshot = buildDiagnostics({
      player: streamerSnapshot(props), youtube: youtubePreview(schedule),
      state: readJsonFile('/run/streamer-youtube-owner.json') || {},
      control: readControlState(), calendar: mode === 'local' ? readJsonFile('/etc/yt/youtube-calendar.json') : null,
      sample: readJsonFile(PROGRESS_FILE),
      weekly: readJsonFile('/run/streamer-scheduler-observation.json'),
      standby: mode === 'local' && policy.calendarUrl ? readJsonFile(policy.standbyState || '/run/videokiosk2/standby.json') : null,
      flags: { manualStop: fs.existsSync('/run/streamer-manual-stop'),
        manualOverride: fs.existsSync('/run/streamer-manual-override'), queueHold: fs.existsSync(QUEUE_HOLD) },
      probes: diagnosticProbes, mode, source: schedule.scheduleSource || 'weekly',
      calendarRequired: !!policy.calendarUrl, resumeChurchLive: policy.resumeChurchLive,
      studioConfirmed: schedule.youtube?.manualStudioChecks
    });
    if (callback) callback(diagnosticSnapshot);
  });
}

let eventTimer = null;
let eventTick = 0;
let eventProps = null;
let eventRefreshPending = false;
function writeEvent(res, text) {
  if (res.destroyed || res.writableLength > 65536 || !res.write(text)) {
    eventClients.delete(res);
    res.destroy();
  }
}

function openEvents(req, res) {
  if (eventClients.size >= 16) return jsonResponse(res, 503, { error: 'Too many event clients' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  eventClients.add(res);
  writeEvent(res, ': connected\n\n');
  req.on('close', () => {
    eventClients.delete(res);
    if (!eventClients.size && eventTimer) { clearInterval(eventTimer); eventTimer = null; }
  });
  if (eventTimer) return;
  eventTick = 0;
  const tick = () => {
    if (!eventClients.size) {
      clearInterval(eventTimer);
      eventTimer = null;
      return;
    }
    if (eventTick % 5 === 0 && !eventRefreshPending) {
      eventRefreshPending = true;
      sampleServiceStatus(props => {
        eventRefreshPending = false;
        eventProps = props;
      });
    }
    if (eventProps && eventTick % 2 === 0) {
      const text = `event: snapshot\ndata: ${JSON.stringify(streamerSnapshot(eventProps))}\n\n`;
      for (const client of eventClients) writeEvent(client, text);
    } else if (eventTick % 15 === 0) {
      for (const client of eventClients) writeEvent(client, ': heartbeat\n\n');
    }
    eventTick++;
  };
  eventTimer = setInterval(tick, 1000);
  tick();
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/streamer/events') {
      return openEvents(req, res);
    }
    if (req.method === 'POST' && req.url === '/api/streamer/queue') {
      const command = JSON.parse(await readBody(req));
      if (!command || typeof command !== 'object' || Array.isArray(command)) {
        return jsonResponse(res, 400, { error: 'Expected a queue command object' });
      }
      if (!isStreamerActive()) return jsonResponse(res, 409, { error: 'Streamer is not running' });
      const state = readControlState();
      if (!state) return jsonResponse(res, 503, { error: 'Live controls require an updated, restarted streamer' });
      const previous = state.actions.find(action => action.id === command.id);
      if (previous) return jsonResponse(res, 200, { ok: true, action: previous });
      if (!['replace', 'next', 'now', 'reset', 'skip'].includes(command.operation)) {
        return jsonResponse(res, 400, { error: 'Unknown queue operation' });
      }
      const files = command.operation === 'replace' ? command.files
        : ['next', 'now'].includes(command.operation) ? [command.file] : [];
      if (!Array.isArray(files) || files.some(file => typeof file !== 'string') ||
          new Set(files).size !== files.length) {
        return jsonResponse(res, 400, { error: 'Queue must contain unique filenames' });
      }
      const current = path.basename(state.current.file);
      if (files.includes(current)) return jsonResponse(res, 409, { error: 'That video is already playing' });
      const available = new Set(listVideoFiles());
      if (files.some(file => !available.has(file) || /[\r\n]/.test(file))) {
        return jsonResponse(res, 400, { error: 'Video is unavailable' });
      }
      const action = submitControl({
        id: command.id, operation: command.operation, session: command.session,
        revision: command.revision, ...(command.operation === 'replace' ? { files } : {}),
        ...(['next', 'now'].includes(command.operation) ? { file: command.file } : {})
      }, state);
      return jsonResponse(res, 202, { ok: true, action });
    }
    if (req.method === 'GET' && req.url === '/api/streamer/queue') {
      return jsonResponse(res, 200, streamerSnapshot({
        ActiveState: isStreamerActive() ? 'active' : 'inactive'
      }).queue);
    }
    if (req.method === 'GET' && req.url.startsWith('/api/streamer/actions/')) {
      const id = req.url.slice('/api/streamer/actions/'.length);
      const state = isStreamerActive() ? readControlState() : null;
      const pending = state ? readJsonFile(CONTROL_REQUEST) : null;
      const action = state && state.actions.find(item => item.id === id);
      if (!action && (!pending || pending.id !== id)) {
        return jsonResponse(res, 404, { error: 'Action is unconfirmed or its session ended' });
      }
      return jsonResponse(res, 200, { action: action || { id, status: 'accepted' } });
    }
    // ─── GET /api/info ─────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/api/info') {
      const prefix = readPrefix();
      const mode = readMode();
      let hostname = '';
      try { hostname = os.hostname(); } catch {}
      const info = { prefix, mode, hostname, ...checkoutInfo() };
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
        execFileSync('/usr/local/bin/generate-playlist.sh', [VIDEO_DIR, PLAYLIST_FILE], { timeout: 15000 });
      } catch {
        return jsonResponse(res, 500, { error: 'Playlist was saved but could not be regenerated' });
      }

      let runtime;
      try {
        runtime = parsed.applyToLive === false
          ? { updated: false, pending: false, nextFile: null } : syncActivePlaylist(videos);
      } catch (error) {
        return jsonResponse(res, error.status || 500, {
          saved: true, error: `Playlist saved, but live application failed: ${error.message}`
        });
      }
      jsonResponse(res, 200, {
        ok: true,
        count: videos.length,
        videos,
        runtimeUpdated: runtime.updated,
        runtimePending: runtime.pending,
        nextFile: runtime.nextFile,
        actionId: runtime.actionId || null
      });
      return;
    }

    // ─── GET /api/streamer ──────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/api/streamer') {
      sampleServiceStatus(props => {
        jsonResponse(res, 200, streamerSnapshot(props, true));
      });
      return;
    }

    // ─── POST /api/streamer/start ──────────────────────────────────
    if (req.method === 'POST' && req.url === '/api/streamer/start') {
      const streams = validateOutputSelection(JSON.parse(await readBody(req) || '{}'), ['landscape', 'portrait']);
      selectManualOutputs(streams);
      execFile('systemctl', ['start', 'streamer.service'], { timeout: 15000 }, (err) => {
        if (err) return jsonResponse(res, 500, { error: 'Failed to start streamer' });
        jsonResponse(res, 200, { ok: true, active: true, streams });
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/streamer/outputs') {
      const streams = validateOutputSelection(JSON.parse(await readBody(req)));
      if (!isStreamerActive()) return jsonResponse(res, 409, { error: 'Streamer is stopped; select outputs and use Start' });
      if (fs.existsSync('/run/streamer-stop-after-current') || fs.existsSync('/run/streamer-restart-requested')) {
        return jsonResponse(res, 409, { error: 'Cancel the pending stop or restart before changing outputs' });
      }
      selectManualOutputs(streams);
      execFile('systemctl', ['restart', 'streamer.service'], { timeout: 30000 }, err => {
        if (err) return jsonResponse(res, 500, { error: 'Outputs selected, but streamer restart failed; check service status' });
        jsonResponse(res, 200, { ok: true, streams, restarting: true });
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
    if (req.method === 'POST' && req.url === '/api/streamer/skip') {
      if (!isStreamerActive()) {
        jsonResponse(res, 409, { error: 'Streamer is not running' });
        return;
      }
      try {
        const state = readControlState();
        if (state) {
          const action = submitControl({
            id: `skip-${randomUUID()}`, operation: 'skip',
            session: state.session, revision: state.revision
          }, state);
          return jsonResponse(res, 202, { ok: true, action });
        }
        writeAtomic('/run/streamer-skip', '');
        jsonResponse(res, 200, { ok: true });
      } catch (error) {
        jsonResponse(res, error.status || 500, { error: error.message || 'Failed to submit skip signal' });
      }
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
    if (req.method === 'GET' && req.url === '/api/streamer/diagnostics') {
      if (diagnosticSnapshot && Date.now() - Date.parse(diagnosticSnapshot.generated_at) < 5000) {
        return jsonResponse(res, 200, diagnosticSnapshot);
      }
      refreshDiagnostics(value => jsonResponse(res, 200, value));
      return;
    }
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

    if (req.method === 'GET' && req.url === '/api/schedule/youtube') {
      return jsonResponse(res, 200, youtubePreview(readSchedule()));
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
      if (schedule.scheduleSource === 'youtube' && readMode() === 'local') {
        const preview = youtubePreview(schedule);
        const upcoming = preview.events.filter(event => event.eligible).sort((a, b) => a.start.localeCompare(b.start));
        nextStart = upcoming[0]?.start || null;
        nextStop = preview.owned?.end || upcoming[0]?.end || null;
      }
      jsonResponse(res, 200, {
        scheduleSource: schedule.scheduleSource || 'weekly',
        youtube: schedule.youtube || { channelId: '', rules: [] },
        youtubeAvailable: readMode() === 'local',
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
      if (parsed.scheduleSource !== undefined || parsed.youtube !== undefined) {
        const source = parsed.scheduleSource ?? schedule.scheduleSource ?? 'weekly';
        if (!['weekly', 'youtube'].includes(source)) return jsonResponse(res, 400, { error: 'Invalid schedule source' });
        if (source === 'youtube' && readMode() !== 'local') {
          return jsonResponse(res, 400, { error: 'YouTube scheduling is currently available in local mode only' });
        }
        const providerChanging = parsed.youtube &&
          (parsed.youtube.provider || 'api') !== (schedule.youtube?.provider || 'api');
        if (readMode() === 'local' && (source !== (schedule.scheduleSource || 'weekly') ||
            (source === 'youtube' && providerChanging))) {
          let serviceState;
          try {
            serviceState = execFileSync('systemctl', ['show', '-p', 'ActiveState', '--value', 'streamer.service'], { timeout: 5000 }).toString().trim();
          } catch {
            return jsonResponse(res, 503, { error: 'Cannot verify streamer state before changing schedule source' });
          }
          if (!['inactive', 'failed'].includes(serviceState)) {
            return jsonResponse(res, 409, { error: 'Stop the streamer before changing schedule source' });
          }
        }
        try {
          schedule.youtube = validateYouTubeConfig(parsed.youtube ?? schedule.youtube ?? { channelId: '', rules: [] }, source === 'youtube');
        } catch (error) {
          return jsonResponse(res, 400, { error: error.message });
        }
        schedule.scheduleSource = source;
      }
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
        if ((parsed.youtube !== undefined || parsed.scheduleSource !== undefined) &&
            (schedule.youtube?.provider === 'yt-dlp' || schedule.scheduleSource === 'youtube')) {
          execFile('systemctl', ['start', '--no-block', 'youtube-sync.service'], { timeout: 5000 }, () => {});
        }
        return jsonResponse(res, 200, { ok: true, synced: true, mode: 'local' });
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
        if (err) {
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
    jsonResponse(res, e.status || (e instanceof SyntaxError ? 400 : 500), { error: e.message });
  }
});

if (require.main === module) {
  refreshDiagnosticProbes();
  refreshDiagnostics();
  setInterval(refreshDiagnosticProbes, 60000).unref();
  setInterval(refreshDiagnostics, 5000).unref();
  server.listen(config.port, process.env.YT_BACKEND_HOST || '0.0.0.0', () => {
    console.log(`Backend listening on port ${config.port}`);
  });
}

module.exports = {
  buildDiagnostics,
  displayTitle,
  buildPlaybackPosition,
  buildRuntimePlaylist,
  moveVideoNext,
  wrapOverlayText,
  playbackHealth,
  writeEvent,
  validateYouTubeConfig,
  youtubeFingerprint,
  validateOutputSelection
};
