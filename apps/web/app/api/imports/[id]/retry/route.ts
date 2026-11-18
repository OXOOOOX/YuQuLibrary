import { retryImport } from '@yuqu/domain/library';
import { api, currentAccount, json, jsonBody } from '../../../../../lib/api.ts';
import { database } from '../../../../../lib/server.ts';
export const runtime = 'nodejs';
export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const profile = await currentAccount(request, true); await jsonBody(request);
    return json({ job: await retryImport(database(), profile, (await context.params).id) });
  });
}
