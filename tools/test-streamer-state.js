#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  buildPlaybackPosition,
  buildRuntimePlaylist,
  moveVideoNext,
  wrapOverlayText,
  playbackHealth,
  writeEvent,
  validateYouTubeConfig,
  youtubeFingerprint,
  validateOutputSelection
} = require('../web/backend/server');

const runtimePlaylist = ['alpha.mp4', 'beta.mp4', 'gamma.mp4'];

assert.deepStrictEqual(
  buildPlaybackPosition(
    true,
    runtimePlaylist,
    { index: 99, file: '/old/order/stale.mp4' },
    { file: '/mnt/blobfuse2/beta.mp4' }
  ),
  { nowPlaying: 'beta.mp4', upNext: ['gamma.mp4', 'alpha.mp4'] },
  'active playback must trust NOW_FILE instead of a stale bookmark'
);

assert.deepStrictEqual(
  buildPlaybackPosition(
    true,
    runtimePlaylist,
    { index: 0, file: '/mnt/blobfuse2/alpha.mp4' },
    { file: '/mnt/blobfuse2/gamma.mp4' }
  ),
  { nowPlaying: 'gamma.mp4', upNext: ['alpha.mp4', 'beta.mp4'] },
  'up-next must wrap using the running streamer playlist'
);

assert.deepStrictEqual(
  buildPlaybackPosition(
    false,
    ['new.mp4', 'beta.mp4', 'gamma.mp4'],
    { index: 0, file: '/mnt/blobfuse2/beta.mp4' },
    null
  ),
  { nowPlaying: null, upNext: ['gamma.mp4', 'new.mp4', 'beta.mp4'] },
  'stopped playback must relocate a bookmark by filename when its index is stale'
);

assert.deepStrictEqual(
  buildRuntimePlaylist(
    ['alpha.mp4', 'beta.mp4', 'gamma.mp4', 'delta.mp4'],
    'gamma.mp4'
  ),
  ['gamma.mp4', 'delta.mp4', 'alpha.mp4', 'beta.mp4'],
  'a saved active playlist must rotate around the current video'
);

assert.deepStrictEqual(
  buildRuntimePlaylist(['alpha.mp4', 'beta.mp4'], 'current-disabled.mp4'),
  ['alpha.mp4', 'beta.mp4'],
  'a disabled current video must finish once without remaining in the future queue'
);

assert.deepStrictEqual(
  moveVideoNext(
    [
      { file: 'alpha.mp4', enabled: true },
      { file: 'beta.mp4', enabled: true },
      { file: 'gamma.mp4', enabled: false }
    ],
    'gamma.mp4',
    'alpha.mp4'
  ),
  [
    { file: 'alpha.mp4', enabled: true },
    { file: 'gamma.mp4', enabled: true },
    { file: 'beta.mp4', enabled: true }
  ],
  'Play Next must enable and move the selected video after the current video'
);

assert.deepStrictEqual(
  moveVideoNext(
    [
      { file: 'alpha.mp4', enabled: true },
      { file: 'current.mp4', enabled: false },
      { file: 'target.mp4', enabled: false }
    ],
    'target.mp4',
    'current.mp4'
  ),
  [
    { file: 'target.mp4', enabled: true },
    { file: 'alpha.mp4', enabled: true },
    { file: 'current.mp4', enabled: false }
  ],
  'Play Next must lead the saved queue when the current video is disabled'
);

assert.strictEqual(
  wrapOverlayText('Up Next: A title that needs to wrap cleanly', 22),
  'Up Next: A title that\nneeds to wrap cleanly',
  'overlay text must wrap near its midpoint using the streamer line limits'
);
const longPortraitTitle = 'January 4, 2025 - Repentance is the Beginning, Middle, and End to a Christian Way of Life';
const portraitLines = wrapOverlayText(longPortraitTitle, 40, 3).split('\n');
assert.strictEqual(portraitLines.length, 3);
assert.strictEqual(portraitLines.join(' '), longPortraitTitle);
assert(Math.max(...portraitLines.map(line => line.length)) < 40);
assert.strictEqual(wrapOverlayText('A concise sermon title', 40, 3), 'A concise sermon title');
assert.strictEqual(wrapOverlayText('February 16, 2025 - The Parable of the Prodigal Son', 40, 3).split('\n').length, 2);
assert.deepStrictEqual(wrapOverlayText('X'.repeat(90), 40, 3).split('\n'), Array(3).fill('X'.repeat(30)));

