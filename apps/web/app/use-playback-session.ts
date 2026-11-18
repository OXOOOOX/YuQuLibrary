'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { PLAYBACK_FIXTURE } from '@yuqu/contracts';
import type { AccountSession, PlaybackReport, PlaybackResult, SyncedPlayback } from '@yuqu/contracts';
import { observedPlaybackState } from './playback-observation';

interface ApiErrorBody { error?: { code: string; message: string }; snapshot?: SyncedPlayback }
export class RequestError extends Error {
  constructor(public status: number, public body: ApiErrorBody) { super(body.error?.message ?? '请求未完成，请重试。'); }
}
async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)
  });
  const data = await response.json();
  if (!response.ok) throw new RequestError(response.status, data as ApiErrorBody);
  return data as T;
}
function requireCookieLock() {
  if (typeof navigator.locks?.request !== 'function') {
    throw new RequestError(400, { error: { code: 'browser_unsupported', message: '请使用较新的浏览器完成登录' } });
  }
}
async function withCookieLock(work: () => Promise<void>) {
  requireCookieLock();
  // The response's Set-Cookie side effect and local account application must
  // finish before another tab starts a login/logout request.
  await navigator.locks.request('yuqu-account-cookie-v1', { mode: 'exclusive' }, work);
}
const message = (error: unknown) => error instanceof RequestError ? error.message : '连接未完成，请检查网络后重试。';
interface Activation { generation: number; playbackSessionId: string }
interface UnconfirmedReport { epoch: number; activation: Activation; report: PlaybackReport }
interface ReturnPoint {
  mediaVersionId: string; title: string; positionMs: number; speed: number; looping: boolean; playing: boolean;
  generation: number; playbackSessionId: string;
}
interface ReplayAttempt {
  requestId: string; expectedGeneration: number; mediaVersionId: string; positionMs: number; endMs: number; original: ReturnPoint;
}
interface RestoreAttempt {
  requestId: string; expectedGeneration: number; expectedPlaybackSessionId: string;
  mediaVersionId: string; positionMs: number; speed: number; looping: boolean; playing: boolean;
}
const FIXTURE_MEDIA = 'fixture-pcm-v1';
const fixtureSource = '/audio/playback-check.wav';

function waitForMedia(audio: HTMLAudioElement, ready: () => boolean, event: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer); audio.removeEventListener(event, check); audio.removeEventListener('error', failed);
      signal.removeEventListener('abort', aborted); if (error) reject(error); else resolve();
    };
    const check = () => { if (ready()) finish(); };
    const failed = () => finish(new Error('音频暂时无法加载，请重试播放。'));
    const aborted = () => finish(new DOMException('Media preparation cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('音频加载超时，请重试播放。')), 20000);
    audio.addEventListener(event, check); audio.addEventListener('error', failed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted(); else if (audio.error) failed(); else check();
  });
}

