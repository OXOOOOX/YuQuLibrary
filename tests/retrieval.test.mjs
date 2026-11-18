import test from 'node:test';
import assert from 'node:assert/strict';
import { retrievalTerms, retrieveSegments } from '../packages/domain/src/retrieval.ts';
import { chatIntent } from '../packages/domain/src/chat-anchors.ts';
import { retrievalCorpus, goldQueries } from './fixtures/retrieval-corpus.mjs';

test('pre-labelled hour transcript retrieves early, tail, cross-span, negative and English evidence', t => {
  const source = retrievalCorpus(), original = structuredClone(source);
  assert.ok(source.length > 600); assert.ok(source.reduce((n, row) => n + row.text.length, 0) > 32000);
  for (const query of goldQueries) {
    const result = retrieveSegments(source, query.question), ids = result.segments.map(row => row.id);
    if (query.empty) assert.deepEqual(ids, [], query.name);
    else for (const index of query.required) assert.ok(ids.includes(`p${index}`), `${query.name}: missing p${index} in ${ids}`);
    for (const index of query.excluded ?? []) assert.ok(!ids.includes(`p${index}`), query.name);
    assert.ok(ids.length <= 32); assert.ok(result.segments.reduce((n, row) => n + row.text.length, 0) <= 24000);
    assert.deepEqual(result.segments, source.filter(row => ids.includes(row.id)), query.name);
    assert.deepEqual(retrieveSegments(source, query.question), result, `deterministic ${query.name}`);
  }
  assert.deepEqual(source, original);
  t.diagnostic(`${goldQueries.length} controlled questions; these do not establish natural-podcast semantic recall`);
});

test('full local windows fit together; evidence caps never orphan their admitted hit from its negation', () => {
  const source = retrievalCorpus();
  for (let index = 30; index < 720; index += 50) {
    source[index].text = `蓝莓种植可以省略浇水，方案编号${index}。`;
    source[index + 1].text = '这个说法是错误的，不能省略这一操作。';
  }
  const result = retrieveSegments(source, '蓝莓种植可以省略浇水吗？'), ids = new Set(result.segments.map(row => row.id));
  assert.ok(result.matchedSegments > 10); assert.ok(ids.size <= 32);
  for (let index = 30; index < 720; index += 50) if (ids.has(`p${index}`)) assert.ok(ids.has(`p${index + 1}`));
  assert.ok(result.segments.some(row => row.text.includes('这个说法是错误的')));
});

test('character budget admits complete windows and preserves zero or overlapping ASR times', () => {
  const source = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, startMs: i % 2, endMs: i % 2,
    text: i % 3 === 1 ? `蓝莓编号${i}。${'长'.repeat(1900)}` : `上下文${i}。${'文'.repeat(1900)}` }));
  const result = retrieveSegments(source, '蓝莓'), ids = new Set(result.segments.map(row => row.id));
  assert.ok(result.segments.length > 0); assert.ok(result.segments.reduce((n, row) => n + row.text.length, 0) <= 24000);
  for (let i = 1; i < 30; i += 3) if (ids.has(`p${i}`)) { assert.ok(ids.has(`p${i - 1}`)); assert.ok(ids.has(`p${i + 1}`)); }
  assert.deepEqual(result.segments, source.filter(row => ids.has(row.id)));
});

test('query and source limits reject excess without truncating the requested evidence', () => {
  assert.deepEqual(retrievalTerms('C++ C# C'), ['c++', 'c#', 'c']);
  assert.throws(() => retrievalTerms(Array.from({ length: 33 }, (_, i) => `entity${i}`).join(' ')), e => e.code === 'RETRIEVAL_QUERY_LIMIT');
  assert.throws(() => retrieveSegments(Array.from({ length: 48001 }, () => ({ text: '' })), '蓝莓'), e => e.code === 'RETRIEVAL_SOURCE_LIMIT');
  assert.throws(() => retrieveSegments([{ text: '字'.repeat(2000001) }], '蓝莓'), e => e.code === 'RETRIEVAL_SOURCE_LIMIT');
  assert.deepEqual(retrieveSegments([], '蓝莓').segments, []);
});

test('retrieval anchor accepts no client-authored evidence and cannot be mixed with playback or a parent', () => {
  assert.deepEqual(chatIntent({ anchor: { kind: 'retrieval' } }), { anchor: { kind: 'retrieval' }, parentTurnId: null, legacy: null });
  for (const extra of [{ segments: [] }, { transcriptJobId: 'fake' }, { positionMs: 1 }, { throughMs: 5 }]) {
    assert.throws(() => chatIntent({ anchor: { kind: 'retrieval', ...extra } }));
  }
  assert.throws(() => chatIntent({ anchor: { kind: 'retrieval' }, positionMs: 0 }));
  assert.throws(() => chatIntent({ positionMs: 0, scope: 'retrieval' }));
});
