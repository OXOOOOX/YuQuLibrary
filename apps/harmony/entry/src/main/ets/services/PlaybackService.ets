import { common, wantAgent, WantAgent } from '@kit.AbilityKit';
import { audio } from '@kit.AudioKit';
import { preferences } from '@kit.ArkData';
import { avSession } from '@kit.AVSessionKit';
import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { media } from '@kit.MediaKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { PlaybackCacheDownload } from './PlaybackCache';
import { DiagnosticReport, PlaybackDiagnostics } from './DiagnosticReport';

const SAMPLE_FILE: string = 'playback-check.wav';
const LOG_LIMIT: number = 18;
const RECONNECT_DELAYS_MS: number[] = [0, 2000, 8000];
const STABLE_PLAYBACK_MS: number = 15000;

interface RecoveryPoint {
  generation: number;
  positionMs: number;
  rate: number;
  looping: boolean;
}

class PlaybackSourceError extends Error {
  readonly code: number;
  readonly retryPrepare: boolean;
  constructor(code: number, preparing: boolean = false) {
    super('播放器读取音频失败');
    this.code = code;
    this.retryPrepare = preparing && code === 5400102;
  }
}

function retryablePlaybackError(code: number): boolean {
  return code === 5400103 || code === 5400104 || (code >= 5411001 && code <= 5411004);
}

export interface PlaybackViewState {
  mediaVersionId: string;
  contentId: string;
  title: string;
  buffering: boolean;
  recovering: boolean;
  cacheEnabled: boolean;
  cacheStatus: string;
  cachePercent: number;
  ready: boolean;
  busy: boolean;
  playerState: string;
  positionMs: number;
  durationMs: number;
  rate: number;
  looping: boolean;
  backgroundActive: boolean;
  backgroundStatus: string;
  foreground: boolean;
  error: string;
  diagnosticIncidentId: string;
  events: string[];
}

type PlaybackListener = (state: PlaybackViewState) => void;

export class PlaybackService {
  private static readonly instance: PlaybackService = new PlaybackService();
  private context: common.UIAbilityContext | undefined = undefined;
  private player: media.AVPlayer | undefined = undefined;
  private session: avSession.AVSession | undefined = undefined;
  private retiringPlayer: media.AVPlayer | undefined = undefined;
  private retiringSession: avSession.AVSession | undefined = undefined;
  private launchAgent: WantAgent | undefined = undefined;
  private rawFileOpen: boolean = false;
  private closing: boolean = false;
  private lifecycleGeneration: number = 0;
  private diagnosticGeneration: number = -1;
  private diagnostics: PlaybackDiagnostics = new PlaybackDiagnostics();
  private commandQueue: Promise<void> = Promise.resolve();
  private sessionQueue: Promise<void> = Promise.resolve();
  private pendingCommands: number = 0;
  private lastSessionUpdate: number = 0;
  private listeners: PlaybackListener[] = [];
  private prepareResolve: (() => void) | undefined = undefined;
  private prepareReject: ((error: Error) => void) | undefined = undefined;
  private prepareTimer: number = -1;
  private sourceUrl: string = '';
  private sourceToken: string = '';
  private pendingCache?: PlaybackCacheDownload;
  private playingCache?: PlaybackCacheDownload;
  private cachedSource?: media.AVFileDescriptor;
  private cancelCacheWait?: () => void;
  private failRecoveryWait?: (error: Error) => void;
  private recovery?: RecoveryPoint;
  private failedPlayer?: media.AVPlayer;
  private recoveringPlayer?: media.AVPlayer;
  private recoveryTimer: number = -1;
  private recoveryAttempts: number = 0;
  private stableSince: number = 0;
  private stablePositionMs: number = 0;
  private wantsPlayback: boolean = false;
  private recoveryAllowed?: () => boolean;
  private switchingFrom?: media.AVPlayer;
  private pendingSeek?: number;
  private seekTimer: number = -1;
  private confirmedSeekAt: number = -1;
  private confirmedSeekMs: number = 0;
  private divergentSince: number = -1;
  private divergentSamples: number = 0;
  private pendingRate?: number;
  private playbackAllowed: (() => boolean) | undefined = undefined;
  private state: PlaybackViewState = {
    mediaVersionId: 'fixture-pcm-v1', contentId: 'yuqu-playback-check-v1',
    title: '两分钟播放验证音频', buffering: false, recovering: false, cacheEnabled: false, cacheStatus: 'idle', cachePercent: 0,
    ready: false, busy: false, playerState: 'idle', positionMs: 0,
    durationMs: 0, rate: 1, looping: false, backgroundActive: false,
    backgroundStatus: '未申请', foreground: true, error: '', diagnosticIncidentId: '', events: []
  };

  private constructor() {}

  static getInstance(): PlaybackService {
    return PlaybackService.instance;
  }

  getSnapshot(): PlaybackViewState {
    return {
      mediaVersionId: this.state.mediaVersionId, contentId: this.state.contentId,
      title: this.state.title, buffering: this.state.buffering, recovering: this.state.recovering,
      cacheEnabled: this.state.cacheEnabled, cacheStatus: this.state.cacheStatus, cachePercent: this.state.cachePercent,
      ready: this.state.ready, busy: this.state.busy,
      playerState: this.state.playerState, positionMs: this.state.positionMs,
      durationMs: this.state.durationMs, rate: this.state.rate,
      looping: this.state.looping, backgroundActive: this.state.backgroundActive,
      backgroundStatus: this.state.backgroundStatus, foreground: this.state.foreground,
      error: this.state.error, diagnosticIncidentId: this.diagnostics.incidentId, events: this.state.events.slice()
    };
  }

  getDiagnosticReport(): DiagnosticReport | undefined {
    return this.diagnostics.snapshot();
  }

  clearDiagnosticReports(): void {
    const hadReport = this.diagnostics.incidentId.length > 0;
    this.diagnosticGeneration = -1;
    this.diagnostics.reset();
    if (hadReport) this.emit();
  }

  subscribe(listener: PlaybackListener): () => void {
    this.listeners.push(listener);
    listener(this.getSnapshot());
    return () => {
      const index: number = this.listeners.indexOf(listener);
      if (index >= 0) {
        this.listeners.splice(index, 1);
      }
    };
  }

  setPlaybackPermission(check: () => boolean, recover?: () => boolean): void {
    this.playbackAllowed = check;
    this.recoveryAllowed = recover ?? check;
  }

