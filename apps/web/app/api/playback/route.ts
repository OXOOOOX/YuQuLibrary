import { getPlayback } from '@yuqu/domain/playback';
import { api, currentAccount, json } from '../../../lib/api.ts';
import { database } from '../../../lib/server.ts';

export const runtime = 'nodejs';
export function GET(request: Request) {
  return api(async () => json({ snapshot: await getPlayback(database(), await currentAccount(request)) }));
}
