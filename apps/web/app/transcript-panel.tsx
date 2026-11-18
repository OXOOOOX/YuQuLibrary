'use client';

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Chapter, TranscriptPage, TranscriptSegment, TranscriptSearchPage, TranscriptSelectionSource } from '@yuqu/contracts';
import { knowledgeApi, time, type QuestionSelection } from './knowledge-ui';
import { ChaptersPanel } from './chapters-panel';
import { SummariesPanel } from './summaries-panel';

const labels = { queued: '等待转写', processing: '正在转写', ready: '整期文稿已完成', failed: '转写暂未完成' };
interface FrozenSelection { source: TranscriptSelectionSource; segments: TranscriptSegment[]; page: TranscriptPage; first: number; last: number }
function highlight(text: string, ranges: { start: number; end: number }[]): ReactNode[] {
  const result: ReactNode[] = []; let previous = 0;
  for (const range of ranges) {
    if (range.start < previous || range.end <= range.start || range.end > text.length) continue;
    result.push(text.slice(previous, range.start), <mark key={`${range.start}:${range.end}`}>{text.slice(range.start, range.end)}</mark>); previous = range.end;
  }
  result.push(text.slice(previous)); return result;
}

export function TranscriptPanel({ mediaVersionId, positionMs, positionAvailable, location, audioAvailable, playbackBusy, active, ask, play, saved }: {
  mediaVersionId: string; positionMs: number; positionAvailable: boolean; location: { positionMs: number; nonce: number } | null;
  audioAvailable: boolean; playbackBusy: boolean; active: boolean; ask: (selection: QuestionSelection) => void;
  play: (mediaId: string, startMs: number, endMs: number) => Promise<void>; saved: () => void;
}) {
  const [page, setPage] = useState<TranscriptPage | null>(null);
  const [cursor, setCursor] = useState(-1);
  const [atMs, setAtMs] = useState<number | null>(null);
  const [previous, setPrevious] = useState<number[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selection, setSelection] = useState<FrozenSelection | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<TranscriptSearchPage | null>(null);
  const [searching, setSearching] = useState(false);
  const [contextHit, setContextHit] = useState<TranscriptSegment | null>(null);
  const [chapterContext, setChapterContext] = useState<Chapter | null>(null);
  const [navigation, setNavigation] = useState(0);
  const contextList = useRef<HTMLOListElement | null>(null);
  const resultsList = useRef<HTMLOListElement | null>(null);
  const focusPending = useRef(false);
  const searchReturn = useRef<{ id: string; top: number } | null>(null);
  const restoreResult = useRef(false);
  const scope = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const searchRequest = useRef<AbortController | null>(null);
  const saveRequest = useRef<AbortController | null>(null);
  const saveIds = useRef(new Map<string, string>());
  const loadRef = useRef<(retry?: boolean) => Promise<void>>(async () => {});

  function jump(ms: number, hit?: TranscriptSegment, top = 0) {
    searchRequest.current?.abort(); setSearching(false);
    activeRequest.current?.abort(); activeRequest.current = null;
    setContextHit(hit ?? null); focusPending.current = !!hit;
    setChapterContext(null);
    searchReturn.current = hit ? { id: hit.id, top } : null; restoreResult.current = false;
    if (!hit) setSearch(null);
    setSelection(null); setPrevious([]); setAtMs(Math.max(0, Math.floor(ms))); setPage(null); setError('');
    setNavigation(value => value + 1);
  }
  function returnToSearch() {
    activeRequest.current?.abort(); activeRequest.current = null;
    setSelection(null); setContextHit(null); focusPending.current = false; restoreResult.current = true;
    setAtMs(null); setError(''); setNavigation(value => value + 1);
  }
  function returnToChapters() {
    setChapterContext(null); focusPending.current = false; setSelection(null); setError('');
  }
  function openChapter(chapter: Chapter) {
    searchRequest.current?.abort(); setSearching(false);
    activeRequest.current?.abort(); activeRequest.current = null;
    setSearch(null); setContextHit(null); searchReturn.current = null; restoreResult.current = false;
    setChapterContext(chapter); focusPending.current = true;
    setSelection(null); setPrevious([]); setAtMs(Math.max(0, Math.floor(chapter.startMs))); setPage(null); setError('');
    setNavigation(value => value + 1);
  }
  useEffect(() => {
    if ((contextHit || chapterContext) && page && focusPending.current) {
      const targetId = contextHit?.id ?? chapterContext?.startSegmentId;
      const target = Array.from(contextList.current?.children ?? []).find(element => (element as HTMLElement).dataset.segmentId === targetId) as HTMLElement | undefined;
      if (target && target.getClientRects().length) { focusPending.current = false; target.scrollIntoView({ block: 'center' }); target.focus({ preventScroll: true }); }
    } else if (!contextHit && search && restoreResult.current && searchReturn.current) {
      const saved = searchReturn.current;
      const target = Array.from(resultsList.current?.children ?? []).find(element => (element as HTMLElement).dataset.segmentId === saved.id) as HTMLElement | undefined;
      if (target && target.getClientRects().length) { restoreResult.current = false; window.scrollBy(0, target.getBoundingClientRect().top - saved.top); target.focus({ preventScroll: true }); }
    }
  }, [contextHit, chapterContext, page, search]);
  useEffect(() => { if (location) jump(location.positionMs); }, [location?.nonce]);
  useEffect(() => {
    const current = ++scope.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (retry = false) => {
      if (document.hidden || activeRequest.current) return;
      const controller = new AbortController(); activeRequest.current = controller; setBusy(true);
      try {
        const path = `/api/media/${encodeURIComponent(mediaVersionId)}/transcript`;
        const result = await knowledgeApi<TranscriptPage>(retry ? `${path}/retry` : `${path}?${atMs === null ? `after=${cursor}` : `at=${atMs}`}`, { method: retry ? 'POST' : 'GET', signal: controller.signal });
        if (scope.current !== current || controller.signal.aborted) return;
        if (result.mediaVersionId !== mediaVersionId || !Array.isArray(result.segments)) throw new Error('文稿响应无效，请重试。');
        setError('');
        if (retry) { setSelection(null); setAtMs(null); setPrevious([]); setCursor(-1); }
        if (atMs !== null) { setCursor(result.pageCursor); setAtMs(null); }
        setPage(result);
      } catch (failure) {
        if (scope.current === current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : '文稿读取失败，请稍后重试。');
      } finally { if (activeRequest.current === controller) activeRequest.current = null; if (scope.current === current) setBusy(false); }
    };
    loadRef.current = load;
    const tick = async () => { await load(); if (scope.current === current) timer = setTimeout(() => { void tick(); }, 5000); };
    const visibility = () => { if (document.hidden) activeRequest.current?.abort(); else void load(); };
    document.addEventListener('visibilitychange', visibility); void tick();
    return () => { ++scope.current; clearTimeout(timer); activeRequest.current?.abort(); activeRequest.current = null; loadRef.current = async () => {}; document.removeEventListener('visibilitychange', visibility); };
  }, [cursor, atMs, mediaVersionId, navigation]);
  useEffect(() => () => { searchRequest.current?.abort(); saveRequest.current?.abort(); }, []);

  function navigate(next: number, history: number[]) {
    focusPending.current = false;
    setChapterContext(null);
    setSelection(null); setPrevious(history); setAtMs(null); setCursor(next); setPage(null); setError('');
  }
  function select(index: number) {
    const shown = selection?.page ?? page;
    if (!shown?.job) return;
    if (selection && selection.first === index && selection.last === index) { setSelection(null); return; }
    const first = selection?.first ?? index;
    const left = Math.min(first, index), right = Math.max(first, index);
    if (right - left >= 32) { setError('一次最多选择 32 个连续片段，请缩小范围。'); return; }
    const segments = shown.segments.slice(left, right + 1);
    setSelection({ page: shown, first, last: index, segments, source: {
      kind: 'transcript-selection', transcriptJobId: shown.job.id, throughMs: shown.job.completedMs, segmentIds: segments.map(segment => segment.id)
    } }); setError(''); setNotice('');
  }
  function askSelection(source: TranscriptSelectionSource, segments: TranscriptSegment[]) {
    ask({ anchor: source, label: `已固定原文 ${time(segments[0].startMs)}–${time(segments.at(-1)!.endMs)}`, nonce: Date.now() });
  }
  async function save(source: TranscriptSelectionSource) {
    if (saveRequest.current) return;
    const sourceKey = JSON.stringify(source);
    const requestId = saveIds.current.get(sourceKey) ?? crypto.randomUUID(); saveIds.current.set(sourceKey, requestId);
    const controller = new AbortController(); saveRequest.current = controller;
    const identity = mediaVersionId; setSaving(true); setError('');
    try {
      await knowledgeApi('/api/saved-items', { signal: controller.signal, body: { requestId, mediaVersionId: identity, source } });
      if (controller.signal.aborted) return;
      setNotice('原文片段已收藏。'); saved();
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '收藏失败，请重试。'); }
    finally { if (saveRequest.current === controller) { saveRequest.current = null; if (!controller.signal.aborted) setSaving(false); } }
  }
  async function find(event?: FormEvent, next = false) {
    event?.preventDefault();
    const term = next && search ? search.query : query.trim();
    if (!term) { searchRequest.current?.abort(); setSearching(false); setSearch(null); return; }
    searchRequest.current?.abort(); const controller = new AbortController(); searchRequest.current = controller;
    if (!next) { setContextHit(null); setChapterContext(null); searchReturn.current = null; focusPending.current = false; restoreResult.current = false; }
    setSearching(true); setError('');
    try {
      const params = new URLSearchParams({ q: term }); if (next && search?.nextCursor) params.set('cursor', search.nextCursor);
      const result = await knowledgeApi<TranscriptSearchPage>(`/api/media/${encodeURIComponent(mediaVersionId)}/transcript/search?${params}`, { signal: controller.signal });
      if (!controller.signal.aborted && searchRequest.current === controller) {
        setSelection(null); setSearch(previous => next && previous ? { ...result, results: [...previous.results, ...result.results] } : result);
      }
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '搜索失败，请重试。'); }
    finally { if (searchRequest.current === controller) { searchRequest.current = null; setSearching(false); } }
  }
  const shown = selection?.page ?? page, job = page?.job;
  return <section className="transcript-panel" aria-label="文稿与搜索"><div className="transcript-content">
    <div className="transcript-heading"><p role="status" data-testid="transcript-status">{page ? job ? labels[job.status] : '验证音频不提供文稿' : '正在读取文稿…'}</p>
      <button className="text-button" disabled={busy || !positionAvailable} onClick={() => jump(positionMs)}>当前附近</button></div>
    {job ? <p className="muted">文稿已到 {time(job.completedMs)} / {time(job.durationMs)} · {job.status === 'ready' ? '可选择整期提问' : '整期提问等待转写完成'} · 自动转写，内容可能有误</p> : null}
    <form className="search-form" onSubmit={event => { void find(event); }}><label className="field"><span>搜索本集已完成文稿</span><input aria-label="搜索文稿" value={query} maxLength={100} onChange={event => setQuery(event.target.value)} placeholder="输入关键词，如：长期主义" /></label>
      <button type="submit" disabled={searching || !query.trim() || !job?.completedMs}>{searching ? '搜索中…' : '搜索'}</button>{search && !contextHit ? <button type="button" onClick={() => { searchRequest.current?.abort(); setSearching(false); setSearch(null); searchReturn.current = null; }}>返回文稿</button> : null}</form>
    {error ? <p className="error" role="alert">{error}</p> : null}{notice ? <p className="muted" role="status">{notice}</p> : null}
    {job?.error ? <p className="error">{job.error}</p> : null}{job?.status === 'failed' ? <button disabled={busy} onClick={() => { void loadRef.current(true); }}>重试转写</button> : null}
    <ChaptersPanel mediaVersionId={mediaVersionId} audioAvailable={audioAvailable} contextOpen={chapterContext !== null}
      onViewChapter={openChapter} onPlayChapter={chapter => { void play(mediaVersionId, chapter.startMs, chapter.endMs); }} />
    <SummariesPanel mediaVersionId={mediaVersionId} audioAvailable={audioAvailable} playbackBusy={playbackBusy} active={active}
      transcriptReady={job?.status === 'ready' && job.completedMs === job.durationMs} play={play} />
    {contextHit && search ? <div className="search-context-heading"><div><strong>查看 {time(contextHit.startMs)} 附近的上下文</strong><p className="muted">这里显示当前文稿，搜索结果与已固定的原文仍保留。</p></div><button onClick={returnToSearch}>返回搜索结果</button>
      {page && !busy && !error && !page.segments.some(segment => segment.id === contextHit.id) ? <p role="status">当前页未找到原命中片段，可返回搜索结果查看保存时的原文。</p> : null}</div> : null}
    {chapterContext ? <div className="search-context-heading"><div><strong>查看章节：{chapterContext.title}</strong><p className="muted">已定位到章节起点，章节目录和原文范围保持不变。</p></div><button type="button" onClick={returnToChapters}>返回章节目录</button>
      {page && !busy && !error && !page.segments.some(segment => segment.id === chapterContext.startSegmentId) ? <p role="status">当前页未找到章节起点，可稍后重试读取文稿。</p> : null}</div> : null}
    {search && !contextHit ? <section aria-label="文稿搜索结果"><p className="muted">“{search.query}” · 已显示 {search.results.length} 处 · 搜索范围截至 {time(search.snapshot.throughMs)}{search.partial ? '，转写仍在继续' : ''}</p>
      {!search.results.length ? <p className="muted">这部分文稿中没有找到关键词。</p> : <ol className="search-results" ref={resultsList}>{search.results.map(segment => {
        const source: TranscriptSelectionSource = { kind: 'transcript-selection', ...search.snapshot, segmentIds: [segment.id] };
        return <li key={segment.id} data-segment-id={segment.id} tabIndex={-1}><span className="transcript-time">{time(segment.startMs)}–{time(segment.endMs)}</span><p>{highlight(segment.text, segment.highlights)}</p>
          <div className="source-actions"><button className="text-button" onClick={event => jump(segment.startMs, segment, event.currentTarget.closest('li')?.getBoundingClientRect().top ?? 0)}>查看上下文</button><button className="text-button" onClick={() => askSelection(source, [segment])}>问这段</button>
            <button className="text-button" disabled={playbackBusy || !audioAvailable} onClick={() => { void play(mediaVersionId, segment.startMs, segment.endMs); }}>回听</button><button className="text-button" disabled={saving} onClick={() => { void save(source); }}>收藏</button></div></li>;
      })}</ol>}{search.nextCursor ? <button disabled={searching} onClick={() => { void find(undefined, true); }}>更多结果</button> : null}</section> : <>
      {selection ? <div className="selection-bar"><span>已固定 {selection.segments.length} 个片段 · {time(selection.segments[0].startMs)}–{time(selection.segments.at(-1)!.endMs)}</span>
        <div className="source-actions"><button onClick={() => askSelection(selection.source, selection.segments)}>问这段</button><button disabled={saving} onClick={() => { void save(selection.source); }}>收藏片段</button><button className="text-button" onClick={() => setSelection(null)}>取消选择</button></div>
        <small>原文已固定，后续转写不会改变此次选择。</small></div> : shown?.segments.length ? <p className="muted">点选起止片段，可连续选择原文进行提问或收藏。</p> : null}
      {shown?.segments.length ? <ol ref={contextList} className="transcript-segments" aria-label="当前文稿片段">{shown.segments.map((segment, index) => <li key={segment.id} data-segment-id={segment.id} tabIndex={-1} className={`${selection?.segments.some(item => item.id === segment.id) ? 'selected-segment' : ''} ${contextHit?.id === segment.id || chapterContext?.startSegmentId === segment.id ? 'context-hit' : ''}`}>
        <label className="segment-selector"><input type="checkbox" aria-label={`选择 ${time(segment.startMs)} 的片段`} checked={selection?.segments.some(item => item.id === segment.id) ?? false} onChange={() => select(index)} /><span className="transcript-time">{time(segment.startMs)}–{time(segment.endMs)}</span></label>
        <p>{contextHit?.id === segment.id ? <small className="context-hit-label">搜索命中</small> : chapterContext?.startSegmentId === segment.id ? <small className="context-hit-label">章节起点</small> : null}{segment.text}</p></li>)}</ol> : page && job ? <p className="muted">这一页暂时没有文稿，可查看前后文或等待转写。</p> : null}
      {page && job ? <div className="transcript-navigation"><button disabled={busy || (cursor === -1 && !previous.length)} onClick={() => navigate(previous.at(-1) ?? Math.max(-1, cursor - 5), previous.slice(0, -1))}>上一段</button>
        <span className="muted">从 {time(Math.max(0, cursor + 1) * 30000)} 开始{busy ? ' · 更新中' : ''}</span><button disabled={busy || page.nextCursor === null} onClick={() => { if (page.nextCursor !== null) navigate(page.nextCursor, [...previous, cursor]); }}>下一段</button></div> : null}
    </>}
    {!audioAvailable ? <p className="muted">音频已清理，文稿、提问和收藏仍可使用。</p> : null}
  </div></section>;
}
