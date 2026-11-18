import { createSavedItem, listSavedItems } from '@yuqu/domain/knowledge';
import { api, currentAccount, json, jsonBody } from '../../../lib/api.ts';
import { database } from '../../../lib/server.ts';

export const runtime = 'nodejs';
export function GET(request: Request) {
  return api(async () => {
    const account = await currentAccount(request), query = new URL(request.url).searchParams;
    return json(await listSavedItems(database(), account, { mediaVersionId: query.get('mediaVersionId') ?? undefined,
      cursor: query.get('cursor') ?? undefined, limit: query.has('limit') ? Number(query.get('limit')) : undefined }));
  });
}
export function POST(request: Request) {
  return api(async () => {
    const account = await currentAccount(request, true), body = await jsonBody(request, 20000);
    return json(await createSavedItem(database(), account, body));
  });
}
