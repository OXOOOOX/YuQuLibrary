import type { ChatCitation } from '@yuqu/contracts';
import { invalid } from './validation.ts';

/** Expand only against the transcript frozen when the question was submitted. */
export function answerCitations(answer: string, segments: ChatCitation[]): ChatCitation[] {
  const available = new Map(segments.map(segment => [segment.id, segment]));
  const selected = new Map<string, ChatCitation>();
  for (const token of answer.matchAll(/\[S\d[^\]]*\]/g)) {
    const match = /^\[S([1-9]\d{0,3})(?:\s*[-–—]\s*S?([1-9]\d{0,3}))?\]$/.exec(token[0]);
    if (!match) throw invalid('回答引用编号格式无效。');
    const start = Number(match[1]), end = Number(match[2] ?? match[1]);
    if (end < start) throw invalid('回答引用范围不能倒序。');
    if (end - start + 1 > 32) throw invalid('回答引用过多，请缩小问题范围。');
    for (let number = start; number <= end; number++) {
      const id = `S${number}`, segment = available.get(id);
      if (!segment) throw invalid('回答引用了未知的文稿片段。');
      selected.set(id, segment);
      if (selected.size > 32) throw invalid('回答引用过多，请缩小问题范围。');
    }
  }
  return [...selected.values()];
}
