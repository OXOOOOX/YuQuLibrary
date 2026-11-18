import { removeLibraryMedia } from '@yuqu/domain/storage';
import { AppError } from '@yuqu/domain/errors';
import { api, currentAccount, json, jsonBody } from '../../../../../lib/api.ts';
import { database } from '../../../../../lib/server.ts';
export const runtime = 'nodejs';
export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const profile = await currentAccount(request, true);
    const value = await jsonBody(request);
    if (value.mode !== 'audio' && value.mode !== 'all') throw new AppError(400, 'INVALID_INPUT', '请选择清理音频或删除整期资料。');
    return json(await removeLibraryMedia(database(), profile, (await context.params).id, value.mode));
  });
}
