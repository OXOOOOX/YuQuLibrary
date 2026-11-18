import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import type { AccountSession, TranscriptJob, TranscriptPage, TranscriptSegment } from '@yuqu/contracts';
import { requireSession } from './auth.ts';
import { transaction } from './database.ts';
import { authorizedMedia } from './library.ts';
import { AppError } from './errors.ts';
import { uuid } from './validation.ts';
import { sentencePage, type StoredSegment } from './transcript-sentences.ts';

export const TRANSCRIPT_CHUNK_MS = 30000;
type Row = Record<string, any>;
function jobView(row: Row, durationMs: number): TranscriptJob {
  return { id: row.id, status: row.status, attempts: row.attempts, durationMs,
    completedMs: row.completed_ms, model: row.model, error: row.error, updatedAt: row.updated_at.toISOString() };
}
export async function transcriptPage(pool: Pool, account: AccountSession, mediaId: string, cursor = -1, atMs?: number): Promise<TranscriptPage> {
  if (!Number.isInteger(cursor) || cursor < -1 || cursor >= 480) throw new AppError(400, 'INVALID_CURSOR', '文稿页码无效。');
  if (atMs !== undefined && (!Number.isSafeInteger(atMs) || atMs < 0 || atMs > 14400000)) throw new AppError(400, 'INVALID_POSITION', '文稿位置无效。');
  return transaction(pool, async db => {
    await requireSession(db, account);
    const media = await authorizedMedia(db, account, mediaId);
    const row = (await db.query('SELECT * FROM yuqu.transcript_jobs WHERE media_version_id=$1 AND user_id=$2 FOR SHARE', [mediaId, account.user.id])).rows[0];
    if (!row) return { mediaVersionId: mediaId, job: null, segments: [], pageCursor: cursor, nextCursor: null };
    if (row.model_info?.pipeline === 'yuqu-qwen3-episode-v3') {
      // At most 480 immutable chunks. Read one consistent snapshot so even a
      // sentence spanning a page boundary keeps a single ID and page owner.
      const chunks = (await db.query('SELECT chunk_index,segments FROM yuqu.transcript_chunks WHERE job_id=$1 ORDER BY chunk_index LIMIT 481', [row.id])).rows;
      if (chunks.length > 480) throw new Error('Transcript chunk limit exceeded');
      return { mediaVersionId: mediaId, job: jobView(row, media.duration_ms), ...sentencePage(row.id, chunks, cursor, atMs) };
    }
    if (atMs !== undefined) cursor = Math.max(-1, Math.min(478, Math.floor(atMs / TRANSCRIPT_CHUNK_MS) - 1));
    const chunks = (await db.query('SELECT * FROM yuqu.transcript_chunks WHERE job_id=$1 AND chunk_index>$2 ORDER BY chunk_index LIMIT 6', [row.id, cursor])).rows;
    const selected = chunks.slice(0, 5);
    const segments: TranscriptSegment[] = selected.flatMap(chunk => chunk.segments.map((segment: Omit<TranscriptSegment, 'id'>, index: number) =>
      ({ ...segment, id: `${row.id}:${chunk.chunk_index}:${index}` })));
    return { mediaVersionId: mediaId, job: jobView(row, media.duration_ms), segments, pageCursor: cursor,
      nextCursor: chunks.length > 5 ? selected[selected.length - 1].chunk_index : null };
  });
}
export async function retryTranscript(pool: Pool, account: AccountSession, mediaId: string): Promise<void> {
  await transaction(pool, async db => {
    await requireSession(db, account);
    await authorizedMedia(db, account, mediaId, true);
    const row = (await db.query('SELECT * FROM yuqu.transcript_jobs WHERE media_version_id=$1 AND user_id=$2 FOR UPDATE', [mediaId, account.user.id])).rows[0];
    if (!row) throw new AppError(404, 'TRANSCRIPT_NOT_FOUND', '该音频没有转写任务。');
    if (row.status !== 'failed') return;
    if (Date.now() - row.updated_at.getTime() < 30000) throw new AppError(429, 'TRANSCRIPT_RETRY_WAIT', '请等待 30 秒再重试。', undefined, 30);
    await db.query("UPDATE yuqu.transcript_jobs SET status='queued',attempts=0,lease_id=NULL,lease_until=NULL,available_at=now(),error=NULL,updated_at=now() WHERE id=$1", [row.id]);
  });
}
export interface ClaimedTranscript {
  id: string; userId: string; mediaVersionId: string; storageKey: string; sha256: string;
  durationMs: number; completedMs: number; model: string | null; leaseId: string; attempts: number;
  byteSize: number;
  pipeline?: 'semantic-v3';
}
const pipelineFor = (row: Row): { pipeline?: 'semantic-v3' } => row.model === null || row.model_info?.pipeline === 'yuqu-qwen3-episode-v3'
  ? { pipeline: 'semantic-v3' } : {};
