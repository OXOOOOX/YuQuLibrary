import test from 'node:test';
import assert from 'node:assert/strict';
import { summaryPlan, summaryInput, resolveSummary } from '../packages/domain/src/summary-segments.ts';

const base = { title: '总结测试', durationMs: 14400000, transcriptId: '00000000-0000-4000-8000-000000000001', throughMs: 14400000 };
const source = (n, text = '原文。') => Array.from({ length: n }, (_, i) => ({ id: `source:${i}`, startMs: i * 10, endMs: i * 10 + 10, text }));
const answer = (ids, text = '保留原文中的条件。') => ({ title: '主题', points: [{ text, citationIds: ids }] });

test('summary planning covers every original segment once with bounded prompts and three merge levels', () => {
  const original = source(39000), plan = summaryPlan(original), results = new Map();
  assert.equal(plan.totalParts, 65); assert.equal(plan.nodes.at(-1).level, 3);
  assert.deepEqual(plan.nodes.filter(n => n.level === 0).flatMap(n => n.segments).map(({ order, ...row }) => row), original);
  for (const node of plan.nodes) {
    const input = summaryInput(base, node, node.index === plan.rootIndex, node.children.map(id => results.get(id)));
    if (node.level === 0) {
      assert.ok(input.payload.segments.length <= 600);
      assert.ok(input.payload.segments.reduce((n, row) => n + row.text.length, 0) <= 24000);
    } else {
      assert.ok(node.children.length <= 8); assert.ok(node.children.every(id => id < node.index));
      assert.ok(input.payload.parts.length <= 48); assert.equal(input.payload.isFinal, node.index === plan.rootIndex);
    }
    results.set(node.index, resolveSummary(answer([node.level ? 'P1' : 'S1']), input, node.level));
  }
  assert.equal(results.get(plan.rootIndex).points[0].citations[0].id, original[0].id);
});
test('summary planning respects character and document bounds instead of truncating', () => {
  assert.equal(summaryPlan(source(4, '字'.repeat(8000))).totalParts, 2);
  for (const rows of [source(48001), source(251, '字'.repeat(8000)), source(1, '字'.repeat(8001))]) {
    assert.throws(() => summaryPlan(rows), error => error.code === 'SUMMARY_SOURCE_LIMIT');
  }
  assert.throws(() => summaryPlan([]), error => error.code === 'TRANSCRIPT_EMPTY');
});
test('sparse long transcripts split near ten minutes without losing original boundaries', () => {
  const rows = source(120).map((row, i) => ({ ...row, startMs: i * 30000, endMs: (i + 1) * 30000 }));
  const plan = summaryPlan(rows), leaves = plan.nodes.filter(node => node.level === 0);
  assert.equal(plan.totalParts, 6); assert.ok(leaves.every(node => node.endMs - node.startMs <= 600000));
  assert.deepEqual(leaves.flatMap(node => node.segments).map(({ order, ...row }) => row), rows);
  const indivisible = [{ id: 'long', startMs: 0, endMs: 600001, text: '不能擅自切开原句。' }, { id: 'after', startMs: 600001, endMs: 600001, text: '零时长原句。' }];
  assert.equal(summaryPlan(indivisible).totalParts, 2);
  assert.throws(() => summaryPlan(source(129).map((row, i) => ({ ...row, startMs: i % 2 * 3600000, endMs: i % 2 * 3600000 + 1 }))), error => error.code === 'SUMMARY_SOURCE_LIMIT');
});
test('summary citations retain exact original whitespace, source order and zero or overlapping times', () => {
  const rows = [{ id: 'first', startMs: 200, endMs: 200, text: '  不适用。  ' }, { id: 'second', startMs: 100, endMs: 300, text: '必须满足条件。' }];
  const plan = summaryPlan(rows), input = summaryInput(base, plan.nodes[0], true, []), before = structuredClone(input);
  const leaf = resolveSummary(answer(['S2', 'S1']), input, 0);
  assert.deepEqual(leaf.points[0].citations.map(({ order, ...row }) => row), rows);
  const mergeInput = summaryInput(base, { level: 1, children: [0, 1], groupIndex: 0, groupCount: 1 }, true, [leaf, leaf]);
  const merged = resolveSummary(answer(['P2', 'P1']), mergeInput, 1);
  assert.deepEqual(merged.points[0].citations, leaf.points[0].citations);
  assert.deepEqual(input, before); assert.equal(mergeInput.payload.parts[0].startMs, 100);
});
test('summary rejects fabricated source fields, unknown or wrong-scope references and duplicate points', () => {
  const plan = summaryPlan(source(2)), input = summaryInput(base, plan.nodes[0], true, []);
  const invalid = [answer(['S3']), answer(['P1']), answer(['S1-S2']), answer(['S1', 'S1']), answer(['S1', 'S2', 'S1']),
    answer([]), { ...answer(['S1']), extra: true }, { ...answer(['S1']), title: '换\n行' },
    { ...answer(['S1']), points: [{ text: '内容', citationIds: ['S1'], startMs: 0 }] },
    { title: '主题', points: [{ text: 'Ａ  B', citationIds: ['S1'] }, { text: 'a b', citationIds: ['S2'] }] },
    answer(['S1'], '字'.repeat(601)), { ...answer(['S1']), title: '字'.repeat(121) }];
  for (const proposal of invalid) assert.throws(() => resolveSummary(proposal, input, 0), error => error.code === 'INVALID_INPUT');
});
test('three levels of two-reference merges keep at most sixteen original evidence segments', () => {
  const rows = source(16).map((row, order) => ({ ...row, order }));
  let children = Array.from({ length: 8 }, (_, i) => resolveSummary(answer(['S1', 'S2']), { payload: {}, references: rows.slice(i * 2, i * 2 + 2).map(row => [row]) }, 0));
  for (let level = 1; level <= 3; level++) {
    const next = [];
    for (let i = 0; i < children.length; i += 2) {
      const input = summaryInput(base, { level, groupIndex: i / 2, groupCount: children.length / 2, children: [i, i + 1] }, level === 3, children.slice(i, i + 2));
      next.push(resolveSummary(answer(['P2', 'P1']), input, level));
    }
    children = next;
  }
  assert.deepEqual(children[0].points[0].citations, rows);
});
