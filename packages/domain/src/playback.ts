import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AccountSession, PlaybackReport, PlaybackResult, SyncedPlayback } from '@yuqu/contracts';
import { requireSession } from './auth.ts';
import { transaction } from './database.ts';
import { AppError } from './errors.ts';
import { integer, invalid, object, uuid } from './validation.ts';
import { authorizedMedia } from './library.ts';

type Row = Record<string, unknown>;
function snapshot(row: Row): SyncedPlayback {
  return {
    contentId: row.content_id as string, mediaVersionId: row.media_version_id as string, title: row.title as string,
    durationMs: row.duration_ms as number, positionMs: row.position_ms as number,
    speed: row.speed as number, state: row.state as SyncedPlayback['state'],
    revision: row.revision as number, generation: row.generation as number, sequence: row.sequence as number,
    ownerSessionId: row.owner_session_id as string | null, playbackSessionId: row.playback_session_id as string | null,
    looping: row.looping as boolean, updatedAt: (row.updated_at as Date).toISOString()
  };
}
async function readSnapshot(db: PoolClient, userId: string, lock = false): Promise<SyncedPlayback> {
  const { rows } = await db.query(`SELECT p.*,m.duration_ms,m.title FROM yuqu.playback_snapshots p
    JOIN yuqu.media_versions m ON m.id=p.media_version_id WHERE p.user_id=$1${lock ? ' FOR UPDATE OF p' : ''}`, [userId]);
  if (!rows[0]) throw new AppError(404, 'PLAYBACK_NOT_FOUND', '播放状态尚未建立，请重新登录。');
  return snapshot(rows[0]);
}
async function publish(db: PoolClient, userId: string): Promise<SyncedPlayback> {
  const current = await readSnapshot(db, userId);
  await db.query('INSERT INTO yuqu.user_events(user_id,revision,payload) VALUES($1,$2,$3)', [userId, current.revision, JSON.stringify(current)]);
  await db.query('DELETE FROM yuqu.user_events WHERE user_id=$1 AND revision <= $2', [userId, current.revision - 1000]);
  return current;
}
function conflict(current: SyncedPlayback): AppError {
  return new AppError(409, 'PLAYBACK_CONFLICT', '播放已由其他会话接管，请刷新状态后重试。', current);
}

export async function getPlayback(pool: Pool, profile: AccountSession): Promise<SyncedPlayback> {
  return transaction(pool, async db => {
    await requireSession(db, profile);
    return readSnapshot(db, profile.user.id);
  });
}

