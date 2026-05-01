/* ── Helpers ─────────────────────────────────────────────────────── */

function showStatus(el, msg, ok) {
  el.textContent = msg;
  el.className = 'status ' + (ok ? 'ok' : 'err');
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.textContent = ''; el.className = 'status'; }, 6000);
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function fmtDuration(seconds) {
  if (!seconds || seconds < 0) return '0:00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

/* ── Deployment Info ─────────────────────────────────────────────── */

async function loadInfo() {
  try {
    const data = await api('/api/info');
    document.getElementById('info').textContent = JSON.stringify(data, null, 2);
  } catch {
    document.getElementById('info').textContent = 'Error loading info';
  }
}

/* ── Streamer Control ────────────────────────────────────────────── */

let progressState = { elapsed: 0, duration: 0, lastSync: 0 };
let progressInterval = null;

function startProgressTicker() {
  if (progressInterval) return;
  progressInterval = setInterval(() => {
    if (progressState.duration <= 0) return;
    const now = Date.now();
    const elapsed = progressState.elapsed + (now - progressState.lastSync) / 1000;
    const clamped = Math.min(elapsed, progressState.duration);
    const pct = Math.min(100, (clamped / progressState.duration) * 100);
    document.getElementById('progress-bar').style.width = pct + '%';
    document.getElementById('progress-elapsed').textContent = fmtDuration(clamped);
  }, 1000);
}

function stopProgressTicker() {
  if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
}

async function refreshStreamerStatus() {
  try {
    const data = await api('/api/streamer');
    const indicator = document.getElementById('streamer-indicator');
    const label = document.getElementById('streamer-label');
    const uptimeEl = document.getElementById('streamer-uptime');
    const startBtn = document.getElementById('streamer-start');
    const stopBtn = document.getElementById('streamer-stop');
    const nowPlaying = document.getElementById('now-playing');
    const nowTitle = document.getElementById('now-playing-title');
    const progressBarContainer = document.getElementById('progress-bar-container');
    const progressBar = document.getElementById('progress-bar');
    const progressTime = document.getElementById('progress-time');
    const progressElapsed = document.getElementById('progress-elapsed');
    const progressDuration = document.getElementById('progress-duration');
    const upNext = document.getElementById('up-next');
    const upNextLabel = document.getElementById('up-next-label');
    const upNextList = document.getElementById('up-next-list');
    const preview = document.getElementById('stream-preview');
    const previewImg = document.getElementById('preview-img');

    indicator.className = 'indicator ' + (data.active ? 'on' : 'off');
    label.textContent = data.active ? 'Streaming' : 'Stopped';
    uptimeEl.textContent = data.active && data.uptimeSeconds ? '(' + fmtDuration(data.uptimeSeconds) + ')' : '';
    startBtn.disabled = data.active;
    stopBtn.disabled = !data.active;
    document.getElementById('streamer-skip').disabled = !data.active;
    if (data.active && data.nowPlaying) {
      nowTitle.textContent = data.nowPlaying;
      nowPlaying.style.display = '';
      // Progress + preview
      if (data.progress && data.progress.duration > 0) {
        progressState = { elapsed: data.progress.elapsed, duration: data.progress.duration, lastSync: Date.now() };
        const pct = Math.min(100, (data.progress.elapsed / data.progress.duration) * 100);
        progressBar.style.width = pct + '%';
        progressElapsed.textContent = fmtDuration(data.progress.elapsed);
        progressDuration.textContent = fmtDuration(data.progress.duration);
        progressBarContainer.style.display = '';
        progressTime.style.display = '';
        startProgressTicker();
      } else {
        progressBarContainer.style.display = 'none';
        progressTime.style.display = 'none';
        stopProgressTicker();
      }
      previewImg.src = '/stream-preview.jpg?' + Date.now();
      previewImg.onload = () => { preview.style.display = ''; };
      previewImg.onerror = () => { preview.style.display = 'none'; };
    } else {
      nowPlaying.style.display = 'none';
      preview.style.display = 'none';
      progressBarContainer.style.display = 'none';
      progressTime.style.display = 'none';
      stopProgressTicker();
    }

    // Up Next
    if (data.upNext && data.upNext.length > 0) {
      upNextLabel.textContent = data.active ? 'Up Next:' : 'On Resume:';
      upNextList.innerHTML = '';
      for (const item of data.upNext) {
        const li = document.createElement('li');
        const name = typeof item === 'string' ? item : item.name;
        const dur = typeof item === 'object' && item.duration ? ` (${fmtDuration(item.duration)})` : '';
        li.textContent = name + dur;
        upNextList.appendChild(li);
      }
      upNext.style.display = '';
    } else {
      upNext.style.display = 'none';
    }
  } catch {
    document.getElementById('streamer-label').textContent = 'Unknown';
  }
}

document.getElementById('streamer-start').addEventListener('click', async () => {
  const status = document.getElementById('streamer-action-status');
  try {
    document.getElementById('streamer-start').disabled = true;
    await api('/api/streamer/start', { method: 'POST' });
    showStatus(status, 'Streamer started.', true);
    await refreshStreamerStatus();
  } catch (e) { showStatus(status, e.message, false); }
});

document.getElementById('streamer-stop').addEventListener('click', async () => {
  const status = document.getElementById('streamer-action-status');
  try {
    document.getElementById('streamer-stop').disabled = true;
    await api('/api/streamer/stop', { method: 'POST' });
    showStatus(status, 'Streamer stopped.', true);
    await refreshStreamerStatus();
  } catch (e) { showStatus(status, e.message, false); }
});

document.getElementById('streamer-skip').addEventListener('click', async () => {
  const status = document.getElementById('streamer-action-status');
  try {
    document.getElementById('streamer-skip').disabled = true;
    await api('/api/streamer/skip', { method: 'POST' });
    showStatus(status, 'Skipping to next video...', true);
    setTimeout(refreshStreamerStatus, 3000);
  } catch (e) { showStatus(status, e.message, false); }
});

let restartTimer = null;

function showRestartButton() {
  const wrapper = document.getElementById('restart-wrapper');
  const countdown = document.getElementById('restart-countdown');
  if (restartTimer) clearInterval(restartTimer);
  wrapper.style.display = '';
  let remaining = 10;
  countdown.textContent = `(${remaining}s)`;
  restartTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(restartTimer);
      restartTimer = null;
      wrapper.style.display = 'none';
    } else {
      countdown.textContent = `(${remaining}s)`;
    }
  }, 1000);
}

