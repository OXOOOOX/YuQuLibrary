import type { TranscriptSegment } from '@yuqu/contracts';

export type StoredSegment = Omit<TranscriptSegment, 'id'> & { continuesPrevious?: boolean; joinWithSpace?: boolean };
export interface SentenceChunk { chunk_index: number; segments: StoredSegment[] }
export interface Sentence extends TranscriptSegment { ownerChunk: number }
function endsSentence(text: string, following: string, joinWithSpace?: boolean): boolean {
  const tail = text.trimEnd().replace(/[”’"'」』）)\]]+$/u, '').trimEnd();
  if (/[。！？!?；;]$/u.test(tail)) return true;
  if (!tail.endsWith('.')) return false;
  if (joinWithSpace === false && /[A-Za-z0-9]\.$/u.test(tail) && /^[A-Za-z0-9]/u.test(following)) return false;
  const token = tail.split(/\s+/u).at(-1)!;
  return !['mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'sr.', 'jr.', 'e.g.', 'i.e.', 'vs.'].includes(token.toLowerCase()) &&
    !/^(?:[A-Za-z]\.)+$/u.test(token);
}

/** A derived view only. Committed chunks and frozen question snapshots never change. */
export function projectSentences(jobId: string, chunks: SentenceChunk[]): Sentence[] {
  const result: Sentence[] = [];
  let previousChunk: SentenceChunk | undefined;
  for (const chunk of chunks) {
    for (const [index, part] of chunk.segments.entries()) {
      const previous = result.at(-1);
      if (index === 0 && part.continuesPrevious === true && previous &&
          previousChunk?.chunk_index === chunk.chunk_index - 1 && previousChunk.segments.length > 0 &&
          !endsSentence(previous.text, part.text, part.joinWithSpace) && part.startMs - previous.endMs < 800 &&
          part.startMs >= previous.startMs && previous.text.length + part.text.length < 2000) {
        const needsSpace = part.joinWithSpace ?? (/[\p{Script=Latin}\p{N}.,;:!?]$/u.test(previous.text) && /^[\p{Script=Latin}\p{N}]/u.test(part.text));
        const space = needsSpace ? ' ' : '';
        previous.text += space + part.text;
        previous.endMs = Math.max(previous.endMs, part.endMs);
      } else {
        result.push({ id: `${jobId}:${chunk.chunk_index}:${index}`, ownerChunk: chunk.chunk_index,
          startMs: part.startMs, endMs: part.endMs, text: part.text });
      }
    }
    previousChunk = chunk;
  }
  return result;
}

export function sentencePage(jobId: string, chunks: SentenceChunk[], cursor: number, atMs?: number) {
  const sentences = projectSentences(jobId, chunks);
  if (atMs !== undefined) {
    const match = sentences.find(sentence => sentence.startMs <= atMs && sentence.endMs > atMs);
    cursor = match ? match.ownerChunk - 1 : Math.max(-1, Math.min(478, Math.floor(atMs / 30000) - 1));
  }
  const candidates = chunks.filter(chunk => chunk.chunk_index > cursor);
  const selected = candidates.slice(0, 5);
  const end = selected.at(-1)?.chunk_index ?? cursor;
  return { segments: sentences.filter(sentence => sentence.ownerChunk > cursor && sentence.ownerChunk <= end)
    .map(({ ownerChunk: _, ...segment }) => segment),
    pageCursor: cursor, nextCursor: candidates.length > 5 ? end : null };
}
