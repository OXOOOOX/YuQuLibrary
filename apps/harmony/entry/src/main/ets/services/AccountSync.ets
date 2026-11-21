import { ChatAnchor, ChatRetrieval, SearchPage, SearchResult, SavedSource, SavedItem, SavedPage, SaveRequest, NoteRequest, ReplayPoint, KnowledgeSegment } from './KnowledgeTypes';
import { Chapter, ChaptersPage, ChapterDocument, ChapterRequest } from './ChapterTypes';
import { SummaryPart, SummaryDocument, SummaryResult, SummariesPage, SummaryEvidence, SummaryRequest, SummaryTopicPage, SummaryTopic, SummaryTopicPoint } from './SummaryTypes';
import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { EventStream, StreamEvent, StreamState } from './EventStream';
import { PlaybackService, PlaybackViewState } from './PlaybackService';
import { DiagnosticReport, createTranscriptDiagnosticReport, diagnosticPreview } from './DiagnosticReport';
import { SessionVault, StoredSession } from './SessionVault';

interface AccountUser { id: string; email: string; }
interface DeviceSession { id: string; deviceName: string; client: string; expiresAt: string; }
interface ApiErrorValue { code: string; message: string; }
interface ApiReply {
  reportId?: string;
  items?: LibraryItem[];
  usage?: LibraryUsage;
  jobs?: ImportJob[];
  job?: ImportJob | TranscriptJob | null;
  mediaVersionId?: string;
  segments?: TranscriptSegment[];
  nextCursor?: number | null;
  pageCursor?: number;
  turns?: ChatTurn[];
  turn?: ChatTurn;
  conversationId?: string | null;
  nextBefore?: number | null;
  bridgeOnline?: boolean;
  retrievalOnline?: boolean;
  audioAvailable?: boolean;
  title?: string;
  episodes?: FeedEpisode[];
  user?: AccountUser;
  session?: DeviceSession;
  token?: string;
  challengeId?: string;
  expiresIn?: number;
  retryAfter?: number;
  delivery?: string;
  snapshot?: SyncedPlayback;
  accepted?: boolean;
  document?: SummaryDocument | null;
  overview?: SummaryResult | null;
  parts?: SummaryPart[];
  nextAfter?: number | null;
  evidence?: SummaryEvidence;
  error?: ApiErrorValue;
}
interface SyncedPlayback {
  title?: string;
  contentId: string;
  mediaVersionId: string;
  positionMs: number;
  durationMs: number;
  speed: number;
  state: string;
  revision: number;
  generation: number;
  sequence: number;
  ownerSessionId: string | null;
  playbackSessionId: string | null;
  looping: boolean;
  updatedAt: string;
}
interface PlaybackReport {
  generation: number;
  playbackSessionId: string;
  sequence: number;
  contentId: string;
  mediaVersionId: string;
  positionMs: number;
  speed: number;
  state: string;
  looping: boolean;
}
interface CodeRequest { email: string; }
interface VerifyRequest { email: string; challengeId: string; code: string; client: string; deviceName: string; }
interface TakeoverRequest {
  requestId: string; expectedGeneration: number; mediaVersionId?: string; positionMs?: number;
  intent?: string; expectedPlaybackSessionId?: string; speed?: number; looping?: boolean;
}
interface ImportRequest { url: string; title?: string; kind?: string; }
interface RemoveRequest { mode: string; }
export interface LibraryUsage {
  usedBytes: number; reservedBytes: number; reclaimingBytes: number; limitBytes: number; itemCount: number; itemLimit: number;
}
export interface LibraryItem {
  mediaVersionId: string; contentId: string; title: string; durationMs: number; createdAt: string;
  byteSize?: number; audioAvailable?: boolean; deletable?: boolean;
  transcript?: LibraryTranscript | null;
}
export interface LibraryTranscript { status: string; completedMs: number; durationMs: number; }
export interface ImportJob {
  id: string; title: string; sourceUrl: string; status: string; attempts: number;
  error: string | null; mediaVersionId: string | null; createdAt: string;
}
export interface FeedEpisode { url: string; title: string; }
export interface TranscriptJob {
  sourceLabel?: string;
  id: string; status: string; attempts: number; durationMs: number; completedMs: number;
  model: string | null; error: string | null; updatedAt: string;
}
export interface TranscriptSegment { id: string; startMs: number; endMs: number; text: string; }
export interface ChatCitation { id: string; startMs: number; endMs: number; text: string; }
export interface ChatTurn {
  id: string; sequence: number; question: string; answer: string; status: string;
  positionMs: number; scope: string; createdAt: string; error: string | null; citations: ChatCitation[];
  parentTurnId?: string | null; topicRootTurnId?: string; anchor?: ChatAnchor | null; retrieval?: ChatRetrieval | null;
}
interface ChatRequest { requestId: string; question: string; anchor?: ChatAnchor; parentTurnId?: string; }

class ApiFailure extends Error {
  status: number;
  snapshot: SyncedPlayback | undefined;
  constructor(status: number, message: string, snapshot: SyncedPlayback | undefined = undefined) {
    super(message);
    this.status = status;
    this.snapshot = snapshot;
  }
}

export interface AccountViewState {
  diagnosticId: string;
  diagnosticKind: string;
  diagnosticPhase: string;
  diagnosticPreview: string;
  diagnosticError: string;
  transcriptDiagnosticAvailable: boolean;
  title: string;
  mediaVersionId: string;
  libraryItems: LibraryItem[];
  libraryUsage: LibraryUsage | null;
  audioAvailable: boolean;
  readingMediaVersionId: string;
  readingTitle: string;
  readingArchived: boolean;
  contentPositionMs: number;
  contentDurationMs: number;
  importJobs: ImportJob[];
  feedEpisodes: FeedEpisode[];
  feedTitle: string;
  libraryBusy: boolean;
  libraryError: string;
  transcriptOpen: boolean;
  transcriptLoaded: boolean;
  transcriptBusy: boolean;
  transcriptError: string;
  transcriptJob: TranscriptJob | null;
  transcriptSegments: TranscriptSegment[];
  transcriptPageCursor: number;
  transcriptCanPrevious: boolean;
  transcriptCanNext: boolean;
  chatOpen: boolean;
  chatLoaded: boolean;
  chatBusy: boolean;
  chatError: string;
  chatTurns: ChatTurn[];
  chatBridgeOnline: boolean;
  chatRetrievalOnline: boolean;
  chatAudioAvailable: boolean;
  chatIsLatest: boolean;
  chatCanEarlier: boolean;
  chatCanSend: boolean;
  chatActive: boolean;
  chatDraft: string;
  chatScope: string;
  chatUnconfirmed: boolean;
  chatAnchorLabel: string;
  selectedSegmentIds: string[];
  searchResults: SearchResult[];
  searchQuery: string;
  searchBusy: boolean;
  searchError: string;
  searchThroughMs: number;
  searchCanNext: boolean;
  searchView: string;
  searchContextId: string;
  searchContextMs: number;
  searchContextRevision: number;
  chaptersOpen: boolean;
  chaptersPage: ChaptersPage | null;
  chaptersBusy: boolean;
  chaptersError: string;
  chaptersCanPrevious: boolean;
  chapterContext: Chapter | null;
  chapterContextRevision: number;
  summariesOpen: boolean;
  summariesPage: SummariesPage | null;
  summariesBusy: boolean;
  summariesError: string;
  summariesCanPrevious: boolean;
  summaryTopicPage: SummaryTopicPage | null;
  summaryTopicIndex: number;
  summaryTopicBusy: boolean;
  summaryTopicError: string;
  summaryTopicCanPrevious: boolean;
  summaryEvidence: SummaryEvidence | null;
  summaryEvidenceBusy: boolean;
  summaryEvidenceError: string;
  summaryExpandedNode: string;
  savedOpen: boolean;
  savedItems: SavedItem[];
  savedBusy: boolean;
  savedEditing: boolean;
  savedError: string;
  savedCanNext: boolean;
  savedThisEpisode: boolean;
  replayReturnLabel: string;
  loggedIn: boolean;
  busy: boolean;
  restoring: boolean;
  email: string;
  baseUrl: string;
  challengeReady: boolean;
  retrySeconds: number;
  hint: string;
  error: string;
  syncStatus: string;
  stale: boolean;
  owner: boolean;
  revision: number;
  generation: number;
  sequence: number;
  positionMs: number;
  durationMs: number;
  speed: number;
  playing: boolean;
  looping: boolean;
}
type AccountListener = (state: AccountViewState) => void;

/** Owns account lifetime and server-authoritative playback; the player remains independent. */
export class AccountSync {
  private static readonly instance: AccountSync = new AccountSync();
  private vault: SessionVault = new SessionVault();
  private stream: EventStream;
  private player: PlaybackService = PlaybackService.getInstance();
  private listeners: AccountListener[] = [];
  private requests: http.HttpRequest[] = [];
  private syncRequests: http.HttpRequest[] = [];
  private unsubscribePlayer: (() => void) | undefined = undefined;
  private ticker: number = -1;
  private lifecycle: number = 0;
  private syncEpoch: number = 0;
  private initialized: boolean = false;
  private foreground: boolean = true;
  private token: string = '';
  private baseUrl: string = 'https://fish.sdspeed.com.cn';
  private profile: DeviceSession | undefined = undefined;
  private accountEmail: string = '';
  private challengeId: string = '';
  private challengeEmail: string = '';
  private challengeBaseUrl: string = '';
  private retryAt: number = 0;
  private challengeExpiresAt: number = 0;
  private busy: boolean = false;
  private restoring: boolean = false;
  private hint: string = '';
  private error: string = '';
  // Keep transient background transport failures separate from explicit user
  // operation errors. A confirmed snapshot can clear only this channel.
  private syncError: string = '';
  private snapshot: SyncedPlayback | undefined = undefined;
  private lastConfirmed: number = 0;
  private lastRefresh: number = 0;
  private refreshEpoch: number = -1;
  private streamStatus: string = 'stopped';
  private controlGranted: boolean = false;
  private controlEpoch: number = 0;
  private aligning: boolean = false;
  private safetyPausing: boolean = false;
  private lastPlayer: PlaybackViewState = PlaybackService.getInstance().getSnapshot();
  private acknowledgedSequence: number = 0;
  private reportEpoch: number = -1;
  private reportDirty: boolean = false;
  private pendingReport: PlaybackReport | undefined = undefined;
  private lastReportSent: number = 0;
  private pendingTakeover: TakeoverRequest | undefined = undefined;
  private takeoverEpoch: number = -1;
  private libraryOpen: boolean = false;
  private libraryItems: LibraryItem[] = [];
  private libraryUsage: LibraryUsage | null = null;
  private readingItem: LibraryItem | null = null;
  private readingIntentEpoch: number = 0;
  private importJobs: ImportJob[] = [];
  private feedEpisodes: FeedEpisode[] = [];
  private feedTitle: string = '';
  private libraryBusy: boolean = false;
  private libraryError: string = '';
  private libraryGeneration: number = 0;
  private libraryRefreshGeneration: number = -1;
  private lastLibraryRefresh: number = 0;
  private transcriptOpen: boolean = false;
  private transcriptLoaded: boolean = false;
  private transcriptBusy: boolean = false;
  private transcriptError: string = '';
  private transcriptJob: TranscriptJob | null = null;
  private transcriptIdentity: string = '';
  private failedTranscriptAt: number = -1;
  private transcriptDiagnostics: Map<string, DiagnosticReport> = new Map<string, DiagnosticReport>();
  private diagnosticDraft: DiagnosticReport | undefined = undefined;
  private diagnosticPhase: string = '';
  private diagnosticAttempt: number = 0;
  private diagnosticText: string = '';
  private diagnosticError: string = '';
  private transcriptSegments: TranscriptSegment[] = [];
  private transcriptPageCursor: number = -1;
  private transcriptNextCursor: number | null = null;
  private transcriptPrevious: number[] = [];
  private transcriptGeneration: number = 0;
  private lastTranscriptRefresh: number = 0;
  private chatOpen: boolean = false;
  private chatLoaded: boolean = false;
  private chatBusy: boolean = false;
  private chatRefreshing: boolean = false;
  private chatError: string = '';
  private chatOperationError: boolean = false;
  private chatTurns: ChatTurn[] = [];
  private chatBridgeOnline: boolean = false;
  private chatRetrievalOnline: boolean = false;
  private chatAudioAvailable: boolean = false;
  private chatBefore: number | null = null;
  private chatNextBefore: number | null = null;
  private chatGeneration: number = 0;
  private chatMediaId: string = '';
  private lastChatRefresh: number = 0;
  private chatDraft: string = '';
  private chatScope: string = 'near';
  private chatPending: ChatRequest | null = null;
  private chatUnconfirmed: boolean = false;
  private chatRequestSubmitted: boolean = false;
  private draftAnchor: ChatAnchor | null = null;
  private parentTurnId: string = '';
  private anchorLabel: string = '';
  private selectedSegments: TranscriptSegment[] = [];
  private selectedAnchor: ChatAnchor | null = null;
  private searchPage: SearchPage | null = null;
  private searchQuery: string = '';
  private searchBusy: boolean = false;
  private searchError: string = '';
  private searchView: string = '';
  private searchContextId: string = '';
  private searchContextMs: number = 0;
  private searchContextRevision: number = 0;
  private knowledgeEpoch: number = 0;
  private chaptersOpen: boolean = false;
  private chaptersPage: ChaptersPage | null = null;
  private chaptersBusy: boolean = false;
  private chaptersMutation: boolean = false;
  private chaptersError: string = '';
  private chaptersEpoch: number = 0;
  private chaptersAfter: number = 0;
  private chaptersPrevious: number[] = [];
  private chaptersRequestId: string = '';
  private lastChaptersRefresh: number = 0;
  private chapterContext: Chapter | null = null;
  private chapterContextRevision: number = 0;
  private summariesOpen: boolean = false;
  private summariesPage: SummariesPage | null = null;
  private summariesBusy: boolean = false;
  private summariesMutation: boolean = false;
  private summariesError: string = '';
  private summariesEpoch: number = 0;
  private summariesAfter: number = 0;
  private summariesPrevious: number[] = [];
  private summariesRequestId: string = '';
  private summaryTopicPage: SummaryTopicPage | null = null;
  private summaryTopicIndex: number = -1;
  private summaryTopicBusy: boolean = false;
  private summaryTopicError: string = '';
  private summaryTopicAfter: number = 0;
  private summaryTopicPrevious: number[] = [];
  private summaryTopicEpoch: number = 0;
  private lastSummariesRefresh: number = 0;
  private summaryEvidence: SummaryEvidence | null = null;
  private summaryEvidenceBusy: boolean = false;
  private summaryEvidenceError: string = '';
  private summaryEvidenceEpoch: number = 0;
  private summaryExpandedNode: string = '';
  private savedOpen: boolean = false;
  private savedItems: SavedItem[] = [];
  private savedBusy: boolean = false;
  private savedMutationBusy: boolean = false;
  private savedMediaId: string = '';
  private savedEditingId: string = '';
  private savedEditingMediaId: string = '';
  private savedError: string = '';
  private savedCursor: string | null = null;
  private savedExpanded: boolean = false;
  private savedEditing: boolean = false;
  private savedThisEpisode: boolean = false;
  private savedEpoch: number = 0;
  private lastSavedRefresh: number = 0;
  private replayPoint: ReplayPoint | null = null;
  private pendingReplayPoint: ReplayPoint | null = null;
  private replayChanging: boolean = false;
  private pendingSave: SaveRequest | null = null;

  private constructor() {
    this.stream = new EventStream((event: StreamEvent) => { this.receiveEvent(event); },
      (state: StreamState) => {
        this.streamStatus = state.status;
        if (state.status === 'error' && this.profile !== undefined) {
          void this.expire('登录已过期，请重新登录');
        }
        this.emit();
      });
  }