document.getElementById('restart-streamer').addEventListener('click', async () => {
  const status = document.getElementById('settings-status');
  const btn = document.getElementById('restart-streamer');
  const wrapper = document.getElementById('restart-wrapper');
  if (restartTimer) { clearInterval(restartTimer); restartTimer = null; }
  try {
    btn.disabled = true;
    await api('/api/streamer/restart', { method: 'POST' });
    showStatus(status, 'Streamer restarted.', true);
    wrapper.style.display = 'none';
    await refreshStreamerStatus();
  } catch (e) { showStatus(status, e.message, false); }
  finally { btn.disabled = false; }
});

/* ── Stream Key ──────────────────────────────────────────────────── */

document.getElementById('stream-key-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = document.getElementById('stream-key-status');
  const input = document.getElementById('stream-key-input');
  try {
    await api('/api/stream-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ streamKey: input.value })
    });
    input.value = '';
    showStatus(status, 'Stream key updated.', true);
  } catch (e) { showStatus(status, e.message, false); }
});

/* ── Settings ────────────────────────────────────────────────────── */

async function loadSettings() {
  try {
    const data = await api('/api/settings');
    document.getElementById('max-resolution').value = data.max_resolution;
    document.getElementById('shuffle-toggle').checked = data.shuffle;
    document.getElementById('watermark-toggle').checked = data.watermark;
  } catch { /* use defaults */ }
}

document.getElementById('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = document.getElementById('settings-status');
  try {
    await api('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        max_resolution: document.getElementById('max-resolution').value,
        shuffle: document.getElementById('shuffle-toggle').checked,
        watermark: document.getElementById('watermark-toggle').checked
      })
    });
    showStatus(status, 'Settings saved.', true);
    showRestartButton();
  } catch (e) { showStatus(status, e.message, false); }
});

/* ── Playlist / Videos ───────────────────────────────────────────── */

let videoData = [];
let dragSrcIdx = null;

async function loadVideos() {
  const list = document.getElementById('video-list');
  const loading = document.getElementById('video-list-loading');
  try {
    const data = await api('/api/videos');
    videoData = data.videos;
    loading.style.display = 'none';
    renderVideoList();
    document.getElementById('save-playlist').disabled = false;
  } catch {
    loading.textContent = 'Error loading videos.';
  }
}

