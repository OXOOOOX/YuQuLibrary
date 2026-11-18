import test from 'node:test';
import assert from 'node:assert/strict';
import { topicSummaryPlan, summaryEvidenceUnits, topicSummaryInput, resolveTopicPart, resolveTopicOverview } from '../packages/domain/src/summary-topics.ts';

const base = { title: '真实边界', durationMs: 14400000, throughMs: 14400000, transcriptId: '00000000-0000-4000-8000-000000000001' };
const source = n => Array.from({ length: n }, (_, i) => ({ id: `s:${i}`, startMs: i * 1000, endMs: i * 1000 + 900, text: ` 原句 ${i}。 `, order: i }));
const groupAll = input => ({ title: '完整主题', topics: [{ title: '所有已提炼内容', itemIds: input.payload.items.map(i => i.id) }] });
const proposed = (n = 1) => ({ title: '分段', points: Array.from({ length: n }, (_, i) => ({ text: `有条件的结论 ${i}`, citationIds: ['S1'] })) });

test('topic plan gives even one leaf a root and preserves every original across five-minute/text/encoding limits', () => {
  const rows = source(700), plan = topicSummaryPlan(rows), leaves = plan.nodes.filter(n => !n.level);
  assert.equal(plan.nodes.at(-1).level, 1); assert.ok(leaves.every(n => n.endMs - n.startMs <= 300000));
  assert.deepEqual(leaves.flatMap(n => n.segments), rows); assert.equal(topicSummaryPlan(source(1)).nodes.length, 2);
  const escaped = source(8).map(s => ({ ...s, text: '\u0001'.repeat(8000) }));
  for (const node of topicSummaryPlan(escaped).nodes.filter(n => !n.level)) {
    const input = topicSummaryInput(base, node, false, []);
    assert.ok(JSON.stringify(input.payload).length <= 60000); assert.ok(input.payload.segments.reduce((n,s) => n+s.text.length,0) <= 24000);
  }
  assert.throws(() => topicSummaryPlan(source(48001)), e => e.code === 'SUMMARY_SOURCE_LIMIT');
  assert.throws(() => topicSummaryPlan(source(129).map((s,i) => ({ ...s,startMs:i*300001,endMs:i*300001+1 }))), e => e.code === 'SUMMARY_SOURCE_LIMIT');
});

test('frozen evidence units complete split statements without inventing or widening original source on read', () => {
  const rows = [{ id:'s6',text:'AI promises to change everything by',startMs:38280,endMs:46280,order:0 },
    { id:'s7',text:'next Tuesday; we do neither because AI is',startMs:46280,endMs:54280,order:1 },
    { id:'s8',text:'a tool.',startMs:54280,endMs:59640,order:2 }];
  const refs = summaryEvidenceUnits(rows);assert.equal(refs.length,1);assert.deepEqual(refs[0],rows);
  const input={format:'topics-v1',kind:'part',payload:{},references:refs};
  const resolved=resolveTopicPart(proposed(),input);assert.deepEqual(resolved.points[0].citations,rows);
  const spaced=source(6);spaced[1].startMs=80000;spaced[1].endMs=80001;assert.ok(summaryEvidenceUnits(spaced).length>1);
  const long=[{...rows[0],endMs:60000,text:'字'.repeat(5000)},rows[1]];assert.equal(summaryEvidenceUnits(long).length,2);
});

test('twelve atomic points and four context units remain bounded to sixteen exact original quotes', () => {
  const refs=summaryEvidenceUnits(source(16)),input={format:'topics-v1',kind:'part',payload:{},references:refs};
  const output=proposed(12);output.points[0].citationIds=['S4','S2','S1','S3'];
  const result=resolveTopicPart(output,input);assert.equal(result.points.length,12);assert.deepEqual(result.points[0].citations,source(16));
  for(const invalid of [proposed(13),{...output,points:[{text:'伪来源',citationIds:['S5']}]},{...output,points:[{text:'重复来源',citationIds:['S1','S1']}]},{...output,points:[{text:'换\n行',citationIds:['S1']}]}])assert.throws(()=>resolveTopicPart(invalid,input));
});

test('all parent memberships must partition inputs; grouping cannot rewrite or silently discard facts', () => {
  const plan=topicSummaryPlan(source(700)),children=plan.nodes.filter(n=>!n.level).map(n=>({id:`node-${n.index}`,level:0,result:resolveTopicPart(proposed(12),topicSummaryInput(base,n,false,[]))}));
  const input=topicSummaryInput(base,plan.nodes.at(-1),true,children),before=structuredClone(input);
  const output=groupAll(input),resolved=resolveTopicOverview(output,input);assert.equal(resolved.topics[0].points.length,children.length*12);
  assert.deepEqual(resolved.topics[0].points.map(p=>p.text).sort(),children.flatMap(c=>c.result.points.map(p=>p.text)).sort());assert.deepEqual(input,before);
  const missing=structuredClone(output);missing.topics[0].itemIds.pop();assert.throws(()=>resolveTopicOverview(missing,input),/未覆盖/);
  const duplicate=structuredClone(output);duplicate.topics[0].itemIds.push('P1');assert.throws(()=>resolveTopicOverview(duplicate,input));
  const invented=structuredClone(output);invented.topics[0].text='模型改写事实';assert.throws(()=>resolveTopicOverview(invented,input));
});

test('three-level 128-leaf merges retain all 1536 facts and serialize bounded routing metadata', () => {
  const childResults=new Map(),nodes=[];for(let i=0;i<128;i++)nodes.push({id:`leaf-${i}`,level:0,result:{title:'"'.repeat(120),points:Array.from({length:12},(_,p)=>({text:'"'.repeat(590)+`${i}:${p}`,citations:[{...source(1)[0],order:i*12+p}]}))}});
  let layer=nodes,level=0;
  while(layer.length>1){level++;const next=[];for(let i=0;i<layer.length;i+=8){const children=layer.slice(i,i+8),node={level,groupIndex:i/8,groupCount:Math.ceil(layer.length/8),children:children.map((_,i)=>i)};
    const input=topicSummaryInput(base,node,layer.length<=8,children);assert.ok(input.payload.items.length<=96);assert.ok(JSON.stringify(input.payload).length<85000);
    const result=resolveTopicOverview(groupAll(input),input);next.push({id:`l${level}-${i}`,level,result});}layer=next;}
  assert.equal(level,3);assert.equal(layer[0].result.topics[0].points.length,1536);
  assert.equal(new Set(layer[0].result.topics[0].points.map(p=>`${p.nodeId}:${p.pointIndex}`)).size,1536);
});