/** An activation belongs to this tab, rather than the shared browser cookie. */
export function usePlaybackSession(player: RefObject<HTMLAudioElement | null>) {
  const [account, setAccount] = useState<AccountSession | null>(null);
  const [snapshot, setSnapshot] = useState<SyncedPlayback | null>(null);
  const [activation, setActivation] = useState<Activation | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState('未登录，仅在本机试听');
  const [now, setNow] = useState(0);
  const [local, setLocal] = useState({ position: 0, duration: 120, speed: 1, looping: true, playing: false });
  const accountRef = useRef<AccountSession | null>(null);
  const snapshotRef = useRef<SyncedPlayback | null>(null);
  const activationRef = useRef<Activation | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const accountChannel = useRef<BroadcastChannel | null>(null);
  const epoch = useRef(0);
  const connected = useRef(false);
  const mounted = useRef(false);
  const sequence = useRef(0);
  const pending = useRef(false);
  const unconfirmed = useRef<UnconfirmedReport | null>(null);
  const retryAt = useRef(0);
  const uploading = useRef(false);
  const takingOver = useRef<number | null>(null);
  const checkingAuth = useRef(false);
  const recoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recoveryRequest = useRef<AbortController | null>(null);
  const recoveryGeneration = useRef(0);
  const flushRef = useRef<() => void>(() => {});
  const preparing = useRef(false);
  const mediaGeneration = useRef(0);
  const mediaRequest = useRef<AbortController | null>(null);
  const loadedMediaId = useRef(FIXTURE_MEDIA);
  const returnRef = useRef<ReturnPoint | null>(null);
  const [returnPoint, setReturnPoint] = useState<ReturnPoint | null>(null);
  const replayEnd = useRef<number | null>(null);
  const replayTransition = useRef(false);
  const replayInFlight = useRef(false);
  const pendingReplay = useRef<ReplayAttempt | null>(null);
  const pendingRestore = useRef<RestoreAttempt | null>(null);

  function clearReturnPoint() {
    returnRef.current = null; setReturnPoint(null); replayEnd.current = null;
    pendingReplay.current = null; pendingRestore.current = null;
  }

  function ownsPlayback(): boolean {
    const active = activationRef.current, current = snapshotRef.current;
    return !!active && !!current && current.ownerSessionId === accountRef.current?.session.id &&
      active.generation === current.generation && active.playbackSessionId === current.playbackSessionId;
  }

  function restoreAttemptMatches(point: ReturnPoint, attempt: RestoreAttempt): boolean {
    return attempt.expectedGeneration === point.generation &&
      attempt.expectedPlaybackSessionId === point.playbackSessionId &&
      attempt.mediaVersionId === point.mediaVersionId && attempt.positionMs === point.positionMs &&
      attempt.speed === point.speed && attempt.looping === point.looping && attempt.playing === point.playing;
  }

  /**
   * A next-generation snapshot can be the result of this exact idempotent
   * restore request. It is only enough to keep the retry affordance; the
   * server response for the frozen request still has to be accepted before
   * this tab creates a new activation.
   */
  function restoreSnapshotMayBeAccepted(next: SyncedPlayback, attempt: RestoreAttempt): boolean {
    const accountId = accountRef.current?.session.id;
    if (!accountId || next.ownerSessionId !== accountId) return false;
    if (next.generation === attempt.expectedGeneration &&
      next.playbackSessionId === attempt.expectedPlaybackSessionId) return true;
    return next.generation === attempt.expectedGeneration + 1 &&
      next.mediaVersionId === attempt.mediaVersionId && next.positionMs === attempt.positionMs &&
      next.speed === attempt.speed && next.looping === attempt.looping && next.state === 'paused' &&
      next.playbackSessionId !== null;
  }

  function deactivate() {
    ++mediaGeneration.current; preparing.current = false;
    mediaRequest.current?.abort(); mediaRequest.current = null;
    activationRef.current = null; setActivation(null); pending.current = false;
    unconfirmed.current = null; retryAt.current = 0;
    player.current?.pause();
  }

  function cancelRecovery() {
    ++recoveryGeneration.current;
    if (recoveryTimer.current !== null) clearTimeout(recoveryTimer.current);
    recoveryTimer.current = null;
    recoveryRequest.current?.abort(); recoveryRequest.current = null;
  }

  function stopConnection() {
    cancelRecovery();
    replayTransition.current = false; replayInFlight.current = false;
    connected.current = false;
    takingOver.current = null;
    sourceRef.current?.close(); sourceRef.current = null;
    deactivate();
    clearReturnPoint();
  }

  function clearAccount(reason = '未登录，仅在本机试听') {
    ++epoch.current; stopConnection();
    accountRef.current = null; snapshotRef.current = null;
    setAccount(null); setSnapshot(null); setConnection(reason); setBusy(false); setLoading(false); setError('');
    const audio = player.current;
    if (audio && loadedMediaId.current !== FIXTURE_MEDIA) {
      loadedMediaId.current = FIXTURE_MEDIA; audio.src = fixtureSource; audio.loop = true; audio.load();
      setLocal({ position: 0, duration: 120, speed: 1, looping: true, playing: false });
    }
  }

  function applySnapshot(next: SyncedPlayback) {
    if (!accountRef.current || !Number.isSafeInteger(next.revision)) return;
    if (snapshotRef.current && next.revision < snapshotRef.current.revision) return;
    snapshotRef.current = next; setSnapshot(next);
    const saved = returnRef.current;
    const restoreAttempt = pendingRestore.current;
    if (saved && !replayTransition.current) {
      const sameSavedSnapshot = next.ownerSessionId === accountRef.current?.session.id &&
        next.generation === saved.generation && next.playbackSessionId === saved.playbackSessionId;
      const possibleRestore = restoreAttempt !== null && restoreAttemptMatches(saved, restoreAttempt) &&
        restoreSnapshotMayBeAccepted(next, restoreAttempt);
      if (!sameSavedSnapshot && !possibleRestore) clearReturnPoint();
    }
    const attempt = pendingReplay.current;
    if (attempt && !replayTransition.current && !(next.generation === attempt.expectedGeneration ||
      (next.generation === attempt.expectedGeneration + 1 && next.ownerSessionId === accountRef.current?.session.id && next.mediaVersionId === attempt.mediaVersionId))) clearReturnPoint();
    if (!ownsPlayback()) deactivate();
  }

  function openAccount(profile: AccountSession) {
    ++epoch.current; stopConnection();
    const currentEpoch = epoch.current;
    accountRef.current = profile; snapshotRef.current = null;
    setAccount(profile); setSnapshot(null); setError(''); setLoading(false); setBusy(false); setConnection('正在连接播放进度…');
    const source = new EventSource('/api/events');
    sourceRef.current = source;
    const live = () => mounted.current && currentEpoch === epoch.current && sourceRef.current === source;
    source.onopen = () => {
      if (!live()) return;
      cancelRecovery(); connected.current = false;
      const recovery = recoveryGeneration.current;
      const recovering = () => live() && recovery === recoveryGeneration.current;
      let failures = 0;
      // Reconcile ownership before sending fresh progress after a disconnected period.
      const recover = async () => {
        if (!recovering()) return;
        const controller = new AbortController(); recoveryRequest.current = controller;
        try {
          const result = await request<{ snapshot: SyncedPlayback }>('/api/playback', undefined, controller.signal);
          if (!recovering()) return;
          recoveryRequest.current = null; applySnapshot(result.snapshot);
          connected.current = true; setConnection('进度已连接');
          if (ownsPlayback()) { pending.current = true; flushRef.current(); }
        } catch (error) {
          if (!recovering()) return;
          recoveryRequest.current = null;
          if (error instanceof RequestError && error.status === 401) { clearAccount('登录已过期，请重新登录'); return; }
          connected.current = false; setConnection('暂时无法恢复进度，正在重试…');
          recoveryTimer.current = setTimeout(() => {
            recoveryTimer.current = null; void recover();
          }, Math.min(5000, 1000 * 2 ** Math.min(failures++, 3)));
        }
      };
      void recover();
    };
    for (const kind of ['snapshot', 'playback']) source.addEventListener(kind, (event: MessageEvent<string>) => {
      if (!live()) return;
      try { applySnapshot(JSON.parse(event.data) as SyncedPlayback); }
      catch { setConnection('收到的进度不可用，正在重新连接'); connected.current = false; }
    });
    source.addEventListener('reset', (event: MessageEvent<string>) => {
      if (!live() || !accountRef.current) return;
      try {
        const resetSnapshot = JSON.parse(event.data) as SyncedPlayback;
        if (!Number.isSafeInteger(resetSnapshot.revision) || resetSnapshot.revision < 0) throw new Error('Invalid reset');
        // A server restore may legitimately lower revision. Start a new epoch
        // and a fresh EventSource without the old cursor before accepting it.
        openAccount(accountRef.current); applySnapshot(resetSnapshot);
      } catch { connected.current = false; setConnection('收到的进度不可用，请重新连接'); }
    });
    source.addEventListener('session-expired', () => { if (live()) clearAccount('登录已过期，请重新登录'); });
    source.onerror = () => {
      if (!live()) return;
      cancelRecovery();
      connected.current = false; setConnection('连接中断，正在恢复…');
      if (checkingAuth.current) return;
      checkingAuth.current = true;
      void request<AccountSession>('/api/auth/me').then(profile => {
        if (live() && profile.session.id !== accountRef.current?.session.id) clearAccount('登录已变化，请刷新页面');
      }).catch(error => {
        if (live() && error instanceof RequestError && error.status === 401) clearAccount('登录已过期，请重新登录');
      }).finally(() => { checkingAuth.current = false; });
    };
  }

  async function reloadAccount() {
    // Cookies are shared by tabs. Drop all old account data before reading the
    // current cookie; no in-flight result from the previous epoch can apply.
    clearAccount('登录状态已变化，正在恢复…');
    setLoading(true);
    const currentEpoch = epoch.current;
    await request<AccountSession>('/api/auth/me').then(profile => {
      if (mounted.current && currentEpoch === epoch.current) openAccount(profile);
    }).catch(error => {
      if (!mounted.current || currentEpoch !== epoch.current) return;
      if (error instanceof RequestError && error.status === 401) clearAccount();
      else setConnection('同步服务暂不可用，可先本地试听');
    }).finally(() => { if (mounted.current && currentEpoch === epoch.current) setLoading(false); });
  }

  async function flush() {
    if (preparing.current || uploading.current || (!pending.current && !unconfirmed.current) || !connected.current || !ownsPlayback() || Date.now() < retryAt.current) return;
    const audio = player.current, current = snapshotRef.current, active = activationRef.current;
    if (!audio || !current || !active || loadedMediaId.current !== current.mediaVersionId || (audio.seeking && !unconfirmed.current)) return;
    const currentEpoch = epoch.current;
    if (unconfirmed.current && (unconfirmed.current.epoch !== currentEpoch || unconfirmed.current.activation !== active)) unconfirmed.current = null;
    if (!unconfirmed.current) {
      pending.current = false;
      const report: PlaybackReport = {
        generation: active.generation, playbackSessionId: active.playbackSessionId,
        sequence: ++sequence.current, contentId: current.contentId, mediaVersionId: current.mediaVersionId,
        positionMs: Math.round(Math.min(current.durationMs, Math.max(0, audio.currentTime * 1000))),
        speed: audio.playbackRate, state: observedPlaybackState(audio, current.durationMs),
        looping: audio.loop
      };
      unconfirmed.current = { epoch: currentEpoch, activation: active, report };
    }
    const packet = unconfirmed.current;
    uploading.current = true;
    try {
      const result = await request<PlaybackResult>('/api/playback/report', packet.report);
      if (!mounted.current || currentEpoch !== epoch.current || activationRef.current !== active) return;
      if (unconfirmed.current === packet) unconfirmed.current = null;
      retryAt.current = 0; sequence.current = Math.max(sequence.current, result.snapshot.sequence);
      applySnapshot(result.snapshot); setError('');
    } catch (error) {
      if (!mounted.current || currentEpoch !== epoch.current || activationRef.current !== active) return;
      if (error instanceof RequestError && error.status === 401) clearAccount('登录已过期，请重新登录');
      else if (error instanceof RequestError && error.status === 409) {
        deactivate(); if (error.body.snapshot) applySnapshot(error.body.snapshot);
        setError('播放已由其他设备接管。');
      } else if (error instanceof RequestError && error.status >= 400 && error.status < 500 && error.status !== 429) {
        deactivate(); setError(error.message);
      } else {
        // Retry the same sequence and immutable payload even if the audio is
        // paused. New media changes remain dirty until this packet is confirmed.
        retryAt.current = Date.now() + 3000; setError(message(error));
      }
    } finally {
      uploading.current = false;
      if (mounted.current && (pending.current || unconfirmed.current)) flushRef.current();
    }
  }
  flushRef.current = () => { void flush(); };

  function queueReport() {
    if (preparing.current || !ownsPlayback()) return;
    pending.current = true; flushRef.current();
  }

  function mediaChanged(upload = false) {
    const audio = player.current;
    if (!audio) return;
    if (accountRef.current && !ownsPlayback() && !audio.paused) audio.pause();
    if (replayEnd.current !== null && ownsPlayback() && !preparing.current && audio.currentTime * 1000 >= replayEnd.current) {
      replayEnd.current = null; audio.pause(); upload = true;
    }
    setLocal({ position: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : (snapshotRef.current?.durationMs ?? PLAYBACK_FIXTURE.durationMs) / 1000,
      speed: audio.playbackRate, looping: audio.loop, playing: !audio.paused && !audio.ended });
    if (upload) queueReport();
  }

  async function activateHere(mediaVersionId?: string, positionMs?: number, restore?: ReturnPoint,
    replayAttempt?: ReplayAttempt, restoreAttempt?: RestoreAttempt): Promise<SyncedPlayback | null> {
    const audio = player.current;
    if (!audio || takingOver.current !== null) return null;
    setError('');
    if (positionMs !== undefined && (!mediaVersionId || !Number.isSafeInteger(positionMs) || positionMs < 0 || !accountRef.current)) {
      setError('引用的回听位置不可用，请重新读取对话。'); return null;
    }
    if (!accountRef.current) {
      try { if (audio.paused) await audio.play(); else audio.pause(); }
      catch { setError('音频无法播放，请检查浏览器设置后重试。'); }
      return null;
    }
    if (!mediaVersionId && ownsPlayback() && !audio.paused) { audio.pause(); queueReport(); return null; }
    const current = snapshotRef.current;
    if (!current || !connected.current) { setError('请等待进度连接后，再在此设备播放。'); return null; }
    if (restore) {
      const sameSavedSnapshot = current.generation === restore.generation && current.playbackSessionId === restore.playbackSessionId &&
        current.ownerSessionId === accountRef.current.session.id && ownsPlayback();
      const retryableRestore = restoreAttempt !== undefined && restoreAttemptMatches(restore, restoreAttempt) &&
        restoreSnapshotMayBeAccepted(current, restoreAttempt);
      if (!sameSavedSnapshot && !retryableRestore) {
        clearReturnPoint(); setError('播放已在其他设备变化，未返回原位置。'); return null;
      }
    }
    const currentEpoch = epoch.current;
    takingOver.current = currentEpoch; setBusy(true);
    // Retire any old upload before changing content. The server's generation
    // check also fences an already in-flight report from the former media.
    deactivate();
    let controller: AbortController | undefined;
    try {
      // Every explicit resume creates a generation, including another tab sharing this cookie.
      const expectedGeneration = restoreAttempt?.expectedGeneration ?? restore?.generation ?? replayAttempt?.expectedGeneration ?? current.generation;
      const result = await request<PlaybackResult>('/api/playback/takeover', {
        requestId: restoreAttempt?.requestId ?? replayAttempt?.requestId ?? crypto.randomUUID(), expectedGeneration,
        ...(restore ? { intent: 'restore', expectedPlaybackSessionId: restoreAttempt?.expectedPlaybackSessionId ?? restore.playbackSessionId,
          speed: restoreAttempt?.speed ?? restore.speed, looping: restoreAttempt?.looping ?? restore.looping } : {}),
        ...(mediaVersionId ? { mediaVersionId } : {}),
        ...(positionMs !== undefined ? { positionMs } : {})
      });
      if (!mounted.current || currentEpoch !== epoch.current) return null;
      applySnapshot(result.snapshot);
      const next = snapshotRef.current;
      if (!next || !result.accepted || next.generation !== expectedGeneration + 1 || next.revision !== result.snapshot.revision ||
          next.ownerSessionId !== accountRef.current?.session.id || !next.playbackSessionId ||
          (mediaVersionId !== undefined && next.mediaVersionId !== mediaVersionId)) {
        if (replayAttempt) pendingReplay.current = null;
        if (restoreAttempt) pendingRestore.current = null;
        setError('播放状态已变化，请重新点击接管。'); return null;
      }
      const nextActivation = { generation: next.generation, playbackSessionId: next.playbackSessionId };
      activationRef.current = nextActivation; setActivation(nextActivation); sequence.current = next.sequence;
      // applySnapshot may deactivate before this tab has claimed the response.
      const preparedGeneration = ++mediaGeneration.current;
      controller = new AbortController();
      preparing.current = true; mediaRequest.current = controller;
      const active = () => mounted.current && currentEpoch === epoch.current &&
        preparedGeneration === mediaGeneration.current && activationRef.current === nextActivation;
      // A decoder can retain its EOF state after seeking back from the end.
      // Explicit resume reloads that decoder before restoring the saved position.
      if (loadedMediaId.current !== next.mediaVersionId || audio.error || audio.ended) {
        loadedMediaId.current = next.mediaVersionId;
        audio.src = next.mediaVersionId === FIXTURE_MEDIA ? fixtureSource : `/api/media/${encodeURIComponent(next.mediaVersionId)}`;
        audio.load();
      }
      await waitForMedia(audio, () => audio.readyState >= 1, 'loadedmetadata', controller.signal);
      if (!active()) return null;
      const target = Math.min(next.positionMs / 1000, Number.isFinite(audio.duration) ? audio.duration : next.durationMs / 1000);
      audio.currentTime = target;
      await waitForMedia(audio, () => !audio.seeking && Math.abs(audio.currentTime - target) < 0.5, 'seeked', controller.signal);
      if (!active()) return null;
      audio.playbackRate = next.speed; audio.loop = next.looping;
      mediaChanged();
      if (!restore || (restoreAttempt?.playing ?? restore.playing)) {
        const started = waitForMedia(audio, () => !audio.paused && audio.readyState >= 3, 'playing', controller.signal);
        await Promise.all([audio.play(), started]);
      }
      if (!active()) { if (mediaGeneration.current === preparedGeneration) audio.pause(); return null; }
      preparing.current = false; mediaRequest.current = null;
      queueReport();
      return next;
    } catch (error) {
      if (!mounted.current || currentEpoch !== epoch.current || controller?.signal.aborted) return null;
      deactivate();
      if (error instanceof RequestError && error.status === 401) clearAccount('登录已过期，请重新登录');
      else {
        if (error instanceof RequestError && error.status >= 400 && error.status < 500 && error.status !== 429 && error.status !== 408) {
          if (replayAttempt) pendingReplay.current = null;
          if (restoreAttempt) pendingRestore.current = null;
        }
        if (error instanceof RequestError && error.body.snapshot) applySnapshot(error.body.snapshot);
        setError(error instanceof RequestError ? error.message : '播放未成功，请再次点击播放。');
      }
      return null;
    } finally {
      if (mediaRequest.current === controller) { preparing.current = false; mediaRequest.current = null; }
      if (takingOver.current === currentEpoch) takingOver.current = null;
      if (mounted.current && currentEpoch === epoch.current) setBusy(false);
    }
  }

  async function playHere(mediaVersionId?: string, positionMs?: number): Promise<void> {
    if (takingOver.current !== null) return;
    if (mediaVersionId || pendingRestore.current) clearReturnPoint();
    await activateHere(mediaVersionId, positionMs);
  }

  async function replayCitation(mediaVersionId: string, startMs: number, endMs: number): Promise<void> {
    if (takingOver.current !== null || replayInFlight.current || !accountRef.current || !Number.isSafeInteger(endMs) || endMs <= startMs) return;
    const operationEpoch = epoch.current;
    replayInFlight.current = true;
    try {
      if (!ownsPlayback()) {
        const fresh = await request<{ snapshot: SyncedPlayback }>('/api/playback');
        if (!mounted.current || operationEpoch !== epoch.current) return;
        applySnapshot(fresh.snapshot);
        if (fresh.snapshot.state === 'playing' && Date.now() - Date.parse(fresh.snapshot.updatedAt) > 10000) {
          setError('另一设备的进度尚未更新，请稍后再回听。'); return;
        }
      }
      const current = snapshotRef.current;
      if (!current) return;
      const audio = player.current;
      const original = returnRef.current ?? pendingReplay.current?.original ?? {
        mediaVersionId: current.mediaVersionId, title: current.title || '原节目',
        positionMs: ownsPlayback() && audio ? Math.round(audio.currentTime * 1000) : current.positionMs,
        speed: ownsPlayback() && audio ? audio.playbackRate : current.speed,
        looping: ownsPlayback() && audio ? audio.loop : current.looping,
        playing: ownsPlayback() && audio ? !audio.paused && !audio.ended : current.state === 'playing',
        generation: current.generation, playbackSessionId: current.playbackSessionId || ''
      };
      replayTransition.current = true; replayEnd.current = null;
      pendingRestore.current = null;
      const previous = pendingReplay.current;
      const attempt = previous && previous.mediaVersionId === mediaVersionId && previous.positionMs === startMs && previous.endMs === endMs
        ? previous : { requestId: crypto.randomUUID(), expectedGeneration: current.generation, mediaVersionId, positionMs: startMs, endMs, original };
      pendingReplay.current = attempt;
      const next = await activateHere(mediaVersionId, startMs, undefined, attempt);
      if (operationEpoch !== epoch.current || !mounted.current) return;
      if (!next?.playbackSessionId || !ownsPlayback()) {
        returnRef.current = null; setReturnPoint(null); replayEnd.current = null;
        if (pendingReplay.current) setError('回听尚未确认，可再次点击同一引用重试；原来的返回位置已保留。');
        return;
      }
      const saved = { ...original, generation: next.generation, playbackSessionId: next.playbackSessionId };
      pendingReplay.current = null;
      returnRef.current = saved; setReturnPoint(saved); replayEnd.current = endMs;
      mediaChanged();
    } catch (error) { if (operationEpoch === epoch.current) setError(message(error)); }
    finally {
      if (operationEpoch === epoch.current) { replayTransition.current = false; replayInFlight.current = false; }
    }
  }

  async function restorePlayback(): Promise<void> {
    const saved = returnRef.current;
    if (!saved || takingOver.current !== null) return;
    const operationEpoch = epoch.current;
    const existing = pendingRestore.current;
    const attempt: RestoreAttempt = existing && restoreAttemptMatches(saved, existing) ? existing : {
      requestId: crypto.randomUUID(), expectedGeneration: saved.generation, expectedPlaybackSessionId: saved.playbackSessionId,
      mediaVersionId: saved.mediaVersionId, positionMs: saved.positionMs, speed: saved.speed, looping: saved.looping, playing: saved.playing
    };
    pendingRestore.current = attempt;
    replayTransition.current = true; replayEnd.current = null;
    try {
      const restored = await activateHere(saved.mediaVersionId, saved.positionMs, saved, undefined, attempt);
      if (operationEpoch !== epoch.current || !mounted.current) return;
      if (restored && pendingRestore.current === attempt) clearReturnPoint();
      else if (pendingRestore.current === attempt && returnRef.current === saved) {
        setError('返回尚未确认，可再次点击返回按钮重试；原位置已保留。');
      }
    } finally {
      if (operationEpoch === epoch.current && mounted.current) {
        replayTransition.current = false;
        if (pendingRestore.current === null && returnRef.current === saved) clearReturnPoint();
      }
    }
  }

  async function continuePlayback(): Promise<void> {
    replayEnd.current = null;
    if (!ownsPlayback() || !player.current) return;
    try { await player.current.play(); queueReport(); }
    catch { setError('音频未能继续，请重新点击播放。'); }
  }

  function seek(seconds: number) {
    if (accountRef.current && !ownsPlayback()) return;
    if (!player.current) return;
    clearReturnPoint();
    const duration = accountRef.current ? (snapshotRef.current?.durationMs ?? 0) / 1000 : player.current.duration;
    player.current.currentTime = Math.min(Number.isFinite(duration) ? duration : 120, Math.max(0, seconds)); mediaChanged();
    // onSeeked uploads the actual position, after the seek has finished.
  }
  function setSpeed(speed: number) {
    if (accountRef.current && !ownsPlayback()) return;
    if (player.current) { player.current.playbackRate = speed; mediaChanged(true); }
  }
  function setLooping(looping: boolean) {
    if (accountRef.current && !ownsPlayback()) return;
    if (player.current) { player.current.loop = looping; mediaChanged(true); }
  }

  async function requestCode(email: string) {
    requireCookieLock();
    return request<{ challengeId: string; expiresIn: number; retryAfter: number; delivery: 'local' | 'smtp' }>('/api/auth/request-code', { email });
  }
  async function verifyCode(email: string, challengeId: string, code: string) {
    await withCookieLock(async () => {
      if (!mounted.current) return;
      const currentEpoch = epoch.current;
      const profile = await request<AccountSession>('/api/auth/verify-code', { email, challengeId, code, client: 'web', deviceName: '网页' });
      if (!mounted.current) return;
      accountChannel.current?.postMessage({ type: 'session-changed' });
      if (currentEpoch !== epoch.current) { await reloadAccount(); return; }
      openAccount(profile);
    });
  }
  async function logout() {
    const intendedSessionId = accountRef.current?.session.id;
    ++epoch.current;
    stopConnection(); setBusy(true); setConnection('正在退出…');
    try {
      await withCookieLock(async () => {
        if (!mounted.current) return;
        const currentEpoch = ++epoch.current;
        stopConnection(); setBusy(true); setConnection('正在退出…');
        try {
          const currentProfile = await request<AccountSession>('/api/auth/me');
          if (!mounted.current) return;
          // A different tab may have logged in while this logout waited for
          // the cookie lock. Never revoke that newer session on an old click.
          if (!intendedSessionId || currentProfile.session.id !== intendedSessionId) {
            await reloadAccount();
            return;
          }
          await request('/api/auth/logout', {});
          if (!mounted.current) return;
          accountChannel.current?.postMessage({ type: 'session-changed' });
          if (currentEpoch === epoch.current) { clearAccount(); setError(''); }
          else await reloadAccount();
        } catch (error) {
          if (!mounted.current || currentEpoch !== epoch.current) return;
          if (error instanceof RequestError && error.status === 401) clearAccount();
          else { setError('播放已停止，退出尚未确认，请重试退出。'); setConnection('已停止同步'); }
        }
      });
    } catch (error) {
      if (mounted.current) { setError(message(error)); setConnection('已停止同步'); }
    } finally { if (mounted.current) setBusy(false); }
  }

  function reconnect() {
    if (accountRef.current) openAccount(accountRef.current);
  }
  async function refreshPlayback() {
    const currentEpoch = epoch.current;
    try {
      const result = await request<{ snapshot: SyncedPlayback }>('/api/playback');
      if (mounted.current && currentEpoch === epoch.current) applySnapshot(result.snapshot);
    } catch (error) {
      if (mounted.current && currentEpoch === epoch.current) setError(message(error));
    }
  }

  useEffect(() => {
    mounted.current = true;
    const channel = new BroadcastChannel('yuqu-account-v1');
    accountChannel.current = channel;
    channel.onmessage = event => { if (event.data?.type === 'session-changed' && mounted.current) void reloadAccount(); };
    void reloadAccount();
    const timer = setInterval(() => {
      setNow(Date.now());
      if (ownsPlayback() && !player.current?.paused) queueReport();
      else if (unconfirmed.current || pending.current) flushRef.current();
    }, 3000);
    return () => {
      mounted.current = false; ++epoch.current;
      cancelRecovery();
      ++mediaGeneration.current; mediaRequest.current?.abort(); mediaRequest.current = null; preparing.current = false;
      channel.close(); accountChannel.current = null;
      sourceRef.current?.close(); sourceRef.current = null; connected.current = false;
      activationRef.current = null; pending.current = false; unconfirmed.current = null; player.current?.pause(); clearInterval(timer);
    };
  }, [player]);

  const own = !!account && !!activation && snapshot?.ownerSessionId === account.session.id &&
    activation.generation === snapshot.generation && activation.playbackSessionId === snapshot.playbackSessionId;
  const following = !!account && !own;
  const view = (following || busy) && snapshot ? {
    position: snapshot.positionMs / 1000, duration: snapshot.durationMs / 1000, speed: snapshot.speed,
    looping: snapshot.looping, playing: snapshot.state === 'playing'
  } : local;
  const stale = !!account && !!snapshot && snapshot.state === 'playing' && now - Date.parse(snapshot.updatedAt) > 10000;
  return { account, snapshot, loading, busy, error, setError, connection, own, following, view, stale,
    canControl: !loading && (!account || own), mediaChanged, playHere, seek, setSpeed, setLooping,
    requestCode, verifyCode, logout, reconnect, refreshPlayback, replayCitation, restorePlayback, continuePlayback, returnPoint, clearReturnPoint };
}
