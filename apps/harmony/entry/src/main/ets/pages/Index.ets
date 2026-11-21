import { KeyboardAvoidMode } from '@kit.ArkUI';
import { PrimaryTabs } from '../components/PrimaryTabs';
import { TranscriptSentences } from '../components/TranscriptSentences';
import { SearchResult, SearchHighlight, SavedItem } from '../services/KnowledgeTypes';
import { Chapter } from '../services/ChapterTypes';
import { SummaryPart, SummaryResult, SummaryEvidence, SummaryPoint, SummaryTopicOverview, SummaryTopic, SummaryTopicPoint } from '../services/SummaryTypes';
import { PlaybackService, PlaybackViewState } from '../services/PlaybackService';
import { ConnectionProbe, ProbeViewState } from '../services/ConnectionProbe';
import { AccountSync, AccountViewState, LibraryItem, ImportJob, FeedEpisode, TranscriptJob, TranscriptSegment, ChatTurn, ChatCitation } from '../services/AccountSync';
import { DEBUG } from 'BuildProfile';
interface TextPiece { text: string; marked: boolean; }
const PLAYER_BACK_SWIPE_DISTANCE: number = 64; // vp

@Entry
@Component
struct Index {
  @State private viewState: PlaybackViewState = PlaybackService.getInstance().getSnapshot();
  @State private seekValue: number = 0;
  @State private probeState: ProbeViewState = ConnectionProbe.getInstance().getSnapshot();
  @State private serverUrl: string = AccountSync.getInstance().getSnapshot().baseUrl;
  @State private account: AccountViewState = AccountSync.getInstance().getSnapshot();
  @State private email: string = '';
  @State private code: string = '';
  @State private showDiagnostics: boolean = false;
  @State private showLibrary: boolean = false;
  @State private importUrl: string = '';
  @State private section: string = 'listen';
  @State private searchText: string = '';
  @State private editingSaved: string = '';
  @State private noteDraft: string = '';
  @State private editingSavedTitle: string = '';
  @State private expandedChatTurn: string = '';
  @State private accountOpen: boolean = false;
  @State private importOpen: boolean = false;
  @State private chatOptionsOpen: boolean = false;
  @State private inputFocused: boolean = false;
  @State private citationSheetOpen: boolean = false;
  @State private citationTurnId: string = '';
  @State private citationFilter: string[] = [];
  @State private showPlayerOptions: boolean = false;
  private pageVisible: boolean = false;
  private chatScroller: Scroller = new Scroller();
  private chatScrollTarget: string = '';
  private chatAtBottom: boolean = true;
  private followComposerResize: boolean = false;
  private dragging: boolean = false;
  private unsubscribe: (() => void) | undefined = undefined;
  private unsubscribeProbe: (() => void) | undefined = undefined;
  private unsubscribeAccount: (() => void) | undefined = undefined;
  private rates: number[] = [1, 1.25, 1.5, 2];
  private readerScroller: Scroller = new Scroller();
  private scrollWindowY: number = 0;
  private scrollWindowHeight: number = 0;
  @State private activeSentenceId: string = '';
  @State private followTranscript: boolean = true;
  @State private draggingSelection: boolean = false;
  @State private sentenceSearchOpen: boolean = false;
  private sentenceAnchor: string = '';
  private sentenceTops: Map<string, number> = new Map<string, number>();
  private lastFollowQuery: number = -1;
  private lastFollowQueryTime: number = 0;
  private alignedSentenceId: string = '';
  private followTimer: number = 0;
  private locatePausedSentence: boolean = false;
  private contextFocusId: string = '';
  private contextFocusTimer: number = 0;
  private searchScrollOffset: number = 0;
  private restoreSearchScroll: boolean = false;
  private chapterScrollOffset: number = 0;
  private chapterTopOffset: number = 0;
  private restoreChapterScroll: boolean = false;
  private summaryFocusScope: string = '';
  private summaryFocusEpoch: number = 0;
  private summaryFocusTimer: number = 0;

  private readingPlayback(state: AccountViewState): boolean {
    return this.section === 'listen' && state.loggedIn && state.transcriptOpen && !state.chatOpen &&
      state.mediaVersionId.length > 0 && (!state.readingMediaVersionId || state.readingMediaVersionId === state.mediaVersionId) &&
      !state.readingArchived && state.audioAvailable;
  }

  private readingAudioAvailable(): boolean {
    if (this.account.readingMediaVersionId && this.account.readingMediaVersionId !== this.account.mediaVersionId) {
      return !this.account.readingArchived;
    }
    return !this.account.readingArchived && this.account.audioAvailable;
  }

  private toggleTranscriptTool(tool: string): void {
    const account: AccountSync = AccountSync.getInstance();
    const chapters: boolean = tool === 'chapters' && !this.account.chaptersOpen;
    const summaries: boolean = tool === 'summaries' && !this.account.summariesOpen;
    this.sentenceSearchOpen = tool === 'search' && !this.sentenceSearchOpen;
    this.pauseTranscriptFollow();
    this.contextFocusId = ''; this.restoreChapterScroll = false; this.restoreSearchScroll = false;
    if (!this.sentenceSearchOpen && (this.account.searchView || this.account.searchBusy)) account.clearSearch();
    if (this.account.chaptersOpen !== chapters) account.setChaptersOpen(chapters);
    if (this.account.summariesOpen !== summaries) account.setSummariesOpen(summaries);
  }

  private canFollowSentence(state: AccountViewState): boolean {
    return this.readingPlayback(state) && this.followTranscript && !this.accountOpen && !this.sentenceSearchOpen &&
      !state.chaptersOpen && !state.summariesOpen && !state.searchView && !this.draggingSelection &&
      state.selectedSegmentIds.length === 0 && (state.playing || this.locatePausedSentence);
  }

  private pauseTranscriptFollow(): void {
    this.followTranscript = false;
    this.locatePausedSentence = false;
    this.alignedSentenceId = '';
    this.lastFollowQuery = -1;
    if (this.followTimer) clearTimeout(this.followTimer);
    this.followTimer = 0;
  }

  private resumeTranscriptFollow(): void {
    this.followTranscript = true;
    this.locatePausedSentence = true;
    this.alignedSentenceId = '';
    this.lastFollowQuery = -1;
    this.updateTranscriptPlayback(this.account);
  }

  private updateTranscriptPlayback(state: AccountViewState): void {
    const current: TranscriptSegment | undefined = this.readingPlayback(state) ?
      state.transcriptSegments.find((s: TranscriptSegment) => s.startMs <= state.positionMs && state.positionMs < s.endMs) : undefined;
    const id: string = current?.id ?? '';
    if (this.activeSentenceId !== id) this.activeSentenceId = id;
    if (!this.canFollowSentence(state)) return;
    if (id) {
      this.lastFollowQuery = -1;
      this.alignPlayingSentence();
      return;
    }
    const job: TranscriptJob | null = state.transcriptJob;
    if (!job || !state.transcriptLoaded || state.transcriptBusy || state.positionMs >= job.completedMs) return;
    // Each transcript page owns five 30-second chunks. Silence inside it has no current sentence.
    const chunk: number = Math.floor(state.positionMs / 30000);
    // A sentence starting on the preceding page can extend into the first chunk on this page.
    const first: TranscriptSegment | undefined = state.transcriptSegments[0];
    const precedingPageMayOwnSentence: boolean = state.transcriptPageCursor >= 0 && chunk === state.transcriptPageCursor + 1 &&
      (!first || state.positionMs < first.startMs);
    if (chunk > state.transcriptPageCursor && chunk <= state.transcriptPageCursor + 5 && !precedingPageMayOwnSentence) return;
    if (this.lastFollowQuery === chunk && (!state.transcriptError || Date.now() - this.lastFollowQueryTime < 10000)) return;
    this.lastFollowQuery = chunk;
    this.lastFollowQueryTime = Date.now();
    void AccountSync.getInstance().refreshTranscript(false, state.positionMs, () =>
      this.canFollowSentence(this.account) && Math.floor(this.account.positionMs / 30000) === chunk);
  }

  private alignPlayingSentence(): void {
    const id: string = this.activeSentenceId;
    if (!id || this.alignedSentenceId === id || this.followTimer || !this.pageVisible ||
      this.scrollWindowHeight <= 0 || !this.sentenceTops.has(id)) return;
    this.followTimer = setTimeout(() => {
      this.followTimer = 0;
      if (!this.pageVisible || !this.canFollowSentence(this.account)) return;
      const currentId: string = this.activeSentenceId;
      const measured: number | undefined = this.sentenceTops.get(currentId);
      if (measured === undefined || !currentId) return;
      const top: number = measured - this.scrollWindowY;
      const relative: number = top - (this.readerScroller.offset()?.yOffset ?? 0);
      if (relative < 8 || relative > this.scrollWindowHeight * 0.68) {
        this.readerScroller.scrollTo({ xOffset: 0, yOffset: Math.max(0, top - this.scrollWindowHeight * 0.24), animation: false });
      }
      this.alignedSentenceId = currentId;
      this.locatePausedSentence = false;
    }, 0);
  }

  private recordSentenceArea(id: string, area: Area): void {
    const top: number = Number(area.globalPosition.y) + (this.readerScroller.offset()?.yOffset ?? 0);
    if (Number.isFinite(top)) this.sentenceTops.set(id, top);
    this.alignSearchContext(id, area);
    if (id === this.activeSentenceId && this.canFollowSentence(this.account)) this.alignPlayingSentence();
  }

  private async playSentence(id: string): Promise<void> {
    this.pauseTranscriptFollow();
    const account: AccountSync = AccountSync.getInstance();
    if (await account.playTranscriptSegment(id) && this.readingPlayback(this.account) &&
      this.account.transcriptSegments.some((s: TranscriptSegment) => s.id === id)) this.resumeTranscriptFollow();
  }

  private selectSentenceRange(anchor: string, end: string): void {
    this.pauseTranscriptFollow();
    this.sentenceAnchor = anchor;
    AccountSync.getInstance().setTranscriptSelectionRange(anchor, end);
  }

  private tapSelectedSentence(id: string): void {
    if (this.account.selectedSegmentIds.length === 1 && this.account.selectedSegmentIds[0] === id) {
      AccountSync.getInstance().clearSelection();
    } else {
      this.selectSentenceRange(this.sentenceAnchor || this.account.selectedSegmentIds[0], id);
    }
  }

  private openChapterContext(chapter: Chapter): void {
    this.clearSummaryFocus();
    this.chapterScrollOffset = this.readerScroller.offset()?.yOffset ?? 0;
    this.contextFocusId = chapter.startSegmentId; this.restoreChapterScroll = false; this.restoreSearchScroll = false;
    void AccountSync.getInstance().showContext(chapter.startMs, '', chapter.id);
  }
  private chapterStatus(): string {
    const status: string = this.account.chaptersPage?.document?.status ?? '';
    if (status === 'complete') return '章节已完成';
    if (status === 'failed') return '整理失败，已完成的章节仍保留';
    if (status === 'cancelled') return '已停止，已完成的章节仍保留';
    if (status === 'running') return '正在整理章节';
    return '等待整理章节';
  }
  private summaryStatus(): string {
    const status: string = this.account.summariesPage?.document?.status ?? '';
    if (status === 'complete') return '总结已完成';
    if (status === 'failed') return '总结失败，已完成部分仍保留';
    if (status === 'cancelled') return '已停止，已完成部分仍保留';
    if (status === 'running') return '正在整理总结';
    return '等待整理总结';
  }
  private summaryResultNode(result: SummaryResult): string { return result.id; }
  private summaryPointKey(nodeId: string, pointIndex: number): string {
    return `${nodeId}:${pointIndex}`;
  }
  private summaryPointExpanded(nodeId: string, pointIndex: number): boolean {
    return this.account.summaryExpandedNode === this.summaryPointKey(nodeId, pointIndex);
  }
  private summaryTopicScope(state: AccountViewState, index: number): string {
    return `${state.readingMediaVersionId || state.mediaVersionId}:${state.summariesPage?.document?.id ?? ''}:${index}`;
  }
  private clearSummaryFocus(): void {
    this.summaryFocusScope = ''; this.summaryFocusEpoch++;
    if (this.summaryFocusTimer > 0) clearTimeout(this.summaryFocusTimer);
    this.summaryFocusTimer = 0;
  }
  private requestSummaryFocus(index: number): void {
    this.clearSummaryFocus(); this.summaryFocusScope = this.summaryTopicScope(this.account, index);
    this.contextFocusId = ''; this.restoreSearchScroll = false; this.restoreChapterScroll = false;
  }
  private openSummaryTopic(index: number): void {
    if (this.account.summaryTopicIndex === index) this.clearSummaryFocus();
    else this.requestSummaryFocus(index);
    AccountSync.getInstance().openSummaryTopic(index);
  }
  private turnSummaryTopic(next: boolean): void {
    if (this.account.summaryTopicBusy || this.account.summaryTopicIndex < 0 ||
      (next ? this.account.summaryTopicPage?.nextAfter == null : !this.account.summaryTopicCanPrevious)) return;
    this.requestSummaryFocus(this.account.summaryTopicIndex);
    if (next) AccountSync.getInstance().nextSummaryTopic();
    else AccountSync.getInstance().previousSummaryTopic();
  }
  private retrySummaryTopic(): void {
    if (this.account.summaryTopicBusy || this.account.summaryTopicIndex < 0) return;
    this.requestSummaryFocus(this.account.summaryTopicIndex); void AccountSync.getInstance().refreshSummaryTopic();
  }
  private alignSummaryTopic(area: Area): void {
    if (this.summaryFocusScope.length === 0 || this.account.summaryTopicBusy ||
      (this.account.summaryTopicPage === null && this.account.summaryTopicError.length === 0)) return;
    const scope: string = this.summaryFocusScope, epoch: number = this.summaryFocusEpoch;
    const target: number = Math.max(0, (this.readerScroller.offset()?.yOffset ?? 0) + Number(area.globalPosition.y) - this.scrollWindowY - 12);
    if (!Number.isFinite(target)) return;
    if (this.summaryFocusTimer > 0) clearTimeout(this.summaryFocusTimer);
    this.summaryFocusTimer = setTimeout(() => {
      this.summaryFocusTimer = 0;
      const live: AccountViewState = AccountSync.getInstance().getSnapshot();
      if (epoch !== this.summaryFocusEpoch || scope !== this.summaryFocusScope || this.section !== 'listen' ||
        !live.loggedIn || !live.transcriptOpen || !live.summariesOpen || live.summaryTopicBusy ||
        scope !== this.summaryTopicScope(live, live.summaryTopicIndex)) return;
      this.clearSummaryFocus(); this.readerScroller.scrollTo({ xOffset: 0, yOffset: target, animation: false });
    }, 150);
  }
  private playSummaryEvidence(evidence: SummaryEvidence, segment: TranscriptSegment): void {
    const end: number = Math.max(segment.startMs, segment.endMs);
    const available: boolean = evidence.audioAvailable && !this.account.readingArchived && end > segment.startMs;
    if (!available) return;
    void AccountSync.getInstance().playExcerpt(evidence.mediaVersionId, segment.startMs, end);
  }
  private turnChapters(next: boolean): void {
    this.chapterScrollOffset = this.chapterTopOffset; this.restoreChapterScroll = true;
    if (next) AccountSync.getInstance().nextChapters();
    else AccountSync.getInstance().previousChapters();
  }
  private returnToChapters(): void {
    this.contextFocusId = ''; this.restoreChapterScroll = true; AccountSync.getInstance().returnToChapters();
  }

