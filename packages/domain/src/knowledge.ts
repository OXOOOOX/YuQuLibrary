import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import type { AccountSession, ChatCitation, TranscriptSegment } from '@yuqu/contracts';
import type { SavedContent, SavedItem, SavedItemSource, SavedItemsPage, TranscriptSearchHit, TranscriptSearchPage, TranscriptSelectionSource, TranscriptSnapshot } from '../../contracts/src/knowledge.ts';
import { requireSession } from './auth.ts';
import { transaction } from './database.ts';
import { authorizedMedia } from './library.ts';
import { AppError } from './errors.ts';
import { integer, invalid, object, uuid } from './validation.ts';
import { projectSentences, type SentenceChunk } from './transcript-sentences.ts';

type Row = Record<string, any>;
type SnapshotChunk = SentenceChunk & { start_ms: number; end_ms: number };
const MAX_POSITION = 14_400_000;

function selectionSource(input: unknown): TranscriptSelectionSource {
  const value = object(input), transcriptJobId = uuid(value.transcriptJobId), throughMs = integer(value.throughMs, 1, MAX_POSITION);
  if (value.kind !== undefined && value.kind !== 'transcript-selection') throw invalid('请选择文稿片段。');
  const ids = value.segmentIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 32 || ids.some(id => typeof id !== 'string' || id.length > 80) || new Set(ids).size !== ids.length) {
    throw invalid('请选择最多 32 个连续文稿片段。');
  }
  return { kind: 'transcript-selection', transcriptJobId, throughMs, segmentIds: ids as string[] };
}

/** Projects only committed chunks visible at the requested watermark, never future continuations. */
export function projectTranscriptSnapshot(jobId: string, pipeline: string | undefined, chunks: SnapshotChunk[], throughMs: number): TranscriptSegment[] {
  if (chunks.length > 480 || chunks.length === 0 || chunks.at(-1)!.end_ms !== throughMs ||
      chunks.some((chunk, index) => chunk.chunk_index !== index || chunk.start_ms !== (chunks[index - 1]?.end_ms ?? 0) || chunk.end_ms > throughMs)) {
    throw new AppError(409, 'TRANSCRIPT_SNAPSHOT_INVALID', '文稿范围已经无效，请重新打开文稿。');
  }
  if (pipeline === 'yuqu-qwen3-episode-v3') return projectSentences(jobId, chunks).map(({ ownerChunk: _, ...segment }) => segment);
  return chunks.flatMap(chunk => chunk.segments.map((segment, index) => ({ id: `${jobId}:${chunk.chunk_index}:${index}`,
    startMs: segment.startMs, endMs: segment.endMs, text: segment.text })));
}

export async function readSnapshot(db: PoolClient, account: AccountSession, mediaId: string, requested?: TranscriptSnapshot) {
  const media = await authorizedMedia(db, account, mediaId);
  const transcript = (await db.query('SELECT * FROM yuqu.transcript_jobs WHERE media_version_id=$1 AND user_id=$2 FOR SHARE', [mediaId, account.user.id])).rows[0];
  if (!transcript || transcript.completed_ms <= 0) throw new AppError(409, 'TRANSCRIPT_PENDING', '文稿尚未转写完成，请稍后再试。');
  const snapshot = requested ?? { transcriptJobId: transcript.id as string, throughMs: transcript.completed_ms as number };
  if (snapshot.transcriptJobId !== transcript.id || snapshot.throughMs > transcript.completed_ms) {
    throw new AppError(409, 'TRANSCRIPT_SNAPSHOT_INVALID', '文稿范围已经无效，请重新打开文稿。');
  }
  const chunks = (await db.query('SELECT chunk_index,start_ms,end_ms,segments FROM yuqu.transcript_chunks WHERE job_id=$1 AND end_ms<=$2 ORDER BY chunk_index LIMIT 481', [transcript.id, snapshot.throughMs])).rows;
  const segments = projectTranscriptSnapshot(transcript.id, transcript.model_info?.pipeline, chunks, snapshot.throughMs);
  return { media, transcript, snapshot, segments };
}

export async function resolveTranscriptSelection(db: PoolClient, account: AccountSession, mediaId: string, input: unknown) {
  const source = selectionSource(input);
  const context = await readSnapshot(db, account, mediaId, source);
  const first = context.segments.findIndex(segment => segment.id === source.segmentIds[0]);
  const segments = context.segments.slice(first, first + source.segmentIds.length);
  if (first < 0 || segments.length !== source.segmentIds.length || segments.some((segment, index) => segment.id !== source.segmentIds[index])) {
    throw invalid('所选文稿片段不存在或不连续，请重新选择。');
  }
  if (segments.reduce((sum, segment) => sum + segment.text.length, 0) > 32000) throw new AppError(422, 'CONTEXT_TOO_LONG', '所选内容较长，请减少片段。');
  return { segments, transcriptId: context.transcript.id as string, model: context.transcript.model as string | null, source };
}

