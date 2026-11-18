export interface ChatAnchor {
  kind: string;
  positionMs?: number;
  scope?: string;
  capturedAt?: string;
  positionSource?: string;
  transcriptJobId?: string;
  throughMs?: number;
  segmentIds?: string[];
  sourceTurnId?: string;
  citationIds?: string[];
}
export interface KnowledgeSegment { id: string; startMs: number; endMs: number; text: string; }
export interface SearchHighlight { start: number; end: number; }
export interface SearchResult extends KnowledgeSegment { highlights: SearchHighlight[]; }
export interface TranscriptSnapshot { transcriptJobId: string; throughMs: number; }
export interface ChatRetrieval {
  strategy: string;
  status: string;
  snapshot: TranscriptSnapshot;
  totalSegments: number;
  matchedSegments: number;
  selectedSegments: number;
  sourceSegmentIds: string[];
  queryTerms: string[];
}
export interface SearchPage {
  mediaVersionId: string; query: string; snapshot: TranscriptSnapshot;
  results: SearchResult[]; nextCursor: string | null; partial: boolean;
}
export interface SavedSource {
  kind: string; transcriptJobId?: string; throughMs?: number; segmentIds?: string[]; turnId?: string;
}
export interface SavedContent {
  text: string; question?: string; segments: KnowledgeSegment[]; citations: KnowledgeSegment[];
}
export interface SavedItem {
  id: string; mediaVersionId: string; mediaTitle: string; kind: string; source: SavedSource;
  content: SavedContent; note: string; audioAvailable: boolean; createdAt: string; updatedAt: string;
}
export interface SavedPage { items: SavedItem[]; nextCursor: string | null; }
export interface SaveRequest { requestId: string; mediaVersionId: string; source: SavedSource; note?: string; }
export interface NoteRequest { note: string; }
export interface ReplayPoint {
  mediaVersionId: string; positionMs: number; speed: number; looping: boolean; playing: boolean;
  expectedGeneration: number; expectedPlaybackSessionId: string; endMs: number;
}
