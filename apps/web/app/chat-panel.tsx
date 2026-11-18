'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChatAnchor, ChatPage, ChatTurn } from '@yuqu/contracts';
import { citationIds, knowledgeApi, KnowledgeRequestError, time, type QuestionSelection } from './knowledge-ui';

type PositionScope = 'near' | 'until' | 'all';
interface PendingQuestion { requestId: string; question: string; anchor?: ChatAnchor; parentTurnId?: string }
const scopeLabels = { near: '前两分钟', until: '截至这里', all: '整期内容', selection: '选定原文', retrieval: '整期检索' };
const statusLabels = { queued: '等待回答', running: '正在生成', complete: '已完成', failed: '回答失败', cancelled: '已取消' };
const retrievalExplanation = '按问题检索整期文稿；追问沿用本次原文，需要新证据请重新检索。';

function isRetrievalTurn(turn: ChatTurn) {
  return turn.scope === 'retrieval' || turn.anchor?.kind === 'retrieval' || turn.retrieval !== undefined && turn.retrieval !== null;
}

function retrievalMeta(turn: ChatTurn) {
  const retrieval = turn.retrieval;
  if (!retrieval) return '文稿范围已固定';
  return `${retrieval.selectedSegments}/${retrieval.totalSegments} 段 · 文稿截至 ${time(retrieval.snapshot.throughMs)}`;
}

