import { removeImport } from '@yuqu/domain/storage';
import { api, currentAccount, json, jsonBody } from '../../../../../lib/api.ts';
import { database } from '../../../../../lib/server.ts';
export const runtime = 'nodejs';
export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const profile = await currentAccount(request, true); await jsonBody(request);
    return json(await removeImport(database(), profile, (await context.params).id));
  });
}