function loadBackend(dependencies) {
  const fs = require('fs');
  const vm = require('vm');
  let handler;
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/backend/server'), 'utf8'), {
    require(name) {
      if (name === 'http') return { createServer(callback) { handler = callback; return {}; } };
      if (name === './config.json') return { port: 8080, prefixFile: '/etc/yt/nameprefix' };
      return dependencies[name] || require(name);
    },
    module: { exports: {} },
    process,
    console,
    Buffer,
    setInterval: dependencies.setInterval || setInterval,
    clearInterval: dependencies.clearInterval || clearInterval
  });
  return handler;
}

async function invokeRoute(handler, method, url, body) {
  const req = new (require('events').EventEmitter)();
  Object.assign(req, { method, url });
  const response = {};
  const pending = handler(req, {
    writeHead(status) { response.status = status; },
    end(data) { response.body = JSON.parse(data); }
  });
  if (body !== undefined) {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  }
  await pending;
  return response;
}

async function testSkipRoute(active, writeFails) {
  const writes = [];
  const renames = [];
  const fakeFs = {
    readFileSync() { throw new Error('No installed configuration'); },
    writeFileSync(file, content) {
      if (writeFails) throw new Error('Permission denied');
      writes.push({ file, content });
    },
    renameSync(from, to) { renames.push({ from, to }); }
  };
  const dependencies = {
    fs: fakeFs,
    child_process: {
      execFile() { throw new Error('Skip must not kill unrelated processes'); },
      execFileSync() {
        if (!active) throw new Error('Inactive service');
      }
    }
  };
  const response = await invokeRoute(loadBackend(dependencies), 'POST', '/api/streamer/skip');
  assert.strictEqual(response.status, !active ? 409 : writeFails ? 500 : 200);
  if (active && !writeFails) {
    assert.deepStrictEqual(response.body, { ok: true });
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0].content, '');
    assert.deepStrictEqual(renames, [{
      from: writes[0].file,
      to: '/run/streamer-skip'
    }]);
  } else {
    assert.strictEqual(renames.length, 0);
    assert.strictEqual(typeof response.body.error, 'string');
  }
}

async function testUpdateResult(error, stdout) {
  const handler = loadBackend({
    fs: { readFileSync() { throw new Error('No installed configuration'); } },
    child_process: {
      execFile(command, args, options, callback) {
        assert.strictEqual(command, '/usr/local/bin/yt-update.sh');
        callback(error, stdout, error ? 'fatal: fetch failed' : '');
      }
    }
  });
  const response = await invokeRoute(handler, 'POST', '/api/update', { branch: 'main' });
  assert.strictEqual(response.status, error ? 500 : 200);
  assert.strictEqual(response.body.ok, error ? undefined : true);
  if (error) assert.strictEqual(response.body.error, 'Update failed');
}

async function testLocalPlaylistSave() {
  let generatorArgs;
  const handler = loadBackend({
    fs: {
      readFileSync(file) {
        if (file === '/etc/yt/mode') return 'local';
        if (file === '/etc/yt/local.conf') return 'VIDEO_DIR=/mnt/sermons';
        throw new Error('No installed configuration');
      },
      readdirSync(directory) {
        assert.strictEqual(directory, '/mnt/sermons');
        return ['sermon.mp4'];
      },
      writeFileSync() {}
    },
    child_process: {
      execFileSync(command, args) {
        if (command === '/usr/local/bin/generate-playlist.sh') {
          generatorArgs = Array.from(args);
          return '';
        }
        throw new Error('Streamer is stopped');
      }
    }
  });
  const response = await invokeRoute(handler, 'PUT', '/api/videos', {
    videos: [{ file: 'sermon.mp4', enabled: true }]
  });
  assert.strictEqual(response.status, 200);
  assert.deepStrictEqual(generatorArgs, ['/mnt/sermons', '/etc/yt/playlist.txt']);
}

