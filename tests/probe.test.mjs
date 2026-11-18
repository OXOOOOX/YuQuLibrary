import test from 'node:test';
import assert from 'node:assert/strict';
import { probeResponse } from '../apps/web/lib/probe.ts';
import { SseDecoder } from '../packages/domain/src/sse.ts';

test('probe replays missed events from a cursor, including UTF-8', async () => {
  const now = Math.floor(Date.now() / 1000);
  const response = probeResponse(new Request('http://localhost/api/dev/events', { headers: { 'Last-Event-ID': String(now - 4) } }));
  const reader = response.body.getReader();
  const decoder = new SseDecoder();
  const events = [];
  while (events.length < 4) events.push(...decoder.push((await reader.read()).value));
  await reader.cancel();
  assert.deepEqual(events.slice(0, 4).map(event => Number(event.id)), [now - 3, now - 2, now - 1, now]);
  assert.equal(JSON.parse(events[0].data).message, '鱼趣连接正常');
});

test('probe resets stale and future cursors instead of unbounded replay', async () => {
  for (const cursor of ['1', String(Math.floor(Date.now() / 1000) + 3600)]) {
    const response = probeResponse(new Request('http://localhost/', { headers: { 'Last-Event-ID': cursor } }));
    const reader = response.body.getReader();
    const decoder = new SseDecoder();
    const events = [];
    while (events.length < 2) events.push(...decoder.push((await reader.read()).value));
    await reader.cancel();
    assert.equal(events[0].event, 'reset');
    assert.equal(events[1].event, 'probe');
  }
});

test('probe rejects malformed cursor and closes an aborted request', async () => {
  assert.equal(probeResponse(new Request('http://localhost/', { headers: { 'Last-Event-ID': '-1' } })).status, 400);
  const controller = new AbortController();
  controller.abort();
  const response = probeResponse(new Request('http://localhost/', { signal: controller.signal }));
  assert.equal((await response.body.getReader().read()).done, true);
});
