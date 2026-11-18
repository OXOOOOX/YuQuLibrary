import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chatIntent } from '../packages/domain/src/chat-anchors.ts';

test('draft anchor preserves captured position and normalizes its explicit source', () => {
  const value = { anchor: { kind: 'position', positionMs: 12340, scope: 'near', capturedAt: '2026-11-18T08:00:00+08:00', positionSource: 'local' } };
  const intent = chatIntent(value);
  assert.equal(intent.anchor.positionMs, 12340);
  assert.equal(intent.anchor.capturedAt, '2026-11-18T00:00:00.000Z');
  assert.throws(() => chatIntent({ ...value, scope: 'all' }));
  assert.throws(() => chatIntent({ anchor: { ...value.anchor, positionMs: -1 } }));
  assert.throws(() => chatIntent({ anchor: { ...value.anchor, positionSource: 'estimated-video' } }));
});
test('followups cannot replace their frozen source, and legacy input remains explicit', () => {
  const parentTurnId = randomUUID();
  assert.deepEqual(chatIntent({ parentTurnId }), { parentTurnId, anchor: null, legacy: null });
  for (const extra of [{ positionMs: 999 }, { scope: 'all' }, { anchor: {} }]) assert.throws(() => chatIntent({ parentTurnId, ...extra }));
  assert.deepEqual(chatIntent({ positionMs: 100 }), { parentTurnId: null, anchor: null, legacy: { positionMs: 100, scope: 'near' } });
});
test('selected citations have a stable normalized identity and bounded valid references', () => {
  const anchor = { kind: 'citation-selection', sourceTurnId: randomUUID(), citationIds: ['S12', 'S2'] };
  assert.deepEqual(chatIntent({ anchor }).anchor.citationIds, ['S2', 'S12']);
  for (const citationIds of [[], ['S0'], ['S1', 'S1'], ['S1–S3'], Array.from({ length: 33 }, (_, i) => `S${i + 1}`)]) {
    assert.throws(() => chatIntent({ anchor: { ...anchor, citationIds } }));
  }
  assert.throws(() => chatIntent({ anchor: { kind: 'transcript-selection', transcriptJobId: randomUUID(), throughMs: 0, segmentIds: ['a'] } }));
});
