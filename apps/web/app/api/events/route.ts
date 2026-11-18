import { api, currentAccount } from '../../../lib/api.ts';
import { database } from '../../../lib/server.ts';
import { playbackEvents } from '../../../lib/events.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return api(async () => playbackEvents(request, database(), await currentAccount(request)));
}
