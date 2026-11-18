import type { ChatAnchor } from '@yuqu/contracts';

export const time = (ms: number) => `${Math.floor(Math.max(0, ms) / 60000)}:${Math.floor(Math.max(0, ms) / 1000 % 60).toString().padStart(2, '0')}`;
export interface QuestionSelection { anchor: ChatAnchor; label: string; nonce: number; question?: string }
export interface SourceLocation { mediaVersionId: string; title?: string; positionMs: number; nonce: number; audioAvailable?: boolean }
export class KnowledgeRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
export async function knowledgeApi<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'), credentials: 'same-origin', cache: 'no-store',
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
    ...(options.body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) })
  });
  const value = await response.json();
  if (!response.ok) throw new KnowledgeRequestError(value.error?.message || '请求未完成，请稍后重试。', response.status);
  return value as T;
}

/** Only the validated list can make a marker actionable. */
export function citationIds(marker: string, available: readonly string[]): string[] {
  const match = /^\[S([1-9]\d*)(?:\s*[-–—]\s*S?([1-9]\d*))?\]$/.exec(marker);
  if (!match) return [];
  const start = Number(match[1]), end = Number(match[2] ?? match[1]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end - start >= 32) return [];
  const ids = Array.from({ length: end - start + 1 }, (_, i) => `S${start + i}`);
  return ids.every(id => available.includes(id)) ? ids : [];
}
