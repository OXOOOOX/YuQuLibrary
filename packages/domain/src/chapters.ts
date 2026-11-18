import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import type { AccountSession, ChapterDocument, ChaptersPage, TranscriptSegment } from '@yuqu/contracts';
import { requireSession } from './auth.ts';
import { transaction } from './database.ts';
import { authorizedMedia } from './library.ts';
import { readSnapshot } from './knowledge.ts';
import { chapterBatches, mergeChapters, resolveChapters, type ResolvedChapters } from './chapter-segments.ts';
import { AppError } from './errors.ts';
import { integer, invalid, object, uuid } from './validation.ts';
import type { BridgeAccount } from './chat.ts';

type Row = Record<string, any>;
export const CHAPTER_TASK_TYPE = 'yuqu.transcript.chapters.v1';
function documentView(row: Row, batches: Row[]): ChapterDocument {
  const status = batches.some(batch => batch.status === 'failed') ? 'failed'
    : batches.some(batch => batch.status === 'cancelled') ? 'cancelled'
    : batches.every(batch => batch.status === 'complete') ? 'complete'
    : batches.some(batch => batch.status === 'running') ? 'running' : 'queued';
  return { id: row.id, snapshot: { transcriptJobId: row.transcript_id, throughMs: row.through_ms }, status,
    completedBatches: batches.filter(batch => batch.status === 'complete').length, totalBatches: batches.length,
    createdAt: row.created_at.toISOString() };
}
async function pageFor(db: PoolClient, account: AccountSession, mediaId: string, documentId?: string, after = 0): Promise<ChaptersPage> {
  const media = await authorizedMedia(db, account, mediaId);
  const source = (await db.query('SELECT id,status,completed_ms FROM yuqu.transcript_jobs WHERE media_version_id=$1 AND user_id=$2', [mediaId, account.user.id])).rows[0];
  const online = (await db.query("SELECT 1 FROM yuqu.bridge_presence WHERE project_id=$1 AND last_seen>now()-interval '60 seconds' AND task_types ? $2", [process.env.YUQU_BRIDGE_PROJECT_ID || 'yuqu', CHAPTER_TASK_TYPE])).rowCount! > 0;
  const row = (await db.query('SELECT * FROM yuqu.chapter_documents WHERE user_id=$1 AND media_version_id=$2 AND ($3::uuid IS NULL OR id=$3) ORDER BY created_at DESC,id DESC LIMIT 1', [account.user.id, mediaId, documentId ?? null])).rows[0];
  if (documentId && !row) throw new AppError(404, 'CHAPTER_NOT_FOUND', '章节记录不存在。');
  const result: ChaptersPage = { mediaVersionId: mediaId, audioAvailable: media.audio_available, bridgeOnline: online,
    canGenerate: source?.status === 'ready' && source.completed_ms === media.duration_ms && (!row || row.transcript_id !== source.id || row.through_ms !== source.completed_ms),
    document: null, chapters: [], nextAfter: null };
  if (!row) return result;
  // Polling never loads the frozen transcript text; only bounded generated metadata is returned.
  const batches = (await db.query('SELECT status,result FROM yuqu.chapter_batches WHERE document_id=$1 ORDER BY batch_index', [row.id])).rows;
  result.document = documentView(row, batches);
  const completed: ResolvedChapters[] = [];
  for (const batch of batches) { if (batch.status !== 'complete') break; completed.push(batch.result); }
  const chapters = mergeChapters(completed);
  result.chapters = chapters.slice(after, after + 40);
  result.nextAfter = after + result.chapters.length < chapters.length ? after + result.chapters.length : null;
  return result;
}
export async function chaptersPage(pool: Pool, account: AccountSession, mediaId: string, documentId?: string, after = 0): Promise<ChaptersPage> {
  if (documentId) uuid(documentId);
  integer(after, 0, 4096);
  if (after && !documentId) throw invalid('继续查看章节时需要原章节记录。');
  return transaction(pool, async db => { await requireSession(db, account); return pageFor(db, account, mediaId, documentId, after); });
}

