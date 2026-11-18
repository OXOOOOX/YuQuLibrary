import pg from 'pg';
import { AppError } from '@yuqu/domain/errors';

const globalPool = globalThis as typeof globalThis & { yuquPool?: pg.Pool };
export function database(): pg.Pool {
  if (!process.env.DATABASE_URL) throw new AppError(503, 'NOT_CONFIGURED', '服务尚未配置数据库。');
  if (!globalPool.yuquPool) {
    globalPool.yuquPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10,
      connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 5000 });
    globalPool.yuquPool.on('error', () => console.error('YuQu database connection interrupted'));
  }
  return globalPool.yuquPool;
}
export function authSecret(): string {
  const secret = process.env.YUQU_AUTH_SECRET;
  if (!secret || secret.length < 32) throw new AppError(503, 'NOT_CONFIGURED', '服务尚未配置登录密钥。');
  return secret;
}
export function appOrigin(): string {
  const value = process.env.YUQU_ORIGIN || (process.env.NODE_ENV !== 'production' ? 'http://127.0.0.1:3000' : '');
  try {
    const url = new URL(value);
    if (url.origin !== value || (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')) throw new Error();
    return value;
  } catch { throw new AppError(503, 'NOT_CONFIGURED', '服务地址尚未配置。'); }
}