function renderVideoList() {
  const list = document.getElementById('video-list');
  list.innerHTML = '';
  videoData.forEach((v, i) => {
    const li = document.createElement('li');
    li.draggable = true;
    li.dataset.idx = i;
    li.className = v.enabled ? '' : 'disabled';

    const grip = document.createElement('span');
    grip.className = 'grip';
    grip.textContent = '☰';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = v.enabled;
    cb.addEventListener('change', () => {
      videoData[i].enabled = cb.checked;
      li.className = cb.checked ? '' : 'disabled';
    });

    const label = document.createElement('span');
    label.className = 'video-name';
    label.textContent = v.file;

    const num = document.createElement('span');
    num.className = 'video-num';
    num.textContent = '#' + (i + 1);

    li.appendChild(grip);
    li.appendChild(cb);
    li.appendChild(label);
    li.appendChild(num);

    li.addEventListener('dragstart', onDragStart);
    li.addEventListener('dragover', onDragOver);
    li.addEventListener('drop', onDrop);
    li.addEventListener('dragend', onDragEnd);

    list.appendChild(li);
  });
}

function onDragStart(e) {
  dragSrcIdx = +e.currentTarget.dataset.idx;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}
function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drag-over');
}
function onDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  const targetIdx = +e.currentTarget.dataset.idx;
  if (dragSrcIdx === null || dragSrcIdx === targetIdx) return;
  const [moved] = videoData.splice(dragSrcIdx, 1);
  videoData.splice(targetIdx, 0, moved);
  renderVideoList();
}
function onDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  document.querySelectorAll('#video-list li').forEach(li => li.classList.remove('drag-over'));
}

document.getElementById('save-playlist').addEventListener('click', async () => {
  const status = document.getElementById('playlist-status');
  try {
    await api('/api/videos', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videos: videoData })
    });
    showStatus(status, 'Playlist saved and regenerated.', true);
  } catch (e) { showStatus(status, e.message, false); }
});

document.getElementById('select-all').addEventListener('click', () => {
  videoData.forEach(v => v.enabled = true);
  renderVideoList();
});
document.getElementById('deselect-all').addEventListener('click', () => {
  videoData.forEach(v => v.enabled = false);
  renderVideoList();
});

/* ── Playlist Sort / Shuffle ─────────────────────────────────────── */

function parseDateFromFilename(filename) {
  // Match patterns like "January 2, 2025" or "Dec 25, 2024" at the start
  const match = filename.match(/^([A-Za-z]+\s+\d{1,2},\s*\d{4})/);
  if (!match) return null;
  const d = new Date(match[1]);
  return isNaN(d.getTime()) ? null : d;
}

document.getElementById('sort-name').addEventListener('click', () => {
  videoData.sort((a, b) => a.file.localeCompare(b.file, undefined, { numeric: true }));
  renderVideoList();
});

document.getElementById('sort-date').addEventListener('click', () => {
  videoData.sort((a, b) => {
    const da = parseDateFromFilename(a.file);
    const db = parseDateFromFilename(b.file);
    // Files with dates come first, sorted chronologically
    if (da && db) return da - db;
    if (da && !db) return -1;
    if (!da && db) return 1;
    // Both undated: alphabetical
    return a.file.localeCompare(b.file, undefined, { numeric: true });
  });
  renderVideoList();
});

document.getElementById('sort-shuffle').addEventListener('click', () => {
  // Fisher-Yates shuffle
  for (let i = videoData.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [videoData[i], videoData[j]] = [videoData[j], videoData[i]];
  }
  renderVideoList();
});

/* ── Service Health ──────────────────────────────────────────────── */

async function loadHealth() {
  const grid = document.getElementById('health-grid');
  try {
    const data = await api('/api/health');
    grid.innerHTML = '';
    for (const [unit, state] of Object.entries(data)) {
      const el = document.createElement('div');
      el.className = 'health-item';
      const dot = document.createElement('span');
      dot.className = 'indicator ' + (state === 'active' ? 'on' : 'off');
      const name = document.createElement('span');
      name.textContent = unit.replace('.service', '').replace('.timer', '').replace('.mount', '');
      const st = document.createElement('span');
      st.className = 'health-state';
      st.textContent = state;
      el.appendChild(dot);
      el.appendChild(name);
      el.appendChild(st);
      grid.appendChild(el);
    }
  } catch {
    grid.textContent = 'Error loading health';
  }
}

/* ── Schedule ────────────────────────────────────────────────────── */

let scheduleData = { timezone: 'UTC', events: [] };

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

async function loadSchedule() {
  try {
    const data = await api('/api/schedule');
    scheduleData = { timezone: data.timezone, events: data.events };
    document.getElementById('next-start').textContent = fmtDate(data.nextStart);
    document.getElementById('next-stop').textContent = fmtDate(data.nextStop);
    document.getElementById('schedule-tz').value = data.timezone;
    renderScheduleEvents();
    renderScheduleEditor();
  } catch {}
}

