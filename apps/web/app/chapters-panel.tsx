'use client';

import { useEffect, useRef, useState } from 'react';
import type { Chapter, ChapterDocument, ChaptersPage } from '@yuqu/contracts';
import { knowledgeApi, time } from './knowledge-ui';

function statusLabel(status: ChapterDocument['status']): string {
  return ({ queued: '等待整理', running: '正在整理', complete: '章节已完成', failed: '整理失败', cancelled: '已停止' } as const)[status];
}

export interface ChaptersPanelProps {
  mediaVersionId: string;
  audioAvailable: boolean;
  contextOpen: boolean;
  onViewChapter: (chapter: Chapter) => void;
  onPlayChapter: (chapter: Chapter) => void;
}

export function ChaptersPanel({ mediaVersionId, audioAvailable, contextOpen, onViewChapter, onPlayChapter }: ChaptersPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState<ChaptersPage | null>(null);
  const [after, setAfter] = useState<number | null>(null);
  const [history, setHistory] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const [requestId, setRequestId] = useState<string | null>(null);
  const scope = useRef(0);
  const request = useRef<AbortController | null>(null);
  const action = useRef<AbortController | null>(null);
  const list = useRef<HTMLOListElement | null>(null);
  const returnPosition = useRef<{ id: string; top: number } | null>(null);
  const restorePosition = useRef(false);
  const panel = useRef<HTMLElement | null>(null);
  const focusPage = useRef(false);

  useEffect(() => {
    if (page && focusPage.current) { focusPage.current = false; panel.current?.scrollIntoView({ block: 'start' }); }
  }, [page]);

  useEffect(() => {
    if (contextOpen || !restorePosition.current || !returnPosition.current) return;
    const saved = returnPosition.current;
    const target = Array.from(list.current?.children ?? []).find(element => (element as HTMLElement).dataset.chapterId === saved.id) as HTMLElement | undefined;
    if (target) { restorePosition.current = false; window.scrollBy(0, target.getBoundingClientRect().top - saved.top); target.focus({ preventScroll: true }); }
  }, [contextOpen, page]);

  useEffect(() => {
    setPage(null); setAfter(null); setHistory([]); setError(''); setNotice(''); setRequestId(null);
  }, [mediaVersionId]);

  useEffect(() => {
    if (!expanded || contextOpen) return;
    const current = ++scope.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (document.hidden || action.current) return;
      request.current?.abort(); const controller = new AbortController(); request.current = controller; setBusy(true);
      try {
        const params = new URLSearchParams();
        if (page?.document?.id) params.set('documentId', page.document.id);
        if (after !== null) params.set('after', String(after));
        const result = await knowledgeApi<ChaptersPage>(`/api/media/${encodeURIComponent(mediaVersionId)}/chapters${params.size ? `?${params}` : ''}`, { signal: controller.signal });
        if (scope.current !== current || controller.signal.aborted || request.current !== controller) return;
        if (result.mediaVersionId !== mediaVersionId || !Array.isArray(result.chapters)) throw new Error('章节响应无效，请重试。');
        setPage(result); setError('');
        if (result.document?.status === 'complete' || result.document?.status === 'failed' || result.document?.status === 'cancelled') setRequestId(null);
      } catch (failure) {
        if (scope.current === current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : '章节读取失败，请重试。');
      } finally {
        if (request.current === controller) request.current = null;
        if (scope.current === current && !action.current) setBusy(false);
      }
    };
    const tick = async () => { await load(); if (scope.current === current) timer = setTimeout(() => { void tick(); }, 5000); };
    const visibility = () => { if (document.hidden) request.current?.abort(); else void load(); };
    document.addEventListener('visibilitychange', visibility);
    void tick();
    return () => { ++scope.current; clearTimeout(timer); request.current?.abort(); request.current = null; document.removeEventListener('visibilitychange', visibility); };
  }, [after, expanded, contextOpen, mediaVersionId, revision, page?.document?.id, page?.document?.status]);

  useEffect(() => () => { request.current?.abort(); action.current?.abort(); }, []);

  async function mutate(input: Record<string, unknown>): Promise<void> {
    if (action.current) return;
    request.current?.abort(); request.current = null;
    const controller = new AbortController(); action.current = controller; setBusy(true); setError(''); setNotice('');
    try {
      const result = await knowledgeApi<ChaptersPage>(`/api/media/${encodeURIComponent(mediaVersionId)}/chapters`, { method: 'POST', body: input, signal: controller.signal });
      if (controller.signal.aborted || action.current !== controller) return;
      setPage(result); setAfter(null); setHistory([]); setExpanded(true); setNotice(input.action === 'cancel' ? '章节整理已停止。' : '章节任务已提交，完成后会自动更新。');
      setRevision(value => value + 1);
      if (result.document) setRequestId(null);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '章节操作失败，请重试。');
    } finally {
      if (action.current === controller) { action.current = null; if (!controller.signal.aborted) setBusy(false); }
    }
  }
  function generate(): void {
    const id = requestId ?? crypto.randomUUID(); setRequestId(id); void mutate({ action: 'generate', requestId: id });
  }
  function nextPage(): void {
    if (!page?.nextAfter || !page.document) return;
    focusPage.current = true;
    setHistory(values => [...values, after ?? 0]); setAfter(page.nextAfter);
  }
  function previousPage(): void {
    if (!history.length) return;
    focusPage.current = true;
    setAfter(history.at(-1) ?? 0); setHistory(values => values.slice(0, -1));
  }
  function close(): void {
    action.current?.abort(); action.current = null; setBusy(false); setExpanded(false);
  }
  function viewChapter(chapter: Chapter, top: number): void {
    returnPosition.current = { id: chapter.id, top }; restorePosition.current = true; onViewChapter(chapter);
  }
  if (!expanded) {
    return <div className="chapters-collapsed"><button type="button" className="text-button" onClick={() => setExpanded(true)}>章节导航</button><span className="muted">按需整理长节目主题</span></div>;
  }
  if (contextOpen) return null;
  const chapterDocument = page?.document ?? null;
  const canRetry = chapterDocument?.status === 'failed' || chapterDocument?.status === 'cancelled';
  return <section ref={panel} className="chapters-panel" aria-label="章节导航">
    <div className="chapters-heading"><div><h2>章节导航</h2><p className="muted">AI 依据已完成文稿整理，章节时间来自原文片段。</p></div><button type="button" className="text-button" onClick={close}>收起</button></div>
    {error ? <div><p className="error" role="alert">{error}</p><button type="button" disabled={busy} onClick={() => setRevision(value => value + 1)}>重试读取章节</button></div> : null}{notice ? <p className="muted" role="status">{notice}</p> : null}
    {!page ? <p className="muted">正在读取章节状态…</p> : <>
      {chapterDocument ? <div className="chapters-status"><span>{statusLabel(chapterDocument.status)} · {chapterDocument.completedBatches}/{chapterDocument.totalBatches} 批</span>{chapterDocument.status === 'running' || chapterDocument.status === 'queued' ? <span className="muted">已完成部分可以先查看</span> : null}</div> : null}
      {!chapterDocument && !page.canGenerate ? <p className="muted">整期文稿完成后才能整理章节；当前仍可按片段阅读。</p> : null}
      {page.canGenerate && !chapterDocument ? <button type="button" disabled={busy || !page.bridgeOnline} onClick={generate}>{page.bridgeOnline ? '生成章节' : '章节服务暂时离线'}</button> : null}
      {canRetry ? <div className="source-actions"><button type="button" disabled={busy || !page.bridgeOnline} onClick={() => { if (chapterDocument) void mutate({ action: 'retry', documentId: chapterDocument.id }); }}>{page.bridgeOnline ? '重试章节整理' : '章节服务暂时离线'}</button>{chapterDocument?.status === 'failed' ? <button type="button" className="text-button" disabled={busy} onClick={() => { if (chapterDocument) void mutate({ action: 'cancel', documentId: chapterDocument.id }); }}>停止</button> : null}</div> : null}
      {chapterDocument?.status === 'queued' || chapterDocument?.status === 'running' ? <button type="button" className="text-button" disabled={busy} onClick={() => { if (chapterDocument) void mutate({ action: 'cancel', documentId: chapterDocument.id }); }}>停止整理</button> : null}
      {page.chapters.length ? <ol ref={list} className="chapter-list">{page.chapters.map(chapter => <li key={chapter.id} data-chapter-id={chapter.id} tabIndex={-1} className="chapter-item"><div><strong>{chapter.title}</strong><span className="muted">{time(chapter.startMs)}–{time(chapter.endMs)}</span></div><div className="source-actions"><button type="button" className="text-button" onClick={event => viewChapter(chapter, event.currentTarget.closest('li')!.getBoundingClientRect().top)}>查看文稿</button><button type="button" className="text-button" disabled={!audioAvailable || busy || chapter.endMs <= chapter.startMs} onClick={() => onPlayChapter(chapter)}>{!audioAvailable ? '音频已清理' : chapter.endMs > chapter.startMs ? '播放本章' : '无可播放时长'}</button></div></li>)}</ol> : chapterDocument?.status === 'complete' ? <p className="muted">暂时没有可显示的章节。</p> : null}
      {page.document ? <div className="transcript-navigation"><button type="button" disabled={busy || !history.length} onClick={previousPage}>上一页</button><span className="muted">{page.nextAfter ? '还有更多章节' : '已到章节末尾'}</span><button type="button" disabled={busy || page.nextAfter === null} onClick={nextPage}>下一页</button></div> : null}
    </>}
  </section>;
}
