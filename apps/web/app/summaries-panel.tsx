'use client';

import { useEffect, useRef, useState } from 'react';
import type { SummaryDocument, SummaryEvidence, SummaryResult, SummariesPage, SummaryTopicOverview, SummaryTopicPage, SummaryTopicPoint } from '@yuqu/contracts';
import { knowledgeApi, time } from './knowledge-ui';

const summaryStatuses = ['queued', 'running', 'complete', 'failed', 'cancelled'] as const;
type SummaryStatus = (typeof summaryStatuses)[number];
interface EvidenceState { visible: boolean; loading: boolean; evidence?: SummaryEvidence; error?: string }
type EvidenceStates = Record<string, EvidenceState>;

export interface SummariesPanelProps {
  mediaVersionId: string;
  audioAvailable: boolean;
  playbackBusy: boolean;
  active: boolean;
  transcriptReady: boolean;
  play: (mediaId: string, startMs: number, endMs: number) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isSummaryId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function statusLabel(status: SummaryStatus): string {
  return ({ queued: '等待生成', running: '正在生成', complete: '已完成', failed: '生成失败', cancelled: '已停止' } as const)[status];
}

function validateSnapshot(value: unknown): void {
  if (!isRecord(value) || !isSummaryId(value.transcriptJobId) ||
    !isSafeInteger(value.throughMs) || value.throughMs <= 0 || value.throughMs > 14400000) throw new Error('总结水位响应无效，请重试。');
}

function validateSummaryResult(value: unknown, maxPoints = 6): SummaryResult {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || typeof value.title !== 'string' ||
    !value.title || !isSafeInteger(value.startMs) || !isSafeInteger(value.endMs) || value.startMs < 0 ||
    value.endMs < value.startMs || value.endMs > 14400000 || !Array.isArray(value.points) || value.points.length < 1 || value.points.length > maxPoints) {
    throw new Error('总结内容响应无效，请重试。');
  }
  for (const point of value.points) {
    if (!isRecord(point) || typeof point.text !== 'string' || !point.text ||
      !isSafeInteger(point.evidenceCount) || point.evidenceCount < 1 || point.evidenceCount > 16) {
      throw new Error('总结要点响应无效，请重试。');
    }
  }
  return value as unknown as SummaryResult;
}

