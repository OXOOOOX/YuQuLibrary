import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { projectTranscriptSnapshot, searchTranscriptSegments } from '../packages/domain/src/knowledge.ts';
import { normalizeImportUrl, previewImportSource } from '../packages/domain/src/library.ts';

const pipeline = 'yuqu-qwen3-episode-v3';
const chunks = [
  { chunk_index: 0, start_ms: 0, end_ms: 30000, segments: [{ startMs: 29000, endMs: 29900, text: '关注程' }] },
  { chunk_index: 1, start_ms: 30000, end_ms: 60000, segments: [{ startMs: 30000, endMs: 31000, text: '序边界。', continuesPrevious: true }] }
];
test('snapshot projection freezes an incomplete sentence while a later snapshot can search the continuation', () => {
  const frozen = projectTranscriptSnapshot('job', pipeline, chunks.slice(0, 1), 30000);
  const complete = projectTranscriptSnapshot('job', pipeline, chunks, 60000);
  assert.equal(frozen[0].id, complete[0].id);
  assert.equal(frozen[0].text, '关注程');
  assert.equal(complete[0].text, '关注程序边界。');
  assert.equal(searchTranscriptSegments(complete, '程序')[0].id, 'job:0:0');
  assert.deepEqual(searchTranscriptSegments(frozen, '程序'), []);
  assert.equal(frozen[0].endMs, 29900);
});
test('watermarks must identify complete contiguous committed chunks, and legacy transcripts do not merge', () => {
  for (const [rows, watermark] of [[[], 30000], [chunks, 45000], [[chunks[1]], 60000], [[{ ...chunks[0], start_ms: 1 }], 30000]]) {
    assert.throws(() => projectTranscriptSnapshot('job', pipeline, rows, watermark), error => error.code === 'TRANSCRIPT_SNAPSHOT_INVALID');
  }
  assert.equal(projectTranscriptSnapshot('job', 'yuqu-qwen3-episode-v2', chunks, 60000).length, 2);
});
test('search keeps original UTF-16 offsets and treats queries literally', () => {
  const text = '鱼🐟 API api a.b [s1]';
  const segment = { id: 'x', text, startMs: 0, endMs: 1000 };
  const hits = searchTranscriptSegments([segment], 'Api');
  assert.deepEqual(hits[0].highlights.map(({ start, end }) => text.slice(start, end)), ['API', 'api']);
  assert.equal(searchTranscriptSegments([segment], 'a.b')[0].highlights.length, 1);
  assert.deepEqual(searchTranscriptSegments([segment], ''), []);
});
test('four-hour sentence projection and keyword matching stay within the two-second local processing budget', t => {
  const full = Array.from({ length: 480 }, (_, chunk_index) => ({ chunk_index, start_ms: chunk_index * 30000, end_ms: (chunk_index + 1) * 30000,
    segments: Array.from({ length: 60 }, (_, index) => ({ startMs: chunk_index * 30000 + index * 500, endMs: chunk_index * 30000 + index * 500 + 450,
      text: `这是第 ${chunk_index} 块第 ${index} 句，讨论中文全文搜索与引用如何保留原始文稿。` })) }));
  const durations = [];
  for (let iteration = 0; iteration < 20; iteration++) {
    const start = performance.now();
    const segments = projectTranscriptSnapshot('job', pipeline, full, 14400000);
    assert.equal(searchTranscriptSegments(segments, '全文搜索').length, 28800);
    durations.push(performance.now() - start);
  }
  durations.sort((a, b) => a - b);
  const p95 = durations[18];
  t.diagnostic(`4h, 480 chunks, 28800 sentences, projection+search P95 ${p95.toFixed(1)} ms (no database/network)`);
  assert.ok(p95 < 2000, `local projection/search P95 ${p95}ms exceeds budget`);
});
function response(body, type, url = 'https://audio.example/episode.mp3') {
  return Object.assign(Readable.from([body]), { sourceUrl: url, headers: { 'content-type': type } });
}
test('automatic audio preview closes the checked stream without consuming the full file', async () => {
  const incoming = response('not downloaded', 'audio/mpeg'); let read = false;
  incoming.on('data', () => { read = true; });
  const preview = await previewImportSource('https://audio.example/episode.mp3', new AbortController().signal, async (_url, signal) => {
    assert.equal(signal.aborted, false); return incoming;
  });
  assert.equal(preview.kind, 'audio');
  assert.equal(preview.episodes[0].url, 'https://audio.example/episode.mp3');
  assert.equal(incoming.destroyed, true);
  assert.equal(read, false);
});
test('automatic feed preview uses enclosure normalization and rejects malformed/oversized sources', async () => {
  const xml = '<rss><channel><title>中文播客</title><item><title>单集</title><enclosure url="https://audio.example/one.mp3"/></item></channel></rss>';
  const preview = await previewImportSource('https://feed.example/rss', new AbortController().signal, async () => response(xml, 'application/rss+xml', 'https://feed.example/rss'));
  assert.equal(preview.kind, 'rss'); assert.equal(preview.title, '中文播客'); assert.equal(preview.episodes.length, 1);
  await assert.rejects(previewImportSource('http://127.0.0.1/private', new AbortController().signal, async () => { throw new Error('must not connect'); }), error => error.code === 'IMPORT_SOURCE_INVALID');
  await assert.rejects(previewImportSource('https://feed.example/rss', new AbortController().signal, async () => response('x'.repeat(2 * 1024 * 1024 + 1), 'application/xml')), error => error.code === 'IMPORT_SOURCE_INVALID');
});
test('a complete BV identifier normalizes to the same public video URL without accepting arbitrary text', () => {
  assert.equal(normalizeImportUrl(' BV1xx411c7mD '), 'https://www.bilibili.com/video/BV1xx411c7mD');
  assert.throws(() => normalizeImportUrl('BVbad'), error => error.code === 'IMPORT_SOURCE_INVALID');
});

test('Bilibili share text accepts the copied title, escaped colon and surrounding quotes', () => {
  const shareTitle = '【EVA的精神分析：碇真嗣到底在逃避什么？【新世纪福音战士的精神分析（1）】-哔哩哔哩】';
  const shortUrl = 'https://b23.tv/BV1Jbxq6uEcP';
  const fullUrl = 'https://www.bilibili.com/video/BV1Jbxq6uEcP?p=2&from=share';
  assert.equal(normalizeImportUrl(`“${shareTitle} https\\://b23.tv/BV1Jbxq6uEcP"`), shortUrl);
  for (const separator of [' ', '\r\n', '']) {
    assert.equal(normalizeImportUrl(shareTitle + separator + shortUrl), shortUrl);
  }
  assert.equal(normalizeImportUrl(shareTitle + ' ' + fullUrl + '”'), fullUrl);
});

test('share text requires one Bilibili link and preserves ordinary source URLs', () => {
  const shortUrl = 'https://b23.tv/BV1Jbxq6uEcP';
  for (const input of ['【标题】', '【标题】 https://feed.example/rss', '【标题】 https://b23.tv.example/a',
    '【标题】 https://user@b23.tv/video', '【标题】 https://b23.tv:8443/video', '长'.repeat(2048) + ' ' + shortUrl]) {
    assert.throws(() => normalizeImportUrl(input), { code: 'IMPORT_SOURCE_INVALID' });
  }
  assert.throws(() => normalizeImportUrl(`【标题】 ${shortUrl} https://b23.tv/second`), /一次粘贴一个链接/);
  const feed = 'https://feed.example/rss?source=https://b23.tv/example';
  assert.equal(normalizeImportUrl(feed), feed);
});