/** ASCII case folding preserves UTF-16 offsets for exact highlighting, including Chinese text. */
const fold = (value: string) => value.replace(/[A-Z]/g, letter => letter.toLowerCase());
export function searchTranscriptSegments(segments: TranscriptSegment[], query: string): TranscriptSearchHit[] {
  const needle = fold(query);
  if (!needle) return [];
  return segments.flatMap(segment => {
    const haystack = fold(segment.text), highlights: { start: number; end: number }[] = [];
    let offset = 0, hit = haystack.indexOf(needle);
    while (hit !== -1) {
      highlights.push({ start: hit, end: hit + needle.length });
      offset = hit + needle.length;
      hit = haystack.indexOf(needle, offset);
    }
    return highlights.length ? [{ ...segment, highlights }] : [];
  });
}
const encodeCursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function decodeCursor(value: string): Row {
  if (value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid('分页位置无效，请重新查询。');
  try { return object(JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))); }
  catch { throw invalid('分页位置无效，请重新查询。'); }
}
export async function searchTranscript(pool: Pool, account: AccountSession, mediaId: string, inputQuery: string, cursor?: string): Promise<TranscriptSearchPage> {
  const query = inputQuery.trim();
  if (!query || query.length > 100) throw invalid('请输入 1 至 100 个字符的搜索词。');
  let requested: TranscriptSnapshot | undefined, offset = 0;
  if (cursor) {
    const page = decodeCursor(cursor);
    if (page.v !== 1 || page.mediaId !== mediaId || page.query !== query) throw invalid('分页与搜索内容不一致，请重新搜索。');
    requested = { transcriptJobId: uuid(page.transcriptJobId), throughMs: integer(page.throughMs, 1, MAX_POSITION) };
    offset = integer(page.offset, 0, 1_000_000);
  }
  return transaction(pool, async db => {
    await requireSession(db, account);
    const context = await readSnapshot(db, account, mediaId, requested);
    // Only materialize highlights for the returned page; a common one-character query
    // over four hours must not allocate an object for every hit in the whole transcript.
    const needle = fold(query), matches = context.segments.filter(segment => fold(segment.text).includes(needle));
    const results = searchTranscriptSegments(matches.slice(offset, offset + 20), query);
    return { mediaVersionId: mediaId, query, snapshot: context.snapshot, results,
      nextCursor: offset + results.length < matches.length ? encodeCursor({ v: 1, mediaId, query, ...context.snapshot, offset: offset + results.length }) : null,
      partial: context.snapshot.throughMs < context.media.duration_ms };
  });
}

function savedView(row: Row): SavedItem {
  return { id: row.id, mediaVersionId: row.media_version_id, mediaTitle: row.media_title, kind: row.kind,
    source: row.source_snapshot, content: row.content_snapshot, note: row.note, audioAvailable: row.audio_available,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}
function noteValue(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 4000) throw invalid('备注最多 4000 个字符。');
  return value.trim();
}
const savedSelect = `SELECT s.*,m.title AS media_title,m.audio_available,s.created_at::text AS page_time
  FROM yuqu.saved_items s JOIN yuqu.media_versions m ON m.id=s.media_version_id`;