async function testYouTubeScheduleRoutes() {
  const settings = {
    channelId: 'UC-test',
    rules: [{ title: 'Sermons & Speakers', profile: 'landscape', durationSeconds: 28800 }]
  };
  assert.deepStrictEqual(validateYouTubeConfig(settings), settings);
  assert.throws(() => validateYouTubeConfig({ ...settings, rules: [...settings.rules, { ...settings.rules[0], title: '  sermons   & speakers ' }] }), /Duplicate/);
  assert.throws(() => validateYouTubeConfig({ ...settings, rules: [{ ...settings.rules[0], durationSeconds: true }] }), /duration/);
  const schedule = { timezone: 'UTC', events: [{ name: 'Weekly' }], stream: { shuffle: true } };
  const files = new Map([
    ['/etc/yt/mode', 'local'],
    ['/etc/yt/schedule.json', JSON.stringify(schedule)],
    ['/etc/yt/secrets/youtube-oauth.json', 'private-fixture'],
    ['/etc/yt/secrets/youtube-stream-key', 'private-main-key'],
    ['/etc/yt/secrets/youtube-stream-key-portrait', 'private-portrait-key']
  ]);
  let serviceState = 'inactive';
  const handler = loadBackend({
    fs: {
      readFileSync(file) {
        if (!files.has(file)) throw new Error('Missing');
        return files.get(file);
      },
      writeFileSync(file, data) { files.set(file, data); },
      renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
      unlinkSync(file) { files.delete(file); },
      existsSync(file) { return files.has(file); }
    },
    child_process: {
      execFile() { throw new Error('Local saves must not invoke Azure'); },
      execFileSync() { return serviceState; }
    }
  });
  const result = await invokeRoute(handler, 'PUT', '/api/schedule', { scheduleSource: 'youtube', youtube: settings });
  assert.strictEqual(result.status, 200);
  const saved = JSON.parse(files.get('/etc/yt/schedule.json'));
  assert.deepStrictEqual(saved.events, schedule.events);
  assert.deepStrictEqual(saved.stream, schedule.stream);
  assert.strictEqual(saved.scheduleSource, 'youtube');
  serviceState = 'active';
  const switching = await invokeRoute(handler, 'PUT', '/api/schedule', { scheduleSource: 'weekly' });
  assert.strictEqual(switching.status, 409);
  serviceState = 'inactive';
  const invalid = await invokeRoute(handler, 'PUT', '/api/schedule', { youtube: { ...settings, rules: [] } });
  assert.strictEqual(invalid.status, 400);
  const now = Date.now() / 1000;
  files.set('/etc/yt/youtube-schedule.json', JSON.stringify({
    fingerprint: youtubeFingerprint(saved), channelId: 'UC-test', fetchedAt: now,
    keyFingerprint: require('crypto').createHash('sha256').update(JSON.stringify({ landscape: 'private-main-key', portrait: 'private-portrait-key' })).digest('hex'),
    events: [{ id: 'broadcast-one', title: '<show>', profile: 'landscape', start: now + 60, end: now + 28800, errors: [], status: 'ready' }]
  }));
  const preview = await invokeRoute(handler, 'GET', '/api/schedule/youtube');
  assert.strictEqual(preview.status, 200);
  assert.strictEqual(preview.body.fresh, true);
  assert.strictEqual(preview.body.events[0].eligible, true);
  assert.strictEqual(JSON.stringify(preview.body).includes('private-fixture'), false);
  assert.strictEqual(JSON.stringify(preview.body).includes('private-main-key'), false);
  files.set('/etc/yt/secrets/youtube-stream-key', 'changed-key');
  assert.strictEqual((await invokeRoute(handler, 'GET', '/api/schedule/youtube')).body.fresh, false,
    'changing ingestion credentials must invalidate eligibility immediately');
  files.set('/etc/yt/secrets/youtube-stream-key', 'private-main-key');
  const old = JSON.parse(files.get('/etc/yt/youtube-schedule.json'));
  old.fetchedAt = now - 601;
  files.set('/etc/yt/youtube-schedule.json', JSON.stringify(old));
  const stale = await invokeRoute(handler, 'GET', '/api/schedule/youtube');
  assert.strictEqual(stale.body.fresh, false);
  assert.strictEqual(stale.body.events[0].eligible, false);
  files.set('/run/streamer-youtube-owner.json', JSON.stringify({
    owner: { events: [{ id: 'broadcast-one', end: now + 3600 }] }
  }));
  const owned = await invokeRoute(handler, 'GET', '/api/schedule');
  assert.strictEqual(owned.body.nextStop, new Date((now + 3600) * 1000).toISOString(),
    'an owned deadline must remain visible during discovery outages');
  files.set('/etc/yt/mode', 'azure');
  const unavailable = await invokeRoute(handler, 'PUT', '/api/schedule', { scheduleSource: 'youtube', youtube: settings });
  assert.strictEqual(unavailable.status, 400);
}

