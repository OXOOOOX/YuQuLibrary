import { takeOver } from '@yuqu/domain/playback';
import { api, currentAccount, json, jsonBody } from '../../../../lib/api.ts';
import { database } from '../../../../lib/server.ts';

export const runtime = 'nodejs';
export function POST(request: Request) {
  return api(async () => {
    const account = await currentAccount(request, true);
    return json(await takeOver(database(), account, await jsonBody(request)));
  });
}