export async function createSavedItem(pool: Pool, account: AccountSession, input: unknown): Promise<SavedItem> {
  const value = object(input), requestId = uuid(value.requestId), mediaId = value.mediaVersionId;
  if (typeof mediaId !== 'string' || mediaId.length > 100) throw invalid('资料标识无效。');
  const rawSource = object(value.source), note = noteValue(value.note);
  let source: SavedItemSource;
  if (rawSource.kind === 'transcript-selection') source = selectionSource(rawSource);
  else if (rawSource.kind === 'answer') source = { kind: 'answer', turnId: uuid(rawSource.turnId) };
  else throw invalid('请选择文稿片段或已完成的回答。');
  const intent = { mediaVersionId: mediaId, source, note };
  return transaction(pool, async db => {
    await requireSession(db, account);
    // Serialize with removeLibraryMedia before reading source records or creating a new reference.
    await db.query('SELECT id FROM yuqu.users WHERE id=$1 FOR NO KEY UPDATE', [account.user.id]);
    const media = await authorizedMedia(db, account, mediaId);
    const previous = (await db.query(`${savedSelect} WHERE s.user_id=$1 AND s.request_id=$2`, [account.user.id, requestId])).rows[0];
    if (previous) {
      if (!isDeepStrictEqual(previous.request_intent, intent)) throw new AppError(409, 'REQUEST_REUSED', '提交标识已用于另一条收藏，请重试。');
      return savedView(previous);
    }
    let content: SavedContent;
    if (source.kind === 'transcript-selection') {
      const selected = await resolveTranscriptSelection(db, account, mediaId, source);
      content = { text: selected.segments.map(segment => segment.text).join('\n'), segments: selected.segments, citations: [] };
    } else {
      const turn = (await db.query('SELECT * FROM yuqu.chat_turns WHERE id=$1 AND user_id=$2 AND media_version_id=$3 FOR SHARE', [source.turnId, account.user.id, mediaId])).rows[0];
      if (!turn) throw new AppError(404, 'CHAT_NOT_FOUND', '回答不存在。');
      if (turn.status !== 'complete') throw new AppError(409, 'ANSWER_NOT_READY', '请等待回答完成后再收藏。');
      content = { text: turn.answer, question: turn.question, segments: [], citations: turn.citations as ChatCitation[] };
    }
    const saved = (await db.query(`INSERT INTO yuqu.saved_items(id,user_id,media_version_id,request_id,request_intent,kind,source_snapshot,content_snapshot,note)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [randomUUID(), account.user.id, mediaId, requestId, JSON.stringify(intent),
      source.kind === 'answer' ? 'answer' : 'excerpt', JSON.stringify(source), JSON.stringify(content), note])).rows[0];
    return savedView({ ...saved, media_title: media.title, audio_available: media.audio_available });
  });
}

export async function listSavedItems(pool: Pool, account: AccountSession, options: { mediaVersionId?: string; cursor?: string; limit?: number } = {}): Promise<SavedItemsPage> {
  const limit = integer(options.limit ?? 20, 1, 50), mediaId = options.mediaVersionId ?? null;
  if (mediaId !== null && (typeof mediaId !== 'string' || !mediaId || mediaId.length > 100)) throw invalid('资料标识无效。');
  let afterAt: string | null = null, afterId: string | null = null;
  if (options.cursor) {
    const cursor = decodeCursor(options.cursor);
    if (cursor.v !== 1 || cursor.mediaId !== mediaId || typeof cursor.at !== 'string' || cursor.at.length > 64 || !Number.isFinite(Date.parse(cursor.at))) throw invalid('收藏分页无效，请重新打开。');
    afterAt = cursor.at; afterId = uuid(cursor.id);
  }
  return transaction(pool, async db => {
    await requireSession(db, account);
    if (mediaId) await authorizedMedia(db, account, mediaId);
    const rows = (await db.query(`${savedSelect} WHERE s.user_id=$1 AND ($2::text IS NULL OR s.media_version_id=$2)
      AND ($3::timestamptz IS NULL OR (s.created_at,s.id)<($3::timestamptz,$4::uuid)) ORDER BY s.created_at DESC,s.id DESC LIMIT $5`,
      [account.user.id, mediaId, afterAt, afterId, limit + 1])).rows;
    const items: SavedItem[] = []; let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      const item = savedView(row), size = Buffer.byteLength(JSON.stringify(item));
      if (items.length && bytes + size > 200000) break;
      items.push(item); bytes += size;
    }
    const last = rows[items.length - 1];
    return { items, nextCursor: rows.length > items.length && last ? encodeCursor({ v: 1, mediaId, at: last.page_time, id: last.id }) : null };
  });
}

export async function updateSavedItem(pool: Pool, account: AccountSession, id: string, input: unknown): Promise<SavedItem> {
  uuid(id); const value = object(input);
  if (typeof value.note !== 'string') throw invalid('请填写备注。');
  const note = noteValue(value.note);
  return transaction(pool, async db => {
    await requireSession(db, account);
    await db.query('SELECT id FROM yuqu.users WHERE id=$1 FOR NO KEY UPDATE', [account.user.id]);
    const updated = await db.query('UPDATE yuqu.saved_items SET note=$3,updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING id', [id, account.user.id, note]);
    if (!updated.rowCount) throw new AppError(404, 'SAVED_ITEM_NOT_FOUND', '收藏不存在或已删除。');
    return savedView((await db.query(`${savedSelect} WHERE s.id=$1 AND s.user_id=$2`, [id, account.user.id])).rows[0]);
  });
}
export async function deleteSavedItem(pool: Pool, account: AccountSession, id: string): Promise<{ removed: boolean }> {
  uuid(id);
  return transaction(pool, async db => {
    await requireSession(db, account);
    await db.query('SELECT id FROM yuqu.users WHERE id=$1 FOR NO KEY UPDATE', [account.user.id]);
    const result = await db.query('DELETE FROM yuqu.saved_items WHERE id=$1 AND user_id=$2', [id, account.user.id]);
    return { removed: Boolean(result.rowCount) };
  });
}
