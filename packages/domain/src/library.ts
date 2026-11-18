import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AccountSession, ImportJob, LibraryItem } from '@yuqu/contracts';
import { requireSession } from './auth.ts';
import { transaction } from './database.ts';
import { object, uuid, invalid } from './validation.ts';
import { AppError } from './errors.ts';
import { openRemote, parseFeed, sourceUrl } from './remote.ts';
import { isBilibiliUrl, isBilibiliShortUrl, parseBilibiliUrl, previewBilibili, resolveBilibiliSource } from './bilibili.ts';
import { assertStorageCapacity, enqueueCleanup, MAX_IMPORT_BYTES, readStorageUsage, STORAGE_KEY } from './storage-limits.ts';

type Row = Record<string, any>;
const job = (row: Row): ImportJob => ({ id: row.id, title: row.title, sourceUrl: row.source_url, status: row.status,
  attempts: row.attempts, error: row.error, mediaVersionId: row.media_version_id, createdAt: row.created_at.toISOString() });
export async function listLibrary(pool: Pool, profile: AccountSession): Promise<LibraryItem[]> {
  return transaction(pool, async db => {
    await requireSession(db, profile);
    const { rows } = await db.query(`SELECT m.*,t.status AS transcript_status,t.completed_ms AS transcript_completed_ms
      FROM yuqu.media_versions m LEFT JOIN yuqu.transcript_jobs t ON t.media_version_id=m.id AND t.user_id=$1
      WHERE m.owner_user_id=$1 OR m.id='fixture-pcm-v1' ORDER BY m.created_at DESC LIMIT 101`, [profile.user.id]);
    return rows.map(row => ({ mediaVersionId: row.id, contentId: row.content_id, title: row.title, durationMs: row.duration_ms,
      createdAt: row.created_at.toISOString(), byteSize: Number(row.byte_size ?? 0), audioAvailable: row.audio_available,
      deletable: row.owner_user_id === profile.user.id,
      transcript: row.transcript_status ? { status: row.transcript_status, completedMs: row.transcript_completed_ms, durationMs: row.duration_ms } : null }));
  });
}
export async function listImports(pool: Pool, profile: AccountSession): Promise<ImportJob[]> {
  return transaction(pool, async db => {
    await requireSession(db, profile);
    return (await db.query('SELECT * FROM yuqu.import_jobs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [profile.user.id])).rows.map(job);
  });
}
export async function createImport(pool: Pool, profile: AccountSession, input: unknown,
  options: { signal?: AbortSignal; resolveSource?: typeof resolveBilibiliSource } = {}): Promise<ImportJob> {
  const value = object(input), suppliedUrl = normalizeImportUrl(value.url);
  let url = suppliedUrl;
  if (isBilibiliShortUrl(suppliedUrl)) {
    // Authenticate and rate-limit before outbound work, without holding a database lock during the network request.
    await reservePreview(pool, profile);
    const source = await (options.resolveSource ?? resolveBilibiliSource)(suppliedUrl, options.signal ?? AbortSignal.timeout(20_000));
    url = parseBilibiliUrl(source.url).url;
  } else if (isBilibiliUrl(suppliedUrl)) url = parseBilibiliUrl(suppliedUrl).url;
  const title = typeof value.title === 'string' ? value.title.trim().slice(0, 300) : '';
  const sourceHash = createHash('sha256').update(url).digest('hex');
  return transaction(pool, async db => {
    await requireSession(db, profile);
    await db.query('SELECT id FROM yuqu.users WHERE id=$1 FOR NO KEY UPDATE', [profile.user.id]);
    const previous = (await db.query('SELECT * FROM yuqu.import_jobs WHERE user_id=$1 AND source_hash=$2', [profile.user.id, sourceHash])).rows[0];
    if (previous) return job(previous);
    const counts = (await db.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE status IN ('queued','downloading'))::int AS pending FROM yuqu.import_jobs WHERE user_id=$1", [profile.user.id])).rows[0];
    if (counts.total >= 50 || counts.pending >= 5) throw new AppError(429, 'IMPORT_LIMIT', '当前最多保留 50 项导入、同时等待 5 项，请稍后再试。');
    await assertStorageCapacity(db, profile.user.id);
    const result = await db.query('INSERT INTO yuqu.import_jobs(id,user_id,source_url,source_hash,title) VALUES($1,$2,$3,$4,$5) RETURNING *', [randomUUID(), profile.user.id, url, sourceHash, title || decodeTitle(url)]);
    return job(result.rows[0]);
  });
}
function decodeTitle(url: string): string {
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || '导入音频').slice(0, 300); } catch { return '导入音频'; }
}
export async function retryImport(pool: Pool, profile: AccountSession, id: string): Promise<ImportJob> {
  uuid(id);
  return transaction(pool, async db => {
    await requireSession(db, profile);
    await db.query('SELECT id FROM yuqu.users WHERE id=$1 FOR NO KEY UPDATE', [profile.user.id]);
    const row = (await db.query('SELECT * FROM yuqu.import_jobs WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, profile.user.id])).rows[0];
    if (!row) throw new AppError(404, 'IMPORT_NOT_FOUND', '导入任务不存在。');
    if (row.status !== 'failed') return job(row);
    const pending = (await db.query("SELECT count(*)::int AS count FROM yuqu.import_jobs WHERE user_id=$1 AND status IN ('queued','downloading')", [profile.user.id])).rows[0].count;
    if (row.attempts >= 3 || pending >= 5) throw new AppError(429, 'IMPORT_LIMIT', '已达到重试或等待任务上限。');
    if (row.lease_id) await enqueueCleanup(db, profile.user.id, `${row.id}-${row.lease_id}.media`, MAX_IMPORT_BYTES, true, 360);
    await assertStorageCapacity(db, profile.user.id);
    return job((await db.query("UPDATE yuqu.import_jobs SET status='queued',error=NULL,lease_id=NULL,lease_until=NULL,available_at=now(),updated_at=now() WHERE id=$1 RETURNING *", [id])).rows[0]);
  });
}
export async function reservePreview(pool: Pool, profile: AccountSession): Promise<void> {
  await transaction(pool, async db => {
    await requireSession(db, profile);
    const result = await db.query("UPDATE yuqu.users SET last_feed_preview_at=now() WHERE id=$1 AND (last_feed_preview_at IS NULL OR last_feed_preview_at<now()-interval '5 seconds')", [profile.user.id]);
    if (!result.rowCount) throw new AppError(429, 'PREVIEW_LIMIT', '请等待 5 秒再解析节目。', undefined, 5);
  });
}

export interface ImportPreview { kind: 'audio' | 'rss' | 'bilibili'; title: string; episodes: { title: string; url: string }[] }
export function normalizeImportUrl(value: unknown): string {
  const candidate = typeof value === 'string' && /^BV[0-9A-Za-z]{10}$/.test(value.trim()) ? `https://www.bilibili.com/video/${value.trim()}` : value;
  return sourceUrl(candidate).href;
}
/** Every HTTP request goes through the same public-address checks and fixed-IP connector as ingestion. */
export async function previewImportSource(input: unknown, signal: AbortSignal, open: typeof openRemote = openRemote): Promise<ImportPreview> {
  const url = normalizeImportUrl(input);
  if (isBilibiliUrl(url)) return { kind: 'bilibili', ...await previewBilibili(url, signal) };
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(20000)]), response = await open(url, bounded);
  try {
    const contentType = String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const path = new URL(response.sourceUrl).pathname;
    const audio = contentType.startsWith('audio/') || contentType === 'application/ogg' || contentType === 'video/mp4' ||
      ((!contentType || contentType === 'application/octet-stream') && /\.(?:mp3|m4a|aac|wav|flac|ogg|opus|mp4)$/i.test(path));
    if (audio) {
      const title = decodeTitle(response.sourceUrl);
      // Keep the original URL for existing import deduplication; ingestion revalidates every redirect.
      return { kind: 'audio', title, episodes: [{ title, url }] };
    }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new AppError(400, 'IMPORT_SOURCE_INVALID', '节目源超过 2 MB，请使用音频直链或有效 RSS。');
      chunks.push(Buffer.from(chunk));
    }
    return { kind: 'rss', ...parseFeed(Buffer.concat(chunks).toString('utf8'), response.sourceUrl) };
  } finally { response.destroy(); }
}
export async function authorizedMedia(db: PoolClient, profile: AccountSession, id: string, requireAudio = false) {
  const row = (await db.query("SELECT * FROM yuqu.media_versions WHERE id=$1 AND (owner_user_id=$2 OR id='fixture-pcm-v1')", [id, profile.user.id])).rows[0];
  if (!row) throw new AppError(404, 'MEDIA_NOT_FOUND', '音频不存在或尚未就绪。');
  if (requireAudio && !row.audio_available) throw new AppError(409, 'MEDIA_AUDIO_REMOVED', '音频已清理，仍可查看文稿和聊天。');
  return row;
}
export async function mediaFile(pool: Pool, profile: AccountSession, id: string) {
  return transaction(pool, async db => { await requireSession(db, profile); return authorizedMedia(db, profile, id, true); });
}

