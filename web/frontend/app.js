/* ── Helpers ─────────────────────────────────────────────────────── */

function showStatus(el, msg, ok, persist) {
  el.textContent = msg;
  el.className = 'status ' + (ok ? 'ok' : 'err');
  clearTimeout(el._t);
  if (!persist) {
    el._t = setTimeout(() => { el.textContent = ''; el.className = 'status'; }, 6000);
  }
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
    // Populate footer version
    const versionEl = document.getElementById('app-version');
    if (versionEl && data.version) {
      versionEl.textContent = `${data.branch || 'main'} @ ${data.version}`;
    }
    // Show VM controls only in Azure mode
    if (data.mode === 'azure') {
      document.getElementById('vm-controls').style.display = '';
    }
  } catch {
    document.getElementById('info').textContent = 'Error loading info';
  }
}

/* ── Streamer Control ────────────────────────────────────────────── */

let progressState = { elapsed: 0, duration: 0, lastSync: 0 };
let progressInterval = null;
let lastVideoEndRefresh = 0;

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
    // When video should have ended, refresh to get new video info (max once per 5s)
    if (elapsed >= progressState.duration + 2 && now - lastVideoEndRefresh > 5000) {
      lastVideoEndRefresh = now;
      refreshStreamerStatus();
    }
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
    const previewLand = document.getElementById('preview-img-landscape');
    const previewPort = document.getElementById('preview-img-portrait');

    indicator.className = 'indicator ' + (data.active ? 'on' : 'off');
    label.textContent = data.active ? 'Streaming' : 'Stopped';
    uptimeEl.textContent = data.active && data.uptimeSeconds ? '(' + fmtDuration(data.uptimeSeconds) + ')' : '';
    startBtn.disabled = data.active;
    stopBtn.disabled = !data.active;
    document.getElementById('streamer-skip').disabled = !data.active;
    const stopAfterBtn = document.getElementById('streamer-stop-after');
    stopAfterBtn.disabled = !data.active;
    if (data.active && data.stopPending) {
      stopAfterBtn.textContent = 'Cancel Stop After Current';
      stopAfterBtn.classList.add('pending');
    } else {
      stopAfterBtn.textContent = 'Stop After Current';
      stopAfterBtn.classList.remove('pending');
    }
    if (data.active && data.nowPlaying) {
      nowTitle.textContent = data.nowPlaying;
      nowPlaying.style.display = '';
      // Active stream badges — clickable to toggle preview
      const activeStreamsEl = document.getElementById('active-streams');
      const landBadge = document.getElementById('stream-badge-landscape');
      const portBadge = document.getElementById('stream-badge-portrait');
      if (data.activeStreams) {
        activeStreamsEl.style.display = '';
        const hasLand = data.activeStreams.landscape;
        const hasPort = data.activeStreams.portrait;
        landBadge.style.display = hasLand ? '' : 'none';
        portBadge.style.display = hasPort ? '' : 'none';
        // Default: show all active previews
        if (hasLand) landBadge.classList.add('active');
        if (hasPort) portBadge.classList.add('active');
        // Click toggles which preview is visible
        landBadge.onclick = () => {
          landBadge.classList.toggle('active');
          previewLand.style.display = landBadge.classList.contains('active') && previewLand.src ? '' : 'none';
        };
        portBadge.onclick = () => {
          portBadge.classList.toggle('active');
          previewPort.style.display = portBadge.classList.contains('active') && previewPort.src ? '' : 'none';
        };
      } else {
        activeStreamsEl.style.display = 'none';
      }
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
      // Load preview images for active streams
      const ts = Date.now();
      const showLand = data.activeStreams ? data.activeStreams.landscape : true;
      const showPort = data.activeStreams ? data.activeStreams.portrait : false;
      preview.style.display = '';  // Show container; individual imgs control visibility
      if (showLand) {
        previewLand.src = '/stream-preview.jpg?' + ts;
        previewLand.onload = () => { previewLand.style.display = ''; };
        previewLand.onerror = () => { previewLand.style.display = 'none'; };
      } else {
        previewLand.style.display = 'none';
        previewLand.removeAttribute('src');
      }
      if (showPort) {
        previewPort.src = '/stream-preview-portrait.jpg?' + ts;
        previewPort.onload = () => { previewPort.style.display = ''; };
        previewPort.onerror = () => { previewPort.style.display = 'none'; };
      } else {
        previewPort.style.display = 'none';
        previewPort.removeAttribute('src');
      }
    } else {
      nowPlaying.style.display = 'none';
      preview.style.display = 'none';
      progressBarContainer.style.display = 'none';
      progressTime.style.display = 'none';
      document.getElementById('active-streams').style.display = 'none';
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

document.getElementById('streamer-stop-after').addEventListener('click', async () => {
  const status = document.getElementById('streamer-action-status');
  const btn = document.getElementById('streamer-stop-after');
  const isPending = btn.classList.contains('pending');
  try {
    btn.disabled = true;
    if (isPending) {
      await api('/api/streamer/stop-after-current', { method: 'DELETE' });
      showStatus(status, 'Stop after current cancelled.', true);
    } else {
      await api('/api/streamer/stop-after-current', { method: 'POST' });
      showStatus(status, 'Will stop after current video.', true);
    }
    await refreshStreamerStatus();
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

/* ── Stream Keys (inline in settings) ─────────────────────────────── */

document.querySelectorAll('.stream-key-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const status = document.getElementById('settings-status');
    const profile = btn.dataset.profile;
    const input = btn.closest('.stream-key-inline').querySelector('input');
    if (!input.value) return;
    try {
      await api('/api/stream-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ streamKey: input.value, profile })
      });
      input.value = '';
      showStatus(status, `Stream key updated (${profile}).`, true);
    } catch (e) { showStatus(status, e.message, false); }
  });
});

