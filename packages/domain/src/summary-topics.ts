import type { TranscriptSegment, SummaryTopicPoint } from '@yuqu/contracts';
import { AppError } from './errors.ts';
import { invalid, object } from './validation.ts';
import type { SummarySource, SummaryPlanNode, ResolvedSummary } from './summary-segments.ts';

export const TOPIC_SUMMARY_STRATEGY = 'topic-complete-summary-v3';
export const SUMMARY_TOPICS_CAPABILITY = 'summary-topics-v1';
export const SUMMARY_PART_V2_TASK = 'yuqu.transcript.summary.part.v2';
export const SUMMARY_OVERVIEW_V2_TASK = 'yuqu.transcript.summary.overview.v2';
export interface TopicPointRef extends SummaryTopicPoint { order: number }
export interface ResolvedTopics { title: string; topics: Array<{ title: string; points: TopicPointRef[] }> }
export interface FrozenTopicPartInput { format: 'topics-v1'; kind: 'part'; payload: Record<string, unknown>; references: SummarySource[][] }
export interface FrozenTopicOverviewInput { format: 'topics-v1'; kind: 'overview'; payload: Record<string, unknown>; references: TopicPointRef[][] }
export type FrozenTopicInput = FrozenTopicPartInput | FrozenTopicOverviewInput;
interface Base { title: string; durationMs: number; transcriptId: string; throughMs: number }
interface Child { id: string; level: number; result: ResolvedSummary | ResolvedTopics }
const identity = (text: string) => text.normalize('NFKC').replace(/\s+/gu, ' ').toLowerCase();
function boundedText(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u001f]/u.test(value)) throw invalid('总结文字格式无效。');
  return value.trim();
}

/** Five-minute source batches, with enough text headroom for evidence-unit separators. */
export function topicSummaryPlan(source: TranscriptSegment[]) {
  if (!source.length) throw new AppError(409, 'TRANSCRIPT_EMPTY', '文稿没有可用于生成总结的内容。');
  if (source.length > 48000 || source.reduce((sum, row) => sum + row.text.length, 0) > 2000000) throw new AppError(422, 'SUMMARY_SOURCE_LIMIT', '这期文稿超出当前总结范围。');
  const batches: SummarySource[][] = []; let current: SummarySource[] = [], size = 0, serializedSize = 0, start = Infinity, end = 0;
  for (let order = 0; order < source.length; order++) {
    const segment = source[order];
    if (!segment.text.trim() || segment.text.length > 8000) throw new AppError(422, 'SUMMARY_SOURCE_LIMIT', '有文稿片段超出总结处理范围。');
    const encoded = JSON.stringify({ id: 'S600', startMs: segment.startMs, endMs: segment.endMs, text: segment.text }).length + 1;
    if (current.length && (current.length === 600 || size + segment.text.length > 23000 || serializedSize + encoded > 55000 || Math.max(end, segment.endMs) - Math.min(start, segment.startMs) > 300000)) {
      batches.push(current); current = []; size = 0; serializedSize = 0; start = Infinity; end = 0;
    }
    current.push({ ...segment, order }); size += segment.text.length; serializedSize += encoded; start = Math.min(start, segment.startMs); end = Math.max(end, segment.endMs);
  }
  if (current.length) batches.push(current);
  if (batches.length > 128) throw new AppError(422, 'SUMMARY_SOURCE_LIMIT', '这期文稿超出当前总结范围。');
  const nodes: SummaryPlanNode[] = batches.map((segments, index) => ({ index, level: 0, groupIndex: index, groupCount: batches.length,
    children: [], segments, startMs: Math.min(...segments.map(s => s.startMs)), endMs: Math.max(...segments.map(s => s.endMs)) }));
  let layer = nodes.slice(), level = 0;
  // Even a single part gets a topic root, so all v3 documents have one public format.
  do {
    const next: SummaryPlanNode[] = []; level++;
    for (let from = 0; from < layer.length; from += 8) {
      const children = layer.slice(from, from + 8), node: SummaryPlanNode = { index: nodes.length, level,
        groupIndex: next.length, groupCount: Math.ceil(layer.length / 8), children: children.map(c => c.index), segments: null,
        startMs: Math.min(...children.map(c => c.startMs)), endMs: Math.max(...children.map(c => c.endMs)) };
      nodes.push(node); next.push(node);
    }
    layer = next;
  } while (layer.length > 1);
  return { nodes, totalParts: batches.length, rootIndex: nodes.length - 1 };
}

/** Non-overlapping, bounded original-context units; never invent source timestamps/text. */
export function summaryEvidenceUnits(source: SummarySource[]): SummarySource[][] {
  const units: SummarySource[][] = []; let current: SummarySource[] = [], chars = 0, start = Infinity, end = 0;
  for (const segment of source) {
    if (current.length && (current.length === 4 || chars + 1 + segment.text.length > 4000 ||
        Math.max(end, segment.endMs) - Math.min(start, segment.startMs) > 30000 || segment.startMs - end > 2000)) {
      units.push(current); current = []; chars = 0; start = Infinity; end = 0;
    }
    chars += segment.text.length + (current.length ? 1 : 0); current.push({ ...segment }); start = Math.min(start, segment.startMs); end = Math.max(end, segment.endMs);
  }
  if (current.length) units.push(current);
  return units;
}

