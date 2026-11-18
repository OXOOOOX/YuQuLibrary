import { verifyCode } from '@yuqu/domain/auth';
import { api, checkOrigin, json, jsonBody, sessionCookie } from '../../../../lib/api.ts';
import { authSecret, database } from '../../../../lib/server.ts';

export const runtime = 'nodejs';
export function POST(request: Request) {
  return api(async () => {
    const input = await jsonBody(request);
    checkOrigin(request, input.client === 'web');
    const { token, ...account } = await verifyCode(database(), authSecret(), input);
    return input.client === 'web'
      ? json(account, 200, { 'Set-Cookie': sessionCookie(token) })
      : json({ ...account, token });
  });
}
