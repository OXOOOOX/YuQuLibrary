import { authenticate } from '@yuqu/domain/auth';
import { AppError } from '@yuqu/domain/errors';
import { object } from '@yuqu/domain/validation';
import { appOrigin, database } from './server.ts';

export function checkOrigin(request: Request, required = false): void {
  const origin = request.headers.get('origin');
  if ((required && !origin) || (origin !== null && origin !== appOrigin())) {
    throw new AppError(403, 'ORIGIN_REJECTED', '请从鱼趣页面重试。');
  }
}
export function sessionToken(request: Request): { token: string; bearer: boolean } {
  const authorization = request.headers.get('authorization');
  if (authorization !== null) {
    // A bad Bearer header must not silently fall back to a cookie.
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
    if (!match) throw new AppError(401, 'UNAUTHENTICATED', '请重新登录。');
    return { token: match[1], bearer: true };
  }
  const cookie = request.headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith('yuqu_session='));
  return { token: cookie?.slice('yuqu_session='.length) || '', bearer: false };
}
export async function currentAccount(request: Request, write = false) {
  const { token, bearer } = sessionToken(request);
  checkOrigin(request, write && !bearer);
  return authenticate(database(), token);
}
export function sessionCookie(token: string, clear = false): string {
  return `yuqu_session=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : 30 * 24 * 60 * 60}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
}
export async function jsonBody(request: Request, maxBytes = 8192): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw new AppError(415, 'JSON_REQUIRED', '请使用 JSON 请求。');
  const reader = request.body?.getReader();
  if (!reader) throw new AppError(400, 'INVALID_INPUT', '请求内容为空。');
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new AppError(413, 'BODY_TOO_LARGE', '请求内容过大。'); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return object(JSON.parse(text));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, 'INVALID_INPUT', '请求内容无效。');
  } finally { reader.releaseLock(); }
}
export function json(value: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...extra } });
}
export async function api(work: () => Promise<Response>): Promise<Response> {
  try { return await work(); }
  catch (error) {
    if (error instanceof AppError) {
      return json({ error: { code: error.code, message: error.message }, ...(error.snapshot ? { snapshot: error.snapshot } : {}) }, error.status,
        error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {});
    }
    // Do not log connection strings, mail credentials, codes, request bodies or tokens.
    console.error('YuQu request failed');
    return json({ error: { code: 'SERVICE_UNAVAILABLE', message: '服务暂时不可用，请稍后重试。' } }, 503);
  }
}
