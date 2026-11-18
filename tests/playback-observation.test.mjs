import test from 'node:test';
import assert from 'node:assert/strict';
import { observedPlaybackState } from '../apps/web/app/playback-observation.ts';

test('a stale ended flag cannot complete a paused seek 35 seconds before the end', () => {
  assert.equal(observedPlaybackState({ ended: true, paused: true, currentTime: 3642.1, readyState: 4 }, 3677120), 'paused');
  assert.equal(observedPlaybackState({ ended: true, paused: false, currentTime: 3642.1, readyState: 2 }, 3677120), 'buffering');
});

test('actual completion retains ended even though the media element is also paused', () => {
  assert.equal(observedPlaybackState({ ended: true, paused: true, currentTime: 3677.119667, readyState: 4 }, 3677120), 'ended');
  assert.equal(observedPlaybackState({ ended: true, paused: true, currentTime: 9.75, readyState: 4 }, 10000), 'ended');
  assert.equal(observedPlaybackState({ ended: true, paused: true, currentTime: 9.749, readyState: 4 }, 10000), 'paused');
});

test('normal playing, buffering and a deliberate end-position pause remain distinct', () => {
  assert.equal(observedPlaybackState({ ended: false, paused: false, currentTime: 3, readyState: 4 }, 10000), 'playing');
  assert.equal(observedPlaybackState({ ended: false, paused: false, currentTime: 3, readyState: 2 }, 10000), 'buffering');
  assert.equal(observedPlaybackState({ ended: false, paused: true, currentTime: 10, readyState: 4 }, 10000), 'paused');
  for (const duration of [0, NaN, Infinity]) assert.equal(observedPlaybackState({ ended: true, paused: true, currentTime: 0, readyState: 4 }, duration), 'paused');
});
