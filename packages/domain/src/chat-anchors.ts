import type { ChatAnchor, PositionScope } from '@yuqu/contracts';
import { integer, invalid, object, uuid } from './validation.ts';

export interface ChatIntent {
  parentTurnId: string | null;
  anchor: ChatAnchor | null;
  legacy: { positionMs: number; scope: PositionScope } | null;
}
const scopes = ['near', 'until', 'all'];
/** Normalize once for validation and idempotency; never trust client supplied text. */
export function chatIntent(input: Record<string, unknown>): ChatIntent {
  if (input.parentTurnId !== undefined) {
    if (input.anchor !== undefined || input.positionMs !== undefined || input.scope !== undefined) throw invalid('追问沿用原话题，不能同时更换提问范围。');
    return { parentTurnId: uuid(input.parentTurnId), anchor: null, legacy: null };
  }
  if (input.anchor === undefined) {
    const scope = input.scope ?? 'near';
    if (!scopes.includes(scope as string)) throw invalid('提问范围无效。');
    return { parentTurnId: null, anchor: null, legacy: { positionMs: integer(input.positionMs), scope: scope as PositionScope } };
  }
  if (input.positionMs !== undefined || input.scope !== undefined) throw invalid('请只提交一种提问锚点。');
  const value = object(input.anchor);
  let anchor: ChatAnchor;
  if (value.kind === 'position') {
    if (!scopes.includes(value.scope as string) || !['local', 'synced'].includes(value.positionSource as string) ||
        typeof value.capturedAt !== 'string' || value.capturedAt.length > 40 || !Number.isFinite(Date.parse(value.capturedAt))) throw invalid('提问位置无效。');
    anchor = { kind: 'position', positionMs: integer(value.positionMs), scope: value.scope as PositionScope,
      capturedAt: new Date(value.capturedAt).toISOString(), positionSource: value.positionSource as 'local' | 'synced' };
  } else if (value.kind === 'retrieval') {
    if (Object.keys(value).some(key => key !== 'kind')) throw invalid('整期检索不能指定外部文稿或片段。');
    anchor = { kind: 'retrieval' };
  } else if (value.kind === 'transcript-selection') {
    const ids = value.segmentIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 32 || ids.some(id => typeof id !== 'string' || id.length > 100) || new Set(ids).size !== ids.length) throw invalid('请选择最多 32 个连续文稿片段。');
    anchor = { kind: 'transcript-selection', transcriptJobId: uuid(value.transcriptJobId), throughMs: integer(value.throughMs, 1, 14400000), segmentIds: [...ids] };
  } else if (value.kind === 'citation-selection') {
    const ids = value.citationIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 32 || ids.some(id => typeof id !== 'string' || !/^S[1-9]\d{0,2}$/.test(id)) || new Set(ids).size !== ids.length) throw invalid('引用选择无效。');
    anchor = { kind: 'citation-selection', sourceTurnId: uuid(value.sourceTurnId), citationIds: [...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))) };
  } else throw invalid('提问锚点无效。');
  return { parentTurnId: null, anchor, legacy: null };
}