function renderScheduleEvents() {
  const el = document.getElementById('schedule-events');
  if (!scheduleData.events.length) {
    el.innerHTML = '<p class="hint">No events configured.</p>';
    return;
  }
  let html = '<table class="schedule-table"><tr><th>Name</th><th>Days</th><th>Start</th><th>Stop</th></tr>';
  for (const e of scheduleData.events) {
    html += `<tr><td>${esc(e.name)}</td><td>${e.days.join(', ')}</td><td>${e.start}</td><td>${e.stop}</td></tr>`;
  }
  html += '</table>';
  el.innerHTML = html;
}

const ALL_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function renderScheduleEditor() {
  const list = document.getElementById('schedule-event-list');
  list.innerHTML = '';
  scheduleData.events.forEach((evt, i) => {
    const div = document.createElement('div');
    div.className = 'event-editor';
    div.innerHTML = `
      <input type="text" value="${esc(evt.name)}" data-field="name" placeholder="Event name" size="16">
      <input type="time" value="${evt.start}" data-field="start">
      <input type="time" value="${evt.stop}" data-field="stop">
      <div class="day-checks">${ALL_DAYS.map(d =>
        `<label class="day-label"><input type="checkbox" value="${d}" ${evt.days.includes(d) ? 'checked' : ''}>${d}</label>`
      ).join('')}</div>
      <button class="secondary remove-event" data-idx="${i}">&#10005;</button>
    `;
    list.appendChild(div);
  });
  list.querySelectorAll('.remove-event').forEach(btn => {
    btn.addEventListener('click', () => {
      scheduleData.events.splice(+btn.dataset.idx, 1);
      renderScheduleEditor();
    });
  });
}

function collectScheduleEdits() {
  const editors = document.querySelectorAll('.event-editor');
  scheduleData.timezone = document.getElementById('schedule-tz').value.trim() || 'UTC';
  scheduleData.events = Array.from(editors).map(div => ({
    name: div.querySelector('[data-field="name"]').value,
    start: div.querySelector('[data-field="start"]').value,
    stop: div.querySelector('[data-field="stop"]').value,
    days: Array.from(div.querySelectorAll('.day-checks input:checked')).map(cb => cb.value)
  })).filter(e => e.name && e.start && e.stop && e.days.length);
}

document.getElementById('add-event').addEventListener('click', () => {
  collectScheduleEdits();
  scheduleData.events.push({ name: 'New Event', start: '18:00', stop: '20:00', days: ['Mon', 'Wed', 'Fri'] });
  renderScheduleEditor();
});

document.getElementById('save-schedule').addEventListener('click', async () => {
  const status = document.getElementById('schedule-status');
  collectScheduleEdits();
  try {
    await api('/api/schedule', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scheduleData)
    });
    showStatus(status, 'Schedule saved.', true);
    loadSchedule();
  } catch (e) { showStatus(status, e.message, false); }
});

/* ── System / Storage ────────────────────────────────────────────── */

async function loadSystem() {
  try {
    const data = await api('/api/system');
    const uptimeSec = Math.floor(parseFloat(data.uptime) || 0);
    const days = Math.floor(uptimeSec / 86400);
    const hrs = Math.floor((uptimeSec % 86400) / 3600);
    document.getElementById('system-stats').innerHTML = `
      <div class="stat-row"><strong>Uptime:</strong> ${days}d ${hrs}h</div>
      <div class="stat-row"><strong>CPU:</strong> ${data.cpu.load1m != null ? data.cpu.load1m.toFixed(2) : '?'} / ${data.cpu.cores || '?'} cores (1m avg)</div>
      <div class="stat-row"><strong>Memory:</strong> ${data.memory.usedMB || '?'} / ${data.memory.totalMB || '?'} MB</div>
      <div class="stat-row"><strong>Disk:</strong> ${data.disk.usedGB || '?'} / ${data.disk.totalGB || '?'} GB</div>
    `;
  } catch {
    document.getElementById('system-stats').textContent = 'Error';
  }
}

async function loadStorage() {
  try {
    const data = await api('/api/storage');
    document.getElementById('storage-stats').innerHTML = `
      <div class="stat-row"><strong>Videos:</strong> ${data.fileCount}</div>
      <div class="stat-row"><strong>Total size:</strong> ${data.totalGB} GB</div>
    `;
  } catch {
    document.getElementById('storage-stats').textContent = 'Error';
  }
}

