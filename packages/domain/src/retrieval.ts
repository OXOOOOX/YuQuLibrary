import type { TranscriptSegment } from '@yuqu/contracts';
import { AppError } from './errors.ts';

export const RETRIEVAL_TASK_TYPE = 'yuqu.chat.retrieval.v1';
export const NO_RETRIEVAL_EVIDENCE = '未在这期已完成文稿中检索到与问题直接相关的原文。请尝试节目中的具体关键词，或选定原文片段后提问。检索未命中不代表节目一定没有提到，也不能据此补造答案。';
const splitter = new Intl.Segmenter('zh', { granularity: 'word' });
const stop = new Set(('的 了 是 在 和 与 或 及 也 都 就 而 但 一个 一些 这个 那个 这些 那些 我 你 他 她 它 我们 你们 他们 这 那 有 没有 不 不是 能 能够 可以 要 会 请 请问 说明 介绍 解释 总结 概括 分析 讨论 提到 讲到 谈到 关于 如何 怎么 为什么 什么 哪些 哪个 是否 多少 多久 怎样 什么样 主要 具体 分别 之间 区别 比较 对比 内容 节目 播客 文稿 这里 里面 全文 整期 作者 主播 说 说的 提出 什么是 并 且 为 对 把 从 到 以 为了 因为 所以 如果 则 时 中 后 前 更 最 还 很 才 又 吗 呢 吧 做 使用 进行 通过 有关 相关 ' +
  '一下 期 本期 本集 观点 要点 重点 大意 核心 需要 条件 最长 马上 写 ' +
  'a an the is are was were be been being do does did how what why which when where who whom can could would should will may might of to in on at for from by with about and or but not no it its this that these those i you he she we they their our your explain describe discuss compare comparison summarize summary episode podcast transcript tell me please main point points key takeaway takeaways').split(/\s+/));
const normalized = (value: string) => value.normalize('NFKC').toLowerCase();
const stem = (value: string) => /^[a-z]{5,}$/.test(value) && value.endsWith('ies') ? `${value.slice(0, -3)}y`
  : /^[a-z]{4,}$/.test(value) && value.endsWith('s') && !value.endsWith('ss') ? value.slice(0, -1) : value;
function words(text: string): string[] {
  const identifiers: string[] = [];
  // Preserve meaningful punctuation: C, C# and C++ are different evidence anchors.
  const plain = normalized(text).replace(/\b[a-z][a-z0-9]*(?:\+\+|#)/gu, token => { identifiers.push(token); return ' '; });
  const tokens: string[] = []; let singles = '';
  const flush = () => { if (singles.length > 1) tokens.push(singles); singles = ''; };
  for (const part of splitter.segment(plain)) {
    if (!part.isWordLike || stop.has(part.segment)) { flush(); continue; }
    if (/^\p{Script=Han}$/u.test(part.segment)) { singles += part.segment; continue; }
    flush(); tokens.push(stem(part.segment));
  }
  flush();
  return [...identifiers, ...tokens].filter(word => !stop.has(word) && word.length <= 80 && /[\p{L}\p{N}]/u.test(word));
}
/** A bounded lexical baseline, not an embedding or a claim of complete semantic recall. */
export function retrievalTerms(question: string): string[] {
  const terms = [...new Set(words(question))];
  if (terms.length > 32) throw new AppError(422, 'RETRIEVAL_QUERY_LIMIT', '问题包含较多检索词，请聚焦一个具体问题后再试。');
  return terms;
}
interface Candidate { index: number; score: number; matched: Set<string> }
export function retrieveSegments(source: TranscriptSegment[], question: string) {
  if (source.length > 48000 || source.reduce((sum, item) => sum + item.text.length, 0) > 2_000_000) {
    throw new AppError(422, 'RETRIEVAL_SOURCE_LIMIT', '这期文稿超出当前检索范围，请选择原文片段提问。');
  }
  const terms = retrievalTerms(question);
  if (!terms.length || !source.length) return { segments: [], terms, matchedSegments: 0 };
  const query = new Set(terms), frequencies = new Map<string, number>();
  // Keep counts only for query terms; do not build an unbounded full-text index in memory.
  const rows = source.map(segment => {
    const tokens = words(segment.text), counts = new Map<string, number>(), text = normalized(segment.text);
    for (const token of tokens) if (query.has(token)) counts.set(token, (counts.get(token) ?? 0) + 1);
    // Chinese token boundaries can differ between a short question and a full sentence.
    // Exact Chinese term fallback tolerates segmentation differences, never approximate characters.
    for (const term of terms) if (/^\p{Script=Han}{2,}$/u.test(term) && !counts.has(term) && text.includes(term)) counts.set(term, 1);
    for (const term of counts.keys()) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    return { length: Math.max(1, tokens.length), counts };
  });
  // A lone generic overlap in a multi-concept question is not sufficient evidence.
  // This conservative gate can miss paraphrases; callers must not treat a miss as absence.
  if (terms.filter(term => frequencies.has(term)).length / terms.length < 0.4) return { segments: [], terms, matchedSegments: 0 };
  const average = rows.reduce((sum, row) => sum + row.length, 0) / rows.length;
  const weights = new Map(terms.map(term => [term, Math.log(1 + (rows.length - (frequencies.get(term) ?? 0) + 0.5) / ((frequencies.get(term) ?? 0) + 0.5))]));
  const ranked: Candidate[] = rows.flatMap((row, index) => {
    if (!row.counts.size) return [];
    let score = 0;
    for (const [term, count] of row.counts) score += weights.get(term)! * count * 2.2 / (count + 1.2 * (0.25 + 0.75 * row.length / average));
    return [{ index, score, matched: new Set(row.counts.keys()) }];
  });
  const selected = new Set<number>(), primary = new Set<number>(), covered = new Set<string>(), windows = new Set<string>();
  let characters = 0;
  const candidates = ranked.map(candidate => {
    const window = [candidate.index - 1, candidate.index, candidate.index + 1].filter(index => index >= 0 && index < source.length);
    return { ...candidate, window, signature: JSON.stringify(window.map(index => normalized(source[index].text))) };
  });
  // Budget a complete local window before admitting its hit. Deduplicate windows rather
  // than isolated sentences, so a repeated claim followed by a correction remains visible.
  for (let round = 0; round < 12; round++) {
    let best: typeof candidates[number] | undefined, bestScore = -1;
    for (const candidate of candidates) {
      if (primary.has(candidate.index) || windows.has(candidate.signature)) continue;
      const extra = candidate.window.filter(index => !selected.has(index));
      if (!extra.length || selected.size + extra.length > 32 || characters + extra.reduce((sum, index) => sum + source[index].text.length, 0) > 24000) continue;
      const novelty = [...candidate.matched].reduce((sum, term) => sum + (covered.has(term) ? 0 : weights.get(term)!), 0);
      const nearby = selected.has(candidate.index - 1) || selected.has(candidate.index + 1);
      const score = (candidate.score + novelty * 2) * (nearby ? 0.35 : 1);
      if (score > bestScore) { best = candidate; bestScore = score; }
    }
    if (!best) break;
    primary.add(best.index); windows.add(best.signature);
    for (const index of best.window) if (!selected.has(index)) { selected.add(index); characters += source[index].text.length; }
    for (const term of best.matched) covered.add(term);
  }
  return { segments: [...selected].sort((a, b) => a - b).map(index => ({ ...source[index] })), terms, matchedSegments: ranked.length };
}
