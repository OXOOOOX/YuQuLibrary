import { checkChat } from '@yuqu/domain/chat';
import { api, currentAccount, json, jsonBody } from '../../../../../../lib/api.ts';
import { database } from '../../../../../../lib/server.ts';
export const runtime = 'nodejs';
export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => json(await checkChat(database(), await currentAccount(request, true), (await context.params).id, await jsonBody(request))));
}