  setPlaybackCacheEnabled(enabled: boolean): void {
    this.state.cacheEnabled = enabled;
    if (!enabled) this.cancelPendingCache();
    else if (this.state.playerState === 'playing') this.startCache();
    this.emit();
    if (this.context === undefined) return;
    try {
      const store = preferences.getPreferencesSync(this.context, { name: 'playback' });
      store.putSync('cacheCurrentEpisode', enabled);
      void store.flush().catch(() => { this.log('本次设置已生效，设备未能保存偏好'); });
    } catch (_error) { this.log('本次设置已生效，设备未能保存偏好'); }
  }

  initialize(context: common.UIAbilityContext): Promise<void> {
    if (this.player !== undefined && !this.closing) {
      return Promise.resolve();
    }
    const generation: number = ++this.lifecycleGeneration;
    return this.enqueue('初始化', async () => {
      if (generation !== this.lifecycleGeneration) {
        return;
      }
      this.closing = false;
      this.context = context;
      try {
        const store = preferences.getPreferencesSync(context, { name: 'playback' });
        this.state.cacheEnabled = store.getSync('cacheCurrentEpisode', false) === true;
      } catch (_error) { this.state.cacheEnabled = false; }
      if (this.player !== undefined) {
        return;
      }
      await this.createResources(generation);
    }, true);
  }

  reload(): Promise<void> {
    return this.loadFixture();
  }

  loadFixture(): Promise<void> {
    return this.loadMedia('yuqu-playback-check-v1', 'fixture-pcm-v1', '两分钟播放验证音频');
  }

  cancelMediaLoading(): void {
    this.clearPendingSeek();
    this.cancelRecovery();
    this.cancelPendingCache();
    if (this.state.ready && this.playingCache === undefined) return;
    this.state.ready = false;
    ++this.lifecycleGeneration;
    this.finishPreparing(new Error('已取消音频加载'));
    void this.enqueue('取消加载', async () => { await this.disposeResources(); });
  }