function testProgressiveQueueDisplay() {
  const vm = require('vm');
  const source = require('fs').readFileSync(require.resolve('../web/frontend/app.js'), 'utf8');
  const start = source.indexOf('function renderLiveQueue(');
  const end = source.indexOf('async function submitQueueAction(', start);
  const node = () => ({
    children: [], dataset: {}, listeners: {},
    set innerHTML(value) { this.children = []; },
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); },
    setAttribute() {},
    addEventListener(event, callback) { this.listeners[event] = callback; }
  });
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, node());
    return elements.get(id);
  };
  const sortables = [];
  const actions = [];
  const context = {
    liveQueue: null, liveCurrentFile: null, liveQueueHold: false,
    pendingQueueAction: null, queueView: 'collapsed', queueDragging: false,
    renderedQueue: '', queueSortable: null,
    document: { getElementById: element, createElement: node, querySelectorAll: () => [] },
    Sortable: class {
      constructor(list, options) { sortables.push(options); }
      destroy() {}
    },
    showStatus() {},
    submitQueueAction(operation, values) { actions.push({ operation, files: Array.from(values.files) }); }
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const queue = {
    session: 'queue-display', revision: 1, ready: true,
    items: Array.from({ length: 12 }, (_, i) => ({ file: `sermon-${i}.mp4` }))
  };
  context.renderLiveQueue(queue);
  const list = element('live-queue-list');
  assert.strictEqual(list.hidden, true);
  assert.strictEqual(list.children.length, 0);
  element('queue-expand').listeners.click();
  assert.strictEqual(list.hidden, false);
  assert.strictEqual(list.children.length, 5);
  assert.strictEqual(element('queue-expand').textContent, 'Show all (12)');
  const sorting = sortables.at(-1);
  sorting.onStart();
  list.children.push(list.children.shift());
  sorting.onEnd();
  assert.deepStrictEqual(actions.at(-1).files, [
    ...queue.items.slice(1, 5).map(item => item.file), queue.items[0].file,
    ...queue.items.slice(5).map(item => item.file)
  ], 'reordering the first five must preserve the entire hidden queue');
  element('queue-expand').listeners.click();
  assert.strictEqual(list.children.length, 12);
  assert.strictEqual(element('queue-expand').hidden, true);
  element('queue-collapse').listeners.click();
  assert.strictEqual(list.hidden, true);
  assert.strictEqual(list.children.length, 0);
  context.renderLiveQueue({ ...queue, revision: 2, items: queue.items.slice(0, 3) });
  element('queue-expand').listeners.click();
  assert.strictEqual(list.children.length, 3);
  assert.strictEqual(element('queue-expand').hidden, true);
  context.renderLiveQueue({ ...queue, revision: 3, items: [] });
  assert.strictEqual(element('queue-expand').disabled, true);
}

async function testUnconfirmedUpdate(fetch) {
  const fs = require('fs');
  const vm = require('vm');
  const source = fs.readFileSync(require.resolve('../web/frontend/app.js'), 'utf8');
  const start = source.indexOf("  applyBtn.addEventListener('click',");
  const end = source.indexOf('  // Step 2b: Cancel', start);
  assert(start >= 0 && end > start);
  let handler;
  let message;
  let successful;
  vm.runInNewContext(source.slice(start, end), {
    applyBtn: { addEventListener(event, callback) { handler = callback; } },
    cancelBtn: {},
    actions: { style: {} },
    status: {},
    output: {},
    getBranch() { return 'main'; },
    fetch,
    showStatus(element, text, ok) { message = text; successful = ok; },
    resetUI() {}
  });
  await handler();
  assert.strictEqual(successful, false);
  assert.strictEqual(message, 'Update result could not be confirmed.');
}