export async function takeOver(pool: Pool, profile: AccountSession, input: unknown): Promise<PlaybackResult> {
  const value = object(input);
  const requestId = uuid(value.requestId);
  const expectedGeneration = integer(value.expectedGeneration);
  const targetId = value.mediaVersionId === undefined ? null : mediaIdentity(value.mediaVersionId);
  const targetPosition = value.positionMs === undefined ? null : integer(value.positionMs);
  if (targetPosition !== null && targetId === null) throw invalid('回听需要指定对应音频。');
  const intent = value.intent ?? 'takeover';
  if (intent !== 'takeover' && intent !== 'restore') throw invalid('播放操作无效。');
  const expectedPlaybackSessionId = intent === 'restore' ? uuid(value.expectedPlaybackSessionId) : null;
  const targetSpeed = intent === 'restore' ? value.speed : null;
  const targetLooping = intent === 'restore' ? value.looping : null;
  if (intent === 'restore' && (targetId === null || targetPosition === null || typeof targetSpeed !== 'number' ||
      ![1, 1.25, 1.5, 2].includes(targetSpeed) || typeof targetLooping !== 'boolean')) throw invalid('返回位置与播放设置不完整。');
  if (intent !== 'restore' && (value.expectedPlaybackSessionId !== undefined || value.speed !== undefined || value.looping !== undefined)) throw invalid('恢复设置只适用于返回原位置。');
  return transaction(pool, async db => {
    await requireSession(db, profile);
    // Serialize with media removal before claiming a position in that media.
    await db.query('SELECT id FROM yuqu.users WHERE id=$1 FOR NO KEY UPDATE', [profile.user.id]);
    const current = await readSnapshot(db, profile.user.id, true);
    const previous = (await db.query('SELECT * FROM yuqu.playback_takeovers WHERE user_id=$1 AND request_id=$2', [profile.user.id, requestId])).rows[0];
    if (previous) {
      if (previous.session_id !== profile.session.id || previous.expected_generation !== expectedGeneration || previous.target_media_version_id !== targetId || previous.target_position_ms !== targetPosition ||
          previous.intent !== intent || previous.expected_playback_session_id !== expectedPlaybackSessionId || previous.target_speed !== targetSpeed || previous.target_looping !== targetLooping) throw conflict(current);
      return { snapshot: current, accepted: current.generation === expectedGeneration + 1 && current.ownerSessionId === profile.session.id };
    }
    if (current.generation !== expectedGeneration) throw conflict(current);
    if (intent === 'restore' && (current.ownerSessionId !== profile.session.id || current.playbackSessionId !== expectedPlaybackSessionId)) throw conflict(current);
    const target = await authorizedMedia(db, profile, targetId ?? current.mediaVersionId, true);
    if (targetPosition !== null && (targetPosition > target.duration_ms || (intent !== 'restore' && targetPosition === target.duration_ms))) throw invalid('回听位置超出音频时长。');
    await rememberPlayback(db, profile.user.id, current);
    const history = target.id === current.mediaVersionId ? { position_ms: current.positionMs, speed: current.speed, looping: current.looping } :
      (await db.query('SELECT * FROM yuqu.playback_history WHERE user_id=$1 AND media_version_id=$2', [profile.user.id, target.id])).rows[0];
    await db.query(`INSERT INTO yuqu.playback_takeovers(user_id,request_id,session_id,expected_generation,target_media_version_id,target_position_ms,intent,expected_playback_session_id,target_speed,target_looping)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [profile.user.id, requestId, profile.session.id, expectedGeneration, targetId, targetPosition, intent, expectedPlaybackSessionId, targetSpeed, targetLooping]);
    await db.query(`UPDATE yuqu.playback_snapshots SET owner_session_id=$2,playback_session_id=$3,
      generation=generation+1,revision=revision+1,sequence=0,state='paused',updated_at=now(),
      content_id=$4,media_version_id=$5,position_ms=$6,speed=$7,looping=$8 WHERE user_id=$1`,
      [profile.user.id, profile.session.id, randomUUID(), target.content_id, target.id, targetPosition ?? Math.min(history?.position_ms ?? 0, target.duration_ms), targetSpeed ?? history?.speed ?? 1, targetLooping ?? history?.looping ?? false]);
    return { snapshot: await publish(db, profile.user.id), accepted: true };
  });
}

function mediaIdentity(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw invalid('音频标识无效。');
  return value;
}
async function rememberPlayback(db: PoolClient, userId: string, state: SyncedPlayback): Promise<void> {
  await db.query(`INSERT INTO yuqu.playback_history(user_id,media_version_id,position_ms,speed,looping) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(user_id,media_version_id) DO UPDATE SET position_ms=excluded.position_ms,speed=excluded.speed,looping=excluded.looping`,
    [userId, state.mediaVersionId, state.positionMs, state.speed, state.looping]);
}

function reportInput(input: unknown): PlaybackReport {
  const value = object(input);
  const generation = integer(value.generation, 1);
  const sequence = integer(value.sequence, 1);
  const playbackSessionId = uuid(value.playbackSessionId);
  const positionMs = integer(value.positionMs);
  const contentId = mediaIdentity(value.contentId), mediaVersionId = mediaIdentity(value.mediaVersionId);
  if (typeof value.speed !== 'number' || ![1, 1.25, 1.5, 2].includes(value.speed)) throw invalid();
  if (value.state !== 'playing' && value.state !== 'paused' && value.state !== 'buffering' && value.state !== 'ended') throw invalid();
  if (typeof value.looping !== 'boolean') throw invalid();
  return { generation, sequence, playbackSessionId, positionMs, contentId, mediaVersionId, speed: value.speed, state: value.state, looping: value.looping };
}

export async function reportPlayback(pool: Pool, profile: AccountSession, input: unknown): Promise<PlaybackResult> {
  const report = reportInput(input);
  return transaction(pool, async db => {
    await requireSession(db, profile);
    const current = await readSnapshot(db, profile.user.id, true);
    if (current.ownerSessionId !== profile.session.id || current.generation !== report.generation || current.playbackSessionId !== report.playbackSessionId) throw conflict(current);
    if (current.mediaVersionId !== report.mediaVersionId || current.contentId !== report.contentId || report.positionMs > current.durationMs) throw invalid();
    if (report.sequence <= current.sequence) return { snapshot: current, accepted: false };
    await db.query(`UPDATE yuqu.playback_snapshots SET position_ms=$2,speed=$3,state=$4,looping=$5,
      sequence=$6,revision=revision+1,updated_at=now() WHERE user_id=$1`, [profile.user.id, report.positionMs, report.speed, report.state, report.looping, report.sequence]);
    const next = await publish(db, profile.user.id);
    await rememberPlayback(db, profile.user.id, next);
    return { snapshot: next, accepted: true };
  });
}

export async function revokeSession(pool: Pool, profile: AccountSession): Promise<void> {
  await transaction(pool, async db => {
    await db.query('UPDATE yuqu.device_sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL', [profile.session.id, profile.user.id]);
    const current = await readSnapshot(db, profile.user.id, true);
    if (current.ownerSessionId === profile.session.id) {
      await db.query(`UPDATE yuqu.playback_snapshots SET state='paused',owner_session_id=NULL,
        playback_session_id=NULL,generation=generation+1,revision=revision+1,sequence=0,updated_at=now() WHERE user_id=$1`, [profile.user.id]);
      await publish(db, profile.user.id);
    }
  });
}

/** Called within the owning account's deletion transaction, before removing media. */
export async function resetRemovedPlayback(db: PoolClient, userId: string, mediaId: string): Promise<void> {
  const current = await readSnapshot(db, userId, true);
  if (current.mediaVersionId === mediaId) {
    await db.query(`UPDATE yuqu.playback_snapshots SET content_id='yuqu-playback-check-v1',media_version_id='fixture-pcm-v1',
      position_ms=0,speed=1,looping=false,state='paused',owner_session_id=NULL,playback_session_id=NULL,
      generation=generation+1,revision=revision+1,sequence=0,updated_at=now() WHERE user_id=$1`, [userId]);
  } else {
    await db.query('UPDATE yuqu.playback_snapshots SET revision=revision+1,updated_at=now() WHERE user_id=$1', [userId]);
  }
  await db.query("DELETE FROM yuqu.user_events WHERE user_id=$1 AND payload->>'mediaVersionId'=$2", [userId,mediaId]);
  await db.query('DELETE FROM yuqu.playback_takeovers WHERE user_id=$1 AND target_media_version_id=$2', [userId,mediaId]);
  await publish(db, userId);
}

export interface EventBatch {
  snapshot?: SyncedPlayback;
  reset: boolean;
  events: SyncedPlayback[];
}

/** One consistent, short DB read per poll; never hold a connection for an SSE lifetime. */
export async function eventBatch(pool: Pool, profile: AccountSession, cursor: number | null): Promise<EventBatch> {
  return transaction(pool, async db => {
    const active = await db.query(`SELECT id FROM yuqu.device_sessions
      WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now()`, [profile.session.id, profile.user.id]);
    if (!active.rowCount) throw new AppError(401, 'UNAUTHENTICATED', '登录已过期，请重新登录。');
    const current = await readSnapshot(db, profile.user.id);
    if (cursor === null) return { snapshot: current, reset: false, events: [] };
    const { rows } = await db.query(`SELECT revision,payload FROM yuqu.user_events
      WHERE user_id=$1 AND revision>$2 ORDER BY revision LIMIT 1000`, [profile.user.id, cursor]);
    if (cursor > current.revision || (cursor < current.revision && (!rows.length || rows[0].revision !== cursor + 1))) {
      return { snapshot: current, reset: true, events: [] };
    }
    return { reset: false, events: rows.map(row => row.payload as SyncedPlayback) };
  }, true);
}