  static getInstance(): AccountSync { return AccountSync.instance; }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.player.setPlaybackPermission(() => this.mayControl(), () => this.controlsCurrentMedia());
    const lifecycle: number = ++this.lifecycle;
    this.unsubscribePlayer = this.player.subscribe((state: PlaybackViewState) => { this.observePlayer(state); });
    this.ticker = setInterval(() => { this.tick(); }, 1000);
    this.restoring = true;
    this.emit();
    try {
      const stored: StoredSession | undefined = await this.vault.load();
      if (!this.live(lifecycle) || stored === undefined) return;
      const base: string = this.validateBase(stored.baseUrl);
      const reply: ApiReply = await this.request(base, '/api/auth/me', http.RequestMethod.GET, '', stored.token);
      if (!this.live(lifecycle)) return;
      this.installProfile(reply, stored.token, base);
      this.hint = '已恢复登录；点击“在此设备播放”后才会播放';
      await this.beginFollowing(lifecycle);
    } catch (error) {
      if (!this.live(lifecycle)) return;
      this.error = (error as Error).message || '暂时无法恢复登录，请检查连接';
      if (error instanceof ApiFailure && error.status === 401) await this.vault.clear();
    } finally {
      if (this.live(lifecycle)) { this.restoring = false; this.emit(); }
    }
  }

  subscribe(listener: AccountListener): () => void {
    this.listeners.push(listener);
    listener(this.getSnapshot());
    return () => {
      const index: number = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  getSnapshot(): AccountViewState {
    const loggedIn: boolean = this.profile !== undefined;
    const owner: boolean = this.ownsPlayback();
    const snapshot: SyncedPlayback | undefined = this.snapshot;
    const local: PlaybackViewState = this.player.getSnapshot();
    const localAligned: boolean = owner && !this.aligning && local.mediaVersionId === snapshot?.mediaVersionId;
    const stale: boolean = loggedIn && (this.lastConfirmed === 0 || Date.now() - this.lastConfirmed > 10000 ||
      (snapshot !== undefined && snapshot.state === 'playing' && Date.now() - Date.parse(snapshot.updatedAt) > 10000));
    let syncStatus: string = '登录后可同步播放进度';
    if (loggedIn) {
      if (snapshot === undefined) syncStatus = '正在读取播放进度';
      else if (stale) syncStatus = '离线或进度已过期，等待重新确认';
      else if (this.streamStatus === 'retrying' || this.streamStatus === 'connecting') syncStatus = '正在恢复事件连接';
      else syncStatus = owner ? '此设备播放 · 已同步' : '跟随云端进度 · 本机静音';
    }
    return {
      title: loggedIn ? snapshot?.title ?? '正在读取内容' : local.title,
      diagnosticId: this.diagnosticDraft?.reportId ?? '', diagnosticKind: this.diagnosticDraft?.kind ?? '',
      diagnosticPhase: this.diagnosticPhase, diagnosticPreview: this.diagnosticText, diagnosticError: this.diagnosticError,
      transcriptDiagnosticAvailable: this.canReportTranscript(),
      mediaVersionId: loggedIn ? snapshot?.mediaVersionId ?? '' : local.mediaVersionId,
      libraryItems: this.libraryItems.slice(), importJobs: this.importJobs.slice(),
      libraryUsage: this.libraryUsage,
      audioAvailable: this.libraryItems.find((item: LibraryItem) => item.mediaVersionId === snapshot?.mediaVersionId)?.audioAvailable !== false,
      readingMediaVersionId: this.readingItem?.mediaVersionId ?? '', readingTitle: this.readingItem?.title ?? '',
      readingArchived: this.readingItem?.audioAvailable === false,
      contentPositionMs: this.readingItem !== null ? 0 :
        loggedIn && !localAligned && snapshot !== undefined ? this.projectPosition(snapshot) : local.positionMs,
      contentDurationMs: this.contentDurationMs(),
      feedEpisodes: this.feedEpisodes.slice(), feedTitle: this.feedTitle,
      libraryBusy: this.libraryBusy, libraryError: this.libraryError,
      transcriptOpen: this.transcriptOpen, transcriptLoaded: this.transcriptLoaded,
      transcriptBusy: this.transcriptBusy, transcriptError: this.transcriptError,
      transcriptJob: this.transcriptJob, transcriptSegments: this.transcriptSegments.slice(),
      transcriptPageCursor: this.transcriptPageCursor,
      transcriptCanPrevious: this.transcriptPrevious.length > 0 || this.transcriptPageCursor >= 0,
      transcriptCanNext: this.transcriptNextCursor !== null,
      chatOpen: this.chatOpen, chatLoaded: this.chatLoaded, chatBusy: this.chatBusy,
      chatError: this.chatError, chatTurns: this.chatTurns.slice(), chatBridgeOnline: this.chatBridgeOnline,
      chatRetrievalOnline: this.chatRetrievalOnline,
      chatAudioAvailable: this.chatAudioAvailable && this.readingItem?.audioAvailable !== false &&
        this.libraryItems.find((item: LibraryItem) => item.mediaVersionId === this.contentMediaId())?.audioAvailable !== false,
      chatIsLatest: this.chatBefore === null, chatCanEarlier: this.chatNextBefore !== null,
      chatCanSend: loggedIn && this.chatOpen && this.chatLoaded && !this.chatBusy && this.chatBefore === null &&
        !this.chatHasActive() && (this.draftAnchor !== null || this.parentTurnId.length > 0) && this.chatDraft.trim().length > 0 && this.chatDraft.trim().length <= 2000,
      chatActive: this.chatHasActive(), chatDraft: this.chatDraft, chatScope: this.chatScope,
      chatUnconfirmed: this.chatUnconfirmed,
      chatAnchorLabel: this.anchorLabel,
      selectedSegmentIds: this.selectedSegments.map((segment: TranscriptSegment) => segment.id),
      searchResults: this.searchPage?.results.slice() ?? [], searchQuery: this.searchQuery,
      searchBusy: this.searchBusy, searchError: this.searchError,
      searchThroughMs: this.searchPage?.snapshot.throughMs ?? 0,
      searchCanNext: this.searchPage?.nextCursor !== null && this.searchPage !== null,
      searchView: this.searchView, searchContextId: this.searchContextId,
      searchContextMs: this.searchContextMs, searchContextRevision: this.searchContextRevision,
      chaptersOpen: this.chaptersOpen, chaptersPage: this.chaptersPage,
      chaptersBusy: this.chaptersBusy || this.chaptersMutation, chaptersError: this.chaptersError,
      chaptersCanPrevious: this.chaptersPrevious.length > 0, chapterContext: this.chapterContext,
      chapterContextRevision: this.chapterContextRevision,
      summariesOpen: this.summariesOpen, summariesPage: this.summariesPage,
      summariesBusy: this.summariesBusy || this.summariesMutation, summariesError: this.summariesError,
      summariesCanPrevious: this.summariesPrevious.length > 0,
      summaryTopicPage: this.summaryTopicPage, summaryTopicIndex: this.summaryTopicIndex,
      summaryTopicBusy: this.summaryTopicBusy, summaryTopicError: this.summaryTopicError,
      summaryTopicCanPrevious: this.summaryTopicPrevious.length > 0,
      summaryEvidence: this.summaryEvidence, summaryEvidenceBusy: this.summaryEvidenceBusy,
      summaryEvidenceError: this.summaryEvidenceError, summaryExpandedNode: this.summaryExpandedNode,
      savedOpen: this.savedOpen, savedItems: this.savedItems.slice(), savedBusy: this.savedBusy || this.savedMutationBusy, savedEditing: this.savedEditing,
      savedError: this.savedError, savedCanNext: this.savedCursor !== null, savedThisEpisode: this.savedThisEpisode,
      replayReturnLabel: this.replayPoint === null ? '' : `在本机返回 ${this.timeLabel(this.replayPoint.positionMs)}`,
      loggedIn: loggedIn, busy: this.busy, restoring: this.restoring, email: this.accountEmail,
      baseUrl: this.baseUrl, challengeReady: this.challengeId.length > 0 && Date.now() < this.challengeExpiresAt,
      retrySeconds: Math.max(0, Math.ceil((this.retryAt - Date.now()) / 1000)), hint: this.hint,
      error: this.error.length > 0 ? this.error : this.syncError,
      syncStatus: syncStatus, stale: stale, owner: owner, revision: snapshot?.revision ?? 0,
      generation: snapshot?.generation ?? 0, sequence: snapshot?.sequence ?? 0,
      positionMs: loggedIn && !localAligned && snapshot !== undefined ? this.projectPosition(snapshot) : local.positionMs,
      durationMs: loggedIn && snapshot !== undefined ? snapshot.durationMs : local.durationMs,
      speed: loggedIn && !localAligned && snapshot !== undefined ? snapshot.speed : local.rate,
      playing: loggedIn && !localAligned && snapshot !== undefined ? snapshot.state === 'playing' : local.playerState === 'playing',
      looping: loggedIn && !localAligned && snapshot !== undefined ? snapshot.looping : local.looping
    };
  }

  async requestCode(baseUrl: string, email: string): Promise<void> {
    if (this.busy || this.restoring || this.profile !== undefined) return;
    const lifecycle: number = ++this.lifecycle;
    this.busy = true;
    this.error = '';
    this.emit();
    try {
      const base: string = this.validateBase(baseUrl);
      const normalizedEmail: string = email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) throw new Error('请输入有效邮箱');
      const body: CodeRequest = { email: normalizedEmail };
      const reply: ApiReply = await this.request(base, '/api/auth/request-code', http.RequestMethod.POST, JSON.stringify(body));
      if (!this.live(lifecycle)) return;
      if (typeof reply.challengeId !== 'string' || reply.challengeId.length === 0) throw new Error('验证码请求响应无效');
      this.baseUrl = base;
      this.challengeBaseUrl = base;
      this.challengeEmail = normalizedEmail;
      this.challengeId = reply.challengeId;
      this.retryAt = Date.now() + (reply.retryAfter ?? 60) * 1000;
      this.challengeExpiresAt = Date.now() + (reply.expiresIn ?? 600) * 1000;
      this.hint = reply.delivery === 'local' ? '当前使用本地测试投递，请从开发收件箱查看验证码' : '验证码已发送，请检查邮箱';
    } catch (error) {
      if (this.live(lifecycle)) this.error = (error as Error).message;
    } finally {
      if (this.live(lifecycle)) { this.busy = false; this.emit(); }
    }
  }

  async verifyCode(baseUrl: string, email: string, code: string): Promise<void> {
    if (this.busy || this.restoring || this.profile !== undefined) return;
    const lifecycle: number = ++this.lifecycle;
    this.busy = true;
    this.error = '';
    this.emit();
    try {
      const base: string = this.validateBase(baseUrl);
      const normalizedEmail: string = email.trim().toLowerCase();
      if (base !== this.challengeBaseUrl || normalizedEmail !== this.challengeEmail ||
        this.challengeId.length === 0 || Date.now() >= this.challengeExpiresAt) {
        throw new Error('请先为当前邮箱和服务地址重新获取验证码');
      }
      if (!/^[0-9]{6}$/.test(code.trim())) throw new Error('请输入 6 位验证码');
      const body: VerifyRequest = {
        email: normalizedEmail, challengeId: this.challengeId, code: code.trim(), client: 'harmony', deviceName: '鸿蒙手机'
      };
      const reply: ApiReply = await this.request(base, '/api/auth/verify-code', http.RequestMethod.POST, JSON.stringify(body));
      if (!this.live(lifecycle)) return;
      if (typeof reply.token !== 'string' || reply.token.length === 0) throw new Error('登录响应缺少设备凭据');
      this.validateProfile(reply);
      const token: string = reply.token;
      await this.vault.save({ token: token, baseUrl: base });
      if (!this.live(lifecycle)) return;
      this.installProfile(reply, token, base);
      this.challengeId = '';
      this.hint = '已登录；两端默认跟随，点击“在此设备播放”开始收听';
      await this.beginFollowing(lifecycle);
    } catch (error) {
      if (this.live(lifecycle)) this.error = (error as Error).message;
    } finally {
      if (this.live(lifecycle)) { this.busy = false; this.emit(); }
    }
  }

  async logout(): Promise<void> {
    const token: string = this.token;
    const base: string = this.baseUrl;
    const lifecycle: number = ++this.lifecycle;
    this.clearAccount();
    this.hint = '已退出登录';
    this.emit();
    const clear: Promise<void> = this.vault.clear().catch((_error: Error) => {
      if (this.live(lifecycle)) this.error = '安全存储清理失败，请重试退出登录';
    });
    await this.player.pause();
    await clear;
    if (token.length > 0) {
      try { await this.request(base, '/api/auth/logout', http.RequestMethod.POST, '{}', token); }
      catch (_error) {
        if (this.live(lifecycle)) this.hint = '本机已退出；服务器暂未确认会话撤销';
      }
    }
    if (this.live(lifecycle)) this.emit();
  }

  async takeover(mediaVersionId: string = '', positionMs?: number, restore?: ReplayPoint, replay: boolean = false): Promise<void> {
    if (this.busy || this.profile === undefined || this.snapshot === undefined) return;
    if (positionMs !== undefined && (mediaVersionId.length === 0 || !Number.isSafeInteger(positionMs) || positionMs < 0)) {
      this.error = '引用播放位置无效，请重新查看引用'; this.emit(); return;
    }
    if (!replay && restore === undefined) { this.replayPoint = null; this.pendingReplayPoint = null; }
    const target: string = mediaVersionId.length > 0 ? mediaVersionId : this.snapshot.mediaVersionId;
    if (this.libraryItems.find((item: LibraryItem) => item.mediaVersionId === target)?.audioAvailable === false) {
      if (restore !== undefined) this.pendingTakeover = undefined;
      this.error = '音频已清理，仍可查看文稿和对话'; this.emit(); return;
    }
    const lifecycle: number = this.lifecycle;
    const syncEpoch: number = this.syncEpoch;
    this.takeoverEpoch = syncEpoch;
    this.busy = true;
    this.error = '';
    this.emit();
    try {
      if (this.pendingTakeover === undefined || this.pendingTakeover.mediaVersionId !== target ||
        this.pendingTakeover.positionMs !== positionMs || this.pendingTakeover.intent !== (restore === undefined ? undefined : 'restore') ||
        (restore !== undefined && !this.pendingRestore(restore))) {
        this.pendingTakeover = { requestId: util.generateRandomUUID(), expectedGeneration: this.snapshot.generation,
          mediaVersionId: target, positionMs: positionMs };
        if (restore !== undefined) {
          this.pendingTakeover.intent = 'restore'; this.pendingTakeover.expectedGeneration = restore.expectedGeneration;
          this.pendingTakeover.expectedPlaybackSessionId = restore.expectedPlaybackSessionId;
          this.pendingTakeover.speed = restore.speed; this.pendingTakeover.looping = restore.looping;
        }
      }
      const operation: TakeoverRequest = this.pendingTakeover;
      const reply: ApiReply = await this.authRequest('/api/playback/takeover', http.RequestMethod.POST,
        JSON.stringify(operation), lifecycle, syncEpoch);
      if (!this.syncLive(lifecycle, syncEpoch)) return;
      // A restore may have committed even if loading the response/media fails. Keep its original identity until aligned.
      if (restore === undefined) this.pendingTakeover = undefined;
      if (reply.snapshot === undefined) throw new Error('接管响应缺少播放进度');
      this.applySnapshot(reply.snapshot);
      const snapshot: SyncedPlayback | undefined = this.snapshot;
      if (reply.accepted !== true || snapshot === undefined || snapshot.generation !== operation.expectedGeneration + 1 ||
        snapshot.ownerSessionId !== this.profile?.id || snapshot.playbackSessionId === null ||
        snapshot.mediaVersionId !== operation.mediaVersionId) {
        this.pendingTakeover = undefined;
        throw new Error('播放设备已发生变化，请重新确认接管');
      }
      this.controlGranted = true;
      const epoch: number = ++this.controlEpoch;
      this.acknowledgedSequence = snapshot.sequence;
      this.pendingReport = undefined;
      this.reportDirty = false;
      this.aligning = true;
      await this.player.pause();
      this.assertControl(lifecycle, epoch);
      await this.player.loadMedia(snapshot.contentId, snapshot.mediaVersionId, snapshot.title ?? '鱼趣音频',
        snapshot.mediaVersionId === 'fixture-pcm-v1' ? '' : this.baseUrl, this.token);
      this.assertControl(lifecycle, epoch);
      await this.waitReady(lifecycle, epoch, snapshot.mediaVersionId);
      const position: number = this.projectPosition(snapshot);
      await this.player.setLooping(snapshot.looping);
      this.assertControl(lifecycle, epoch);
      await this.player.setRate(snapshot.speed);
      this.assertControl(lifecycle, epoch);
      const targetPosition: number = restore === undefined && position >= snapshot.durationMs ? 0 : position;
      await this.player.seek(targetPosition);
      await this.waitAligned(targetPosition, snapshot.speed, lifecycle, epoch);
      this.assertControl(lifecycle, epoch);
      this.aligning = false;
      if (restore === undefined || restore.playing) {
        await this.player.play();
        this.assertControl(lifecycle, epoch);
        if (this.player.getSnapshot().playerState !== 'playing') throw new Error('播放器未能启动，请重试');
      }
      if (this.pendingTakeover === operation) this.pendingTakeover = undefined;
      this.reportDirty = true;
      this.updateNetworkPolicy();
      void this.flushReport();
    } catch (error) {
      if (this.syncLive(lifecycle, syncEpoch)) {
        if (error instanceof ApiFailure && (error.status === 409 || (restore !== undefined &&
          error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429))) {
          this.pendingTakeover = undefined;
          if (error.snapshot !== undefined) this.applySnapshot(error.snapshot);
        }
        this.dropControl();
        this.error = (error as Error).message;
        if (positionMs !== undefined) void this.refreshChat();
      }
    } finally {
      if (this.syncLive(lifecycle, syncEpoch) && this.takeoverEpoch === syncEpoch) {
        this.takeoverEpoch = -1;
        this.aligning = false;
        this.busy = false;
        this.emit();
      }
    }
  }

  async playTranscriptSegment(segmentId: string): Promise<boolean> {
    if (!this.profile || !this.snapshot || !this.foreground || !this.transcriptOpen || this.transcriptJob === null ||
      this.busy || this.replayChanging || this.selectedAnchor !== null) return false;
    const segment: TranscriptSegment | undefined = this.transcriptSegments.find((row: TranscriptSegment) => row.id === segmentId);
    if (!segment || segment.startMs >= this.contentDurationMs()) return false;
    const mediaId: string = this.contentMediaId();
    if (this.readingItem?.audioAvailable === false ||
      this.libraryItems.find((item: LibraryItem) => item.mediaVersionId === mediaId)?.audioAvailable === false) {
      this.error = '音频已清理，仍可阅读文稿'; this.emit(); return false;
    }
    const lifecycle: number = this.lifecycle, syncEpoch: number = this.syncEpoch, reading: number = this.readingIntentEpoch;
    if (mediaId !== this.snapshot.mediaVersionId || !this.mayControl()) {
      await this.takeover(mediaId, segment.startMs);
      const active: PlaybackViewState = this.player.getSnapshot();
      return this.syncLive(lifecycle, syncEpoch) && this.readingIntentEpoch === reading && this.mayControl() &&
        active.mediaVersionId === mediaId && active.playerState === 'playing' && this.error.length === 0;
    }
    const player: PlaybackViewState = this.player.getSnapshot();
    if (player.busy || player.recovering) return false;
    const control: number = this.controlEpoch;
    this.replayPoint = null; this.pendingReplayPoint = null; this.pendingTakeover = undefined;
    this.takeoverEpoch = syncEpoch; this.busy = true; this.error = ''; this.emit();
    try {
      await this.player.seek(segment.startMs);
      await this.waitAligned(segment.startMs, player.rate, lifecycle, control);
      this.assertControl(lifecycle, control);
      if (this.readingIntentEpoch !== reading || this.contentMediaId() !== mediaId || !this.mayControl()) return false;
      if (this.player.getSnapshot().playerState !== 'playing') {
        await this.player.play();
        this.assertControl(lifecycle, control);
        if (this.player.getSnapshot().playerState !== 'playing') throw new Error('播放器未能启动，请重试');
      }
      return this.readingIntentEpoch === reading;
    } catch (error) {
      if (this.syncLive(lifecycle, syncEpoch) && this.controlEpoch === control) this.error = (error as Error).message;
      return false;
    } finally {
      if (this.syncLive(lifecycle, syncEpoch)) {
        this.takeoverEpoch = -1; this.busy = false; this.emit();
      }
    }
  }

  async playCitation(turnId: string, citationId: string): Promise<void> {
    if (!this.profile || this.busy || !this.chatLoaded || this.chatMediaId !== this.contentMediaId()) return;
    const turn: ChatTurn | undefined = this.chatTurns.find((value: ChatTurn) => value.id === turnId);
    const citation: ChatCitation | undefined = turn?.citations.find((value: ChatCitation) => value.id === citationId);
    if (citation === undefined) return;
    if (!this.getSnapshot().chatAudioAvailable) {
      this.error = '音频已清理或状态尚未确认，仍可查看引用原文'; this.emit(); return;
    }
    const mediaId: string = this.chatMediaId;
    const position: number = citation.startMs;
    if (!Number.isSafeInteger(position) || position < 0 || position >= this.contentDurationMs()) {
      this.error = '引用播放位置无效，请重新查看引用'; this.emit(); return;
    }
    // Freeze the displayed conversation identity before any await; reading and drafts stay intact.
    await this.playExcerpt(mediaId, position, citation.endMs);
  }

  async playExcerpt(mediaId: string, startMs: number, endMs: number): Promise<void> {
    if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < 0 || endMs <= startMs) return;
    if (this.busy || !this.profile || !this.snapshot || this.replayChanging) return;
    if (this.getSnapshot().stale) { await this.refresh(); if (this.getSnapshot().stale) { this.error = '播放进度尚未确认，请稍后回听'; this.emit(); return; } }
    const state: AccountViewState = this.getSnapshot();
    const previous: ReplayPoint = this.replayPoint ?? this.pendingReplayPoint ?? { mediaVersionId: state.mediaVersionId,
      positionMs: Math.round(state.positionMs), speed: state.speed, looping: state.looping, playing: state.playing,
      expectedGeneration: 0, expectedPlaybackSessionId: '', endMs: endMs };
    this.pendingReplayPoint = previous;
    const lifecycle: number = this.lifecycle, syncEpoch: number = this.syncEpoch;
    this.replayChanging = true;
    try {
      await this.takeover(mediaId, startMs, undefined, true);
      if (!this.syncLive(lifecycle, syncEpoch)) return;
      if (this.ownsPlayback() && this.snapshot?.mediaVersionId === mediaId && this.error.length === 0) {
        previous.expectedGeneration = this.snapshot.generation;
        previous.expectedPlaybackSessionId = this.snapshot.playbackSessionId ?? '';
        previous.endMs = endMs; this.replayPoint = previous; this.pendingReplayPoint = null;
      } else { this.replayPoint = null; if (this.pendingTakeover === undefined) this.pendingReplayPoint = null; }
    } finally { if (this.syncLive(lifecycle, syncEpoch)) { this.replayChanging = false; this.emit(); } }
  }
  async returnFromReplay(): Promise<void> {
    const point: ReplayPoint | null = this.replayPoint;
    if (point === null || this.busy || this.replayChanging) return;
    const retry: boolean = this.pendingRestore(point) && this.restoreSnapshotCompatible(point);
    if (!retry && (!this.ownsPlayback() || this.snapshot?.generation !== point.expectedGeneration || this.snapshot?.playbackSessionId !== point.expectedPlaybackSessionId)) {
      if (this.pendingTakeover?.intent === 'restore') this.pendingTakeover = undefined;
      this.replayPoint = null; this.hint = '播放已在其他设备变化，未返回'; this.emit(); return;
    }
    const lifecycle: number = this.lifecycle, syncEpoch: number = this.syncEpoch;
    this.replayChanging = true;
    try { await this.takeover(point.mediaVersionId, point.positionMs, point); }
    finally {
      if (this.syncLive(lifecycle, syncEpoch)) {
        if (this.replayPoint === point) {
          if (this.pendingRestore(point) && this.restoreSnapshotCompatible(point)) {
            this.hint = '返回结果尚未确认，可再次点击同一返回按钮重试';
          } else {
            this.replayPoint = null;
            if (this.pendingTakeover?.intent === 'restore') this.pendingTakeover = undefined;
          }
        }
        this.replayChanging = false; this.emit();
      }
    }
  }
  private pendingRestore(point: ReplayPoint): boolean {
    const request: TakeoverRequest | undefined = this.pendingTakeover;
    return request?.intent === 'restore' && request.expectedGeneration === point.expectedGeneration &&
      request.expectedPlaybackSessionId === point.expectedPlaybackSessionId && request.mediaVersionId === point.mediaVersionId &&
      request.positionMs === point.positionMs && request.speed === point.speed && request.looping === point.looping;
  }
  private restoreSnapshotCompatible(point: ReplayPoint): boolean {
    const snapshot: SyncedPlayback | undefined = this.snapshot;
    if (!this.profile || snapshot === undefined || snapshot.ownerSessionId !== this.profile.id) return false;
    if (snapshot.generation === point.expectedGeneration && snapshot.playbackSessionId === point.expectedPlaybackSessionId) return true;
    // This only permits an idempotent retry; the server must still confirm this exact request before local playback.
    return this.pendingRestore(point) && snapshot.generation === point.expectedGeneration + 1 &&
      snapshot.mediaVersionId === point.mediaVersionId && snapshot.playbackSessionId !== null;
  }
  async continueReplay(): Promise<void> {
    if (this.replayPoint !== null) this.replayPoint.endMs = -1;
    if (this.mayControl()) await this.player.play();
  }

  async playOrPause(): Promise<void> {
    if (!this.mayControl()) return;
    if (this.player.getSnapshot().playerState === 'playing') await this.player.pause();
    else await this.player.play();
  }
  async seek(positionMs: number): Promise<void> { if (this.mayControl()) await this.player.seek(positionMs); }
  async setRate(rate: number): Promise<void> { if (this.mayControl()) await this.player.setRate(rate); }
  async setLooping(looping: boolean): Promise<void> { if (this.mayControl()) await this.player.setLooping(looping); }

  setForeground(foreground: boolean): void {
    this.foreground = foreground;
    if (!foreground) { this.transcriptGeneration++; this.transcriptBusy = false; this.invalidateChatRequests(); this.clearSummaryTopic(); }
    this.updateNetworkPolicy();
    if (foreground && this.profile !== undefined) { void this.refresh(); void this.refreshLibrary(); void this.refreshTranscript(); void this.refreshChat(); }
  }

  setLibraryOpen(open: boolean): void {
    this.libraryOpen = open;
    if (open) void this.refreshLibrary();
  }

  selectReading(mediaId: string): void {
    this.readingIntentEpoch++;
    if (!this.profile) return;
    const item: LibraryItem | undefined = this.libraryItems.find((value: LibraryItem) => value.mediaVersionId === mediaId);
    if (item === undefined) return;
    this.libraryOpen = false;
    this.readingItem = item;
    this.syncSavedFilter();
    this.clearTranscript();
    this.clearChat();
    this.chatMediaId = item.mediaVersionId;
    this.chatScope = 'all';
    this.transcriptOpen = true;
    void this.refreshTranscript();
    void this.refreshChat();
    this.emit();
  }

  returnToCurrent(hint: string = ''): void {
    this.readingIntentEpoch++;
    this.readingItem = null;
    this.syncSavedFilter();
    this.clearTranscript();
    this.clearChat();
    this.chatMediaId = this.contentMediaId();
    if (hint.length > 0) this.hint = hint;
    void this.refreshTranscript();
    void this.refreshChat();
    this.emit();
  }

  private contentMediaId(): string { return this.readingItem?.mediaVersionId ?? this.snapshot?.mediaVersionId ?? ''; }
  private contentDurationMs(): number { return this.readingItem?.durationMs ?? this.snapshot?.durationMs ?? 0; }

  private canReportTranscript(): boolean {
    const job: TranscriptJob | null = this.transcriptJob;
    return this.profile !== undefined && this.contentMediaId().length > 0 && job !== null &&
      job.status === 'failed' && job.id === this.transcriptIdentity && Number.isSafeInteger(job.attempts) &&
      job.attempts >= 0 && this.failedTranscriptAt > 0 && Date.parse(job.updatedAt) === this.failedTranscriptAt;
  }

  private diagnosticMatches(report: DiagnosticReport): boolean {
    if (this.profile === undefined) return false;
    if (report.kind === 'playback') {
      const local: PlaybackViewState = this.player.getSnapshot();
      return report.mediaVersionId === this.snapshot?.mediaVersionId && report.mediaVersionId === local.mediaVersionId &&
        report.reportId === local.diagnosticIncidentId;
    }
    return this.canReportTranscript() && report.mediaVersionId === this.contentMediaId() &&
      report.jobId === this.transcriptIdentity && report.events[0].atMs === this.failedTranscriptAt;
  }

  previewDiagnostic(kind: string): void {
    if (this.profile === undefined || this.diagnosticPhase === 'sending') return;
    let report: DiagnosticReport | undefined = undefined;
    if (kind === 'playback') {
      const local: PlaybackViewState = this.player.getSnapshot();
      if (!local.diagnosticIncidentId || local.mediaVersionId !== this.snapshot?.mediaVersionId) return;
      report = this.player.getDiagnosticReport();
    } else if (kind === 'transcription' && this.transcriptJob !== null && this.canReportTranscript()) {
      const mediaId: string = this.contentMediaId();
      report = this.transcriptDiagnostics.get(mediaId);
      if (report === undefined || !this.diagnosticMatches(report)) {
        const job: TranscriptJob = this.transcriptJob;
        report = createTranscriptDiagnosticReport(mediaId, job.id, job.completedMs, job.attempts, this.failedTranscriptAt);
        this.transcriptDiagnostics.set(mediaId, report);
      }
    }
    if (report === undefined || report.kind !== kind || !this.diagnosticMatches(report) ||
      (this.diagnosticDraft?.reportId === report.reportId && this.diagnosticPhase === 'sent')) return;
    this.diagnosticDraft = report;
    this.diagnosticText = diagnosticPreview(report);
    this.diagnosticPhase = 'preview';
    this.diagnosticError = '';
    this.emit();
  }

  cancelDiagnostic(reportId: string): void {
    if (this.diagnosticDraft?.reportId !== reportId || this.diagnosticPhase === 'sending') return;
    this.clearDiagnosticDraft();
    this.emit();
  }

  async submitDiagnostic(reportId: string): Promise<void> {
    const report: DiagnosticReport | undefined = this.diagnosticDraft;
    if (report === undefined || report.reportId !== reportId || !this.diagnosticMatches(report) ||
      (this.diagnosticPhase !== 'preview' && this.diagnosticPhase !== 'failed')) return;
    const lifecycle: number = this.lifecycle, syncEpoch: number = this.syncEpoch;
    const attempt: number = ++this.diagnosticAttempt;
    this.diagnosticPhase = 'sending';
    this.diagnosticError = '';
    try {
      const pending: Promise<ApiReply> = this.authRequest('/api/diagnostics', http.RequestMethod.POST,
        JSON.stringify(report), lifecycle, syncEpoch);
      this.emit();
      const reply: ApiReply = await pending;
      if (!this.syncLive(lifecycle, syncEpoch) || attempt !== this.diagnosticAttempt) return;
      if (reply.reportId !== report.reportId) throw new Error('报告编号不匹配');
      this.diagnosticPhase = 'sent';
      this.diagnosticText = '';
    } catch (error) {
      if (!this.syncLive(lifecycle, syncEpoch) || attempt !== this.diagnosticAttempt) return;
      this.diagnosticPhase = 'failed';
      this.diagnosticError = error instanceof ApiFailure && error.status === 429 ?
        '上传次数已达上限，请稍后重试。' : '暂未收到上传回执，可重试同一份日志。';
    }
    this.emit();
  }

  private clearDiagnosticDraft(): void {
    this.diagnosticAttempt++;
    this.diagnosticDraft = undefined;
    this.diagnosticText = '';
    this.diagnosticError = '';
    this.diagnosticPhase = '';
  }

  private clearAccountDiagnostics(): void {
    this.clearDiagnosticDraft();
    this.failedTranscriptAt = -1;
    this.transcriptDiagnostics.clear();
    this.player.clearDiagnosticReports();
  }

  private readingRemoved(error: Error, mediaId: string): boolean {
    if (error instanceof ApiFailure && error.status === 404 && this.readingItem?.mediaVersionId === mediaId) {
      this.returnToCurrent('这期资料已删除，已返回当前节目');
      void this.refreshLibrary();
      return true;
    }
    return false;
  }

  setTranscriptOpen(open: boolean): void {
    this.transcriptOpen = open;
    if (!open) { this.transcriptGeneration++; this.transcriptBusy = false; this.setChaptersOpen(false); this.setSummariesOpen(false); }
    else void this.refreshTranscript();
    this.emit();
  }

  async refreshTranscript(retry: boolean = false, atMs: number = -1, stillWanted?: () => boolean): Promise<void> {
    if (!this.profile || !this.foreground || !this.transcriptOpen || this.transcriptBusy || this.contentMediaId().length === 0) return;
    if (retry && this.readingItem?.audioAvailable === false) return;
    const mediaId: string = this.contentMediaId();
    const lifecycle: number = this.lifecycle, syncEpoch: number = this.syncEpoch;
    const generation: number = this.transcriptGeneration;
    const path: string = `/api/media/${encodeURIComponent(mediaId)}/transcript`;
    const query: string = atMs >= 0 ? `at=${Math.floor(atMs)}` : `after=${this.transcriptPageCursor}`;
    this.transcriptBusy = true;
    this.lastTranscriptRefresh = Date.now();
    this.emit();
    try {
      const reply: ApiReply = await this.authRequest(retry ? `${path}/retry` : `${path}?${query}`,
        retry ? http.RequestMethod.POST : http.RequestMethod.GET, '', lifecycle, syncEpoch);
      if (!this.syncLive(lifecycle, syncEpoch) || generation !== this.transcriptGeneration ||
        mediaId !== this.contentMediaId() || !this.transcriptOpen || !this.foreground || (stillWanted && !stillWanted())) return;
      this.validateTranscript(reply, mediaId);
      const job: TranscriptJob | null = reply.job as TranscriptJob | null;
      const identity: string = job?.id ?? 'none';
      const changed: boolean = this.transcriptIdentity.length > 0 && this.transcriptIdentity !== identity;
      if (changed && !retry && this.transcriptPageCursor !== -1) {
        this.clearTranscript();
        return;
      }
      if (changed || retry) this.transcriptPrevious = [];
      this.transcriptIdentity = identity;
      this.failedTranscriptAt = job?.status === 'failed' ? Date.parse(job.updatedAt) : -1;
      // A completed request must not move the cursor underneath a new selection.
      if (this.selectedAnchor !== null && this.selectedAnchor.transcriptJobId === identity && !retry) return;
      if (this.selectedAnchor !== null) this.clearSelection();
      this.transcriptJob = job;
      this.transcriptSegments = (reply.segments as TranscriptSegment[]).slice();
      this.transcriptPageCursor = reply.pageCursor as number;
      this.transcriptNextCursor = reply.nextCursor as number | null;
      this.transcriptLoaded = true;
      this.transcriptError = '';
    } catch (error) {
      if (this.syncLive(lifecycle, syncEpoch) && generation === this.transcriptGeneration &&
        mediaId === this.contentMediaId() && (!stillWanted || stillWanted()) &&
        !this.readingRemoved(error as Error, mediaId)) this.transcriptError = (error as Error).message;
    } finally {
      if (generation === this.transcriptGeneration) this.transcriptBusy = false;
      if (this.live(lifecycle)) this.emit();
    }
  }

  nextTranscriptPage(): void {
    if (this.transcriptBusy || this.transcriptNextCursor === null) return;
    this.transcriptPrevious.push(this.transcriptPageCursor);
    this.moveTranscriptPage(this.transcriptNextCursor);
  }
  previousTranscriptPage(): void {
    if (this.transcriptBusy) return;
    const previous: number | undefined = this.transcriptPrevious.pop();
    this.moveTranscriptPage(previous ?? Math.max(-1, this.transcriptPageCursor - 5));
  }
  transcriptNearCurrent(): void {
    if (this.transcriptBusy || this.contentMediaId().length === 0) return;
    this.chapterContext = null; this.setChaptersOpen(false);
    this.clearSearch();
    this.clearSelection();
    const position: number = Math.max(0, Math.min(this.contentDurationMs() - 1, this.getSnapshot().contentPositionMs));
    this.transcriptPrevious.push(this.transcriptPageCursor);
    this.transcriptGeneration++;
    this.transcriptSegments = [];
    this.transcriptLoaded = false;
    this.transcriptError = '';
    void this.refreshTranscript(false, position);
  }
  private moveTranscriptPage(cursor: number): void {
    this.clearSelection();
    this.transcriptGeneration++;
    this.transcriptPageCursor = cursor;
    this.transcriptSegments = [];
    this.transcriptNextCursor = null;
    this.transcriptError = '';
    this.transcriptLoaded = false;
    void this.refreshTranscript();
  }
  private clearTranscript(): void {
    this.failedTranscriptAt = -1;
    if (this.diagnosticDraft?.kind === 'transcription') this.clearDiagnosticDraft();
    this.clearChapters();
    this.clearSummaries();
    this.clearSelection(); this.clearSearch();
    this.transcriptGeneration++;
    this.transcriptBusy = false;
    this.transcriptLoaded = false;
    this.transcriptError = '';
    this.transcriptJob = null;
    this.transcriptIdentity = '';
    this.transcriptSegments = [];
    this.transcriptPageCursor = -1;
    this.transcriptNextCursor = null;
    this.transcriptPrevious = [];
    this.lastTranscriptRefresh = 0;
  }
  private validateTranscript(reply: ApiReply, mediaId: string): void {
    if (reply.mediaVersionId !== mediaId || !Array.isArray(reply.segments) ||
      !Number.isSafeInteger(reply.pageCursor) || (reply.pageCursor as number) < -1 ||
      (reply.nextCursor !== null && (!Number.isSafeInteger(reply.nextCursor) || (reply.nextCursor as number) < 0)) ||
      reply.job === undefined) throw new Error('文稿响应无效');
    if (reply.job !== null) {
      const job: TranscriptJob = reply.job as TranscriptJob;
      if (typeof job.id !== 'string' || !['queued', 'processing', 'ready', 'failed'].includes(job.status) ||
        !Number.isSafeInteger(job.durationMs) || job.durationMs <= 0 ||
        !Number.isSafeInteger(job.completedMs) || job.completedMs < 0 || job.completedMs > job.durationMs) {
        throw new Error('文稿状态无效');
      }
    }
    const segments: TranscriptSegment[] = reply.segments as TranscriptSegment[];
    if (segments.length > 1000) throw new Error('文稿分页过大');
    let previous: number = 0;
    for (const segment of segments) {
      if (typeof segment.id !== 'string' || typeof segment.text !== 'string' ||
        !Number.isSafeInteger(segment.startMs) || !Number.isSafeInteger(segment.endMs) ||
        segment.startMs < previous || segment.endMs < segment.startMs ||
        segment.endMs > this.contentDurationMs()) throw new Error('文稿时间戳无效');
      // Adjacent recognition windows can retain a word crossing the core boundary.
      previous = segment.startMs;
    }
  }

  private timeLabel(value: number): string {
    const seconds: number = Math.floor(Math.max(0, value) / 1000);
    return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}`;
  }
  private captureAnchor(): void {
    if (this.chatScope === 'retrieval') {
      this.draftAnchor = { kind: 'retrieval' };
      this.anchorLabel = '按问题检索整期文稿；追问沿用本次原文，需要新证据请重新检索。';
      this.chatError = '';
      return;
    }
    if (this.chatScope === 'selection') this.chatScope = 'near';
    if (this.readingItem !== null) { this.chatError = '正在独立阅读，请先选中文稿，再问这段'; return; }
    const state: AccountViewState = this.getSnapshot();
    if (state.stale || state.mediaVersionId.length === 0) { this.chatError = '当前进度尚未确认，请刷新后点击“问现在听到的”'; return; }
    this.draftAnchor = { kind: 'position', positionMs: Math.round(state.contentPositionMs), scope: this.chatScope,
      capturedAt: new Date().toISOString(), positionSource: state.owner ? 'local' : 'synced' };
    this.anchorLabel = `已固定 ${this.timeLabel(state.contentPositionMs)} · ${this.chatScope === 'near' ? '前两分钟' : this.chatScope === 'until' ? '截至这里' : '整期内容'}`;
    this.chatError = '';
  }
  askNow(question: string = ''): void {
    if (this.chatBusy) return;
    const draft: string = question.length > 0 ? question : this.chatDraft;
    if (this.readingItem !== null) this.returnToCurrent();
    this.parentTurnId = ''; this.draftAnchor = null; this.anchorLabel = '';
    this.chatDraft = draft; this.chatScope = 'near'; this.chatPending = null; this.chatUnconfirmed = false;
    this.captureAnchor(); this.setChatOpen(true); this.emit();
  }
  askRetrieval(): void {
    if (this.chatBusy || this.profile === undefined || this.contentMediaId().length === 0) return;
    this.parentTurnId = '';
    this.chatScope = 'retrieval';
    this.draftAnchor = { kind: 'retrieval' };
    this.anchorLabel = '按问题检索整期文稿；追问沿用本次原文，需要新证据请重新检索。';
    this.chatPending = null; this.chatUnconfirmed = false; this.chatOperationError = false; this.chatError = '';
    this.setChatOpen(true); this.emit();
  }
  followTurn(turnId: string): void {
    if (this.chatBusy) return;
    const turn: ChatTurn | undefined = this.chatTurns.find((value: ChatTurn) => value.id === turnId && value.status === 'complete');
    if (turn === undefined) return;
    if (turn.scope === 'retrieval' && turn.retrieval?.status === 'no-evidence') return;
    this.parentTurnId = turn.id; this.draftAnchor = null;
    if (turn.scope === 'retrieval') {
      this.chatScope = 'retrieval';
      this.anchorLabel = '继续整期检索；追问沿用本次原文，需要新证据请重新检索。';
    } else {
      this.chatScope = turn.scope;
      this.anchorLabel = `继续话题 · ${this.timeLabel(turn.positionMs)}`;
    }
    this.chatPending = null; this.chatUnconfirmed = false; this.emit();
  }
  askCitation(turnId: string, citationId: string): void {
    if (this.chatBusy) return;
    const turn: ChatTurn | undefined = this.chatTurns.find((value: ChatTurn) => value.id === turnId);
    const citation: ChatCitation | undefined = turn?.citations.find((value: ChatCitation) => value.id === citationId);
    if (citation === undefined) return;
    this.parentTurnId = ''; this.draftAnchor = { kind: 'citation-selection', sourceTurnId: turnId, citationIds: [citationId] };
    this.anchorLabel = `引用片段 · ${this.timeLabel(citation.startMs)}`;
    this.chatPending = null; this.chatUnconfirmed = false; this.chatScope = 'selection'; this.setChatOpen(true);
  }
  clearSelection(): void { this.selectedSegments = []; this.selectedAnchor = null; this.emit(); }
  toggleSegment(segmentId: string): void {
    if (this.transcriptBusy || this.transcriptJob === null) return;
    if (this.selectedSegments.length === 1 && this.selectedSegments[0].id === segmentId) { this.clearSelection(); return; }
    this.setTranscriptSelectionRange(this.selectedSegments[0]?.id ?? segmentId, segmentId, false);
  }

  setTranscriptSelectionRange(anchorId: string, endId: string, clampToLimit: boolean = true): void {
    if (!this.transcriptOpen || this.transcriptJob === null) return;
    const anchor: number = this.transcriptSegments.findIndex((row: TranscriptSegment) => row.id === anchorId);
    const end: number = this.transcriptSegments.findIndex((row: TranscriptSegment) => row.id === endId);
    if (anchor < 0 || end < 0) return;
    const overLimit: boolean = Math.abs(end - anchor) >= 32;
    if (overLimit && !clampToLimit) { this.transcriptError = '一次最多选择 32 个连续片段'; this.emit(); return; }
    const last: number = Math.min(anchor + 31, Math.max(anchor - 31, end));
    const from: number = Math.min(anchor, last), to: number = Math.max(anchor, last);
    const message: string = overLimit ? '一次最多选择 32 个连续片段' : '';
    if (this.selectedSegments[0]?.id === this.transcriptSegments[from].id &&
      this.selectedSegments[this.selectedSegments.length - 1]?.id === this.transcriptSegments[to].id && this.transcriptError === message) return;
    if (this.selectedAnchor === null) this.selectedAnchor = { kind: 'transcript-selection', transcriptJobId: this.transcriptJob.id,
      throughMs: this.transcriptJob.completedMs, segmentIds: [] };
    this.selectedSegments = this.transcriptSegments.slice(from, to + 1);
    this.selectedAnchor.segmentIds = this.selectedSegments.map((segment: TranscriptSegment) => segment.id);
    this.transcriptError = message; this.emit();
  }
  askSelection(): void {
    if (this.selectedAnchor === null || this.chatBusy) return;
    this.draftAnchor = JSON.parse(JSON.stringify(this.selectedAnchor)) as ChatAnchor;
    this.parentTurnId = ''; this.chatScope = 'selection'; this.chatPending = null; this.chatUnconfirmed = false;
    this.anchorLabel = `已固定 ${this.selectedSegments.length} 段 · ${this.timeLabel(this.selectedSegments[0].startMs)}`;
    this.setChatOpen(true);
  }
  private clearChapters(): void {
    this.chaptersEpoch++; this.chaptersOpen = false; this.chaptersPage = null;
    this.chaptersBusy = false; this.chaptersMutation = false; this.chaptersError = '';
    this.chaptersAfter = 0; this.chaptersPrevious = []; this.chaptersRequestId = '';
    this.chapterContext = null; this.chapterContextRevision++; this.lastChaptersRefresh = 0;
  }
  setChaptersOpen(open: boolean): void {
    if (this.chaptersOpen !== open) {
      this.chaptersEpoch++; this.chaptersBusy = false; this.chaptersMutation = false;
    }
    this.chaptersOpen = open;
    if (open) void this.refreshChapters();
    else this.chapterContext = null;
    this.emit();
  }
  private validateChapters(page: ChaptersPage, mediaId: string): void {
    if (page.mediaVersionId !== mediaId || typeof page.audioAvailable !== 'boolean' || typeof page.canGenerate !== 'boolean' ||
      typeof page.bridgeOnline !== 'boolean' || !Array.isArray(page.chapters) || page.chapters.length > 40 ||
      (page.nextAfter !== null && (!Number.isSafeInteger(page.nextAfter) || page.nextAfter < 1 || page.nextAfter > 4096))) throw new Error('章节响应无效');
    if (page.document === null) {
      if (page.chapters.length > 0 || page.nextAfter !== null) throw new Error('章节来源缺失');
      return;
    }
    const doc: ChapterDocument = page.document;
    if (doc === undefined || typeof doc.id !== 'string' || doc.id.length === 0 || doc.snapshot === undefined ||
      typeof doc.snapshot.transcriptJobId !== 'string' || !Number.isSafeInteger(doc.snapshot.throughMs) ||
      doc.snapshot.throughMs <= 0 || doc.snapshot.throughMs > this.contentDurationMs() ||
      !['queued','running','complete','failed','cancelled'].includes(doc.status) ||
      !Number.isSafeInteger(doc.totalBatches) || doc.totalBatches < 1 || doc.totalBatches > 128 ||
      !Number.isSafeInteger(doc.completedBatches) || doc.completedBatches < 0 || doc.completedBatches > doc.totalBatches ||
      (doc.status === 'complete' && doc.completedBatches !== doc.totalBatches)) throw new Error('章节生成状态无效');
    const ids: string[] = [];
    for (const chapter of page.chapters) {
      if (typeof chapter.id !== 'string' || chapter.id.length === 0 || chapter.id.length > 100 || ids.includes(chapter.id) ||
        typeof chapter.title !== 'string' || chapter.title.length === 0 || chapter.title.length > 80 ||
        typeof chapter.startSegmentId !== 'string' || chapter.startSegmentId.length === 0 || typeof chapter.endSegmentId !== 'string' ||
        !Number.isSafeInteger(chapter.startMs) || !Number.isSafeInteger(chapter.endMs) || chapter.startMs < 0 || chapter.endMs < chapter.startMs ||
        chapter.endMs > doc.snapshot.throughMs) throw new Error('章节内容或时间范围无效');
      ids.push(chapter.id);
    }
  }
  async refreshChapters(): Promise<void> {
    if (!this.profile || !this.foreground || !this.transcriptOpen || !this.chaptersOpen || this.chaptersBusy || this.chaptersMutation || this.contentMediaId().length === 0) return;
    const mediaId: string = this.contentMediaId(), epoch: number = this.chaptersEpoch;
    const lifecycle: number = this.lifecycle, syncEpoch: number = this.syncEpoch;
    const documentId: string = this.chaptersPage?.document?.id ?? '';
    const query: string = documentId.length > 0 ? `?documentId=${encodeURIComponent(documentId)}&after=${this.chaptersAfter}` : '';
    this.chaptersBusy = true; this.lastChaptersRefresh = Date.now(); this.emit();
    try {
      const reply: ApiReply = await this.authRequest(`/api/media/${encodeURIComponent(mediaId)}/chapters${query}`, http.RequestMethod.GET, '', lifecycle, syncEpoch);
      if (!this.syncLive(lifecycle, syncEpoch) || epoch !== this.chaptersEpoch || mediaId !== this.contentMediaId() || !this.foreground) return;
      const page: ChaptersPage = JSON.parse(JSON.stringify(reply)) as ChaptersPage;
      this.validateChapters(page, mediaId);
      if (documentId.length > 0 && page.document?.id !== documentId) throw new Error('章节记录已变化，请重新打开');
      this.chaptersPage = page; this.chaptersError = '';
    } catch (error) {
      if (this.syncLive(lifecycle, syncEpoch) && epoch === this.chaptersEpoch && !this.readingRemoved(error as Error, mediaId)) this.chaptersError = (error as Error).message;
    } finally { if (epoch === this.chaptersEpoch) this.chaptersBusy = false; this.emit(); }
  }
  nextChapters(): void {
    if (this.chaptersBusy || this.chaptersMutation || this.chaptersPage?.nextAfter === null || this.chaptersPage === null) return;
    this.chaptersPrevious.push(this.chaptersAfter); this.chaptersAfter = this.chaptersPage.nextAfter as number;
    this.chaptersEpoch++; void this.refreshChapters();
  }
  previousChapters(): void {
    if (this.chaptersBusy || this.chaptersMutation || this.chaptersPrevious.length === 0) return;
    this.chaptersAfter = this.chaptersPrevious.pop() as number; this.chaptersEpoch++; void this.refreshChapters();
  }
  async chapterAction(action: string): Promise<void> {
    if (!this.profile || !this.foreground || !this.chaptersOpen || this.chaptersMutation || !['generate','retry','cancel'].includes(action)) return;
    const documentId: string = this.chaptersPage?.document?.id ?? '';
    if (action !== 'generate' && documentId.length === 0) return;
    if (action === 'generate' && this.chaptersRequestId.length === 0) this.chaptersRequestId = util.generateRandomUUID();
    const body: ChapterRequest = action === 'generate' ? { action: action, requestId: this.chaptersRequestId } : { action: action, documentId: documentId };
    const epoch: number = ++this.chaptersEpoch, mediaId: string = this.contentMediaId();
    const lifecycle: number = this.lifecycle, syncEpoch: number = this.syncEpoch;
    this.chaptersBusy = false; this.chaptersMutation = true; this.chaptersError = ''; this.emit();
    try {
      const reply: ApiReply = await this.authRequest(`/api/media/${encodeURIComponent(mediaId)}/chapters`, http.RequestMethod.POST, JSON.stringify(body), lifecycle, syncEpoch);
      if (!this.syncLive(lifecycle, syncEpoch) || epoch !== this.chaptersEpoch || mediaId !== this.contentMediaId()) return;
      const page: ChaptersPage = JSON.parse(JSON.stringify(reply)) as ChaptersPage;
      this.validateChapters(page, mediaId); this.chaptersPage = page;
      this.chaptersAfter = 0; this.chaptersPrevious = [];
    } catch (error) {
      if (this.syncLive(lifecycle, syncEpoch) && epoch === this.chaptersEpoch && !this.readingRemoved(error as Error, mediaId)) this.chaptersError = (error as Error).message;
    } finally { if (epoch === this.chaptersEpoch) this.chaptersMutation = false; this.emit(); }
  }
  returnToChapters(): void {
    this.chapterContext = null; this.transcriptGeneration++; this.transcriptBusy = false; this.clearSelection(); this.emit();
  }
  private clearSummaries(): void {
    this.clearSummaryTopic();
    this.summariesEpoch++; this.summariesOpen = false; this.summariesPage = null;
    this.summariesBusy = false; this.summariesMutation = false; this.summariesError = '';
    this.summariesAfter = 0; this.summariesPrevious = []; this.summariesRequestId = '';
    this.lastSummariesRefresh = 0; this.summaryEvidenceEpoch++;
    this.summaryEvidence = null; this.summaryEvidenceBusy = false; this.summaryEvidenceError = '';
    this.summaryExpandedNode = '';
  }
  setSummariesOpen(open: boolean): void {
    if (this.summariesOpen !== open) { this.summariesEpoch++; this.summariesBusy = false; this.summariesMutation = false; }
    this.summariesOpen = open;
    if (open) void this.refreshSummaries();
    else this.clearSummaryTopic();
    this.emit();
  }
  private validSummaryId(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
  private validateSummaryResult(result: SummaryResult, throughMs: number, maxPoints: number = 6): void {
    if (result === undefined || typeof result.id !== 'string' || result.id.length === 0 || result.id.length > 120 ||
      typeof result.title !== 'string' || result.title.length === 0 || result.title.length > 120 ||
      !Number.isSafeInteger(result.startMs) || !Number.isSafeInteger(result.endMs) || result.startMs < 0 ||
      result.endMs < result.startMs || result.endMs > throughMs || !Array.isArray(result.points) || result.points.length < 1 || result.points.length > maxPoints) throw new Error('总结内容无效');
    for (const point of result.points) {
      if (typeof point.text !== 'string' || point.text.trim().length === 0 || point.text.length > 600 ||
        !Number.isSafeInteger(point.evidenceCount) || point.evidenceCount < 1 || point.evidenceCount > 16) throw new Error('总结要点无效');
    }
  }
  private validateSummaries(page: SummariesPage, mediaId: string): void {
    if (page === undefined) throw new Error('总结响应无效-undefined');
    if (page.mediaVersionId !== mediaId) throw new Error('总结响应无效-media');
    if (typeof page.audioAvailable !== 'boolean') throw new Error('总结响应无效-audio');
    if (typeof page.canGenerate !== 'boolean') throw new Error('总结响应无效');
    if (typeof page.bridgeOnline !== 'boolean') throw new Error('总结响应无效-bridge');
    if (!Array.isArray(page.parts) || page.parts.length > 8) throw new Error('总结响应无效-parts');
    if (page.overview === undefined) throw new Error('总结响应无效-overview');
    if (page.nextAfter !== null && (!Number.isSafeInteger(page.nextAfter) || page.nextAfter < 1 || page.nextAfter > 127)) throw new Error('总结分页响应无效');
    if (page.document === null) {
      if (page.parts.length > 0 || page.overview !== null || page.topicOverview != null || page.nextAfter !== null) throw new Error('总结来源缺失');
      return;
    }
    const doc: SummaryDocument = page.document;
    if (doc === undefined || !this.validSummaryId(doc.id) || doc.snapshot === undefined ||
      !this.validSummaryId(doc.snapshot.transcriptJobId) || !Number.isSafeInteger(doc.snapshot.throughMs) ||
      doc.snapshot.throughMs <= 0 || doc.snapshot.throughMs > this.contentDurationMs() ||
      !['queued','running','complete','failed','cancelled'].includes(doc.status) ||
      !Number.isSafeInteger(doc.totalParts) || doc.totalParts < 1 || doc.totalParts > 128 ||
      !Number.isSafeInteger(doc.completedParts) || doc.completedParts < 0 || doc.completedParts > doc.totalParts ||
      !Number.isSafeInteger(doc.totalTasks) || doc.totalTasks < doc.totalParts || doc.totalTasks > 147 ||
      !Number.isSafeInteger(doc.completedTasks) || doc.completedTasks < 0 || doc.completedTasks > doc.totalTasks ||
      typeof doc.createdAt !== 'string' || !Number.isFinite(Date.parse(doc.createdAt)) ||
      (doc.status === 'complete' && (doc.completedParts !== doc.totalParts || doc.completedTasks !== doc.totalTasks)) ||
      (doc.format !== undefined && doc.format !== 'topics-v1')) throw new Error('总结生成状态无效');
    if (doc.format === 'topics-v1') {
      if (page.overview !== null || ((page.topicOverview != null) !== (doc.status === 'complete'))) throw new Error('总结主题生成状态无效');
    } else if (page.topicOverview != null || ((page.overview !== null) !== (doc.status === 'complete'))) throw new Error('总结生成状态无效');
    if (page.topicOverview != null) {
      if (typeof page.topicOverview.id !== 'string' || page.topicOverview.id.length === 0 || page.topicOverview.id.length > 120 ||
        typeof page.topicOverview.title !== 'string' || page.topicOverview.title.length === 0 || page.topicOverview.title.length > 120 ||
        !Array.isArray(page.topicOverview.topics) || page.topicOverview.topics.length < 1 || page.topicOverview.topics.length > 12) throw new Error('总结主题无效');
      let count: number = 0;
      for (let index: number = 0; index < page.topicOverview.topics.length; index++) {
        const topic: SummaryTopic = page.topicOverview.topics[index];
        if (topic.index !== index || typeof topic.title !== 'string' || topic.title.trim().length === 0 || topic.title.length > 120 ||
          !Number.isSafeInteger(topic.pointCount) || topic.pointCount < 1 || topic.pointCount > 1536) throw new Error('总结主题索引无效');
        count += topic.pointCount;
      }
      if (count > 1536) throw new Error('总结主题总量无效');
    }
    const ids: string[] = [];
    for (const part of page.parts) {
      if (!Number.isSafeInteger(part.index) || part.index < 0 || part.index >= doc.totalParts || ids.includes(part.id)) throw new Error('总结分段索引无效');
      ids.push(part.id); this.validateSummaryResult(part, doc.snapshot.throughMs, doc.format === 'topics-v1' ? 12 : 6);
    }
    if (page.overview !== null) this.validateSummaryResult(page.overview, doc.snapshot.throughMs);
  }
  async refreshSummaries(): Promise<void> {
    if (!this.profile || !this.foreground || !this.transcriptOpen || !this.summariesOpen || this.summariesBusy || this.summariesMutation || this.contentMediaId().length === 0) return;
    const mediaId: string = this.contentMediaId(), epoch: number = this.summariesEpoch;
    const lifecycle: number = this.lifecycle, syncEpoch: number = this.syncEpoch;
    const documentId: string = this.summariesPage?.document?.id ?? '';
    const query: string = `?capabilities=summary-topics-v1${documentId.length > 0 ? `&documentId=${encodeURIComponent(documentId)}&after=${this.summariesAfter}` : ''}`;
    this.summariesBusy = true; this.lastSummariesRefresh = Date.now(); this.emit();
    try {
      const reply: ApiReply = await this.authRequest(`/api/media/${encodeURIComponent(mediaId)}/summaries${query}`, http.RequestMethod.GET, '', lifecycle, syncEpoch);
      if (!this.syncLive(lifecycle, syncEpoch) || epoch !== this.summariesEpoch || mediaId !== this.contentMediaId() || !this.foreground) return;
      const page: SummariesPage = JSON.parse(JSON.stringify(reply)) as SummariesPage;
      this.validateSummaries(page, mediaId);
      if (documentId.length > 0 && (page.document?.id !== documentId || page.document?.snapshot.transcriptJobId !== this.summariesPage?.document?.snapshot.transcriptJobId ||
        page.document?.snapshot.throughMs !== this.summariesPage?.document?.snapshot.throughMs)) throw new Error('总结记录已变化，请重新打开');
      this.summariesPage = page; this.summariesError = '';
    } catch (error) {
      if (this.syncLive(lifecycle, syncEpoch) && epoch === this.summariesEpoch && !this.readingRemoved(error as Error, mediaId)) this.summariesError = (error as Error).message;
    } finally { if (epoch === this.summariesEpoch) this.summariesBusy = false; this.emit(); }
  }
  nextSummaries(): void {
    if (this.summariesBusy || this.summariesMutation || this.summariesPage?.nextAfter === null || this.summariesPage === null) return;
    this.summariesPrevious.push(this.summariesAfter); this.summariesAfter = this.summariesPage.nextAfter as number;
    this.summariesEpoch++; void this.refreshSummaries();
  }
  previousSummaries(): void {
    if (this.summariesBusy || this.summariesMutation || this.summariesPrevious.length === 0) return;
    this.summariesAfter = this.summariesPrevious.pop() as number; this.summariesEpoch++; void this.refreshSummaries();
  }
  async summaryAction(action: string): Promise<void> {
    if (!this.profile || !this.foreground || !this.summariesOpen || this.summariesMutation || !['generate','retry','cancel'].includes(action)) return;
    const documentId: string = this.summariesPage?.document?.id ?? '';
    if (action !== 'generate' && documentId.length === 0) return;
    if (action === 'generate' && this.summariesPage?.canGenerate !== true) return;
    if (action === 'generate' && this.summariesRequestId.length === 0) this.summariesRequestId = util.generateRandomUUID();
    const body: SummaryRequest = action === 'generate' ? { action: action, requestId: this.summariesRequestId } : { action: action, documentId: documentId };
    const epoch: number = ++this.summariesEpoch, mediaId: string = this.contentMediaId();
    const lifecycle: number = this.lifecycle, syncEpoch: number = this.syncEpoch;
    this.summariesBusy = false; this.summariesMutation = true; this.summariesError = ''; this.emit();
    try {
      const reply: ApiReply = await this.authRequest(`/api/media/${encodeURIComponent(mediaId)}/summaries?capabilities=summary-topics-v1`, http.RequestMethod.POST, JSON.stringify(body), lifecycle, syncEpoch);
      if (!this.syncLive(lifecycle, syncEpoch) || epoch !== this.summariesEpoch || mediaId !== this.contentMediaId()) return;
      const page: SummariesPage = JSON.parse(JSON.stringify(reply)) as SummariesPage;
      this.validateSummaries(page, mediaId);
      if (action !== 'generate' && (page.document?.id !== documentId || page.document?.snapshot.transcriptJobId !== this.summariesPage?.document?.snapshot.transcriptJobId ||
        page.document?.snapshot.throughMs !== this.summariesPage?.document?.snapshot.throughMs)) throw new Error('总结记录已变化，请重新打开');
      if (page.document?.id !== documentId) {
        this.clearSummaryTopic();
      }
      this.summariesPage = page; this.summariesAfter = 0; this.summariesPrevious = [];
      if (action === 'generate') this.summariesRequestId = '';
    } catch (error) {
      if (this.syncLive(lifecycle, syncEpoch) && epoch === this.summariesEpoch && !this.readingRemoved(error as Error, mediaId)) this.summariesError = (error as Error).message;
    } finally { if (epoch === this.summariesEpoch) this.summariesMutation = false; this.emit(); }
  }
  private clearSummaryEvidence(): void {
    this.summaryEvidenceEpoch++; this.summaryEvidence = null; this.summaryEvidenceBusy = false;
    this.summaryEvidenceError = ''; this.summaryExpandedNode = '';
  }
  private clearSummaryTopic(): void {
    this.summaryTopicEpoch++; this.summaryTopicPage = null; this.summaryTopicIndex = -1;
    this.summaryTopicBusy = false; this.summaryTopicError = ''; this.summaryTopicAfter = 0; this.summaryTopicPrevious = [];
    this.clearSummaryEvidence();
  }
  openSummaryTopic(index: number): void {
    if (!this.profile || !this.foreground || !this.summariesOpen || !Number.isSafeInteger(index) || index < 0 || index > 11 ||
      this.summariesPage?.topicOverview?.topics[index] === undefined) return;
    if (this.summaryTopicIndex === index) { this.clearSummaryTopic(); this.emit(); return; }
    this.clearSummaryTopic(); this.summaryTopicIndex = index; void this.refreshSummaryTopic();
  }
  nextSummaryTopic(): void {
    if (this.summaryTopicBusy || this.summaryTopicPage?.nextAfter === null || this.summaryTopicPage === null) return;
    this.summaryTopicPrevious.push(this.summaryTopicAfter); this.summaryTopicAfter = this.summaryTopicPage.nextAfter as number;
    void this.refreshSummaryTopic();
  }
  previousSummaryTopic(): void {
    if (this.summaryTopicBusy || this.summaryTopicPrevious.length === 0) return;
    this.summaryTopicAfter = this.summaryTopicPrevious.pop() as number; void this.refreshSummaryTopic();
  }
  async refreshSummaryTopic(): Promise<void> {
    if (!this.profile || !this.foreground || !this.summariesOpen || this.summaryTopicBusy || this.summariesPage?.document?.format !== 'topics-v1') return;
    const topic: SummaryTopic | undefined = this.summariesPage.topicOverview?.topics[this.summaryTopicIndex];
    const doc: SummaryDocument = this.summariesPage.document;
    if (topic === undefined || !Number.isSafeInteger(this.summaryTopicAfter) || this.summaryTopicAfter < 0 || this.summaryTopicAfter >= topic.pointCount) return;
    const epoch: number = ++this.summaryTopicEpoch, lifecycle: number = this.lifecycle, syncEpoch: number = this.syncEpoch;
    const mediaId: string = this.contentMediaId(), after: number = this.summaryTopicAfter;
    this.clearSummaryEvidence(); this.summaryTopicPage = null; this.summaryTopicBusy = true; this.summaryTopicError = ''; this.emit();
    try {
      const reply: ApiReply = await this.authRequest(`/api/media/${encodeURIComponent(mediaId)}/summaries/topics?capabilities=summary-topics-v1&documentId=${encodeURIComponent(doc.id)}&topicIndex=${topic.index}&after=${after}`, http.RequestMethod.GET, '', lifecycle, syncEpoch);
      if (!this.syncLive(lifecycle, syncEpoch) || epoch !== this.summaryTopicEpoch || mediaId !== this.contentMediaId() || !this.foreground || !this.summariesOpen || this.summariesPage?.document?.id !== doc.id ||
        this.summariesPage.document.snapshot.transcriptJobId !== doc.snapshot.transcriptJobId || this.summariesPage.document.snapshot.throughMs !== doc.snapshot.throughMs) return;
      const page: SummaryTopicPage = JSON.parse(JSON.stringify(reply)) as SummaryTopicPage;
      this.validateSummaryTopicPage(page, mediaId, doc, topic, after); this.summaryTopicPage = page;
    } catch (error) {
      if (this.syncLive(lifecycle, syncEpoch) && epoch === this.summaryTopicEpoch && !this.readingRemoved(error as Error, mediaId)) this.summaryTopicError = (error as Error).message;
    } finally { if (epoch === this.summaryTopicEpoch) this.summaryTopicBusy = false; this.emit(); }
  }
  private validateSummaryTopicPage(page: SummaryTopicPage, mediaId: string, doc: SummaryDocument, topic: SummaryTopic, after: number): void {
    if (page === undefined || page.mediaVersionId !== mediaId || page.documentId !== doc.id || page.topicIndex !== topic.index || page.title !== topic.title ||
      page.totalPoints !== topic.pointCount || page.after !== after || page.snapshot === undefined ||
      page.snapshot.transcriptJobId !== doc.snapshot.transcriptJobId || page.snapshot.throughMs !== doc.snapshot.throughMs ||
      !Array.isArray(page.points) || page.points.length !== Math.min(20, topic.pointCount - after) || page.points.length < 1 ||
      page.nextAfter !== (after + page.points.length < topic.pointCount ? after + page.points.length : null)) throw new Error('主题分页响应无效');
    const ids: string[] = [];
    for (const point of page.points) {
      if (typeof point.nodeId !== 'string' || point.nodeId.length === 0 || point.nodeId.length > 120 || !Number.isSafeInteger(point.pointIndex) || point.pointIndex < 0 || point.pointIndex > 11 ||
        typeof point.text !== 'string' || point.text.trim().length === 0 || point.text.length > 600 || !Number.isSafeInteger(point.evidenceCount) || point.evidenceCount < 1 || point.evidenceCount > 16 ||
        !Number.isSafeInteger(point.startMs) || !Number.isSafeInteger(point.endMs) || point.startMs < 0 || point.endMs < point.startMs || point.endMs > doc.snapshot.throughMs ||
        ids.includes(`${point.nodeId}:${point.pointIndex}`)) throw new Error('主题要点响应无效');
      ids.push(`${point.nodeId}:${point.pointIndex}`);
    }
  }
  async toggleSummaryPoint(nodeId: string, pointIndex: number): Promise<void> {
    if (!this.profile || !this.foreground || !this.summariesOpen || this.summariesPage?.document === null || this.summariesPage?.document === undefined ||
      !Number.isSafeInteger(pointIndex) || pointIndex < 0 || pointIndex > (this.summariesPage.document.format === 'topics-v1' ? 11 : 5)) return;
    const result: SummaryResult | undefined = this.summariesPage.overview?.id === nodeId ? this.summariesPage.overview : this.summariesPage.parts.find((part: SummaryPart) => part.id === nodeId);
    const topicPoint: SummaryTopicPoint | undefined = this.summaryTopicPage?.points.find((point: SummaryTopicPoint) => point.nodeId === nodeId && point.pointIndex === pointIndex);
    if (result?.points[pointIndex] === undefined && topicPoint === undefined) return;
    const key: string = `${nodeId}:${pointIndex}`;
    if (this.summaryExpandedNode === key && this.summaryEvidenceError.length === 0) { this.clearSummaryEvidence(); this.emit(); return; }
    const mediaId: string = this.contentMediaId(), documentId: string = this.summariesPage.document.id;
    const epoch: number = ++this.summaryEvidenceEpoch, lifecycle: number = this.lifecycle, syncEpoch: number = this.syncEpoch;
    this.summaryExpandedNode = key; this.summaryEvidence = null; this.summaryEvidenceBusy = true; this.summaryEvidenceError = ''; this.emit();
    try {
      const reply: ApiReply = await this.authRequest(`/api/media/${encodeURIComponent(mediaId)}/summaries/evidence?documentId=${encodeURIComponent(documentId)}&nodeId=${encodeURIComponent(nodeId)}&pointIndex=${pointIndex}`,
        http.RequestMethod.GET, '', lifecycle, syncEpoch);
      if (!this.syncLive(lifecycle, syncEpoch) || epoch !== this.summaryEvidenceEpoch || mediaId !== this.contentMediaId() || !this.summariesOpen || !this.foreground || this.summariesPage?.document?.id !== documentId) return;
      const evidence: SummaryEvidence = JSON.parse(JSON.stringify(reply.evidence ?? reply)) as SummaryEvidence;
      this.validateSummaryEvidence(evidence, mediaId, documentId, nodeId, pointIndex);
      this.summaryEvidence = evidence;
    } catch (error) {
      if (this.syncLive(lifecycle, syncEpoch) && epoch === this.summaryEvidenceEpoch) { this.summaryEvidenceError = (error as Error).message; this.summaryEvidence = null; }
    } finally { if (epoch === this.summaryEvidenceEpoch) this.summaryEvidenceBusy = false; this.emit(); }
  }
  private validateSummaryEvidence(value: SummaryEvidence, mediaId: string, documentId: string, nodeId: string, pointIndex: number): void {
    if (value === undefined || value.mediaVersionId !== mediaId || value.documentId !== documentId || value.nodeId !== nodeId ||
      value.pointIndex !== pointIndex || value.snapshot === undefined || !this.validSummaryId(value.snapshot.transcriptJobId) ||
      this.summariesPage?.document?.snapshot.transcriptJobId !== value.snapshot.transcriptJobId ||
      this.summariesPage?.document?.snapshot.throughMs !== value.snapshot.throughMs || typeof value.audioAvailable !== 'boolean' ||
      !Array.isArray(value.segments) || value.segments.length < 1 || value.segments.length > 16) throw new Error('总结依据无效');
    const ids: string[] = [];
    for (const segment of value.segments) {
      if (typeof segment.id !== 'string' || segment.id.length === 0 || segment.id.length > 120 || ids.includes(segment.id) ||
        typeof segment.text !== 'string' || segment.text.length === 0 || !Number.isSafeInteger(segment.startMs) || !Number.isSafeInteger(segment.endMs) ||
        segment.startMs < 0 || segment.endMs < segment.startMs || segment.endMs > value.snapshot.throughMs) throw new Error('总结依据片段无效');
      ids.push(segment.id);
    }
  }
  clearSearch(): void {
    this.knowledgeEpoch++; this.searchBusy = false; this.searchPage = null;
    this.searchQuery = ''; this.searchError = ''; this.searchView = ''; this.searchContextId = '';
    this.searchContextRevision++; this.emit();
  }
  returnToSearch(): void {
    if (this.searchPage === null) return;
    this.transcriptGeneration++; this.transcriptBusy = false; this.clearSelection();
    this.searchView = 'results'; this.searchContextId = ''; this.transcriptError = ''; this.emit();
  }
  async showContext(positionMs: number, searchId: string = '', chapterId: string = ''): Promise<void> {
    const chapter: Chapter | undefined = chapterId.length > 0 ? this.chaptersPage?.chapters.find((item: Chapter) => item.id === chapterId) : undefined;
    if (chapterId.length > 0 && (chapter === undefined || chapter.startMs !== positionMs || searchId.length > 0)) return;
    this.chapterContext = null; this.chapterContextRevision++;
    if (searchId.length > 0) {
      const hit: SearchResult | undefined = this.searchPage?.results.find((result: SearchResult) => result.id === searchId);
      if (hit === undefined || hit.startMs !== positionMs) return;
      this.knowledgeEpoch++; this.searchBusy = false;
      this.searchView = 'context'; this.searchContextId = hit.id; this.searchContextMs = hit.startMs; this.searchContextRevision++;
    } else this.clearSearch();
    if (chapter !== undefined) { this.chapterContext = chapter; this.chaptersOpen = true; }
    else this.setChaptersOpen(false);
    this.clearSelection(); this.transcriptGeneration++; this.transcriptBusy = false;
    this.transcriptSegments = []; this.transcriptLoaded = false; this.transcriptError = '';
    this.transcriptOpen = true; this.transcriptPrevious.push(this.transcriptPageCursor);
    await this.refreshTranscript(false, positionMs); this.emit();
  }
  async searchTranscript(query: string, next: boolean = false): Promise<void> {
    if (!this.profile || this.searchBusy || this.contentMediaId().length === 0 || query.trim().length === 0) return;
    const term: string = next ? this.searchPage?.query ?? '' : query.trim();
    const previous: SearchPage | null = next ? this.searchPage : null;
    const cursor: string | null = next ? this.searchPage?.nextCursor ?? null : null;
    if (next && cursor === null) return;
    if (!next) {
      this.chapterContext = null; this.setChaptersOpen(false);
      this.knowledgeEpoch++; this.clearSelection(); this.searchPage = null;
      this.transcriptGeneration++; this.transcriptBusy = false;
    }
    this.searchView = 'results'; this.searchContextId = '';
    const mediaId: string = this.contentMediaId(), epoch: number = this.knowledgeEpoch;
    const lifecycle: number = this.lifecycle, syncEpoch: number = this.syncEpoch;
    this.searchBusy = true; this.searchError = ''; this.searchQuery = term; this.emit();
    try {
      const raw: ApiReply = await this.authRequest(`/api/media/${encodeURIComponent(mediaId)}/transcript/search?q=${encodeURIComponent(term)}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
        http.RequestMethod.GET, '', lifecycle, syncEpoch);
      if (!this.syncLive(lifecycle, syncEpoch) || epoch !== this.knowledgeEpoch || mediaId !== this.contentMediaId()) return;
      const page: SearchPage = JSON.parse(JSON.stringify(raw)) as SearchPage;
      if (page.mediaVersionId !== mediaId || page.query !== term || !Array.isArray(page.results) || page.snapshot === undefined) throw new Error('搜索响应无效');
      if (previous !== null) {
        if (page.snapshot.transcriptJobId !== previous.snapshot.transcriptJobId || page.snapshot.throughMs !== previous.snapshot.throughMs) throw new Error('搜索范围已变化，请重新搜索');
        page.results = previous.results.concat(page.results.filter((result: SearchResult) => !previous.results.some((old: SearchResult) => old.id === result.id)));
      }
      this.searchPage = page;
    } catch (error) { if (epoch === this.knowledgeEpoch) this.searchError = (error as Error).message; }
    finally { if (epoch === this.knowledgeEpoch) this.searchBusy = false; this.emit(); }
  }
  askSearchResult(result: SearchResult): void {
    if (this.searchPage === null || this.chatBusy) return;
    this.draftAnchor = { kind: 'transcript-selection', transcriptJobId: this.searchPage.snapshot.transcriptJobId,
      throughMs: this.searchPage.snapshot.throughMs, segmentIds: [result.id] };
    this.parentTurnId = ''; this.chatScope = 'selection'; this.chatPending = null; this.chatUnconfirmed = false;
    this.anchorLabel = `搜索片段 · ${this.timeLabel(result.startMs)}`; this.setChatOpen(true);
  }
  private syncSavedFilter(): void {
    if (!this.savedThisEpisode || this.savedMediaId === this.contentMediaId()) return;
    this.savedMediaId = this.contentMediaId(); this.savedEpoch++; this.savedBusy = false;
    this.savedItems = []; this.savedCursor = null; this.savedExpanded = false; this.savedError = '';
    if (this.savedOpen) void this.refreshSaved(false, true);
  }
  setSavedOpen(open: boolean, thisEpisode: boolean = false): void {
    this.savedEpoch++; this.savedBusy = false; this.savedOpen = open;
    // Hiding the panel does not discard a later page or an unfinished note.
    if (!open) { this.emit(); return; }
    const mediaId: string = thisEpisode ? this.contentMediaId() : '';
    if (thisEpisode === this.savedThisEpisode && mediaId === this.savedMediaId && this.savedItems.length > 0 && (this.savedExpanded || this.savedEditing)) {
      this.emit(); return;
    }
    this.savedThisEpisode = thisEpisode; this.savedMediaId = mediaId;
    this.savedItems = []; this.savedCursor = null; this.savedExpanded = false; this.savedError = '';
    void this.refreshSaved(false, true); this.emit();
  }
  setSavedEditing(editing: boolean, id: string = '', mediaId: string = ''): void {
    this.savedEditing = editing; this.savedEditingId = editing ? id : ''; this.savedEditingMediaId = editing ? mediaId : '';
    this.emit();
  }
  async refreshSaved(next: boolean = false, reset: boolean = false): Promise<void> {
    if (!this.profile || !this.savedOpen || this.savedBusy || this.savedMutationBusy || !this.foreground) return;
    if (next && this.savedCursor === null) return;
    // Keep subsequent pages and an in-progress note visible until explicit refresh.
    const protectsDraft: boolean = this.savedEditing && (this.savedMediaId.length === 0 || this.savedMediaId === this.savedEditingMediaId);
    if (!next && !reset && (this.savedExpanded || protectsDraft)) return;
    const epoch: number = this.savedEpoch, lifecycle: number = this.lifecycle, syncEpoch: number = this.syncEpoch;
    const mediaId: string = this.savedMediaId;
    const cursor: string | null = next ? this.savedCursor : null;
    this.savedBusy = true; this.lastSavedRefresh = Date.now(); this.emit();
    try {
      const raw: ApiReply = await this.authRequest(`/api/saved-items?${mediaId.length > 0 ? `mediaVersionId=${encodeURIComponent(mediaId)}&` : ''}${cursor === null ? '' : `cursor=${encodeURIComponent(cursor)}`}`,
        http.RequestMethod.GET, '', lifecycle, syncEpoch);
      if (!this.syncLive(lifecycle, syncEpoch) || epoch !== this.savedEpoch || (this.savedThisEpisode && mediaId !== this.contentMediaId())) return;
      const page: SavedPage = JSON.parse(JSON.stringify(raw)) as SavedPage;
      if (!Array.isArray(page.items)) throw new Error('收藏响应无效');
      if (!next && !reset && this.savedEditing && (this.savedMediaId.length === 0 || this.savedMediaId === this.savedEditingMediaId)) return;
      this.savedExpanded = next || (this.savedExpanded && !reset);
      this.savedItems = next ? this.savedItems.concat(page.items) : page.items;
      this.savedCursor = page.nextCursor; this.savedError = '';
    } catch (error) { if (epoch === this.savedEpoch) this.savedError = (error as Error).message; }
    finally { if (epoch === this.savedEpoch) this.savedBusy = false; this.emit(); }
  }
  async saveSelection(): Promise<void> {
    if (this.selectedAnchor === null) return;
    const source: SavedSource = { kind: 'transcript-selection', transcriptJobId: this.selectedAnchor.transcriptJobId,
      throughMs: this.selectedAnchor.throughMs, segmentIds: this.selectedAnchor.segmentIds?.slice() };
    await this.saveSource(source);
  }
  async saveAnswer(turnId: string): Promise<void> { await this.saveSource({ kind: 'answer', turnId: turnId }); }
  async saveSearchResult(result: SearchResult): Promise<void> {
    if (this.searchPage === null) return;
    await this.saveSource({ kind: 'transcript-selection', transcriptJobId: this.searchPage.snapshot.transcriptJobId,
      throughMs: this.searchPage.snapshot.throughMs, segmentIds: [result.id] });
  }
  private async saveSource(source: SavedSource): Promise<void> {
    if (!this.profile || this.savedBusy || this.savedMutationBusy) return;
    if (this.pendingSave === null || this.pendingSave.mediaVersionId !== this.contentMediaId() || JSON.stringify(this.pendingSave.source) !== JSON.stringify(source)) {
      this.pendingSave = { requestId: util.generateRandomUUID(), mediaVersionId: this.contentMediaId(), source: source };
    }
    const pending: SaveRequest = this.pendingSave;
    const saved: boolean = await this.savedAction('/api/saved-items', http.RequestMethod.POST, JSON.stringify(pending));
    if (saved && this.pendingSave === pending) this.pendingSave = null;
  }
  async updateSavedNote(id: string, note: string): Promise<boolean> {
    const body: NoteRequest = { note: note };
    return await this.savedAction(`/api/saved-items/${encodeURIComponent(id)}`, http.RequestMethod.PATCH, JSON.stringify(body));
  }
  async deleteSaved(id: string): Promise<void> { await this.savedAction(`/api/saved-items/${encodeURIComponent(id)}`, http.RequestMethod.DELETE, ''); }
  private async savedAction(path: string, method: http.RequestMethod, body: string): Promise<boolean> {
    if (!this.profile || this.savedBusy || this.savedMutationBusy) return false;
    const lifecycle: number = this.lifecycle, syncEpoch: number = this.syncEpoch;
    const id: string = decodeURIComponent(path.substring(path.lastIndexOf('/') + 1));
    // List navigation retires GETs, but must not retire an in-flight mutation for this account.
    this.savedMutationBusy = true; this.savedError = ''; this.emit();
    try {
      const reply: ApiReply = await this.authRequest(path, method, body, lifecycle, syncEpoch);
      if (!this.syncLive(lifecycle, syncEpoch)) return false;
      if (method === http.RequestMethod.PATCH) {
        const updated: SavedItem = JSON.parse(JSON.stringify(reply)) as SavedItem;
        if (updated.id !== id || typeof updated.note !== 'string' || typeof updated.updatedAt !== 'string' || typeof updated.mediaVersionId !== 'string') {
          throw new Error('备注保存结果无法确认，请重试');
        }
        // Update matching cached rows only; never insert an old filter's item into a new filter.
        this.savedItems = this.savedItems.map((item: SavedItem) => {
          if (item.id === updated.id && item.mediaVersionId === updated.mediaVersionId) { item.note = updated.note; item.updatedAt = updated.updatedAt; }
          return item;
        });
      }
      if (method === http.RequestMethod.DELETE) {
        this.savedItems = this.savedItems.filter((item: SavedItem) => item.id !== id);
        if (this.savedEditingId === id) { this.savedEditing = false; this.savedEditingId = ''; this.savedEditingMediaId = ''; }
      }
      this.hint = method === http.RequestMethod.DELETE ? '收藏已删除' : '收藏已保存';
      return true;
    } catch (error) {
      if (this.syncLive(lifecycle, syncEpoch)) {
        this.savedError = (error as Error).message;
        if (error instanceof ApiFailure && error.status === 404 && this.savedEditingId === id) {
          this.savedEditing = false; this.savedEditingId = ''; this.savedEditingMediaId = '';
        }
      }
      return false;
    } finally {
      if (this.syncLive(lifecycle, syncEpoch)) { this.savedMutationBusy = false; void this.refreshSaved(); this.emit(); }
    }
  }
  async readSaved(item: SavedItem): Promise<void> {
    if (!this.profile) return;
    const intent: number = ++this.readingIntentEpoch;
    const lifecycle: number = this.lifecycle, syncEpoch: number = this.syncEpoch;
    const libraryWasOpen: boolean = this.libraryOpen;
    this.libraryOpen = true;
    await this.refreshLibrary();
    if (!this.syncLive(lifecycle, syncEpoch) || intent !== this.readingIntentEpoch) return;
    this.libraryOpen = libraryWasOpen;
    this.selectReading(item.mediaVersionId);
    if (this.contentMediaId() !== item.mediaVersionId) { this.savedError = '来源资料已删除或尚未加载'; this.emit(); return; }
    const first: KnowledgeSegment | undefined = item.content.segments[0] ?? item.content.citations[0];
    if (first !== undefined) await this.showContext(first.startMs);
  }

  setChatOpen(open: boolean): void {
    this.chatOpen = open;
    if (!open) this.invalidateChatRequests();
    else void this.refreshChat();
    this.emit();
  }
  setChatDraft(value: string): void {
    if (this.chatBusy) return;
    if (this.chatOperationError) { this.chatOperationError = false; this.chatError = ''; }
    if (value.trim().length > 0 && this.draftAnchor === null && this.parentTurnId.length === 0) this.captureAnchor();
    this.chatDraft = value.slice(0, 2000);
    this.chatPending = null;
    this.chatUnconfirmed = false;
    this.emit();
  }
  setChatScope(value: string): void {
    if (this.chatBusy || !['near', 'until', 'all'].includes(value)) return;
    if (this.readingItem !== null && value !== 'all') return;
    this.chatScope = value;
    this.parentTurnId = ''; this.draftAnchor = null; this.anchorLabel = '';
    if (this.chatDraft.trim().length > 0) this.captureAnchor();
    this.chatPending = null;
    this.chatUnconfirmed = false;
    this.emit();
  }
  async refreshChat(): Promise<void> {
    if (!this.profile || !this.foreground || !this.chatOpen || this.chatBusy || this.chatRefreshing || this.contentMediaId().length === 0) return;
    const lifecycle: number = this.lifecycle, syncEpoch: number = this.syncEpoch;
    const generation: number = this.chatGeneration;
    const mediaId: string = this.contentMediaId();
    this.chatRefreshing = true;
    this.lastChatRefresh = Date.now();
    try {
      const query: string = `?capabilities=${encodeURIComponent('anchored-v1,retrieval-v1')}${this.chatBefore === null ? '' : `&before=${this.chatBefore}`}`;
      const reply: ApiReply = await this.authRequest(`/api/media/${encodeURIComponent(mediaId)}/chat${query}`,
        http.RequestMethod.GET, '', lifecycle, syncEpoch);
      if (!this.chatLive(lifecycle, syncEpoch, generation, mediaId)) return;
      if (reply.mediaVersionId !== mediaId || !Array.isArray(reply.turns) || reply.turns.length > 20 ||
        typeof reply.bridgeOnline !== 'boolean' ||
        (reply.retrievalOnline !== undefined && typeof reply.retrievalOnline !== 'boolean') || (reply.nextBefore !== null &&
        (!Number.isSafeInteger(reply.nextBefore) || (reply.nextBefore as number) <= 0))) throw new Error('对话响应无效');
      const turns: ChatTurn[] = reply.turns as ChatTurn[];
      let previous: number = 0;
      for (const turn of turns) {
        this.validateChatTurn(turn);
        if (turn.sequence <= previous) throw new Error('对话顺序无效');
        previous = turn.sequence;
      }
      this.chatTurns = turns.slice();
      this.chatBridgeOnline = reply.bridgeOnline as boolean;
      this.chatRetrievalOnline = reply.retrievalOnline === true;
      // Older servers may omit this field; reading remains available, replay stays disabled.
      this.chatAudioAvailable = reply.audioAvailable === true;
      this.chatNextBefore = reply.nextBefore as number | null;
      this.chatLoaded = true;
      if (!this.chatUnconfirmed && !this.chatOperationError) this.chatError = '';
    } catch (error) {
      if (this.chatLive(lifecycle, syncEpoch, generation, mediaId) && !this.readingRemoved(error as Error, mediaId)) this.chatError = (error as Error).message;
    } finally {
      if (generation === this.chatGeneration) this.chatRefreshing = false;
      if (this.live(lifecycle)) this.emit();
    }
  }
  earlierChat(): void {
    if (this.chatBusy || this.chatNextBefore === null) return;
    this.moveChatPage(this.chatNextBefore);
  }
  latestChat(): void {
    if (this.chatBusy) return;
    this.moveChatPage(null);
  }
  private moveChatPage(before: number | null): void {
    this.invalidateChatRequests();
    this.chatBefore = before;
    this.chatTurns = [];
    this.chatNextBefore = null;
    this.chatLoaded = false;
    this.chatError = '';
    void this.refreshChat();
    this.emit();
  }
  async sendChat(): Promise<void> {
    if (!this.getSnapshot().chatCanSend || this.contentMediaId().length === 0) return;
    if (this.chatPending === null) {
      this.chatPending = this.parentTurnId.length > 0 ?
        { requestId: util.generateRandomUUID(), question: this.chatDraft.trim(), parentTurnId: this.parentTurnId } :
        { requestId: util.generateRandomUUID(), question: this.chatDraft.trim(), anchor: this.draftAnchor as ChatAnchor };
    }
    const pending: ChatRequest = this.chatPending;
    this.chatRequestSubmitted = false;
    const sent: boolean = await this.chatAction(`/api/media/${encodeURIComponent(this.contentMediaId())}/chat`, JSON.stringify(pending));
    if (this.chatPending !== pending) return;
    if (sent) { this.chatPending = null; this.chatUnconfirmed = false; this.chatDraft = ''; }
    else { this.chatUnconfirmed = this.chatRequestSubmitted; if (!this.chatRequestSubmitted) this.chatPending = null; }
    this.emit();
  }
  async retryChat(id: string): Promise<void> {
    const turn: ChatTurn | undefined = this.chatTurns.find((value: ChatTurn) => value.id === id);
    if (this.chatBefore !== null || this.chatHasActive() || turn?.status !== 'failed') return;
    await this.chatAction(`/api/chat/turns/${encodeURIComponent(id)}/retry`);
  }
  async cancelChat(id: string): Promise<void> {
    const turn: ChatTurn | undefined = this.chatTurns.find((value: ChatTurn) => value.id === id);
    if (turn?.status !== 'queued' && turn?.status !== 'running') return;
    await this.chatAction(`/api/chat/turns/${encodeURIComponent(id)}/cancel`);
  }
  private async chatAction(path: string, body: string = ''): Promise<boolean> {
    if (!this.profile || !this.foreground || !this.chatOpen || this.chatBusy || this.contentMediaId().length === 0) return false;
    this.invalidateChatRequests();
    const generation: number = this.chatGeneration;
    const lifecycle: number = this.lifecycle, syncEpoch: number = this.syncEpoch;
    const mediaId: string = this.contentMediaId();
    this.chatBusy = true;
    this.chatError = ''; this.chatOperationError = false;
    this.emit();
    try {
      if (path.endsWith('/chat') && !this.chatUnconfirmed) {
        await this.authRequest(`${path}/check`, http.RequestMethod.POST, body, lifecycle, syncEpoch);
        if (!this.chatLive(lifecycle, syncEpoch, generation, mediaId)) return false;
      }
      if (path.endsWith('/chat')) this.chatRequestSubmitted = true;
      const reply: ApiReply = await this.authRequest(path, http.RequestMethod.POST, body, lifecycle, syncEpoch);
      if (!this.chatLive(lifecycle, syncEpoch, generation, mediaId)) return false;
      if (reply.turn === undefined) throw new Error('提交结果无法确认，请重试');
      const turn: ChatTurn = reply.turn;
      this.validateChatTurn(turn);
      const updated: ChatTurn[] = this.chatTurns.filter((value: ChatTurn) => value.id !== turn.id);
      updated.push(turn);
      if (path.endsWith('/chat')) {
        this.draftAnchor = null;
        if (turn.scope === 'retrieval' && turn.retrieval?.status === 'no-evidence') {
          this.parentTurnId = '';
          this.chatScope = 'retrieval';
          this.draftAnchor = { kind: 'retrieval' };
          this.anchorLabel = '按问题检索整期文稿；追问沿用本次原文，需要新证据请重新检索。';
        } else if (turn.scope === 'retrieval') {
          this.parentTurnId = turn.id;
          this.chatScope = 'retrieval';
          this.anchorLabel = '继续整期检索；追问沿用本次原文，需要新证据请重新检索。';
        } else {
          this.parentTurnId = turn.id;
          this.chatScope = turn.scope;
          this.anchorLabel = `继续话题 · ${this.timeLabel(turn.positionMs)}`;
        }
      }
      this.chatTurns = updated.sort((a: ChatTurn, b: ChatTurn) => a.sequence - b.sequence).slice(-20);
      return true;
    } catch (error) {
      if (error instanceof ApiFailure && error.status >= 400 && error.status < 500) this.chatRequestSubmitted = false;
      if (this.chatLive(lifecycle, syncEpoch, generation, mediaId)) this.chatOperationError = true;
      if (this.chatLive(lifecycle, syncEpoch, generation, mediaId) && !this.readingRemoved(error as Error, mediaId)) this.chatError = (error as Error).message;
      return false;
    } finally {
      if (generation === this.chatGeneration) {
        this.chatBusy = false;
        void this.refreshChat();
      }
      if (this.live(lifecycle)) this.emit();
    }
  }
  private chatHasActive(): boolean {
    return this.chatTurns.some((turn: ChatTurn) => turn.status === 'queued' || turn.status === 'running');
  }
  private chatLive(lifecycle: number, syncEpoch: number, generation: number, mediaId: string): boolean {
    return this.syncLive(lifecycle, syncEpoch) && generation === this.chatGeneration &&
      this.contentMediaId() === mediaId && this.chatOpen && this.foreground;
  }
  private invalidateChatRequests(): void {
    this.chatGeneration++;
    if (this.chatBusy && this.chatPending !== null) this.chatUnconfirmed = true;
    this.chatBusy = false;
    this.chatRefreshing = false;
    this.lastChatRefresh = 0;
  }
  private clearChat(): void {
    this.invalidateChatRequests();
    this.chatLoaded = false;
    this.chatError = ''; this.chatOperationError = false;
    this.chatTurns = [];
    this.chatBridgeOnline = false;
    this.chatRetrievalOnline = false;
    this.chatAudioAvailable = false;
    this.chatBefore = null;
    this.chatNextBefore = null;
    this.chatMediaId = '';
    this.chatDraft = '';
    this.parentTurnId = ''; this.draftAnchor = null; this.anchorLabel = '';
    this.chatScope = 'near';
    this.chatPending = null;
    this.chatUnconfirmed = false;
  }
  private validateChatTurn(turn: ChatTurn): void {
    if (typeof turn.id !== 'string' || !Number.isSafeInteger(turn.sequence) || turn.sequence <= 0 ||
      typeof turn.question !== 'string' || typeof turn.answer !== 'string' ||
      !['queued', 'running', 'complete', 'failed', 'cancelled'].includes(turn.status) ||
      !['near', 'until', 'all', 'selection', 'retrieval'].includes(turn.scope) || !Number.isSafeInteger(turn.positionMs) ||
      turn.positionMs < 0 || turn.positionMs > this.contentDurationMs() || !Array.isArray(turn.citations)) {
      throw new Error('对话内容无效');
    }
    if (turn.scope === 'retrieval') {
      if (turn.anchor?.kind !== 'retrieval' || turn.retrieval === undefined || turn.retrieval === null) {
        throw new Error('整期检索内容无效');
      }
      this.validateChatRetrieval(turn.retrieval);
    } else if (turn.retrieval !== undefined && turn.retrieval !== null) {
      throw new Error('对话检索内容无效');
    }
    for (const citation of turn.citations) {
      if (typeof citation.id !== 'string' || typeof citation.text !== 'string' ||
        !Number.isSafeInteger(citation.startMs) || !Number.isSafeInteger(citation.endMs) ||
        citation.startMs < 0 || citation.endMs < citation.startMs ||
        citation.endMs > this.contentDurationMs()) throw new Error('回答引用无效');
    }
  }
  private validateChatRetrieval(value: ChatRetrieval): void {
    const snapshot = value.snapshot;
    if (value.strategy !== 'lexical-v1' || !['matched', 'no-evidence'].includes(value.status) ||
      snapshot === undefined || snapshot === null || typeof snapshot !== 'object' || typeof snapshot.transcriptJobId !== 'string' || snapshot.transcriptJobId.length === 0 ||
      !Number.isSafeInteger(snapshot.throughMs) || snapshot.throughMs <= 0 || snapshot.throughMs !== this.contentDurationMs() ||
      !Number.isSafeInteger(value.totalSegments) || value.totalSegments < 0 || value.totalSegments > 48000 ||
      !Number.isSafeInteger(value.matchedSegments) || value.matchedSegments < 0 || value.matchedSegments > value.totalSegments ||
      !Number.isSafeInteger(value.selectedSegments) || value.selectedSegments < 0 || value.selectedSegments > 32 || value.selectedSegments > value.totalSegments ||
      !Array.isArray(value.sourceSegmentIds) || value.sourceSegmentIds.length !== value.selectedSegments ||
      value.sourceSegmentIds.some((id: string) => typeof id !== 'string' || id.length === 0 || id.length > 100) ||
      value.sourceSegmentIds.some((id: string, index: number) => value.sourceSegmentIds.indexOf(id) !== index) ||
      !Array.isArray(value.queryTerms) || value.queryTerms.length > 32 ||
      value.queryTerms.some((term: string) => typeof term !== 'string' || term.length === 0 || term.length > 80) ||
      (value.status === 'matched' && (value.matchedSegments < 1 || value.selectedSegments === 0 || value.queryTerms.length === 0)) ||
      (value.status === 'no-evidence' && value.selectedSegments !== 0)) throw new Error('整期检索内容无效');
  }

  async refreshLibrary(force: boolean = false): Promise<void> {
    if (!this.profile || !this.foreground || !this.libraryOpen || (this.libraryBusy && !force) ||
      this.libraryRefreshGeneration === this.libraryGeneration) return;
    const generation: number = this.libraryGeneration;
    const lifecycle: number = this.lifecycle;
    const syncEpoch: number = this.syncEpoch;
    this.libraryRefreshGeneration = generation;
    this.lastLibraryRefresh = Date.now();
    try {
      const replies: ApiReply[] = await Promise.all([
        this.authRequest('/api/library', http.RequestMethod.GET, '', lifecycle, syncEpoch),
        this.authRequest('/api/imports', http.RequestMethod.GET, '', lifecycle, syncEpoch)
      ]);
      if (!this.syncLive(lifecycle, syncEpoch) || generation !== this.libraryGeneration) return;
      if (!Array.isArray(replies[0].items) || !Array.isArray(replies[1].jobs)) throw new Error('资料列表响应无效');
      const usage: LibraryUsage | undefined = replies[0].usage;
      if (usage !== undefined && ![usage.usedBytes, usage.reservedBytes, usage.reclaimingBytes,
        usage.limitBytes, usage.itemCount, usage.itemLimit].every((value: number) => Number.isSafeInteger(value) && value >= 0)) {
        throw new Error('容量信息响应无效');
      }
      const items: LibraryItem[] = (replies[0].items as LibraryItem[]).slice(0, 100);
      for (const item of items) {
        const summary: LibraryTranscript | null | undefined = item.transcript;
        if (summary !== null && summary !== undefined &&
          (!['queued', 'processing', 'ready', 'failed'].includes(summary.status) ||
          !Number.isSafeInteger(summary.completedMs) || !Number.isSafeInteger(summary.durationMs) ||
          summary.completedMs < 0 || summary.durationMs <= 0 || summary.completedMs > summary.durationMs)) {
          throw new Error('资料文稿状态响应无效');
        }
      }
      this.libraryItems = items;
      if (this.ownsPlayback() && items.some((item: LibraryItem) =>
        item.mediaVersionId === this.snapshot?.mediaVersionId && item.audioAvailable === false)) this.dropControl();
      this.libraryUsage = usage ?? null;
      this.importJobs = (replies[1].jobs as ImportJob[]).slice(0, 100);
      if (this.readingItem !== null) {
        const selected: LibraryItem | undefined = this.libraryItems.find((item: LibraryItem) => item.mediaVersionId === this.readingItem?.mediaVersionId);
        if (selected !== undefined) this.readingItem = selected;
      }
      this.libraryError = '';
    } catch (error) {
      if (this.syncLive(lifecycle, syncEpoch) && generation === this.libraryGeneration) this.libraryError = (error as Error).message;
    } finally {
      if (this.libraryRefreshGeneration === generation) this.libraryRefreshGeneration = -1;
      if (this.live(lifecycle)) this.emit();
    }
  }

  async previewFeed(url: string): Promise<void> {
    const body: ImportRequest = { url: url.trim(), kind: 'auto' };
    await this.libraryAction('/api/imports/preview', JSON.stringify(body), true);
  }
  async importAudio(url: string, title: string = ''): Promise<void> {
    const body: ImportRequest = { url: url.trim() };
    if (title.trim().length > 0) body.title = title.trim();
    await this.libraryAction('/api/imports', JSON.stringify(body), false);
  }
  async retryImport(id: string): Promise<void> {
    if (!/^[a-f0-9-]{36}$/i.test(id)) return;
    await this.libraryAction(`/api/imports/${encodeURIComponent(id)}/retry`, '{}', false);
  }
  async removeLibrary(mediaId: string, mode: string): Promise<void> {
    const item: LibraryItem | undefined = this.libraryItems.find((value: LibraryItem) => value.mediaVersionId === mediaId);
    if (item === undefined || item.deletable !== true || !['audio', 'all'].includes(mode) ||
      (mode === 'audio' && item.audioAvailable === false)) return;
    const body: RemoveRequest = { mode: mode };
    await this.removeResource(`/api/library/${encodeURIComponent(mediaId)}/remove`, JSON.stringify(body), mediaId, mode);
  }
  async removeImport(id: string): Promise<void> {
    const job: ImportJob | undefined = this.importJobs.find((value: ImportJob) => value.id === id);
    if (job === undefined || !['queued', 'failed'].includes(job.status)) return;
    await this.removeResource(`/api/imports/${encodeURIComponent(id)}/remove`, '{}', '', 'import');
  }
  private async removeResource(path: string, body: string, mediaId: string, mode: string): Promise<void> {
    if (!this.profile || this.libraryBusy) return;
    const lifecycle: number = this.lifecycle, syncEpoch: number = this.syncEpoch;
    // Retire an in-flight list before mutating so it cannot restore deleted rows.
    const generation: number = ++this.libraryGeneration;
    this.libraryRefreshGeneration = -1;
    this.libraryBusy = true;
    this.libraryError = '';
    this.emit();
    try {
      const reply: ApiReply = await this.authRequest(path, http.RequestMethod.POST, body, lifecycle, syncEpoch);
      if (!this.syncLive(lifecycle, syncEpoch) || generation !== this.libraryGeneration) return;
      if (this.replayPoint?.mediaVersionId === mediaId || this.snapshot?.mediaVersionId === mediaId) this.replayPoint = null;
      if (mode === 'all') {
        if (this.savedEditingMediaId === mediaId) { this.savedEditing = false; this.savedEditingId = ''; this.savedEditingMediaId = ''; }
        this.savedItems = this.savedItems.filter((item: SavedItem) => item.mediaVersionId !== mediaId);
        this.savedEpoch++; this.savedBusy = false;
        this.libraryItems = this.libraryItems.filter((item: LibraryItem) => item.mediaVersionId !== mediaId);
        if (this.readingItem?.mediaVersionId === mediaId) this.returnToCurrent();
      } else if (mode === 'audio') {
        const item: LibraryItem | undefined = this.libraryItems.find((value: LibraryItem) => value.mediaVersionId === mediaId);
        if (item !== undefined) item.audioAvailable = false;
        if (this.readingItem?.mediaVersionId === mediaId) this.readingItem.audioAvailable = false;
        this.savedItems.forEach((saved: SavedItem) => { if (saved.mediaVersionId === mediaId) saved.audioAvailable = false; });
      }
      if (mediaId.length > 0 && this.snapshot?.mediaVersionId === mediaId) this.dropControl();
      if (reply.snapshot !== undefined) this.applySnapshot(reply.snapshot);
      this.hint = mode === 'audio' ? '音频已清理，文稿和对话已保留；空间回收可能稍有延迟' :
        mode === 'all' ? '整期资料已删除；空间回收可能稍有延迟' : '导入任务已移除';
      await this.refreshLibrary(true);
      if (mediaId.length > 0) await this.refresh();
    } catch (error) {
      if (this.syncLive(lifecycle, syncEpoch) && generation === this.libraryGeneration) this.libraryError = (error as Error).message;
    } finally {
      if (generation === this.libraryGeneration) this.libraryBusy = false;
      if (this.live(lifecycle)) this.emit();
    }
  }
  private async libraryAction(path: string, body: string, preview: boolean): Promise<void> {
    if (!this.profile || this.libraryBusy) return;
    const lifecycle: number = this.lifecycle, syncEpoch: number = this.syncEpoch;
    const generation: number = this.libraryGeneration;
    this.libraryBusy = true;
    this.libraryError = '';
    if (preview) { this.feedEpisodes = []; this.feedTitle = ''; }
    this.emit();
    try {
      const reply: ApiReply = await this.authRequest(path, http.RequestMethod.POST, body, lifecycle, syncEpoch);
      if (!this.syncLive(lifecycle, syncEpoch) || generation !== this.libraryGeneration) return;
      if (preview) {
        if (!Array.isArray(reply.episodes)) throw new Error('没有可选择的音频单集');
        this.feedEpisodes = (reply.episodes as FeedEpisode[]).slice(0, 100);
        this.feedTitle = reply.title ?? '播客单集';
      } else {
        this.hint = '导入任务已提交，可在资料列表查看进度';
        await this.refreshLibrary(true);
      }
    } catch (error) {
      if (this.syncLive(lifecycle, syncEpoch) && generation === this.libraryGeneration) this.libraryError = (error as Error).message;
    } finally {
      if (generation === this.libraryGeneration) this.libraryBusy = false;
      if (this.live(lifecycle)) this.emit();
    }
  }

  release(): void {
    this.lifecycle++;
    this.initialized = false;
    this.clearAccount();
    if (this.ticker >= 0) clearInterval(this.ticker);
    this.ticker = -1;
    if (this.unsubscribePlayer !== undefined) this.unsubscribePlayer();
    this.unsubscribePlayer = undefined;
  }

  private installProfile(reply: ApiReply, token: string, base: string): void {
    this.validateProfile(reply);
    this.clearAccountDiagnostics();
    this.profile = reply.session;
    this.accountEmail = (reply.user as AccountUser).email;
    this.token = token;
    this.baseUrl = base;
    this.controlGranted = false;
    this.snapshot = undefined;
    this.lastConfirmed = 0;
  }

  private validateProfile(reply: ApiReply): void {
    if (reply.user === undefined || reply.session === undefined || typeof reply.user.id !== 'string' ||
      typeof reply.user.email !== 'string' || typeof reply.session.id !== 'string' ||
      typeof reply.session.expiresAt !== 'string' || !Number.isFinite(Date.parse(reply.session.expiresAt))) {
      throw new Error('登录响应无效');
    }
  }

  private async beginFollowing(lifecycle: number): Promise<void> {
    await this.player.pause();
    if (!this.live(lifecycle)) return;
    this.stream.start(`${this.baseUrl}/api/events`, this.token);
    this.updateNetworkPolicy();
    await this.refresh();
    void this.refreshLibrary();
  }

  private receiveEvent(event: StreamEvent): void {
    if (this.profile === undefined) return;
    if (event.event === 'session-expired') { void this.expire('登录已过期，请重新登录'); return; }
    if (event.event !== 'snapshot' && event.event !== 'playback' && event.event !== 'reset') return;
    const snapshot: SyncedPlayback = JSON.parse(event.data) as SyncedPlayback;
    if (event.event === 'reset') { this.resetSnapshot(snapshot); return; }
    this.applySnapshot(snapshot);
  }

  private resetSnapshot(snapshot: SyncedPlayback): void {
    this.validateSnapshot(snapshot);
    // A reset replaces the authoritative history, even when revision/generation decrease.
    // Keep the account alive but invalidate every request belonging to the old history.
    const previousEpoch: number = this.syncEpoch;
    this.syncEpoch++;
    this.clearDiagnosticDraft();
    this.replayChanging = false; this.replayPoint = null; this.pendingReplayPoint = null;
    this.savedMutationBusy = false; this.savedEpoch++; this.savedBusy = false;
    this.cancelSyncRequests();
    this.clearTranscript();
    this.invalidateChatRequests();
    this.refreshEpoch = -1;
    this.reportEpoch = -1;
    if (this.takeoverEpoch === previousEpoch) this.busy = false;
    this.takeoverEpoch = -1;
    this.pendingTakeover = undefined;
    this.dropControl();
    this.acknowledgedSequence = 0;
    this.lastReportSent = 0;
    this.lastRefresh = 0;
    this.snapshot = undefined;
    this.error = '';
    this.syncError = '';
    this.hint = '云端进度已重新载入，本机已暂停，请确认后重新接管';
    this.applySnapshot(snapshot);
    // start() clears Last-Event-ID; the retired stream must not restore its old cursor.
    this.stream.start(`${this.baseUrl}/api/events`, this.token);
    this.updateNetworkPolicy();
    void this.refresh();
  }

  private applySnapshot(snapshot: SyncedPlayback): void {
    this.validateSnapshot(snapshot);
    this.lastConfirmed = Date.now();
    this.syncError = '';
    if (this.snapshot !== undefined && snapshot.revision <= this.snapshot.revision) { this.emit(); return; }
    const previous: SyncedPlayback | undefined = this.snapshot;
    const previousContentId: string = this.contentMediaId();
    this.snapshot = snapshot;
    if (!this.replayChanging && snapshot.ownerSessionId !== this.profile?.id) this.pendingReplayPoint = null;
    if (!this.replayChanging && this.replayPoint !== null && !this.restoreSnapshotCompatible(this.replayPoint)) {
      this.replayPoint = null;
      if (this.pendingTakeover?.intent === 'restore') this.pendingTakeover = undefined;
    }
    const contentId: string = this.contentMediaId();
    this.syncSavedFilter();
    if (this.chatMediaId !== contentId) {
      this.clearChat();
      this.chatMediaId = contentId;
      if (this.readingItem !== null) this.chatScope = 'all';
      void this.refreshChat();
    }
    if (previousContentId !== contentId) {
      this.clearTranscript();
      void this.refreshTranscript();
    }
    if (this.controlGranted && (snapshot.ownerSessionId !== this.profile?.id ||
      snapshot.generation !== previous?.generation || snapshot.playbackSessionId !== previous?.playbackSessionId)) {
      this.dropControl();
      this.hint = '已切换到其他播放设备，本机已暂停';
    }
    // Acknowledgements advance metadata only; never seek an owner back to an old report position.
    if (this.ownsPlayback()) this.acknowledgedSequence = Math.max(this.acknowledgedSequence, snapshot.sequence);
    this.updateNetworkPolicy();
    this.emit();
  }

  private observePlayer(state: PlaybackViewState): void {
    if (!this.aligning && !this.replayChanging && this.replayPoint !== null && this.replayPoint.endMs >= 0 && this.ownsPlayback() && state.mediaVersionId === this.snapshot?.mediaVersionId && state.playerState === 'playing' && state.positionMs >= this.replayPoint.endMs) {
      this.replayPoint.endMs = -1; void this.player.pause();
    }
    const previous: PlaybackViewState = this.lastPlayer;
    this.lastPlayer = state;
    if (this.profile !== undefined && !this.ownsPlayback() && state.playerState === 'playing') this.pauseForSafety();
    if (this.ownsPlayback() && !this.aligning && state.mediaVersionId === this.snapshot?.mediaVersionId) {
      const seekFinished: boolean = state.events[0] !== previous.events[0] &&
        (state.events[0] || '').includes('跳转完成');
      if (state.playerState !== previous.playerState || state.buffering !== previous.buffering || state.rate !== previous.rate ||
        state.looping !== previous.looping || seekFinished) {
        this.reportDirty = true;
        void this.flushReport();
      }
    }
    this.updateNetworkPolicy();
    this.emit();
  }

  private tick(): void {
    if (this.profile !== undefined) {
      if (Date.parse(this.profile.expiresAt) <= Date.now()) { void this.expire('登录已过期，请重新登录'); return; }
      if (this.ownsPlayback() && this.lastPlayer.playerState === 'playing' && Date.now() - this.lastReportSent >= 3000) {
        this.reportDirty = true;
      }
      if ((this.reportDirty || this.pendingReport !== undefined) && Date.now() - this.lastReportSent >= 3000) {
        void this.flushReport();
      }
      if (this.foreground && Date.now() - this.lastRefresh >= 5000) void this.refresh();
      if (this.foreground && this.libraryOpen && Date.now() - this.lastLibraryRefresh >= 5000) void this.refreshLibrary();
      if (this.foreground && this.transcriptOpen && Date.now() - this.lastTranscriptRefresh >= 5000) void this.refreshTranscript();
      if (this.foreground && this.transcriptOpen && this.chaptersOpen && Date.now() - this.lastChaptersRefresh >= 5000) void this.refreshChapters();
      if (this.foreground && this.transcriptOpen && this.summariesOpen && Date.now() - this.lastSummariesRefresh >= 5000) void this.refreshSummaries();
      if (this.foreground && this.chatOpen && Date.now() - this.lastChatRefresh >= 2000) void this.refreshChat();
      if (this.foreground && this.savedOpen && Date.now() - this.lastSavedRefresh >= 5000) void this.refreshSaved();
    }
    this.emit();
  }

  private async refresh(): Promise<void> {
    if (this.refreshEpoch === this.syncEpoch || this.profile === undefined) return;
    const lifecycle: number = this.lifecycle;
    const syncEpoch: number = this.syncEpoch;
    this.refreshEpoch = syncEpoch;
    this.lastRefresh = Date.now();
    try {
      const reply: ApiReply = await this.authRequest('/api/playback', http.RequestMethod.GET, '', lifecycle, syncEpoch);
      if (!this.syncLive(lifecycle, syncEpoch)) return;
      if (reply.snapshot === undefined) throw new Error('服务器未返回播放进度');
      this.applySnapshot(reply.snapshot);
    } catch (error) {
      if (this.syncLive(lifecycle, syncEpoch)) this.syncError = (error as Error).message;
    } finally {
      if (this.refreshEpoch === syncEpoch) this.refreshEpoch = -1;
      if (this.syncLive(lifecycle, syncEpoch)) this.emit();
    }
  }

  private async flushReport(): Promise<void> {
    if (this.reportEpoch === this.syncEpoch || !this.ownsPlayback() || this.aligning || this.snapshot === undefined ||
      (!this.reportDirty && this.pendingReport === undefined)) return;
    const lifecycle: number = this.lifecycle;
    const syncEpoch: number = this.syncEpoch;
    const epoch: number = this.controlEpoch;
    if (this.pendingReport === undefined) {
      const local: PlaybackViewState = this.player.getSnapshot();
      if (!local.ready || local.mediaVersionId !== this.snapshot.mediaVersionId || local.contentId !== this.snapshot.contentId) return;
      this.pendingReport = {
        generation: this.snapshot.generation, playbackSessionId: this.snapshot.playbackSessionId as string,
        sequence: this.acknowledgedSequence + 1, contentId: this.snapshot.contentId, mediaVersionId: this.snapshot.mediaVersionId,
        positionMs: Math.round(Math.min(this.snapshot.durationMs, Math.max(0, local.positionMs))),
        speed: local.rate, state: this.reportState(local), looping: local.looping
      };
      this.reportDirty = false;
    }
    const report: PlaybackReport = this.pendingReport;
    this.reportEpoch = syncEpoch;
    this.lastReportSent = Date.now();
    try {
      const reply: ApiReply = await this.authRequest('/api/playback/report', http.RequestMethod.POST,
        JSON.stringify(report), lifecycle, syncEpoch);
      if (!this.syncLive(lifecycle, syncEpoch) || epoch !== this.controlEpoch) return;
      if (reply.snapshot === undefined) throw new Error('服务器未确认播放进度');
      this.pendingReport = undefined;
      this.applySnapshot(reply.snapshot);
      if (this.ownsPlayback()) this.acknowledgedSequence = Math.max(this.acknowledgedSequence, report.sequence);
    } catch (error) {
      if (!this.syncLive(lifecycle, syncEpoch) || epoch !== this.controlEpoch) return;
      if (error instanceof ApiFailure && error.status === 409) {
        this.dropControl();
        if (error.snapshot !== undefined) this.applySnapshot(error.snapshot);
        this.hint = '播放进度已更新，请确认后重新接管';
      } else {
        this.syncError = (error as Error).message;
      }
    } finally {
      if (this.reportEpoch === syncEpoch) this.reportEpoch = -1;
      if (this.syncLive(lifecycle, syncEpoch)) {
        this.emit();
        // A newly queued local change can follow a confirmed report immediately.
        if (this.pendingReport === undefined && this.reportDirty) void this.flushReport();
      }
    }
  }

  private async authRequest(path: string, method: http.RequestMethod, body: string, lifecycle: number,
    syncEpoch: number): Promise<ApiReply> {
    const reply: ApiReply = await this.request(this.baseUrl, path, method, body, this.token, true).catch(async (error: Error) => {
      if (this.syncLive(lifecycle, syncEpoch) && error instanceof ApiFailure && error.status === 401) {
        await this.expire('登录已过期，请重新登录');
      }
      throw error;
    });
    return reply;
  }

  private async request(base: string, path: string, method: http.RequestMethod, body: string,
    token: string = '', syncRequest: boolean = false): Promise<ApiReply> {
    const request: http.HttpRequest = http.createHttp();
    this.requests.push(request);
    if (syncRequest) this.syncRequests.push(request);
    const headers: Record<string, string> = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
    if (token.length > 0) headers['Authorization'] = `Bearer ${token}`;
    const options: http.HttpRequestOptions = {
      method: method, header: headers, expectDataType: http.HttpDataType.STRING,
      connectTimeout: 8000,
      readTimeout: path === '/api/auth/request-code' ? 45000 : path === '/api/imports/preview' ? 25000 : 8000,
      usingCache: false, usingProxy: false,
      maxLimit: 262144, maxRedirects: 0
    };
    if (body.length > 0) options.extraData = body;
    try {
      const response: http.HttpResponse = await request.request(`${base}${path}`, options);
      const raw: string = typeof response.result === 'string' ? response.result : '';
      let reply: ApiReply = {};
      try { if (raw.length > 0) reply = JSON.parse(raw) as ApiReply; }
      catch (_error) { throw new ApiFailure(response.responseCode, '服务器响应格式无效'); }
      if (reply === null || typeof reply !== 'object') throw new ApiFailure(response.responseCode, '服务器响应格式无效');
      if (response.responseCode < 200 || response.responseCode >= 300) {
        throw new ApiFailure(response.responseCode, reply.error?.message ?? `请求失败（${response.responseCode}）`, reply.snapshot);
      }
      return reply;
    } finally {
      const syncIndex: number = this.syncRequests.indexOf(request);
      if (syncIndex >= 0) this.syncRequests.splice(syncIndex, 1);
      const index: number = this.requests.indexOf(request);
      if (index >= 0) { this.requests.splice(index, 1); request.destroy(); }
    }
  }

  private async expire(message: string): Promise<void> {
    const lifecycle: number = ++this.lifecycle;
    this.clearAccount();
    this.hint = message;
    this.emit();
    const clear: Promise<void> = this.vault.clear().catch((_error: Error) => {
      if (this.live(lifecycle)) this.error = '登录已失效，但安全存储清理失败';
    });
    await this.player.pause();
    await clear;
    if (this.live(lifecycle)) this.emit();
  }

  private clearAccount(): void {
    this.clearAccountDiagnostics();
    this.replayChanging = false;
    this.savedMutationBusy = false; this.savedMediaId = ''; this.savedEditingId = ''; this.savedEditingMediaId = '';
    this.readingIntentEpoch++;
    this.pendingSave = null; this.pendingReplayPoint = null; this.replayPoint = null; this.savedItems = []; this.savedOpen = false; this.savedCursor = null; this.savedExpanded = false; this.savedEditing = false; this.savedEpoch++; this.savedBusy = false; this.savedError = '';
    this.readingItem = null;
    this.libraryUsage = null;
    this.chatOpen = false;
    this.clearChat();
    this.transcriptOpen = false;
    this.clearTranscript();
    this.libraryGeneration++;
    this.libraryRefreshGeneration = -1;
    this.libraryBusy = false;
    this.libraryItems = [];
    this.importJobs = [];
    this.feedEpisodes = [];
    this.feedTitle = '';
    this.libraryError = '';
    this.syncEpoch++;
    this.refreshEpoch = -1;
    this.reportEpoch = -1;
    this.takeoverEpoch = -1;
    this.profile = undefined;
    this.token = '';
    this.accountEmail = '';
    this.busy = false;
    this.restoring = false;
    this.challengeId = '';
    this.controlGranted = false;
    this.controlEpoch++;
    this.aligning = false;
    this.pendingReport = undefined;
    this.reportDirty = false;
    this.pendingTakeover = undefined;
    this.snapshot = undefined;
    this.lastConfirmed = 0;
    this.error = '';
    this.syncError = '';
    this.stream.stop();
    const requests: http.HttpRequest[] = this.requests.slice();
    this.requests = [];
    this.syncRequests = [];
    for (const request of requests) request.destroy();
    // Removing account control must also remove the private source from the local player.
    if (this.initialized) void this.player.loadFixture().catch((_error: Error) => {});
  }

  private cancelSyncRequests(): void {
    const requests: http.HttpRequest[] = this.syncRequests.slice();
    this.syncRequests = [];
    for (const request of requests) {
      const index: number = this.requests.indexOf(request);
      if (index >= 0) this.requests.splice(index, 1);
      request.destroy();
    }
  }

  private dropControl(): void {
    this.controlGranted = false;
    this.controlEpoch++;
    this.aligning = false;
    this.pendingReport = undefined;
    this.reportDirty = false;
    this.player.cancelMediaLoading();
    this.pauseForSafety();
    this.updateNetworkPolicy();
  }

  private pauseForSafety(): void {
    if (this.safetyPausing) return;
    this.safetyPausing = true;
    void this.player.pause().finally(() => { this.safetyPausing = false; });
  }

  private ownsPlayback(): boolean {
    return this.controlGranted && this.profile !== undefined && this.snapshot !== undefined &&
      this.snapshot.ownerSessionId === this.profile.id && this.snapshot.playbackSessionId !== null;
  }
  private mayControl(): boolean {
    return this.player.getSnapshot().ready && this.controlsCurrentMedia();
  }

  private controlsCurrentMedia(): boolean {
    const local: PlaybackViewState = this.player.getSnapshot();
    return this.profile === undefined ? local.mediaVersionId === 'fixture-pcm-v1' :
      this.ownsPlayback() && !this.aligning && local.mediaVersionId === this.snapshot?.mediaVersionId &&
      this.libraryItems.find((item: LibraryItem) => item.mediaVersionId === local.mediaVersionId)?.audioAvailable !== false;
  }
  private live(lifecycle: number): boolean { return this.initialized && lifecycle === this.lifecycle; }
  private syncLive(lifecycle: number, syncEpoch: number): boolean {
    return this.live(lifecycle) && syncEpoch === this.syncEpoch;
  }
  private assertControl(lifecycle: number, epoch: number): void {
    if (!this.live(lifecycle) || !this.ownsPlayback() || epoch !== this.controlEpoch) throw new Error('播放设备已发生变化');
  }
  private updateNetworkPolicy(): void {
    this.stream.setForeground(this.foreground ||
      (this.ownsPlayback() && (this.lastPlayer.playerState === 'playing' || this.lastPlayer.recovering === true)));
  }
  private reportState(state: PlaybackViewState): string {
    if (state.buffering && state.playerState === 'playing') return 'buffering';
    if (state.playerState === 'playing') return 'playing';
    if (state.playerState === 'completed') return 'ended';
    return 'paused';
  }
  private projectPosition(snapshot: SyncedPlayback): number {
    const elapsed: number = Math.max(0, Date.now() - Date.parse(snapshot.updatedAt));
    // A live connection does not prove that the playback owner is still reporting.
    // Once its sample is stale, show the last authoritative position instead of inventing progress.
    const advance: number = snapshot.state === 'playing' && elapsed <= 10000 ? elapsed * snapshot.speed : 0;
    const position: number = snapshot.positionMs + (Number.isFinite(advance) ? advance : 0);
    if (snapshot.looping && snapshot.durationMs > 0) return Math.floor(position % snapshot.durationMs);
    return Math.floor(Math.min(snapshot.durationMs, Math.max(0, position)));
  }
  private validateBase(value: string): string {
    const base: string = value.trim().replace(/\/+$/, '');
    if (!/^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/.test(base) &&
      !/^http:\/\/(127\.0\.0\.1|localhost)(:[0-9]{1,5})?$/.test(base)) {
      throw new Error('请使用 HTTPS 服务地址；本机测试可用 http://127.0.0.1:3000');
    }
    return base;
  }
  private validateSnapshot(snapshot: SyncedPlayback): void {
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || !Number.isSafeInteger(snapshot.generation) ||
      snapshot.generation < 0 || !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0 ||
      !Number.isFinite(snapshot.positionMs) || snapshot.positionMs < 0 || snapshot.positionMs > snapshot.durationMs ||
      !Number.isFinite(snapshot.durationMs) || snapshot.durationMs <= 0 || snapshot.durationMs > 21600000 ||
      typeof snapshot.contentId !== 'string' || typeof snapshot.mediaVersionId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(snapshot.contentId) || !/^[A-Za-z0-9_-]{1,100}$/.test(snapshot.mediaVersionId) ||
      ![1, 1.25, 1.5, 2].includes(snapshot.speed) || typeof snapshot.looping !== 'boolean' ||
      !Number.isFinite(Date.parse(snapshot.updatedAt))) throw new Error('服务器播放进度无效或音频版本不匹配');
  }
  private async waitReady(lifecycle: number, epoch: number, mediaVersionId: string): Promise<void> {
    const deadline: number = Date.now() + 5000;
    while (!this.player.getSnapshot().ready || this.player.getSnapshot().mediaVersionId !== mediaVersionId) {
      this.assertControl(lifecycle, epoch);
      if (Date.now() > deadline) throw new Error('音频尚未准备好，请稍后重试');
      await new Promise<void>((resolve: () => void) => { setTimeout(resolve, 100); });
    }
  }
  private async waitAligned(position: number, speed: number, lifecycle: number, epoch: number): Promise<void> {
    const deadline: number = Date.now() + 3000;
    while (true) {
      this.assertControl(lifecycle, epoch);
      const state: PlaybackViewState = this.player.getSnapshot();
      if (Math.abs(state.positionMs - position) <= 500 && state.rate === speed) return;
      if (Date.now() > deadline) throw new Error('播放位置尚未对齐，请重试');
      await new Promise<void>((resolve: () => void) => { setTimeout(resolve, 50); });
    }
  }
  private emit(): void {
    if (this.diagnosticDraft !== undefined && !this.diagnosticMatches(this.diagnosticDraft)) this.clearDiagnosticDraft();
    const snapshot: AccountViewState = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
