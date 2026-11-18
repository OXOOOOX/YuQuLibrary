import test from 'node:test';
import assert from 'node:assert/strict';
import { chapterBatches, resolveChapters, mergeChapters } from '../packages/domain/src/chapter-segments.ts';

const source = [
  { id: 'real:0', startMs: 100, endMs: 1200, text: '开场。' },
  { id: 'real:1', startMs: 1100, endMs: 2000, text: '介绍背景。' },
  { id: 'real:2', startMs: 5000, endMs: 6000, text: '换一个话题。' }
];
const proposal = { continuesPrevious: false, chapters: [
  { title: '背景', startSegmentId: 'S1', endSegmentId: 'S2' },
  { title: '另一个话题', startSegmentId: 'S3', endSegmentId: 'S3' }
] };
test('chapter time and source identity come only from frozen source, including overlap and silence', () => {
  const result = resolveChapters(proposal, source, 'batch', false);
  assert.deepEqual(result.chapters.map(({ startMs, endMs, startSegmentId, endSegmentId }) => ({ startMs, endMs, startSegmentId, endSegmentId })), [
    { startMs: 100, endMs: 2000, startSegmentId: 'real:0', endSegmentId: 'real:1' },
    { startMs: 5000, endMs: 6000, startSegmentId: 'real:2', endSegmentId: 'real:2' }
  ]);
});
test('zero-duration ASR text remains readable without inventing playable time', () => {
  const frozen = [{ id: 'zero:0', startMs: 1000, endMs: 1000, text: '对齐为零时长的原文。' }];
  const batches = chapterBatches(frozen);
  assert.deepEqual(batches.flat(), frozen);
  const result = resolveChapters({ continuesPrevious: false, chapters: [{ title: '原文', startSegmentId: 'S1', endSegmentId: 'S1' }] }, batches[0], 'batch', false);
  assert.equal(result.chapters[0].startMs, 1000); assert.equal(result.chapters[0].endMs, 1000);
  assert.equal(result.chapters[0].startSegmentId, 'zero:0');
});
test('chapter result rejects invented times, IDs, gaps, overlaps, reverse ranges and incomplete coverage', () => {
  const cases = [
    { ...proposal, time: 1 }, { ...proposal, continuesPrevious: true },
    { ...proposal, chapters: [{ ...proposal.chapters[0], startMs: 100 }] },
    { ...proposal, chapters: [{ ...proposal.chapters[0], endSegmentId: 'S4' }] },
    { ...proposal, chapters: [{ ...proposal.chapters[0], startSegmentId: 'S2', endSegmentId: 'S3' }] },
    { ...proposal, chapters: [{ ...proposal.chapters[0], startSegmentId: 'S2', endSegmentId: 'S1' }] },
    { ...proposal, chapters: [proposal.chapters[0]] },
    { ...proposal, chapters: [proposal.chapters[0], { ...proposal.chapters[1], startSegmentId: 'S2' }] },
    { ...proposal, chapters: [{ ...proposal.chapters[0], title: 'a\nb' }, proposal.chapters[1]] },
    { ...proposal, chapters: [{ ...proposal.chapters[0], title: 'x'.repeat(81) }, proposal.chapters[1]] }
  ];
  for (const invalid of cases) assert.throws(() => resolveChapters(invalid, source, 'batch', false), error => error.code === 'INVALID_INPUT');
});
test('prompt batching bounds both counts and text without truncating or altering source', () => {
  const long = Array.from({ length: 601 }, (_, i) => ({ ...source[0], id: `source:${i}`, text: '原文。' }));
  const batches = chapterBatches(long);
  assert.deepEqual(batches.map(batch => batch.length), [600, 1]);
  assert.deepEqual(batches.flat(), long);
  assert.deepEqual(chapterBatches(Array.from({ length: 4 }, () => ({ ...source[0], text: '字'.repeat(8000) }))).map(batch => batch.length), [3, 1]);
  assert.throws(() => chapterBatches([{ ...source[0], text: '字'.repeat(8001) }]), error => error.code === 'CHAPTER_SOURCE_LIMIT');
  assert.throws(() => chapterBatches(Array.from({ length: 600 * 128 + 1 }, () => source[0])), error => error.code === 'CHAPTER_SOURCE_LIMIT');
});
test('a cross-batch continuation extends the prior chapter without mutating stored results', () => {
  const first = resolveChapters(proposal, source, 'first', false), before = structuredClone(first);
  const nextSource = [{ id: 'real:3', startMs: 4900, endMs: 7000, text: '继续第二个话题。' }];
  const second = resolveChapters({ continuesPrevious: true, chapters: [{ title: '第二个话题延续', startSegmentId: 'S1', endSegmentId: 'S1' }] }, nextSource, 'second', true);
  const merged = mergeChapters([first, second]);
  assert.equal(merged.length, 2); assert.equal(merged[1].id, 'first:1');
  assert.equal(merged[1].title, '另一个话题'); assert.equal(merged[1].startMs, 4900); assert.equal(merged[1].endMs, 7000); assert.equal(merged[1].endSegmentId, 'real:3');
  assert.deepEqual(first, before);
});
