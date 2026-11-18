import { revokeSession } from '@yuqu/domain/playback';
import { api, currentAccount, json, jsonBody, sessionCookie } from '../../../../lib/api.ts';
import { database } from '../../../../lib/server.ts';

export const runtime = 'nodejs';
export function POST(request: Request) {
  return api(async () => {
    const account = await currentAccount(request, true);
    await jsonBody(request);
    await revokeSession(database(), account);
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', true) });
  });
}
