import { askChat, chatPage } from '@yuqu/domain/chat';
import { AppError } from '@yuqu/domain/errors';
import { api, currentAccount, json, jsonBody } from '../../../../../lib/api.ts';
import { database } from '../../../../../lib/server.ts';
export const runtime = 'nodejs';
export function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const account = await currentAccount(request), { id } = await context.params;
    const raw = new URL(request.url).searchParams.get('before');
    if (raw !== null && !/^[1-9]\d{0,8}$/.test(raw)) throw new AppError(400, 'INVALID_CURSOR', '对话页码无效。');
    const capabilities = new Set((new URL(request.url).searchParams.get('capabilities') ?? '').split(','));
    return json(await chatPage(database(), account, id, raw === null ? undefined : Number(raw), capabilities.has('anchored-v1'), capabilities.has('retrieval-v1')));
  });
}
export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => json({ turn: await askChat(database(), await currentAccount(request, true), (await context.params).id, await jsonBody(request)) }));
}
