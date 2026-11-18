import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTranscriptChunk } from '../packages/domain/src/transcripts.ts';

const chunk = () => ({ index: 1, startMs: 30000, endMs: 60000, language: 'Chinese',
  model: { id: 'local-pipeline', revision: 'sha256:' + 'a'.repeat(64) },
  segments: [{ startMs: 29900, endMs: 32100, text: '跨段时间戳保留真实边界。' }] });
test('transcript validation permits real cross-boundary alignment and empty silence', () => {
  assert.equal(validateTranscriptChunk(chunk(), 90000).segments[0].startMs, 29900);
  assert.deepEqual(validateTranscriptChunk({ ...chunk(), segments: [] }, 90000).segments, []);
});
test('transcript validation rejects gaps, nonfinite/reversed timestamps, oversized output and unversioned models', () => {
  for (const change of [{ startMs: 30001 }, { endMs: 60001 }, { index: -1 }, { model: { id: 'x', revision: 'latest' } },
    { segments: [{ startMs: 24000, endMs: 32100, text: 'x' }] },
    { segments: [{ startMs: 30000, endMs: NaN, text: 'x' }] },
    { segments: [{ startMs: 32000, endMs: 31000, text: 'x' }] },
    { segments: [{ startMs: 30000, endMs: 31000, text: 'x'.repeat(2001) }] },
    { segments: Array.from({ length: 101 }, () => ({ startMs: 30000, endMs: 30000, text: 'x' })) }]) {
    assert.throws(() => validateTranscriptChunk({ ...chunk(), ...change }, 90000));
  }
});