function validatePage(value: unknown, mediaVersionId: string): SummariesPage {
  if (!isRecord(value) || value.mediaVersionId !== mediaVersionId || typeof value.audioAvailable !== 'boolean' ||
    typeof value.canGenerate !== 'boolean' || typeof value.bridgeOnline !== 'boolean' || !Array.isArray(value.parts) ||
    value.parts.length > 8 || (value.nextAfter !== null && (!isSafeInteger(value.nextAfter) || value.nextAfter <= 0 || value.nextAfter > 127))) {
    throw new Error('总结响应无效，请重试。');
  }
  if (value.document !== null) {
    if (!isRecord(value.document) || !isSummaryId(value.document.id) ||
      !summaryStatuses.includes(value.document.status as SummaryStatus) || !isSafeInteger(value.document.completedParts) ||
      !isSafeInteger(value.document.totalParts) || value.document.totalParts < 1 || value.document.totalParts > 128 || value.document.completedParts < 0 ||
      value.document.completedParts > value.document.totalParts || !isSafeInteger(value.document.completedTasks) ||
      !isSafeInteger(value.document.totalTasks) || value.document.totalTasks < 1 || value.document.totalTasks > 147 || value.document.completedTasks < 0 ||
      value.document.completedTasks > value.document.totalTasks || value.document.totalTasks < value.document.totalParts ||
      (value.document.status === 'complete' && (value.document.completedParts !== value.document.totalParts || value.document.completedTasks !== value.document.totalTasks)) ||
      typeof value.document.createdAt !== 'string' || !Number.isFinite(Date.parse(value.document.createdAt)) ||
      (value.document.format !== undefined && value.document.format !== 'topics-v1')) {
      throw new Error('总结任务状态响应无效，请重试。');
    }
    validateSnapshot(value.document.snapshot);
  }
  const topicOverview = value.topicOverview ?? null;
  const topicsFormat = value.document !== null && value.document.format === 'topics-v1';
  if (value.document === null && (value.overview !== null || topicOverview !== null || value.parts.length > 0 || value.nextAfter !== null)) throw new Error('无总结文档却返回了总结内容，请重试。');
  if (value.document !== null && value.document.status === 'complete' && (topicsFormat ? topicOverview === null || value.overview !== null : value.overview === null || topicOverview !== null)) throw new Error('已完成总结缺少整期内容，请重试。');
  if (value.document !== null && value.document.status !== 'complete' && (value.overview !== null || topicOverview !== null)) throw new Error('未完成总结不应返回整期内容，请重试。');
  if (topicOverview !== null) {
    if (!topicsFormat || !isRecord(topicOverview) || typeof topicOverview.id !== 'string' || !topicOverview.id || topicOverview.id.length > 120 || typeof topicOverview.title !== 'string' || !topicOverview.title.trim() || topicOverview.title.length > 120 ||
      !Array.isArray(topicOverview.topics) || topicOverview.topics.length < 1 || topicOverview.topics.length > 12) throw new Error('总结主题响应无效，请重试。');
    let count = 0;
    topicOverview.topics.forEach((topic, index) => {
      if (!isRecord(topic) || topic.index !== index || typeof topic.title !== 'string' || !topic.title.trim() || topic.title.length > 120 || !isSafeInteger(topic.pointCount) || topic.pointCount < 1 || topic.pointCount > 1536) throw new Error('总结主题索引响应无效，请重试。');
      count += topic.pointCount;
    });
    if (count > 1536) throw new Error('总结主题总量响应无效，请重试。');
  }
  const snapshotThroughMs = value.document === null ? null : (value.document.snapshot as { throughMs: number }).throughMs;
  if (value.overview !== null) {
    const overview = validateSummaryResult(value.overview);
    if (snapshotThroughMs !== null && overview.endMs > snapshotThroughMs) throw new Error('整期总结范围响应无效，请重试。');
  }
  const indexes = new Set<number>();
  for (const part of value.parts) {
    const result = validateSummaryResult(part, topicsFormat ? 12 : 6);
    if (!isRecord(part) || !isSafeInteger(part.index) || part.index < 0 || part.index > 127 || indexes.has(part.index)) {
      throw new Error('总结分段响应无效，请重试。');
    }
    if (snapshotThroughMs !== null && result.endMs > snapshotThroughMs) throw new Error('总结分段范围响应无效，请重试。');
    indexes.add(part.index);
    void result;
  }
  return value as unknown as SummariesPage;
}

function validateEvidence(value: unknown, mediaVersionId: string, documentId: string, nodeId: string, pointIndex: number, expectedSnapshot: { transcriptJobId: string; throughMs: number }): SummaryEvidence {
  if (!isRecord(value) || value.mediaVersionId !== mediaVersionId || value.documentId !== documentId ||
    value.nodeId !== nodeId || value.pointIndex !== pointIndex || typeof value.audioAvailable !== 'boolean' ||
    !Array.isArray(value.segments) || value.segments.length < 1 || value.segments.length > 16) throw new Error('依据响应无效，请重试。');
  validateSnapshot(value.snapshot);
  const snapshot = value.snapshot as { transcriptJobId: string; throughMs: number };
  if (snapshot.transcriptJobId !== expectedSnapshot.transcriptJobId || snapshot.throughMs !== expectedSnapshot.throughMs) throw new Error('依据水位已变化，请重试。');
  for (const segment of value.segments) {
    if (!isRecord(segment) || typeof segment.id !== 'string' || !segment.id || typeof segment.text !== 'string' ||
      !segment.text || !isSafeInteger(segment.startMs) || !isSafeInteger(segment.endMs) || segment.startMs < 0 ||
      segment.endMs < segment.startMs || segment.endMs > expectedSnapshot.throughMs) throw new Error('依据原文响应无效，请重试。');
  }
  return value as unknown as SummaryEvidence;
}

function evidenceKey(nodeId: string, pointIndex: number): string {
  return `${nodeId}:${pointIndex}`;
}

