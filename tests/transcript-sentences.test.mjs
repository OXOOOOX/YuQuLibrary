import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSentences, sentencePage } from '../packages/domain/src/transcript-sentences.ts';
import { validateTranscriptChunk } from '../packages/domain/src/transcripts.ts';
const part = (text, startMs, endMs, continuesPrevious) => ({ text, startMs, endMs,
  ...(continuesPrevious ? { continuesPrevious } : {}) });

test('a word crossing 120 seconds and a sentence longer than eight seconds stay intact', () => {
  const chunks = [
    { chunk_index: 3, segments: [part('每行都使用一个print。', 114000, 118000), part('要注意程', 119000, 120000)] },
    { chunk_index: 4, segments: [part('序是自上而下执行的，也就是说先执行第一个print，再向下依次执行，这样也可以保证打印出的诗句顺序不会乱。', 119960, 130000, true)] }
  ];
  const original = structuredClone(chunks), projected = projectSentences('job', chunks);
  assert.equal(projected.length, 2);
  assert.match(projected[1].text, /^要注意程序.*保证/u);
  assert.equal(projected[1].startMs, 119000);
  assert.equal(projected[1].endMs, 130000);
  assert.equal(projected[1].id, 'job:3:1');
  assert.deepEqual(chunks, original);
});

test('page boundaries own sentences once, while at locates a sentence that began on the preceding page', () => {
  const chunks = Array.from({ length: 11 }, (_, index) => ({ chunk_index: index, segments: [
    part(index === 4 ? '跨页程' : index === 5 ? '序完整。' : `句${index}。`, index * 30000, (index + 1) * 30000, index === 5)
  ] }));
  const first = sentencePage('j', chunks, -1), second = sentencePage('j', chunks, first.nextCursor);
  assert.equal(first.nextCursor, 4);
  assert.equal(first.segments.at(-1).text, '跨页程序完整。');
  assert.equal(second.segments[0].id, 'j:6:0');
  assert.equal(new Set([...first.segments, ...second.segments].map(s => s.id)).size, 9);
  const located = sentencePage('j', chunks, -1, 155000);
  assert.equal(located.pageCursor, 3);
  assert.equal(located.segments[0].id, 'j:4:0');
  const before = projectSentences('j', chunks.slice(0, 5)).at(-1);
  assert.equal(before.id, first.segments.at(-1).id);
  assert.equal(before.text, '跨页程');
});

test('silence, missing chunks, sentence ends and legacy fragments never implicitly merge', () => {
  for (const chunks of [
    [{ chunk_index: 0, segments: [part('结束。', 0, 30000)] }, { chunk_index: 1, segments: [part('下一句', 30000, 32000, true)] }],
    [{ chunk_index: 0, segments: [part('中断', 0, 30000)] }, { chunk_index: 2, segments: [part('下一句', 30000, 32000, true)] }],
    [{ chunk_index: 0, segments: [part('中断', 0, 30000)] }, { chunk_index: 1, segments: [] }, { chunk_index: 2, segments: [part('下一句', 30000, 32000, true)] }],
    [{ chunk_index: 0, segments: [part('中断', 0, 30000)] }, { chunk_index: 1, segments: [part('下一句', 30000, 32000)] }]
  ]) assert.equal(projectSentences('j', chunks).length, 2);
});

test('titles and dotted abbreviations use the same boundary rules as the recognizer', () => {
  for (const title of ['Dr.', 'U.S.', 'e.g.']) {
    const sentences = projectSentences('j', [
      { chunk_index: 0, segments: [part(title, 29000, 30000)] },
      { chunk_index: 1, segments: [part('Smith continues.', 30000, 32000, true)] }
    ]);
    assert.equal(sentences.length, 1);
    assert.equal(sentences[0].text, title + ' Smith continues.');
  }
});

test('only a versioned first fragment may carry a continuation marker', () => {
  const chunk = { index: 1, startMs: 30000, endMs: 60000, language: 'Chinese',
    model: { id: 'qwen', revision: 'sha256:' + 'a'.repeat(64), pipeline: 'yuqu-qwen3-episode-v3' },
    segments: [part('序继续。', 29900, 31000, true)] };
  assert.equal(validateTranscriptChunk(chunk, 90000).segments.length, 1);
  assert.throws(() => validateTranscriptChunk({ ...chunk, model: { ...chunk.model, pipeline: 'old' } }, 90000));
  assert.throws(() => validateTranscriptChunk({ ...chunk, segments: [part('a', 30000, 30001), part('b', 30002, 30003, true)] }, 90000));
});

test('source boundary spacing survives punctuation and decimals across cores', () => {
  for (const [left, right, joinWithSpace, expected] of [['Hello,', 'world.', true, 'Hello, world.'], ['3.', '14', false, '3.14']]) {
    const result = projectSentences('j', [{ chunk_index: 0, segments: [part(left, 29000, 30000)] },
      { chunk_index: 1, segments: [{ ...part(right, 30000, 32000, true), joinWithSpace }] }]);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, expected);
  }
});