function liveBackend(options = {}) {
  const state = {
    version: 1, session: 'session-one', revision: 3, ownerPid: 4242, ownerStart: '777',
    current: {
      file: '/mnt/blobfuse2/alpha.mp4', generation: 'generation-one', startedAt: 1, onAir: true,
      encoderPid: 4243, encoderStart: '888', telemetryPid: 4244, telemetryStart: '999'
    },
    upcoming: [{ file: '/mnt/blobfuse2/beta.mp4', ordinary: true }],
    explicitEmpty: false, actions: [], ...options.state
  };
  const stat = Array(20).fill('0');
  stat[0] = 'S';
  stat[19] = '777';
  const files = new Map([
    ['/run/streamer-control-state.json', JSON.stringify(state)],
    ['/proc/4242/stat', `4242 (bash) ${stat.join(' ')}`],
    ['/proc/4243/stat', `4243 (ffmpeg) ${stat.map((value, index) => index === 19 ? '888' : value).join(' ')}`],
    ['/proc/4244/stat', `4244 (python) ${stat.map((value, index) => index === 19 ? '999' : value).join(' ')}`],
    ['/etc/yt/playlist.txt', "file '/mnt/blobfuse2/alpha.mp4'\nfile '/mnt/blobfuse2/beta.mp4'\n"],
    ['/run/streamer-now.json', JSON.stringify({ file: state.current.file, startedAt: 1, duration: 100 })]
  ]);
  const calls = [];
  const handler = loadBackend({
    fs: {
      readFileSync(filename) {
        if (!files.has(filename)) throw new Error('Missing file');
        return files.get(filename);
      },
      existsSync(filename) { return files.has(filename); },
      readdirSync() { return ['alpha.mp4', 'beta.mp4', 'gamma.mp4']; },
      writeFileSync(filename, text) { files.set(filename, text); },
      renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
      unlinkSync(filename) { files.delete(filename); }
    },
    child_process: {
      execFileSync(command) {
        calls.push(command);
        if (command === 'systemctl' && options.active === false) throw new Error('Stopped');
        return '10';
      },
      execFile(command, args, opts, callback) {
        calls.push(command);
        if (options.onExecFile) options.onExecFile(command, args);
        callback(options.serviceError ? new Error('systemctl unavailable') : null, 'ActiveState=active\n');
      }
    },
    setInterval: options.setInterval,
    clearInterval: options.clearInterval
  });
  const command = { id: 'edit-one', operation: 'replace', files: ['beta.mp4'], session: state.session, revision: state.revision };
  return { state, files, calls, handler, command };
}

async function testManualOutputControls() {
  for (const invalid of [null, [], 1, {}, { streams: [] }, { streams: ['portrait', 'portrait'] },
    { streams: ['invalid'] }, { streams: 'portrait' }]) {
    assert.throws(() => validateOutputSelection(invalid));
  }
  assert.deepStrictEqual(validateOutputSelection({}, ['landscape', 'portrait']), ['landscape', 'portrait']);
  const serviceCalls = [];
  const fixture = liveBackend({ onExecFile(command, args) { serviceCalls.push([command, Array.from(args)]); } });
  fixture.files.set('/etc/yt/mode', 'local');
  fixture.files.set('/etc/yt/secrets/youtube-stream-key', 'fixture-landscape');
  fixture.files.set('/etc/yt/secrets/youtube-stream-key-portrait', 'fixture-portrait');
  fixture.files.set('/run/streamer-active-landscape', '');
  const change = await invokeRoute(fixture.handler, 'POST', '/api/streamer/outputs', { streams: ['portrait'] });
  assert.strictEqual(change.status, 200);
  assert(fixture.files.has('/run/streamer-active-portrait'));
  assert(!fixture.files.has('/run/streamer-active-landscape'));
  assert(fixture.files.has('/run/streamer-manual-override'));
  assert.deepStrictEqual(serviceCalls.at(-1), ['systemctl', ['restart', 'streamer.service']]);
  const before = JSON.stringify([...fixture.files]);
  const empty = await invokeRoute(fixture.handler, 'POST', '/api/streamer/outputs', { streams: [] });
  assert.strictEqual(empty.status, 400);
  assert.strictEqual(JSON.stringify([...fixture.files]), before, 'empty selection must not trigger fallback output');
  fixture.files.delete('/etc/yt/secrets/youtube-stream-key');
  const missing = await invokeRoute(fixture.handler, 'POST', '/api/streamer/outputs', { streams: ['landscape'] });
  assert.strictEqual(missing.status, 409);
  assert(fixture.files.has('/run/streamer-active-portrait'));
  fixture.files.set('/run/streamer-stop-after-current', '');
  const pending = await invokeRoute(fixture.handler, 'POST', '/api/streamer/outputs', { streams: ['portrait'] });
  assert.strictEqual(pending.status, 409);
  const stopped = liveBackend({ active: false });
  assert.strictEqual((await invokeRoute(stopped.handler, 'POST', '/api/streamer/outputs', { streams: ['portrait'] })).status, 409);
  fixture.files.delete('/run/streamer-stop-after-current');
  const start = await invokeRoute(fixture.handler, 'POST', '/api/streamer/start', { streams: ['portrait'] });
  assert.strictEqual(start.status, 200);
  assert.deepStrictEqual(serviceCalls.at(-1), ['systemctl', ['start', 'streamer.service']]);
  assert(!fixture.files.has('/run/streamer-active-landscape'));
}

