import { common, wantAgent, WantAgent } from '@kit.AbilityKit';
import { audio } from '@kit.AudioKit';
import { avSession } from '@kit.AVSessionKit';
import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { media } from '@kit.MediaKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const SAMPLE_FILE: string = 'playback-check.wav';
const LOG_LIMIT: number = 18;

export interface PlaybackViewState {
  mediaVersionId: string;
  contentId: string;
  title: string;
  buffering: boolean;
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
  private playbackAllowed: (() => boolean) | undefined = undefined;
  private state: PlaybackViewState = {
    mediaVersionId: 'fixture-pcm-v1', contentId: 'yuqu-playback-check-v1',
    title: '两分钟播放验证音频', buffering: false,
    ready: false, busy: false, playerState: 'idle', positionMs: 0,
    durationMs: 0, rate: 1, looping: false, backgroundActive: false,
    backgroundStatus: '未申请', foreground: true, error: '', events: []
  };

  private constructor() {}

  static getInstance(): PlaybackService {
    return PlaybackService.instance;
  }

  getSnapshot(): PlaybackViewState {
    return {
      mediaVersionId: this.state.mediaVersionId, contentId: this.state.contentId,
      title: this.state.title, buffering: this.state.buffering,
      ready: this.state.ready, busy: this.state.busy,
      playerState: this.state.playerState, positionMs: this.state.positionMs,
      durationMs: this.state.durationMs, rate: this.state.rate,
      looping: this.state.looping, backgroundActive: this.state.backgroundActive,
      backgroundStatus: this.state.backgroundStatus, foreground: this.state.foreground,
      error: this.state.error, events: this.state.events.slice()
    };
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

  setPlaybackPermission(check: () => boolean): void { this.playbackAllowed = check; }

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
    if (this.state.ready) return;
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
    if (this.state.ready && this.state.mediaVersionId === mediaVersionId && this.sourceToken === token) return;
    const generation: number = ++this.lifecycleGeneration;
    this.finishPreparing(new Error('已切换音频，取消旧加载'));
    this.state.ready = false;
    this.state.buffering = false;
    this.emit();
    await this.enqueue('加载音频', async () => {
      this.assertLive(generation);
      await this.disposeResources();
      this.assertLive(generation);
      this.sourceUrl = fixture ? '' : `${baseUrl}/api/media/${encodeURIComponent(mediaVersionId)}`;
      this.sourceToken = fixture ? '' : token;
      this.state.mediaVersionId = mediaVersionId;
      this.state.contentId = contentId;
      this.state.title = title.slice(0, 300);
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
    });
  }

  pause(): Promise<void> {
    return this.enqueue('暂停', async () => {
      await this.pauseInternal();
    });
  }

  seek(positionMs: number): Promise<void> {
    return this.enqueue('跳转', async () => {
      const player: media.AVPlayer = this.requirePlayer();
      this.requireSeekable(player);
      const target: number = Math.round(Math.max(0, Math.min(positionMs, player.duration)));
      player.seek(target, media.SeekMode.SEEK_CLOSEST);
      // seekDone supplies the actual position; do not invent a completed seek here.
    });
  }

