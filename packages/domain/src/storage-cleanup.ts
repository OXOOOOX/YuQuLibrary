import { lstat, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { Pool } from 'pg';
import { transaction } from './database.ts';
import { AppError } from './errors.ts';
import { STORAGE_KEY } from './storage-limits.ts';

/** Deletes only generated file names directly inside the configured media directory. */
export async function removeStorageFiles(directory: string, storageKey: string, includePartial = false): Promise<void> {
  if (!isAbsolute(directory) || !STORAGE_KEY.test(storageKey)) throw new AppError(503, 'CLEANUP_PATH_INVALID', '音频清理路径无效。');
  const base = await realpath(directory);
  if (!(await lstat(base)).isDirectory()) throw new AppError(503, 'CLEANUP_PATH_INVALID', '音频清理目录无效。');
  for (const name of includePartial ? [storageKey, `${storageKey}.part`] : [storageKey]) {
    const path = join(base, name);
    if (dirname(path) !== base) throw new AppError(503, 'CLEANUP_PATH_INVALID', '音频清理路径无效。');
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path) {
        throw new AppError(503, 'CLEANUP_PATH_INVALID', '音频清理目标不是普通文件。');
      }
      await unlink(path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

/** One short account/queue lock spans the reference check and unlink. A crash after
 * unlink leaves the queue charged; its next attempt confirms ENOENT and commits. */
export async function cleanupOne(pool: Pool, directory: string): Promise<boolean> {
  const candidate = (await pool.query('SELECT storage_key,user_id FROM yuqu.media_cleanup_jobs WHERE available_at<=now() ORDER BY available_at,created_at LIMIT 1')).rows[0];
  if (!candidate) return false;
  return transaction(pool, async db => {
    await db.query('SELECT id FROM yuqu.users WHERE id=$1 FOR NO KEY UPDATE', [candidate.user_id]);
    const item = (await db.query('SELECT * FROM yuqu.media_cleanup_jobs WHERE storage_key=$1 AND available_at<=now() FOR UPDATE SKIP LOCKED', [candidate.storage_key])).rows[0];
    if (!item) return false;
    try {
      if ((await db.query('SELECT 1 FROM yuqu.media_versions WHERE storage_key=$1 LIMIT 1', [item.storage_key])).rowCount) {
        throw new AppError(409, 'CLEANUP_STILL_REFERENCED', '音频仍被资料引用。');
      }
      // Old failed-attempt files are delayed beyond the five-minute download deadline.
      await removeStorageFiles(directory, item.storage_key, item.include_partial);
      await db.query("UPDATE yuqu.import_jobs SET lease_id=NULL WHERE user_id=$1 AND status='failed' AND id::text || '-' || lease_id::text || '.media'=$2", [item.user_id,item.storage_key]);
      await db.query('DELETE FROM yuqu.media_cleanup_jobs WHERE storage_key=$1', [item.storage_key]);
      await db.query("UPDATE yuqu.import_jobs SET available_at=now() WHERE user_id=$1 AND status='queued' AND available_at>now()", [item.user_id]);
    } catch (error) {
      const raw = (error as NodeJS.ErrnoException).code ?? 'CLEANUP_FAILED';
      const code = /^[A-Z0-9_]{1,80}$/.test(raw) ? raw : 'CLEANUP_FAILED';
      const delay = Math.min(3600, 30 * 2 ** Math.min(item.attempts, 7));
      await db.query("UPDATE yuqu.media_cleanup_jobs SET attempts=attempts+1,error_code=$2,available_at=now()+$3*interval '1 second' WHERE storage_key=$1", [item.storage_key,code,delay]);
    }
    return true;
  });
}