async function testLiveCommands() {
  const fixture = liveBackend();
  const { handler, command, files } = fixture;
  const submit = changes => invokeRoute(handler, 'POST', '/api/streamer/queue', { ...command, ...changes });
  assert.strictEqual((await submit({ revision: 0 })).status, 409);
  assert.strictEqual((await submit({ files: ['beta.mp4', 'beta.mp4'] })).status, 400);
  assert.strictEqual((await submit({ files: ['../beta.mp4'] })).status, 400);
  assert.strictEqual((await submit({ files: ['alpha.mp4'] })).status, 409);
  assert.strictEqual((await invokeRoute(handler, 'POST', '/api/streamer/queue', null)).status, 400);
  const accepted = await submit({});
  assert.strictEqual(accepted.status, 202);
  assert.strictEqual(accepted.body.action.status, 'accepted');
  assert.strictEqual(JSON.parse(files.get('/run/streamer-control-request.json')).revision, 3);
  assert.strictEqual(files.has('/run/streamer-playlist.json'), false, 'backend must not write applied player state');
  assert.strictEqual(files.has('/etc/yt/playlist-config.json'), false, 'live edits must not persist');
  assert.strictEqual((await submit({ id: 'other-client' })).status, 409);
  assert.strictEqual((await submit({})).status, 202, 'retrying the same pending action is idempotent');
  const lookup = await invokeRoute(handler, 'GET', '/api/streamer/actions/edit-one');
  assert.strictEqual(lookup.body.action.status, 'accepted');
  files.delete('/run/streamer-control-request.json');
  fixture.state.actions = [{ id: command.id, status: 'applied', operation: 'now' }];
  files.set('/run/streamer-control-state.json', JSON.stringify(fixture.state));
  assert.strictEqual((await submit({ operation: 'now', file: 'alpha.mp4' })).status, 200,
    'an already-applied action must not interrupt twice');
  files.set('/proc/4242/stat', 'different process');
  assert.strictEqual((await submit({ id: 'new-command' })).status, 503);
  const stopped = liveBackend({ active: false });
  assert.strictEqual((await invokeRoute(stopped.handler, 'POST', '/api/streamer/queue', stopped.command)).status, 409);
}

async function testLiveSnapshotAndSavedOnly() {
  const fixture = liveBackend({ state: { upcoming: [], explicitEmpty: true } });
  const response = await invokeRoute(fixture.handler, 'GET', '/api/streamer');
  assert.deepStrictEqual(response.body.upNext, [], 'an intentional empty queue must not fall back to saved rotation');
  assert.strictEqual(response.body.queue.explicitEmpty, true);
  const saved = await invokeRoute(fixture.handler, 'PUT', '/api/videos', {
    videos: [{ file: 'beta.mp4', enabled: true }], applyToLive: false
  });
  assert.strictEqual(saved.status, 200);
  assert.strictEqual(fixture.files.has('/run/streamer-control-request.json'), false);
  const applied = await invokeRoute(fixture.handler, 'PUT', '/api/videos', {
    videos: [{ file: 'beta.mp4', enabled: true }]
  });
  assert.strictEqual(applied.status, 200);
  assert.strictEqual(applied.body.runtimeUpdated, false);
  assert.strictEqual(applied.body.runtimePending, true);
  assert.strictEqual(JSON.parse(fixture.files.get('/run/streamer-control-request.json')).operation, 'reset');
  const unavailable = liveBackend({ serviceError: true });
  const unknown = await invokeRoute(unavailable.handler, 'GET', '/api/streamer');
  assert.strictEqual(unknown.body.state, 'unknown');
  assert.strictEqual(unknown.body.playbackHealth.status, 'unknown',
    'failed operational sampling must not claim playback is stopped or healthy');
  const resumed = liveBackend();
  resumed.files.set('/run/streamer-now.json', JSON.stringify({
    file: resumed.state.current.file, startedAt: 1, duration: 100, offsetSeconds: 30
  }));
  resumed.files.set('/run/streamer-progress.json', JSON.stringify({
    generation: resumed.state.current.generation, elapsed: 15, at: Date.now() / 1000, speed: 1
  }));
  const progress = (await invokeRoute(resumed.handler, 'GET', '/api/streamer')).body.progress;
  assert.strictEqual(progress.elapsed, 45, 'measured time must include the resumed input position');
  assert.strictEqual(progress.duration, 100, 'duration stays relative to the complete source');
}