function SummaryResultView({ result, label, documentId, mediaVersionId, audioAvailable, playbackBusy, evidence, onEvidence, play, pointIndexes }: {
  result: SummaryResult; label: string; documentId: string; mediaVersionId: string; audioAvailable: boolean; playbackBusy: boolean;
  evidence: EvidenceStates; onEvidence: (result: SummaryResult, pointIndex: number) => void;
  play: (mediaId: string, startMs: number, endMs: number) => Promise<void>;
  pointIndexes?: number[];
}) {
  return <article className="summary-result">
    <div className="summary-result-heading"><div><h3>{label}</h3><strong>{result.title}</strong></div><span className="muted">{time(result.startMs)}–{time(result.endMs)}</span></div>
    <ol className="summary-points" style={pointIndexes ? { listStyle: 'none', paddingLeft: 0 } : undefined}>
      {result.points.map((point, displayIndex) => {
        const pointIndex = pointIndexes?.[displayIndex] ?? displayIndex;
        const key = evidenceKey(result.id, pointIndex), state = evidence[key], loadedEvidence = state?.evidence;
        return <li key={`${result.id}:${pointIndex}`} className="summary-point">
          <p>{point.text}</p>
          {point.evidenceCount > 0 ? <>
            <button type="button" className="text-button" disabled={state?.loading} onClick={() => onEvidence(result, pointIndex)}>
              {state?.loading ? '正在读取依据…' : state?.visible && state.evidence ? '收起依据' : state?.error ? '重试查看依据' : `查看依据（${point.evidenceCount}）`}
            </button>
            {state?.error ? <p className="error" role="alert">{state.error}</p> : null}
            {state?.visible && loadedEvidence ? <div className="summary-evidence" aria-label="总结依据原文">
              {loadedEvidence.segments.map(segment => <div key={segment.id} className="summary-evidence-item">
                <div className="summary-evidence-heading"><span className="transcript-time">{time(segment.startMs)}–{time(segment.endMs)}</span>
                  <button type="button" className="text-button" disabled={playbackBusy || !audioAvailable || !loadedEvidence.audioAvailable || segment.endMs <= segment.startMs}
                    onClick={() => { void play(mediaVersionId, segment.startMs, segment.endMs); }}>{!audioAvailable || !loadedEvidence.audioAvailable ? '音频已清理' : segment.endMs > segment.startMs ? '回听原文' : '无可播放时长'}</button></div>
                <p>{segment.text}</p>
              </div>)}
            </div> : null}
          </> : <span className="muted summary-no-evidence">暂无可展开的原文依据</span>}
        </li>;
      })}
    </ol>
    {documentId.length === 0 ? <span className="muted">这份总结尚未绑定文稿。</span> : null}
  </article>;
}

function validateTopicPage(value: unknown, mediaVersionId: string, document: SummaryDocument, overview: SummaryTopicOverview, topicIndex: number, after: number): SummaryTopicPage {
  const topic = overview.topics[topicIndex];
  if (!topic || !isRecord(value) || value.mediaVersionId !== mediaVersionId || value.documentId !== document.id ||
    value.topicIndex !== topicIndex || value.after !== after || value.title !== topic.title || value.totalPoints !== topic.pointCount ||
    !Array.isArray(value.points) || value.points.length !== Math.min(20, topic.pointCount - after) || value.points.length < 1 ||
    value.nextAfter !== (after + value.points.length < topic.pointCount ? after + value.points.length : null)) throw new Error('主题分页响应无效，请重试。');
  validateSnapshot(value.snapshot);
  const snapshot = value.snapshot as SummaryDocument['snapshot'];
  if (snapshot.transcriptJobId !== document.snapshot.transcriptJobId || snapshot.throughMs !== document.snapshot.throughMs) throw new Error('主题文稿水位已变化，请重试。');
  const seen = new Set<string>();
  for (const point of value.points) {
    if (!isRecord(point) || typeof point.nodeId !== 'string' || !point.nodeId || point.nodeId.length > 120 || !isSafeInteger(point.pointIndex) || point.pointIndex < 0 || point.pointIndex > 11 ||
      typeof point.text !== 'string' || !point.text.trim() || point.text.length > 600 || !isSafeInteger(point.evidenceCount) || point.evidenceCount < 1 || point.evidenceCount > 16 ||
      !isSafeInteger(point.startMs) || !isSafeInteger(point.endMs) || point.startMs < 0 || point.endMs < point.startMs || point.endMs > document.snapshot.throughMs || seen.has(evidenceKey(point.nodeId, point.pointIndex))) throw new Error('主题要点响应无效，请重试。');
    seen.add(evidenceKey(point.nodeId, point.pointIndex));
  }
  return value as unknown as SummaryTopicPage;
}