  setRate(rate: number): Promise<void> {
    return this.enqueue('调整倍速', async () => {
      const player: media.AVPlayer = this.requirePlayer();
      this.requireSeekable(player);
      player.setSpeed(this.speedEnum(rate));
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
    this.state.foreground = foreground;
    this.log(foreground ? '应用回到前台' : '应用进入后台，保持播放器和媒体会话');
  }

  release(): Promise<void> {
    this.closing = true;
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
      try {
        await work();
      } catch (error) {
        if (generation === this.lifecycleGeneration) this.reportError(label, error as BusinessError);
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
        if (this.session === session && this.isCurrentPlayer(player, generation)) { void this.play(); }
      });
      session.on('pause', () => {
        if (this.session === session && this.isCurrentPlayer(player, generation)) { void this.pause(); }
      });
      session.on('seek', (time: number) => {
        if (this.session === session && this.isCurrentPlayer(player, generation)) { void this.seek(time); }
      });
      session.on('setSpeed', (speed: number) => {
        if (this.session === session && this.isCurrentPlayer(player, generation)) { void this.setRate(speed); }
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
          const headers: Record<string, string> = { 'Authorization': `Bearer ${this.sourceToken}` };
          const source: media.MediaSource = media.createMediaSourceWithUrl(this.sourceUrl, headers);
          // Some system builds return void despite the SDK Promise signature.
          // Readiness always comes from stateChange/prepare, never this return value.
          void Promise.resolve(player.setMediaSource(source, {})).catch((error: BusinessError) => {
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

  private bindPlayer(player: media.AVPlayer, generation: number): void {
    player.on('stateChange', (state: string) => {
      if (!this.isCurrentPlayer(player, generation)) {
        return;
      }
      this.state.playerState = state;
      this.log(`播放器状态：${state}`);
      if (state === 'initialized') {
        this.preparePlayer(player).then(() => {
          if (this.isCurrentPlayer(player, generation)) {
            this.finishPreparing();
          }
        }).catch((error: BusinessError) => {
          if (this.isCurrentPlayer(player, generation)) {
            this.finishPreparing(new Error(error.message));
          }
        });
      } else if (state === 'completed') {
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
      this.state.positionMs = Math.max(0, time);
      this.emit();
      if (Date.now() - this.lastSessionUpdate >= 1000) {
        this.lastSessionUpdate = Date.now();
        void this.syncSession();
      }
    });
    player.on('seekDone', (time: number) => {
      if (!this.isCurrentPlayer(player, generation)) { return; }
      this.state.positionMs = time;
      this.log(`跳转完成：${Math.round(time / 1000)} 秒`);
      void this.syncSession();
    });
    player.on('speedDone', (speed: number) => {
      if (!this.isCurrentPlayer(player, generation)) { return; }
      this.state.rate = this.speedRatio(speed);
      this.log(`倍速已生效：${this.state.rate}×`);
      void this.syncSession();
    });
    player.on('bufferingUpdate', (infoType: media.BufferingInfoType, _value: number) => {
      if (!this.isCurrentPlayer(player, generation)) return;
      if (infoType === media.BufferingInfoType.BUFFERING_START) this.state.buffering = true;
      if (infoType === media.BufferingInfoType.BUFFERING_END) this.state.buffering = false;
      this.emit();
    });
    player.on('audioInterrupt', (event: audio.InterruptEvent) => {
      if (!this.isCurrentPlayer(player, generation)) { return; }
      this.log(`音频中断提示：${event.hintType}`);
      if (event.hintType === audio.InterruptHint.INTERRUPT_HINT_PAUSE ||
        event.hintType === audio.InterruptHint.INTERRUPT_HINT_STOP) {
        void this.enqueue('处理中断', async () => {
          if (!this.isCurrentPlayer(player, generation)) { return; }
          await this.pauseInternal();
          this.log('已因音频中断暂停，请手动继续播放');
        });
      } else if (event.hintType === audio.InterruptHint.INTERRUPT_HINT_RESUME) {
        this.log('音频焦点已可恢复；本验证页等待用户手动播放');
      }
    });
    player.on('audioOutputDeviceChangeWithInfo', (info: audio.AudioStreamDeviceChangeInfo) => {
      if (!this.isCurrentPlayer(player, generation)) { return; }
      this.log(`输出设备变化：${info.changeReason}`);
      if (info.changeReason === audio.AudioStreamDeviceChangeReason.REASON_OLD_DEVICE_UNAVAILABLE) {
        void this.enqueue('耳机断开', async () => {
          if (!this.isCurrentPlayer(player, generation)) { return; }
          await this.pauseInternal();
          this.log('旧输出设备断开，已暂停，避免自动外放');
        });
      }
    });
    player.on('error', (error: BusinessError) => {
      if (!this.isCurrentPlayer(player, generation)) { return; }
      this.state.ready = false;
      this.state.playerState = 'error';
      this.reportError('播放器', error);
      this.finishPreparing(new Error(error.message));
      void this.enqueue('处理播放错误', async () => {
        if (!this.isCurrentPlayer(player, generation)) { return; }
        await this.stopBackgroundTask();
        await this.syncSession();
      });
    });
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
    return !this.closing && generation === this.lifecycleGeneration && this.player === player;
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
