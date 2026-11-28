/* ── Helpers ─────────────────────────────────────────────────────── */

function showStatus(el, msg, ok, persist) {
  el.textContent = msg;
  el.className = 'status ' + (ok === null ? 'waiting' : ok ? 'ok' : 'err');
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

function deploymentLabel({ version, branch, tag, checkoutModified } = {}) {
  if (!version) return 'Version unavailable';
  const ref = tag || (branch !== 'HEAD' ? branch : '');
  return `${ref ? `${ref} @ ` : ''}${version}${checkoutModified ? ' (locally modified)' : ''}`;
}

async function loadInfo() {
  const versionEl = document.getElementById('app-version');
  try {
    const data = await api('/api/info');
    const label = deploymentLabel(data);
    document.getElementById('deployment-version').textContent = label;
    document.getElementById('info').textContent = JSON.stringify(data, null, 2);
    versionEl.textContent = label;
    // Show VM controls only in Azure mode
    if (data.mode === 'azure') {
      document.getElementById('vm-controls').style.display = '';
    }
  } catch {
    versionEl.textContent = 'Version unavailable';
    document.getElementById('deployment-version').textContent = 'Version unavailable';
    document.getElementById('info').textContent = 'Deployment information could not be loaded.';
  }
}

/* ── Streamer Control ────────────────────────────────────────────── */

let progressState = { elapsed: 0, duration: 0, lastSync: 0 };
let progressInterval = null;
let lastVideoEndRefresh = 0;
let liveQueue = { ready: false, items: [], actions: [] };
let pendingQueueAction = null;
let queueSortable = null;
let queueView = 'collapsed';
let outputSelectionDirty = false;
let manualActionPending = false;
let outputSnapshot = { active: false, state: 'unknown', activeStreams: {} };
let queueDragging = false;
let renderedQueue = '';
let liveEventsConnected = false;
let lastPreviewRefresh = 0;
let lastPreviewKey = '';
let previewProfile = '';
let liveCurrentFile = '';
let liveQueueHold = false;
let lastStreamerSnapshot = null;
let playbackCheckedAt = null;
let playbackUnavailable = false;
let currentDiagnostics = null;

function playbackPresentation(player, diagnostics, unavailable) {
  if (unavailable || player?.state === 'unknown') return {
    tone: 'unknown', label: 'Current status unknown',
    note: player ? 'Playback controls are unavailable. Any displayed playback is last known.' : 'No playback status is available.'
  };
  if (!player) return { tone: 'unknown', label: 'Checking playback', note: 'Waiting for the streamer.' };
  const { playback, scheduling } = diagnostics?.components || {};
  const intent = playback && !playback.stale && playback.actual === player.state ? playback : null;
  if (['activating', 'deactivating', 'reloading'].includes(player.state)) {
    return { tone: 'warn', label: { activating: 'Streamer starting', deactivating: 'Streamer stopping', reloading: 'Streamer reloading' }[player.state], note: 'Waiting for the service to settle.' };
  }
  if (player.state === 'failed' || intent?.severity === 'error') {
    return { tone: 'error', label: player.active ? 'Unexpected playback' : 'Streamer not running', note: intent?.reason || 'The streamer service failed.' };
  }
  if (!player.active) {
    if (intent?.intentional_pause && scheduling?.church_blocked && !scheduling.stale &&
        diagnostics.next_action.action === 'wait_for_kiosk_failover') {
      return { tone: 'warn', label: 'Paused for church', note: 'Playback is intentionally stopped until kiosk failover.' };
    }
    return { tone: 'off', label: player.queueHold ? 'Stopped · queue hold' : 'Streamer stopped',
      note: intent?.reason || 'Start manually or wait for the next scheduled start.' };
  }
  const health = player.playbackHealth || {};
  const [tone, label, note] = {
    healthy: ['on', 'Encoder progressing', 'Measured encoding progress is advancing.'],
    stalled: ['error', 'Encoder stalled', 'Measured progress has stopped. Inspect the streamer logs.'],
    slow: ['warn', 'Encoder running slowly', 'Measured progress is below real time.'],
    starting: ['warn', 'Encoder starting', 'Waiting for measured progress.']
  }[health.status] || ['unknown', 'Encoder progress unknown', 'The service is active, but progress cannot be verified.'];
  return { tone, label, note: health.reason || note };
}

function renderPlaybackOverview() {
  const { tone, label, note } = playbackPresentation(lastStreamerSnapshot, currentDiagnostics, playbackUnavailable);
  const indicator = document.getElementById('streamer-indicator');
  indicator.className = `indicator ${tone}`;
  indicator.textContent = { on: '✓', off: '–', unknown: '?', warn: '!', error: '×' }[tone];
  const headline = document.getElementById('streamer-label');
  if (headline.textContent !== label) headline.textContent = label;
  document.getElementById('playback-note').textContent = note;
  document.getElementById('playback-freshness').textContent = playbackCheckedAt
    ? `${playbackUnavailable ? 'Last checked' : 'Checked'} ${fmtDate(playbackCheckedAt)}` : '';
  const uptime = document.getElementById('streamer-uptime');
  uptime.hidden = !lastStreamerSnapshot?.active || !Number.isFinite(lastStreamerSnapshot.uptimeSeconds);
  if (!uptime.hidden) uptime.textContent = `${playbackUnavailable ? 'Last known uptime' : 'Streamer uptime'} ${fmtDuration(lastStreamerSnapshot.uptimeSeconds)}`;
  document.getElementById('now-playing-label').textContent = playbackUnavailable ? 'Last known title' : 'Now playing';
}

function renderOutputPreview() {
  const data = lastStreamerSnapshot;
  const profiles = ['portrait', 'landscape'];
  const streams = data?.active ? (data.activeStreams || { landscape: true }) : {};
  const available = profiles.filter(profile => streams[profile]);
  if (!available.includes(previewProfile)) previewProfile = available[0] || '';
  const preview = document.getElementById('stream-preview');
  const caption = document.getElementById('preview-caption');
  const details = document.getElementById('preview-details');
  document.getElementById('active-streams').hidden = !previewProfile;
  preview.hidden = !previewProfile;
  preview.dataset.profile = previewProfile;
  for (const profile of profiles) {
    const button = document.getElementById(`stream-badge-${profile}`);
    button.hidden = !available.includes(profile);
    button.setAttribute('aria-pressed', String(previewProfile === profile));
    const image = document.getElementById(`preview-img-${profile}`);
    image.hidden = profile !== previewProfile || image.dataset.loaded !== 'true';
  }
  if (!previewProfile) {
    lastPreviewKey = '';
    caption.textContent = playbackUnavailable ? 'Preview status unavailable.' : 'No active output to preview.';
    return;
  }
  const image = document.getElementById(`preview-img-${previewProfile}`);
  const previewText = `${playbackUnavailable ? 'Last known preview' : 'Encoder preview'} · ${previewProfile === 'portrait' ? '9:16' : '16:9'}`;
  caption.textContent = image.hidden ? (playbackUnavailable ? 'Preview status unavailable.' : 'Waiting for a preview frame.') : previewText;
  if (playbackUnavailable || !details.open) return;
  const key = `${previewProfile}:${data.nowFile || data.nowPlaying || ''}`;
  const now = Date.now();
  if (key === lastPreviewKey && now - lastPreviewRefresh < 5000) return;
  if (key !== lastPreviewKey) {
    image.dataset.loaded = 'false';
    image.hidden = true;
  }
  lastPreviewKey = key;
  lastPreviewRefresh = now;
  image.onload = () => {
    image.dataset.loaded = 'true';
    image.hidden = image.id !== `preview-img-${previewProfile}`;
    if (!image.hidden && !playbackUnavailable) caption.textContent = previewText;
  };
  image.onerror = () => {
    image.dataset.loaded = 'false';
    image.hidden = true;
    if (image.id === `preview-img-${previewProfile}` && !playbackUnavailable) caption.textContent = 'Waiting for a preview frame.';
  };
  image.src = `${previewProfile === 'portrait' ? '/stream-preview-portrait.jpg' : '/stream-preview.jpg'}?${now}`;
}

for (const profile of ['landscape', 'portrait']) {
  document.getElementById(`stream-badge-${profile}`).addEventListener('click', () => {
    previewProfile = profile;
    renderOutputPreview();
  });
}
document.getElementById('preview-details').addEventListener('toggle', renderOutputPreview);

function startProgressTicker() {
  if (progressInterval) return;
  progressInterval = setInterval(() => {
    if (progressState.duration <= 0) return;
    const now = Date.now();
    const sinceSync = (now - progressState.lastSync) / 1000;
    const elapsed = progressState.elapsed + (progressState.measured
      ? progressState.advancing ? Math.min(sinceSync, 3) * (progressState.speed || 1) : 0
      : sinceSync);
    const clamped = Math.min(elapsed, progressState.duration);
    document.getElementById('progress-bar').value = clamped;
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
    renderStreamerStatus(await api('/api/streamer'));
  } catch {
    playbackUnavailable = true;
    stopProgressTicker();
    renderPlaybackOverview();
    renderOutputPreview();
    const unknown = { ...outputSnapshot, state: 'unknown' };
    renderPlaybackControls(unknown);
    renderOutputControls(unknown);
    renderLiveQueue({ ...liveQueue, ready: false });
  }
}

function renderStreamerStatus(data) {
    playbackUnavailable = data.state === 'unknown';
    if (!playbackUnavailable) {
      lastStreamerSnapshot = data;
      playbackCheckedAt = new Date();
    }
    renderPlaybackOverview();
    renderOutputPreview();
    if (playbackUnavailable) data = { ...lastStreamerSnapshot, state: 'unknown' };
    const queue = data.queue || { ready: false, items: [], actions: [] };
    renderLiveQueue(playbackUnavailable ? { ...queue, ready: false } : queue, data.nowFile, data.queueHold);
    renderPlaybackControls(data);
    renderOutputControls(data);
    if (playbackUnavailable) {
      stopProgressTicker();
      return;
    }
    const nowPlaying = document.getElementById('now-playing');
    const progressBar = document.getElementById('progress-bar');
    const progressTime = document.getElementById('progress-time');
    const hasTitle = data.active && !!data.nowPlaying;
    nowPlaying.hidden = !hasTitle;
    const hasProgress = hasTitle && data.progress?.duration > 0;
    progressBar.hidden = progressTime.hidden = !hasProgress;
    if (hasTitle) document.getElementById('now-playing-title').textContent = data.nowPlaying;
    if (hasProgress) {
      progressState = { ...data.progress, lastSync: Date.now() };
      progressBar.max = data.progress.duration;
      progressBar.value = data.progress.elapsed;
      document.getElementById('progress-elapsed').textContent = fmtDuration(data.progress.elapsed);
      document.getElementById('progress-duration').textContent = fmtDuration(data.progress.duration);
      startProgressTicker();
    } else stopProgressTicker();
    const upNext = document.getElementById('up-next');
    upNext.hidden = !data.upNext?.length;
    if (!upNext.hidden) {
      document.getElementById('up-next-label').textContent = data.active ? 'Up next · Live queue' : 'On resume';
      const list = document.getElementById('up-next-list');
      const signature = JSON.stringify(data.upNext);
      if (list.dataset.items !== signature) {
        list.replaceChildren(...data.upNext.map(item => {
          const li = document.createElement('li');
          const name = typeof item === 'string' ? item : item.name;
          const title = document.createElement('span');
          title.textContent = name;
          li.appendChild(title);
          if (typeof item === 'object' && item.duration) {
            const duration = document.createElement('span');
            duration.className = 'hint numbers';
            duration.textContent = fmtDuration(item.duration);
            li.appendChild(duration);
          }
          return li;
        }));
        list.dataset.items = signature;
      }
    }
}

function renderLiveQueue(queue, current = liveCurrentFile, hold = liveQueueHold) {
  liveQueue = queue;
  liveCurrentFile = current;
  liveQueueHold = hold;
  const status = document.getElementById('queue-action-status');
  if (pendingQueueAction) {
    const action = (queue.actions || []).find(item => item.id === pendingQueueAction.id);
    if (action && ['applied', 'rejected', 'unconfirmed'].includes(action.status)) {
      showStatus(status, action.status === 'applied'
        ? `${pendingQueueAction.label}: ${action.operation === 'now' || action.operation === 'skip' ? 'confirmed on air' : 'applied'}.`
        : action.error || 'Action is unconfirmed or rejected.', action.status === 'applied');
      pendingQueueAction = null;
    } else if (queue.session !== pendingQueueAction.session ||
        Date.now() - pendingQueueAction.at > 30000) {
      showStatus(status, 'Action is unconfirmed; reload actual playback before retrying.', false, true);
      pendingQueueAction = null;
    }
  }
  const disabled = !queue.ready || !!queue.pending || !!pendingQueueAction;
  document.getElementById('queue-clear').disabled = disabled;
  document.getElementById('queue-reset').disabled = disabled;
  document.querySelectorAll('[data-live-file]').forEach(button => {
    button.disabled = disabled || button.dataset.liveFile === current;
  });
  document.getElementById('queue-description').textContent = hold
    ? 'Queue was emptied. Start manually to restore the saved playlist.'
    : !queue.ready ? 'Live queue requires a running, updated streamer.'
    : queue.explicitEmpty ? 'Current sermon will finish, then streaming will stop until manual start.'
    : 'Temporary upcoming pass. Natural exhaustion refills from the saved playlist.';
  const items = queue.items || [];
  const visibleItems = queueView === 'all' ? items : queueView === 'next' ? items.slice(0, 5) : [];
  const expand = document.getElementById('queue-expand');
  expand.hidden = queueView === 'all' || (queueView === 'next' && items.length <= 5);
  expand.disabled = !items.length;
  expand.textContent = queueView === 'collapsed' ? 'Show next 5' : `Show all (${items.length})`;
  expand.setAttribute('aria-expanded', String(queueView !== 'collapsed'));
  document.getElementById('queue-collapse').hidden = queueView === 'collapsed';
  const signature = JSON.stringify([queue.session, queue.revision, queue.ready, disabled, queue.items, queueView]);
  if (queueDragging || renderedQueue === signature) return;
  renderedQueue = signature;
  const list = document.getElementById('live-queue-list');
  const focusInList = list.contains?.(document.activeElement);
  list.hidden = queueView === 'collapsed';
  list.innerHTML = '';
  for (const [index, item] of visibleItems.entries()) {
    const li = document.createElement('li');
    li.dataset.file = item.file;
    const grip = document.createElement('span');
    grip.className = 'grip';
    grip.textContent = '⋮⋮';
    grip.setAttribute('aria-hidden', 'true');
    const title = document.createElement('span');
    title.className = 'queue-title';
    title.textContent = item.name || item.file;
    const remove = document.createElement('button');
    remove.className = 'secondary';
    remove.textContent = 'Remove';
    remove.disabled = disabled;
    remove.addEventListener('click', () => submitQueueAction('replace', {
      files: liveQueue.items.filter(queued => queued.file !== item.file).map(queued => queued.file)
    }, 'Queue removal'));
    const buttons = document.createElement('div');
    buttons.className = 'queue-row-actions';
    for (const direction of [-1, 1]) {
      const target = index + direction;
      buttons.appendChild(reorderButton(direction, title.textContent, disabled || target < 0 || target >= visibleItems.length, () => {
        const files = liveQueue.items.map(queued => queued.file);
        [files[index], files[target]] = [files[target], files[index]];
        submitQueueAction('replace', { files }, 'Queue reorder', queue);
      }));
    }
    buttons.appendChild(remove);
    li.append(grip, title, buttons);
    list.appendChild(li);
  }
  if (queueSortable) queueSortable.destroy();
  queueSortable = null;
  if (focusInList) list.closest('details')?.querySelector('summary')?.focus({ preventScroll: true });
  if (queueView === 'collapsed' || typeof Sortable !== 'function') return;
  let expected;
  let remaining;
  queueSortable = new Sortable(list, {
    handle: '.grip', animation: typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 150, disabled,
    onStart() {
      queueDragging = true;
      expected = { session: liveQueue.session, revision: liveQueue.revision };
      remaining = liveQueue.items.slice(visibleItems.length).map(item => item.file);
    },
    onEnd() {
      queueDragging = false;
      const files = [...list.children].map(item => item.dataset.file).concat(remaining);
      renderedQueue = '';
      submitQueueAction('replace', { files }, 'Queue reorder', expected);
    }
  });
}

function reorderButton(direction, title, disabled, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary reorder-button';
  button.textContent = direction < 0 ? '↑' : '↓';
  button.disabled = disabled;
  button.setAttribute('aria-label', `Move ${title} ${direction < 0 ? 'up' : 'down'}`);
  button.addEventListener('click', onClick);
  return button;
}

document.getElementById('queue-expand').addEventListener('click', () => {
  queueView = queueView === 'collapsed' ? 'next' : 'all';
  renderLiveQueue(liveQueue);
});
document.getElementById('queue-collapse').addEventListener('click', () => {
  queueView = 'collapsed';
  renderLiveQueue(liveQueue);
});

async function submitQueueAction(operation, values = {}, label = 'Queue change', expected = liveQueue) {
  const status = document.getElementById('queue-action-status');
  if (!liveQueue.ready || pendingQueueAction || liveQueue.pending) {
    showStatus(status, 'Live controls are unavailable or another action is pending.', false);
    return;
  }
  const id = `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  pendingQueueAction = { id, session: expected.session, at: Date.now(), label };
  renderLiveQueue(liveQueue);
  renderPlaybackControls(outputSnapshot);
  showStatus(status, `${label}: waiting for player acknowledgement…`, null, true);
  try {
    await api('/api/streamer/queue', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, operation, session: expected.session, revision: expected.revision, ...values })
    });
  } catch (error) {
    pendingQueueAction = null;
    showStatus(status, `${error.message} The requested change is not confirmed.`, false, true);
  }
  await refreshStreamerStatus();
}

document.getElementById('queue-clear').addEventListener('click', () => {
  if (confirm('Remove all upcoming sermons? The current sermon will finish, then streaming will stop until manual start.')) {
    submitQueueAction('replace', { files: [] }, 'Clear queue');
  }
});
document.getElementById('queue-reset').addEventListener('click', () => {
  submitQueueAction('reset', {}, 'Restore saved queue');
});

function connectPlaybackEvents() {
  if (typeof EventSource === 'undefined') return;
  const events = new EventSource('/api/streamer/events');
  events.onopen = () => {
    liveEventsConnected = true;
    document.getElementById('live-event-status').textContent = 'Live updates connected';
    refreshStreamerStatus();
  };
  events.addEventListener('snapshot', event => {
    try { renderStreamerStatus(JSON.parse(event.data)); } catch { refreshStreamerStatus(); }
  });
  events.onerror = () => {
    liveEventsConnected = false;
    document.getElementById('live-event-status').textContent = 'Live updates disconnected; polling';
  };
  window.addEventListener('pagehide', () => {
    liveEventsConnected = false;
    events.close();
  }, { once: true });
}
window.addEventListener('pageshow', event => {
  if (event.persisted) connectPlaybackEvents();
});

function selectedOutputs() {
  return ['landscape', 'portrait'].filter(profile => document.getElementById(`output-${profile}`).checked);
}

function renderPlaybackControls(data) {
  const known = data.state !== 'unknown';
  const stop = document.getElementById('streamer-stop');
  const stopAfter = document.getElementById('streamer-stop-after');
  const skip = document.getElementById('streamer-skip');
  const start = document.getElementById('streamer-start');
  start.hidden = data.active;
  stop.hidden = stopAfter.hidden = skip.hidden = !data.active;
  stop.disabled = stopAfter.disabled = !known || !data.active || manualActionPending;
  skip.disabled = stop.disabled || !!pendingQueueAction || !!data.queue?.pending;
  stopAfter.textContent = data.stopPending ? 'Cancel scheduled stop' : 'Stop after current';
}

function renderOutputControls(data) {
  outputSnapshot = data;
  const active = data.activeStreams || {};
  const known = data.state !== 'unknown';
  if (known && !outputSelectionDirty && !manualActionPending && (active.landscape || active.portrait)) {
    for (const profile of ['landscape', 'portrait']) {
      document.getElementById(`output-${profile}`).checked = !!active[profile];
    }
  }
  const selected = selectedOutputs();
  const changed = ['landscape', 'portrait'].some(profile => selected.includes(profile) !== !!active[profile]);
  for (const profile of ['landscape', 'portrait']) {
    document.getElementById(`output-${profile}`).disabled = manualActionPending || !known;
  }
  document.getElementById('streamer-apply-outputs').disabled =
    manualActionPending || !data.active || !known || !selected.length || !changed || data.stopPending;
  document.getElementById('streamer-start').disabled =
    manualActionPending || data.active || !known || !selected.length;
  const hint = document.getElementById('output-hint');
  const message = !known ? 'Wait for a current playback status.'
    : !selected.length ? 'Select at least one output.'
    : !data.active ? 'These outputs will be used when you start manually.'
    : !changed ? 'No output changes.'
    : data.stopPending ? 'Cancel the scheduled stop before applying changes.'
    : 'Unsaved selection. Applying it briefly reconnects YouTube and resets the live queue.';
  if (hint.textContent !== message) hint.textContent = message;
  hint.classList.toggle('err', known && !selected.length);
}

for (const profile of ['landscape', 'portrait']) {
  document.getElementById(`output-${profile}`).addEventListener('change', () => {
    outputSelectionDirty = true;
    renderOutputControls(outputSnapshot);
  });
}

function confirmPlayback(title, message, action, destructive = false) {
  const dialog = document.getElementById('playback-confirm');
  if (typeof dialog.showModal !== 'function') return Promise.resolve(confirm(`${title}\n\n${message}`));
  if (dialog.open) return Promise.resolve(false);
  const submit = document.getElementById('playback-confirm-submit');
  document.getElementById('playback-confirm-title').textContent = title;
  document.getElementById('playback-confirm-copy').textContent = message;
  submit.textContent = action;
  submit.classList.toggle('danger', destructive);
  dialog.returnValue = 'cancel';
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'accept'), { once: true });
    dialog.showModal();
  });
}

async function runPlaybackCommand(request, waiting, success) {
  if (manualActionPending || outputSnapshot.state === 'unknown') return;
  const status = document.getElementById('streamer-action-status');
  manualActionPending = true;
  showStatus(status, waiting, null, true);
  renderPlaybackControls(outputSnapshot);
  renderOutputControls(outputSnapshot);
  try {
    await request();
    showStatus(status, success, true);
  } catch (error) {
    showStatus(status, error.message, false, true);
  } finally {
    await refreshStreamerStatus();
    manualActionPending = false;
    renderPlaybackControls(outputSnapshot);
    renderOutputControls(outputSnapshot);
  }
}

document.getElementById('streamer-apply-outputs').addEventListener('click', async event => {
  const button = event.currentTarget;
  const streams = selectedOutputs();
  if (!await confirmPlayback('Restart with these outputs?',
    'YouTube will briefly reconnect and temporary queue edits will reset. Using both outputs increases CPU load.',
    'Apply outputs & restart', true) || button.disabled || selectedOutputs().join() !== streams.join()) return;
  await runPlaybackCommand(async () => {
    await api('/api/streamer/outputs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ streams })
    });
    outputSelectionDirty = false;
  }, 'Applying outputs and restarting…', 'Output restart requested. Check measured encoder progress before assuming playback has resumed.');
});

document.getElementById('streamer-start').addEventListener('click', async () => {
  const streams = selectedOutputs();
  await runPlaybackCommand(async () => {
    await api('/api/streamer/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ streams })
    });
    outputSelectionDirty = false;
  }, 'Starting streamer…', 'Start accepted. Check measured encoder progress.');
});

document.getElementById('streamer-stop').addEventListener('click', async event => {
  const button = event.currentTarget;
  if (!await confirmPlayback('Stop playback now?',
    'This interrupts the current video and may end the YouTube broadcast. To finish the video first, cancel and use Stop after current.',
    'Stop now', true) || button.disabled) return;
  await runPlaybackCommand(() => api('/api/streamer/stop', { method: 'POST' }),
    'Stopping playback…', 'Streamer stopped.');
});

document.getElementById('streamer-skip').addEventListener('click', async () => {
  if (liveQueue.ready) {
    await submitQueueAction('skip', {}, 'Skip');
    return;
  }
  await runPlaybackCommand(() => api('/api/streamer/skip', { method: 'POST' }),
    'Requesting next video…', 'Skip requested. Watch the playback title for the change.');
});

document.getElementById('streamer-stop-after').addEventListener('click', async () => {
  const cancel = outputSnapshot.stopPending;
  await runPlaybackCommand(() => api('/api/streamer/stop-after-current', { method: cancel ? 'DELETE' : 'POST' }),
    cancel ? 'Cancelling scheduled stop…' : 'Scheduling stop…',
    cancel ? 'Scheduled stop cancelled.' : 'Playback will stop after the current video.');
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
  const entries = videoData.map((video, index) => ({ video, index, title: cleanDisplayTitle(video.title || video.file) }))
    .filter(({ video, title }) => !query || title.toLowerCase().includes(query) || video.file.toLowerCase().includes(query));
  entries.forEach(({ video: v, index: i, title: displayTitle }, visibleIndex) => {
    const li = document.createElement('li');
    li.dataset.idx = i;
    li.className = v.enabled ? '' : 'disabled';

    const grip = document.createElement('span');
    grip.className = 'grip';
    grip.textContent = '⋮⋮';
    grip.setAttribute('aria-hidden', 'true');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = v.enabled;
    cb.setAttribute('aria-label', `Include ${displayTitle} in the saved playlist`);
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
    editBtn.textContent = 'Edit';
    editBtn.setAttribute('aria-label', `Edit title for ${displayTitle}`);

    // Hidden inline edit input
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.setAttribute('aria-label', 'Display title');
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
      const derived = cleanDisplayTitle(v.file);
      videoData[i].title = (newTitle === derived) ? '' : newTitle;
      titleSpan.textContent = cleanDisplayTitle(newTitle || derived);
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

    const playNextBtn = document.createElement('button');
    playNextBtn.className = 'video-play-next-btn secondary';
    playNextBtn.textContent = 'Queue next';
    playNextBtn.dataset.liveFile = v.file;
    playNextBtn.disabled = !liveQueue.ready || !!liveQueue.pending || !!pendingQueueAction || v.file === liveCurrentFile;
    playNextBtn.title = 'Move into the temporary upcoming queue without saving the playlist';
    playNextBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await submitQueueAction('next', { file: v.file }, 'Queue next');
    });
    const playNowBtn = document.createElement('button');
    playNowBtn.className = 'video-play-next-btn secondary';
    playNowBtn.textContent = 'Play now';
    playNowBtn.dataset.liveFile = v.file;
    playNowBtn.disabled = playNextBtn.disabled;
    playNowBtn.addEventListener('click', () => {
      const title = cleanDisplayTitle(v.title || v.file);
      if (confirm(`Play "${title}" now? This interrupts the current sermon, briefly reconnects the stream, and continues with the next queued sermon afterward.`)) {
        submitQueueAction('now', { file: v.file }, 'Play now');
      }
    });

    li.appendChild(grip);
    li.appendChild(cb);
    li.appendChild(nameBlock);
    const actions = document.createElement('div');
    actions.className = 'playlist-row-actions';
    for (const direction of [-1, 1]) {
      const target = entries[visibleIndex + direction]?.index;
      actions.appendChild(reorderButton(direction, displayTitle, target === undefined, () => {
        [videoData[i], videoData[target]] = [videoData[target], videoData[i]];
        renderVideoList(query);
        const buttons = [...list.querySelectorAll(`li[data-idx="${target}"] .reorder-button`)];
        (buttons[direction < 0 ? 0 : 1]?.disabled ? buttons.find(button => !button.disabled)
          : buttons[direction < 0 ? 0 : 1])?.focus({ preventScroll: true });
      }));
    }
    actions.append(playNextBtn, playNowBtn, num);
    li.appendChild(actions);

    list.appendChild(li);
  });

  // (Re-)initialize SortableJS for mouse + touch drag support
  if (sortableInstance) sortableInstance.destroy();
  if (typeof Sortable !== 'function') return;
  sortableInstance = new Sortable(list, {
    handle: '.grip',
    animation: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 150,
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

async function savePlaylist() {
  const body = { videos: videoData, applyToLive: false };
  const result = await api('/api/videos', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (Array.isArray(result.videos)) videoData = result.videos;
  renderVideoList(document.getElementById('playlist-search').value);
  await refreshStreamerStatus();
  return result;
}

document.getElementById('save-playlist').addEventListener('click', async () => {
  const status = document.getElementById('playlist-status');
  try {
    const result = await savePlaylist();
    showStatus(status, 'Saved playlist updated. The current live queue is unchanged; use Restore Saved Queue to apply it.', true);
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

function cleanDisplayTitle(text) {
  return text.trim().replace(/(?:\.(?:mp4|mkv|mov|avi|ts|flv))+$/i, '')
    .replace(/^\d{4}-\d{2}-\d{2}(?:\s*[-_]\s*|\s+)/, '').trim();
}

function needsTitleSuggestion(v) {
  // If the user has already set a custom title, no suggestion needed
  if (v.title && v.title.trim()) return false;
  const name = cleanDisplayTitle(v.file);
  if (name.includes('_')) return true;
  if (/version/i.test(name)) return true;
  if (/\.(mp4|mkv|mov|avi|ts|flv)/i.test(name)) return true;
  if (!/^[A-Za-z]+ \d{1,2},\s*\d{4}/.test(name)) return true;
  return false;
}

function suggestTitle(filename) {
  let t = cleanDisplayTitle(filename);
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
      input.setAttribute('aria-label', `Display title for ${c.file}`);
      input.value = c.title || suggestTitle(c.file);
      input.dataset.idx = c.idx;

      li.appendChild(nameEl);
      li.appendChild(input);
      list.appendChild(li);
    });
  }

  modal.showModal();
});

document.getElementById('title-modal-apply').addEventListener('click', () => {
  const inputs = document.querySelectorAll('#title-modal-list input');
  inputs.forEach(input => {
    const idx = +input.dataset.idx;
    videoData[idx].title = input.value.trim();
  });
  document.getElementById('title-modal').close();
  renderVideoList(document.getElementById('playlist-search').value);
});

document.getElementById('title-modal-close').addEventListener('click', () => {
  document.getElementById('title-modal').close();
});
document.getElementById('title-modal-cancel').addEventListener('click', () => {
  document.getElementById('title-modal').close();
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

/* ── Schedule ────────────────────────────────────────────────────── */

let scheduleData = { timezone: 'UTC', events: [] };
let activeScheduleSource = 'weekly';
let scheduleTimes = null;
let youtubeSchedulePreview = null;

function schedulePresentation(times, diagnostics, youtubePreview) {
  const source = times?.scheduleSource || diagnostics?.components.scheduling?.source;
  const scheduling = diagnostics?.components.scheduling;
  const action = scheduling && scheduling.source === source && !scheduling.stale ? diagnostics.next_action : null;
  const title = {
    church_pause: 'Pause for church',
    stop_at_deadline: 'Stop at broadcast cutoff',
    wait_for_kiosk_failover: 'Wait for kiosk failover',
    wait_for_safe_broadcast: 'Wait for a safe broadcast handoff',
    wait_for_operator_release: 'Wait for manual start',
    wait_for_scheduler_observation: 'Waiting for scheduler status',
    continue_weekly_schedule: 'Continue scheduled playback',
    wait_for_weekly_window: 'Wait for the next schedule window',
    await_studio_confirmation: 'Confirm the YouTube Studio settings',
    scheduled_start: 'Start scheduled broadcast',
    wait_for_eligible_broadcast: 'Wait for an eligible broadcast'
  }[action?.action];
  const matched = action?.action === 'scheduled_start' && youtubePreview?.fresh
    ? youtubePreview.events?.find(event => event.eligible && Date.parse(event.start) === Date.parse(action.at))
    : null;
  const previewEvent = !diagnostics && source === 'youtube' && youtubePreview?.enabled && youtubePreview.fresh
    ? youtubePreview.events?.filter(event => event.eligible && event.lifecycle === 'ready' && Date.parse(event.start) > Date.now())
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0]
    : null;
  const note = action?.action === 'wait_for_kiosk_failover' ? 'Waiting for the kiosk to switch from VLC to the browser. No resume time is known.'
    : action?.action === 'wait_for_operator_release' ? 'The scheduler will not restart playback while the manual stop or queue hold remains.'
    : matched?.title || previewEvent?.title || (source === 'youtube' && scheduling?.stale ? scheduling.reason : '');
  const weekly = source === 'weekly';
  const fallback = previewEvent ? 'Upcoming eligible broadcast'
    : weekly && times ? (times.nextStart ? 'Next weekly window' : 'No upcoming weekly start') : 'Scheduler status unavailable';
  return {
    source: source === 'youtube' ? 'YouTube broadcasts' : weekly ? 'Weekly schedule' : '',
    title: title || fallback,
    at: action?.at || previewEvent?.start || null,
    note,
    nextStart: weekly ? times?.nextStart : action?.action === 'scheduled_start' ? action.at : null,
    nextStop: weekly ? times?.nextStop : scheduling && !scheduling.stale ? scheduling.deadline_at : null
  };
}

function renderScheduleOverview() {
  const summary = schedulePresentation(scheduleTimes, currentDiagnostics, youtubeSchedulePreview);
  document.getElementById('schedule-source-label').textContent = summary.source;
  document.getElementById('schedule-next-action').textContent = summary.at ? `${summary.title} · ${fmtDate(summary.at)}` : summary.title;
  document.getElementById('schedule-next-detail').textContent = summary.note;
  document.getElementById('next-start').textContent = summary.nextStart ? fmtDate(summary.nextStart) : 'Not available';
  document.getElementById('next-stop').textContent = summary.nextStop ? fmtDate(summary.nextStop) : 'Not available';
  document.querySelector('.schedule-next').hidden = !summary.nextStart && !summary.nextStop;
}

async function refreshScheduleOverview() {
  if (scheduleTimes?.youtubeAvailable) await loadYouTubePreview();
  if (activeScheduleSource !== 'weekly') return;
  try {
    const data = await api('/api/schedule');
    if ((data.scheduleSource || 'weekly') === activeScheduleSource) {
      scheduleTimes = { ...data, scheduleSource: activeScheduleSource };
      renderScheduleOverview();
    }
  } catch {
    scheduleTimes = null;
    renderScheduleOverview();
  }
}

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
    activeScheduleSource = data.youtubeAvailable && data.scheduleSource === 'youtube' ? 'youtube' : 'weekly';
    scheduleTimes = { ...data, scheduleSource: activeScheduleSource };
    renderScheduleOverview();
    populateTimezoneDropdown('schedule-tz', data.timezone);
    populateTimezoneDropdown('override-tz', data.timezone);
    renderScheduleEvents();
    renderScheduleEditor();
    renderOverrides(data.overrides || []);
    youtubeSettings = data.youtube || { channelId: '', rules: [] };
    document.getElementById('schedule-source').value = activeScheduleSource;
    document.getElementById('youtube-channel').value = youtubeSettings.channelId;
    document.getElementById('youtube-provider').value = youtubeSettings.provider || 'api';
    document.getElementById('youtube-studio-confirmed').checked = youtubeSettings.manualStudioChecks === true;
    document.getElementById('youtube-public-checks').hidden = youtubeSettings.provider !== 'yt-dlp';
    document.getElementById('youtube-api-help').hidden = youtubeSettings.provider === 'yt-dlp';
    for (const id of ['schedule-source', 'youtube-channel', 'youtube-provider', 'youtube-studio-confirmed', 'add-youtube-rule', 'save-youtube-schedule']) {
      document.getElementById(id).disabled = !data.youtubeAvailable;
    }
    renderYouTubeRules();
    document.getElementById('youtube-schedule-settings').hidden = !data.youtubeAvailable;
    if (data.youtubeAvailable) loadYouTubePreview();
  } catch { renderScheduleOverview(); }
}

let youtubeSettings = { channelId: '', rules: [] };

function collectYouTubeRules() {
  youtubeSettings = {
    channelId: document.getElementById('youtube-channel').value.trim(),
    provider: document.getElementById('youtube-provider').value,
    manualStudioChecks: document.getElementById('youtube-studio-confirmed').checked,
    rules: Array.from(document.querySelectorAll('.youtube-rule')).map(row => ({
      title: row.querySelector('[data-title]').value,
      profile: row.querySelector('[data-profile]').value,
      durationSeconds: Math.round(Number(row.querySelector('[data-hours]').value) * 3600)
    }))
  };
}

function renderYouTubeRules() {
  const list = document.getElementById('youtube-rule-list');
  list.innerHTML = youtubeSettings.rules.map((rule, index) => `
    <div class="youtube-rule">
      <label>Exact title <input data-title maxlength="200" value="${esc(rule.title)}"></label>
      <label>Output <select data-profile>
        <option value="landscape" ${rule.profile === 'landscape' ? 'selected' : ''}>landscape</option>
        <option value="portrait" ${rule.profile === 'portrait' ? 'selected' : ''}>portrait</option>
      </select></label>
      <label>Fallback hours <input data-hours type="number" min="0.017" max="24" step="any" value="${esc(String((rule.durationSeconds || 28800) / 3600))}"></label>
      <button class="secondary" data-remove-rule="${index}">Remove</button>
    </div>`).join('');
  list.querySelectorAll('[data-remove-rule]').forEach(button => button.addEventListener('click', () => {
    collectYouTubeRules();
    youtubeSettings.rules.splice(Number(button.dataset.removeRule), 1);
    renderYouTubeRules();
  }));
}

async function loadYouTubePreview() {
  const status = document.getElementById('youtube-sync-status');
  try {
    const data = await api('/api/schedule/youtube');
    youtubeSchedulePreview = data;
    renderScheduleOverview();
    const age = data.ageSeconds === null ? 'no successful snapshot' : `${Math.round(data.ageSeconds / 60)} min old`;
    const connection = data.provider === 'yt-dlp' ? 'Public discovery; no Google sign-in required' :
      data.authorized ? 'Credentials configured' : 'Google authorization required';
    const runtime = Number.isFinite(data.sync?.durationSeconds) ? ` Last scan: ${data.sync.durationSeconds}s.` : '';
    status.textContent = !data.available ? 'Available in local mode only.' :
      `${connection}; ${data.fresh ? 'fresh discovery' : 'discovery unavailable or stale'} (${age}). ` +
      `${data.enabled ? 'Automatic scheduling enabled.' : 'Preview only; Weekly schedule remains selected.'}${runtime} ${data.sync?.error || ''}`;
    if (data.available && data.owned) {
      status.textContent += ` Owned session ${data.owned.stopping ? 'stopping' : `ends ${fmtDate(data.owned.end)}`}.`;
    }
    if (data.control?.enabled) {
      status.textContent += ` Rollover enabled; minimum disconnect ${data.control.minimumDisconnectSeconds}s, with verified old-event completion.`;
      if (data.control.churchBlocked) status.textContent += ' Church service: paused until VLC-to-browser failover.';
      else if (!data.control.calendarReady) status.textContent += ' Local calendar unavailable: new starts blocked.';
      if (data.control.waiting) status.textContent += ' Waiting before a replacement broadcast can start.';
    }
    const rows = data.events.map(event => {
      const feedback = event.errors.length ? event.errors.join('; ') :
        event.eligible ? 'Eligible' : `Not eligible for a new start (${event.lifecycle || 'unknown'})`;
      return `<tr><td><a href="https://www.youtube.com/watch?v=${encodeURIComponent(event.id)}" target="_blank" rel="noopener noreferrer">${esc(event.title)}</a></td>
        <td>${esc(event.profile)}</td><td>${esc(fmtDate(event.start))}</td><td>${esc(fmtDate(event.end))}</td>
        <td>${esc(event.lifecycle || 'unknown')}; ${esc(feedback)}</td></tr>`;
    }).join('');
    document.getElementById('youtube-events').innerHTML = rows ?
      `<table class="schedule-table"><tr><th>Broadcast</th><th>Output</th><th>Start</th><th>End</th><th>Status</th></tr>${rows}</table>` :
      `<p class="hint">${data.ageSeconds === null ? 'No successful discovery yet.' : 'No matching broadcasts in the last successful discovery.'}</p>`;
    if (data.activeBroadcasts?.length) {
      document.getElementById('youtube-events').innerHTML += '<p class="hint">Publicly active now: ' +
        data.activeBroadcasts.map(event => esc(event.title)).join('; ') + '. Existing live broadcasts are never taken over.</p>';
    }
  } catch (error) {
    youtubeSchedulePreview = null;
    renderScheduleOverview();
    status.textContent = error.message;
  }
}

document.getElementById('add-youtube-rule').addEventListener('click', () => {
  collectYouTubeRules();
  youtubeSettings.rules.push({ title: '', profile: 'landscape', durationSeconds: 28800 });
  renderYouTubeRules();
});
document.getElementById('refresh-youtube-preview').addEventListener('click', loadYouTubePreview);
document.getElementById('youtube-provider').addEventListener('change', () => {
  document.getElementById('youtube-public-checks').hidden =
    document.getElementById('youtube-provider').value !== 'yt-dlp';
  document.getElementById('youtube-api-help').hidden =
    document.getElementById('youtube-provider').value === 'yt-dlp';
});
document.getElementById('save-youtube-schedule').addEventListener('click', async () => {
  const button = document.getElementById('save-youtube-schedule');
  const status = document.getElementById('youtube-save-status');
  collectYouTubeRules();
  button.disabled = true;
  try {
    await api('/api/schedule', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scheduleSource: document.getElementById('schedule-source').value, youtube: youtubeSettings })
    });
    showStatus(status, 'Saved. Discovery runs in the background; preview refresh reads its cache. Manual stops and queue hold still take priority.', true);
    loadSchedule();
  } catch (error) { showStatus(status, error.message, false); }
  finally { button.disabled = false; }
});

function renderScheduleEvents() {
  const el = document.getElementById('schedule-events');
  if (activeScheduleSource === 'youtube') {
    el.innerHTML = '';
    return;
  }
  if (!scheduleData.events.length) {
    el.innerHTML = '<p class="hint">No weekly events configured.</p>';
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
  showStatus(status, 'Saving schedule\u2026', true, true);
  try {
    const result = await api('/api/schedule', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scheduleData)
    });
    if (result.syncError) {
      showStatus(status, `Schedule saved, but Azure sync failed: ${result.syncError}`, false);
    } else {
      showStatus(status, result.mode === 'local' ? 'Schedule saved.' : 'Schedule saved and synced to Azure.', true);
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

async function loadStorage() {
  await loadDiagnostics();
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

uploadArea.addEventListener('click', event => { if (event.target !== uploadInput) uploadInput.click(); });
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
        showStatus(status, 'Update result could not be confirmed.', false);
        output.textContent = 'The server returned no readable update result. Check for updates again to confirm the installed version.';
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
      showStatus(status, 'Update result could not be confirmed.', false);
      output.textContent = `Connection lost during update: ${e.message}. Check for updates again to confirm the installed version.`;
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

for (const id of ['playlist-card', 'logs-card']) {
  for (const link of document.querySelectorAll(`a[href="#${id}"]`)) {
    link.addEventListener('click', () => { document.querySelector(`#${id} > details`).open = true; });
  }
}

/* ── Init ────────────────────────────────────────────────────────── */

loadInfo();
loadSettings();
loadVideos();
refreshStreamerStatus();
loadSchedule();

connectPlaybackEvents();
setInterval(() => { if (!liveEventsConnected) refreshStreamerStatus(); }, 5000);
setInterval(refreshScheduleOverview, 60000);

function diagnosticValue(value) {
  if (value === null || value === undefined) return 'Unavailable';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))) return fmtDate(value);
  if (Array.isArray(value)) return value.length ? value.map(diagnosticValue).join('; ') : 'None';
  if (typeof value === 'object') return Object.entries(value).map(([key, item]) =>
    `${key.replace(/_/g, ' ')}: ${diagnosticValue(item)}`).join(', ');
  return String(value);
}