export interface ClaimedImport { id: string; userId: string; sourceUrl: string; title: string; leaseId: string }
export async function claimImport(pool: Pool): Promise<ClaimedImport | null> {
  // Never lock a task before its owner: completion, retry and removal use the same order.
  // A full account must not prevent another account's queued work from starting.
  const candidates = (await pool.query(`SELECT * FROM (
    SELECT DISTINCT ON (user_id) id,user_id,created_at FROM yuqu.import_jobs
    WHERE (status='queued' AND available_at<=now()) OR (status='downloading' AND lease_until<now())
    ORDER BY user_id,created_at) candidates ORDER BY created_at LIMIT 20`)).rows;
  for (const candidate of candidates) {
    const claimed = await transaction(pool, async db => {
      if (!(await db.query('SELECT id FROM yuqu.users WHERE id=$1 FOR NO KEY UPDATE SKIP LOCKED', [candidate.user_id])).rowCount) return null;
      const row = (await db.query("SELECT * FROM yuqu.import_jobs WHERE id=$1 AND ((status='queued' AND available_at<=now()) OR (status='downloading' AND lease_until<now())) FOR UPDATE SKIP LOCKED", [candidate.id])).rows[0];
      if (!row) return null;
      if (row.status === 'downloading' && row.lease_id) {
        await enqueueCleanup(db, row.user_id, `${row.id}-${row.lease_id}.media`, MAX_IMPORT_BYTES, true, 360);
        await db.query("UPDATE yuqu.import_jobs SET status='queued',lease_id=NULL,lease_until=NULL,updated_at=now() WHERE id=$1", [row.id]);
      }
      if (row.attempts >= 3) {
        await db.query("UPDATE yuqu.import_jobs SET status='failed',error='任务多次中断，已停止重试。',lease_id=NULL,lease_until=NULL,updated_at=now() WHERE id=$1", [row.id]);
        return null;
      }
      const usage = await readStorageUsage(db, row.user_id);
      if (usage.usedBytes + usage.reservedBytes + usage.reclaimingBytes > usage.limitBytes) {
        await db.query("UPDATE yuqu.import_jobs SET error='容量不足，等待空间回收后继续下载。',available_at=now()+interval '30 seconds',updated_at=now() WHERE user_id=$1 AND status='queued'", [row.user_id]);
        return null;
      }
      const leaseId = randomUUID();
      await db.query("UPDATE yuqu.import_jobs SET status='downloading',attempts=attempts+1,lease_id=$2,lease_until=now()+interval '90 seconds',error=NULL,updated_at=now() WHERE id=$1", [row.id, leaseId]);
      return { id: row.id, userId: row.user_id, title: row.title, sourceUrl: row.source_url, leaseId };
    });
    if (claimed) return claimed;
  }
  return null;
}
export async function renewImport(pool: Pool, item: ClaimedImport): Promise<boolean> {
  return !!(await pool.query("UPDATE yuqu.import_jobs SET lease_until=now()+interval '90 seconds',updated_at=now() WHERE id=$1 AND lease_id=$2 AND status='downloading' AND lease_until>now()", [item.id, item.leaseId])).rowCount;
}
export interface ImportedFile { storageKey: string; mimeType: string; byteSize: number; sha256: string; durationMs: number;
  source?: { kind: 'bilibili'; url: string; title: string; bvid: string; cid: number; page: number } }