function testMeasuredHealth() {
  const current = { generation: 'new', startedAt: 100 };
  const history = {};
  const sample = (at, elapsed, speed = 1) => ({ generation: 'new', at, elapsed, speed });
  assert.strictEqual(playbackHealth(current, sample(105, 5), 105, history).status, 'starting');
  assert.strictEqual(playbackHealth(current, sample(121, 21), 121, history).status, 'healthy');
  assert.strictEqual(playbackHealth(current, sample(130, 21), 130, history).status, 'healthy');
  assert.strictEqual(playbackHealth(current, sample(137, 21), 137, history).status, 'stalled');
  assert.strictEqual(playbackHealth(current, sample(150, 40, 0.7), 150, history).status, 'healthy');
  assert.strictEqual(playbackHealth(current, sample(171, 51, 0.7), 171, history).status, 'slow');
  assert.strictEqual(playbackHealth(current, sample(172, 52), 172, history).status, 'healthy');
  assert.strictEqual(playbackHealth(current, sample(172, 52), 180, history).status, 'unknown');
  assert.strictEqual(playbackHealth(current, { ...sample(180, 1), generation: 'previous' }, 180, history).status, 'unknown');
  assert.strictEqual(playbackHealth({ generation: 'restarted', startedAt: 180 }, null, 181, history).status, 'starting');
}

function testStaleProgressAndCollectorFailure() {
  const current = { generation: 'new', startedAt: 100, onAir: true };
  const sample = { generation: 'new', at: 121, elapsed: 21, speed: 1 };
  const alive = { encoderAlive: true, telemetryAlive: true };
  assert.strictEqual(playbackHealth(current, sample, 122, {}, alive).status, 'healthy');
  assert.strictEqual(playbackHealth(current, sample, 129, {}, alive).status, 'unknown',
    'briefly stale progress must not immediately claim a stall');
  assert.strictEqual(playbackHealth(current, sample, 140, {}, alive).status, 'stalled',
    'a running encoder with a live collector and no fresh progress must report a stall');
  assert.strictEqual(playbackHealth(current, sample, 140, {}, { ...alive, telemetryAlive: false }).status, 'unknown');
  assert.strictEqual(playbackHealth(current, { ...sample, at: 140 }, 140, {},
    { ...alive, encoderAlive: false }).status, 'unknown', 'a dead encoder must not look healthy from its final sample');
  assert.notStrictEqual(playbackHealth(current, { ...sample, end: true }, 140, {}, alive).status, 'stalled',
    'finite completion is not a stall');
  assert.strictEqual(playbackHealth({ ...current, generation: 'next' }, sample, 140, {}, alive).status, 'unknown');
}

async function testProcessIdentityHealth() {
  const fixture = liveBackend();
  const progress = { generation: 'generation-one', at: Date.now() / 1000 - 25, elapsed: 21, speed: 1 };
  fixture.files.set('/run/streamer-progress.json', JSON.stringify(progress));
  const snapshot = () => invokeRoute(fixture.handler, 'GET', '/api/streamer');
  const stalled = await snapshot();
  assert.strictEqual(stalled.body.playbackHealth.status, 'stalled');
  assert(stalled.body.playbackHealth.age >= 25);
  const reader = fixture.files.get('/proc/4244/stat');
  fixture.files.set('/proc/4244/stat', reader.replace('(python) S', '(python) Z'));
  assert.strictEqual((await snapshot()).body.playbackHealth.status, 'unknown', 'zombie collectors are not live');
  fixture.files.set('/proc/4244/stat', reader.replace(/999$/, '1000'));
  assert.strictEqual((await snapshot()).body.playbackHealth.status, 'unknown', 'reused PIDs must not imply a live collector');
  fixture.files.set('/proc/4244/stat', reader);
  fixture.files.delete('/proc/4243/stat');
  fixture.files.set('/run/streamer-progress.json', JSON.stringify({ ...progress, at: Date.now() / 1000 }));
  assert.strictEqual((await snapshot()).body.playbackHealth.status, 'unknown', 'old samples cannot mask an exited encoder');
}

