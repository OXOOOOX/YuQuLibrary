import type { TranscriptSegment } from '@yuqu/contracts';
import { chapterBatches } from './chapter-segments.ts';
import { AppError } from './errors.ts';
import { invalid, object } from './validation.ts';

export const SUMMARY_PART_TASK = 'yuqu.transcript.summary.part.v1';
export const SUMMARY_OVERVIEW_TASK = 'yuqu.transcript.summary.overview.v1';
export const SUMMARY_STRATEGY = 'time-bounded-summary-v2';
export const SUMMARY_TARGET_SPAN_MS = 600000;
export interface SummarySource extends TranscriptSegment { order: number }
export interface SummaryPlanNode {
  index: number; level: number; groupIndex: number; groupCount: number; children: number[];
  segments: SummarySource[] | null; startMs: number; endMs: number;
}
export interface ResolvedSummary { title: string; points: Array<{ text: string; citations: SummarySource[] }> }
export interface FrozenSummaryInput { payload: Record<string, unknown>; references: SummarySource[][] }
interface Base { title: string; durationMs: number; transcriptId: string; throughMs: number }

/** All speech is assigned once. Higher levels merge at most eight completed children. */
export function summaryPlan(source: TranscriptSegment[]) {
  if (source.length > 48000 || source.reduce((sum, row) => sum + row.text.length, 0) > 2000000) {
    throw new AppError(422, 'SUMMARY_SOURCE_LIMIT', '这期文稿超出当前总结范围。');
  }
  let batches: TranscriptSegment[][];
  try { batches = chapterBatches(source.map((part, order) => ({ ...part, order }))); }
  catch (error) {
    if (error instanceof AppError) throw new AppError(error.status, error.code === 'TRANSCRIPT_EMPTY' ? error.code : 'SUMMARY_SOURCE_LIMIT', '这期文稿暂时无法生成总结，请检查原文范围。');
    throw error;
  }
  // A sparse hour-long transcript can fit the character budget but loses topics when
  // compressed to six points. Keep each local summary near ten minutes as well.
  // Original segments are indivisible, even if one alone exceeds this soft target.
  batches = batches.flatMap(batch => {
    const bounded: TranscriptSegment[][] = []; let current: TranscriptSegment[] = [], start = Infinity, end = 0;
    for (const segment of batch) {
      if (current.length && Math.max(end, segment.endMs) - Math.min(start, segment.startMs) > SUMMARY_TARGET_SPAN_MS) {
        bounded.push(current); current = []; start = Infinity; end = 0;
      }
      current.push(segment); start = Math.min(start, segment.startMs); end = Math.max(end, segment.endMs);
    }
    if (current.length) bounded.push(current);
    return bounded;
  });
  if (batches.length > 128) throw new AppError(422, 'SUMMARY_SOURCE_LIMIT', '这期文稿超出当前总结范围。');
  const nodes: SummaryPlanNode[] = batches.map((segments, index) => ({ index, level: 0, groupIndex: index, groupCount: batches.length,
    children: [], segments: segments as SummarySource[], startMs: Math.min(...segments.map(row => row.startMs)), endMs: Math.max(...segments.map(row => row.endMs)) }));
  let layer = nodes.slice(), level = 0;
  while (layer.length > 1) {
    const next: SummaryPlanNode[] = []; level++;
    for (let from = 0; from < layer.length; from += 8) {
      const children = layer.slice(from, from + 8);
      const node: SummaryPlanNode = { index: nodes.length, level, groupIndex: next.length, groupCount: Math.ceil(layer.length / 8),
        children: children.map(child => child.index), segments: null,
        startMs: Math.min(...children.map(child => child.startMs)), endMs: Math.max(...children.map(child => child.endMs)) };
      nodes.push(node); next.push(node);
    }
    layer = next;
  }
  return { nodes, totalParts: batches.length, rootIndex: nodes.length - 1 };
}

export function summaryInput(base: Base, node: SummaryPlanNode, isFinal: boolean, children: ResolvedSummary[]): FrozenSummaryInput {
  if (node.level === 0) {
    const source = node.segments!;
    return { payload: { ...base, partIndex: node.groupIndex, partCount: node.groupCount,
      segments: source.map(({ startMs, endMs, text }, index) => ({ id: `S${index + 1}`, startMs, endMs, text })) },
    references: source.map(row => [{ ...row }]) };
  }
  if (children.length !== node.children.length || children.length > 8) throw new Error('Summary dependencies are incomplete');
  const points = children.flatMap(child => child.points.map(point => ({ sectionTitle: child.title, point })));
  if (!points.length || points.length > 48) throw new Error('Invalid summary dependency size');
  return { payload: { ...base, level: node.level, groupIndex: node.groupIndex, groupCount: node.groupCount, isFinal,
    parts: points.map(({ sectionTitle, point }, index) => ({ id: `P${index + 1}`, sectionTitle, text: point.text,
      startMs: Math.min(...point.citations.map(citation => citation.startMs)), endMs: Math.max(...point.citations.map(citation => citation.endMs)) })) },
  references: points.map(({ point }) => point.citations.map(citation => ({ ...citation }))) };
}

/** The model chooses local IDs only. Original text/order/times come from frozen evidence. */
export function resolveSummary(value: unknown, input: FrozenSummaryInput, level: number): ResolvedSummary {
  const result = object(value);
  if (Object.keys(result).some(key => !['title', 'points'].includes(key)) || typeof result.title !== 'string' ||
    !result.title.trim() || result.title.trim().length > 120 || /[\r\n\u0000-\u001f]/u.test(result.title) ||
    !Array.isArray(result.points) || result.points.length < 1 || result.points.length > 6) throw invalid('总结结果格式无效，请重试。');
  const seen = new Set<string>(), prefix = level === 0 ? 'S' : 'P';
  const points = result.points.map(item => {
    const point = object(item);
    if (Object.keys(point).some(key => !['text', 'citationIds'].includes(key)) || typeof point.text !== 'string' ||
      !point.text.trim() || point.text.trim().length > 600 || !Array.isArray(point.citationIds) ||
      point.citationIds.length < 1 || point.citationIds.length > 2 || new Set(point.citationIds).size !== point.citationIds.length) throw invalid('总结要点或引用无效。');
    const identity = point.text.trim().normalize('NFKC').replace(/\s+/gu, ' ').toLowerCase();
    if (seen.has(identity)) throw invalid('总结包含重复要点，请重试。'); seen.add(identity);
    const evidence = new Map<string, SummarySource>();
    for (const id of point.citationIds) {
      if (typeof id !== 'string' || !new RegExp(`^${prefix}[1-9]\\d{0,2}$`).test(id)) throw invalid('总结引用编号无效。');
      const references = input.references[Number(id.slice(1)) - 1];
      if (!references?.length) throw invalid('总结引用不属于本次固定原文。');
      for (const citation of references) evidence.set(citation.id, { ...citation });
    }
    // 128 leaves, fan-out eight, max three merge levels, and two references per point.
    if (evidence.size > 16) throw invalid('总结引用超出当前范围。');
    return { text: point.text.trim(), citations: [...evidence.values()].sort((a, b) => a.order - b.order) };
  });
  return { title: result.title.trim(), points };
}
