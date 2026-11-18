import { transcriptPage } from '@yuqu/domain/transcripts';
import { AppError } from '@yuqu/domain/errors';
import { api, currentAccount, json } from '../../../../../lib/api.ts';
import { database } from '../../../../../lib/server.ts';

export const runtime = 'nodejs';
export function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const account = await currentAccount(request), { id } = await context.params;
    const params = new URL(request.url).searchParams;
    let cursor = -1, atMs: number | undefined;
    if (params.has('at')) {
      const at = params.get('at')!;
      if (!/^\d{1,8}$/.test(at) || Number(at) > 14400000) throw new AppError(400, 'INVALID_POSITION', '文稿位置无效。');
      atMs = Number(at);
    } else if (params.has('after')) {
      const after = params.get('after')!;
      if (!/^(?:-1|\d{1,3})$/.test(after)) throw new AppError(400, 'INVALID_CURSOR', '文稿页码无效。');
      cursor = Number(after);
    }
    return json(await transcriptPage(database(), account, id, cursor, atMs));
  });
}