  private openSearchContext(result: SearchResult): void {
    this.clearSummaryFocus();
    this.searchScrollOffset = this.readerScroller.offset()?.yOffset ?? 0;
    this.contextFocusId = result.id; this.restoreSearchScroll = false; this.restoreChapterScroll = false;
    void AccountSync.getInstance().showContext(result.startMs, result.id);
  }
  private alignSearchContext(id: string, area: Area): void {
    const targetId: string = this.account.searchView === 'context' ? this.account.searchContextId : this.account.chapterContext?.startSegmentId ?? '';
    if (this.contextFocusId !== id || targetId !== id) return;
    const offset: number = this.readerScroller.offset()?.yOffset ?? 0;
    const y: number = Number(area.globalPosition.y);
    if (!Number.isFinite(y) || !Number.isFinite(this.scrollWindowY)) return;
    const targetOffset: number = Math.max(0, offset + y - this.scrollWindowY - 12);
    if (this.contextFocusTimer > 0) clearTimeout(this.contextFocusTimer);
    this.contextFocusTimer = setTimeout(() => {
      this.contextFocusTimer = 0;
      const currentId: string = this.account.searchView === 'context' ? this.account.searchContextId : this.account.chapterContext?.startSegmentId ?? '';
      if (this.contextFocusId !== id || currentId !== id) return;
      this.contextFocusId = '';
      this.readerScroller.scrollTo({ xOffset: 0, yOffset: targetOffset, animation: false });
    }, 150);
  }

  aboutToAppear(): void {
    AccountSync.getInstance().setLibraryOpen(this.showLibrary);
    this.unsubscribe = PlaybackService.getInstance().subscribe((state: PlaybackViewState) => {
      this.viewState = state;
      if (!this.dragging && !this.account.loggedIn) {
        this.seekValue = state.positionMs;
      }
    });
    this.unsubscribeProbe = ConnectionProbe.getInstance().subscribe((state: ProbeViewState) => {
      this.probeState = state;
    });
    this.unsubscribeAccount = AccountSync.getInstance().subscribe((state: AccountViewState) => {
      const readingChanged: boolean = (state.readingMediaVersionId || state.mediaVersionId) !==
        (this.account.readingMediaVersionId || this.account.mediaVersionId);
      if (readingChanged || state.transcriptJob?.id !== this.account.transcriptJob?.id ||
        !state.transcriptOpen || state.transcriptPageCursor !== this.account.transcriptPageCursor) {
        this.sentenceTops.clear();
        this.alignedSentenceId = '';
      }
      if (readingChanged || !state.loggedIn) {
        this.followTranscript = true;
        this.lastFollowQuery = -1;
        this.locatePausedSentence = false;
        this.sentenceSearchOpen = false;
      }
      if (state.selectedSegmentIds.length === 0) this.sentenceAnchor = '';
      if (this.summaryFocusScope.length > 0 && (!state.loggedIn || !state.transcriptOpen || !state.summariesOpen ||
        this.summaryFocusScope !== this.summaryTopicScope(state, state.summaryTopicIndex))) this.clearSummaryFocus();
      if ((state.readingMediaVersionId || state.mediaVersionId) !==
        (this.account.readingMediaVersionId || this.account.mediaVersionId) || !state.loggedIn) {
        this.expandedChatTurn = ''; this.searchText = ''; this.contextFocusId = ''; this.restoreSearchScroll = false; this.restoreChapterScroll = false;
        this.citationSheetOpen = false;
      }
      if (!state.loggedIn || (this.editingSaved.length > 0 && !state.savedEditing)) { this.editingSaved = ''; this.noteDraft = ''; this.editingSavedTitle = ''; }
      if (!this.account.loggedIn && state.loggedIn) this.accountOpen = false;
      if (!state.loggedIn && this.account.loggedIn) {
        this.section = 'listen'; this.showLibrary = false; this.importOpen = false;
        this.chatOptionsOpen = false; this.inputFocused = false;
      }
      if (state.hint.length > 0 && state.hint !== this.account.hint && state.loggedIn && !this.accountOpen) {
        this.notifyAction(state.hint);
      }
      const last: ChatTurn | undefined = state.chatTurns[state.chatTurns.length - 1];
      const previous: ChatTurn | undefined = this.account.chatTurns[this.account.chatTurns.length - 1];
      if (state.chatOpen && state.chatIsLatest && last !== undefined && previous !== undefined &&
        ((last.id !== previous.id && (this.chatAtBottom || this.account.chatBusy)) ||
        (this.chatAtBottom && last.status !== previous.status))) this.chatScrollTarget = 'latest';
      this.account = state;
      this.updateTranscriptPlayback(state);
      if (!this.dragging) this.seekValue = state.positionMs;
      if (state.loggedIn) this.serverUrl = state.baseUrl;
    });
  }

  aboutToDisappear(): void {
    this.pauseTranscriptFollow();
    this.sentenceTops.clear();
    this.clearSummaryFocus();
    if (this.contextFocusTimer > 0) clearTimeout(this.contextFocusTimer);
    this.contextFocusTimer = 0;
    this.contextFocusId = ''; this.restoreSearchScroll = false; this.restoreChapterScroll = false;
    AccountSync.getInstance().setLibraryOpen(false);
    AccountSync.getInstance().setTranscriptOpen(false);
    AccountSync.getInstance().setChatOpen(false);
    AccountSync.getInstance().setSavedOpen(false);
    if (this.unsubscribe !== undefined) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    if (this.unsubscribeProbe !== undefined) {
      this.unsubscribeProbe();
      this.unsubscribeProbe = undefined;
    }
    if (this.unsubscribeAccount !== undefined) {
      this.unsubscribeAccount();
      this.unsubscribeAccount = undefined;
    }
    // Playback continues when this page disappears or the screen locks.
  }

