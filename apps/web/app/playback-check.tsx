'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { PLAYBACK_FIXTURE } from '@yuqu/contracts';
import { ConnectionProbe } from './connection-probe';
import { RequestError, usePlaybackSession } from './use-playback-session';
import { LibraryPanel } from './library-panel';
import { TranscriptPanel } from './transcript-panel';
import { ChatPanel } from './chat-panel';
import { SavedPanel } from './saved-panel';
import { time, type QuestionSelection, type SourceLocation } from './knowledge-ui';

function formatTime(seconds: number) {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(safe / 60).toString().padStart(2, '0')}:${(safe % 60).toString().padStart(2, '0')}`;
}

type PlaybackSession = ReturnType<typeof usePlaybackSession>;
function EmailLogin({ session }: { session: PlaybackSession }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState('');
  const [busy, setBusy] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(0);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [localDelivery, setLocalDelivery] = useState(false);
  const remaining = Math.max(0, Math.ceil((retryAt - now) / 1000));
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = await session.requestCode(email.trim().toLowerCase());
      setChallenge(result.challengeId); setCode(''); setNow(Date.now()); setRetryAt(Date.now() + result.retryAfter * 1000);
      setLocalDelivery(result.delivery === 'local');
      setNotice(result.delivery === 'local' ? '本地测试邮件已生成，可在本机测试收件箱查看。' : '验证码已发送，请查看邮箱。');
    } catch (error) {
      setError(error instanceof RequestError ? error.message : '邮件发送未完成，请稍后重试。');
    } finally { setBusy(false); }
  }
  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try { await session.verifyCode(email.trim().toLowerCase(), challenge, code.trim()); }
    catch (error) { setError(error instanceof RequestError ? error.message : '登录未完成，请稍后重试。'); }
    finally { setBusy(false); }
  }

  return <details className="account-panel"><summary>邮箱登录，同步手机与网页</summary>
    <div className="account-content">
      <form className="login-row" onSubmit={send}>
        <label className="field"><span>邮箱</span><input type="email" autoComplete="email" required maxLength={254}
          aria-label="登录邮箱" placeholder="你的邮箱" value={email} disabled={busy}
          onChange={event => { setEmail(event.target.value); setChallenge(''); setCode(''); setNotice(''); setError(''); }} /></label>
        <button type="submit" disabled={busy || remaining > 0 || !email.trim()}>{remaining > 0 ? `${remaining} 秒后重发` : '发送验证码'}</button>
      </form>
      {challenge ? <form className="login-row" onSubmit={verify}>
        <label className="field"><span>验证码</span><input aria-label="邮箱验证码" inputMode="numeric" autoComplete="one-time-code"
          pattern="[0-9]{6}" maxLength={6} required placeholder="6 位验证码" value={code} disabled={busy}
          onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} /></label>
        <button className="primary" type="submit" disabled={busy || code.length !== 6}>登录</button>
      </form> : null}
      {notice ? <p className="muted" role="status">{notice}</p> : null}
      {localDelivery && challenge ? <p className="muted">本地开发：在项目目录运行 <code>npm run mail:inbox</code> 查看测试邮件。</p> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      <p className="muted">邮箱用于登录；资料、播放进度和对话将保存到云端。提问时，问题和相关文稿会发送给 OpenAI Codex。<a href="/privacy" target="_blank" rel="noopener noreferrer">查看隐私说明</a>。</p>
    </div>
  </details>;
}

export function PlaybackCheck() {
  const player = useRef<HTMLAudioElement>(null);
  const session = usePlaybackSession(player);
  const { view } = session;
  const [reader, setReader] = useState<{ id: string; title: string; sessionId: string; audioAvailable: boolean } | null>(null);
  const [section, setSection] = useState<'library' | 'listen' | 'saved'>('listen');
  const [detail, setDetail] = useState<'chat' | 'transcript'>('chat');
  const [selection, setSelection] = useState<{ mediaVersionId: string; sessionId: string; value: QuestionSelection } | null>(null);
  const [location, setLocation] = useState<SourceLocation | null>(null);
  const [savedRevision, setSavedRevision] = useState(0);
  useEffect(() => { setReader(null); setSelection(null); setLocation(null); setSection('listen'); setDetail('chat'); }, [session.account?.session.id]);
  const reading = reader?.sessionId === session.account?.session.id ? reader : null;
  const documentId = reading?.id ?? session.snapshot?.mediaVersionId;
  const sameMedia = documentId === session.snapshot?.mediaVersionId;
  const documentPosition = sameMedia ? Math.round(view.position * 1000) : 0;
  const positionAvailable = sameMedia && !session.stale && !session.busy && !!session.snapshot;
  const documentAudio = reading?.audioAvailable ?? true;
  const pinDocument = () => {
    if (!documentId || !session.account) return;
    setReader(previous => previous?.id === documentId && previous.sessionId === session.account!.session.id ? previous : {
      id: documentId, title: session.snapshot?.title || '当前节目', sessionId: session.account!.session.id, audioAvailable: true
    });
  };
  const locate = (source: SourceLocation) => {
    if (!session.account) return;
    setReader({ id: source.mediaVersionId, title: source.title || reading?.title || session.snapshot?.title || '文稿', sessionId: session.account.session.id, audioAvailable: source.audioAvailable ?? documentAudio });
    setLocation(source); setSection('listen'); setDetail('transcript');
  };
  const primaryLabel = session.account ? session.own && view.playing ? '暂停' : '在此设备播放' : view.playing ? '暂停' : '播放';

  return <main>
    <header><span className="brand">鱼趣知识库</span>
      {session.account ? <div className="account-identity"><span title={session.account.user.email}>{session.account.user.email}</span>
        <button className="text-button" onClick={() => { void session.logout(); }} disabled={session.busy}>退出</button></div> : <span className="muted">{session.loading ? '正在恢复登录…' : '本地试听'}</span>}
    </header>
    {!session.account && !session.loading ? <EmailLogin session={session} /> : null}
    {session.account ? <nav className="section-tabs" aria-label="主导航">{([['library', '资料库'], ['listen', '收听'], ['saved', '收藏']] as const).map(([id, title]) =>
      <button key={id} aria-current={section === id ? 'page' : undefined} onClick={() => setSection(id)}>{title}</button>)}</nav> : null}
    <section className="player persistent-player" aria-label="播放器">
      <h1>{session.snapshot?.title || PLAYBACK_FIXTURE.title}</h1>
      <audio ref={player} src="/audio/playback-check.wav" preload="metadata" loop
        onLoadedMetadata={() => session.mediaChanged()} onTimeUpdate={() => session.mediaChanged()}
        onPlay={() => session.mediaChanged(true)} onPlaying={() => session.mediaChanged(true)}
        onPause={() => session.mediaChanged(true)} onEnded={() => session.mediaChanged(true)}
        onSeeked={() => session.mediaChanged(true)} onRateChange={() => session.mediaChanged(true)}
        onWaiting={() => session.mediaChanged(true)}
        onError={() => session.setError('音频暂时无法加载，请重新点击播放；也可以检查连接后重试。')} />
      <input className="progress" type="range" min="0" max={view.duration} step="0.1" value={view.position}
        disabled={!session.canControl || session.busy} aria-label="播放进度" onChange={event => session.seek(Number(event.target.value))} />
      <div className="time"><span data-testid="playback-time">{formatTime(view.position)} / {formatTime(view.duration)}</span>
        <span>{view.playing ? '正在播放' : '已暂停'} · {session.following ? '静音跟随' : '本机'}</span></div>
      <div className="controls">
        <button className="primary" onClick={() => { void session.playHere(); }} disabled={session.loading || session.busy || (!!session.account && !session.snapshot)}>{primaryLabel}</button>
        <button onClick={() => session.seek(view.position - 15)} disabled={!session.canControl || session.busy} aria-label="后退十五秒">−15 秒</button>
        <button onClick={() => session.seek(view.position + 15)} disabled={!session.canControl || session.busy} aria-label="前进十五秒">+15 秒</button>
        <select aria-label="播放速度" value={view.speed} disabled={!session.canControl || session.busy} onChange={event => session.setSpeed(Number(event.target.value))}>
          {[1, 1.25, 1.5, 2].map(rate => <option key={rate} value={rate}>{rate}×</option>)}
        </select>
        <label className="loop"><input type="checkbox" checked={view.looping} disabled={!session.canControl || session.busy}
          onChange={event => session.setLooping(event.target.checked)} />循环</label>
      </div>
      <div className="sync-status"><span role="status" data-testid="sync-status">{session.connection}{session.stale ? ' · 进度已过期，等待设备更新' : ''}</span>
        {session.account ? <button className="text-button" onClick={session.reconnect} disabled={session.busy}>重新连接</button> : null}
      </div>
      {session.following ? <p className="muted">网页只跟随收听进度。点击“在此设备播放”可切换到电脑收听。</p> : null}
      {session.error ? <p role="alert" className="error">{session.error}</p> : null}
      {session.returnPoint ? <div className="return-point"><span>回听后可返回「{session.returnPoint.title}」{time(session.returnPoint.positionMs)}</span>
        <div className="source-actions"><button disabled={session.busy} onClick={() => { void session.restorePlayback(); }}>在本机返回原位置</button>
          <button disabled={session.busy || !session.own} onClick={() => { void session.continuePlayback(); }}>继续听</button><button className="text-button" onClick={session.clearReturnPoint}>关闭</button></div></div> : null}
    </section>
    {session.account ? <div hidden={section !== 'library'}><LibraryPanel key={session.account.session.id} visible={section === 'library'} currentMediaId={session.snapshot?.mediaVersionId}
      playbackBusy={session.busy || !session.snapshot} play={async id => { await session.playHere(id); setReader(null); setSection('listen'); }}
      read={item => { setReader({ id: item.mediaVersionId, title: item.title, sessionId: session.account!.session.id, audioAvailable: item.audioAvailable }); setSection('listen'); setDetail('transcript'); setLocation(null); }}
      removed={async (id, mode) => {
        session.clearReturnPoint(); setSavedRevision(value => value + 1);
        setReader(previous => previous?.id !== id ? previous : mode === 'all' ? null : { ...previous, audioAvailable: false });
        await session.refreshPlayback();
      }} /></div> : null}
    {session.account && documentId ? <div hidden={section !== 'listen'} className="listening-detail">
      <section className="reading-heading" aria-label="正在查看文稿"><div><strong>{reading?.title || session.snapshot?.title || '当前节目'}</strong>
        <p className="muted">{sameMedia ? '文稿、搜索和对话不会中断播放。' : '独立阅读，不改变当前播放。可选择文稿片段或检索整期文稿提问。'}</p></div>
        {!sameMedia ? <button onClick={() => { setReader(null); setSelection(null); setLocation(null); }}>返回当前节目</button> : null}</section>
      <div className="section-tabs" aria-label="收听详情"><button aria-pressed={detail === 'chat'} onClick={() => setDetail('chat')}>对话</button><button aria-pressed={detail === 'transcript'} onClick={() => setDetail('transcript')}>文稿与搜索</button></div>
      <div hidden={detail !== 'transcript'}><TranscriptPanel key={`transcript:${session.account.session.id}:${documentId}`}
        mediaVersionId={documentId} positionMs={documentPosition} positionAvailable={positionAvailable}
        location={location?.mediaVersionId === documentId ? location : null} audioAvailable={documentAudio} playbackBusy={session.busy || !session.snapshot}
        active={section === 'listen' && detail === 'transcript'}
        play={session.replayCitation} saved={() => setSavedRevision(value => value + 1)} ask={value => {
          setSelection({ mediaVersionId: documentId, sessionId: session.account!.session.id, value }); pinDocument(); setDetail('chat');
        }} /></div>
      <div hidden={detail !== 'chat'}><ChatPanel key={`chat:${session.account.session.id}:${documentId}`}
        mediaVersionId={documentId} positionMs={documentPosition} positionAvailable={positionAvailable} positionSource={session.own ? 'local' : 'synced'}
        selection={selection?.mediaVersionId === documentId && selection.sessionId === session.account.session.id ? selection.value : null}
        playCitation={session.replayCitation} playbackBusy={session.busy || !session.snapshot} playbackError={session.error}
        pinDocument={pinDocument} saved={() => setSavedRevision(value => value + 1)} showContext={positionMs => locate({ mediaVersionId: documentId, positionMs, nonce: Date.now() })}
        askCurrent={(draft, scope) => {
          if (!session.snapshot || session.stale || session.busy) { session.setError('当前进度暂不可用，请等待连接更新。'); return; }
          setReader(null); setSelection({ mediaVersionId: session.snapshot.mediaVersionId, sessionId: session.account!.session.id,
            value: { anchor: { kind: 'position', positionMs: Math.round(view.position * 1000), scope, capturedAt: new Date().toISOString(), positionSource: session.own ? 'local' : 'synced' }, label: '', nonce: Date.now(), question: draft } });
        }} onUnavailable={() => { setReader(null); void session.refreshPlayback(); }} /></div>
    </div> :
      <section className="empty" aria-label="对话区"><div><strong>边听，边理清思路</strong><p>登录并选择节目，即可根据文稿提问，手机与网页继续同一段对话。</p></div></section>}
    {session.account ? <div hidden={section !== 'saved'}><SavedPanel key={session.account.session.id} enabled={section === 'saved'} currentMediaId={documentId} refreshToken={savedRevision}
      playbackBusy={session.busy || !session.snapshot} play={session.replayCitation} locate={locate} /></div> : null}
    {process.env.NODE_ENV !== 'production' ? <ConnectionProbe /> : null}
    <footer className="privacy-footer"><a href="/privacy" target="_blank" rel="noopener noreferrer">隐私说明与数据管理</a></footer>
  </main>;
}
