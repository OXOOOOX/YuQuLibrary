import type { ChatCitation, TranscriptSegment } from './playback.ts';

export interface TranscriptSnapshot { transcriptJobId: string; throughMs: number }
export interface TranscriptSelectionSource extends TranscriptSnapshot {
  kind: 'transcript-selection'; segmentIds: string[];
}
export interface TranscriptSearchHit extends TranscriptSegment { highlights: { start: number; end: number }[] }
export interface TranscriptSearchPage {
  mediaVersionId: string; query: string; snapshot: TranscriptSnapshot;
  results: TranscriptSearchHit[]; nextCursor: string | null; partial: boolean;
}
export interface AnswerSavedSource { kind: 'answer'; turnId: string }
export type SavedItemSource = TranscriptSelectionSource | AnswerSavedSource;
export interface SavedContent {
  text: string; question?: string; segments: TranscriptSegment[]; citations: ChatCitation[];
}
export interface SavedItem {
  id: string; mediaVersionId: string; mediaTitle: string; kind: 'excerpt' | 'answer';
  source: SavedItemSource; content: SavedContent; note: string; audioAvailable: boolean;
  createdAt: string; updatedAt: string;
}
export interface SavedItemsPage { items: SavedItem[]; nextCursor: string | null }
