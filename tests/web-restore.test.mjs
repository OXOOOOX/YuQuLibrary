import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const repoRoot = path.resolve(import.meta.dirname, '..');
const hookPath = path.join(repoRoot, 'apps', 'web', 'app', 'use-playback-session.ts');
const hookSource = fs.readFileSync(hookPath, 'utf8');

function compileHook() {
  let source = hookSource;
  source = source.replace("import { useEffect, useRef, useState, type RefObject } from 'react';", `
const reactSlots = []; let reactIndex = 0; let reactMounted = false; const reactEffects = [];
const useState = initial => { const index = reactIndex++; if (!(index in reactSlots)) reactSlots[index] = typeof initial === 'function' ? initial() : initial; return [reactSlots[index], value => { reactSlots[index] = typeof value === 'function' ? value(reactSlots[index]) : value; }]; };
const useRef = initial => { const index = reactIndex++; if (!(index in reactSlots)) reactSlots[index] = { current: initial }; return reactSlots[index]; };
const useEffect = effect => { if (!reactMounted) reactEffects.push(effect); };
globalThis.__yuquReactHarness = { reset() { reactIndex = 0; }, mount() { reactMounted = true; return reactEffects.splice(0); } };
`);
  source = source.replace("import { PLAYBACK_FIXTURE } from '@yuqu/contracts';\nimport type { AccountSession, PlaybackReport, PlaybackResult, SyncedPlayback } from '@yuqu/contracts';", "const PLAYBACK_FIXTURE = { durationMs: 240000 };");
  source = source.replace("import { observedPlaybackState } from './playback-observation';", "const observedPlaybackState = audio => audio.ended ? 'ended' : audio.paused ? 'paused' : 'playing';");
  return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
}

const hookCode = compileHook();
let moduleNumber = 0;

class FakeAudio {
  constructor() {
    this.currentTime = 42; this.duration = 240; this.readyState = 3; this.playbackRate = 1.5; this.loop = true;
    this.paused = true; this.ended = false; this.error = null; this.seeking = false; this.src = '/audio/playback-check.wav'; this.listeners = new Map();
  }
  addEventListener(name, listener) { const list = this.listeners.get(name) ?? []; list.push(listener); this.listeners.set(name, list); }
  removeEventListener(name, listener) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter(value => value !== listener)); }
  emit(name) { for (const listener of this.listeners.get(name) ?? []) listener(); }
  load() { this.readyState = 3; this.ended = false; }
  async play() { this.paused = false; this.emit('playing'); }
  pause() { this.paused = true; this.emit('pause'); }
}

function snapshot(patch = {}) {
  return {
    revision: 1, sequence: 0, generation: 1, playbackSessionId: 'p-original', ownerSessionId: 'session-a',
    contentId: 'content-b', mediaVersionId: 'media-b', title: '原节目', positionMs: 42000,
    durationMs: 240000, speed: 1.5, looping: true, state: 'paused', updatedAt: new Date().toISOString(), ...patch
  };
}

function jsonResponse(value, ok = true, status = 200) {
  return { ok, status, async json() { return value; } };
}