function diagnosticWorst(components) {
  const ranks = { ok: 0, warn: 1, unknown: 2, error: 3 };
  return components.reduce((worst, value) =>
    ranks[value.severity] > ranks[worst.severity] ? value : worst);
}

function diagnosticTable(fields) {
  return `<table class="diagnostics-table">${Object.entries(fields)
    .filter(([key]) => !['reason', 'severity'].includes(key))
    .map(([key, value]) => `<tr><th scope="row">${esc(key.replace(/_/g, ' '))}</th><td>${esc(diagnosticValue(value))}</td></tr>`)
    .join('')}</table>`;
}

function diagnosticSection(id, label, component, expanded, fields = component, content = '') {
  const severity = component.severity;
  return `<details class="health-detail" data-component="${esc(id)}" ${expanded.has(id) ? 'open' : ''}>
    <summary><span class="indicator ${severity === 'ok' ? 'on' : esc(severity)}" aria-hidden="true"></span>
      ${esc(label)} · ${esc(severity)}: ${esc(component.reason)}</summary>
    ${content}${diagnosticTable(fields)}</details>`;
}

function renderDiagnostics(data) {
  if (data.schema_version !== 1 || !data.components || !data.next_action) throw new Error('Unsupported diagnostics');
  const { playback, encoder, services, scheduling, resources, storage, auth } = data.components;
  const containers = ['health-grid', 'system-stats', 'storage-stats'].map(id => document.getElementById(id));
  const focused = document.activeElement?.closest?.('summary')?.parentElement?.dataset.component;
  const expanded = new Set(containers.flatMap(container =>
    Array.from(container.querySelectorAll('details[open]')).map(node => node.dataset.component)));
  document.getElementById('diagnostics-summary').textContent = data.severity === 'ok' ? '' : `Overall health · ${data.severity}: ${data.summary}`;
  document.getElementById('diagnostics-logs-link').hidden = ![encoder, playback].some(component => component.severity === 'error');
  const unitHealth = unit => {
    const sample = services.units?.[unit] || {};
    const state = sample.state || 'unknown';
    const severity = services.stale || !sample.state ? 'unknown' : state === 'active' ? 'ok' : state === 'failed' ? 'error' : 'unknown';
    return { severity, reason: services.stale ? 'Service observation stale or unavailable' : state,
      actual: state, restarts: sample.restarts ?? null, observed_at: services.observed_at,
      age_seconds: services.age_seconds, stale: services.stale };
  };
  const section = (id, label, component, fields, content) =>
    diagnosticSection(id, label, component, expanded, fields, content);
  const streamer = diagnosticWorst([playback, encoder]);
  const serviceUnits = ['caddy.service', 'web-backend.service',
    ...(scheduling.source === 'youtube' ? ['youtube-sync.timer'] : []),
    ...(data.mode === 'azure' ? ['schedule-sync.timer'] : [])];
  containers[0].innerHTML = section('streamer.service', 'Streamer', streamer,
    { restarts: services.units?.['streamer.service']?.restarts ?? null,
      service_observed_at: services.observed_at },
    section('playback', 'Playback intent', playback,
      Object.fromEntries(Object.entries(playback).filter(([key]) => !['current_title', 'outputs'].includes(key)))) +
    section('encoder', 'Encoder progress', encoder,
      Object.fromEntries(Object.entries(encoder).filter(([key]) => !['elapsed_seconds', 'duration_seconds'].includes(key))))) +
    section('scheduler.service', 'Scheduler', diagnosticWorst([scheduling, unitHealth('scheduler.service')]),
      unitHealth('scheduler.service'), section('scheduling', 'Broadcast and scheduling', scheduling,
        Object.fromEntries(Object.entries(scheduling).filter(([key]) => key !== 'observations')))) +
    serviceUnits.map(unit => section(unit, unit.replace(/\.(service|timer)$/, ''), unitHealth(unit))).join('');
  const gib = bytes => Number.isFinite(bytes) ? `${(bytes / 1073741824).toFixed(2)} GB` : null;
  containers[1].innerHTML = section('resources', 'Host resources', resources, {
    uptime: Number.isFinite(resources.uptime_seconds) ? fmtDuration(Math.floor(resources.uptime_seconds)) : null,
    'CPU load (1m)': Number.isFinite(resources.load_1m) ? `${resources.load_1m.toFixed(2)} / ${resources.cpu_cores} cores` : null,
    'Memory (used / total)': Number.isFinite(resources.memory_available_mb) && Number.isFinite(resources.memory_total_mb) ?
      `${resources.memory_total_mb - resources.memory_available_mb} / ${resources.memory_total_mb} MB` : null,
    'Root disk (used / total)': `${gib(resources.disk_used_bytes) || 'Unavailable'} / ${gib(resources.disk_total_bytes) || 'Unavailable'}`,
    'Root disk available': `${gib(resources.disk_available_bytes) || 'Unavailable'} (${diagnosticValue(resources.disk_available_percent)}%)`,
    temperature_c: resources.temperature_c, observed_at: resources.observed_at,
    age_seconds: resources.age_seconds, stale: resources.stale
  });
  const storageHealth = services.units?.['mnt-blobfuse2.mount'] ?
    diagnosticWorst([storage, unitHealth('mnt-blobfuse2.mount')]) : storage;
  containers[2].innerHTML = section('storage', 'Media storage', storageHealth, {
    recordings: storage.available_count, total_size: gib(storage.total_bytes),
    saved_enabled_count: storage.saved_enabled_count, selection_source: storage.selection_source,
    mount: storage.mount, read_bytes: storage.read_bytes, remote_roundtrip_verified: storage.remote_roundtrip_verified,
    upcoming_count: storage.upcoming_count, explicit_empty: storage.explicit_empty,
    ...(services.units?.['mnt-blobfuse2.mount'] ? { mount_service: unitHealth('mnt-blobfuse2.mount') } : {}),
    observed_at: storage.observed_at, age_seconds: storage.age_seconds, stale: storage.stale
  }) + (auth.mode === 'not_applicable' && auth.severity === 'ok' && !auth.stale ?
    '' : section('auth', 'Blob access expiry', auth));
  document.getElementById('diagnostics-freshness').textContent = `Snapshot: ${fmtDate(data.generated_at)}. ` +
    'Service, storage and system probes update about once a minute.';
  if (focused && document.activeElement === document.body) {
    const replacement = containers.flatMap(container => Array.from(container.querySelectorAll('details')))
      .find(node => node.dataset.component === focused);
    replacement?.querySelector('summary')?.focus({ preventScroll: true });
  }
}

async function loadDiagnostics() {
  try {
    const data = await api('/api/streamer/diagnostics');
    const age = Date.now() - Date.parse(data.generated_at);
    if (!Number.isFinite(age) || age < -5000 || age > 90000) throw new Error('Diagnostics snapshot is not current');
    renderDiagnostics(data);
    currentDiagnostics = data;
  } catch {
    currentDiagnostics = null;
    document.getElementById('diagnostics-summary').textContent = 'Diagnostics unavailable';
    document.getElementById('diagnostics-logs-link').hidden = true;
    document.getElementById('diagnostics-freshness').textContent = 'Any displayed checks are last known, not current health.';
    for (const id of ['health-grid', 'system-stats', 'storage-stats']) {
      const container = document.getElementById(id);
      for (const summary of container.querySelectorAll('summary')) {
        if (!summary.textContent.startsWith('Last known · ')) summary.prepend('Last known · ');
      }
      for (const dot of container.querySelectorAll('.indicator')) dot.className = 'indicator unknown';
    }
  }
  renderPlaybackOverview();
  renderScheduleOverview();
}

loadDiagnostics();
setInterval(loadDiagnostics, 10000);