export function topicSummaryInput(base: Base, node: SummaryPlanNode, isFinal: boolean, children: Child[]): FrozenTopicInput {
  if (!node.level) {
    const references = summaryEvidenceUnits(node.segments!);
    const input: FrozenTopicPartInput = { format: 'topics-v1', kind: 'part', payload: { ...base, partIndex: node.groupIndex, partCount: node.groupCount,
      segments: references.map((rows, i) => ({ id: `S${i + 1}`, text: rows.map(s => s.text).join('\n'),
        startMs: Math.min(...rows.map(s => s.startMs)), endMs: Math.max(...rows.map(s => s.endMs)) })) }, references };
    if (JSON.stringify(input.payload).length > 60000) throw new AppError(422, 'SUMMARY_SOURCE_LIMIT', '总结原文编码超出处理范围。');
    return input;
  }
  if (children.length !== node.children.length || children.length > 8) throw new Error('Summary dependencies are incomplete');
  const items = children.flatMap(child => child.level === 0
    ? (child.result as ResolvedSummary).points.map((point, pointIndex) => {
      const startMs = Math.min(...point.citations.map(s => s.startMs)), endMs = Math.max(...point.citations.map(s => s.endMs));
      return { title: child.result.title, text: point.text.slice(0, 240), startMs, endMs, references: [{ nodeId: child.id, pointIndex, text: point.text,
        evidenceCount: point.citations.length, startMs, endMs, order: Math.min(...point.citations.map(s => s.order)) }] };
    })
    : (child.result as ResolvedTopics).topics.map(topic => ({ title: topic.title,
      // This is routing metadata only. The immutable leaf point text below is never truncated.
      text: topic.points.map(p => p.text).join('；').slice(0, 240), startMs: Math.min(...topic.points.map(p => p.startMs)),
      endMs: Math.max(...topic.points.map(p => p.endMs)), references: topic.points.map(p => ({ ...p })) })));
  if (!items.length || items.length > 96) throw new Error('Invalid topic dependency size');
  const input: FrozenTopicOverviewInput = { format: 'topics-v1', kind: 'overview', payload: { ...base, level: node.level, groupIndex: node.groupIndex, groupCount: node.groupCount, isFinal,
    items: items.map(({ references: _, ...item }, i) => ({ id: `P${i + 1}`, ...item })) }, references: items.map(i => i.references) };
  if (JSON.stringify(input.payload).length > 85000) throw new AppError(422, 'SUMMARY_SOURCE_LIMIT', '总结主题输入超出处理范围。');
  return input;
}

export function resolveTopicPart(value: unknown, input: FrozenTopicPartInput): ResolvedSummary {
  const result = object(value), title = boundedText(result.title, 120);
  if (Object.keys(result).some(k => !['title', 'points'].includes(k)) || !Array.isArray(result.points) || !result.points.length || result.points.length > 12) throw invalid('总结要点格式无效。');
  const seen = new Set<string>();
  const points = result.points.map(item => {
    const point = object(item), text = boundedText(point.text, 600), ids = point.citationIds;
    if (Object.keys(point).some(k => !['text', 'citationIds'].includes(k)) || !Array.isArray(ids) || !ids.length || ids.length > 4 || new Set(ids).size !== ids.length || seen.has(identity(text))) throw invalid('总结要点或引用无效。');
    seen.add(identity(text)); const evidence = new Map<string, SummarySource>();
    for (const id of ids) {
      if (typeof id !== 'string' || !/^S[1-9]\d{0,2}$/u.test(id)) throw invalid('总结引用编号无效。');
      const rows = input.references[Number(id.slice(1)) - 1]; if (!rows?.length) throw invalid('总结引用不属于固定原文。');
      for (const row of rows) evidence.set(row.id, { ...row });
    }
    if (evidence.size > 16) throw invalid('总结引用超出范围。');
    return { text, citations: [...evidence.values()].sort((a, b) => a.order - b.order) };
  });
  return { title, points };
}

/** The model names groups only. Every inherited fact is retained once, verbatim. */
export function resolveTopicOverview(value: unknown, input: FrozenTopicOverviewInput): ResolvedTopics {
  const result = object(value), title = boundedText(result.title, 120);
  if (Object.keys(result).some(k => !['title', 'topics'].includes(k)) || !Array.isArray(result.topics) || !result.topics.length || result.topics.length > 12) throw invalid('总结主题格式无效。');
  const used = new Set<number>(), names = new Set<string>(), pointIds = new Set<string>(); let pointCount = 0;
  const topics = result.topics.map(item => {
    const topic = object(item), topicTitle = boundedText(topic.title, 120);
    if (Object.keys(topic).some(k => !['title', 'itemIds'].includes(k)) || !Array.isArray(topic.itemIds) || !topic.itemIds.length || topic.itemIds.length > 96 || names.has(identity(topicTitle))) throw invalid('总结主题分组无效。');
    names.add(identity(topicTitle)); const points: TopicPointRef[] = [];
    for (const id of topic.itemIds) {
      if (typeof id !== 'string' || !/^P[1-9]\d?$/u.test(id)) throw invalid('主题来源编号无效。');
      const index = Number(id.slice(1)) - 1, refs = input.references[index];
      if (!refs?.length || used.has(index)) throw invalid('主题来源缺失或重复。');
      used.add(index);
      for (const ref of refs) {
        const key = `${ref.nodeId}:${ref.pointIndex}`;
        if (pointIds.has(key) || ++pointCount > 1536) throw invalid('主题要点重复或超限。');
        pointIds.add(key); points.push({ ...ref });
      }
    }
    return { title: topicTitle, points: points.sort((a, b) => a.order - b.order || a.pointIndex - b.pointIndex) };
  });
  if (used.size !== input.references.length) throw invalid('主题未覆盖全部输入要点，请重新整理。');
  return { title, topics };
}
