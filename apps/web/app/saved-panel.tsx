'use client';

import { useEffect, useRef, useState } from 'react';
import type { SavedItem, SavedItemsPage } from '@yuqu/contracts';
import { knowledgeApi, time, type SourceLocation } from './knowledge-ui';

interface NoteDraft { item: SavedItem; note: string }
interface MutationState { id: string; operation: 'save' | 'delete' }

function SavedCard({ item, playbackBusy, play, locate, editing, note, busy, mutating, error, onEdit, onNoteChange, onSave, onCancel, onDelete }: {
  item: SavedItem; playbackBusy: boolean; play: (mediaId: string, startMs: number, endMs: number) => Promise<void>;
  locate: (source: SourceLocation) => void; editing: boolean; note: string; busy: boolean; mutating: boolean; error: string;
  onEdit: () => void; onNoteChange: (value: string) => void; onSave: () => void; onCancel: () => void; onDelete: () => void;
}) {
  const source = item.content.segments[0] ?? item.content.citations[0];
  return <article className="saved-card">
    <div className="saved-heading"><strong>{item.mediaTitle}</strong><span className="muted">{item.kind === 'answer' ? '回答' : '原文'} · {source ? time(source.startMs) : '整期'}</span></div>
    {item.content.question ? <p className="saved-question">{item.content.question}</p> : null}
    <p className="saved-text">{item.content.text}</p>
    {item.content.citations.length ? <details><summary>查看保存时的引用（{item.content.citations.length}）</summary>
      {item.content.citations.map(citation => <blockquote key={`${item.id}:${citation.id}`}><span className="muted">[{citation.id}] {time(citation.startMs)}–{time(citation.endMs)}</span><p>{citation.text}</p>
        <button className="text-button" disabled={playbackBusy || !item.audioAvailable} onClick={() => { void play(item.mediaVersionId, citation.startMs, citation.endMs); }}>回听这一段</button></blockquote>)}</details> : null}
    {editing ? <form className="note-form" onSubmit={event => { event.preventDefault(); onSave(); }}><label className="field"><span>我的备注</span><textarea aria-label={`备注 ${item.mediaTitle}`} value={note} maxLength={4000} onChange={event => onNoteChange(event.target.value)} disabled={busy} rows={3} /></label>
      <div className="source-actions"><button type="submit" disabled={mutating}>保存备注</button><button type="button" className="text-button" disabled={mutating} onClick={onCancel}>取消</button></div></form> : item.note ? <p className="saved-note">我的备注：{item.note}</p> : null}
    <div className="source-actions"><button className="text-button" onClick={() => locate({ mediaVersionId: item.mediaVersionId, title: item.mediaTitle, positionMs: source?.startMs ?? 0, nonce: Date.now(), audioAvailable: item.audioAvailable })}>回到来源</button>
      {item.kind === 'excerpt' && source ? <button className="text-button" disabled={playbackBusy || !item.audioAvailable} onClick={() => { void play(item.mediaVersionId, source.startMs, item.content.segments.at(-1)?.endMs ?? source.endMs); }}>回听片段</button> : null}
      <button className="text-button" disabled={busy} onClick={onEdit}>编辑备注</button><button className="text-button" disabled={busy} onClick={onDelete}>删除收藏</button></div>
    {!item.audioAvailable ? <p className="muted">音频已清理，保存的内容仍可阅读。</p> : null}{error ? <p className="error" role="alert">{error}</p> : null}
  </article>;
}

