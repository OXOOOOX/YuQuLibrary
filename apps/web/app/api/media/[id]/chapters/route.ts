import { chaptersPage, changeChapters, generateChapters } from '@yuqu/domain/chapters';
import { invalid } from '@yuqu/domain/validation';
import { api, currentAccount, json, jsonBody } from '../../../../../lib/api.ts';
import { database } from '../../../../../lib/server.ts';
export const runtime = 'nodejs';
export function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const query = new URL(request.url).searchParams, after = query.get('after');
    if (after !== null && !/^\d{1,4}$/.test(after)) throw invalid('章节页码无效。');
    return json(await chaptersPage(database(), await currentAccount(request), (await context.params).id,
      query.get('documentId') ?? undefined, after === null ? 0 : Number(after)));
  });
}
export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const account = await currentAccount(request, true), mediaId = (await context.params).id, input = await jsonBody(request);
    if (input.action === 'generate') return json(await generateChapters(database(), account, mediaId, input));
    if ((input.action === 'retry' || input.action === 'cancel') && typeof input.documentId === 'string') {
      return json(await changeChapters(database(), account, mediaId, input.documentId, input.action));
    }
    throw invalid('章节操作无效。');
  });
}