export async function claimTranscript(pool: Pool): Promise<ClaimedTranscript | null> {
  return transaction(pool, async db => {
    await db.query("UPDATE yuqu.transcript_jobs SET status='failed',error='转写多次中断，可稍后重试。',lease_id=NULL,lease_until=NULL,updated_at=now() WHERE status='processing' AND lease_until<now() AND attempts>=3");
    const row = (await db.query(`SELECT j.*,m.storage_key,m.sha256,m.duration_ms,m.byte_size FROM yuqu.transcript_jobs j
      JOIN yuqu.media_versions m ON m.id=j.media_version_id AND m.owner_user_id=j.user_id AND m.audio_available
      WHERE ((j.status='queued' AND j.available_at<=now()) OR (j.status='processing' AND j.lease_until<now())) AND j.attempts<3
      ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1`)).rows[0];
    if (!row) return null;
    const leaseId = randomUUID();
    await db.query("UPDATE yuqu.transcript_jobs SET status='processing',attempts=attempts+1,lease_id=$2,lease_until=now()+interval '90 seconds',error=NULL,updated_at=now() WHERE id=$1", [row.id, leaseId]);
    return { id: row.id, userId: row.user_id, mediaVersionId: row.media_version_id, storageKey: row.storage_key,
      sha256: row.sha256, byteSize: Number(row.byte_size), durationMs: row.duration_ms, completedMs: row.completed_ms, model: row.model, leaseId, attempts: row.attempts + 1, ...pipelineFor(row) };
  });
}
export async function renewTranscript(pool: Pool, task: ClaimedTranscript): Promise<boolean> {
  return !!(await pool.query("UPDATE yuqu.transcript_jobs SET lease_until=now()+interval '90 seconds' WHERE id=$1 AND lease_id=$2 AND status='processing' AND lease_until>now()", [task.id, task.leaseId])).rowCount;
}
export interface TranscriptChunk {
  index: number; startMs: number; endMs: number;
  segments: StoredSegment[];
  language: string; model: { id: string; revision: string; [key: string]: unknown };
}
export function validateTranscriptChunk(value: unknown, durationMs: number): TranscriptChunk {
  const chunk = value as TranscriptChunk | null;
  if (!chunk || !Number.isInteger(chunk.index) || chunk.index < 0 || chunk.index >= 480 ||
      chunk.startMs !== chunk.index * TRANSCRIPT_CHUNK_MS || chunk.endMs !== Math.min(chunk.startMs + TRANSCRIPT_CHUNK_MS, durationMs) || chunk.endMs <= chunk.startMs ||
      !Array.isArray(chunk.segments) || chunk.segments.length > 100 || typeof chunk.language !== 'string' || chunk.language.length > 80 ||
      typeof chunk.model?.id !== 'string' || chunk.model.id.length > 120 || !/^sha256:[a-f0-9]{64}$/.test(chunk.model.revision) ||
      Buffer.byteLength(JSON.stringify(chunk)) > 30000) throw new Error('Invalid transcription chunk');
  let end = Math.max(0, chunk.startMs - 5000);
  for (const [index, segment] of chunk.segments.entries()) {
    if (!Number.isInteger(segment.startMs) || !Number.isInteger(segment.endMs) || segment.startMs < end ||
        segment.endMs < segment.startMs || segment.endMs > Math.min(durationMs, chunk.endMs + 5000) || typeof segment.text !== 'string' ||
        !segment.text.trim() || segment.text.length > 2000 ||
        (segment.continuesPrevious !== undefined && (typeof segment.continuesPrevious !== 'boolean' || index !== 0 ||
          chunk.index === 0 || chunk.model.pipeline !== 'yuqu-qwen3-episode-v3')) ||
        (segment.joinWithSpace !== undefined && (typeof segment.joinWithSpace !== 'boolean' || segment.continuesPrevious !== true))) throw new Error('Invalid transcription segment');
    end = segment.endMs;
  }
  return chunk;
}
export async function saveTranscriptChunk(pool: Pool, task: ClaimedTranscript, input: unknown): Promise<boolean> {
  const chunk = validateTranscriptChunk(input, task.durationMs);
  const identity = `${chunk.model.id}@${chunk.model.revision}`;
  return transaction(pool, async db => {
    const row = (await db.query("SELECT * FROM yuqu.transcript_jobs WHERE id=$1 AND lease_id=$2 AND status='processing' AND lease_until>now() FOR UPDATE", [task.id, task.leaseId])).rows[0];
    if (!row) return false;
    if (row.model !== null && row.model !== identity) throw new AppError(409, 'MODEL_CONFLICT', 'Transcription model changed during resume');
    // A committed chunk may be replayed after its HTTP acknowledgement was lost.
    // Never overwrite it, and check the current live lease before acknowledging it.
    if (row.completed_ms > chunk.startMs) {
      const previous = (await db.query('SELECT * FROM yuqu.transcript_chunks WHERE job_id=$1 AND chunk_index=$2', [task.id, chunk.index])).rows[0];
      if (previous && previous.start_ms === chunk.startMs && previous.end_ms === chunk.endMs && previous.language === chunk.language &&
        isDeepStrictEqual(previous.segments, chunk.segments) && isDeepStrictEqual(row.model_info, chunk.model)) return true;
      throw new AppError(409, 'CHUNK_CONFLICT', '已保存的文稿片段与重试内容不同。');
    }
    if (row.completed_ms !== chunk.startMs) throw new AppError(409, 'CHUNK_CONFLICT', 'Non-contiguous transcript publication');
    await db.query('INSERT INTO yuqu.transcript_chunks(job_id,chunk_index,start_ms,end_ms,segments,language) VALUES($1,$2,$3,$4,$5,$6)',
      [task.id, chunk.index, chunk.startMs, chunk.endMs, JSON.stringify(chunk.segments), chunk.language]);
    await db.query('UPDATE yuqu.transcript_jobs SET completed_ms=$2,model=$3,model_info=$4,updated_at=now() WHERE id=$1',
      [task.id, chunk.endMs, identity, JSON.stringify(chunk.model)]);
    return true;
  });
}
export async function completeTranscript(pool: Pool, task: ClaimedTranscript): Promise<boolean> {
  // Retain the final lease ID as an idempotency receipt; it cannot renew or read media.
  return !!(await pool.query(`UPDATE yuqu.transcript_jobs SET status='ready',lease_until=NULL,error=NULL,updated_at=now()
    WHERE id=$1 AND lease_id=$2 AND completed_ms=$3 AND
      ((status='processing' AND lease_until>now()) OR status='ready')`, [task.id, task.leaseId, task.durationMs])).rowCount;
}
export async function failTranscript(pool: Pool, task: ClaimedTranscript): Promise<boolean> {
  return !!(await pool.query(`UPDATE yuqu.transcript_jobs SET status=CASE WHEN attempts<3 THEN 'queued' ELSE 'failed' END,
    error=CASE WHEN attempts<3 THEN '转写中断，已保存完成片段；正在等待重试。' ELSE '转写未完成，已保存可用文稿；请检查转写服务后重试。' END,
    lease_id=NULL,lease_until=NULL,available_at=now()+interval '30 seconds',updated_at=now()
    WHERE id=$1 AND lease_id=$2 AND status='processing' AND lease_until>now()`, [task.id, task.leaseId])).rowCount;
}