export function SavedPanel({ currentMediaId, refreshToken, enabled, playbackBusy, play, locate }: {
  currentMediaId?: string; refreshToken: number; enabled: boolean; playbackBusy: boolean;
  play: (mediaId: string, startMs: number, endMs: number) => Promise<void>; locate: (source: SourceLocation) => void;
}) {
  const [onlyCurrent, setOnlyCurrent] = useState(false);
  const [page, setPage] = useState<SavedItemsPage | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<(string | null)[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [mutation, setMutation] = useState<MutationState | null>(null);
  const [mutationError, setMutationError] = useState<{ id: string; message: string } | null>(null);
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const mutationVersion = useRef(0);
  const mediaId = onlyCurrent ? currentMediaId : undefined;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort(); }; }, []);
  useEffect(() => { setCursor(null); setPrevious([]); setPage(null); }, [mediaId]);
  useEffect(() => {
    if (!enabled) return;
    const epoch = ++generation.current; let request: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (document.hidden) return;
      request?.abort(); const controller = new AbortController(); request = controller; setBusy(true);
      const version = mutationVersion.current;
      try {
        const params = new URLSearchParams(); if (mediaId) params.set('mediaVersionId', mediaId); if (cursor) params.set('cursor', cursor);
        const result = await knowledgeApi<SavedItemsPage>(`/api/saved-items?${params}`, { signal: controller.signal });
        if (epoch === generation.current && version === mutationVersion.current && !controller.signal.aborted) { setPage(result); setError(''); }
      } catch (failure) {
        if (epoch === generation.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : '收藏读取失败，请重试。');
      } finally { if (epoch === generation.current) setBusy(false); }
    };
    const tick = async () => { await load(); if (epoch === generation.current) timer = setTimeout(() => { void tick(); }, 5000); };
    void tick();
    return () => { ++generation.current; request?.abort(); clearTimeout(timer); };
  }, [mediaId, cursor, enabled, refreshToken, revision]);
  function beginEdit(item: SavedItem): void {
    if (draft && draft.item.id !== item.id) { setNotice('请先保存或取消当前备注，再编辑另一条收藏。'); return; }
    setNotice(''); setMutationError(null);
    setDraft(current => current?.item.id === item.id ? current : { item, note: item.note });
  }
  function cancelEdit(): void { if (!mutation) { setDraft(null); setMutationError(null); setNotice(''); } }
  async function saveDraft(): Promise<void> {
    const current = draft;
    if (!current || request.current) return;
    const controller = new AbortController(); request.current = controller; setMutation({ id: current.item.id, operation: 'save' }); setMutationError(null); setNotice('');
    mutationVersion.current++;
    try {
      const updated = await knowledgeApi<SavedItem>(`/api/saved-items/${encodeURIComponent(current.item.id)}`, { signal: controller.signal, method: 'PATCH', body: { note: current.note } });
      if (!mounted.current || controller.signal.aborted) return;
      mutationVersion.current++;
      setPage(value => value ? { ...value, items: value.items.map(item => item.id === updated.id ? updated : item) } : value);
      setDraft(null); setMutationError(null); setRevision(value => value + 1);
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) setMutationError({ id: current.item.id, message: failure instanceof Error ? failure.message : '收藏更新失败，请重试。' });
    } finally {
      if (request.current === controller) { request.current = null; if (mounted.current) setMutation(null); }
    }
  }
  async function deleteItem(item: SavedItem): Promise<void> {
    if (request.current || !window.confirm('删除这条收藏和备注？原文与聊天记录会保留。')) return;
    const controller = new AbortController(); request.current = controller; setMutation({ id: item.id, operation: 'delete' }); setMutationError(null); setNotice('');
    mutationVersion.current++;
    try {
      await knowledgeApi(`/api/saved-items/${encodeURIComponent(item.id)}`, { signal: controller.signal, method: 'DELETE' });
      if (!mounted.current || controller.signal.aborted) return;
      mutationVersion.current++;
      setDraft(current => current?.item.id === item.id ? null : current);
      setPage(current => current ? { ...current, items: current.items.filter(value => value.id !== item.id) } : current);
      setMutationError(null); setRevision(value => value + 1);
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) setMutationError({ id: item.id, message: failure instanceof Error ? failure.message : '收藏删除失败，请重试。' });
    } finally {
      if (request.current === controller) { request.current = null; if (mounted.current) setMutation(null); }
    }
  }
  function renderCard(item: SavedItem) {
    const editing = draft?.item.id === item.id;
    const errorForItem = mutationError?.id === item.id ? mutationError.message : '';
    return <SavedCard key={item.id} item={item} playbackBusy={playbackBusy} play={play} locate={locate} editing={editing} note={editing ? draft!.note : item.note}
      busy={mutation?.id === item.id} mutating={Boolean(mutation)} error={errorForItem} onEdit={() => beginEdit(item)} onNoteChange={value => setDraft(current => current?.item.id === item.id ? { ...current, note: value } : current)}
      onSave={() => { void saveDraft(); }} onCancel={cancelEdit} onDelete={() => { void deleteItem(item); }} />;
  }
  const draftInPage = draft && page?.items.some(item => item.id === draft.item.id);
  return <section className="saved-panel" aria-label="收藏"><div className="panel-heading"><h2>收藏</h2><div className="section-tabs" aria-label="收藏范围">
    <button aria-pressed={!onlyCurrent} onClick={() => setOnlyCurrent(false)}>全部收藏</button><button aria-pressed={onlyCurrent} disabled={!currentMediaId} onClick={() => setOnlyCurrent(true)}>本集收藏</button></div></div>
    <p className="muted">保存原文与回答，随时回到来源；备注只属于你。</p>
    {notice ? <p className="muted" role="status">{notice}</p> : null}{error ? <p className="error" role="alert">{error}</p> : null}
    {!page ? error ? <div className="chat-empty"><p>收藏暂时读取失败。</p><button onClick={() => setRevision(value => value + 1)} disabled={busy}>重试读取</button></div> : <p className="muted">正在读取收藏…</p> : !page.items.length ? <div className="chat-empty"><strong>{previous.length ? '这一页已经没有收藏' : '把有用的内容留下来'}</strong><p>{previous.length ? '可以返回上一页继续查看。' : '在文稿中选择片段，或在回答下点击“收藏回答”。'}</p>{previous.length ? <button disabled={busy} onClick={() => { setCursor(previous.at(-1) ?? null); setPrevious(previous.slice(0, -1)); }}>返回上一页</button> : null}</div> : page.items.map(renderCard)}
    {draft && !draftInPage ? <div className="saved-card"><div className="saved-heading"><strong>正在编辑：{draft.item.mediaTitle}</strong><span className="muted">这条收藏当前不在本页</span></div>
      <form className="note-form" onSubmit={event => { event.preventDefault(); void saveDraft(); }}><label className="field"><span>我的备注</span><textarea aria-label={`备注 ${draft.item.mediaTitle}`} value={draft.note} maxLength={4000} onChange={event => setDraft(current => current ? { ...current, note: event.target.value } : current)} disabled={mutation?.id === draft.item.id} rows={3} /></label>
        <div className="source-actions"><button type="submit" disabled={Boolean(mutation)}>保存备注</button><button type="button" className="text-button" disabled={Boolean(mutation)} onClick={cancelEdit}>取消</button></div></form>
      {mutationError?.id === draft.item.id ? <p className="error" role="alert">{mutationError.message}</p> : null}</div> : null}
    {page ? <div className="transcript-navigation"><button disabled={busy || !previous.length} onClick={() => { setCursor(previous.at(-1) ?? null); setPrevious(previous.slice(0, -1)); }}>上一页</button>
      <button disabled={busy || !page.nextCursor} onClick={() => { setPrevious([...previous, cursor]); setCursor(page.nextCursor); }}>下一页</button></div> : null}
  </section>;
}