  async loadMedia(contentId: string, mediaVersionId: string, title: string,
    baseUrl: string = '', token: string = ''): Promise<void> {
    const fixture: boolean = mediaVersionId === 'fixture-pcm-v1' && contentId === 'yuqu-playback-check-v1';
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(mediaVersionId) || !/^[A-Za-z0-9_-]{1,100}$/.test(contentId)) {
      throw new Error('音频标识无效');
    }
    if (!fixture && (!/^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/.test(baseUrl) &&
      !/^http:\/\/(127\.0\.0\.1|localhost)(:[0-9]{1,5})?$/.test(baseUrl))) {
      throw new Error('音频服务地址无效');
    }
    if (!fixture && token.length === 0) throw new Error('请先登录后播放资料');
    const sourceUrl = fixture ? '' : `${baseUrl}/api/media/${encodeURIComponent(mediaVersionId)}`;
    if (this.state.ready && this.state.mediaVersionId === mediaVersionId && this.sourceToken === token && this.sourceUrl === sourceUrl) {
      if (token.length === 0 && this.diagnosticGeneration !== -1) this.clearDiagnosticReports();
      if (token.length > 0 && this.diagnosticGeneration !== this.lifecycleGeneration) {
        this.diagnosticGeneration = this.lifecycleGeneration;
        this.diagnostics.reset(mediaVersionId);
        this.diagnostics.record(this.state.foreground ? 'foreground' : 'background', this.state.positionMs);
      }
      return;
    }
    const generation: number = ++this.lifecycleGeneration;
    this.diagnostics.reset();
    this.diagnosticGeneration = token.length > 0 ? generation : -1;
    this.cancelRecovery();
    this.recoveryAttempts = 0;
    this.cancelPendingCache();
    this.finishPreparing(new Error('已切换音频，取消旧加载'));
    this.state.ready = false;
    this.state.buffering = false;
    this.emit();
    await this.enqueue('加载音频', async () => {
      this.assertLive(generation);
      await this.disposeResources();
      this.assertLive(generation);
      this.sourceUrl = sourceUrl;
      this.sourceToken = token;
      this.state.mediaVersionId = mediaVersionId;
      this.state.contentId = contentId;
      this.state.title = title.slice(0, 300);
      if (this.diagnosticGeneration === generation) {
        this.diagnostics.reset(mediaVersionId);
        this.diagnostics.record(this.state.foreground ? 'foreground' : 'background', 0);
      }
      this.state.error = '';
      this.state.looping = false;
      await this.createResources(generation);
    });
    this.assertLive(generation);
    if (!this.state.ready || this.state.mediaVersionId !== mediaVersionId) throw new Error('音频加载失败，请重试');
  }

  play(): Promise<void> {
    const generation: number = this.lifecycleGeneration;
    return this.enqueue('播放', async () => {
      if (this.playbackAllowed !== undefined && !this.playbackAllowed()) throw new Error('请在鱼趣中确认接管后播放');
      const player: media.AVPlayer = this.requirePlayer();
      if (player.state === 'playing') {
        return;
      }
      if (player.state !== 'prepared' && player.state !== 'paused' && player.state !== 'completed') {
        throw new Error('音频尚未准备好，请等待加载完成。');
      }
      this.wantsPlayback = true;
      await player.play();
      this.assertLive(generation);
      try {
        await this.startBackgroundTask();
        this.assertLive(generation);
      } catch (error) {
        // A failed background request must not look like a successful lock-screen test.
        await this.pauseInternal();
        throw error as Error;
      }
      await this.syncSession();
      this.startCache();
    });
  }

  pause(): Promise<void> {
    this.cancelRecovery();
    return this.enqueue('暂停', async () => {
      await this.pauseInternal();
    });
  }

  seek(positionMs: number): Promise<void> {
    return this.enqueue('跳转', async () => {
      const player: media.AVPlayer = this.requirePlayer();
      this.requireSeekable(player);
      const target: number = Math.round(Math.max(0, Math.min(positionMs, player.duration)));
      this.clearPendingSeek();
      this.pendingSeek = target;
      this.diagnostics.record('seek', target);
      const generation = this.lifecycleGeneration;
      this.seekTimer = setTimeout(() => {
        if (generation !== this.lifecycleGeneration || this.player !== player || this.pendingSeek !== target) return;
        this.stopAtTrustedPosition(player, '跳转未获确认，已保留上次进度，可重新播放本期。');
      }, 15000);
      try { player.seek(target, media.SeekMode.SEEK_CLOSEST); }
      catch (error) { this.clearPendingSeek(); throw error as Error; }
      // seekDone supplies the actual position; do not invent a completed seek here.
    });
  }

  setRate(rate: number): Promise<void> {
    return this.enqueue('调整倍速', async () => {
      const player: media.AVPlayer = this.requirePlayer();
      this.requireSeekable(player);
      this.pendingRate = rate;
      try { player.setSpeed(this.speedEnum(rate)); }
      catch (error) { this.pendingRate = undefined; throw error as Error; }
    });
  }

  setLooping(looping: boolean): Promise<void> {
    return this.enqueue('循环设置', async () => {
      const player: media.AVPlayer = this.requirePlayer();
      player.loop = looping;
      this.state.looping = looping;
      this.log(looping ? '已开启循环，适合持续锁屏测试' : '已关闭循环');
    });
  }

  setForeground(foreground: boolean): void {
    if (this.state.foreground !== foreground) {
      this.diagnostics.record(foreground ? 'foreground' : 'background', this.state.positionMs);
    }
    this.state.foreground = foreground;
    this.log(foreground ? '应用回到前台' : '应用进入后台，保持播放器和媒体会话');
  }

  release(): Promise<void> {
    this.closing = true;
    this.clearDiagnosticReports();
    this.cancelRecovery();
    this.cancelPendingCache();
    this.lifecycleGeneration += 1;
    this.finishPreparing(new Error('应用正在退出。'));
    return this.enqueue('释放', async () => {
      await this.disposeResources();
      this.context = undefined;
      this.state.ready = false;
      this.state.playerState = 'released';
      this.log('播放资源已释放');
    }, true);
  }

  private enqueue(label: string, work: () => Promise<void>, allowClosing: boolean = false): Promise<void> {
    const generation: number = this.lifecycleGeneration;
    this.pendingCommands += 1;
    this.state.busy = true;
    this.emit();
    const operation: Promise<void> = this.commandQueue.then(async () => {
      if ((this.closing && !allowClosing) || generation !== this.lifecycleGeneration) {
        return;
      }
      const previousIncident = this.diagnostics.incidentId;
      try {
        await work();
      } catch (error) {
        if (generation === this.lifecycleGeneration) {
          const failure = error as BusinessError;
          if (previousIncident === this.diagnostics.incidentId && (label === '加载音频' ||
            (failure.code !== undefined && (label === '播放' || label === '暂停' || label === '跳转')))) {
            this.diagnostics.fail(this.state.positionMs, false, failure.code);
          }
          this.reportError(label, failure);
        }
      } finally {
        this.emit();
      }
    }).finally(() => {
      this.pendingCommands -= 1;
      this.state.busy = this.pendingCommands > 0;
      this.emit();
    });
    this.commandQueue = operation;
    return operation;
  }

  private async createResources(generation: number): Promise<void> {
    this.assertLive(generation);
    const context: common.UIAbilityContext | undefined = this.context;
    if (context === undefined) {
      throw new Error('应用上下文不可用。');
    }
    this.state.ready = false;
    this.state.positionMs = 0;
    this.state.buffering = false;
    this.state.rate = 1;
    try {
      const player: media.AVPlayer = await media.createAVPlayer();
      this.player = player;
      this.assertLive(generation);
      this.bindPlayer(player, generation);
      const agentInfo: wantAgent.WantAgentInfo = {
        wants: [{ bundleName: context.abilityInfo.bundleName, abilityName: context.abilityInfo.name }],
        actionType: wantAgent.OperationType.START_ABILITY,
        requestCode: 0,
        actionFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
      };
      const launchAgent: WantAgent = await wantAgent.getWantAgent(agentInfo);
      this.launchAgent = launchAgent;
      this.assertLive(generation);
      const session: avSession.AVSession = await avSession.createAVSession(context, 'yuqu-player', 'audio');
      this.session = session;
      this.assertLive(generation);
      await session.setLaunchAbility(launchAgent);
      this.assertLive(generation);
      session.on('play', () => {
        if (this.session === session && generation === this.lifecycleGeneration) { void this.play(); }
      });
      session.on('pause', () => {
        if (this.session === session && generation === this.lifecycleGeneration) { void this.pause(); }
      });
      session.on('seek', (time: number) => {
        if (this.session === session && generation === this.lifecycleGeneration) { void this.seek(time); }
      });
      session.on('setSpeed', (speed: number) => {
        if (this.session === session && generation === this.lifecycleGeneration) { void this.setRate(speed); }
      });
      await session.activate();
      this.assertLive(generation);
      let fileSource: media.AVFileDescriptor | undefined = undefined;
      if (this.sourceUrl.length === 0) {
        const descriptor = await context.resourceManager.getRawFd(SAMPLE_FILE);
        this.rawFileOpen = true;
        this.assertLive(generation);
        fileSource = { fd: descriptor.fd, offset: descriptor.offset, length: descriptor.length };
      }
      await new Promise<void>((resolve, reject) => {
        this.prepareResolve = resolve;
        this.prepareReject = reject;
        this.prepareTimer = setTimeout(() => {
          this.finishPreparing(new Error('音频准备超时，请检查网络后重试。'));
        }, 20000);
        if (this.sourceUrl.length > 0) {
          void this.setNetworkSource(player).catch((error: BusinessError) => {
            if (this.isCurrentPlayer(player, generation)) this.finishPreparing(error);
          });
        } else if (fileSource !== undefined) player.fdSrc = fileSource;
      });
      this.assertLive(generation);
      player.loop = this.state.looping;
      this.state.durationMs = player.duration;
      const metadata: avSession.AVMetadata = {
        assetId: this.state.mediaVersionId,
        title: this.state.title,
        artist: '鱼趣知识库',
        duration: player.duration
      };
      await session.setAVMetadata(metadata);
      this.assertLive(generation);
      await this.syncSession();
      this.assertLive(generation);
      this.state.ready = true;
      this.log('音频已准备，请主动点击播放');
    } catch (error) {
      await this.disposeResources();
      throw error as Error;
    }
  }

  private setNetworkSource(player: media.AVPlayer): Promise<void> {
    const headers: Record<string, string> = { 'Authorization': `Bearer ${this.sourceToken}` };
    const source = media.createMediaSourceWithUrl(this.sourceUrl, headers);
    // Some system builds return void. Readiness comes from stateChange and prepare.
    return Promise.resolve(player.setMediaSource(source, {}));
  }

  private cancelPendingCache(): void {
    const pending = this.pendingCache;
    this.pendingCache = undefined;
    pending?.cancel();
    this.cancelCacheWait?.();
    if (this.playingCache === undefined) {
      this.state.cacheStatus = 'idle';
      this.state.cachePercent = 0;
    }
  }

  private startCache(): void {
    if (!this.state.cacheEnabled || !this.state.ready || this.state.playerState !== 'playing' ||
      this.context === undefined || !this.sourceUrl || this.closing || this.pendingCache || this.playingCache ||
      (this.playbackAllowed !== undefined && !this.playbackAllowed())) return;
    const download = new PlaybackCacheDownload();
    this.pendingCache = download;
    this.state.cacheStatus = 'downloading';
    this.state.cachePercent = 0;
    this.emit();
    void this.cacheCurrent(download, this.lifecycleGeneration, this.context.cacheDir);
  }

  private async cacheCurrent(download: PlaybackCacheDownload, generation: number, directory: string): Promise<void> {
    let next: media.AVPlayer | undefined = undefined;
    let adopted = false;
    try {
      const source = await download.read(directory, this.sourceUrl, this.sourceToken, (percent: number) => {
        if (this.pendingCache !== download) return;
        this.state.cachePercent = Math.min(99, percent);
        this.emit();
      });
      if (this.pendingCache !== download) return;
      const candidate = await media.createAVPlayer();
      next = candidate;
      if (this.pendingCache !== download) return;
      // Prepare a silent local player while the network player keeps sounding.
      await this.prepareCandidate(candidate, source, false);
      if (this.pendingCache !== download) return;
      await this.enqueue('切换本地音频', async () => {
        try { await this.activateCachedPlayer(candidate, download, source, generation); }
        catch (_error) { /* Keep the network player and report a cache-only failure below. */ }
        adopted = this.playingCache === download;
      });
    } catch (_error) {
      // Storage, network or decoder failure must not interrupt the original stream.
    } finally {
      if (!adopted) {
        try { if (next !== undefined) await next.release(); } catch (_error) { /* The candidate was never published. */ }
        try { download.close(); } catch (_error) { this.log('临时缓存文件关闭失败'); }
      }
      if (this.pendingCache === download) {
        this.pendingCache = undefined;
        if (!adopted) { this.state.cacheStatus = 'failed'; this.state.cachePercent = 0; }
        this.emit();
      }
    }
  }

  private prepareCandidate(player: media.AVPlayer, source: media.AVFileDescriptor | undefined, recovery: boolean): Promise<void> {
    return this.waitPlayerEvent(player, (done, fail) => {
      player.on('stateChange', (state: string) => {
        if (state === 'initialized') void this.preparePlayer(player).then(done, fail);
      });
      if (source !== undefined) player.fdSrc = source;
      else void this.setNetworkSource(player).catch(fail);
    }, () => { player.off('stateChange'); }, recovery);
  }

  private waitPlayerEvent(player: media.AVPlayer, begin: (done: () => void, fail: (error: Error) => void) => void,
    detach: () => void, recovery: boolean = false): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (recovery) this.failRecoveryWait = undefined;
        else this.cancelCacheWait = undefined;
        detach();
        if (!recovery) player.off('error');
        if (error === undefined) resolve(); else reject(error);
      };
      const timer = setTimeout(() => { finish(new Error('等待播放器响应超时')); }, recovery ? 15000 : 8000);
      const cancel = (): void => { finish(new Error('已取消音频准备')); };
      if (recovery) this.failRecoveryWait = (error: Error) => { finish(error); };
      else {
        this.cancelCacheWait = cancel;
        player.on('error', (error: BusinessError) => { finish(error); });
      }
      try { begin(() => { finish(); }, (error: Error) => { finish(error); }); }
      catch (error) { finish(error as Error); }
    });
  }

  private async activateCachedPlayer(next: media.AVPlayer, download: PlaybackCacheDownload, source: media.AVFileDescriptor, generation: number): Promise<void> {
    const previous = this.player;
    if (previous === undefined || this.pendingCache !== download || !this.isCurrentPlayer(previous, generation) ||
      (this.playbackAllowed !== undefined && !this.playbackAllowed())) return;
    const resume = previous.state === 'playing';
    const wasCompleted = previous.state === 'completed';
    this.switchingFrom = previous;
    try {
      if (resume) await previous.pause();
      if (this.pendingCache !== download) return;
      const currentTime = this.confirmedSeekAt < 0 && Number.isFinite(previous.currentTime) ? previous.currentTime : this.state.positionMs;
      const position = Math.max(0, Math.min(next.duration, this.pendingSeek ?? currentTime));
      let confirmed = 0;
      const rate = this.pendingRate ?? this.state.rate;
      next.loop = this.state.looping;
      if (position > 0 && !wasCompleted) {
        await this.waitPlayerEvent(next, (done, fail) => {
          next.on('seekDone', (time: number) => {
            if (!Number.isFinite(time) || Math.abs(time - position) > 1500) { fail(new Error('本地音频定位失败')); return; }
            confirmed = time;
            done();
          });
          next.seek(position, media.SeekMode.SEEK_CLOSEST);
        }, () => { next.off('seekDone'); });
      }
      if (this.pendingCache !== download) return;
      if (rate !== 1) {
        await this.waitPlayerEvent(next, (done) => {
          next.on('speedDone', () => { done(); });
          next.setSpeed(this.speedEnum(rate));
        }, () => { next.off('speedDone'); });
      }
      if (this.pendingCache !== download || (this.playbackAllowed !== undefined && !this.playbackAllowed())) return;
      if (resume && this.wantsPlayback) await next.play();
      if (next.state === 'playing' && !this.wantsPlayback) await next.pause();
      if (this.pendingCache !== download || (this.playbackAllowed !== undefined && !this.playbackAllowed())) {
        if (next.state === 'playing') await next.pause();
        return;
      }
      this.player = next;
      this.bindPlayer(next, generation);
      this.playingCache = download;
      this.cachedSource = source;
      this.state.playerState = wasCompleted ? 'completed' : next.state;
      this.confirmSeek(wasCompleted ? next.duration : confirmed);
      this.state.rate = rate;
      this.pendingRate = undefined;
      this.clearPendingSeek();
      this.state.buffering = false;
      this.state.cacheStatus = 'ready';
      this.state.cachePercent = 100;
      this.emit();
      await previous.release();
      await this.syncSession();
    } finally {
      this.switchingFrom = undefined;
      if (resume && this.wantsPlayback && this.isCurrentPlayer(previous, generation) && this.player?.state === 'paused' &&
        (this.playbackAllowed === undefined || this.playbackAllowed())) await previous.play();
    }
  }

  private bindPlayer(player: media.AVPlayer, generation: number, interruptionsBound: boolean = false): void {
    player.on('stateChange', (state: string) => {
      if (!this.isCurrentPlayer(player, generation)) {
        return;
      }
      this.state.playerState = state;
      if (state === 'playing' || state === 'paused') {
        this.diagnostics.record(state === 'playing' ? 'play' : 'pause', this.state.positionMs);
      }
      if (state !== 'playing') this.divergentSince = -1;
      this.log(`播放器状态：${state}`);
      if (state === 'initialized') {
        this.preparePlayer(player).then(() => {
          if (this.isCurrentPlayer(player, generation)) {
            this.finishPreparing();
          }
        }).catch((error: BusinessError) => {
          if (this.isCurrentPlayer(player, generation)) {
            this.finishPreparing(error);
          }
        });
      } else if (state === 'completed') {
        this.wantsPlayback = false;
        this.clearPendingSeek();
        this.confirmedSeekAt = -1;
        if (player.duration > 0) this.state.positionMs = player.duration;
        void this.enqueue('播放结束', async () => {
          if (!this.isCurrentPlayer(player, generation) || player.state !== 'completed') { return; }
          await this.stopBackgroundTask();
          await this.syncSession();
        });
      }
      void this.syncSession();
    });
    player.on('durationUpdate', (duration: number) => {
      if (!this.isCurrentPlayer(player, generation)) { return; }
      this.state.durationMs = Math.max(0, duration);
      this.emit();
    });
    player.on('timeUpdate', (time: number) => {
      if (!this.isCurrentPlayer(player, generation)) { return; }
      if (!this.trustTimeUpdate(time, player)) return;
      if (this.recoveryAttempts > 0 && this.wantsPlayback && player.state === 'playing' && this.pendingSeek === undefined) {
        if (this.stableSince === 0 || time < this.stablePositionMs) {
          this.stableSince = Date.now();
          this.stablePositionMs = time;
        } else if (Date.now() - this.stableSince >= STABLE_PLAYBACK_MS && time - this.stablePositionMs >= STABLE_PLAYBACK_MS) {
          this.recoveryAttempts = 0;
        }
      }
      this.state.positionMs = Math.max(0, time);
      this.emit();
      if (Date.now() - this.lastSessionUpdate >= 1000) {
        this.lastSessionUpdate = Date.now();
        void this.syncSession();
      }
    });
    player.on('seekDone', (time: number) => {
      if (!this.isCurrentPlayer(player, generation)) { return; }
      if (!Number.isFinite(time) || time < 0 || (this.pendingSeek !== undefined && Math.abs(time - this.pendingSeek) > 1500)) return;
      this.clearPendingSeek();
      this.stableSince = 0;
      this.confirmSeek(time);
      this.diagnostics.record('seek_done', this.state.positionMs);
      this.log(`跳转完成：${Math.round(time / 1000)} 秒`);
      void this.syncSession();
    });
    player.on('speedDone', (speed: number) => {
      if (!this.isCurrentPlayer(player, generation)) { return; }
      this.pendingRate = undefined;
      this.state.rate = this.speedRatio(speed);
      this.log(`倍速已生效：${this.state.rate}×`);
      void this.syncSession();
    });
    player.on('bufferingUpdate', (infoType: media.BufferingInfoType, _value: number) => {
      if (!this.isCurrentPlayer(player, generation)) return;
      if (infoType === media.BufferingInfoType.BUFFERING_START) {
        if (!this.state.buffering) this.diagnostics.record('buffer_start', this.state.positionMs);
        this.state.buffering = true;
        this.divergentSince = -1;
      }
      if (infoType === media.BufferingInfoType.BUFFERING_END) {
        if (this.state.buffering) this.diagnostics.record('buffer_end', this.state.positionMs);
        this.state.buffering = false;
      }
      this.emit();
    });
    if (!interruptionsBound) this.bindInterruptions(player, generation);
    player.on('error', (error: BusinessError) => {
      if (!this.isCurrentPlayer(player, generation)) return;
      const recover = this.state.ready && this.wantsPlayback && this.sourceUrl.length > 0 &&
        retryablePlaybackError(error.code) && this.recoveryAttempts < RECONNECT_DELAYS_MS.length &&
        (this.recoveryAllowed === undefined || this.recoveryAllowed());
      this.diagnostics.fail(this.state.positionMs, recover, error.code);
      this.failedPlayer = player;
      this.clearPendingSeek();
      this.state.ready = false;
      this.state.buffering = false;
      this.state.playerState = 'error';
      this.finishPreparing(error);
      if (recover) {
        const point: RecoveryPoint = { generation: generation, positionMs: this.state.positionMs,
          rate: this.pendingRate ?? this.state.rate, looping: this.state.looping };
        this.recovery = point;
        this.state.recovering = true;
        this.cancelPendingCache();
        this.state.error = '';
        this.log(`播放中断 (${error.code})，正在从上次位置重新连接`);
        this.scheduleRecovery(point);
      } else {
        this.wantsPlayback = false;
        this.reportError('播放器', error);
        void this.enqueue('处理播放错误', async () => {
          if (generation !== this.lifecycleGeneration || this.player !== player) return;
          await this.stopBackgroundTask();
          await this.syncSession();
        });
      }
    });
  }

  private bindInterruptions(player: media.AVPlayer, generation: number): void {
    player.on('audioInterrupt', (event: audio.InterruptEvent) => {
      if (this.closing || this.lifecycleGeneration !== generation || (this.player !== player && this.recoveringPlayer !== player)) return;
      this.log(`音频中断提示：${event.hintType}`);
      if (event.hintType === audio.InterruptHint.INTERRUPT_HINT_PAUSE ||
        event.hintType === audio.InterruptHint.INTERRUPT_HINT_STOP) {
        this.cancelRecovery();
        void this.enqueue('处理中断', async () => {
          if (this.closing || this.lifecycleGeneration !== generation) return;
          await this.pauseInternal();
          this.log('已因音频中断暂停，请手动继续播放');
        });
      } else if (event.hintType === audio.InterruptHint.INTERRUPT_HINT_RESUME) {
        this.log('音频焦点已可恢复；本验证页等待用户手动播放');
      }
    });
    player.on('audioOutputDeviceChangeWithInfo', (info: audio.AudioStreamDeviceChangeInfo) => {
      if (this.closing || this.lifecycleGeneration !== generation || (this.player !== player && this.recoveringPlayer !== player)) return;
      this.log(`输出设备变化：${info.changeReason}`);
      if (info.changeReason === audio.AudioStreamDeviceChangeReason.REASON_OLD_DEVICE_UNAVAILABLE) {
        this.cancelRecovery();
        void this.enqueue('耳机断开', async () => {
          if (this.closing || this.lifecycleGeneration !== generation) return;
          await this.pauseInternal();
          this.log('旧输出设备断开，已暂停，避免自动外放');
        });
      }
    });
  }

  private cancelRecovery(): void {
    this.wantsPlayback = false;
    this.stableSince = 0;
    if (this.recovery === undefined) return;
    this.diagnostics.endRecovery();
    this.recovery = undefined;
    this.state.recovering = false;
    this.state.error = '重连已停止，可重新播放本期。';
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = -1;
    this.failRecoveryWait?.(new Error('已取消重连'));
    this.emit();
  }

  private confirmSeek(time: number): void {
    this.state.positionMs = time;
    this.confirmedSeekAt = Date.now();
    this.confirmedSeekMs = time;
    this.divergentSince = -1;
  }

  private clearPendingSeek(): void {
    clearTimeout(this.seekTimer);
    this.seekTimer = -1;
    this.pendingSeek = undefined;
  }

  private stopAtTrustedPosition(player: media.AVPlayer, message: string): void {
    this.diagnostics.fail(this.state.positionMs, false);
    this.clearPendingSeek();
    this.failedPlayer = player;
    this.cancelRecovery();
    this.cancelPendingCache();
    this.state.ready = false;
    this.state.buffering = false;
    this.state.playerState = 'error';
    this.state.error = message;
    this.log(message);
    void this.enqueue('暂停未对齐的播放', async () => {
      if (this.player === player) await this.pauseInternal();
    });
  }

  private trustTimeUpdate(time: number, player: media.AVPlayer): boolean {
    if (!Number.isFinite(time) || time < 0 || this.pendingSeek !== undefined) return false;
    if (this.confirmedSeekAt < 0) return true;
    // AVPlayer can briefly publish the end of the file both before and just after seekDone.
    const elapsed = Math.max(0, Date.now() - this.confirmedSeekAt);
    const advance = time - this.confirmedSeekMs;
    const maxAdvance = elapsed * 2 + 1500; // Highest supported playback speed is 2x.
    const wrapped = this.state.looping && time <= 1500 && this.state.durationMs - this.confirmedSeekMs <= maxAdvance;
    if (!wrapped && (advance < -1500 || advance > maxAdvance)) {
      if (player.state === 'playing' && !this.state.buffering) {
        const now = Date.now();
        if (this.divergentSince < 0) { this.divergentSince = now; this.divergentSamples = 0; }
        this.divergentSamples++;
        if (this.divergentSamples >= 3 && now - this.divergentSince >= 5000) {
          this.stopAtTrustedPosition(player, '播放器持续偏离已确认的位置，已暂停，可从上次进度重新播放。');
        }
      }
      return false;
    }
    this.divergentSince = -1;
    if (wrapped || (elapsed >= 1000 && advance >= 2000)) this.confirmedSeekAt = -1;
    return true;
  }

  private recoveryLive(point: RecoveryPoint): boolean {
    return this.recovery === point && this.wantsPlayback && !this.closing &&
      point.generation === this.lifecycleGeneration && (this.recoveryAllowed === undefined || this.recoveryAllowed());
  }

  private scheduleRecovery(point: RecoveryPoint): void {
    // Keep a bad segment bounded, but allow later independent interruptions to recover.
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = -1;
      if (this.recovery !== point) return;
      void this.enqueue('恢复播放', async () => {
        try {
          if (!this.recoveryLive(point)) throw new Error('已取消重连');
          ++this.recoveryAttempts;
          this.diagnostics.record('retry', point.positionMs);
          await this.reconnect(point);
        } catch (error) {
          if (this.recovery !== point) return;
          const code = (error as BusinessError).code;
          const live = this.recoveryLive(point);
          if (live) this.diagnostics.record('error', point.positionMs, code);
          hilog.warn(0x1000, 'YuQuPlayback', 'Reconnect attempt=%{public}d error=%{public}d active=%{public}d',
            this.recoveryAttempts, code ?? -1, live ? 1 : 0);
          const transient = code === undefined || retryablePlaybackError(code) ||
            (error instanceof PlaybackSourceError && error.retryPrepare);
          if (live && this.recoveryAttempts < RECONNECT_DELAYS_MS.length && transient) {
            this.scheduleRecovery(point);
          } else {
            this.cancelRecovery();
            this.state.error = '播放中断，可重新播放本期。';
            this.log(this.state.error);
            await this.stopBackgroundTask();
            await this.syncSession();
          }
        }
      });
    }, RECONNECT_DELAYS_MS[this.recoveryAttempts]);
  }

  private async reconnect(point: RecoveryPoint): Promise<void> {
    // Release the previous decoder before reusing its local file descriptor.
    const old = this.player ?? this.retiringPlayer;
    if (old !== undefined) {
      this.retiringPlayer = old;
      await old.release();
      this.retiringPlayer = undefined;
      this.player = undefined;
      this.failedPlayer = undefined;
    }
    if (!this.recoveryLive(point)) throw new Error('已取消重连');
    const candidate = await media.createAVPlayer();
    this.recoveringPlayer = candidate;
    const source = this.recoveryAttempts === 1 ? this.cachedSource : undefined;
    let failure: BusinessError | undefined = undefined;
    let preparing = true;
    const check = (): void => {
      if (failure !== undefined) throw new PlaybackSourceError(failure.code, preparing);
      if (!this.recoveryLive(point)) throw new Error('已取消重连');
    };
    try {
      check();
      // Keep errors observable between seek, rate and play callbacks and while renewing background playback.
      candidate.on('error', (error: BusinessError) => {
        if (this.recoveringPlayer !== candidate) return;
        hilog.warn(0x1000, 'YuQuPlayback', 'Replacement decoder error=%{public}d', error.code);
        failure = error;
        this.failRecoveryWait?.(error);
      });
      this.bindInterruptions(candidate, point.generation);
      try {
        await this.prepareCandidate(candidate, source, true);
      } catch (error) {
        // On a truncated HTTP source the SDK may reject prepare with 5400102 instead of delivering its network error.
        if ((error as BusinessError).code === 5400102) throw new PlaybackSourceError(5400102, true);
        throw error as Error;
      }
      check();
      preparing = false;
      if (candidate.duration <= 0 || point.positionMs > candidate.duration + 1500) throw new Error('音频时长已改变');
      let confirmed = 0;
      candidate.loop = point.looping;
      if (point.positionMs > 0) {
        await this.waitPlayerEvent(candidate, (done, fail) => {
          candidate.on('seekDone', (time: number) => {
            if (!Number.isFinite(time) || Math.abs(time - point.positionMs) > 1500) { fail(new Error('未能恢复播放位置')); return; }
            confirmed = time;
            if (this.recoveryLive(point)) this.diagnostics.record('seek_done', time);
            done();
          });
          const target = Math.min(point.positionMs, candidate.duration);
          this.diagnostics.record('seek', target);
          candidate.seek(target, media.SeekMode.SEEK_CLOSEST);
        }, () => { candidate.off('seekDone'); }, true);
      }
      check();
      if (point.rate !== 1) {
        await this.waitPlayerEvent(candidate, (done, fail) => {
          candidate.on('speedDone', (value: number) => {
            if (this.speedRatio(value) === point.rate) done();
            else fail(new Error('未能恢复播放倍速'));
          });
          candidate.setSpeed(this.speedEnum(point.rate));
        }, () => { candidate.off('speedDone'); }, true);
      }
      check();
      await this.waitPlayerEvent(candidate, (done, fail) => {
        candidate.on('stateChange', (state: string) => { if (state === 'playing') done(); });
        void candidate.play().catch(fail);
      }, () => { candidate.off('stateChange'); }, true);
      check();
      await this.startBackgroundTask();
      check();
      if (candidate.state !== 'playing') throw new Error('播放器未能启动');
      if (source === undefined && this.playingCache !== undefined) {
        this.playingCache.close();
        this.playingCache = undefined;
        this.cachedSource = undefined;
        this.state.cacheStatus = 'idle';
        this.state.cachePercent = 0;
      }
      candidate.off('error');
      this.player = candidate;
      this.recovery = undefined;
      this.state.recovering = false;
      this.state.ready = true;
      this.confirmSeek(confirmed);
      this.diagnostics.record('resumed', confirmed);
      this.state.rate = point.rate;
      this.state.playerState = 'playing';
      this.stableSince = Date.now();
      this.stablePositionMs = confirmed;
      this.pendingRate = undefined;
      this.clearPendingSeek();
      this.bindPlayer(candidate, point.generation, true);
      this.log('已从中断位置继续播放');
      await this.syncSession();
      this.startCache();
    } finally {
      const adopted = this.player === candidate;
      try {
        if (!adopted) {
          this.retiringPlayer = candidate;
          await candidate.release();
          this.retiringPlayer = undefined;
        }
      } finally {
        this.recoveringPlayer = undefined;
        // A prepare/seek promise may reject for its current state before the native source error is delivered.
        if (!adopted) check();
      }
    }
  }

  private async preparePlayer(player: media.AVPlayer): Promise<void> {
    player.audioRendererInfo = { usage: audio.StreamUsage.STREAM_USAGE_MUSIC, rendererFlags: 0 };
    await player.prepare();
    // This setter is only valid once AVPlayer has reached prepared state.
    player.audioInterruptMode = audio.InterruptMode.SHARE_MODE;
  }

  private finishPreparing(error?: Error): void {
    if (this.prepareTimer >= 0) {
      clearTimeout(this.prepareTimer);
      this.prepareTimer = -1;
    }
    const resolve: (() => void) | undefined = this.prepareResolve;
    const reject: ((error: Error) => void) | undefined = this.prepareReject;
    this.prepareResolve = undefined;
    this.prepareReject = undefined;
    if (error !== undefined) {
      if (reject !== undefined) {
        reject(error);
      }
    } else if (resolve !== undefined) {
      resolve();
    }
  }

  private async pauseInternal(): Promise<void> {
    this.cancelRecovery();
    const player: media.AVPlayer | undefined = this.player;
    if (player !== undefined && player.state === 'playing') {
      // A forced interruption can pause the stream without updating AVPlayer.state.
      await player.pause();
    }
    await this.stopBackgroundTask();
    await this.syncSession();
  }

  private async startBackgroundTask(): Promise<void> {
    if (this.closing) {
      throw new Error('应用正在退出，取消后台播放申请。');
    }
    if (this.state.backgroundActive) {
      return;
    }
    const context: common.UIAbilityContext | undefined = this.context;
    const agent: WantAgent | undefined = this.launchAgent;
    if (context === undefined || agent === undefined) {
      throw new Error('后台播放上下文尚未准备。');
    }
    this.state.backgroundStatus = '申请中';
    this.emit();
    try {
      await backgroundTaskManager.startBackgroundRunning(context,
        backgroundTaskManager.BackgroundMode.AUDIO_PLAYBACK, agent);
      this.state.backgroundActive = true;
      this.state.backgroundStatus = '已申请';
      this.log('音频后台任务申请成功');
    } catch (error) {
      this.state.backgroundActive = false;
      this.state.backgroundStatus = '申请失败';
      throw error as Error;
    }
  }

  private async stopBackgroundTask(): Promise<void> {
    const context: common.UIAbilityContext | undefined = this.context;
    if (!this.state.backgroundActive || context === undefined) {
      return;
    }
    this.state.backgroundStatus = '取消中';
    this.emit();
    try {
      await backgroundTaskManager.stopBackgroundRunning(context);
      this.state.backgroundActive = false;
      this.state.backgroundStatus = '已取消';
      this.log('音频后台任务已取消');
    } catch (error) {
      this.state.backgroundStatus = '取消失败，状态待核对';
      throw error as Error;
    }
  }

  private syncSession(): Promise<void> {
    const generation: number = this.lifecycleGeneration;
    const expected: avSession.AVSession | undefined = this.session;
    this.sessionQueue = this.sessionQueue.then(async () => {
      const session: avSession.AVSession | undefined = this.session;
      if (session === undefined || session !== expected || generation !== this.lifecycleGeneration || this.closing) {
        return;
      }
      let state: avSession.PlaybackState = avSession.PlaybackState.PLAYBACK_STATE_PAUSE;
      if (this.state.playerState === 'playing') {
        state = avSession.PlaybackState.PLAYBACK_STATE_PLAY;
      } else if (this.state.playerState === 'completed' || this.state.playerState === 'error') {
        state = avSession.PlaybackState.PLAYBACK_STATE_STOP;
      }
      await session.setAVPlaybackState({
        state: state,
        position: { elapsedTime: this.state.positionMs, updateTime: Date.now() },
        speed: this.state.rate
      });
    }).catch((error: BusinessError) => {
      this.reportError('媒体会话同步', error);
    });
    return this.sessionQueue;
  }

  private async disposeResources(): Promise<void> {
    this.cancelPendingCache();
    this.clearPendingSeek();
    this.confirmedSeekAt = -1;
    this.pendingRate = undefined;
    this.finishPreparing(new Error('播放资源已重置。'));
    this.state.ready = false;
    try {
      await this.stopBackgroundTask();
    } catch (error) {
      this.reportError('取消后台任务', error as BusinessError);
    }
    await this.sessionQueue;
    const player: media.AVPlayer | undefined = this.player === undefined ? this.retiringPlayer : this.player;
    this.player = undefined;
    this.retiringPlayer = player;
    if (player !== undefined) {
      try {
        player.off('stateChange');
        player.off('error');
        player.off('timeUpdate');
        player.off('durationUpdate');
        player.off('seekDone');
        player.off('speedDone');
        player.off('bufferingUpdate');
        player.off('audioInterrupt');
        player.off('audioOutputDeviceChangeWithInfo');
      } catch (error) {
        this.reportError('取消播放器监听', error as BusinessError);
      }
      try {
        await player.release();
        this.retiringPlayer = undefined;
        this.failedPlayer = undefined;
      } catch (error) {
        this.reportError('释放播放器', error as BusinessError);
      }
    }
    const session: avSession.AVSession | undefined = this.session === undefined ? this.retiringSession : this.session;
    this.session = undefined;
    this.retiringSession = session;
    if (session !== undefined) {
      try {
        session.off('play');
        session.off('pause');
        session.off('seek');
        session.off('setSpeed');
      } catch (error) {
        this.reportError('取消媒体会话监听', error as BusinessError);
      }
      try {
        await session.deactivate();
      } catch (error) {
        this.reportError('停止媒体会话', error as BusinessError);
      }
      try {
        await session.destroy();
        this.retiringSession = undefined;
      } catch (error) {
        this.reportError('释放媒体会话', error as BusinessError);
      }
    }
    // Keep the rawfile descriptor alive if player.release failed; a retry can finish cleanup.
    if (this.retiringPlayer === undefined && this.rawFileOpen && this.context !== undefined) {
      try {
        await this.context.resourceManager.closeRawFd(SAMPLE_FILE);
        this.rawFileOpen = false;
      } catch (error) {
        this.reportError('关闭音频资源', error as BusinessError);
      }
    }
    if (this.retiringPlayer === undefined && this.playingCache !== undefined) {
      this.playingCache.close();
      this.playingCache = undefined;
      this.cachedSource = undefined;
      this.state.cacheStatus = 'idle';
      this.state.cachePercent = 0;
    }
    this.launchAgent = undefined;
    this.state.playerState = 'idle';
    this.state.positionMs = 0;
    this.state.durationMs = 0;
    this.state.buffering = false;
    this.emit();
    if (this.state.backgroundActive) {
      throw new Error('后台任务取消失败，请重试清理，暂不创建新的播放器。');
    }
    if (this.retiringPlayer !== undefined || this.retiringSession !== undefined || this.rawFileOpen) {
      throw new Error('播放资源尚未完全释放，请重试清理，暂不创建新的播放器。');
    }
  }

  private assertLive(generation: number): void {
    if (this.closing || generation !== this.lifecycleGeneration) {
      throw new Error('播放初始化已因应用退出而取消。');
    }
  }

  private isCurrentPlayer(player: media.AVPlayer, generation: number): boolean {
    return !this.closing && generation === this.lifecycleGeneration && this.player === player &&
      this.switchingFrom !== player && this.failedPlayer !== player;
  }

  private requirePlayer(): media.AVPlayer {
    if (this.player === undefined || !this.state.ready) {
      throw new Error('播放器尚未就绪，请等待或重新加载样本。');
    }
    return this.player;
  }

  private requireSeekable(player: media.AVPlayer): void {
    if (player.state !== 'prepared' && player.state !== 'playing' &&
      player.state !== 'paused' && player.state !== 'completed') {
      throw new Error('当前状态不能调整进度或倍速。');
    }
  }

  private speedEnum(rate: number): media.PlaybackSpeed {
    if (rate === 1) { return media.PlaybackSpeed.SPEED_FORWARD_1_00_X; }
    if (rate === 1.25) { return media.PlaybackSpeed.SPEED_FORWARD_1_25_X; }
    if (rate === 1.5) { return media.PlaybackSpeed.SPEED_FORWARD_1_50_X; }
    if (rate === 2) { return media.PlaybackSpeed.SPEED_FORWARD_2_00_X; }
    throw new Error('当前验证页仅支持 1、1.25、1.5、2 倍速。');
  }

  private speedRatio(speed: number): number {
    if (speed === media.PlaybackSpeed.SPEED_FORWARD_1_25_X) { return 1.25; }
    if (speed === media.PlaybackSpeed.SPEED_FORWARD_1_50_X) { return 1.5; }
    if (speed === media.PlaybackSpeed.SPEED_FORWARD_2_00_X) { return 2; }
    return 1;
  }

  private reportError(action: string, error: BusinessError): void {
    const code: string = error.code === undefined ? '' : ` (${error.code})`;
    // Network SDK errors may contain URLs. Never expose media request credentials in UI/logs.
    this.state.error = this.sourceUrl.length > 0 ? `${action}失败${code}，请检查连接后重试` : `${action}失败${code}：${error.message}`;
    this.log(this.state.error);
    hilog.error(0x1000, 'YuQuPlayback', '%{public}s', this.state.error);
  }

  private log(message: string): void {
    this.state.events.unshift(`${new Date().toLocaleTimeString()} ${message}`);
    if (this.state.events.length > LOG_LIMIT) {
      this.state.events.length = LOG_LIMIT;
    }
    this.emit();
  }

  private emit(): void {
    const snapshot: PlaybackViewState = this.getSnapshot();
    this.listeners.forEach((listener: PlaybackListener) => { listener(snapshot); });
  }
}
