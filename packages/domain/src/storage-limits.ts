import type { PoolClient } from 'pg';
import { AppError } from './errors.ts';

export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
export const IMPORT_ITEM_LIMIT = 50;
export interface StorageUsage {
  usedBytes: number; reservedBytes: number; reclaimingBytes: number;
  limitBytes: number; itemCount: number; itemLimit: number;
}
export const STORAGE_KEY = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.media$/;
export function storageLimitBytes(): number {
  const raw = process.env.YUQU_USER_STORAGE_LIMIT_BYTES;
  const value = raw === undefined ? 1024 * 1024 * 1024 : /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value <= 0) throw new AppError(503, 'STORAGE_CONFIG_INVALID', '容量配置暂时不可用。');
  return value;
}
export async function readStorageUsage(db: PoolClient, userId: string): Promise<StorageUsage> {
  const row = (await db.query(`SELECT
    (SELECT COALESCE(sum(byte_size),0) FROM yuqu.media_versions WHERE owner_user_id=$1 AND audio_available) AS used,
    (SELECT count(*) FROM yuqu.import_jobs WHERE user_id=$1 AND status IN ('queued','downloading')) AS pending,
    (SELECT COALESCE(sum(byte_size),0) FROM yuqu.media_cleanup_jobs WHERE user_id=$1) AS reclaiming,
    (SELECT count(*) FROM yuqu.import_jobs WHERE user_id=$1) AS items`, [userId])).rows[0];
  return { usedBytes: Number(row.used), reservedBytes: Number(row.pending) * MAX_IMPORT_BYTES,
    reclaimingBytes: Number(row.reclaiming), limitBytes: storageLimitBytes(), itemCount: Number(row.items), itemLimit: IMPORT_ITEM_LIMIT };
}
/** Caller holds the account row lock; queueing and retrying share this reservation check. */
export async function assertStorageCapacity(db: PoolClient, userId: string): Promise<void> {
  const usage = await readStorageUsage(db, userId);
  if (usage.usedBytes + usage.reservedBytes + usage.reclaimingBytes + MAX_IMPORT_BYTES > usage.limitBytes) {
    throw new AppError(409, 'STORAGE_LIMIT', '容量不足以预留下一集音频，请先清理音频并等待空间回收。');
  }
}
export async function enqueueCleanup(db: PoolClient, userId: string, storageKey: string, byteSize: number,
  includePartial = false, delaySeconds = 30): Promise<void> {
  if (!STORAGE_KEY.test(storageKey) || !Number.isSafeInteger(byteSize) || byteSize < 0 || byteSize > MAX_IMPORT_BYTES) {
    throw new AppError(503, 'STORAGE_RECORD_INVALID', '音频存储记录无效，未执行删除。');
  }
  const result = await db.query(`INSERT INTO yuqu.media_cleanup_jobs(storage_key,user_id,byte_size,include_partial,available_at)
    VALUES($1,$2,$3,$4,now()+$5*interval '1 second') ON CONFLICT(storage_key) DO UPDATE
    SET byte_size=GREATEST(yuqu.media_cleanup_jobs.byte_size,excluded.byte_size),
      include_partial=yuqu.media_cleanup_jobs.include_partial OR excluded.include_partial
    WHERE yuqu.media_cleanup_jobs.user_id=excluded.user_id`, [storageKey,userId,byteSize,includePartial,delaySeconds]);
  if (!result.rowCount) throw new AppError(409, 'STORAGE_RECORD_CONFLICT', '音频存储记录冲突，未执行删除。');
}