function testPlaybackHealthFeedback() {
  const source = require('fs').readFileSync(require.resolve('../web/frontend/app.js'), 'utf8');
  const start = source.indexOf('function renderStreamerStatus(data) {');
  const end = source.indexOf('function renderLiveQueue(', start);
  assert(start >= 0 && end > start);
  for (const health of [
    { status: 'stalled', speed: 1, age: 25.9, reason: 'no new encoder progress' },
    { status: 'unknown', reason: 'telemetry reader unavailable' }
  ]) {
    const elements = new Map();
    require('vm').runInNewContext(source.slice(start, end) + '\nrenderStreamerStatus(data);', {
      data: { active: true, nowPlaying: null, upNext: [], playbackHealth: health },
      document: {
        getElementById(id) {
          if (!elements.has(id)) elements.set(id, { style: {}, classList: { add() {}, remove() {} } });
          return elements.get(id);
        }
      },
      renderLiveQueue() {}, renderOutputControls() {}, stopProgressTicker() {}, fmtDuration() { return ''; }
    });
    const text = elements.get('playback-health').textContent;
    assert(text.includes(health.status) && text.includes(health.reason));
    if (health.age !== undefined) assert(text.includes('sample 25s old'));
    assert(!text.includes('NaN') && !text.includes('undefined'));
  }
}

async function testSharedEvents() {
  let tick;
  let intervalCount = 0;
  let cleared = 0;
  const fixture = liveBackend({
    setInterval(callback) { tick = callback; intervalCount++; return 1; },
    clearInterval() { cleared++; }
  });
  const connect = async () => {
    const req = new (require('events').EventEmitter)();
    Object.assign(req, { method: 'GET', url: '/api/streamer/events' });
    const writes = [];
    const res = {
      writableLength: 0, writeHead(status) { assert.strictEqual(status, 200); },
      flushHeaders() {}, write(text) { writes.push(text); return true; }, destroy() {}
    };
    await fixture.handler(req, res);
    return { req, writes };
  };
  const first = await connect();
  const second = await connect();
  tick();
  tick();
  assert.strictEqual(intervalCount, 1, 'multiple clients must share one observer');
  assert.strictEqual(fixture.calls.filter(command => command === 'systemctl').length, 1);
  assert.strictEqual(fixture.calls.includes('ffprobe'), false, 'events must not invoke ffprobe');
  assert(first.writes.some(text => text.startsWith('event: snapshot')));
  assert(second.writes.some(text => text.startsWith('event: snapshot')));
  first.req.emit('close');
  second.req.emit('close');
  assert.strictEqual(cleared, 1);
  let destroyed = false;
  writeEvent({ writableLength: 0, write() { return false; }, destroy() { destroyed = true; } }, 'event');
  assert.strictEqual(destroyed, true, 'slow clients must be disconnected rather than queued indefinitely');
}

(async () => {
  await testSkipRoute(true, false);
  await testSkipRoute(false, false);
  await testSkipRoute(true, true);
  await testUpdateResult(new Error('Updater exited 1'), 'Starting update...\n');
  await testUpdateResult(new Error('Updater exited 1'), '');
  await testUpdateResult(null, 'Update complete\n');
  await testLocalPlaylistSave();
  await testYouTubeScheduleRoutes();
  testProgressiveQueueDisplay();
  await testLiveCommands();
  await testManualOutputControls();
  await testLiveSnapshotAndSavedOnly();
  testMeasuredHealth();
  testStaleProgressAndCollectorFailure();
  await testProcessIdentityHealth();
  testPlaybackHealthFeedback();
  await testSharedEvents();
  await testUnconfirmedUpdate(async () => { throw new Error('Network unavailable'); });
  await testUnconfirmedUpdate(async () => ({
    async json() { throw new Error('Unreadable response'); }
  }));
  console.log('Streamer state tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});