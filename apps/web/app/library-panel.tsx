'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { LibraryItem, StorageUsage } from '@yuqu/contracts';

interface ImportJob {
  id: string; title: string; sourceUrl: string; status: 'queued' | 'downloading' | 'ready' | 'failed';
  attempts: number; error: string | null; mediaVersionId: string | null; createdAt: string;
}
interface FeedPreview { kind: 'audio' | 'rss' | 'bilibili'; title: string; episodes: { url: string; title: string }[] }
const stateLabel = { queued: '等待处理', downloading: '正在下载', ready: '已可播放', failed: '导入失败' };

async function api<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message || '资料暂时无法加载，请稍后重试。');
  return value as T;
}
const readable = (error: unknown) => error instanceof Error && error.name !== 'AbortError' ? error.message : '请求未完成，请稍后重试。';
const minutes = (durationMs: number) => `${Math.floor(durationMs / 60000)}:${Math.floor(durationMs / 1000 % 60).toString().padStart(2, '0')}`;
const bytes = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GiB` : `${(value / 1024 ** 2).toFixed(1)} MiB`;

/** Mounted with the authenticated session id as its React key. */
export function LibraryPanel({ currentMediaId, playbackBusy, play, read, removed, visible }: {
  currentMediaId?: string; playbackBusy: boolean; play: (mediaId: string) => Promise<void>;
  read: (item: LibraryItem) => void; removed: (mediaId: string, mode: 'audio' | 'all') => Promise<void>;
  visible: boolean;
}) {
  const open = visible;
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [preview, setPreview] = useState<FeedPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const scope = useRef(0);
  const poll = useRef<AbortController | null>(null);
  const action = useRef<AbortController | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    const currentScope = ++scope.current;
    if (!open) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let requestId = 0;
    const refresh = async () => {
      const id = ++requestId; poll.current?.abort();
      const controller = new AbortController(); poll.current = controller;
      const outcomes = await Promise.allSettled([
        api<{ items: LibraryItem[]; usage: StorageUsage }>('/api/library', controller.signal),
        api<{ jobs: ImportJob[] }>('/api/imports', controller.signal)
      ]);
      if (scope.current !== currentScope || id !== requestId || controller.signal.aborted) return;
      const [library, imports] = outcomes;
      if (library.status === 'fulfilled') { setItems(library.value.items); setUsage(library.value.usage); }
      if (imports.status === 'fulfilled') setJobs(imports.value.jobs);
      const failure = outcomes.find(value => value.status === 'rejected');
      if (failure?.status === 'rejected') setError(readable(failure.reason));
      setLoading(false);
    };
    refreshRef.current = refresh;
    const tick = async () => { await refresh(); if (scope.current === currentScope) timer = setTimeout(() => { void tick(); }, 3000); };
    setLoading(true); void tick();
    return () => {
      ++scope.current; clearTimeout(timer); poll.current?.abort(); action.current?.abort();
      poll.current = null; action.current = null; refreshRef.current = async () => {};
      setBusy(false); setLoading(false);
    };
  }, [open]);

  async function perform<T>(path: string, body: unknown, complete: (value: T) => void | Promise<void>) {
    if (action.current || !open) return;
    const currentScope = scope.current;
    const controller = new AbortController(); action.current = controller;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api<T>(path, controller.signal, body);
      if (scope.current !== currentScope || controller.signal.aborted) return;
      await complete(result); await refreshRef.current();
    } catch (error) {
      if (scope.current === currentScope && !controller.signal.aborted) setError(readable(error));
    } finally {
      if (scope.current === currentScope && action.current === controller) { action.current = null; setBusy(false); }
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPreview(null);
    await perform<FeedPreview>('/api/imports/preview', { kind: 'auto', url: url.trim() }, result => {
      setPreview(result); if (!result.episodes.length) setNotice('这个链接中没有可导入的内容。');
    });
  }
  async function importAudio(sourceUrl: string, title: string) {
    await perform<{ job: ImportJob }>('/api/imports', { url: sourceUrl, ...(title ? { title } : {}) }, result => {
      setNotice(result.job.status === 'ready' ? '这项内容已在资料库，可以开始播放。' : '已加入导入任务，可以继续浏览，完成后会出现在资料库。');
    });
  }
  async function retry(id: string) {
    await perform<{ job: ImportJob }>(`/api/imports/${encodeURIComponent(id)}/retry`, {}, () => setNotice('已重新加入导入队列。'));
  }
  async function remove(item: LibraryItem, mode: 'audio' | 'all') {
    const description = mode === 'audio'
      ? '清理音频后将不能回听，文稿、聊天、收藏和备注会保留。正在播放的设备会停止播放。仅已完成转写的资料可清理音频。'
      : '将永久删除音频、文稿、聊天记录及本集的收藏和备注，正在处理的任务和播放也会停止。此操作无法撤销。';
    if (!window.confirm(`「${item.title}」\n${description}\n确定继续吗？`)) return;
    await perform(`/api/library/${encodeURIComponent(item.mediaVersionId)}/remove`, { mode }, async () => {
      await removed(item.mediaVersionId, mode);
      setNotice(mode === 'audio' ? '文稿和聊天已保留，音频正在后台回收空间。' : '整期资料已删除，文件正在后台回收空间。');
    });
  }
  async function removeJob(job: ImportJob) {
    if (!window.confirm(`删除「${job.title || '音频导入'}」的导入任务？此操作无法撤销。`)) return;
    await perform(`/api/imports/${encodeURIComponent(job.id)}/remove`, {}, () => setNotice('导入任务已删除。'));
  }

  return <section className="library-panel" aria-label="资料库与导入">
    <h2>资料库与导入</h2>
    <div className="library-content">
      {usage ? <div className="storage-usage" aria-label="资料容量">
        <span>音频 {bytes(usage.usedBytes)} / {bytes(usage.limitBytes)} · 资料 {usage.itemCount}/{usage.itemLimit}</span>
        <meter min={0} max={usage.limitBytes} value={Math.min(usage.limitBytes, usage.usedBytes + usage.reservedBytes + usage.reclaimingBytes)} aria-label="容量占用" />
        {usage.reservedBytes || usage.reclaimingBytes ? <span className="muted">下载预留 {bytes(usage.reservedBytes)} · 待回收 {bytes(usage.reclaimingBytes)}</span> : null}
      </div> : null}
      <form className="import-form" onSubmit={event => { void submit(event); }}>
        <label className="field"><span>粘贴音频、播客 RSS 或 B 站链接</span>
          <input type="text" inputMode="url" aria-label="导入链接" required maxLength={2048} placeholder="https://…" value={url} disabled={busy}
            onChange={event => { setUrl(event.target.value); setPreview(null); setError(''); setNotice(''); }} /></label>
        {preview?.kind === 'audio' ? <label className="field"><span>标题（可选）</span><input aria-label="音频标题" maxLength={240} value={title} disabled={busy} onChange={event => setTitle(event.target.value)} /></label> : null}
        <button type="submit" className="primary" disabled={busy || !url.trim()}>{busy ? '正在识别…' : '识别并预览'}</button>
        <p className="muted">支持公开 B 站视频音轨、RSS 和 MP3、M4A、AAC、WAV；每集最多 100 MB、4 小时。下载后可收听，文稿自动转写。B 站支持完整 BV 链接和 b23.tv 短链接。</p>
      </form>
      {notice ? <p role="status" className="muted">{notice}</p> : null}
      {error ? <p role="alert" className="error">{error}</p> : null}
      {preview ? <section aria-label="可导入内容"><h2>{preview.title || '内容列表'}</h2><ul className="library-list rss-list">
        {preview.episodes.map((episode, index) => <li key={`${index}:${episode.url}`}><span className="item-title">{episode.title}</span>
          <button disabled={busy} onClick={() => { void importAudio(episode.url, preview.kind === 'audio' && title.trim() ? title.trim() : episode.title); }} aria-label={`导入 ${episode.title}`}>确认导入</button></li>)}
      </ul></section> : null}
      <section aria-label="我的资料"><h2>我的资料</h2>
        {loading && !items.length ? <p className="muted">正在读取资料…</p> : !items.length ? <p className="muted">导入完成的音频会出现在这里。</p> : <ul className="library-list">
          {items.map(item => <li key={item.mediaVersionId}><div className="item-copy"><span className="item-title">{item.title}</span>
            <span className="muted">{minutes(item.durationMs)} · {item.audioAvailable ? `音频可听 · ${bytes(item.byteSize)}` : '音频已清理，文稿保留'}{currentMediaId === item.mediaVersionId ? ' · 当前内容' : ''}</span>
            {item.transcript ? <span className="muted">{item.transcript.status === 'ready' ? '整期文稿已完成' : `文稿已到 ${minutes(item.transcript.completedMs)} · ${item.transcript.status === 'failed' ? '转写中断，可进入文稿重试' : '整期提问等待完成'}`}</span> : null}</div>
            <div className="library-actions">
              {item.audioAvailable ? <button disabled={playbackBusy || busy} onClick={() => { void play(item.mediaVersionId); }} aria-label={`播放 ${item.title}`}>播放</button> : null}
              <button disabled={busy} onClick={() => read(item)} aria-label={`查看文稿 ${item.title}`}>查看文稿</button>
              {item.deletable ? <details className="item-manage"><summary>管理</summary><div>
                {item.audioAvailable ? <button disabled={busy} onClick={() => { void remove(item, 'audio'); }}>清理音频</button> : null}
                <button disabled={busy} onClick={() => { void remove(item, 'all'); }}>删除整期资料</button>
              </div></details> : null}
            </div></li>)}
        </ul>}
      </section>
      {jobs.length ? <section aria-label="导入任务"><h2>导入任务</h2><ul className="library-list">
        {jobs.map(job => <li key={job.id}><div className="item-copy"><span className="item-title">{job.title || '音频导入'}</span>
          <span className="muted">{stateLabel[job.status]}</span>{job.error ? <span className="error">{job.error}</span> : null}</div>
          {job.status === 'failed' && job.attempts < 3 ? <button disabled={busy} onClick={() => { void retry(job.id); }} aria-label={`重试 ${job.title || '音频导入'}`}>重试</button> : null}
          {job.status === 'queued' || job.status === 'failed' ? <button disabled={busy} onClick={() => { void removeJob(job); }} aria-label={`删除导入 ${job.title || '音频导入'}`}>删除任务</button> : null}
        </li>)}
      </ul></section> : null}
    </div>
  </section>;
}