export async function generateChapters(pool: Pool, account: AccountSession, mediaId: string, input: unknown): Promise<ChaptersPage> {
  const requestId = uuid(object(input).requestId);
  return transaction(pool, async db => {
    await requireSession(db, account);
    await db.query('SELECT id FROM yuqu.users WHERE id=$1 FOR NO KEY UPDATE', [account.user.id]);
    await authorizedMedia(db, account, mediaId);
    const existing = (await db.query('SELECT * FROM yuqu.chapter_documents WHERE user_id=$1 AND request_id=$2', [account.user.id, requestId])).rows[0];
    if (existing) {
      if (existing.media_version_id !== mediaId) throw new AppError(409, 'REQUEST_REUSED', '这次提交标识已用于其他资料。');
      return pageFor(db, account, mediaId, existing.id);
    }
    const context = await readSnapshot(db, account, mediaId);
    if (context.transcript.status !== 'ready' || context.snapshot.throughMs !== context.media.duration_ms) {
      throw new AppError(409, 'TRANSCRIPT_PENDING', '章节需要整期文稿完成后再生成，当前可继续阅读已转写内容。');
    }
    const previous = (await db.query('SELECT id FROM yuqu.chapter_documents WHERE user_id=$1 AND transcript_id=$2 AND through_ms=$3 AND strategy=$4',
      [account.user.id, context.transcript.id, context.snapshot.throughMs, 'semantic-chapters-v1'])).rows[0];
    if (previous) return pageFor(db, account, mediaId, previous.id);
    const active = (await db.query(`SELECT count(*)::int AS n FROM yuqu.chapter_documents d WHERE user_id=$1
      AND EXISTS(SELECT 1 FROM yuqu.chapter_batches b WHERE b.document_id=d.id AND b.status IN ('queued','running'))`, [account.user.id])).rows[0].n;
    if (active >= 2) throw new AppError(429, 'CHAPTER_LIMIT', '已有两期章节等待生成，请等待完成或先停止其中一期。');
    const batches = chapterBatches(context.segments), id = randomUUID();
    await db.query('INSERT INTO yuqu.chapter_documents(id,user_id,media_version_id,transcript_id,request_id,through_ms) VALUES($1,$2,$3,$4,$5,$6)',
      [id, account.user.id, mediaId, context.transcript.id, requestId, context.snapshot.throughMs]);
    for (let index = 0; index < batches.length; index++) {
      await db.query('INSERT INTO yuqu.chapter_batches(id,document_id,batch_index,source_segments) VALUES($1,$2,$3,$4)', [randomUUID(), id, index, JSON.stringify(batches[index])]);
    }
    return pageFor(db, account, mediaId, id);
  });
}
export async function changeChapters(pool: Pool, account: AccountSession, mediaId: string, id: string, action: 'retry' | 'cancel'): Promise<ChaptersPage> {
  uuid(id);
  return transaction(pool, async db => {
    await requireSession(db, account);
    await db.query('SELECT id FROM yuqu.users WHERE id=$1 FOR NO KEY UPDATE', [account.user.id]);
    await authorizedMedia(db, account, mediaId);
    const row = (await db.query('SELECT * FROM yuqu.chapter_documents WHERE id=$1 AND user_id=$2 AND media_version_id=$3 FOR UPDATE', [id, account.user.id, mediaId])).rows[0];
    if (!row) throw new AppError(404, 'CHAPTER_NOT_FOUND', '章节记录不存在。');
    if (action === 'cancel') {
      await db.query("UPDATE yuqu.chapter_batches SET status='cancelled',lease_id=NULL,lease_until=NULL,updated_at=now() WHERE document_id=$1 AND status IN ('queued','running','failed')", [id]);
    } else {
      const active = (await db.query(`SELECT count(*)::int AS n FROM yuqu.chapter_documents d WHERE user_id=$1 AND id<>$2
        AND EXISTS(SELECT 1 FROM yuqu.chapter_batches b WHERE b.document_id=d.id AND b.status IN ('queued','running'))`, [account.user.id, id])).rows[0].n;
      if (active >= 2) throw new AppError(429, 'CHAPTER_LIMIT', '已有两期章节等待生成，请稍后重试。');
      // Completed batches and their original input/results are never regenerated by retry.
      await db.query("UPDATE yuqu.chapter_batches SET status='queued',attempts=0,agent_id=NULL,lease_id=NULL,lease_until=NULL,updated_at=now() WHERE document_id=$1 AND status IN ('failed','cancelled')", [id]);
    }
    return pageFor(db, account, mediaId, id);
  });
}