  private formatTime(timeMs: number): string {
    const seconds: number = Math.floor(Math.max(0, timeMs) / 1000);
    return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}`;
  }

  private canControl(): boolean {
    return this.viewState.ready && !this.viewState.recovering && !this.viewState.busy && !this.account.busy &&
      !this.account.restoring && (!this.account.loggedIn || (this.account.owner && this.account.audioAvailable));
  }

  private canRetryPlayback(): boolean {
    return this.viewState.playerState === 'error' && this.account.owner && this.account.audioAvailable &&
      !this.account.busy && !this.account.restoring && !this.viewState.busy &&
      this.viewState.mediaVersionId === this.account.mediaVersionId;
  }

  private playbackActionLabel(): string {
    if (this.viewState.recovering) return '取消重连';
    if (this.canRetryPlayback()) return '重试播放';
    return this.viewState.playerState === 'playing' ? '暂停' : '播放';
  }

  private togglePlayback(): void {
    if (this.viewState.recovering) void PlaybackService.getInstance().pause();
    else if (this.canRetryPlayback()) {
      const position = Math.round(this.viewState.positionMs);
      void AccountSync.getInstance().takeover(this.viewState.mediaVersionId,
        position >= 0 && position < this.account.durationMs ? position : undefined);
    }
    else if (this.canControl()) void AccountSync.getInstance().playOrPause();
  }

  private formatBytes(value: number): string {
    if (value >= 1073741824) return `${(value / 1073741824).toFixed(2)} GiB`;
    if (value >= 1048576) return `${(value / 1048576).toFixed(1)} MiB`;
    return `${Math.ceil(Math.max(0, value) / 1024)} KiB`;
  }

  private confirmRemoval(item: LibraryItem, mode: string): void {
    this.getUIContext().showAlertDialog({
      title: mode === 'audio' ? '清理音频？' : '删除整期资料？',
      message: mode === 'audio' ? `“${item.title}”的音频将被清理，文稿、章节、聊天记录和收藏保留。清理后无法播放。` :
        `“${item.title}”的音频、文稿、章节、聊天记录及收藏备注都将删除，无法撤销。`,
      primaryButton: { value: '取消', action: () => {} },
      secondaryButton: { value: mode === 'audio' ? '确认清理音频' : '确认删除整期',
        action: () => { void AccountSync.getInstance().removeLibrary(item.mediaVersionId, mode); } }
    });
  }

  private confirmImportRemoval(job: ImportJob): void {
    this.getUIContext().showAlertDialog({
      title: '移除导入任务？', message: `将移除“${job.title}”的导入任务。`,
      primaryButton: { value: '取消', action: () => {} },
      secondaryButton: { value: '确认移除', action: () => { void AccountSync.getInstance().removeImport(job.id); } }
    });
  }

  private importStatus(status: string): string {
    if (status === 'queued') return '等待下载';
    if (status === 'downloading') return '正在下载';
    if (status === 'ready') return '音频已就绪';
    return '导入失败';
  }

  private transcriptStatus(): string {
    if (!this.account.transcriptLoaded) return '正在读取文稿…';
    const status: string = this.account.transcriptJob?.status ?? '';
    if (status === 'queued') return '等待转写';
    if (status === 'processing') return '正在转写';
    if (status === 'ready') return '整期文稿已完成';
    if (status === 'failed') return '转写暂未完成';
    return '验证音频不提供文稿';
  }

  private chatStatus(status: string): string {
    if (status === 'queued') return '等待回答';
    if (status === 'running') return '正在生成';
    if (status === 'complete') return '已完成';
    if (status === 'cancelled') return '已取消';
    return '回答失败';
  }
  private chatScope(scope: string): string {
    if (scope === 'all') return '整期内容';
    if (scope === 'until') return '截至这里';
    if (scope === 'selection') return '选中片段';
    if (scope === 'retrieval') return '整期检索';
    return '当前位置附近';
  }
  private chatRetrievalMeta(turn: ChatTurn): string {
    const retrieval = turn.retrieval;
    if (retrieval === undefined || retrieval === null) return '整期文稿已固定';
    return `${retrieval.selectedSegments}/${retrieval.totalSegments} 段 · 文稿截至 ${this.formatTime(retrieval.snapshot.throughMs)}`;
  }
  private chatRetrievalNoEvidence(turn: ChatTurn): boolean {
    return turn.scope === 'retrieval' && turn.retrieval?.status === 'no-evidence';
  }

  private notifyAction(message: string): void {
    if (!this.pageVisible) return;
    try {
      this.getUIContext().getPromptAction().showToast({ message: message });
    } catch {
      // The account sheet also retains this message if the window has just closed.
    }
  }

  private sectionTitle(): string {
    if (!this.account.loggedIn) return '鱼趣知识库';
    if (this.section === 'library' || this.section === 'saved') return '资料库';
    return this.section === 'chat' ? '文稿对话' : '收听';
  }

  onBackPress(): boolean {
    if (this.citationSheetOpen) { this.citationSheetOpen = false; return true; }
    if (this.chatOptionsOpen) { this.chatOptionsOpen = false; return true; }
    if (this.accountOpen) { this.accountOpen = false; return true; }
    if (this.importOpen) { this.importOpen = false; return true; }
    if (this.section === 'chat') { this.showTranscript(); return true; }
    if (this.section === 'listen' && this.account.selectedSegmentIds.length > 0) {
      AccountSync.getInstance().clearSelection(); return true;
    }
    if (this.account.chapterContext !== null && this.section === 'listen') { this.returnToChapters(); return true; }
    if (this.account.searchView === 'context' && this.section === 'listen') { this.returnToSearch(); return true; }
    if (this.section === 'saved') { this.switchSection('library'); return true; }
    if (this.account.loggedIn && this.section === 'listen') { this.switchSection('library'); return true; }
    return false;
  }

  private canSwipeBackFromPlayer(): boolean {
    return this.account.loggedIn && this.section === 'listen' && !this.account.chatOpen && !this.accountOpen &&
      !this.draggingSelection && this.account.selectedSegmentIds.length === 0;
  }

  private finishPlayerSwipe(event: GestureEvent): void {
    const distanceLeft: number = -event.offsetX;
    if (this.canSwipeBackFromPlayer() && distanceLeft >= PLAYER_BACK_SWIPE_DISTANCE && distanceLeft > Math.abs(event.offsetY)) {
      this.onBackPress();
    }
  }

  private returnToSearch(): void {
    this.contextFocusId = ''; this.restoreSearchScroll = true;
    AccountSync.getInstance().returnToSearch();
  }

  private showCitations(turn: ChatTurn, marker: string = ''): void {
    const numbers: RegExpMatchArray | null = marker.match(/\d+/g);
    const ids: string[] = [];
    if (numbers !== null) {
      const first: number = Number(numbers[0]), last: number = Number(numbers[numbers.length - 1]);
      for (let n: number = first; n <= last && ids.length < 32; n++) ids.push(`S${n}`);
    }
    this.expandedChatTurn = ''; this.citationTurnId = turn.id;
    this.citationFilter = ids; this.citationSheetOpen = true;
  }

  private switchSection(section: string): void {
    if (this.section !== 'chat' && section !== 'chat' && this.section !== section && this.pageVisible) {
      this.readerScroller.scrollTo({ xOffset: 0, yOffset: 0, animation: false });
    }
    if (section === 'chat') this.chatScrollTarget = 'latest';
    else {
      this.inputFocused = false; this.chatOptionsOpen = false; this.citationSheetOpen = false;
    }
    this.importOpen = false;
    this.section = section; this.showLibrary = section === 'library';
    AccountSync.getInstance().setLibraryOpen(this.showLibrary);
    AccountSync.getInstance().setSavedOpen(section === 'saved', this.account.savedThisEpisode);
    if (section !== 'chat') AccountSync.getInstance().setChatOpen(false);
    AccountSync.getInstance().setTranscriptOpen(section === 'listen');
    if (section === 'chat' && !this.account.chatOpen) AccountSync.getInstance().setChatOpen(true);
  }
  private showChat(): void {
    this.switchSection('chat');
  }
  private showTranscript(): void {
    this.switchSection('listen');
  }
  private highlighted(result: SearchResult): TextPiece[] {
    const pieces: TextPiece[] = []; let from: number = 0;
    result.highlights.forEach((range: SearchHighlight) => {
      if (range.start > from) pieces.push({ text: result.text.slice(from, range.start), marked: false });
      pieces.push({ text: result.text.slice(range.start, range.end), marked: true }); from = range.end;
    });
    if (from < result.text.length) pieces.push({ text: result.text.slice(from), marked: false });
    return pieces;
  }
  private answerPieces(turn: ChatTurn): TextPiece[] {
    const pieces: TextPiece[] = [];
    const regex: RegExp = /\[S\d+(?:\s*[-–—~～]\s*S?\d+)?\]/g;
    let from: number = 0; let match: RegExpExecArray | null = regex.exec(turn.answer);
    while (match !== null) {
      if (match.index > from) pieces.push({ text: turn.answer.slice(from, match.index), marked: false });
      const numbers: RegExpMatchArray | null = match[0].match(/\d+/g);
      let valid: boolean = numbers !== null;
      if (numbers !== null) {
        const first: number = Number(numbers[0]), last: number = Number(numbers[numbers.length - 1]);
        valid = last >= first && last - first < 32;
        for (let n: number = first; valid && n <= last; n++) valid = turn.citations.some((citation: ChatCitation) => citation.id === `S${n}`);
      }
      pieces.push({ text: match[0], marked: valid }); from = match.index + match[0].length; match = regex.exec(turn.answer);
    }
    if (from < turn.answer.length) pieces.push({ text: turn.answer.slice(from), marked: false });
    return pieces;
  }
  private libraryTranscriptLabel(item: LibraryItem): string {
    if (item.transcript === null || item.transcript === undefined) return '';
    return `文稿已到 ${this.formatTime(item.transcript.completedMs)} · ${item.transcript.status === 'ready' ? '整期可问' : '已转写部分可问'}`;
  }
  private hasEditingSavedItem(): boolean {
    return this.editingSaved.length > 0 && this.account.savedItems.some((item: SavedItem) => item.id === this.editingSaved);
  }
  private beginNote(item: SavedItem): void {
    this.editingSaved = item.id; this.noteDraft = item.note; this.editingSavedTitle = item.mediaTitle;
    AccountSync.getInstance().setSavedEditing(true, item.id, item.mediaVersionId);
  }
  private cancelNote(): void {
    this.editingSaved = ''; this.noteDraft = ''; this.editingSavedTitle = '';
    AccountSync.getInstance().setSavedEditing(false);
  }
  private async commitNote(id: string): Promise<void> {
    const saved: boolean = await AccountSync.getInstance().updateSavedNote(id, this.noteDraft);
    if (saved && this.editingSaved === id) this.cancelNote();
  }
  private confirmSavedRemoval(item: SavedItem): void {
    this.getUIContext().showAlertDialog({ title: '删除这条收藏？', message: '收藏及备注会删除，原文稿和对话保留。',
      primaryButton: { value: '取消', action: () => {} },
      secondaryButton: { value: '删除收藏', action: () => { void AccountSync.getInstance().deleteSaved(item.id); } } });
  }

  build() {
    Column() {
      Row({ space: 10 }) {
        Text(this.sectionTitle()).fontSize(24).fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.yuqu_ink')).layoutWeight(1)
        Button(this.account.loggedIn ? '账户' : '邮箱登录').quietAction().id('account-open')
          .onClick(() => { this.accountOpen = true; })
          .bindSheet($$this.accountOpen, this.accountSheet(), { height: SheetSize.LARGE,
            dragBar: true, backgroundColor: $r('app.color.yuqu_page') })
      }.padding({ left: 18, right: 18, top: 8, bottom: 8 }).width('100%')
      if (this.account.loggedIn && this.account.error.length > 0 && !this.accountOpen) {
        Text(this.account.error).fontSize(13).fontColor($r('app.color.yuqu_danger')).width('100%')
          .padding({ left: 18, right: 18, bottom: 4 })
      }
      if (this.account.loggedIn && this.section === 'chat' &&
        this.account.readingMediaVersionId.length === 0 && this.account.mediaVersionId.length === 0) {
        Column({ space: 12 }) {
          Text('先在资料库选择一期节目，再围绕文稿提问。').fontSize(15).fontColor($r('app.color.yuqu_muted'))
          Button('打开资料库').quietAction().onClick(() => { this.switchSection('library'); })
        }.width('100%').layoutWeight(1).justifyContent(FlexAlign.Center)
      } else if (this.account.loggedIn && this.section === 'chat') {
        this.miniPlayer()
        Scroll(this.chatScroller) {
          this.chatHistory()
        }.id('chat-history').layoutWeight(1).width('100%').align(Alignment.TopStart)
          .onDidScroll(() => { this.chatAtBottom = this.chatScroller.isAtEnd(); })
          .onTouch((event: TouchEvent) => { if (event.type === TouchType.Down) this.followComposerResize = false; })
          .onAreaChange((oldArea: Area, area: Area) => {
            if (this.followComposerResize && this.inputFocused && Number(area.height) < Number(oldArea.height)) {
              this.chatScroller.scrollEdge(Edge.Bottom);
            }
          })
          .bindSheet($$this.citationSheetOpen, this.citationSheet(), { height: SheetSize.MEDIUM,
            detents: [SheetSize.MEDIUM, SheetSize.LARGE], dragBar: true,
            showClose: true, title: { title: '引用原文' }, backgroundColor: $r('app.color.yuqu_surface') })
        this.chatComposer()
      } else {
        if (this.account.loggedIn && (this.section === 'library' || this.section === 'saved')) {
          this.libraryTabs()
        }
        if (this.account.loggedIn && this.section === 'listen' && this.account.chapterContext !== null) {
          Button('返回章节目录').quietAction().id('chapters-return').width('94%')
            .onClick(() => { this.returnToChapters(); })
        }
        Scroll(this.readerScroller) {
          Column({ space: 14 }) {
            if (this.section === 'listen' || !this.account.loggedIn) {
              this.fullPlayer()
              if (this.account.loggedIn) {
                this.readingActions()
                if (this.account.transcriptOpen) this.transcriptPanel()
              }
            } else if (this.section === 'library') {
              this.libraryList()
            } else if (this.section === 'saved') {
              this.savedList()
            }
            if (this.viewState.error.length > 0) {
              Text(this.viewState.error).fontSize(14).fontColor($r('app.color.yuqu_danger'))
            }
          }.padding({ left: 16, right: 16, top: 6, bottom: 20 }).width('100%')
        }.width('100%').layoutWeight(1).align(Alignment.TopStart)
          .enableScrollInteraction(!this.draggingSelection)
          .onWillScroll((_x: number, _y: number, _state: ScrollState, source: ScrollSource) => {
            if (this.followTranscript && this.account.transcriptOpen && (source === ScrollSource.DRAG ||
              source === ScrollSource.SCROLL_BAR || source === ScrollSource.OTHER_USER_INPUT)) this.pauseTranscriptFollow();
          })
          .onAreaChange((_old: Area, area: Area) => {
            this.scrollWindowY = Number(area.globalPosition.y);
            this.scrollWindowHeight = Number(area.height);
            if (this.canFollowSentence(this.account)) this.alignPlayingSentence();
          })
        if (this.account.loggedIn) {
          if (this.section !== 'listen') {
            this.miniPlayer()
          } else if (this.account.replayReturnLabel.length > 0) {
            this.replayActions()
          }
          if (this.section === 'listen' && this.account.transcriptOpen && this.account.searchView !== 'results' &&
            this.account.transcriptJob !== null) this.transcriptToolbar()
        }
      }
      if (this.account.loggedIn) {
        PrimaryTabs({ section: this.section === 'saved' ? 'library' : this.section,
          onSelect: (next: string) => { this.switchSection(next); } })
      }
    }.width('100%').height('100%').backgroundColor($r('app.color.yuqu_page'))
      .gesture(PanGesture({ fingers: 1, direction: this.canSwipeBackFromPlayer() ? PanDirection.Left : PanDirection.None,
        distance: PLAYER_BACK_SWIPE_DISTANCE }).onActionEnd((event: GestureEvent) => { this.finishPlayerSwipe(event); }))
      .onAppear(() => { this.pageVisible = true; this.getUIContext().setKeyboardAvoidMode(KeyboardAvoidMode.RESIZE); })
      .onDisAppear(() => { this.pageVisible = false; })
  }

  @Builder
  private accountSheet() {
    Scroll() {
      Column({ space: 14 }) {
        Text('账户').fontSize(22).fontWeight(FontWeight.Bold)
        Column({ space: 10 }) {
          if (this.account.restoring) {
            Text('正在恢复登录…').id('account-restoring').fontSize(14)
          } else if (this.account.loggedIn) {
            Text(this.account.email).id('account-email-current').fontSize(16)
            Text(this.account.syncStatus).id('account-sync-status').fontSize(14)
              .fontColor(this.account.stale ? $r('app.color.yuqu_danger') : $r('app.color.yuqu_ink'))
            if (!this.account.owner) {
              Button('在此设备播放').quietAction().id('account-takeover').width('100%')
                .enabled(!this.account.busy && this.account.audioAvailable && this.account.mediaVersionId.length > 0)
                .onClick(() => { void AccountSync.getInstance().takeover(); })
            }
            Button('退出登录').quietAction().id('account-logout')
              .onClick(() => { this.code = ''; void AccountSync.getInstance().logout(); })
          } else {
            Text('邮箱登录').fontSize(17).fontWeight(FontWeight.Medium)
            if (DEBUG) {
              TextInput({ text: this.serverUrl, placeholder: '服务地址' }).id('account-server-url')
                .enabled(!this.account.busy)
                .onChange((value: string) => { this.serverUrl = value; })
            }
            TextInput({ text: this.email, placeholder: '你的邮箱' }).id('account-email')
              .type(InputType.Email).enabled(!this.account.busy)
              .onChange((value: string) => { this.email = value; })
            Button(this.account.retrySeconds > 0 ? `${this.account.retrySeconds} 秒后可重发` : '获取验证码').quietAction()
              .id('account-request-code').enabled(!this.account.busy && this.account.retrySeconds === 0)
              .onClick(() => { void AccountSync.getInstance().requestCode(this.serverUrl, this.email); })
            TextInput({ text: this.code, placeholder: '6 位验证码' }).id('account-code')
              .type(InputType.Number).maxLength(6).enabled(!this.account.busy)
              .onChange((value: string) => { this.code = value; })
            Button(this.account.busy ? '处理中…' : '登录').quietAction().id('account-verify-code').width('100%')
              .enabled(!this.account.busy && this.account.challengeReady)
              .onClick(() => { void AccountSync.getInstance().verifyCode(this.serverUrl, this.email, this.code); })
            Text('未登录时可试听本地样本；登录后两端使用同一邮箱同步进度。').fontSize(12).fontColor($r('app.color.yuqu_muted'))
            Text('邮箱用于登录。导入资料、文稿、播放进度和对话将保存到云端。你提问时，开发者部署的大模型服务会调用外部模型处理你的问题和相关文稿，生成回答。')
              .fontSize(12).fontColor($r('app.color.yuqu_muted'))
          }
          Hyperlink('https://fish.sdspeed.com.cn/privacy', '隐私说明与数据管理')
            .id('privacy-link').color($r('app.color.yuqu_ink'))
          if (this.account.hint.length > 0) {
            Text(this.account.hint).id('account-hint').fontSize(13).fontColor($r('app.color.yuqu_muted'))
          }
          if (this.account.error.length > 0) {
            Text(this.account.error).id('account-error').fontSize(13).fontColor($r('app.color.yuqu_danger'))
          }
        }.padding(16).width('100%').alignItems(HorizontalAlign.Start)
          .backgroundColor($r('app.color.yuqu_surface')).borderRadius(16)
        if (DEBUG) {
          Button(this.showDiagnostics ? '收起连接诊断' : '连接诊断').quietAction().id('diagnostics-toggle')
            .onClick(() => { this.showDiagnostics = !this.showDiagnostics; })
          if (this.showDiagnostics) {
            Column({ space: 8 }) {
              Text(`播放器：${this.viewState.playerState}${this.viewState.busy ? ' · 处理中' : ''}`).fontSize(14)
              Text(`后台任务：${this.viewState.backgroundStatus}`).fontSize(14)
              Text(`应用：${this.viewState.foreground ? '前台' : '后台'} · 当前倍率 ${this.viewState.rate}×`).fontSize(14)
              Text('模拟器只能验证部分行为，锁屏与耳机体验仍需真机复核。').fontSize(13).fontColor($r('app.color.yuqu_muted'))
              if (!this.account.loggedIn) {
                Button('重新加载样本').quietAction().enabled(!this.viewState.busy)
                  .onClick(() => { void PlaybackService.getInstance().reload(); })
              }
            }.padding(16).width('100%').alignItems(HorizontalAlign.Start)
              .backgroundColor($r('app.color.yuqu_subtle')).borderRadius(16)
            Column({ space: 8 }) {
              Text('事件连接诊断').fontSize(17).fontWeight(FontWeight.Medium)
              Text(`同步版本 ${this.account.revision} · 播放代次 ${this.account.generation} · 序号 ${this.account.sequence}`)
                .id('account-sync-numbers').fontSize(12)
              TextInput({ text: this.serverUrl, placeholder: '服务地址' })
                .id('probe-server-url').enabled(!this.probeState.requested && !this.account.loggedIn)
                .onChange((value: string) => { this.serverUrl = value; })
              Row({ space: 8 }) {
                Button(this.probeState.requested ? '断开连接' : '连接事件').quietAction().layoutWeight(1)
                  .id('probe-connect')
                  .onClick(() => {
                    if (this.probeState.requested) ConnectionProbe.getInstance().disconnect();
                    else ConnectionProbe.getInstance().connect(this.serverUrl);
                  })
                Button('模拟重连').quietAction().layoutWeight(1).id('probe-reconnect')
                  .enabled(this.probeState.requested)
                  .onClick(() => { ConnectionProbe.getInstance().reconnect(); })
              }.width('100%')
              Text(`事件连接：${this.probeState.status}`).id('probe-status').fontSize(14)
              Text(`已收 ${this.probeState.received} · 最新 ${this.probeState.lastSequence}`)
                .id('probe-received').fontSize(14)
              Text(`重复 ${this.probeState.duplicates} · 缺口 ${this.probeState.gaps} · 重连 ${this.probeState.reconnects} · 重置 ${this.probeState.resets}`)
                .id('probe-counts').fontSize(13)
              if (this.probeState.message.length > 0) {
                Text(this.probeState.message).fontSize(13).fontColor($r('app.color.yuqu_ink'))
              }
              if (this.probeState.error.length > 0) {
                Text(this.probeState.error).id('probe-error').fontSize(13).fontColor($r('app.color.yuqu_danger'))
              }
              Text('仅连接开发诊断接口。退到后台会断开，回到前台后恢复事件；本地音频继续播放。')
                .fontSize(12).fontColor($r('app.color.yuqu_muted'))
            }.padding(16).width('100%').alignItems(HorizontalAlign.Start)
              .backgroundColor($r('app.color.yuqu_subtle')).borderRadius(16)
            Column({ space: 8 }) {
              Text('最近播放事件').fontSize(17).fontWeight(FontWeight.Medium)
              ForEach(this.viewState.events, (event: string, index: number) => {
                Text(event).fontSize(12).fontColor($r('app.color.yuqu_muted')).width('100%')
              }, (event: string, index: number) => `${index}-${event}`)
            }.width('100%').alignItems(HorizontalAlign.Start)
          }
        }
      }.padding(18).width('100%').alignItems(HorizontalAlign.Start)
    }.width('100%').height('100%').align(Alignment.TopStart)
  }

  @Builder
  private fullPlayer() {
    Column({ space: 12 }) {
      Text(this.account.title).id('current-media-title').fontSize(22).fontWeight(FontWeight.Bold).width('100%')
      Text(`${this.formatTime(this.account.positionMs)} / ${this.formatTime(this.account.durationMs)}`)
        .id('playback-position')
        .fontSize(16).fontWeight(FontWeight.Medium).fontColor($r('app.color.yuqu_ink'))
      Slider({ value: this.seekValue, min: 0, max: Math.max(1, this.account.durationMs), step: 1000 })
        .selectedColor($r('app.color.yuqu_accent_ink')).id('playback-seek').enabled(this.canControl())
        .onChange((value: number, mode: SliderChangeMode) => {
          this.seekValue = value;
          if (mode === SliderChangeMode.End || mode === SliderChangeMode.Click) {
            this.dragging = false;
            void AccountSync.getInstance().seek(value);
          } else {
            this.dragging = true;
          }
        })
      Row({ space: 6 }) {
        Button({ type: ButtonType.Normal }) {
          SymbolGlyph($r('sys.symbol.gobackward_15')).fontSize(28).fontColor([$r('app.color.yuqu_ink')])
        }.quietAction().playerAction(1).accessibilityText('后退15秒')
          .id('playback-back').enabled(this.canControl())
          .onClick(() => { void AccountSync.getInstance().seek(this.viewState.positionMs - 15000); })
        Button(this.playbackActionLabel()).quietAction().playerAction(1)
          .backgroundColor($r('app.color.yuqu_primary')).fontColor($r('app.color.yuqu_on_primary'))
          .id('playback-toggle').enabled(this.viewState.recovering || this.canControl() || this.canRetryPlayback())
          .onClick(() => { this.togglePlayback(); })
        Button({ type: ButtonType.Normal }) {
          SymbolGlyph($r('sys.symbol.goforward_15')).fontSize(28).fontColor([$r('app.color.yuqu_ink')])
        }.quietAction().playerAction(1).accessibilityText('前进15秒')
          .id('playback-forward').enabled(this.canControl())
          .onClick(() => { void AccountSync.getInstance().seek(this.viewState.positionMs + 15000); })
        Button(`${this.account.speed}× ${this.account.looping ? '循环' : '设置'}`).quietAction().playerAction(1.25).id('player-settings')
          .accessibilityText(`播放设置，${this.account.speed} 倍速，循环${this.account.looping ? '开启' : '关闭'}`)
          .onClick(() => { this.showPlayerOptions = !this.showPlayerOptions; })
      }.width('100%')
      if (this.account.loggedIn && !this.account.owner) {
        Button('在此设备播放').quietAction().id('listen-takeover').enabled(!this.account.busy && this.account.audioAvailable && this.account.mediaVersionId.length > 0)
          .onClick(() => { void AccountSync.getInstance().takeover(); })
      }
      if (this.account.loggedIn && this.viewState.diagnosticIncidentId.length > 0 &&
        this.account.mediaVersionId === this.viewState.mediaVersionId) {
        this.diagnosticPrompt('playback')
      }
      if (this.showPlayerOptions) {
        Row({ space: 8 }) {
          ForEach(this.rates, (rate: number) => {
            Button(`${rate}×`).quietAction().layoutWeight(1)
              .backgroundColor(this.account.speed === rate ? $r('app.color.yuqu_accent_soft') : $r('app.color.yuqu_subtle'))
              .fontColor(this.account.speed === rate ? $r('app.color.yuqu_accent_ink') : $r('app.color.yuqu_ink'))
              .enabled(this.canControl())
              .onClick(() => { void AccountSync.getInstance().setRate(rate); })
          }, (rate: number) => rate.toString())
        }.width('100%')
        Row() {
          Text('循环播放').fontSize(14).layoutWeight(1)
          Toggle({ type: ToggleType.Switch, isOn: this.account.looping }).selectedColor($r('app.color.yuqu_accent_ink'))
            .enabled(this.canControl())
            .onChange((enabled: boolean) => { void AccountSync.getInstance().setLooping(enabled); })
        }.width('100%')
        Row() {
          Text('播放时缓存本期音频').fontSize(14).layoutWeight(1)
          Toggle({ type: ToggleType.Switch, isOn: this.viewState.cacheEnabled })
            .id('playback-cache-toggle').accessibilityText('播放时缓存本期音频')
            .selectedColor($r('app.color.yuqu_accent_ink'))
            .onChange((enabled: boolean) => { PlaybackService.getInstance().setPlaybackCacheEnabled(enabled); })
        }.width('100%')
        Text('缓存会使用网络流量。关闭后停止下载，已缓存的本期仍可继续听。')
          .fontSize(13).fontColor($r('app.color.yuqu_muted'))
        Text('网络中断后会尝试从原位置续播。来电或耳机断开后请手动继续播放。').fontSize(13).fontColor($r('app.color.yuqu_muted'))
      }
      if (this.viewState.cacheStatus === 'ready' || (this.viewState.cacheEnabled && this.viewState.cacheStatus !== 'idle')) {
        Text(this.viewState.cacheStatus === 'ready' ? '本期已缓存，可断网继续听' :
          this.viewState.cacheStatus === 'failed' ? '本期缓存失败，继续收听需要联网' :
          `正在缓存本期 ${this.viewState.cachePercent}% · 请保持联网`)
          .id('playback-cache-status').fontSize(13).fontColor($r('app.color.yuqu_muted'))
      }
    }.padding(16).width('100%').alignItems(HorizontalAlign.Start).backgroundColor($r('app.color.yuqu_surface')).borderRadius(16)
  }

  @Builder
  private readingActions() {
    if (this.account.readingMediaVersionId.length > 0) {
      Column({ space: 8 }) {
        Text(`正在阅读 · ${this.account.readingTitle}`).id('reading-title').fontSize(16).fontWeight(FontWeight.Medium)
        Text(this.account.readingArchived ? '音频已清理，文稿和对话仍可查看；选择片段或检索整期文稿提问。' : '查看这期文稿和对话，选择片段或检索整期文稿提问；当前播放保持不变。')
          .fontSize(12).fontColor($r('app.color.yuqu_muted'))
        Button('返回当前节目').quietAction().id('reading-return').width('100%')
          .onClick(() => { AccountSync.getInstance().returnToCurrent(); })
      }.padding(16).width('100%').alignItems(HorizontalAlign.Start).backgroundColor($r('app.color.yuqu_subtle')).borderRadius(16)
    }
    if (!this.account.transcriptOpen) {
      Button('查看文稿').quietAction().id('transcript-toggle').width('100%')
        .onClick(() => {
          this.showTranscript();
          if (this.readingPlayback(this.account)) this.resumeTranscriptFollow();
        })
    }
  }

  @Builder
  private diagnosticPrompt(kind: string) {
    if (this.account.diagnosticKind !== kind) {
      Text(kind === 'playback' ? '本期播放遇到过问题，愿意上传日志帮助排查吗？' : '转写失败，愿意上传日志帮助排查吗？').fontSize(14)
      Button('查看待上传日志').quietAction().id(`diagnostic-open-${kind}`)
        .enabled(this.account.diagnosticPhase !== 'sending').onClick(() => { AccountSync.getInstance().previewDiagnostic(kind); })
    } else if (this.account.diagnosticPhase === 'sent') {
      Text(`日志已上传，受理编号 ${this.account.diagnosticId}`).fontSize(14).copyOption(CopyOptions.LocalDevice).id(`diagnostic-receipt-${kind}`)
    } else {
      ForEach([this.account.diagnosticId], (reportId: string) => {
        this.diagnosticReview(kind, reportId)
      }, (reportId: string) => reportId)
    }
  }

  @Builder
  private diagnosticReview(kind: string, reportId: string) {
    Column({ space: 10 }) {
      Text('上传故障日志').fontSize(16).fontWeight(FontWeight.Medium)
      Text(`确认后会把以下内容发送至 ${this.account.baseUrl}，供维护人员排查这次故障。报告与当前账号关联，在线保留 14 天。`).fontSize(13)
      Text(this.account.diagnosticPreview).fontSize(13).copyOption(CopyOptions.LocalDevice).id(`diagnostic-preview-${kind}`)
      if (this.account.diagnosticError.length > 0) {
        Text(this.account.diagnosticError).fontSize(13).fontColor($r('app.color.yuqu_danger'))
      }
      Row({ space: 8 }) {
        Button('取消').quietAction().enabled(this.account.diagnosticPhase !== 'sending').id(`diagnostic-cancel-${kind}`)
          .onClick(() => { AccountSync.getInstance().cancelDiagnostic(reportId); })
        Button(this.account.diagnosticPhase === 'sending' ? '正在上传…' :
          this.account.diagnosticPhase === 'failed' ? '重试上传' : '确认上传').quietAction()
          .enabled(this.account.diagnosticPhase !== 'sending').id(`diagnostic-send-${kind}`)
          .onClick(() => { void AccountSync.getInstance().submitDiagnostic(reportId); })
      }
    }.width('100%').alignItems(HorizontalAlign.Start)
  }

  @Builder
  private transcriptToolbar() {
    if (this.account.selectedSegmentIds.length > 0) {
      Row({ space: 6 }) {
        Text(`已选 ${this.account.selectedSegmentIds.length} 句`).layoutWeight(1).fontSize(14).fontWeight(FontWeight.Medium)
        Button('提问').quietAction().id('selection-ask')
          .onClick(() => { AccountSync.getInstance().askSelection(); this.showChat(); })
        Button('收藏').quietAction().id('selection-save').enabled(!this.account.savedBusy)
          .onClick(() => { void AccountSync.getInstance().saveSelection(); })
        Button('取消').quietAction().id('selection-cancel').onClick(() => { AccountSync.getInstance().clearSelection(); })
      }.width('100%').padding({ left: 16, right: 16, top: 4, bottom: 4 })
    } else if (this.readingPlayback(this.account) && !this.account.chaptersOpen && !this.account.summariesOpen &&
      !this.sentenceSearchOpen && !this.account.searchView) {
      Row({ space: 8 }) {
        Text(`${this.account.playing ? '播放至' : '停在'} ${this.formatTime(this.account.positionMs)}`).fontSize(14).layoutWeight(1)
        Button(this.followTranscript ? '跟读中' : '跟随播放').quietAction().id('transcript-follow')
          .accessibilityText(this.followTranscript ? '暂停文稿自动滚动' : '回到播放位置并跟读')
          .onClick(() => { if (this.followTranscript) this.pauseTranscriptFollow(); else this.resumeTranscriptFollow(); })
      }.width('100%').padding({ left: 16, right: 16, top: 4, bottom: 4 })
    }
  }

  @Builder
  private transcriptPanel() {
    Column({ space: 12 }) {
      Row({ space: 8 }) {
        Text(this.transcriptStatus()).id('transcript-status').fontSize(16).layoutWeight(1)
        if (this.account.transcriptJob !== null) {
          Text(this.account.transcriptJob.sourceLabel ?? '自动转写').fontSize(12).fontColor($r('app.color.yuqu_muted'))
        }
      }.width('100%')
      if (this.account.transcriptJob !== null) {
        if (this.account.transcriptJob.status !== 'ready') Text(`已处理至 ${this.formatTime(this.account.transcriptJob.completedMs)} / ${this.formatTime(this.account.transcriptJob.durationMs)}`)
          .id('transcript-progress').fontSize(13).fontColor($r('app.color.yuqu_muted'))
        if (this.account.transcriptJob.error !== null) {
          Text(this.account.transcriptJob.error).fontSize(13).fontColor($r('app.color.yuqu_danger'))
        }
        if (this.account.transcriptJob.status === 'failed' && !this.account.readingArchived) {
          Button('重试转写').quietAction().id('transcript-retry').enabled(!this.account.transcriptBusy)
            .onClick(() => { void AccountSync.getInstance().refreshTranscript(true); })
        }
        if (this.account.transcriptDiagnosticAvailable) {
          this.diagnosticPrompt('transcription')
        }
      }
      if (this.account.transcriptError.length > 0) {
        Text(this.account.transcriptError).id('transcript-error').fontSize(13).fontColor($r('app.color.yuqu_danger'))
      }
      Row({ space: 6 }) {
        Button(this.account.chaptersOpen ? '收起章节' : '章节').quietAction().id('chapters-toggle').layoutWeight(1)
          .onClick(() => { this.toggleTranscriptTool('chapters'); })
        Button(this.account.summariesOpen ? '收起总结' : '总结').quietAction().id('summaries-toggle').layoutWeight(1)
          .onClick(() => { this.toggleTranscriptTool('summaries'); })
        Button(this.sentenceSearchOpen ? '收起搜索' : '搜索').quietAction().id('transcript-search-toggle').layoutWeight(1)
          .onClick(() => { this.toggleTranscriptTool('search'); })
      }.width('100%')
      if (this.account.chaptersOpen) {
        Column({ space: 10 }) {
          Text('AI 根据整期文稿整理，可返回原文核对。').fontSize(12).fontColor($r('app.color.yuqu_muted'))
          if (this.account.chaptersError.length > 0) {
            Text(this.account.chaptersError).id('chapters-error').fontSize(13).fontColor($r('app.color.yuqu_danger'))
            Button('重试读取章节').quietAction().enabled(!this.account.chaptersBusy).onClick(() => { void AccountSync.getInstance().refreshChapters(); })
          }
          if (this.account.chapterContext !== null) {
            Text(`章节 · ${this.account.chapterContext.title}`).fontSize(16).fontWeight(FontWeight.Medium)
            Text('这里显示当前文稿，章节依据生成时的原文整理。').fontSize(12).fontColor($r('app.color.yuqu_muted'))
            if (this.account.transcriptLoaded && !this.account.transcriptBusy && this.account.transcriptError.length === 0 &&
              !this.account.transcriptSegments.some((segment: TranscriptSegment) => segment.id === this.account.chapterContext?.startSegmentId)) {
              Text('当前文稿未找到原章节起点，可返回目录查看章节范围。').fontSize(12).fontColor($r('app.color.yuqu_muted'))
            }
          } else {
            if (this.account.chaptersPage === null && this.account.chaptersError.length === 0) Text('正在读取章节…').fontSize(13)
            if (this.account.chaptersPage !== null) {
              if (this.account.chaptersPage.document !== null) {
                Text(`${this.chapterStatus()} · ${this.account.chaptersPage.document.completedBatches}/${this.account.chaptersPage.document.totalBatches}`).id('chapters-status').fontSize(13)
                if (['queued','running'].includes(this.account.chaptersPage.document.status)) {
                  if (!this.account.chaptersPage.bridgeOnline) Text('章节生成服务暂未连接，任务会保留等待。').fontSize(12)
                  Button('停止整理章节').quietAction().enabled(!this.account.chaptersBusy).onClick(() => { void AccountSync.getInstance().chapterAction('cancel'); })
                }
                if (['failed','cancelled'].includes(this.account.chaptersPage.document.status)) {
                  Button('继续整理章节').quietAction().enabled(!this.account.chaptersBusy).onClick(() => { void AccountSync.getInstance().chapterAction('retry'); })
                }
              }
              if (this.account.chaptersPage.canGenerate) {
                Button('生成章节').quietAction().id('chapters-generate').enabled(!this.account.chaptersBusy).onClick(() => { void AccountSync.getInstance().chapterAction('generate'); })
              } else if (this.account.chaptersPage.document === null) {
                Text('整期文稿完成后可生成章节。').fontSize(13).fontColor($r('app.color.yuqu_muted'))
              }
              if (this.account.chaptersCanPrevious || this.account.chaptersPage.nextAfter !== null) {
                Row({ space: 8 }) {
                  Button('上一页章节').quietAction().fontSize(12).layoutWeight(1).enabled(!this.account.chaptersBusy && this.account.chaptersCanPrevious)
                    .onClick(() => { this.turnChapters(false); })
                  Button('下一页章节').quietAction().fontSize(12).layoutWeight(1).enabled(!this.account.chaptersBusy && this.account.chaptersPage?.nextAfter !== null)
                    .onClick(() => { this.turnChapters(true); })
                }.width('100%')
              }
              ForEach(this.account.chaptersPage.chapters, (chapter: Chapter) => {
                Column({ space: 6 }) {
                  Text(chapter.title).fontSize(15).fontWeight(FontWeight.Medium).width('100%')
                  Text(`${this.formatTime(chapter.startMs)}–${this.formatTime(chapter.endMs)}`).fontSize(12).fontColor($r('app.color.yuqu_muted'))
                  Row({ space: 8 }) {
                    Button('查看文稿').quietAction().fontSize(12).layoutWeight(1).onClick(() => { this.openChapterContext(chapter); })
                    Button(chapter.endMs > chapter.startMs ? '播放本章' : '无可播放时长').quietAction().fontSize(12).layoutWeight(1).enabled(!this.account.busy && chapter.endMs > chapter.startMs && !this.account.readingArchived && this.account.chaptersPage?.audioAvailable === true)
                      .onClick(() => { void AccountSync.getInstance().playExcerpt(this.account.readingMediaVersionId || this.account.mediaVersionId, chapter.startMs, chapter.endMs); })
                  }.width('100%')
                }.width('100%').padding(10).backgroundColor($r('app.color.yuqu_subtle')).borderRadius(8).alignItems(HorizontalAlign.Start)
              }, (chapter: Chapter) => `${chapter.id}:${chapter.title}:${chapter.endMs}`)
              if (this.account.chaptersCanPrevious || this.account.chaptersPage.nextAfter !== null) {
                Row({ space: 8 }) {
                  Button('上一页章节').quietAction().fontSize(12).layoutWeight(1).enabled(!this.account.chaptersBusy && this.account.chaptersCanPrevious)
                    .onClick(() => { this.turnChapters(false); })
                  Button('下一页章节').quietAction().fontSize(12).layoutWeight(1).enabled(!this.account.chaptersBusy && this.account.chaptersPage?.nextAfter !== null)
                    .onClick(() => { this.turnChapters(true); })
                }.width('100%')
              }
              if (!this.account.chaptersPage.audioAvailable) Text('音频已清理，章节仍可阅读。').fontSize(12).fontColor($r('app.color.yuqu_muted'))
            }
          }
        }.width('100%').alignItems(HorizontalAlign.Start).onAreaChange((_oldArea: Area, area: Area) => {
          const top: number = (this.readerScroller.offset()?.yOffset ?? 0) + Number(area.globalPosition.y) - this.scrollWindowY;
          if (Number.isFinite(top)) this.chapterTopOffset = Math.max(0, top);
          if (this.restoreChapterScroll && this.account.chapterContext === null) {
            this.restoreChapterScroll = false;
            this.readerScroller.scrollTo({ xOffset: 0, yOffset: this.chapterScrollOffset, animation: false });
          }
        })
      }
      if (this.account.summariesOpen) {
        Column({ space: 10 }) {
          Text('分段与整期总结').fontSize(16).fontWeight(FontWeight.Medium)
          Text('总结依据生成时冻结的整期文稿；展开要点后才读取依据，便于逐条核对。').fontSize(12).fontColor($r('app.color.yuqu_muted'))
          if (this.account.summariesError.length > 0) {
            Text(this.account.summariesError).id('summaries-error').fontSize(13).fontColor($r('app.color.yuqu_danger'))
            Button('重试读取总结').quietAction().enabled(!this.account.summariesBusy).onClick(() => { void AccountSync.getInstance().refreshSummaries(); })
          }
          if (this.account.summariesPage === null && this.account.summariesError.length === 0) Text('正在读取总结…').fontSize(13)
          if (this.account.summariesPage !== null) {
            if (this.account.summariesPage.document === null) {
              if (!this.account.summariesPage.canGenerate) Text('整期文稿完成后可生成总结。').fontSize(13).fontColor($r('app.color.yuqu_muted'))
            } else {
              Text(`${this.summaryStatus()} · 已完成 ${this.account.summariesPage.document.completedParts}/${this.account.summariesPage.document.totalParts} 段 · 任务 ${this.account.summariesPage.document.completedTasks}/${this.account.summariesPage.document.totalTasks}`)
                .id('summaries-status').fontSize(13)
              if (this.account.summariesPage.document.status === 'queued' || this.account.summariesPage.document.status === 'running') {
                if (!this.account.summariesPage.bridgeOnline) Text('总结服务暂未连接，任务会保留等待。').fontSize(12)
                Button('停止整理总结').quietAction().enabled(!this.account.summariesBusy).onClick(() => { void AccountSync.getInstance().summaryAction('cancel'); })
              }
              if (this.account.summariesPage.document.status === 'failed' || this.account.summariesPage.document.status === 'cancelled') {
                Button('继续整理总结').quietAction().enabled(!this.account.summariesBusy).onClick(() => { void AccountSync.getInstance().summaryAction('retry'); })
              }
            }
            if (this.account.summariesPage.canGenerate) {
              Button(this.account.summariesPage.document === null ? '生成总结' : '重新整理总结').quietAction().id('summaries-generate').enabled(!this.account.summariesBusy).onClick(() => { void AccountSync.getInstance().summaryAction('generate'); })
              if (this.account.summariesPage.document !== null) Text('可按主题重新完整整理，原总结记录保留。').fontSize(12).fontColor($r('app.color.yuqu_muted'))
            }
            if (this.account.summariesPage.overview !== null) {
              this.summaryOverview(this.account.summariesPage.overview)
            }
            if (this.account.summariesPage.topicOverview != null) {
              this.summaryTopics(this.account.summariesPage.topicOverview)
            }
            ForEach(this.account.summariesPage.parts, (part: SummaryPart) => {
              this.summaryPart(part)
            }, (part: SummaryPart) => `${part.id}:${part.index}:${part.endMs}`)
              if (this.account.summariesCanPrevious || this.account.summariesPage.nextAfter !== null) {
                Row({ space: 8 }) {
                  Button('上一页总结').quietAction().fontSize(12).layoutWeight(1).enabled(!this.account.summariesBusy && this.account.summariesCanPrevious)
                    .onClick(() => { AccountSync.getInstance().previousSummaries(); })
                  Button('下一页总结').quietAction().fontSize(12).layoutWeight(1).enabled(!this.account.summariesBusy && this.account.summariesPage?.nextAfter !== null)
                    .onClick(() => { AccountSync.getInstance().nextSummaries(); })
                }.width('100%')
              }
            if (!this.account.summariesPage.audioAvailable) Text('音频已清理，总结与冻结依据仍可阅读。').fontSize(12).fontColor($r('app.color.yuqu_muted'))
          }
        }.width('100%').alignItems(HorizontalAlign.Start).padding(10).backgroundColor($r('app.color.yuqu_surface')).borderRadius(10)
      }
      if (this.sentenceSearchOpen) {
        Row({ space: 8 }) {
          TextInput({ text: this.searchText, placeholder: '搜索本集文稿' }).id('transcript-search-input').layoutWeight(1)
            .onChange((value: string) => { this.searchText = value; })
          Button(this.account.searchBusy ? '搜索中' : '搜索').quietAction().id('transcript-search')
            .enabled(!this.account.searchBusy && this.searchText.trim().length > 0)
            .onClick(() => { this.contextFocusId = ''; this.restoreSearchScroll = false; void AccountSync.getInstance().searchTranscript(this.searchText); })
        }.width('100%')
      }
      if (this.account.searchError.length > 0) Text(this.account.searchError).fontSize(12).fontColor($r('app.color.yuqu_danger'))
      if (this.account.searchView === 'context') {
        Text(`查看 ${this.formatTime(this.account.searchContextMs)} 附近的上下文`).fontSize(15).fontWeight(FontWeight.Medium)
        Text('这里显示当前文稿，原搜索结果与已固定原文仍保留。').fontSize(12).fontColor($r('app.color.yuqu_muted'))
        Button('返回搜索结果').quietAction().id('search-return').onClick(() => { this.returnToSearch(); })
        if (this.account.transcriptLoaded && !this.account.transcriptBusy && this.account.transcriptError.length === 0 &&
          !this.account.transcriptSegments.some((segment: TranscriptSegment) => segment.id === this.account.searchContextId)) {
          Text('当前页未找到原命中片段，可返回搜索结果查看保存时的原文。').fontSize(13).fontColor($r('app.color.yuqu_muted'))
        }
      }
      if (this.account.searchView === 'results') {
        Column({ space: 12 }) {
        Text(`搜索“${this.account.searchQuery}” · 已显示 ${this.account.searchResults.length} 处 · 截至 ${this.formatTime(this.account.searchThroughMs)}`).fontSize(12)
        Button('返回文稿').quietAction().onClick(() => { this.sentenceSearchOpen = false; AccountSync.getInstance().clearSearch(); })
        if (!this.account.searchBusy && this.account.searchResults.length === 0 && this.account.searchError.length === 0) Text('没有找到匹配片段').fontSize(13)
        ForEach(this.account.searchResults, (result: SearchResult) => {
          Column({ space: 6 }) {
            Text(`${this.formatTime(result.startMs)}–${this.formatTime(result.endMs)}`).fontSize(12)
            Text() {
              ForEach(this.highlighted(result), (piece: TextPiece) => {
                Span(piece.text).fontColor(piece.marked ? $r('app.color.yuqu_accent_ink') : $r('app.color.yuqu_ink'))
                  .fontWeight(piece.marked ? FontWeight.Bold : FontWeight.Normal)
              })
            }.fontSize(14).width('100%')
            Row({ space: 6 }) {
              Button('上下文').quietAction().fontSize(12).layoutWeight(1).onClick(() => { this.openSearchContext(result); })
              Button('问这段').quietAction().fontSize(12).layoutWeight(1).onClick(() => { AccountSync.getInstance().askSearchResult(result); this.showChat(); })
              Button('收藏').quietAction().fontSize(12).layoutWeight(1).enabled(!this.account.savedBusy)
                .onClick(() => { void AccountSync.getInstance().saveSearchResult(result); })
            }.width('100%')
            Button('回听这一段').quietAction().fontSize(12).enabled(!this.account.busy && !this.account.readingArchived)
              .onClick(() => { void AccountSync.getInstance().playExcerpt(this.account.readingMediaVersionId || this.account.mediaVersionId, result.startMs, result.endMs); })
          }.padding(10).width('100%').backgroundColor($r('app.color.yuqu_subtle')).borderRadius(8)
        }, (result: SearchResult) => `${result.id}:${result.text}`)
        if (this.account.searchCanNext) Button('更多搜索结果').quietAction().enabled(!this.account.searchBusy)
          .onClick(() => { void AccountSync.getInstance().searchTranscript(this.account.searchQuery, true); })
        }.width('100%').alignItems(HorizontalAlign.Start).onAreaChange(() => {
          if (this.restoreSearchScroll && this.account.searchView === 'results') {
            this.restoreSearchScroll = false;
            this.readerScroller.scrollTo({ xOffset: 0, yOffset: this.searchScrollOffset, animation: false });
          }
        })
      }
      if (this.account.searchView !== 'results') {
      if (this.account.savedError.length > 0) Text(this.account.savedError).fontSize(12).fontColor($r('app.color.yuqu_danger'))
      if (this.account.transcriptSegments.length > 0) {
        Text(this.readingAudioAvailable() ? '点句播放 · 长按后上下拖动可多选' : '长按一句，上下拖动可多选')
          .fontSize(12).fontColor($r('app.color.yuqu_muted'))
        TranscriptSentences({
          segments: this.account.transcriptSegments, selectedIds: this.account.selectedSegmentIds, activeId: this.activeSentenceId,
          searchId: this.account.searchContextId, chapterId: this.account.chapterContext?.startSegmentId ?? '',
          contextRevision: this.account.searchContextRevision + this.account.chapterContextRevision,
          canPlay: !this.account.busy && this.readingAudioAvailable(),
          onPlay: (id: string) => { void this.playSentence(id); },
          onSelect: (anchor: string, end: string) => { this.selectSentenceRange(anchor, end); },
          onToggle: (id: string) => { this.tapSelectedSentence(id); },
          onDrag: (active: boolean) => { this.draggingSelection = active; },
          onRowArea: (id: string, area: Area) => { this.recordSentenceArea(id, area); },
          viewportTop: () => this.scrollWindowY, viewportHeight: () => this.scrollWindowHeight,
          scrollOffset: () => this.readerScroller.offset()?.yOffset ?? 0,
          onEdgeScroll: (dy: number) => { this.readerScroller.scrollBy(0, dy); }
        })
      }
      if (this.account.transcriptLoaded && this.account.transcriptJob !== null && this.account.transcriptSegments.length === 0) {
        Text(this.account.transcriptJob.status === 'ready' ||
          this.account.transcriptJob.completedMs > (this.account.transcriptPageCursor + 1) * 30000 ?
          '这一页暂无独立文稿片段，可查看前后文。' : '这一段还没有文稿，转写完成后会自动更新。')
          .fontSize(13).fontColor($r('app.color.yuqu_muted'))
      }
      if (this.account.transcriptJob !== null) {
        Row({ space: 8 }) {
          if (this.account.readingMediaVersionId && this.account.readingMediaVersionId !== this.account.mediaVersionId &&
            this.account.transcriptCanPrevious) {
            Button('从头查看').quietAction().id('transcript-current').enabled(!this.account.transcriptBusy)
              .onClick(() => { AccountSync.getInstance().transcriptNearCurrent(); })
          }
          Button('上一段').quietAction().id('transcript-previous').layoutWeight(1)
            .enabled(!this.account.transcriptBusy && this.account.transcriptCanPrevious)
            .onClick(() => { this.pauseTranscriptFollow(); AccountSync.getInstance().previousTranscriptPage(); })
          Button('下一段').quietAction().id('transcript-next').layoutWeight(1)
            .enabled(!this.account.transcriptBusy && this.account.transcriptCanNext)
            .onClick(() => { this.pauseTranscriptFollow(); AccountSync.getInstance().nextTranscriptPage(); })
        }.width('100%')
        Text(`从 ${this.formatTime(Math.max(0, this.account.transcriptPageCursor + 1) * 30000)} 开始${this.account.transcriptBusy ? ' · 更新中' : ''}`)
          .fontSize(12).fontColor($r('app.color.yuqu_muted'))
      }
      }
    }.padding(16).width('100%').alignItems(HorizontalAlign.Start)
      .backgroundColor($r('app.color.yuqu_surface')).borderRadius(16)
  }

  @Builder
  private savedList() {
    Column({ space: 12 }) {
      Text(this.account.savedThisEpisode ? '本集收藏' : '全部收藏').fontSize(20).fontWeight(FontWeight.Bold)
      Row({ space: 8 }) {
        Button('全部收藏').quietAction().fontSize(12).layoutWeight(1).enabled(this.editingSaved.length === 0).onClick(() => { AccountSync.getInstance().setSavedOpen(true, false); })
        Button('本集收藏').quietAction().fontSize(12).layoutWeight(1).enabled(this.editingSaved.length === 0).onClick(() => { AccountSync.getInstance().setSavedOpen(true, true); })
        Button('刷新').quietAction().fontSize(12).layoutWeight(1).enabled(!this.account.savedBusy && this.editingSaved.length === 0)
          .onClick(() => { void AccountSync.getInstance().refreshSaved(false, true); })
      }.width('100%')
      if (this.account.savedError.length > 0) Text(this.account.savedError).fontColor($r('app.color.yuqu_danger')).fontSize(13)
      if (this.account.savedBusy) Text('正在更新收藏…').fontSize(13)
      if (!this.account.savedBusy && this.account.savedItems.length === 0) Text('从文稿片段或 AI 回答保存第一条收藏').fontSize(14)
      if (this.editingSaved.length > 0 && !this.hasEditingSavedItem()) {
        this.savedNoteEditor()
      }
      ForEach(this.account.savedItems, (item: SavedItem) => {
        Column({ space: 8 }) {
          Text(`${item.kind === 'answer' ? '回答' : '文稿片段'} · ${item.mediaTitle}`).fontSize(15).fontWeight(FontWeight.Medium)
          if (item.content.question !== undefined) Text(item.content.question).fontSize(14).fontColor($r('app.color.yuqu_muted'))
          Text(item.content.text).fontSize(14).width('100%')
          if (item.note.length > 0) Text(`我的备注：${item.note}`).fontSize(13).fontColor($r('app.color.yuqu_muted'))
          if (this.editingSaved === item.id) {
            this.savedNoteEditor()
          }
          Button(item.note.length > 0 ? '编辑备注' : '添加备注').quietAction().fontSize(12)
            .enabled(!this.account.savedBusy && this.editingSaved.length === 0)
            .onClick(() => { this.beginNote(item); })
          Row({ space: 8 }) {
            Button('回到来源').quietAction().fontSize(12).layoutWeight(1)
              .onClick(() => { this.showTranscript(); void AccountSync.getInstance().readSaved(item); })
            Button('删除收藏').quietAction().fontSize(12).layoutWeight(1).enabled(!this.account.savedBusy)
              .onClick(() => { this.confirmSavedRemoval(item); })
          }.width('100%')
          if (!item.audioAvailable) Text('音频已清理，收藏与备注仍可阅读').fontSize(12).fontColor($r('app.color.yuqu_muted'))
        }.padding(14).width('100%').alignItems(HorizontalAlign.Start).backgroundColor($r('app.color.yuqu_surface')).borderRadius(12)
      }, (item: SavedItem) => `${item.id}:${item.updatedAt}:${item.audioAvailable}:${this.editingSaved === item.id}:${this.account.savedBusy}`)
      if (this.account.savedCanNext) Button('更多收藏').quietAction().enabled(!this.account.savedBusy)
        .onClick(() => { void AccountSync.getInstance().refreshSaved(true); })
    }.width('100%').alignItems(HorizontalAlign.Start)
  }

  @Builder
  private miniPlayer() {
    Column({ space: 2 }) {
      if (this.account.replayReturnLabel.length > 0) this.replayActions()
      Row({ space: 10 }) {
        Column({ space: 2 }) {
          Text(this.account.title).fontSize(13).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
          Text(`${this.formatTime(this.account.positionMs)} / ${this.formatTime(this.account.durationMs)} · ${this.account.loggedIn && !this.account.owner ? '跟随 · 本机静音' : '本机播放'}`).fontSize(12).fontColor($r('app.color.yuqu_muted'))
        }.layoutWeight(1).alignItems(HorizontalAlign.Start)
        if (this.account.loggedIn && !this.account.owner) {
          Button('本机播放').quietAction().id('mini-takeover').fontSize(12).enabled(!this.account.busy && this.account.audioAvailable)
            .onClick(() => { void AccountSync.getInstance().takeover(); })
        } else {
          Button(this.playbackActionLabel()).quietAction().id('mini-play-toggle').fontSize(12)
            .enabled(this.viewState.recovering || this.canControl() || this.canRetryPlayback())
            .onClick(() => { this.togglePlayback(); })
        }
      }.width('100%')
    }.padding({ left: 16, right: 16, top: 4, bottom: 4 }).width('100%').backgroundColor($r('app.color.yuqu_surface'))
  }

  @Builder
  private replayActions() {
    Row({ space: 8 }) {
      Button(this.account.replayReturnLabel).quietAction().id('replay-return').fontSize(12).layoutWeight(1).enabled(!this.account.busy)
        .onClick(() => { void AccountSync.getInstance().returnFromReplay(); })
      Button('继续听').quietAction().id('replay-continue').fontSize(12).enabled(this.canControl())
        .onClick(() => { void AccountSync.getInstance().continueReplay(); })
    }.width('100%')
  }

  @Builder
  private chatHistory() {
    Column({ space: 14 }) {
      Text(this.account.readingMediaVersionId.length > 0 ? `阅读《${this.account.readingTitle}》 · ${this.formatTime(this.account.contentDurationMs)}` :
        `${this.formatTime(this.account.contentPositionMs)} / ${this.formatTime(this.account.contentDurationMs)} · ${this.account.playing ? '正在收听' : '已暂停'}`)
        .id('chat-playback-position').fontSize(13).fontColor($r('app.color.yuqu_muted'))
      Text(!this.account.chatLoaded ? '正在读取对话…' : this.account.chatBridgeOnline ?
        'AI 已连接' : 'AI 暂未连接，问题会排队等待').id('chat-connection').fontSize(13).fontColor($r('app.color.yuqu_muted'))
      if (this.account.chatCanEarlier || !this.account.chatIsLatest) {
        Row({ space: 8 }) {
          Button('更早记录').quietAction().id('chat-earlier').layoutWeight(1)
            .enabled(!this.account.chatBusy && this.account.chatCanEarlier)
            .onClick(() => { this.chatScrollTarget = 'earlier'; AccountSync.getInstance().earlierChat(); })
          Button('最新记录').quietAction().id('chat-latest').layoutWeight(1)
            .enabled(!this.account.chatBusy && !this.account.chatIsLatest)
            .onClick(() => { this.chatScrollTarget = 'latest'; AccountSync.getInstance().latestChat(); })
        }.width('100%')
      }
      if (this.account.chatLoaded && this.account.chatTurns.length === 0) {
        Text('可以问“刚才这段是什么意思”，回答会依据提问时的位置和已有文稿。').fontSize(14).fontColor($r('app.color.yuqu_muted'))
      }
      ForEach(this.account.chatTurns, (turn: ChatTurn) => {
        Column({ space: 10 }) {
          Column({ space: 5 }) {
            Text(turn.scope === 'retrieval' ? `你 · ${this.chatScope(turn.scope)}` : `你 · ${this.formatTime(turn.positionMs)} · ${this.chatScope(turn.scope)}`).fontSize(12).fontColor($r('app.color.yuqu_muted'))
            if (turn.scope === 'retrieval' && turn.retrieval !== undefined && turn.retrieval !== null) {
              Text(this.chatRetrievalMeta(turn)).fontSize(12).fontColor($r('app.color.yuqu_muted'))
            }
            Text(turn.question).copyOption(CopyOptions.InApp).fontSize(16).width('100%')
          }.padding(12).width('100%').alignItems(HorizontalAlign.Start).backgroundColor($r('app.color.yuqu_subtle')).borderRadius(14)
          Text(`AI · ${this.chatStatus(turn.status)}`).fontSize(12).fontColor($r('app.color.yuqu_muted'))
          if (turn.answer.length > 0) {
            Text() {
              ForEach(this.answerPieces(turn), (piece: TextPiece) => {
                Span(piece.text).fontColor(piece.marked ? $r('app.color.yuqu_accent_ink') : $r('app.color.yuqu_ink'))
                  .onClick(() => { if (piece.marked) this.showCitations(turn, piece.text); })
              })
            }.copyOption(CopyOptions.InApp).lineHeight(25).id(`chat-answer-${turn.id}`).fontSize(15).width('100%')
          } else if (turn.status === 'queued' || turn.status === 'running') {
            Text(turn.status === 'queued' ? '问题已保存，等待开始回答。' : '正在根据文稿整理回答…').fontSize(13).fontColor($r('app.color.yuqu_muted'))
          }
          if (turn.status === 'complete') {
            Row({ space: 8 }) {
              if (!this.chatRetrievalNoEvidence(turn)) {
                Button('继续问这个话题').quietAction().fontSize(12).layoutWeight(1).enabled(!this.account.chatBusy)
                  .onClick(() => { AccountSync.getInstance().followTurn(turn.id); })
              } else {
                Button('重新检索整期文稿').quietAction().fontSize(12).layoutWeight(1).enabled(!this.account.chatBusy)
                  .onClick(() => { AccountSync.getInstance().askRetrieval(); })
              }
              Button('收藏回答').quietAction().fontSize(12).layoutWeight(1).enabled(!this.account.savedBusy)
                .onClick(() => { void AccountSync.getInstance().saveAnswer(turn.id); })
            }.width('100%')
          }
          if (turn.error !== null) Text(turn.error).fontSize(13).fontColor($r('app.color.yuqu_danger'))
          if (turn.citations.length > 0) {
            Button(this.expandedChatTurn === turn.id ? '收起引用' : `查看引用原文（${turn.citations.length}）`).quietAction()
              .id(`chat-citations-${turn.id}`).fontSize(12)
              .onClick(() => {
                if (turn.citations.length > 2 || turn.citations.some((item: ChatCitation) => item.text.length > 160)) {
                  this.showCitations(turn);
                } else { this.expandedChatTurn = this.expandedChatTurn === turn.id ? '' : turn.id; }
              })
            if (this.expandedChatTurn === turn.id) {
              ForEach(turn.citations, (citation: ChatCitation) => {
                this.citationCard(turn, citation)
              }, (citation: ChatCitation) => citation.id)
            }
          }
          if (turn.status === 'queued' || turn.status === 'running') {
            Button('取消回答').quietAction().id(`chat-cancel-${turn.id}`).enabled(!this.account.chatBusy)
              .onClick(() => { void AccountSync.getInstance().cancelChat(turn.id); })
          }
          if (turn.status === 'failed') {
            Button('重试回答').quietAction().id(`chat-retry-${turn.id}`)
              .enabled(!this.account.chatBusy && !this.account.chatActive && this.account.chatIsLatest)
              .onClick(() => { void AccountSync.getInstance().retryChat(turn.id); })
          }
        }.width('100%').alignItems(HorizontalAlign.Start).padding({ top: 8, bottom: 8 })
      }, (turn: ChatTurn) => `${turn.id}:${turn.status}:${turn.scope}:${turn.answer.length}:${turn.citations.length}:${turn.error ?? ''}:${turn.retrieval?.status ?? ''}:${turn.retrieval?.selectedSegments ?? 0}:${turn.retrieval?.totalSegments ?? 0}:${turn.retrieval?.snapshot.throughMs ?? 0}:${this.expandedChatTurn === turn.id}:${this.account.chatBusy}:${this.account.chatActive}:${this.account.chatIsLatest}:${this.account.busy}:${this.account.chatAudioAvailable}`)
      if (this.account.chatError.length > 0) {
        Text(this.account.chatError).id('chat-error').fontSize(13).fontColor($r('app.color.yuqu_danger'))
      }
      if (!this.account.chatIsLatest) {
        Text('正在查看更早记录，回到最新记录后可继续提问。').fontSize(12).fontColor($r('app.color.yuqu_muted'))
      }
      if (this.account.savedError.length > 0) Text(this.account.savedError).fontSize(12).fontColor($r('app.color.yuqu_danger'))
    }.padding(16).width('100%').alignItems(HorizontalAlign.Start)
      .onAreaChange(() => {
        if (this.chatScrollTarget.length > 0 && this.account.chatLoaded && this.account.chatTurns.length > 0) {
          const end: boolean = this.chatScrollTarget === 'latest';
          this.chatScrollTarget = ''; this.chatScroller.scrollEdge(end ? Edge.Bottom : Edge.Top);
        }
      })
  }

  @Builder
  private citationSheet() {
    Scroll() {
      Column({ space: 12 }) {
        ForEach(this.account.chatTurns.filter((turn: ChatTurn) => turn.id === this.citationTurnId), (turn: ChatTurn) => {
          ForEach(turn.citations.filter((citation: ChatCitation) => this.citationFilter.length === 0 ||
            this.citationFilter.includes(citation.id)), (citation: ChatCitation) => {
            this.citationCard(turn, citation)
          }, (citation: ChatCitation) => citation.id)
          if (this.citationFilter.length > 0 && this.citationFilter.length < turn.citations.length) {
            Button('查看全部引用').quietAction().onClick(() => { this.citationFilter = []; })
          }
        }, (turn: ChatTurn) => turn.id)
      }.padding(16).width('100%').alignItems(HorizontalAlign.Start)
    }.align(Alignment.TopStart).width('100%').height('100%')
  }

  @Builder
  private citationCard(turn: ChatTurn, citation: ChatCitation) {
    Column({ space: 4 }) {
      Text(`[${citation.id}] ${this.formatTime(citation.startMs)}–${this.formatTime(citation.endMs)}`)
        .fontSize(12).fontColor($r('app.color.yuqu_muted'))
      Text(citation.text).copyOption(CopyOptions.InApp).lineHeight(22).fontSize(14).width('100%')
      Row({ space: 6 }) {
        Button('查看上下文').quietAction().fontSize(12).layoutWeight(1)
          .onClick(() => { this.showTranscript(); void AccountSync.getInstance().showContext(citation.startMs); })
        Button('问这段').quietAction().fontSize(12).layoutWeight(1).enabled(!this.account.chatBusy)
          .onClick(() => { this.citationSheetOpen = false; AccountSync.getInstance().askCitation(turn.id, citation.id); })
      }.width('100%')
      Button('回听这一段').quietAction().id(`chat-replay-${turn.id}-${citation.id}`).fontSize(12)
        .enabled(!this.account.busy && this.account.chatAudioAvailable)
        .onClick(() => { this.citationSheetOpen = false; void AccountSync.getInstance().playCitation(turn.id, citation.id); })
      if (!this.account.chatAudioAvailable) {
        Text('音频已清理或状态未确认，仍可查看原文').fontSize(12).fontColor($r('app.color.yuqu_muted'))
      }
    }.padding(10).width('100%').alignItems(HorizontalAlign.Start).backgroundColor($r('app.color.yuqu_accent_soft')).border({ width: { left: 2 }, color: $r('app.color.yuqu_accent') }).borderRadius(8)
  }

  @Builder
  private chatOptions() {
    Scroll() {
      Column({ space: 12 }) {
        Text('提问方式').fontSize(20).fontWeight(FontWeight.Bold)
        if (this.account.readingMediaVersionId.length > 0) {
          Button('回到当前播放节目提问').quietAction().enabled(!this.account.chatBusy)
            .onClick(() => { this.chatOptionsOpen = false; AccountSync.getInstance().askNow(); })
        } else {
          Row({ space: 6 }) {
            ForEach(['near', 'until', 'all'], (scope: string) => {
              Button(this.chatScope(scope)).quietAction().id(`chat-scope-${scope}`).layoutWeight(1).fontSize(12)
                .backgroundColor(this.account.chatScope === scope ? $r('app.color.yuqu_accent_soft') : $r('app.color.yuqu_subtle'))
                .fontColor(this.account.chatScope === scope ? $r('app.color.yuqu_accent_ink') : $r('app.color.yuqu_ink'))
                .enabled(!this.account.chatBusy)
                .onClick(() => { this.chatOptionsOpen = false; AccountSync.getInstance().setChatScope(scope); })
            }, (scope: string) => `${scope}:${this.account.chatScope}:${this.account.chatBusy}`)
          }.width('100%')
          Row({ space: 6 }) {
            Button('解释刚才').quietAction().fontSize(12).layoutWeight(1).enabled(!this.account.chatBusy)
              .onClick(() => { this.chatOptionsOpen = false; AccountSync.getInstance().askNow('刚才这段是什么意思？'); })
            Button('概括刚才').quietAction().fontSize(12).layoutWeight(1).enabled(!this.account.chatBusy)
              .onClick(() => { this.chatOptionsOpen = false; AccountSync.getInstance().askNow('请概括刚才这段的要点。'); })
            Button('问现在听到的').quietAction().fontSize(12).layoutWeight(1).enabled(!this.account.chatBusy)
              .onClick(() => { this.chatOptionsOpen = false; AccountSync.getInstance().askNow(); })
          }.width('100%')
        }
        Button('检索整期文稿').quietAction().id('chat-retrieval').fontSize(12).width('100%').enabled(!this.account.chatBusy)
          .onClick(() => { this.chatOptionsOpen = false; AccountSync.getInstance().askRetrieval(); })
        if (!this.account.chatRetrievalOnline) {
          Text('整期检索 AI 暂未连接，有相关原文的问题会排队等待。').fontSize(12).fontColor($r('app.color.yuqu_muted')).width('100%')
        }
      }.alignItems(HorizontalAlign.Start).padding(18).width('100%')
    }.align(Alignment.TopStart).width('100%')
  }

  @Builder
  private chatComposer() {
    Column({ space: 4 }) {
      Row({ space: 8 }) {
        Text(this.account.chatAnchorLabel.length > 0 ? this.account.chatAnchorLabel :
          this.account.readingMediaVersionId.length > 0 ? '独立阅读：选择片段或检索整期文稿后提问' : '开始输入时固定当前位置').id('chat-anchor').fontSize(13).fontColor($r('app.color.yuqu_ink')).layoutWeight(1)
        Button('提问方式').quietAction().id('chat-options').fontSize(13).onClick(() => { this.chatOptionsOpen = true; })
          .bindSheet($$this.chatOptionsOpen, this.chatOptions(), { height: SheetSize.MEDIUM, dragBar: true, backgroundColor: $r('app.color.yuqu_surface') })
      }.width('100%')
      Row({ space: 8 }) {
        TextArea({ text: this.account.chatDraft, placeholder: '刚才这段是什么意思？' }).id('chat-question')
          .maxLength(2000).maxLines(3).constraintSize({ minHeight: 44, maxHeight: 88 }).layoutWeight(1)
          .backgroundColor($r('app.color.yuqu_subtle')).borderRadius(14).padding({ left: 12, right: 12, top: 10, bottom: 10 })
          .border({ width: 1, color: this.inputFocused ? $r('app.color.yuqu_accent') : $r('app.color.yuqu_line') })
          .onFocus(() => { this.followComposerResize = this.chatScroller.isAtEnd(); this.inputFocused = true; })
          .onBlur(() => { this.inputFocused = false; this.followComposerResize = false; })
          .enabled(!this.account.chatBusy && this.account.chatIsLatest)
          .onChange((value: string) => { AccountSync.getInstance().setChatDraft(value); })
        Button(this.account.chatBusy ? '提交中…' : this.account.chatUnconfirmed ? '重新确认发送' : '发送').quietAction()
          .id('chat-send').height(44).backgroundColor($r('app.color.yuqu_primary')).fontColor($r('app.color.yuqu_on_primary')).enabled(this.account.chatCanSend)
          .onClick(() => { void AccountSync.getInstance().sendChat(); })
      }.width('100%')
      if (this.account.chatUnconfirmed) {
        Text(this.account.chatScope === 'retrieval' ? '上次发送结果未确认，重发会沿用同一问题和整期检索范围。' : '上次发送结果未确认，重发会沿用同一问题和原播放位置。').fontSize(12).fontColor($r('app.color.yuqu_muted'))
      } else if (this.account.chatActive) {
        Text('当前回答完成或取消后，可以继续提问。').fontSize(12).fontColor($r('app.color.yuqu_muted'))
      }
    }.padding({ left: 14, right: 14, top: 4, bottom: 8 }).width('100%').alignItems(HorizontalAlign.Start)
      .backgroundColor($r('app.color.yuqu_surface')).border({ width: { top: 0.5 }, color: $r('app.color.yuqu_line') })
  }

  @Builder
  private libraryTab(section: string, title: string, id: string) {
    Button(title).quietAction().id(id).layoutWeight(1)
      .fontColor(this.section === section ? $r('app.color.yuqu_accent_ink') : $r('app.color.yuqu_muted'))
      .backgroundColor(this.section === section ? $r('app.color.yuqu_accent_soft') : $r('app.color.yuqu_surface'))
      .accessibilitySelected(this.section === section)
      .onClick(() => { if (this.section !== section) this.switchSection(section); })
  }

  @Builder
  private libraryTabs() {
    Row({ space: 4 }) {
      this.libraryTab('library', '节目', 'library-episodes')
      this.libraryTab('saved', '收藏', 'library-saved')
    }.width('100%').padding({ left: 16, right: 16, top: 2, bottom: 6 })
      .accessibilityRole(AccessibilityRoleType.TAB_BAR)
  }

  @Builder
  private libraryList() {
    Column({ space: 18 }) {
      Row({ space: 12 }) {
        if (this.account.libraryUsage !== null) {
          Column({ space: 5 }) {
            Text(`已用 ${this.formatBytes(this.account.libraryUsage.usedBytes)} / ${this.formatBytes(this.account.libraryUsage.limitBytes)} · ${this.account.libraryUsage.itemCount}/${this.account.libraryUsage.itemLimit} 期资料`)
              .id('library-usage').fontSize(12).fontColor($r('app.color.yuqu_muted'))
            if (this.account.libraryUsage.reservedBytes > 0 || this.account.libraryUsage.reclaimingBytes > 0) {
              Text(`下载预留 ${this.formatBytes(this.account.libraryUsage.reservedBytes)} · 待回收 ${this.formatBytes(this.account.libraryUsage.reclaimingBytes)}`)
                .id('library-reclaiming').fontSize(12).fontColor($r('app.color.yuqu_muted'))
            }
          }.layoutWeight(1).alignItems(HorizontalAlign.Start)
        } else {
          Blank().layoutWeight(1)
        }
        Button('添加').id('library-toggle').height(44).fontSize(14)
          .padding({ left: 18, right: 18 }).borderRadius(22)
          .backgroundColor($r('app.color.yuqu_primary')).fontColor($r('app.color.yuqu_on_primary'))
          .accessibilityText('添加音频、播客或 B 站资料')
          .onClick(() => {
            this.importOpen = true;
          })
          .bindSheet($$this.importOpen, this.libraryImportSheet(), {
            height: SheetSize.LARGE,
            dragBar: true,
            showClose: true,
            backgroundColor: $r('app.color.yuqu_surface'),
            title: { title: '添加资料', subtitle: '音频、播客与 B 站' }
          })
      }.width('100%')

      if (!this.importOpen) {
        if (this.account.libraryBusy) {
          Text('正在更新资料…').fontSize(13).fontColor($r('app.color.yuqu_muted'))
        }
        if (this.account.libraryError.length > 0) {
          Text(this.account.libraryError).id('library-error').fontSize(13).fontColor($r('app.color.yuqu_danger'))
        }
      }

      if (this.account.libraryItems.length === 0 && !this.account.libraryBusy) {
        Column({ space: 8 }) {
          Text('从一段想听的内容开始').fontSize(17).fontWeight(FontWeight.Medium).fontColor($r('app.color.yuqu_ink'))
          Text('点击“添加”粘贴链接。音频就绪后可以收听，转写的文稿可用于提问。')
            .fontSize(14).lineHeight(23).fontColor($r('app.color.yuqu_muted')).textAlign(TextAlign.Center)
        }.width('100%').padding({ top: 36, bottom: 36, left: 20, right: 20 })
          .backgroundColor($r('app.color.yuqu_surface')).borderRadius(16)
      }

      ForEach(this.account.libraryItems, (item: LibraryItem) => {
        Column({ space: 12 }) {
          Row({ space: 8 }) {
            Text(item.title).fontSize(17).fontWeight(FontWeight.Medium).lineHeight(25)
              .fontColor($r('app.color.yuqu_ink')).layoutWeight(1)
            if (item.deletable === true) {
              Button('⋯').id(`library-manage-${item.mediaVersionId}`).width(44).height(44).padding(0)
                .fontSize(23).backgroundColor(Color.Transparent).fontColor($r('app.color.yuqu_muted'))
                .accessibilityText(`管理 ${item.title}`).enabled(!this.account.libraryBusy)
                .bindMenu(this.libraryItemMenu(item))
            }
          }.width('100%').alignItems(VerticalAlign.Top)
          Text(`${this.formatTime(item.durationMs)} · ${item.audioAvailable === false ? '音频已清理' : this.formatBytes(item.byteSize ?? 0)}`)
            .fontSize(12).fontColor($r('app.color.yuqu_muted'))
          if (this.libraryTranscriptLabel(item).length > 0) {
            Text(this.libraryTranscriptLabel(item)).fontSize(12).lineHeight(19)
              .fontColor($r('app.color.yuqu_muted'))
          }
          Row({ space: 10 }) {
            Button('查看文稿').id(`library-read-${item.mediaVersionId}`).layoutWeight(1).height(44)
              .fontSize(14).borderRadius(12).backgroundColor($r('app.color.yuqu_subtle'))
              .fontColor($r('app.color.yuqu_ink'))
              .onClick(() => { this.showTranscript(); AccountSync.getInstance().selectReading(item.mediaVersionId); })
            Button('播放').id(`library-play-${item.mediaVersionId}`).layoutWeight(1).height(44)
              .fontSize(14).borderRadius(12).backgroundColor($r('app.color.yuqu_accent_soft'))
              .fontColor($r('app.color.yuqu_accent_ink'))
              .enabled(!this.account.busy && !this.account.libraryBusy && item.audioAvailable !== false)
              .onClick(() => { void AccountSync.getInstance().takeover(item.mediaVersionId); })
          }.width('100%')
        }.width('100%').padding(16).alignItems(HorizontalAlign.Start)
          .backgroundColor($r('app.color.yuqu_surface')).borderRadius(16)
          .border({ width: 1, color: $r('app.color.yuqu_line') })
      }, (item: LibraryItem) => `${item.mediaVersionId}:${item.title}:${item.audioAvailable}:${item.byteSize}:${item.deletable}:${this.libraryTranscriptLabel(item)}:${this.account.libraryBusy}:${this.account.busy}`)

      if (!this.importOpen && this.account.importJobs.length > 0) {
        this.libraryImportTasks()
      }
    }.width('100%').alignItems(HorizontalAlign.Start)
  }

  @Builder
  private libraryItemMenu(item: LibraryItem) {
    Menu() {
      if (item.audioAvailable !== false) {
        MenuItem({ content: '清理音频' }).id(`library-remove-audio-${item.mediaVersionId}`)
          .contentFontColor($r('app.color.yuqu_ink')).enabled(!this.account.libraryBusy)
          .onClick(() => { this.confirmRemoval(item, 'audio'); })
      }
      MenuItem({ content: '删除整期' }).id(`library-remove-all-${item.mediaVersionId}`)
        .contentFontColor($r('app.color.yuqu_danger')).enabled(!this.account.libraryBusy)
        .onClick(() => { this.confirmRemoval(item, 'all'); })
    }
  }

  @Builder
  private libraryImportSheet() {
    Scroll() {
      Column({ space: 18 }) {
        Column({ space: 9 }) {
          Text('粘贴链接').fontSize(15).fontWeight(FontWeight.Medium).fontColor($r('app.color.yuqu_ink'))
          TextInput({ text: this.importUrl, placeholder: '音频链接、RSS、BV 号或 B 站分享文本' }).id('library-import-url')
            .maxLength(2048).height(48).fontSize(15).borderRadius(12)
            .backgroundColor($r('app.color.yuqu_subtle')).fontColor($r('app.color.yuqu_ink'))
            .placeholderColor($r('app.color.yuqu_muted')).enabled(!this.account.libraryBusy)
            .onChange((value: string) => { this.importUrl = value; })
          Button(this.account.libraryBusy ? '正在处理…' : '预览链接').id('library-import-audio')
            .width('100%').height(46).fontSize(15).borderRadius(12)
            .backgroundColor($r('app.color.yuqu_primary')).fontColor($r('app.color.yuqu_on_primary'))
            .enabled(!this.account.libraryBusy && this.importUrl.trim().length > 0)
            .onClick(() => { void AccountSync.getInstance().previewFeed(this.importUrl); })
          Text('先查看内容，再选择要导入的节目或分 P。')
            .fontSize(13).lineHeight(21).fontColor($r('app.color.yuqu_muted'))
        }.width('100%').alignItems(HorizontalAlign.Start)

        if (this.account.libraryError.length > 0) {
          Text(this.account.libraryError).id('library-import-error').fontSize(13).lineHeight(21)
            .fontColor($r('app.color.yuqu_danger')).width('100%')
        }

        if (this.account.feedEpisodes.length > 0) {
          Column({ space: 12 }) {
            Text(this.account.feedTitle.length > 0 ? this.account.feedTitle : '选择要导入的内容')
              .fontSize(17).fontWeight(FontWeight.Medium).fontColor($r('app.color.yuqu_ink'))
            ForEach(this.account.feedEpisodes, (episode: FeedEpisode) => {
              Row({ space: 12 }) {
                Text(episode.title).fontSize(15).lineHeight(23).fontColor($r('app.color.yuqu_ink')).layoutWeight(1)
                Button('导入').height(44).fontSize(14).padding({ left: 16, right: 16 })
                  .borderRadius(12).backgroundColor($r('app.color.yuqu_accent_soft'))
                  .fontColor($r('app.color.yuqu_accent_ink')).enabled(!this.account.libraryBusy)
                  .accessibilityText(`导入 ${episode.title}`)
                  .onClick(() => { void AccountSync.getInstance().importAudio(episode.url, episode.title); })
              }.width('100%').padding({ top: 8, bottom: 8 })
            }, (episode: FeedEpisode) => `${episode.url}:${episode.title}:${this.account.libraryBusy}`)
          }.width('100%').alignItems(HorizontalAlign.Start)
        }

        if (this.account.importJobs.length > 0) {
          this.libraryImportTasks()
        }
        Text('音频下载完成后可播放，文稿会自动转写，已转写的内容可用于提问。')
          .fontSize(13).lineHeight(22).fontColor($r('app.color.yuqu_muted'))
      }.width('100%').padding({ left: 20, right: 20, top: 12, bottom: 28 }).alignItems(HorizontalAlign.Start)
    }.width('100%').height('100%')
  }

  @Builder
  private libraryImportTasks() {
    Column({ space: 12 }) {
      Text('导入进度').fontSize(17).fontWeight(FontWeight.Medium).fontColor($r('app.color.yuqu_ink'))
      ForEach(this.account.importJobs, (job: ImportJob) => {
        Column({ space: 9 }) {
          Text(job.title).fontSize(15).lineHeight(23).fontColor($r('app.color.yuqu_ink'))
          Text(this.importStatus(job.status)).fontSize(12)
            .fontColor(job.status === 'failed' ? $r('app.color.yuqu_danger') : $r('app.color.yuqu_muted'))
          if (job.error !== null) {
            Text(job.error).fontSize(13).lineHeight(21).fontColor($r('app.color.yuqu_danger'))
          }
          if (job.status === 'queued' || job.status === 'failed') {
            Row({ space: 8 }) {
              if (job.status === 'failed' && job.attempts < 3) {
                Button('重试导入').height(44).fontSize(13).padding({ left: 14, right: 14 }).borderRadius(12)
                  .backgroundColor($r('app.color.yuqu_accent_soft')).fontColor($r('app.color.yuqu_accent_ink'))
                  .enabled(!this.account.libraryBusy)
                  .onClick(() => { void AccountSync.getInstance().retryImport(job.id); })
              }
              if (job.status === 'queued' || job.status === 'failed') {
                Button('移除任务').id(`library-remove-import-${job.id}`).height(44).fontSize(13)
                  .padding({ left: 14, right: 14 }).borderRadius(12).backgroundColor($r('app.color.yuqu_surface'))
                  .fontColor($r('app.color.yuqu_muted')).enabled(!this.account.libraryBusy)
                  .onClick(() => { this.confirmImportRemoval(job); })
              }
            }.width('100%')
          }
        }.width('100%').padding(14).alignItems(HorizontalAlign.Start)
          .backgroundColor($r('app.color.yuqu_subtle')).borderRadius(14)
      }, (job: ImportJob) => `${job.id}:${job.status}:${job.title}:${job.attempts}:${job.error ?? ''}:${this.account.libraryBusy}`)
    }.width('100%').alignItems(HorizontalAlign.Start)
  }

  @Builder
  private summaryPoint(nodeId: string, point: SummaryPoint, pointIndex: number) {
    Column({ space: 5 }) {
      Button(`${this.summaryPointExpanded(nodeId, pointIndex) ? '收起依据' : '查看依据'} · ${point.evidenceCount} 条`).quietAction().fontSize(12).width('100%')
        .onClick(() => { void AccountSync.getInstance().toggleSummaryPoint(nodeId, pointIndex); })
      Text(point.text).fontSize(14).width('100%')
      if (this.summaryPointExpanded(nodeId, pointIndex) && this.account.summaryEvidenceBusy) Text('正在读取冻结依据…').fontSize(12).fontColor($r('app.color.yuqu_muted'))
      if (this.summaryPointExpanded(nodeId, pointIndex) && this.account.summaryEvidenceError.length > 0) Text(this.account.summaryEvidenceError).fontSize(12).fontColor($r('app.color.yuqu_danger'))
      if (this.summaryPointExpanded(nodeId, pointIndex) && this.account.summaryEvidence !== null) {
        ForEach(this.account.summaryEvidence.segments, (segment: TranscriptSegment) => {
          Column({ space: 4 }) {
            Text(`${this.formatTime(segment.startMs)}–${this.formatTime(segment.endMs)}`).fontSize(12).fontColor($r('app.color.yuqu_muted'))
            Text(segment.text).fontSize(13).width('100%')
            Button(segment.endMs > segment.startMs ? '回听依据' : '无可播放时长').quietAction().fontSize(12)
              .enabled(segment.endMs > segment.startMs && this.account.summaryEvidence?.audioAvailable === true && !this.account.readingArchived)
              .onClick(() => { if (this.account.summaryEvidence !== null) this.playSummaryEvidence(this.account.summaryEvidence, segment); })
          }.padding(8).width('100%').backgroundColor($r('app.color.yuqu_subtle')).borderRadius(6).alignItems(HorizontalAlign.Start)
        }, (segment: TranscriptSegment) => `${segment.id}:${segment.startMs}:${segment.endMs}`)
      }
    }.width('100%').alignItems(HorizontalAlign.Start)
  }

  @Builder
  private summaryTopics(overview: SummaryTopicOverview) {
    Column({ space: 8 }) {
      Text('整期总结').fontSize(15).fontWeight(FontWeight.Medium)
      Text(overview.title).fontSize(14).width('100%')
      Text('按主题阅读全部要点，展开依据可查看冻结原文。').fontSize(12).fontColor($r('app.color.yuqu_muted'))
      ForEach(overview.topics, (topic: SummaryTopic) => {
        Button(`${this.account.summaryTopicIndex === topic.index ? '收起' : '展开'} · ${topic.title} · ${topic.pointCount} 条要点`).quietAction()
          .fontSize(13).width('100%').height('auto').padding(10)
          .onClick(() => { this.openSummaryTopic(topic.index); })
      }, (topic: SummaryTopic) => `${overview.id}:${topic.index}`)
      if (this.account.summaryTopicIndex >= 0) {
        Column({ space: 8 }) {
          Text(overview.topics[this.account.summaryTopicIndex]?.title ?? '').fontSize(14).fontWeight(FontWeight.Medium).width('100%')
          if (this.account.summaryTopicBusy) Text('正在读取主题要点…').fontSize(12).fontColor($r('app.color.yuqu_muted'))
          if (this.account.summaryTopicError.length > 0) {
            Text(this.account.summaryTopicError).fontSize(12).fontColor($r('app.color.yuqu_danger'))
            Button('重试读取主题').quietAction().fontSize(12).onClick(() => { this.retrySummaryTopic(); })
            if (this.account.summaryTopicCanPrevious) {
              Button('上一页要点').quietAction().fontSize(12).onClick(() => { this.turnSummaryTopic(false); })
            }
          }
          if (this.account.summaryTopicPage !== null) {
            ForEach(this.account.summaryTopicPage.points, (point: SummaryTopicPoint) => {
              Column({ space: 4 }) {
                Text(`${this.formatTime(point.startMs)}–${this.formatTime(point.endMs)}`).fontSize(12).fontColor($r('app.color.yuqu_muted'))
                this.summaryPoint(point.nodeId, point, point.pointIndex)
              }.width('100%').alignItems(HorizontalAlign.Start)
            }, (point: SummaryTopicPoint) => `${point.nodeId}:${point.pointIndex}`)
            Text(`${this.account.summaryTopicPage.after + 1}–${this.account.summaryTopicPage.after + this.account.summaryTopicPage.points.length} / ${this.account.summaryTopicPage.totalPoints} 条要点`).fontSize(12)
            Row({ space: 8 }) {
              Button('上一页要点').quietAction().fontSize(12).layoutWeight(1).enabled(!this.account.summaryTopicBusy && this.account.summaryTopicCanPrevious)
                .onClick(() => { this.turnSummaryTopic(false); })
              Button('下一页要点').quietAction().fontSize(12).layoutWeight(1).enabled(!this.account.summaryTopicBusy && this.account.summaryTopicPage?.nextAfter !== null)
                .onClick(() => { this.turnSummaryTopic(true); })
            }.width('100%')
          }
        }.width('100%').alignItems(HorizontalAlign.Start).onAreaChange((_old: Area, area: Area) => { this.alignSummaryTopic(area); })
      }
    }.width('100%').padding(10).backgroundColor($r('app.color.yuqu_subtle')).borderRadius(8).alignItems(HorizontalAlign.Start)
  }

  @Builder
  private summaryOverview(result: SummaryResult) {
    Column({ space: 6 }) {
      Text('整期概览').fontSize(15).fontWeight(FontWeight.Medium)
      Text(result.title).fontSize(14)
      ForEach(result.points, (point: SummaryPoint, pointIndex: number) => {
        this.summaryPoint(result.id, point, pointIndex)
      }, (point: SummaryPoint, pointIndex: number) => `${this.summaryResultNode(result)}:${pointIndex}:${point.text}`)
    }.width('100%').padding(10).backgroundColor($r('app.color.yuqu_subtle')).borderRadius(8).alignItems(HorizontalAlign.Start)
  }

  @Builder
  private summaryPart(part: SummaryPart) {
    Column({ space: 6 }) {
      Text(`第 ${part.index + 1} 段 · ${part.title}`).fontSize(15).fontWeight(FontWeight.Medium).width('100%')
      Text(`${this.formatTime(part.startMs)}–${this.formatTime(part.endMs)}`).fontSize(12).fontColor($r('app.color.yuqu_muted'))
      ForEach(part.points, (point: SummaryPoint, pointIndex: number) => {
        this.summaryPoint(part.id, point, pointIndex)
      }, (point: SummaryPoint, pointIndex: number) => `${this.summaryResultNode(part)}:${pointIndex}:${point.text}`)
    }.width('100%').padding(10).backgroundColor($r('app.color.yuqu_subtle')).borderRadius(8).alignItems(HorizontalAlign.Start)
  }

  @Builder
  private savedNoteEditor() {
    Column({ space: 8 }) {
      Text(`正在编辑备注 · ${this.editingSavedTitle}`).fontSize(14).fontColor($r('app.color.yuqu_ink'))
      TextArea({ text: this.noteDraft, placeholder: '写下自己的备注' }).height(90).maxLength(4000).enabled(!this.account.savedBusy)
        .onChange((value: string) => { this.noteDraft = value; })
      Row({ space: 8 }) {
        Button('保存备注').quietAction().fontSize(12).enabled(!this.account.savedBusy)
          .onClick(() => { void this.commitNote(this.editingSaved); })
        Button('取消').quietAction().fontSize(12).enabled(!this.account.savedBusy).onClick(() => { this.cancelNote(); })
      }
    }.padding(12).width('100%').backgroundColor($r('app.color.yuqu_subtle')).borderRadius(10)
  }
}

@Extend(Button) function quietAction() {
  .fontSize(14)
  .fontColor($r('app.color.yuqu_ink'))
  .backgroundColor($r('app.color.yuqu_subtle'))
  .constraintSize({ minHeight: 40 })
  .padding({ left: 12, right: 12 })
  .borderRadius(12)
}

@Extend(Button) function playerAction(weight: number) {
  .layoutWeight(weight)
  .padding({ left: 4, right: 4 })
  .constraintSize({ minHeight: 44 })
  .labelStyle({ maxLines: 1, minFontSize: 12, maxFontSize: 14 })
}
