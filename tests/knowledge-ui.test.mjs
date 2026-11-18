import test from 'node:test';
import assert from 'node:assert/strict';
import { citationIds } from '../apps/web/app/knowledge-ui.ts';

test('inline ranges are actionable only when every source belongs to the current answer', () => {
  assert.deepEqual(citationIds('[S1–S3]', ['S1', 'S2', 'S3']), ['S1', 'S2', 'S3']);
  assert.deepEqual(citationIds('[S1-S3]', ['S1', 'S3']), []);
  assert.deepEqual(citationIds('[S7]', ['S1', 'S2']), []);
  assert.deepEqual(citationIds('[S7]', ['S7']), ['S7']);
});

test('streaming or malformed references never create guessed source links', () => {
  for (const marker of ['[S1]', '[S1-S2]', '[S1-S', '[S0]', '[S2-S1]', '[S01]', '[S1]suffix', '[S9007199254740993]']) {
    assert.deepEqual(citationIds(marker, []), []);
  }
  assert.deepEqual(citationIds('[S1-S33]', Array.from({ length: 33 }, (_, i) => `S${i + 1}`)), []);
  assert.equal(citationIds('[S1-S32]', Array.from({ length: 32 }, (_, i) => `S${i + 1}`)).length, 32);
});