function SummaryTopicsView({ document, overview, mediaVersionId, active, audioAvailable, playbackBusy, play }: {
  document: SummaryDocument; overview: SummaryTopicOverview; mediaVersionId: string; active: boolean; audioAvailable: boolean; playbackBusy: boolean;
  play: SummariesPanelProps['play'];
}) {
  const [topicIndex, setTopicIndex] = useState<number | null>(null);
  const [page, setPage] = useState<SummaryTopicPage | null>(null);
  const [after, setAfter] = useState(0);
  const [history, setHistory] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [evidence, setEvidence] = useState<EvidenceStates>({});
  const epoch = useRef(0);
  const request = useRef<AbortController | null>(null);
  const evidenceRequests = useRef(new Map<string, AbortController>());
  const topicHeading = useRef<HTMLHeadingElement | null>(null);
  const focusRequest = useRef<number | null>(null);
  const focusFrame = useRef<number | null>(null);

  function retire(): number {
    focusRequest.current = null;
    if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
    focusFrame.current = null;
    request.current?.abort(); request.current = null;
    for (const controller of evidenceRequests.current.values()) controller.abort();
    evidenceRequests.current.clear();
    return ++epoch.current;
  }

  function close(): void {
    retire(); setTopicIndex(null); setPage(null); setAfter(0); setHistory([]); setBusy(false); setError(''); setEvidence({});
  }

  useEffect(() => {
    if (!active) close();
    const hidden = () => { if (globalThis.document.hidden) close(); };
    globalThis.document.addEventListener('visibilitychange', hidden);
    return () => { retire(); globalThis.document.removeEventListener('visibilitychange', hidden); };
  }, [active]);

  useEffect(() => {
    if (!active || busy || (!page && !error) || focusRequest.current !== epoch.current) return;
    const current = epoch.current;
    focusFrame.current = requestAnimationFrame(() => {
      focusFrame.current = null;
      if (current !== epoch.current || focusRequest.current !== current || globalThis.document.hidden) return;
      focusRequest.current = null;
      const heading = topicHeading.current;
      if (heading) {
        const player = globalThis.document.querySelector<HTMLElement>('.persistent-player');
        heading.style.scrollMarginTop = `${(player?.getBoundingClientRect().height ?? 0) + 12}px`;
        heading.scrollIntoView({ block: 'start', behavior: 'auto' });
      }
    });
    return () => { if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current); focusFrame.current = null; };
  }, [active, busy, page, error]);

  async function load(index: number, cursor: number, previous: number[]): Promise<void> {
    if (!active || globalThis.document.hidden || !overview.topics[index] || !Number.isSafeInteger(cursor) || cursor < 0 || cursor >= overview.topics[index].pointCount) return;
    const current = retire(), controller = new AbortController(); request.current = controller;
    focusRequest.current = current;
    setTopicIndex(index); setAfter(cursor); setHistory(previous); setPage(null); setBusy(true); setError(''); setEvidence({});
    try {
      const params = new URLSearchParams({ capabilities: 'summary-topics-v1', documentId: document.id, topicIndex: String(index), after: String(cursor) });
      const value = validateTopicPage(await knowledgeApi<unknown>(`/api/media/${encodeURIComponent(mediaVersionId)}/summaries/topics?${params}`, { signal: controller.signal }), mediaVersionId, document, overview, index, cursor);
      if (controller.signal.aborted || current !== epoch.current) return;
      setPage(value);
    } catch (failure) {
      if (!controller.signal.aborted && current === epoch.current) setError(failure instanceof Error ? failure.message : '主题读取失败，请重试。');
    } finally {
      if (current === epoch.current) { request.current = null; setBusy(false); }
    }
  }

  async function loadEvidence(point: SummaryTopicPoint): Promise<void> {
    if (!active || !page || globalThis.document.hidden) return;
    const key = evidenceKey(point.nodeId, point.pointIndex), existing = evidence[key];
    if (existing?.evidence) { setEvidence(values => ({ ...values, [key]: { ...existing, visible: !existing.visible } })); return; }
    if (evidenceRequests.current.has(key)) return;
    const current = epoch.current, controller = new AbortController(); evidenceRequests.current.set(key, controller);
    setEvidence(values => ({ ...values, [key]: { visible: true, loading: true } }));
    try {
      const params = new URLSearchParams({ documentId: document.id, nodeId: point.nodeId, pointIndex: String(point.pointIndex) });
      const value = validateEvidence(await knowledgeApi<unknown>(`/api/media/${encodeURIComponent(mediaVersionId)}/summaries/evidence?${params}`, { signal: controller.signal }), mediaVersionId, document.id, point.nodeId, point.pointIndex, document.snapshot);
      if (controller.signal.aborted || current !== epoch.current || evidenceRequests.current.get(key) !== controller) return;
      setEvidence(values => ({ ...values, [key]: { visible: true, loading: false, evidence: value } }));
    } catch (failure) {
      if (!controller.signal.aborted && current === epoch.current) setEvidence(values => ({ ...values, [key]: { visible: true, loading: false, error: failure instanceof Error ? failure.message : '依据读取失败，请重试。' } }));
    } finally {
      if (evidenceRequests.current.get(key) === controller) evidenceRequests.current.delete(key);
    }
  }

  return <section className="summary-overview" aria-label="整期总结">
    <h3>整期总结</h3><p>{overview.title}</p><p className="muted">按主题阅读全部要点，展开依据可查看冻结原文。</p>
    <div className="source-actions">{overview.topics.map(topic => <button type="button" key={topic.index} style={{ maxWidth: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere' }} aria-expanded={topicIndex === topic.index} onClick={() => { if (topicIndex === topic.index) close(); else void load(topic.index, 0, []); }}>{topic.title} · {topic.pointCount} 条要点</button>)}</div>
    {topicIndex !== null ? <section aria-label="主题要点">
      <h4 ref={topicHeading}>{overview.topics[topicIndex].title}</h4>
      {busy ? <p className="muted" role="status">正在读取主题要点…</p> : null}
      {error ? <div><p className="error" role="alert">{error}</p><button type="button" onClick={() => void load(topicIndex, after, history)}>重试读取主题</button>{history.length ? <button type="button" onClick={() => void load(topicIndex, history.at(-1) ?? 0, history.slice(0, -1))}>上一页要点</button> : null}</div> : null}
      {page?.points.map((point, index) => <SummaryResultView key={evidenceKey(point.nodeId, point.pointIndex)} result={{ id: point.nodeId, title: '', startMs: point.startMs, endMs: point.endMs, points: [point] }} label={`要点 ${after + index + 1}`} documentId={document.id} mediaVersionId={mediaVersionId} audioAvailable={audioAvailable} playbackBusy={playbackBusy} evidence={evidence} pointIndexes={[point.pointIndex]} onEvidence={() => { void loadEvidence(point); }} play={play} />)}
      {page ? <div className="transcript-navigation"><button type="button" disabled={busy || !history.length} onClick={() => void load(topicIndex, history.at(-1) ?? 0, history.slice(0, -1))}>上一页要点</button><span className="muted">{after + 1}–{after + page.points.length} / {page.totalPoints} 条</span><button type="button" disabled={busy || page.nextAfter === null} onClick={() => { if (page.nextAfter !== null) void load(topicIndex, page.nextAfter, [...history, after]); }}>下一页要点</button></div> : null}
    </section> : null}
  </section>;
}

export function SummariesPanel({ mediaVersionId, audioAvailable, playbackBusy, active, transcriptReady, play }: SummariesPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState<SummariesPage | null>(null);
  const [after, setAfter] = useState<number | null>(null);
  const [history, setHistory] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<EvidenceStates>({});
  const scope = useRef(0);
  const evidenceScope = useRef(0);
  const request = useRef<AbortController | null>(null);
  const action = useRef<AbortController | null>(null);
  const evidenceRequests = useRef(new Map<string, AbortController>());
  const panel = useRef<HTMLElement | null>(null);

  function abortEvidence(resetLoading = true): void {
    for (const controller of evidenceRequests.current.values()) controller.abort();
    evidenceRequests.current.clear();
    if (resetLoading) setEvidence(values => {
      let changed = false;
      const next = { ...values };
      for (const [key, state] of Object.entries(values)) {
        if (!state.loading) continue;
        next[key] = { ...state, loading: false };
        changed = true;
      }
      return changed ? next : values;
    });
  }

  useEffect(() => {
    ++scope.current; ++evidenceScope.current; request.current?.abort(); action.current?.abort(); action.current = null; abortEvidence();
    setPage(null); setAfter(null); setHistory([]); setError(''); setNotice(''); setRequestId(null); setEvidence({}); setBusy(false);
  }, [mediaVersionId]);

  useEffect(() => {
    if (expanded && active) return;
    ++scope.current; ++evidenceScope.current; request.current?.abort(); request.current = null; action.current?.abort(); action.current = null; abortEvidence(); setBusy(false);
  }, [expanded, active]);

  useEffect(() => {
    if (!expanded || !active) return;
    const current = ++scope.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tickRunning = false;
    const load = async () => {
      if (globalThis.document.hidden || action.current) return;
      request.current?.abort(); const controller = new AbortController(); request.current = controller; setBusy(true);
      const boundDocumentId = page?.document?.id ?? null;
      try {
        const params = new URLSearchParams({ capabilities: 'summary-topics-v1' });
        if (boundDocumentId) params.set('documentId', boundDocumentId);
        if (after !== null) params.set('after', String(after));
        const result = validatePage(await knowledgeApi<unknown>(`/api/media/${encodeURIComponent(mediaVersionId)}/summaries${params.size ? `?${params}` : ''}`, { signal: controller.signal }), mediaVersionId);
        if (scope.current !== current || controller.signal.aborted || request.current !== controller) return;
        if (boundDocumentId && (result.document?.id !== boundDocumentId || result.document.snapshot.transcriptJobId !== page?.document?.snapshot.transcriptJobId || result.document.snapshot.throughMs !== page?.document?.snapshot.throughMs)) throw new Error('总结文档已变化，请重新打开。');
        setPage(result); setError('');
      } catch (failure) {
        if (scope.current === current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : '总结读取失败，请重试。');
      } finally {
        if (request.current === controller) request.current = null;
        if (scope.current === current && !action.current) setBusy(false);
      }
    };
    const schedule = () => {
      if (timer || scope.current !== current || !expanded || !active || globalThis.document.hidden) return;
      timer = setTimeout(() => { timer = undefined; void tick(); }, 5000);
    };
    const tick = async () => {
      if (tickRunning) return;
      tickRunning = true;
      try { await load(); } finally { tickRunning = false; schedule(); }
    };
    const visibility = () => {
      if (globalThis.document.hidden) {
        if (timer) { clearTimeout(timer); timer = undefined; }
        request.current?.abort(); request.current = null; setBusy(false);
      } else void tick();
    };
    globalThis.document.addEventListener('visibilitychange', visibility); void tick();
    return () => { ++scope.current; clearTimeout(timer); request.current?.abort(); request.current = null; globalThis.document.removeEventListener('visibilitychange', visibility); };
  }, [after, active, expanded, mediaVersionId, page?.document?.id, page?.document?.status, revision]);

  useEffect(() => () => { ++evidenceScope.current; request.current?.abort(); action.current?.abort(); abortEvidence(false); }, []);

  async function mutate(input: Record<string, unknown>): Promise<void> {
    if (action.current || !expanded || !active || globalThis.document.hidden) return;
    request.current?.abort(); request.current = null;
    const controller = new AbortController(); action.current = controller; const current = scope.current;
    const boundDocumentId = page?.document?.id ?? null; setBusy(true); setError(''); setNotice('');
    try {
      const result = validatePage(await knowledgeApi<unknown>(`/api/media/${encodeURIComponent(mediaVersionId)}/summaries?capabilities=summary-topics-v1`, { method: 'POST', body: input, signal: controller.signal }), mediaVersionId);
      if (controller.signal.aborted || action.current !== controller || scope.current !== current) return;
      if (input.action !== 'generate' && boundDocumentId && (result.document?.id !== boundDocumentId || result.document.snapshot.transcriptJobId !== page?.document?.snapshot.transcriptJobId || result.document.snapshot.throughMs !== page?.document?.snapshot.throughMs)) throw new Error('总结文档已变化，请重新打开。');
      ++evidenceScope.current; abortEvidence();
      setPage(result); setAfter(null); setHistory([]); setExpanded(true); setEvidence({}); setRevision(value => value + 1);
      if (input.action === 'generate') setRequestId(null);
      setNotice(input.action === 'cancel' ? '总结生成已停止，已完成部分仍可阅读。' : input.action === 'retry' ? '总结已重新排队，已完成部分仍可阅读。' : '总结任务已提交，完成后会自动更新。');
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '总结操作失败，请重试。');
    } finally {
      if (action.current === controller) { action.current = null; if (!controller.signal.aborted) setBusy(false); }
    }
  }

  function generate(): void {
    if (busy || !transcriptReady || (page && !page.canGenerate) || action.current) return;
    const id = requestId ?? crypto.randomUUID(); setRequestId(id); void mutate({ action: 'generate', requestId: id });
  }

  function nextPage(): void {
    if (!page?.document || page.nextAfter === null) return;
    setHistory(values => [...values, after ?? 0]); setAfter(page.nextAfter);
  }

  function previousPage(): void {
    if (!history.length) return;
    setAfter(history.at(-1) ?? 0); setHistory(values => values.slice(0, -1));
  }

  function close(): void {
    ++scope.current; ++evidenceScope.current; request.current?.abort(); request.current = null; action.current?.abort(); action.current = null; abortEvidence(); setBusy(false); setExpanded(false);
  }

  async function loadEvidence(result: SummaryResult, pointIndex: number): Promise<void> {
    const documentId = page?.document?.id;
    if (!documentId || result.points[pointIndex]?.evidenceCount <= 0) return;
    const key = evidenceKey(result.id, pointIndex), existing = evidence[key];
    if (existing?.evidence) { setEvidence(values => ({ ...values, [key]: { ...existing, visible: !existing.visible } })); return; }
    if (evidenceRequests.current.has(key)) return;
    const controller = new AbortController(); evidenceRequests.current.set(key, controller);
    const current = evidenceScope.current; setEvidence(values => ({ ...values, [key]: { visible: true, loading: true } }));
    try {
      const params = new URLSearchParams({ documentId, nodeId: result.id, pointIndex: String(pointIndex) });
      const expectedSnapshot = page?.document?.snapshot;
      if (!expectedSnapshot) throw new Error('总结文档尚未准备好，请重试。');
      const value = validateEvidence(await knowledgeApi<unknown>(`/api/media/${encodeURIComponent(mediaVersionId)}/summaries/evidence?${params}`, { signal: controller.signal }), mediaVersionId, documentId, result.id, pointIndex, expectedSnapshot);
      if (controller.signal.aborted || evidenceScope.current !== current || evidenceRequests.current.get(key) !== controller) return;
      setEvidence(values => ({ ...values, [key]: { visible: true, loading: false, evidence: value } }));
    } catch (failure) {
      if (!controller.signal.aborted && evidenceScope.current === current) setEvidence(values => ({ ...values, [key]: { visible: true, loading: false, error: failure instanceof Error ? failure.message : '依据读取失败，请重试。' } }));
    } finally {
      if (evidenceRequests.current.get(key) === controller) {
        evidenceRequests.current.delete(key);
        setEvidence(values => {
          const state = values[key];
          return state?.loading ? { ...values, [key]: { ...state, loading: false } } : values;
        });
      }
    }
  }

  const summaryDocument = page?.document ?? null;
  const canRetry = summaryDocument?.status === 'failed' || summaryDocument?.status === 'cancelled';
  if (!expanded) return <div className="summaries-collapsed"><button type="button" className="text-button" onClick={() => setExpanded(true)}>分段与整期总结</button><span className="muted">按需整理已完成文稿</span></div>;
  return <section ref={panel} className="summaries-panel" aria-label="分段与整期总结">
    <div className="summaries-heading"><div><h2>分段与整期总结</h2><p className="muted">依据这期已完成文稿整理，原文依据可按点查看。</p></div><button type="button" className="text-button" onClick={close}>收起</button></div>
    {error ? <div><p className="error" role="alert">{error}</p><button type="button" disabled={busy} onClick={() => setRevision(value => value + 1)}>重试读取总结</button></div> : null}
    {notice ? <p className="muted" role="status">{notice}</p> : null}
    {!page ? <p className="muted">正在读取总结状态…</p> : <>
      {summaryDocument ? <div className="summary-status"><span>{statusLabel(summaryDocument.status)} · 已完成分段 {summaryDocument.completedParts}/{summaryDocument.totalParts} · 已完成任务 {summaryDocument.completedTasks}/{summaryDocument.totalTasks}</span>{summaryDocument.status === 'queued' || summaryDocument.status === 'running' ? <span className="muted">已完成部分可先阅读</span> : null}</div> : null}
      {!transcriptReady ? <p className="muted">整期文稿完成后才能生成总结，当前仍可阅读已完成内容。</p> : null}
      {page.canGenerate && transcriptReady ? <button type="button" disabled={busy} onClick={generate}>{summaryDocument ? '重新整理总结' : page.bridgeOnline ? '生成分段与整期总结' : '排队生成分段与整期总结'}</button> : null}
      {summaryDocument && page.canGenerate ? <p className="muted">可按主题重新完整整理，原总结记录保留。</p> : null}
      {!page.bridgeOnline && (page.canGenerate || summaryDocument?.status === 'queued' || summaryDocument?.status === 'running' || canRetry) ? <p className="muted">AI 服务暂时离线，提交后会排队等待连接恢复。</p> : null}
      {canRetry ? <div className="source-actions"><button type="button" disabled={busy} onClick={() => { if (summaryDocument) void mutate({ action: 'retry', documentId: summaryDocument.id }); }}>继续生成总结</button></div> : null}
      {summaryDocument?.status === 'queued' || summaryDocument?.status === 'running' ? <button type="button" className="text-button" disabled={busy} onClick={() => { if (summaryDocument) void mutate({ action: 'cancel', documentId: summaryDocument.id }); }}>停止生成</button> : null}
      {summaryDocument?.status === 'complete' && page.overview ? <section className="summary-overview" aria-label="整期总结"><SummaryResultView result={page.overview} label="整期总结" documentId={summaryDocument.id} mediaVersionId={mediaVersionId} audioAvailable={audioAvailable && page.audioAvailable} playbackBusy={playbackBusy} evidence={evidence} onEvidence={(result, pointIndex) => { void loadEvidence(result, pointIndex); }} play={play} /></section> : null}
      {summaryDocument?.status === 'complete' && page.topicOverview ? <SummaryTopicsView key={`${mediaVersionId}:${summaryDocument.id}:${revision}`} document={summaryDocument} overview={page.topicOverview} mediaVersionId={mediaVersionId} active={active} audioAvailable={audioAvailable && page.audioAvailable} playbackBusy={playbackBusy} play={play} /> : null}
      {page.parts.length ? <section className="summary-parts" aria-label="已完成分段"><h3>已完成分段</h3>{page.parts.map(part => <SummaryResultView key={part.id} result={part} label={`第 ${part.index + 1} 段`} documentId={summaryDocument?.id ?? ''} mediaVersionId={mediaVersionId} audioAvailable={audioAvailable && page.audioAvailable} playbackBusy={playbackBusy} evidence={evidence} onEvidence={(result, pointIndex) => { void loadEvidence(result, pointIndex); }} play={play} />)}</section> : summaryDocument && summaryDocument.status !== 'complete' ? <p className="muted">已完成的分段会在这里显示，未完成范围不会提前展示。</p> : summaryDocument?.status === 'complete' ? <p className="muted">暂无可显示的分段总结。</p> : null}
      {summaryDocument ? <div className="transcript-navigation"><button type="button" disabled={busy || !history.length} onClick={previousPage}>上一页</button><span className="muted">{page.nextAfter === null ? '已到分段末尾' : '还有更多已完成分段'}</span><button type="button" disabled={busy || page.nextAfter === null} onClick={nextPage}>下一页</button></div> : null}
    </>}
    {!audioAvailable ? <p className="muted">音频已清理，总结和原文依据仍可阅读。</p> : null}
  </section>;
}