/* ── Logs ────────────────────────────────────────────────────────── */

document.getElementById('refresh-logs').addEventListener('click', async () => {
  const service = document.getElementById('log-service').value;
  const lines = document.getElementById('log-lines').value;
  const output = document.getElementById('log-output');
  output.textContent = 'Loading...';
  try {
    const data = await api(`/api/logs?service=${encodeURIComponent(service)}&lines=${lines}`);
    output.textContent = data.lines || '(no output)';
    output.scrollTop = output.scrollHeight;
  } catch (e) {
    output.textContent = 'Error: ' + e.message;
  }
});

/* ── Upload ───────────────────────────────────────────────────────── */

const uploadArea = document.getElementById('upload-area');
const uploadInput = document.getElementById('upload-input');
const uploadQueue = document.getElementById('upload-queue');
const uploadStatus = document.getElementById('upload-status');

uploadArea.addEventListener('click', () => uploadInput.click());
uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.classList.add('drag-over'); });
uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('drag-over'));
uploadArea.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadArea.classList.remove('drag-over');
  handleFiles(e.dataTransfer.files);
});
uploadInput.addEventListener('change', () => { handleFiles(uploadInput.files); uploadInput.value = ''; });

async function handleFiles(files) {
  for (const file of files) {
    await uploadFile(file);
  }
  loadVideos();
  loadStorage();
}

async function uploadFile(file) {
  const item = document.createElement('div');
  item.className = 'upload-item';
  item.innerHTML = `
    <span class="upload-name">${esc(file.name)}</span>
    <span class="upload-size">${(file.size / (1024 * 1024)).toFixed(1)} MB</span>
    <div class="upload-progress-bar"><div class="upload-progress-fill"></div></div>
    <span class="upload-pct">0%</span>
  `;
  uploadQueue.appendChild(item);
  const fill = item.querySelector('.upload-progress-fill');
  const pct = item.querySelector('.upload-pct');

  try {
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/videos/upload');
      xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const p = Math.round((e.loaded / e.total) * 100);
          fill.style.width = p + '%';
          pct.textContent = p + '%';
        }
      };
      xhr.onload = () => {
        if (xhr.status === 200) {
          fill.style.width = '100%';
          fill.style.background = '#43a047';
          pct.textContent = '✓';
          resolve();
        } else {
          let msg = 'Upload failed';
          try { msg = JSON.parse(xhr.responseText).error; } catch {}
          reject(new Error(msg));
        }
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.send(file);
    });
  } catch (e) {
    fill.style.width = '100%';
    fill.style.background = '#d32f2f';
    pct.textContent = '✗';
    showStatus(uploadStatus, e.message, false);
  }
}

/* ── Update ───────────────────────────────────────────────────────── */

document.getElementById('run-update').addEventListener('click', async () => {
  const btn = document.getElementById('run-update');
  const output = document.getElementById('update-output');
  const status = document.getElementById('update-status');
  const useBeta = document.getElementById('update-beta').checked;
  const branch = useBeta ? 'beta' : 'main';
  btn.disabled = true;
  btn.textContent = `Updating (${branch})...`;
  output.style.display = 'none';
  try {
    const res = await fetch('/api/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch })
    });
    const data = await res.json();
    output.textContent = data.output || data.error || 'No output';
    output.style.display = '';
    if (!res.ok) {
      showStatus(status, data.error || 'Update failed', false);
    } else {
      showStatus(status, 'Update complete.', true);
    }
  } catch (e) {
    showStatus(status, e.message, false);
    output.textContent = e.message;
    output.style.display = '';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Check for Updates';
  }
});

/* ── Dark Mode ────────────────────────────────────────────────────── */

const darkToggle = document.getElementById('dark-mode-toggle');
if (localStorage.getItem('dark') === '1') {
  document.body.classList.add('dark');
  darkToggle.checked = true;
}
darkToggle.addEventListener('change', () => {
  document.body.classList.toggle('dark', darkToggle.checked);
  localStorage.setItem('dark', darkToggle.checked ? '1' : '0');
});

/* ── Init ────────────────────────────────────────────────────────── */

loadInfo();
loadSettings();
loadVideos();
refreshStreamerStatus();
loadHealth();
loadSchedule();
loadSystem();
loadStorage();

setInterval(() => { refreshStreamerStatus(); }, 5000);
setInterval(() => { loadHealth(); }, 10000);
setInterval(() => { loadSystem(); loadStorage(); }, 60000);