function createHarness(mode) {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalBroadcastChannel = globalThis.BroadcastChannel;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const requests = [];
  const profile = { session: { id: 'session-a' }, email: 'web-restore@example.com' };
  let current = snapshot();
  let restoreCount = 0;
  let deferredRestore;
  let deferredResolve;
  const eventSources = [];
  const audio = new FakeAudio();

  const commitRestore = body => {
    current = snapshot({
      revision: current.revision + 1, generation: body.expectedGeneration + 1, playbackSessionId: 'p-restored',
      mediaVersionId: body.mediaVersionId, positionMs: body.positionMs, speed: body.speed,
      looping: body.looping, state: 'paused', ownerSessionId: profile.session.id
    });
    return current;
  };
  const emitPlayback = value => eventSources.at(-1)?.emit('playback', value);
  const restorePlan = async body => {
    restoreCount += 1;
    if (mode === 'before-commit' && restoreCount === 1) throw new TypeError('network failed before commit');
    if (mode === 'http-lost' && restoreCount === 1) { commitRestore(body); throw new TypeError('response lost'); }
    if (mode === 'sse-before-error' && restoreCount === 1) { const committed = commitRestore(body); emitPlayback(committed); throw new TypeError('response lost'); }
    if (mode === 'sse-after-error' && restoreCount === 1) { commitRestore(body); throw new TypeError('response lost'); }
    if (mode === 'terminal-404' && restoreCount === 1) return jsonResponse({ error: { message: 'media removed' } }, false, 404);
    if (mode === 'deferred' && restoreCount === 1) {
      deferredRestore = body;
      return new Promise(resolve => { deferredResolve = resolve; });
    }
    const committed = current.generation === body.expectedGeneration + 1 && current.mediaVersionId === body.mediaVersionId
      ? current : commitRestore(body);
    return jsonResponse({ accepted: true, snapshot: committed });
  };

  class FakeEventSource {
    constructor() { this.listeners = new Map(); this.closed = false; eventSources.push(this); setTimeout(() => this.onopen?.(), 0); }
    addEventListener(name, listener) { const list = this.listeners.get(name) ?? []; list.push(listener); this.listeners.set(name, list); }
    emit(name, value) { for (const listener of this.listeners.get(name) ?? []) listener({ event: name, data: JSON.stringify(value) }); }
    close() { this.closed = true; }
  }
  globalThis.EventSource = FakeEventSource;
  globalThis.BroadcastChannel = class { postMessage() {} close() {} };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_name, _options, work) => work() } } });
  globalThis.setInterval = () => 0;
  globalThis.clearInterval = () => {};
  globalThis.fetch = async (url, init = {}) => {
    const pathName = String(url); const body = init.body ? JSON.parse(init.body) : undefined;
    if (pathName === '/api/auth/me') return jsonResponse(profile);
    if (pathName === '/api/auth/logout') return jsonResponse({});
    if (pathName === '/api/playback') return jsonResponse({ snapshot: current });
    if (pathName === '/api/playback/takeover') {
      requests.push(body);
      if (body.intent === 'restore') return restorePlan(body);
      current = snapshot({ revision: current.revision + 1, generation: body.expectedGeneration + 1,
        playbackSessionId: 'p-citation', mediaVersionId: body.mediaVersionId, positionMs: body.positionMs,
        ownerSessionId: profile.session.id, speed: 1, looping: true });
      return jsonResponse({ accepted: true, snapshot: current });
    }
    throw new Error(`unexpected request ${pathName}`);
  };

  let api;
  let mounted = false;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(hookCode).toString('base64')}#web-restore-${moduleNumber++}`;
  const ready = import(moduleUrl).then(async ({ usePlaybackSession }) => {
    function render() {
      globalThis.__yuquReactHarness.reset();
      api = usePlaybackSession({ current: audio });
      if (!mounted) { mounted = true; for (const effect of globalThis.__yuquReactHarness.mount()) effect(); }
      return api;
    }
    const settle = async () => { for (let index = 0; index < 18; index += 1) await new Promise(resolve => setTimeout(resolve, 0)); render(); };
    render(); await settle();
    return {
      get api() { return api; }, audio, requests, current: () => current, eventSources,
      render, settle, emitPlayback,
      resolveDeferred() {
        const committed = commitRestore(deferredRestore);
        deferredResolve?.(jsonResponse({ accepted: true, snapshot: committed }));
      },
      restoreCount: () => restoreCount,
      async cleanup() {
        try { api?.clearReturnPoint?.(); } finally {
          globalThis.fetch = originalFetch; globalThis.EventSource = originalEventSource; globalThis.BroadcastChannel = originalBroadcastChannel;
          globalThis.setInterval = originalSetInterval; globalThis.clearInterval = originalClearInterval;
          if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator); else delete globalThis.navigator;
        }
      }
    };
  });
  return ready;
}

async function enterReplay(harness) {
  await harness.api.replayCitation('media-a', 0, 6000);
  await harness.settle();
  assert.ok(harness.api.returnPoint, 'citation replay should retain the original return point');
  return { generation: harness.api.returnPoint.generation, playbackSessionId: harness.api.returnPoint.playbackSessionId };
}

test('web follows the phone silently and an explicit sentence tap starts continuous playback at its timestamp', async () => {
  const harness = await createHarness();
  try {
    const phone = snapshot({ revision: 2, generation: 2, ownerSessionId: 'phone', playbackSessionId: 'on-phone', state: 'playing', positionMs: 15000 });
    harness.emitPlayback(phone); await harness.settle();
    assert.equal(harness.api.following, true);
    assert.equal(harness.audio.paused, true);
    assert.deepEqual(harness.requests, []);

    const accepted = await harness.api.playHere('media-a', 32000);
    await harness.settle();
    assert.equal(accepted, true);
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0].expectedGeneration, phone.generation);
    assert.equal(harness.requests[0].mediaVersionId, 'media-a');
    assert.equal(harness.requests[0].positionMs, 32000);
    assert.equal(harness.audio.currentTime, 32);
    assert.equal(harness.audio.paused, false);
    harness.audio.currentTime = 37;
    harness.api.mediaChanged();
    assert.equal(harness.audio.paused, false);
    assert.equal(harness.api.returnPoint, null);

    harness.emitPlayback({ ...phone, revision: 4, generation: 4 });
    await harness.settle();
    assert.equal(harness.audio.paused, true);
    assert.equal(harness.api.following, true);
    assert.equal(harness.requests.length, 1);
  } finally { await harness.cleanup(); }
});