/* ── Settings ────────────────────────────────────────────────────── */

async function loadSettings() {
  try {
    const data = await api('/api/settings');
    document.getElementById('shuffle-toggle').checked = data.shuffle;
    document.getElementById('branding-name').value = data.branding_name || '';
    document.getElementById('branding-location').value = data.branding_location || '';
    // Per-stream settings
    const land = data.streams?.landscape || {};
    const port = data.streams?.portrait || {};
    document.getElementById('land-max-resolution').value = land.max_resolution || data.max_resolution || '720p';
    document.getElementById('land-watermark-toggle').checked = land.watermark ?? data.watermark ?? false;
    document.getElementById('port-max-resolution').value = port.max_resolution || '1080p';
    document.getElementById('port-watermark-toggle').checked = port.watermark ?? false;
    // Update legend labels with configured names
    if (land.name) document.getElementById('landscape-legend').textContent = land.name;
    if (port.name) document.getElementById('portrait-legend').textContent = port.name;
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
        shuffle: document.getElementById('shuffle-toggle').checked,
        branding_name: document.getElementById('branding-name').value.trim(),
        branding_location: document.getElementById('branding-location').value.trim(),
        streams: {
          landscape: {
            max_resolution: document.getElementById('land-max-resolution').value,
            watermark: document.getElementById('land-watermark-toggle').checked
          },
          portrait: {
            max_resolution: document.getElementById('port-max-resolution').value,
            watermark: document.getElementById('port-watermark-toggle').checked
          }
        }
      })
    });
    showStatus(status, 'Settings saved.', true);
    showRestartButton();
  } catch (e) { showStatus(status, e.message, false); }
});

/* ── Playlist / Videos ───────────────────────────────────────────── */

let videoData = [];
let sortableInstance = null;

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

