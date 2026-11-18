import type { Pool } from 'pg';
import type { AccountSession } from '@yuqu/contracts';
import { requireSession } from './auth.ts';
import { transaction } from './database.ts';
import { AppError } from './errors.ts';
import { uuid } from './validation.ts';
import { resetRemovedPlayback } from './playback.ts';
import { enqueueCleanup, MAX_IMPORT_BYTES, readStorageUsage, type StorageUsage } from './storage-limits.ts';

export type { StorageUsage } from './storage-limits.ts';
export async function getStorageUsage(pool: Pool, profile: AccountSession): Promise<StorageUsage> {
  return transaction(pool, async db => { await requireSession(db, profile); return readStorageUsage(db, profile.user.id); });
}
export async function removeLibraryMedia(pool: Pool, profile: AccountSession, mediaId: string, mode: 'audio' | 'all') {
  if (mode !== 'audio' && mode !== 'all') throw new AppError(400, 'REMOVE_MODE_INVALID', '请选择清理音频或删除整期资料。');
  if (mediaId === 'fixture-pcm-v1') throw new AppError(403, 'MEDIA_NOT_DELETABLE', '公共播放样本不能删除。');
  uuid(mediaId);
  return transaction(pool, async db => {
    await requireSession(db, profile);
    await db.query('SELECT id FROM yuqu.users WHERE id=$1 FOR NO KEY UPDATE', [profile.user.id]);
    // Match takeOver/report's snapshot-before-media order.
    await db.query('SELECT user_id FROM yuqu.playback_snapshots WHERE user_id=$1 FOR UPDATE', [profile.user.id]);
    const media = (await db.query('SELECT * FROM yuqu.media_versions WHERE id=$1 AND owner_user_id=$2 FOR UPDATE', [mediaId,profile.user.id])).rows[0];
    if (!media) throw new AppError(404, 'MEDIA_NOT_FOUND', '资料不存在或已删除。');
    const transcript = (await db.query('SELECT * FROM yuqu.transcript_jobs WHERE media_version_id=$1 FOR UPDATE', [mediaId])).rows[0];
    if (mode === 'audio' && (!transcript || transcript.status !== 'ready' || transcript.completed_ms !== media.duration_ms)) {
      throw new AppError(409, 'TRANSCRIPT_NOT_READY', '整期转写尚未完成，请等待完成后清理音频，或选择删除整期资料。');
    }
    if (media.audio_available && media.storage_key) {
      await enqueueCleanup(db, profile.user.id, media.storage_key, Number(media.byte_size));
    }
    await resetRemovedPlayback(db, profile.user.id, mediaId);
    if (mode === 'audio') {
      await db.query('UPDATE yuqu.media_versions SET audio_available=false,storage_key=NULL,byte_size=0 WHERE id=$1', [mediaId]);
      // A completed lease is only an idempotency receipt; retiring it also blocks old ASR reads.
      await db.query('UPDATE yuqu.transcript_jobs SET lease_id=NULL,lease_until=NULL WHERE media_version_id=$1', [mediaId]);
    } else {
      await db.query('DELETE FROM yuqu.saved_items WHERE media_version_id=$1 AND user_id=$2', [mediaId,profile.user.id]);
      await db.query('DELETE FROM yuqu.chat_turns WHERE media_version_id=$1', [mediaId]);
      await db.query('DELETE FROM yuqu.chat_conversations WHERE media_version_id=$1', [mediaId]);
      if (transcript) await db.query('DELETE FROM yuqu.transcript_chunks WHERE job_id=$1', [transcript.id]);
      await db.query('DELETE FROM yuqu.transcript_jobs WHERE media_version_id=$1', [mediaId]);
      await db.query('DELETE FROM yuqu.playback_history WHERE media_version_id=$1', [mediaId]);
      await db.query('DELETE FROM yuqu.import_jobs WHERE media_version_id=$1 AND user_id=$2', [mediaId,profile.user.id]);
      await db.query('DELETE FROM yuqu.media_versions WHERE id=$1', [mediaId]);
    }
    return { removed: true, mode };
  });
}
export async function removeImport(pool: Pool, profile: AccountSession, importId: string) {
  uuid(importId);
  return transaction(pool, async db => {
    await requireSession(db, profile);
    await db.query('SELECT id FROM yuqu.users WHERE id=$1 FOR NO KEY UPDATE', [profile.user.id]);
    const item = (await db.query('SELECT * FROM yuqu.import_jobs WHERE id=$1 AND user_id=$2 FOR UPDATE', [importId,profile.user.id])).rows[0];
    if (!item) throw new AppError(404, 'IMPORT_NOT_FOUND', '导入任务不存在或已删除。');
    if (item.status === 'downloading') throw new AppError(409, 'IMPORT_DOWNLOADING', '正在下载，请等待任务完成或失败后再删除。');
    if (item.media_version_id || item.status === 'ready') throw new AppError(409, 'IMPORT_HAS_MEDIA', '音频已就绪，请在资料列表选择清理音频或删除整期资料。');
    if (item.lease_id) await enqueueCleanup(db, profile.user.id, `${item.id}-${item.lease_id}.media`, MAX_IMPORT_BYTES, true, 360);
    await db.query('DELETE FROM yuqu.import_jobs WHERE id=$1', [importId]);
    await db.query("UPDATE yuqu.import_jobs SET available_at=now() WHERE user_id=$1 AND status='queued' AND available_at>now()", [profile.user.id]);
    return { removed: true };
  });
}
