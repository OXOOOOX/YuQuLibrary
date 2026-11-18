import { changeChat } from '@yuqu/domain/chat';
import { AppError } from '@yuqu/domain/errors';
import { api, currentAccount, json } from '../../../../../../lib/api.ts';
import { database } from '../../../../../../lib/server.ts';
export const runtime = 'nodejs';
export function POST(request: Request, context: { params: Promise<{ id: string; action: string }> }) {
  return api(async () => {
    const account = await currentAccount(request, true), { id, action } = await context.params;
    if (action !== 'retry' && action !== 'cancel') throw new AppError(404, 'NOT_FOUND', '操作不存在。');
    return json({ turn: await changeChat(database(), account, id, action) });
  });
}
