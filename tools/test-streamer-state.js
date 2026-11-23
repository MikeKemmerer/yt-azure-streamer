#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  buildPlaybackPosition,
  buildRuntimePlaylist,
  moveVideoNext,
  wrapOverlayText
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

async function testSkipRoute(active, writeFails) {
  const fs = require('fs');
  const vm = require('vm');
  let handler;
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
    http: { createServer(callback) { handler = callback; return {}; } },
    path: require('path'),
    child_process: {
      execFile() { throw new Error('Skip must not kill unrelated processes'); },
      execFileSync() {
        if (!active) throw new Error('Inactive service');
      }
    },
    './config.json': { port: 8080, prefixFile: '/etc/yt/nameprefix' }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/backend/server'), 'utf8'), {
    require(name) { return dependencies[name]; },
    module: { exports: {} },
    process,
    console
  });
  const response = {};
  await handler({ method: 'POST', url: '/api/streamer/skip' }, {
    writeHead(status) { response.status = status; },
    end(body) { response.body = JSON.parse(body); }
  });
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

(async () => {
  await testSkipRoute(true, false);
  await testSkipRoute(false, false);
  await testSkipRoute(true, true);
  console.log('Streamer state tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});