function renderVideoList(filter) {
  const list = document.getElementById('video-list');
  list.innerHTML = '';
  const query = (filter || '').toLowerCase();
  videoData.forEach((v, i) => {
    const displayTitle = v.title || v.file.replace(/\.[^.]+$/, '');
    if (query && !displayTitle.toLowerCase().includes(query) && !v.file.toLowerCase().includes(query)) {
      return; // skip items that don't match search
    }

    const li = document.createElement('li');
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

    const nameBlock = document.createElement('div');
    nameBlock.className = 'video-name-block';

    // Title row: title text + pencil edit icon
    const titleRow = document.createElement('div');
    titleRow.className = 'video-title-row';

    const titleSpan = document.createElement('span');
    titleSpan.className = 'video-title-display';
    titleSpan.textContent = displayTitle;

    const editBtn = document.createElement('button');
    editBtn.className = 'video-edit-btn';
    editBtn.textContent = '✏️';
    editBtn.title = 'Edit title';

    // Hidden inline edit input
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'video-title-input';
    titleInput.value = v.title || displayTitle;
    titleInput.style.display = 'none';

    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      titleSpan.style.display = 'none';
      editBtn.style.display = 'none';
      titleInput.style.display = '';
      titleInput.focus();
      titleInput.select();
    });

    function commitEdit() {
      const newTitle = titleInput.value.trim();
      // If input matches derived filename title, store as empty (use default)
      const derived = v.file.replace(/\.[^.]+$/, '');
      videoData[i].title = (newTitle === derived) ? '' : newTitle;
      titleSpan.textContent = newTitle || derived;
      titleInput.style.display = 'none';
      titleSpan.style.display = '';
      editBtn.style.display = '';
    }

    titleInput.addEventListener('blur', commitEdit);
    titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
      if (e.key === 'Escape') {
        titleInput.value = v.title || displayTitle;
        titleInput.style.display = 'none';
        titleSpan.style.display = '';
        editBtn.style.display = '';
      }
    });

    titleRow.appendChild(titleSpan);
    titleRow.appendChild(editBtn);
    titleRow.appendChild(titleInput);

    // Filename row (muted, smaller)
    const fileRow = document.createElement('div');
    fileRow.className = 'video-filename';
    fileRow.textContent = v.file;

    nameBlock.appendChild(titleRow);
    nameBlock.appendChild(fileRow);

    const num = document.createElement('span');
    num.className = 'video-num';
    num.textContent = '#' + (i + 1);

    li.appendChild(grip);
    li.appendChild(cb);
    li.appendChild(nameBlock);
    li.appendChild(num);

    list.appendChild(li);
  });

  // (Re-)initialize SortableJS for mouse + touch drag support
  if (sortableInstance) sortableInstance.destroy();
  sortableInstance = new Sortable(list, {
    handle: '.grip',
    animation: 150,
    ghostClass: 'sortable-ghost',
    chosenClass: 'sortable-chosen',
    dragClass: 'sortable-drag',
    onEnd: function (evt) {
      if (evt.oldIndex === evt.newIndex) return;
      if (query) {
        // Filter is active: DOM indices ≠ videoData indices.
        // Read the new visual order via data-idx (set by renderVideoList, unchanged by SortableJS).
        const newVisibleIdxs = [...list.querySelectorAll('li')].map(li => parseInt(li.dataset.idx, 10));
        // Sorted positions in videoData that the visible items occupy
        const visiblePositions = newVisibleIdxs.slice().sort((a, b) => a - b);
        const newVideoData = [...videoData];
        for (let i = 0; i < visiblePositions.length; i++) {
          newVideoData[visiblePositions[i]] = videoData[newVisibleIdxs[i]];
        }
        videoData.length = 0;
        videoData.push(...newVideoData);
      } else {
        const [moved] = videoData.splice(evt.oldIndex, 1);
        videoData.splice(evt.newIndex, 0, moved);
      }
      renderVideoList(query);
    }
  });
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

/* ── Title Suggestions Modal ─────────────────────────────────────── */

