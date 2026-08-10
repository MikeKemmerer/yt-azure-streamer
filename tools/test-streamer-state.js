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

console.log('Streamer state tests passed.');