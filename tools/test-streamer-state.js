#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { buildPlaybackPosition } = require('../web/backend/server');

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

console.log('Streamer state tests passed.');