function needsTitleSuggestion(v) {
  // If the user has already set a custom title, no suggestion needed
  if (v.title && v.title.trim()) return false;
  const name = v.file.replace(/\.[^.]+$/, '');
  if (name.includes('_')) return true;
  if (/version/i.test(name)) return true;
  if (/\.(mp4|mkv|mov|avi|ts|flv)/i.test(name)) return true;
  if (!/^[A-Za-z]+ \d{1,2},\s*\d{4}/.test(name)) return true;
  return false;
}

function suggestTitle(filename) {
  let t = filename.replace(/\.[^.]+$/, '');
  t = t.replace(/_/g, ' ');
  // Remove trailing version-like patterns (v2, v3, etc.)
  t = t.replace(/\s*v\d+$/i, '');
  // Remove embedded file extensions
  t = t.replace(/\.(mp4|mkv|mov|avi|ts|flv)/gi, '');
  return t.trim();
}

document.getElementById('title-suggestions').addEventListener('click', () => {
  const modal = document.getElementById('title-modal');
  const list = document.getElementById('title-modal-list');
  list.innerHTML = '';

  const candidates = videoData
    .map((v, i) => ({ ...v, idx: i }))
    .filter(needsTitleSuggestion);

  if (candidates.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'All files look good — no suggestions needed.';
    list.appendChild(li);
  } else {
    candidates.forEach(c => {
      const li = document.createElement('li');
      li.dataset.idx = c.idx;

      const nameEl = document.createElement('div');
      nameEl.className = 'video-name';
      nameEl.textContent = c.file;

      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'Display title';
      input.value = c.title || suggestTitle(c.file);
      input.dataset.idx = c.idx;

      li.appendChild(nameEl);
      li.appendChild(input);
      list.appendChild(li);
    });
  }

  modal.style.display = '';
});

document.getElementById('title-modal-apply').addEventListener('click', () => {
  const inputs = document.querySelectorAll('#title-modal-list input');
  inputs.forEach(input => {
    const idx = +input.dataset.idx;
    videoData[idx].title = input.value.trim();
  });
  document.getElementById('title-modal').style.display = 'none';
  renderVideoList();
});