/** Worker requests supply only identifiers. All authoritative media fields come from the database. */
export async function leasedTranscript(pool: Pool, id: unknown, leaseId: unknown, allowComplete = false): Promise<ClaimedTranscript> {
  const jobId = uuid(id), lease = uuid(leaseId);
  const row = (await pool.query(`SELECT j.*,m.storage_key,m.sha256,m.duration_ms,m.byte_size
    FROM yuqu.transcript_jobs j JOIN yuqu.media_versions m ON m.id=j.media_version_id AND m.owner_user_id=j.user_id AND m.audio_available
    WHERE j.id=$1 AND j.lease_id=$2 AND ((j.status='processing' AND j.lease_until>now()) OR ($3 AND j.status='ready'))`,
  [jobId, lease, allowComplete])).rows[0];
  if (!row) throw new AppError(409, 'LEASE_LOST', '转写任务已失效，请重新领取。');
  return { id: row.id, userId: row.user_id, mediaVersionId: row.media_version_id, storageKey: row.storage_key,
    sha256: row.sha256, byteSize: Number(row.byte_size), durationMs: row.duration_ms, completedMs: row.completed_ms,
    model: row.model, leaseId: row.lease_id, attempts: row.attempts, ...pipelineFor(row) };
}

export function remoteTranscriptTask(task: ClaimedTranscript) {
  const { id, leaseId, sha256, byteSize, durationMs, completedMs, model, attempts } = task;
  return { id, leaseId, sha256, byteSize, durationMs, completedMs, model, attempts, ...(task.pipeline ? { pipeline: task.pipeline } : {}) };
}