test('the remote playback clock respects speed, loop boundaries and stale samples without taking over', async () => {
  const realNow = Date.now;
  const testTime = realNow();
  Date.now = () => testTime;
  let harness;
  try {
    harness = await createHarness();
    async function display(sample) {
      harness.emitPlayback(snapshot({ ownerSessionId: 'phone', playbackSessionId: 'phone-session', generation: 2,
        state: 'playing', speed: 2, looping: false, updatedAt: new Date(Date.now() - 2000).toISOString(), ...sample }));
      await harness.settle();
      return harness.api.view.position;
    }
    assert.equal(await display({ revision: 2, positionMs: 30000 }), 34);
    assert.equal(await display({ revision: 3, positionMs: 237000, looping: true }), 1);
    assert.equal(await display({ revision: 4, positionMs: 237000 }), 240);
    assert.equal(await display({ revision: 5, positionMs: 19000, state: 'paused' }), 19);
    assert.equal(await display({ revision: 6, positionMs: 30000, updatedAt: new Date(Date.now() - 12000).toISOString() }), 30);
    assert.equal(harness.api.stale, true);
    assert.equal(harness.audio.paused, true);
    assert.deepEqual(harness.requests, []);
  } finally { Date.now = realNow; await harness?.cleanup(); }
});

test('web restore retries the frozen request across unknown outcomes', async t => {
  for (const mode of ['before-commit', 'http-lost', 'sse-before-error', 'sse-after-error']) {
    await t.test(mode, async () => {
      const harness = await createHarness(mode);
      try {
        const point = await enterReplay(harness);
        await harness.api.restorePlayback(); await harness.settle();
        if (mode === 'sse-after-error') { harness.emitPlayback(harness.current()); await harness.settle(); }
        assert.ok(harness.api.returnPoint, 'unknown restore result keeps the return affordance');
        assert.equal(harness.audio.paused, true, 'failed restore never starts local playback');
        const first = harness.requests.filter(request => request.intent === 'restore')[0];
        await harness.api.restorePlayback(); await harness.settle();
        const restores = harness.requests.filter(request => request.intent === 'restore');
        assert.equal(restores.length, 2);
        assert.deepEqual(restores[0], restores[1], 'retry reuses the exact request identity and target');
        assert.equal(restores[1].expectedGeneration, point.generation);
        assert.equal(restores[1].expectedPlaybackSessionId, point.playbackSessionId);
        assert.equal(harness.current().generation, point.generation + 1);
        assert.equal(harness.api.returnPoint, null);
        assert.equal(harness.audio.currentTime, 42);
        assert.equal(first.mediaVersionId, 'media-b');
      } finally { await harness.cleanup(); }
    });
  }
});

test('web restore drops the retry when a peer or permanent refusal wins', async t => {
  await t.test('peer with the same account but another playback session', async () => {
    const harness = await createHarness('before-commit');
    try {
      await enterReplay(harness); await harness.api.restorePlayback(); await harness.settle();
      const peer = snapshot({ revision: harness.current().revision + 1, generation: harness.current().generation + 1,
        ownerSessionId: 'session-a', playbackSessionId: 'other-tab', mediaVersionId: 'media-peer', positionMs: 9000 });
      harness.emitPlayback(peer); await harness.settle();
      const count = harness.requests.length;
      assert.equal(harness.api.returnPoint, null);
      await harness.api.restorePlayback();
      assert.equal(harness.requests.length, count, 'invalidated return point cannot retry or reclaim the peer');
    } finally { await harness.cleanup(); }
  });
  await t.test('permanent 404', async () => {
    const harness = await createHarness('terminal-404');
    try {
      await enterReplay(harness); await harness.api.restorePlayback(); await harness.settle();
      assert.equal(harness.api.returnPoint, null);
      const count = harness.requests.length; await harness.api.restorePlayback();
      assert.equal(harness.requests.length, count);
    } finally { await harness.cleanup(); }
  });
});

test('web restore fences late results after logout and reset', async t => {
  await t.test('logout', async () => {
    const harness = await createHarness('deferred');
    try {
      await enterReplay(harness);
      const oldRestore = harness.api.restorePlayback(); await harness.settle();
      await harness.api.logout(); await harness.settle();
      harness.resolveDeferred(); await oldRestore; await harness.settle();
      assert.equal(harness.api.account, null);
      assert.equal(harness.api.returnPoint, null);
    } finally { await harness.cleanup(); }
  });
  await t.test('reset does not let the old finally clear a new return point', async () => {
    const harness = await createHarness('deferred');
    try {
      await enterReplay(harness);
      const oldRestore = harness.api.restorePlayback(); await harness.settle();
      const oldSource = harness.eventSources.at(-1);
      oldSource.emit('reset', snapshot()); await harness.settle();
      await enterReplay(harness);
      harness.resolveDeferred(); await oldRestore; await harness.settle();
      assert.ok(harness.api.returnPoint, 'new replay state survives the retired restore finally');
    } finally { await harness.cleanup(); }
  });
});