export function ChatPanel({ mediaVersionId, positionMs, positionAvailable, positionSource, selection, onUnavailable,
  playCitation, playbackBusy, playbackError, showContext, saved, askCurrent, pinDocument }: {
  mediaVersionId: string; positionMs: number; positionAvailable: boolean; positionSource: 'local' | 'synced';
  selection: QuestionSelection | null; onUnavailable?: () => void;
  playCitation: (mediaId: string, startMs: number, endMs: number) => Promise<void>;
  playbackBusy: boolean; playbackError: string; showContext: (positionMs: number) => void; saved: () => void;
  askCurrent: (draft: string, scope: PositionScope) => void; pinDocument: () => void;
}) {
  const [page, setPage] = useState<ChatPage | null>(null);
  const [before, setBefore] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [questionScope, setQuestionScope] = useState<PositionScope>('near');
  const [anchor, setAnchor] = useState<ChatAnchor | null>(null);
  const anchorRef = useRef<ChatAnchor | null>(null);
  const [anchorLabel, setAnchorLabel] = useState('');
  const [parent, setParent] = useState<ChatTurn | null>(null);
  const choiceMade = useRef(false);
  const unavailable = useRef(onUnavailable); unavailable.current = onUnavailable;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [unconfirmed, setUnconfirmed] = useState(false);
  const lifetime = useRef(0);
  const poll = useRef<AbortController | null>(null);
  const action = useRef<AbortController | null>(null);
  const pending = useRef<PendingQuestion | null>(null);
  const saveIds = useRef(new Map<string, string>());
  const [savedAnswers, setSavedAnswers] = useState<string[]>([]);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const submissionUncertain = useRef(false);
  const active = page?.turns.some(turn => turn.status === 'queued' || turn.status === 'running') ?? false;
  const latest = before === null;

  function resetPending() { pending.current = null; setUnconfirmed(false); setError(''); setNotice(''); }
  function useAnchor(value: ChatAnchor, label = '') {
    choiceMade.current = true; setParent(null); anchorRef.current = value; setAnchor(value); setAnchorLabel(label); resetPending(); pinDocument();
  }
  function freeze(scope = questionScope): ChatAnchor | null {
    if (!positionAvailable) return null;
    return { kind: 'position', positionMs: Math.max(0, Math.round(positionMs)), scope, capturedAt: new Date().toISOString(), positionSource };
  }
  useEffect(() => { if (selection) { useAnchor(selection.anchor, selection.label); if (selection.question !== undefined) setDraft(selection.question); } }, [selection?.nonce]);

  useEffect(() => {
    const generation = ++lifetime.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sequence = 0;
    const refresh = async () => {
      if (document.hidden || action.current) return;
      const request = ++sequence; poll.current?.abort();
      const controller = new AbortController(); poll.current = controller;
      try {
        const capabilities = encodeURIComponent('anchored-v1,retrieval-v1');
        const result = await knowledgeApi<ChatPage>(`/api/media/${encodeURIComponent(mediaVersionId)}/chat?capabilities=${capabilities}${before === null ? '' : `&before=${before}`}`, { signal: controller.signal });
        if (generation !== lifetime.current || request !== sequence || controller.signal.aborted) return;
        if (result.mediaVersionId !== mediaVersionId || !Array.isArray(result.turns) || result.turns.length > 20) throw new Error('对话响应无效，请重试。');
        setPage(result);
        if (!choiceMade.current) {
          const recent = [...result.turns].reverse().find(turn => turn.status === 'complete');
          if (recent) {
            if (recent.retrieval?.status === 'no-evidence') { const next: ChatAnchor = { kind: 'retrieval' }; anchorRef.current = next; setAnchor(next); }
            else setParent(recent);
            choiceMade.current = true;
          }
        } else setParent(previous => previous ? result.turns.find(turn => turn.id === previous.id) ?? previous : null);
      } catch (failure) {
        if (generation === lifetime.current && request === sequence && !controller.signal.aborted) {
          if (failure instanceof KnowledgeRequestError && failure.status === 404) { setPage(null); unavailable.current?.(); }
          setError(failure instanceof Error ? failure.message : '对话读取失败，请稍后重试。');
        }
      } finally { if (poll.current === controller) poll.current = null; }
    };
    refreshRef.current = refresh;
    const tick = async () => { await refresh(); if (generation === lifetime.current) timer = setTimeout(() => { void tick(); }, 2000); };
    const visibility = () => { if (document.hidden) poll.current?.abort(); else void refresh(); };
    document.addEventListener('visibilitychange', visibility); void tick();
    return () => {
      ++lifetime.current; clearTimeout(timer); poll.current?.abort(); action.current?.abort();
      poll.current = null; action.current = null; refreshRef.current = async () => {};
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [mediaVersionId, before]);

  async function perform(path: string, body?: PendingQuestion): Promise<ChatTurn | null> {
    if (action.current) return null;
    const generation = lifetime.current;
    const controller = new AbortController(); action.current = controller;
    let posted = false; submissionUncertain.current = false;
    poll.current?.abort(); setBusy(true); setError('');
    try {
      if (body) await knowledgeApi(`/api/media/${encodeURIComponent(mediaVersionId)}/chat/check`, {
        signal: controller.signal, body: body.parentTurnId ? { parentTurnId: body.parentTurnId } : { anchor: body.anchor }
      });
      posted = true;
      const result = await knowledgeApi<{ turn: ChatTurn }>(path, { signal: controller.signal, body, method: 'POST' });
      if (generation !== lifetime.current || controller.signal.aborted) return null;
      if (!result.turn || typeof result.turn.id !== 'string') throw new Error('提交结果无法确认，请重试。');
      setPage(previous => previous ? { ...previous, turns: [...previous.turns.filter(turn => turn.id !== result.turn.id), result.turn].sort((a, b) => a.sequence - b.sequence).slice(-20) } : previous);
      return result.turn;
    } catch (failure) {
      submissionUncertain.current = posted && !(failure instanceof KnowledgeRequestError && failure.status >= 400 && failure.status < 500);
      if (generation === lifetime.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : '提交未确认，请稍后重试。');
      return null;
    } finally {
      if (action.current === controller) action.current = null;
      if (generation === lifetime.current) { setBusy(false); void refreshRef.current(); }
    }
  }
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = draft.trim();
    if (!page || !latest || active || busy || !question || question.length > 2000) return;
    if (!parent && !anchorRef.current) { setError('请先选择文稿片段，或切换到当前收听位置再提问。'); return; }
    if (!pending.current) pending.current = { requestId: crypto.randomUUID(), question, ...(parent ? { parentTurnId: parent.id } : { anchor: anchorRef.current! }) };
    const request = pending.current;
    const sent = await perform(`/api/media/${encodeURIComponent(mediaVersionId)}/chat`, request);
    if (pending.current !== request) return;
    if (sent) {
      pending.current = null; setUnconfirmed(false); setDraft(''); setParent(sent.retrieval?.status === 'no-evidence' ? null : sent); choiceMade.current = true;
      const next: ChatAnchor | null = sent.retrieval?.status === 'no-evidence' ? { kind: 'retrieval' } : null;
      setAnchor(next); anchorRef.current = next; setAnchorLabel('');
    } else setUnconfirmed(submissionUncertain.current);
  }
  function changedDraft(value: string) {
    if (value.trim()) pinDocument();
    if (value.trim() && !parent && !anchorRef.current) {
      choiceMade.current = true; const next = freeze(); if (next) { anchorRef.current = next; setAnchor(next); pinDocument(); }
    }
    setDraft(value); resetPending();
  }
  function newCurrent(scope = questionScope) {
    choiceMade.current = true; setParent(null); setAnchor(null); anchorRef.current = null; setAnchorLabel(''); resetPending();
    const next = freeze(scope); if (next) useAnchor(next); else askCurrent(draft, scope);
  }
  function shortcut(question: string) {
    if (!positionAvailable) return;
    setQuestionScope('near'); useAnchor(freeze('near')!); setDraft(question);
  }
  function follow(turn: ChatTurn) {
    pinDocument();
    choiceMade.current = true; setParent(turn); setAnchor(null); anchorRef.current = null; setAnchorLabel(''); resetPending();
    document.getElementById('question-input')?.focus();
  }
  async function saveAnswer(turn: ChatTurn) {
    if (busy || action.current) return;
    if (savedAnswers.includes(turn.id)) { setNotice('这条回答已收藏。'); return; }
    const requestId = saveIds.current.get(turn.id) ?? crypto.randomUUID(); saveIds.current.set(turn.id, requestId);
    const controller = new AbortController(); action.current = controller; const generation = lifetime.current;
    setBusy(true); setError('');
    try {
      await knowledgeApi('/api/saved-items', { signal: controller.signal, body: { requestId, mediaVersionId, source: { kind: 'answer', turnId: turn.id } } });
      if (generation !== lifetime.current || controller.signal.aborted) return;
      setSavedAnswers(previous => [...previous, turn.id]); setNotice('回答和引用已收藏。'); saved();
    } catch (failure) { if (generation === lifetime.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : '收藏失败，请重试。'); }
    finally { if (action.current === controller) action.current = null; if (generation === lifetime.current) setBusy(false); }
  }
  function showCitation(turnId: string, citationId: string) {
    const element = document.getElementById(`citation-${turnId}-${citationId}`);
    const details = element?.closest('details'); if (details) details.open = true;
    element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  function answer(turn: ChatTurn) {
    return turn.answer.split(/(\[S\d+(?:\s*[-–—]\s*S?\d+)?\])/g).map((part, index) => {
      const ids = citationIds(part, turn.citations.map(citation => citation.id));
      return ids.length ? <button className="inline-citation" key={index} type="button" aria-label={`查看引用 ${ids.join('、')}`} onClick={() => showCitation(turn.id, ids[0])}>{part}</button> : part;
    });
  }
  const label = parent ? isRetrievalTurn(parent) ? `继续整期检索 · ${retrievalExplanation}` : `继续原话题 · ${time(parent.positionMs)} · ${scopeLabels[parent.scope]}` : anchor?.kind === 'position' ? `已固定 ${time(anchor.positionMs)} · ${scopeLabels[anchor.scope]}` : anchor?.kind === 'retrieval' ? anchorLabel || retrievalExplanation : anchor ? anchorLabel || '已固定选定原文' : positionAvailable ? '开始输入时固定收听位置' : '独立阅读：请选定文稿片段后提问';

  return <section className="chat-panel" aria-label="对话区">
    <div className="chat-heading"><span className="muted" role="status" data-testid="chat-connection">{!page ? '正在读取对话…' : page.bridgeOnline ? 'AI 已连接' : 'AI 暂未连接，问题会排队等待'}</span><div className="chat-history">
      <button className="text-button" disabled={busy || !page || page.nextBefore === null} onClick={() => { setPage(null); setBefore(page!.nextBefore); }}>更早记录</button>
      {!latest ? <button className="text-button" disabled={busy} onClick={() => { setPage(null); setBefore(null); }}>最新记录</button> : null}</div></div>
    {page?.turns.length ? <div className="chat-turns">{page.turns.map(turn => {
      const retrieval = isRetrievalTurn(turn);
      const noEvidence = turn.retrieval?.status === 'no-evidence';
      const answerText = turn.answer || (noEvidence ? '未在整期文稿中找到与这个问题相关的内容。' : '');
      return <article className="chat-turn" key={turn.id}>
      <div className="chat-question"><span className="muted">{retrieval ? `你 · 整期检索${turn.parentTurnId ? ' · 追问' : ''}` : `你 · ${time(turn.positionMs)} · ${scopeLabels[turn.scope]}${turn.parentTurnId ? ' · 追问' : ''}`}</span><p>{turn.question}</p></div>
      <div className="chat-answer"><span className="muted">AI · {statusLabels[turn.status]}</span>
        {answerText ? <p>{noEvidence && !turn.answer ? answerText : answer(turn)}</p> : turn.status === 'queued' || turn.status === 'running' ? <p className="muted">正在根据固定的文稿整理回答…</p> : null}
        {retrieval && turn.retrieval ? <p className="muted">来源：{retrievalMeta(turn)}</p> : null}
        {turn.error ? <p className="error">{turn.error}</p> : null}
        {turn.citations.length ? <details className="chat-citations"><summary>查看引用原文（{turn.citations.length}）</summary><div className="citation-content">
          <p className="muted">{page.audioAvailable ? '回听会切换到此设备；查看原文不改变播放。' : '音频已清理，原文和对话仍可查看。'}</p>
          {turn.citations.map(citation => <blockquote id={`citation-${turn.id}-${citation.id}`} key={`${turn.id}:${citation.id}`}>
            <span className="muted">[{citation.id}] {time(citation.startMs)}–{time(citation.endMs)}</span><p>{citation.text}</p>
            <div className="source-actions"><button className="text-button" onClick={() => showContext(citation.startMs)}>查看上下文</button>
              <button className="text-button" disabled={busy} onClick={() => useAnchor({ kind: 'citation-selection', sourceTurnId: turn.id, citationIds: [citation.id] }, `已固定引用 ${citation.id} · ${time(citation.startMs)}`)}>问这段</button>
              <button className="text-button" disabled={playbackBusy || !page.audioAvailable} onClick={() => { void playCitation(mediaVersionId, citation.startMs, citation.endMs); }}>回听这一段</button></div>
          </blockquote>)}{playbackError ? <p className="error" role="alert">{playbackError}</p> : null}</div></details> : null}
        {turn.status === 'complete' ? <div className="source-actions">{!noEvidence ? <button className="text-button" disabled={busy} onClick={() => follow(turn)}>继续问这个话题</button> : <button className="text-button" disabled={busy} onClick={() => useAnchor({ kind: 'retrieval' }, retrievalExplanation)}>重新检索整期文稿</button>}<button className="text-button" disabled={busy || savedAnswers.includes(turn.id)} onClick={() => { void saveAnswer(turn); }}>{savedAnswers.includes(turn.id) ? '已收藏' : '收藏回答'}</button></div> : null}
        {turn.status === 'queued' || turn.status === 'running' ? <button className="text-button" disabled={busy} onClick={() => { void perform(`/api/chat/turns/${encodeURIComponent(turn.id)}/cancel`); }}>取消回答</button> : null}
        {turn.status === 'failed' || turn.status === 'cancelled' ? <button className="text-button" disabled={busy || active || !latest} onClick={() => { void perform(`/api/chat/turns/${encodeURIComponent(turn.id)}/retry`); }}>重试回答</button> : null}
      </div></article>; })}</div> : page ? <div className="chat-empty"><strong>边听，边理清思路</strong><p>输入时固定位置，回答后可以围绕同一片段继续追问。</p></div> : null}
    {error ? <p className="error" role="alert">{error}</p> : null}{notice ? <p className="muted" role="status">{notice}</p> : null}
    {!latest ? <p className="muted">正在查看更早记录，回到最新记录后可继续提问。</p> : null}
    <form className="chat-compose" onSubmit={event => { void send(event); }}>
      <div className="anchor-bar"><span data-testid="question-anchor">{label}</span><button className="text-button" type="button" disabled={busy} onClick={() => newCurrent()}>问现在听到的</button></div>
      <div className="quick-questions"><button type="button" disabled={busy || !positionAvailable} onClick={() => shortcut('刚才这段是什么意思？')}>解释刚才</button><button type="button" disabled={busy || !positionAvailable} onClick={() => shortcut('请概括刚才这段的要点。')}>概括刚才</button><button type="button" disabled={busy || !page} onClick={() => useAnchor({ kind: 'retrieval' }, retrievalExplanation)}>检索整期文稿</button></div>
      {page?.retrievalOnline === false ? <p className="muted" role="status">整期检索 AI 暂未连接，有相关原文的问题会排队等待。</p> : null}
      <div className="composer"><textarea id="question-input" aria-label="问题输入" placeholder="写下问题，播放可以继续" value={draft} rows={2} maxLength={2000} disabled={busy || !latest} onChange={event => changedDraft(event.target.value)} />
        <div className="composer-toolbar"><label className="chat-scope"><span>新话题范围</span><select aria-label="提问范围" value={questionScope} disabled={busy || !positionAvailable} onChange={event => { const value = event.target.value as PositionScope; setQuestionScope(value); newCurrent(value); }}>
          <option value="near">前两分钟</option><option value="until">截至这里</option><option value="all">整期内容</option></select></label>
          <button type="submit" className="primary" aria-busy={busy} disabled={busy || !page || !latest || active || !draft.trim() || (!parent && !anchor)}>{busy ? '提交中…' : unconfirmed ? '重新确认发送' : '发送'}</button></div></div>
      {unconfirmed ? <p className="muted">问题尚未提交确认，草稿和原文位置已保留。</p> : active ? <p className="muted">当前回答完成或取消后，可以继续提问。</p> : null}
    </form>
  </section>;
}
