import type { Chapter, TranscriptSegment } from '@yuqu/contracts';
import { AppError } from './errors.ts';
import { invalid, object } from './validation.ts';

export interface ChapterProposal { title: string; startSegmentId: string; endSegmentId: string }
export interface ChapterResult { chapters: ChapterProposal[]; continuesPrevious: boolean }
export interface ResolvedChapters { chapters: Chapter[]; continuesPrevious: boolean }

/** These are prompt limits, not chapter boundaries. The model may continue the preceding topic. */
export function chapterBatches(segments: TranscriptSegment[]): TranscriptSegment[][] {
  if (!segments.length) throw new AppError(409, 'TRANSCRIPT_EMPTY', '文稿没有可用于生成章节的内容。');
  const batches: TranscriptSegment[][] = []; let batch: TranscriptSegment[] = [], size = 0;
  for (const segment of segments) {
    if (!segment.text.trim() || segment.text.length > 8000) throw new AppError(422, 'CHAPTER_SOURCE_LIMIT', '有文稿片段超出章节处理范围，请先检查文稿。');
    if (batch.length === 600 || size + segment.text.length > 24000) { batches.push(batch); batch = []; size = 0; }
    batch.push(segment); size += segment.text.length;
  }
  if (batch.length) batches.push(batch);
  if (batches.length > 128) throw new AppError(422, 'CHAPTER_SOURCE_LIMIT', '这期文稿超出章节处理范围。');
  return batches;
}

export function resolveChapters(value: unknown, segments: TranscriptSegment[], batchId: string, hasPrevious: boolean): ResolvedChapters {
  const input = object(value);
  if (Object.keys(input).some(key => !['chapters', 'continuesPrevious'].includes(key)) ||
      typeof input.continuesPrevious !== 'boolean' || (input.continuesPrevious && !hasPrevious) ||
      !Array.isArray(input.chapters) || input.chapters.length < 1 || input.chapters.length > 32) throw invalid('章节结果格式无效，请重试生成。');
  let next = 0;
  const chapters = input.chapters.map((item, index): Chapter => {
    const chapter = object(item);
    if (Object.keys(chapter).some(key => !['title', 'startSegmentId', 'endSegmentId'].includes(key)) ||
        typeof chapter.title !== 'string' || !chapter.title.trim() || chapter.title.trim().length > 80 || /[\r\n\u0000-\u001f]/.test(chapter.title) ||
        typeof chapter.startSegmentId !== 'string' || typeof chapter.endSegmentId !== 'string' ||
        !/^S[1-9]\d{0,2}$/.test(chapter.startSegmentId) || !/^S[1-9]\d{0,2}$/.test(chapter.endSegmentId)) throw invalid('章节标题或原文范围无效。');
    const start = Number(chapter.startSegmentId.slice(1)) - 1, end = Number(chapter.endSegmentId.slice(1)) - 1;
    if (start !== next || end < start || end >= segments.length) throw invalid('章节必须按顺序覆盖本批原文，不能遗漏或重复。');
    next = end + 1;
    const selected = segments.slice(start, end + 1);
    return { id: `${batchId}:${index}`, title: chapter.title.trim(), startMs: Math.min(...selected.map(segment => segment.startMs)),
      endMs: Math.max(...selected.map(segment => segment.endMs)), startSegmentId: segments[start].id, endSegmentId: segments[end].id };
  });
  if (next !== segments.length) throw invalid('章节未覆盖全部原文，请重试生成。');
  return { chapters, continuesPrevious: input.continuesPrevious };
}

/** Only adjacent completed batches can extend a topic; existing source snapshots remain immutable. */
export function mergeChapters(results: ResolvedChapters[]): Chapter[] {
  const chapters: Chapter[] = [];
  for (const result of results) {
    const current = result.chapters.map(chapter => ({ ...chapter }));
    if (result.continuesPrevious && chapters.length && current.length) {
      const continuation = current.shift()!, last = chapters[chapters.length - 1];
      last.startMs = Math.min(last.startMs, continuation.startMs);
      last.endMs = Math.max(last.endMs, continuation.endMs); last.endSegmentId = continuation.endSegmentId;
    }
    chapters.push(...current);
  }
  return chapters;
}
