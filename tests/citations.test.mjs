import test from 'node:test';
import assert from 'node:assert/strict';
import { answerCitations } from '../packages/domain/src/citations.ts';

const segments = Array.from({length: 60}, (_, i) => ({id:`S${i+1}`,text:`冻结原文 ${i+1}`,startMs:i*1000,endMs:(i+1)*1000}));
const ids = value => answerCitations(value, segments).map(item => item.id);
test('single citations and inclusive ranges preserve first appearance and frozen evidence', () => {
  assert.deepEqual(ids('无引用'), []);
  for (const dash of ['-', '–', '—']) {
    assert.deepEqual(ids(`[S3] [S1 ${dash} S3] [S2${dash}4] [S4${dash}S4]`), ['S3','S1','S2','S4']);
  }
  assert.equal(answerCitations('正文[S2–S3]', segments)[0], segments[1]);
  assert.deepEqual(answerCitations('[S1-S3]', segments), segments.slice(0, 3));
});
test('invalid or unknown range members fail closed including holes between valid endpoints', () => {
  for (const value of ['[S0]','[S01]','[S2-S1]','[S1–S0]','[S1-S99999999999999999999]','[S99999]','[S1–S61]','[S9999]','[S1,S2]','[S1-nope]']) {
    assert.throws(() => ids(value), {code:'INVALID_INPUT'}, value);
  }
  assert.throws(() => answerCitations('[S1–S3]', [segments[0], segments[2]]), /未知/);
});
test('32 unique citations remain the bound after expansion and deduplication', () => {
  assert.equal(ids('[S1–S32][S1-S32]').length, 32);
  assert.throws(() => ids('[S1–S33]'), /过多/);
  assert.throws(() => ids('[S1–S32][S33]'), /过多/);
  assert.equal(ids('[S2][S15–S22][S31][S32][S1][S22][S24][S25][S11][S12][S13][S14][S15][S16][S29][S30][S33][S41][S42][S43][S44][S45][S48][S49][S50][S51][S52][S53]').length, 32);
});