export async function isChapterTask(pool: Pool, id: string): Promise<boolean> {
  return (await pool.query('SELECT 1 FROM yuqu.chapter_batches WHERE id=$1', [uuid(id)])).rowCount! > 0;
}
export async function claimChapters(pool: Pool, agent: BridgeAccount): Promise<Record<string, unknown> | null> {
  return transaction(pool, async db => {
    await db.query("UPDATE yuqu.chapter_batches SET status='failed',lease_id=NULL,lease_until=NULL,updated_at=now() WHERE status='running' AND lease_until<now() AND attempts>=3");
    const row = (await db.query(`SELECT b.* FROM yuqu.chapter_batches b JOIN yuqu.chapter_documents d ON d.id=b.document_id
      WHERE (b.status='queued' OR (b.status='running' AND b.lease_until<now())) AND b.attempts<3
      AND NOT EXISTS(SELECT 1 FROM yuqu.chapter_batches prior WHERE prior.document_id=b.document_id AND prior.batch_index<b.batch_index AND prior.status<>'complete')
      ORDER BY d.created_at,b.batch_index FOR UPDATE OF b SKIP LOCKED LIMIT 1`)).rows[0];
    if (!row) return null;
    const doc = (await db.query(`SELECT d.*,m.title,m.duration_ms,(SELECT count(*)::int FROM yuqu.chapter_batches b WHERE b.document_id=d.id) AS batch_count
      FROM yuqu.chapter_documents d JOIN yuqu.media_versions m ON m.id=d.media_version_id WHERE d.id=$1`, [row.document_id])).rows[0];
    let previous: { title: string; tail: string } | null = null;
    if (row.batch_index) {
      const prior = (await db.query('SELECT result FROM yuqu.chapter_batches WHERE document_id=$1 AND batch_index<$2 ORDER BY batch_index', [row.document_id, row.batch_index])).rows;
      const tail = (await db.query('SELECT source_segments FROM yuqu.chapter_batches WHERE document_id=$1 AND batch_index=$2', [row.document_id, row.batch_index - 1])).rows[0];
      previous = { title: mergeChapters(prior.map(batch => batch.result)).at(-1)!.title,
        tail: (tail.source_segments as TranscriptSegment[]).slice(-3).map(segment => segment.text).join('\n').slice(-2400) };
    }
    const leaseId = randomUUID();
    const leased = (await db.query("UPDATE yuqu.chapter_batches SET status='running',attempts=attempts+1,agent_id=$2,lease_id=$3,lease_until=now()+interval '120 seconds',updated_at=now() WHERE id=$1 RETURNING *", [row.id, agent.agentId, leaseId])).rows[0];
    const segments = (row.source_segments as TranscriptSegment[]).map(({ startMs, endMs, text }, index) => ({ id: `S${index + 1}`, startMs, endMs, text }));
    return { protocolVersion: '1.0', projectId: agent.projectId, jobId: row.id, taskType: CHAPTER_TASK_TYPE, attempt: leased.attempts,
      lease: { id: leaseId, expiresAt: leased.lease_until.toISOString() }, artifacts: [], payload: {
        title: doc.title, durationMs: doc.duration_ms, transcriptId: doc.transcript_id, throughMs: doc.through_ms,
        batchIndex: row.batch_index, batchCount: doc.batch_count, segments, previous
      } };
  });
}
async function activeBatch(db: PoolClient, agent: BridgeAccount, id: string, leaseId: string): Promise<Row> {
  const row = (await db.query("SELECT * FROM yuqu.chapter_batches WHERE id=$1 AND agent_id=$2 AND lease_id=$3 AND status='running' AND lease_until>now() FOR UPDATE", [uuid(id), agent.agentId, uuid(leaseId)])).rows[0];
  if (!row) throw new AppError(409, 'LEASE_LOST', '章节任务已结束或租约已失效。');
  return row;
}
export async function heartbeatChapters(pool: Pool, agent: BridgeAccount, id: string, leaseId: string) {
  return transaction(pool, async db => {
    await activeBatch(db, agent, id, leaseId);
    const row = (await db.query("UPDATE yuqu.chapter_batches SET lease_until=now()+interval '120 seconds' WHERE id=$1 RETURNING lease_until", [id])).rows[0];
    return { expiresAt: row.lease_until.toISOString(), cancelled: false };
  });
}
export async function finishChapters(pool: Pool, agent: BridgeAccount, id: string, input: unknown): Promise<void> {
  const value = object(input), leaseId = uuid(value.leaseId), result = object(value.result);
  await transaction(pool, async db => {
    const previous = (await db.query('SELECT * FROM yuqu.chapter_batches WHERE id=$1 FOR UPDATE', [uuid(id)])).rows[0];
    if (previous?.status === 'complete' && previous.agent_id === agent.agentId && previous.lease_id === leaseId && isDeepStrictEqual(previous.result_input, result)) return;
    const row = await activeBatch(db, agent, id, leaseId);
    const resolved = resolveChapters(result, row.source_segments, id, row.batch_index > 0);
    await db.query("UPDATE yuqu.chapter_batches SET status='complete',result=$2,result_input=$3,lease_until=NULL,updated_at=now() WHERE id=$1", [id, JSON.stringify(resolved), JSON.stringify(result)]);
  });
}
export async function failChapters(pool: Pool, agent: BridgeAccount, id: string, leaseId: string): Promise<void> {
  await transaction(pool, async db => {
    await activeBatch(db, agent, id, leaseId);
    await db.query("UPDATE yuqu.chapter_batches SET status='failed',lease_id=NULL,lease_until=NULL,updated_at=now() WHERE id=$1", [id]);
  });
}
