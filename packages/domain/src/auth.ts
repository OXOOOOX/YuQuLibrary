import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AccountSession } from '@yuqu/contracts';
import { transaction } from './database.ts';
import { AppError } from './errors.ts';
import { emailAddress, invalid, object, uuid } from './validation.ts';

export type DeliverCode = (message: { email: string; challengeId: string; code: string }) => Promise<'local' | 'smtp'>;
export const tokenDigest = (token: string) => createHash('sha256').update(token).digest('hex');
const codeDigest = (secret: string, email: string, id: string, code: string) => createHmac('sha256', secret).update(JSON.stringify([email, id, code])).digest('hex');

export async function requestCode(pool: Pool, secret: string, input: unknown, deliver: DeliverCode) {
  const email = emailAddress(object(input).email);
  const id = randomUUID();
  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  await transaction(pool, async db => {
    // Small, global send budget is deliberate for the first private deployment.
    // Mail delivery never happens while holding this lock.
    await db.query('SELECT pg_advisory_xact_lock(5173802)');
    const { rows } = await db.query(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE email=$1)::int AS per_email,
      count(*) FILTER (WHERE email=$1 AND created_at > now()-interval '60 seconds')::int AS recent
      FROM yuqu.login_challenges WHERE created_at > now()-interval '1 hour'`, [email]);
    if (rows[0].recent > 0 || rows[0].per_email >= 6 || rows[0].total >= 120) {
      throw new AppError(429, 'RATE_LIMITED', '发送过于频繁，请稍后再试。', undefined, rows[0].recent > 0 ? 60 : 3600);
    }
    await db.query("UPDATE yuqu.login_challenges SET status='failed' WHERE email=$1 AND status IN ('pending','sent')", [email]);
    await db.query("INSERT INTO yuqu.login_challenges(id,email,code_hash,status) VALUES($1,$2,$3,'pending')", [id, email, codeDigest(secret, email, id, code)]);
  });
  let delivery: 'local' | 'smtp';
  try { delivery = await deliver({ email, challengeId: id, code }); }
  catch {
    await pool.query("UPDATE yuqu.login_challenges SET status='failed' WHERE id=$1 AND status='pending'", [id]);
    throw new AppError(503, 'EMAIL_UNAVAILABLE', '邮件暂时无法发送，请稍后重试。');
  }
  const sent = await pool.query("UPDATE yuqu.login_challenges SET status='sent' WHERE id=$1 AND status='pending' AND expires_at>now()", [id]);
  if (!sent.rowCount) throw new AppError(409, 'CODE_REPLACED', '验证码已被更新，请重新发送。');
  return { challengeId: id, expiresIn: 600, retryAfter: 60, delivery };
}

export async function verifyCode(pool: Pool, secret: string, input: unknown): Promise<AccountSession & { token: string }> {
  const value = object(input);
  const email = emailAddress(value.email);
  const id = uuid(value.challengeId);
  if (typeof value.code !== 'string' || !/^\d{6}$/.test(value.code)) throw invalid('请输入六位验证码。');
  if (value.client !== 'web' && value.client !== 'harmony') throw invalid();
  const client = value.client;
  const deviceName = typeof value.deviceName === 'string' ? value.deviceName.trim() : '';
  if (!deviceName || deviceName.length > 64 || /[\x00-\x1f]/.test(deviceName)) throw invalid();
  const digest = codeDigest(secret, email, id, value.code);
  const result = await transaction<(AccountSession & { token: string }) | null>(pool, async db => {
    const { rows } = await db.query('SELECT *, expires_at>now() AS valid FROM yuqu.login_challenges WHERE id=$1 FOR UPDATE', [id]);
    const challenge = rows[0];
    if (!challenge || challenge.email !== email || challenge.status !== 'sent' || !challenge.valid || challenge.attempts >= 5) return null;
    if (!timingSafeEqual(Buffer.from(challenge.code_hash, 'hex'), Buffer.from(digest, 'hex'))) {
      // Return a value, not an exception: failed attempts must COMMIT.
      await db.query('UPDATE yuqu.login_challenges SET attempts=attempts+1 WHERE id=$1', [id]);
      return null;
    }
    const user = (await db.query(`INSERT INTO yuqu.users(id,email) VALUES($1,$2)
      ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING id,email`, [randomUUID(), email])).rows[0];
    const token = randomBytes(32).toString('base64url');
    const session = (await db.query(`INSERT INTO yuqu.device_sessions(id,user_id,token_hash,client,device_name)
      VALUES($1,$2,$3,$4,$5) RETURNING id,expires_at`, [randomUUID(), user.id, tokenDigest(token), client, deviceName])).rows[0];
    await db.query("UPDATE yuqu.login_challenges SET status='consumed' WHERE id=$1", [id]);
    await db.query('INSERT INTO yuqu.playback_snapshots(user_id) VALUES($1) ON CONFLICT DO NOTHING', [user.id]);
    return { user: { id: user.id as string, email }, session: { id: session.id as string, deviceName, client, expiresAt: (session.expires_at as Date).toISOString() }, token };
  });
  if (!result) throw new AppError(401, 'INVALID_CODE', '验证码无效或已过期，请重新获取。');
  return result;
}

export async function authenticate(db: Pick<Pool, 'query'> | PoolClient, token: string): Promise<AccountSession> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError(401, 'UNAUTHENTICATED', '请先登录。');
  const { rows } = await db.query(`SELECT u.id AS user_id,u.email,s.id,s.client,s.device_name,s.expires_at
    FROM yuqu.device_sessions s JOIN yuqu.users u ON u.id=s.user_id
    WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()`, [tokenDigest(token)]);
  const row = rows[0];
  if (!row) throw new AppError(401, 'UNAUTHENTICATED', '登录已过期，请重新登录。');
  return { user: { id: row.user_id, email: row.email }, session: {
    id: row.id, client: row.client, deviceName: row.device_name, expiresAt: (row.expires_at as Date).toISOString()
  } };
}

export async function requireSession(db: PoolClient, profile: AccountSession): Promise<void> {
  const { rowCount } = await db.query(`SELECT id FROM yuqu.device_sessions
    WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now() FOR SHARE`, [profile.session.id, profile.user.id]);
  if (!rowCount) throw new AppError(401, 'UNAUTHENTICATED', '登录已过期，请重新登录。');
}