document.getElementById('title-modal-close').addEventListener('click', () => {
  document.getElementById('title-modal').style.display = 'none';
});
document.getElementById('title-modal-cancel').addEventListener('click', () => {
  document.getElementById('title-modal').style.display = 'none';
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

// Playlist search filter
document.getElementById('playlist-search').addEventListener('input', (e) => {
  renderVideoList(e.target.value);
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

function populateTimezoneDropdown(selectId, selectedTz) {
  const select = document.getElementById(selectId);
  if (select.options.length === 0) {
    const timezones = ['UTC'].concat(Intl.supportedValuesOf('timeZone').filter(t => t !== 'UTC'));
    for (const tz of timezones) {
      const opt = document.createElement('option');
      opt.value = tz;
      opt.textContent = tz.replace(/_/g, ' ');
      select.appendChild(opt);
    }
  }
  if (selectedTz) select.value = selectedTz;
}

// Populate timezone options immediately so the dropdowns are never empty
populateTimezoneDropdown('schedule-tz', 'UTC');
populateTimezoneDropdown('override-tz', 'UTC');

async function loadSchedule() {
  try {
    const data = await api('/api/schedule');
    scheduleData = { timezone: data.timezone, events: data.events };
    document.getElementById('next-start').textContent = fmtDate(data.nextStart);
    document.getElementById('next-stop').textContent = fmtDate(data.nextStop);
    populateTimezoneDropdown('schedule-tz', data.timezone);
    populateTimezoneDropdown('override-tz', data.timezone);
    renderScheduleEvents();
    renderScheduleEditor();
    renderOverrides(data.overrides || []);
  } catch {}
}

function renderScheduleEvents() {
  const el = document.getElementById('schedule-events');
  if (!scheduleData.events.length) {
    el.innerHTML = '<p class="hint">No events configured.</p>';
    return;
  }
  const now = new Date();
  const dayAbbrs = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const todayAbbr = dayAbbrs[now.getDay()];
  const nowMins = now.getHours() * 60 + now.getMinutes();

  let html = '<table class="schedule-table"><tr><th>Name</th><th>Days</th><th>Start</th><th>Stop</th><th>Streams</th></tr>';
  for (const e of scheduleData.events) {
    const streams = (e.streams || ['landscape']).join(', ');
    // Check if this event is currently active
    let isActive = false;
    if (e.days && e.days.includes(todayAbbr) && e.start && e.stop) {
      const [sh, sm] = e.start.split(':').map(Number);
      const [eh, em] = e.stop.split(':').map(Number);
      const startMins = sh * 60 + sm;
      const stopMins = eh * 60 + em;
      isActive = nowMins >= startMins && nowMins < stopMins;
    }
    const cls = isActive ? ' class="active-event"' : '';
    html += `<tr${cls}><td>${esc(e.name)}</td><td>${e.days.join(', ')}</td><td>${e.start}</td><td>${e.stop}</td><td>${esc(streams)}</td></tr>`;
  }
  html += '</table>';
  el.innerHTML = html;
}

const ALL_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function renderScheduleEditor() {
  const list = document.getElementById('schedule-event-list');
  list.innerHTML = '';
  const ALL_STREAMS = ['landscape', 'portrait'];
  scheduleData.events.forEach((evt, i) => {
    const evtStreams = evt.streams || ['landscape'];
    const div = document.createElement('div');
    div.className = 'event-editor';
    div.innerHTML = `
      <input type="text" value="${esc(evt.name)}" data-field="name" placeholder="Event name" size="16">
      <input type="time" value="${evt.start}" data-field="start">
      <input type="time" value="${evt.stop}" data-field="stop">
      <div class="day-checks">${ALL_DAYS.map(d =>
        `<label class="day-label"><input type="checkbox" value="${d}" ${evt.days.includes(d) ? 'checked' : ''}>${d}</label>`
      ).join('')}</div>
      <div class="stream-checks">${ALL_STREAMS.map(s =>
        `<label class="stream-label"><input type="checkbox" value="${s}" data-stream ${evtStreams.includes(s) ? 'checked' : ''}>${s}</label>`
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
    days: Array.from(div.querySelectorAll('.day-checks input:checked')).map(cb => cb.value),
    streams: Array.from(div.querySelectorAll('[data-stream]:checked')).map(cb => cb.value)
  })).filter(e => e.name && e.start && e.stop && e.days.length && e.streams.length);
}

document.getElementById('add-event').addEventListener('click', () => {
  collectScheduleEdits();
  scheduleData.events.push({ name: 'New Event', start: '18:00', stop: '20:00', days: ['Mon', 'Wed', 'Fri'], streams: ['landscape'] });
  renderScheduleEditor();
});

document.getElementById('save-schedule').addEventListener('click', async () => {
  const status = document.getElementById('schedule-status');
  const btn = document.getElementById('save-schedule');
  collectScheduleEdits();
  btn.disabled = true;
  showStatus(status, 'Saving and syncing to Azure\u2026', true, true);
  try {
    const result = await api('/api/schedule', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scheduleData)
    });
    if (result.syncError) {
      showStatus(status, `Schedule saved, but Azure sync failed: ${result.syncError}`, false);
    } else {
      showStatus(status, 'Schedule saved and synced to Azure.', true);
    }
    loadSchedule();
  } catch (e) { showStatus(status, e.message, false); }
  finally { btn.disabled = false; }
});

/* ── Schedule Overrides ──────────────────────────────────────────── */

function renderOverrides(overrides) {
  const el = document.getElementById('override-list');
  if (!overrides.length) {
    el.innerHTML = '<p class="hint">No upcoming overrides.</p>';
    return;
  }
  let html = '<table class="schedule-table"><tr><th>Date</th><th>Name</th><th>Start</th><th>Stop</th><th>Streams</th><th>TZ</th><th></th></tr>';
  for (const o of overrides) {
    const startCell = o.startNow ? `<em>now</em> (${esc(o.start)})` : (o.start ? esc(o.start) : '<em>skip</em>');
    const stopCell  = o.stop  ? esc(o.stop)  : '<em>skip</em>';
    const tzCell    = o.timezone ? esc(o.timezone) : '<em>default</em>';
    const streamsCell = (o.streams || ['landscape']).join(', ');
    html += `<tr>
      <td>${esc(o.date)}</td>
      <td>${esc(o.name || '')}</td>
      <td>${startCell}</td>
      <td>${stopCell}</td>
      <td>${esc(streamsCell)}</td>
      <td>${tzCell}</td>
      <td><button class="secondary override-delete-btn" data-date="${esc(o.date)}">Remove</button></td>
    </tr>`;
  }
  html += '</table>';
  el.innerHTML = html;
  el.querySelectorAll('.override-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteOverride(btn.dataset.date));
  });
}

async function deleteOverride(date) {
  const status = document.getElementById('override-status');
  try {
    await api(`/api/overrides?date=${encodeURIComponent(date)}`, { method: 'DELETE' });
    showStatus(status, 'Override removed.', true);
    loadSchedule();
  } catch (e) { showStatus(status, e.message, false); }
}

document.getElementById('override-skip').addEventListener('change', () => {
  const skip = document.getElementById('override-skip').checked;
  document.getElementById('override-times').style.display = skip ? 'none' : '';
  document.getElementById('override-streams').style.display = skip ? 'none' : '';
  if (skip) document.getElementById('override-start-now').checked = false;
});

document.getElementById('override-start-now').addEventListener('change', () => {
  const startNow = document.getElementById('override-start-now').checked;
  const startInput = document.getElementById('override-start');
  const dateInput = document.getElementById('override-date');
  if (startNow) {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    startInput.value = `${hh}:${mm}`;
    startInput.disabled = true;
    dateInput.value = now.toISOString().slice(0, 10);
  } else {
    startInput.disabled = false;
  }
});

document.getElementById('save-override').addEventListener('click', async () => {
  const status = document.getElementById('override-status');
  const date  = document.getElementById('override-date').value;
  const name  = document.getElementById('override-name').value.trim();
  const skip  = document.getElementById('override-skip').checked;
  const startNow = document.getElementById('override-start-now').checked;
  const start = skip ? null : document.getElementById('override-start').value;
  const stop  = skip ? null : document.getElementById('override-stop').value;

  if (!date) return showStatus(status, 'Please select a date.', false);
  if (!skip && !stop) return showStatus(status, 'Please provide a Stop time.', false);
  if (!skip && !startNow && !start) return showStatus(status, 'Please provide a Start time or check "Start now".', false);

  // null start/stop signals "skip this day entirely" to the backend
  const streams = Array.from(document.querySelectorAll('#override-streams input:checked')).map(cb => cb.value);
  if (!skip && streams.length === 0) return showStatus(status, 'Please select at least one stream.', false);
  const payload = { date, start, stop };
  if (!skip) payload.streams = streams;
  if (startNow) payload.startNow = true;
  if (name) payload.name = name;
  const overrideTz = document.getElementById('override-tz').value;
  if (overrideTz && overrideTz !== scheduleData.timezone) payload.timezone = overrideTz;

  showStatus(status, 'Saving and syncing to Azure\u2026', true, true);
  try {
    const result = await api('/api/overrides', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (result.syncError) {
      showStatus(status, `Override saved, but Azure sync failed: ${result.syncError}`, false);
    } else {
      showStatus(status, 'Override saved and synced.', true);
    }
    document.getElementById('override-add-details').removeAttribute('open');
    document.getElementById('override-start-now').checked = false;
    document.getElementById('override-start').disabled = false;
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

/* ── VM Deallocate ───────────────────────────────────────────────── */

document.getElementById('vm-deallocate').addEventListener('click', async () => {
  const confirmed = confirm(
    'Are you sure you want to shut down and deallocate this VM?\n\n' +
    'This will stop the stream, terminate all services, and deallocate the VM ' +
    '(stopping billing). The VM will not restart until the next scheduled time ' +
    'or manual intervention.'
  );
  if (!confirmed) return;

  const status = document.getElementById('vm-status');
  showStatus(status, 'Triggering VM deallocate…', true, true);
  try {
    const result = await api('/api/vm/deallocate', { method: 'POST' });
    showStatus(status, result.message || 'Deallocate triggered.', true);
  } catch (e) {
    showStatus(status, e.message, false);
  }
});

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

(function () {
  const btn = document.getElementById('run-update');
  const output = document.getElementById('update-output');
  const status = document.getElementById('update-status');
  const actions = document.getElementById('update-actions');
  const applyBtn = document.getElementById('apply-update');
  const cancelBtn = document.getElementById('cancel-update');
  const restartBtn = document.getElementById('restart-streamer-btn');
  const restartBanner = document.getElementById('streamer-restart-banner');
  const branchSelect = document.getElementById('update-branch');
  const refreshBtn = document.getElementById('refresh-branches');

  let cachedBranches = null;
  let currentBranch = 'main';

  function populateBranchDropdown(branches, current) {
    branchSelect.innerHTML = '';
    for (const b of branches) {
      const opt = document.createElement('option');
      opt.value = b;
      opt.textContent = b;
      if (b === current) opt.selected = true;
      branchSelect.appendChild(opt);
    }
  }

  // Initial populate: always get live branch from /api/info, use cached branch list if available
  function initBranches() {
    fetch('/api/info').then(r => r.json()).then(info => {
      currentBranch = info.branch || 'main';
      const stored = localStorage.getItem('cachedBranches');
      if (stored) {
        try {
          const data = JSON.parse(stored);
          cachedBranches = data.branches;
          // Update cache with live branch
          data.currentBranch = currentBranch;
          localStorage.setItem('cachedBranches', JSON.stringify(data));
          populateBranchDropdown(cachedBranches, currentBranch);
          return;
        } catch {}
      }
      const defaultList = ['main'];
      if (currentBranch !== 'main') defaultList.push(currentBranch);
      populateBranchDropdown(defaultList, currentBranch);
    }).catch(() => {
      populateBranchDropdown(['main'], 'main');
    });
  }

  async function refreshBranches() {
    refreshBtn.disabled = true;
    refreshBtn.textContent = '…';
    try {
      const data = await api('/api/branches');
      cachedBranches = data.branches;
      currentBranch = data.currentBranch || 'main';
      localStorage.setItem('cachedBranches', JSON.stringify({ branches: cachedBranches, currentBranch }));
      populateBranchDropdown(cachedBranches, currentBranch);
      showStatus(status, `${cachedBranches.length} branches loaded.`, true);
    } catch (e) {
      showStatus(status, 'Failed to refresh branches: ' + e.message, false);
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.textContent = '↻';
    }
  }

  initBranches();
  refreshBtn.addEventListener('click', refreshBranches);

  function getBranch() {
    return branchSelect.value || 'main';
  }

  function resetUI() {
    actions.style.display = 'none';
    btn.disabled = false;
    btn.textContent = 'Check for Updates';
  }

  function showRestartBtn() {
    if (restartBtn) restartBtn.style.display = '';
  }
  function hideRestartBtn() {
    if (restartBtn) restartBtn.style.display = 'none';
  }
  function showRestartPending() {
    if (restartBanner) restartBanner.style.display = '';
    hideRestartBtn();
  }

  // Check on load if a restart is already pending
  fetch('/api/streamer/restart-pending').then(r => r.json()).then(d => {
    if (d.pending) showRestartPending();
  }).catch(() => {});

  // Step 1: Check for updates (fetch only, no apply)
  btn.addEventListener('click', async () => {
    const branch = getBranch();
    btn.disabled = true;
    btn.textContent = `Checking (${branch})...`;
    output.style.display = 'none';
    actions.style.display = 'none';
    status.textContent = '';
    try {
      const res = await fetch('/api/update/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch })
      });
      const data = await res.json();
      if (!res.ok) {
        showStatus(status, data.error || 'Check failed', false);
        output.textContent = data.output || '';
        output.style.display = data.output ? '' : 'none';
        resetUI();
        return;
      }
      if (data.upToDate) {
        showStatus(status, `Already up to date on ${branch} (${data.localHead.slice(0, 7)}).`, true);
        output.style.display = 'none';
        resetUI();
        return;
      }
      // Show available changes
      let text = `Branch: ${branch}\n`;
      text += `Current: ${data.localHead} → Latest: ${data.remoteHead}\n\n`;
      text += `Commits:\n${data.commits}\n\n`;
      text += `Files changed:\n${data.diffStat}`;
      output.textContent = text;
      output.style.display = '';
      actions.style.display = '';
      btn.disabled = true;
      btn.textContent = 'Check for Updates';
    } catch (e) {
      showStatus(status, e.message, false);
      resetUI();
    }
  });

  // Step 2a: Apply update
  applyBtn.addEventListener('click', async () => {
    const branch = getBranch();
    applyBtn.disabled = true;
    cancelBtn.disabled = true;
    applyBtn.textContent = `Applying (${branch})...`;
    try {
      const res = await fetch('/api/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch })
      });
      let data;
      try { data = await res.json(); } catch {
        showStatus(status, 'Update applied — server restarted.', true);
        output.textContent = 'The server restarted to apply the update. This page will reload shortly.';
        setTimeout(() => location.reload(), 3000);
        return;
      }
      output.textContent = data.output || data.error || 'No output';
      if (!res.ok) {
        showStatus(status, data.error || 'Update failed', false);
      } else {
        showStatus(status, 'Update complete. Reloading...', true);
        if (data.streamerPending) showRestartBtn();
        setTimeout(() => location.reload(true), 6000);
      }
    } catch (e) {
      showStatus(status, 'Update applied — server restarted.', true);
      output.textContent = 'Connection lost during update (server restarted). This page will reload shortly.';
      setTimeout(() => location.reload(), 3000);
      return;
    } finally {
      actions.style.display = 'none';
      applyBtn.disabled = false;
      cancelBtn.disabled = false;
      applyBtn.textContent = 'Apply Update';
      resetUI();
    }
  });

  // Step 2b: Cancel
  cancelBtn.addEventListener('click', () => {
    output.style.display = 'none';
    actions.style.display = 'none';
    status.textContent = '';
    resetUI();
  });

  // Restart streamer after current video
  if (restartBtn) {
    restartBtn.addEventListener('click', async () => {
      restartBtn.disabled = true;
      restartBtn.textContent = 'Scheduling...';
      try {
        const res = await fetch('/api/streamer/restart-after-current', { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
          showRestartPending();
          showStatus(status, 'Streamer will restart after the current video finishes.', true);
        } else {
          restartBtn.disabled = false;
          restartBtn.textContent = 'Restart Streamer After Current Video';
          showStatus(status, data.error || 'Failed to schedule restart', false);
        }
      } catch (e) {
        restartBtn.disabled = false;
        restartBtn.textContent = 'Restart Streamer After Current Video';
        showStatus(status, e.message, false);
      }
    });
  }
})();

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
