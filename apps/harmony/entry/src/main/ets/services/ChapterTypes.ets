export interface Chapter {
  id: string; title: string; startMs: number; endMs: number; startSegmentId: string; endSegmentId: string;
}
export interface ChapterSnapshot { transcriptJobId: string; throughMs: number; }
export interface ChapterDocument {
  id: string; snapshot: ChapterSnapshot; status: string; completedBatches: number; totalBatches: number; createdAt: string;
}
export interface ChaptersPage {
  mediaVersionId: string; audioAvailable: boolean; canGenerate: boolean; bridgeOnline: boolean;
  document: ChapterDocument | null; chapters: Chapter[]; nextAfter: number | null;
}
export interface ChapterRequest { action: string; requestId?: string; documentId?: string; }
