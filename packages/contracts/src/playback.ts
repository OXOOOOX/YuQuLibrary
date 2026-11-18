export type PlaybackState = 'idle' | 'ready' | 'playing' | 'paused' | 'buffering' | 'ended' | 'error';

/** All playback positions and durations are milliseconds on the same media version. */
export interface PlaybackSnapshot {
  contentId: string;
  mediaVersionId: string;
  positionMs: number;
  durationMs: number;
  speed: number;
  state: PlaybackState;
}

export interface AccountSession {
  user: { id: string; email: string };
  session: { id: string; deviceName: string; client: 'web' | 'harmony'; expiresAt: string };
}

export interface SyncedPlayback extends PlaybackSnapshot {
  title?: string;
  revision: number;
  generation: number;
  sequence: number;
  ownerSessionId: string | null;
  playbackSessionId: string | null;
  looping: boolean;
  updatedAt: string;
}

export interface LibraryItem {
  mediaVersionId: string;
  contentId: string;
  title: string;
  durationMs: number;
  createdAt: string;
  byteSize: number;
  audioAvailable: boolean;
  deletable: boolean;
  transcript?: { status: TranscriptJob['status']; completedMs: number; durationMs: number } | null;
}
export interface StorageUsage {
  usedBytes: number; reservedBytes: number; reclaimingBytes: number; limitBytes: number;
  itemCount: number; itemLimit: number;
}
export interface ImportJob {
  id: string;
  title: string;
  sourceUrl: string;
  status: 'queued' | 'downloading' | 'ready' | 'failed';
  attempts: number;
  error: string | null;
  mediaVersionId: string | null;
  createdAt: string;
}

export interface PlaybackReport {
  generation: number;
  playbackSessionId: string;
  sequence: number;
  contentId: string;
  mediaVersionId: string;
  positionMs: number;
  speed: number;
  state: 'playing' | 'paused' | 'buffering' | 'ended';
  looping: boolean;
}

export interface TranscriptSegment { id: string; startMs: number; endMs: number; text: string }
export interface TranscriptJob {
  id: string; status: 'queued' | 'processing' | 'ready' | 'failed'; attempts: number;
  durationMs: number; completedMs: number; model: string | null; error: string | null; updatedAt: string;
}
export interface TranscriptPage {
  mediaVersionId: string; job: TranscriptJob | null; segments: TranscriptSegment[];
  pageCursor: number; nextCursor: number | null;
}
export interface ChatCitation { id: string; startMs: number; endMs: number; text: string }
export type PositionScope = 'near' | 'until' | 'all';
export type ChatScope = PositionScope | 'selection' | 'retrieval';
export type ChatAnchor =
  | { kind: 'position'; positionMs: number; scope: PositionScope; capturedAt: string; positionSource: 'local' | 'synced' }
  | { kind: 'transcript-selection'; transcriptJobId: string; throughMs: number; segmentIds: string[] }
  | { kind: 'citation-selection'; sourceTurnId: string; citationIds: string[] }
  | { kind: 'retrieval' };
export interface ChatRetrieval {
  strategy: 'lexical-v1'; status: 'matched' | 'no-evidence';
  snapshot: { transcriptJobId: string; throughMs: number };
  totalSegments: number; matchedSegments: number; selectedSegments: number;
  sourceSegmentIds: string[]; queryTerms: string[];
}
export interface ChatCheck { available: true; positionMs: number; scope: ChatScope; segmentCount: number; characterCount: number }
export interface ChatTurn {
  id: string; sequence: number; question: string; answer: string;
  status: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
  positionMs: number; scope: ChatScope; createdAt: string; error: string | null; citations: ChatCitation[];
  parentTurnId?: string | null; topicRootTurnId?: string; anchor?: ChatAnchor | null; retrieval?: ChatRetrieval | null;
}
export interface ChatPage {
  mediaVersionId: string; conversationId: string | null; turns: ChatTurn[]; nextBefore: number | null; bridgeOnline: boolean; audioAvailable: boolean; retrievalOnline?: boolean;
}

export interface PlaybackResult {
  snapshot: SyncedPlayback;
  accepted: boolean;
}

/** Development transport probe only; it is not a multi-user synchronization protocol. */
export interface ProbeEvent {
  version: 1;
  sequence: number;
  serverTime: string;
  message: string;
}

export const PLAYBACK_FIXTURE = {
  id: 'yuqu-playback-check-v1',
  title: '两分钟播放验证音频',
  durationMs: 120_000,
  sampleRate: 16_000,
} as const;

export type * from './knowledge.ts';
export type * from './chapters.ts';
export type * from './summaries.ts';
