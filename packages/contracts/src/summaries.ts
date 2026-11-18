import type { TranscriptSnapshot } from './knowledge.ts';
import type { TranscriptSegment } from './playback.ts';

export interface SummaryPoint { text: string; evidenceCount: number }
export interface SummaryResult {
  id: string; title: string; startMs: number; endMs: number; points: SummaryPoint[];
}
export interface SummaryPart extends SummaryResult { index: number }
export interface SummaryDocument {
  id: string; snapshot: TranscriptSnapshot;
  format?: 'topics-v1';
  status: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
  completedParts: number; totalParts: number; completedTasks: number; totalTasks: number; createdAt: string;
}
export interface SummariesPage {
  mediaVersionId: string; audioAvailable: boolean; canGenerate: boolean; bridgeOnline: boolean;
  document: SummaryDocument | null; overview: SummaryResult | null; parts: SummaryPart[]; nextAfter: number | null;
  topicOverview?: SummaryTopicOverview | null;
}
export interface SummaryTopicOverview { id: string; title: string; topics: Array<{ index: number; title: string; pointCount: number }> }
export interface SummaryTopicPoint { nodeId: string; pointIndex: number; text: string; evidenceCount: number; startMs: number; endMs: number }
export interface SummaryTopicPage {
  mediaVersionId: string; documentId: string; topicIndex: number; title: string; snapshot: TranscriptSnapshot;
  points: SummaryTopicPoint[]; after: number; nextAfter: number | null; totalPoints: number;
}
export interface SummaryEvidence {
  mediaVersionId: string; documentId: string; nodeId: string; pointIndex: number;
  snapshot: TranscriptSnapshot; audioAvailable: boolean; segments: TranscriptSegment[];
}
