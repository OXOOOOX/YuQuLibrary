import type { TranscriptSnapshot } from './knowledge.ts';

export interface Chapter {
  id: string; title: string; startMs: number; endMs: number;
  startSegmentId: string; endSegmentId: string;
}
export interface ChapterDocument {
  id: string; snapshot: TranscriptSnapshot;
  status: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
  completedBatches: number; totalBatches: number; createdAt: string;
}
export interface ChaptersPage {
  mediaVersionId: string; audioAvailable: boolean; canGenerate: boolean; bridgeOnline: boolean;
  document: ChapterDocument | null; chapters: Chapter[]; nextAfter: number | null;
}