export async function completeImport(pool: Pool, item: ClaimedImport, file: ImportedFile): Promise<boolean> {
  return transaction(pool, async db => {
    await db.query('SELECT id FROM yuqu.users WHERE id=$1 FOR NO KEY UPDATE', [item.userId]);
    const row = (await db.query("SELECT id FROM yuqu.import_jobs WHERE id=$1 AND lease_id=$2 AND status='downloading' AND lease_until>now() FOR UPDATE", [item.id, item.leaseId])).rows[0];
    if (!row) return false;
    if (!Number.isSafeInteger(file.byteSize) || file.byteSize <= 0 || file.byteSize > MAX_IMPORT_BYTES || !STORAGE_KEY.test(file.storageKey)) {
      throw new AppError(400, 'IMPORT_FILE_INVALID', '音频文件大小或存储标识无效。');
    }
    const mediaId = randomUUID(), contentId = randomUUID();
    const title = file.source?.title ?? item.title;
    await db.query('INSERT INTO yuqu.media_versions(id,content_id,title,duration_ms,owner_user_id,storage_key,mime_type,byte_size,sha256,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [mediaId, contentId, title, file.durationMs, item.userId, file.storageKey, file.mimeType, file.byteSize, file.sha256, JSON.stringify(file.source ?? { kind: 'audio', url: item.sourceUrl })]);
    await db.query('INSERT INTO yuqu.transcript_jobs(id,media_version_id,user_id) VALUES($1,$2,$3)', [randomUUID(), mediaId, item.userId]);
    await db.query("UPDATE yuqu.import_jobs SET status='ready',media_version_id=$2,title=$3,lease_id=NULL,lease_until=NULL,updated_at=now() WHERE id=$1", [item.id, mediaId, title]);
    await db.query("UPDATE yuqu.import_jobs SET available_at=now() WHERE user_id=$1 AND status='queued' AND available_at>now()", [item.userId]);
    return true;
  });
}
export async function failImport(pool: Pool, item: ClaimedImport, message: string): Promise<void> {
  await transaction(pool, async db => {
    await db.query('SELECT id FROM yuqu.users WHERE id=$1 FOR NO KEY UPDATE', [item.userId]);
    const result = await db.query("UPDATE yuqu.import_jobs SET status='failed',error=$3,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_id=$2 AND status='downloading' AND lease_until>now()", [item.id,item.leaseId,message.slice(0,300)]);
    if (result.rowCount) await enqueueCleanup(db, item.userId, `${item.id}-${item.leaseId}.media`, MAX_IMPORT_BYTES, true, 360);
  });
}
