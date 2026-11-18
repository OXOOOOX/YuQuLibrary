import { searchTranscript } from '@yuqu/domain/knowledge';
import { api, currentAccount, json } from '../../../../../../lib/api.ts';
import { database } from '../../../../../../lib/server.ts';

export const runtime = 'nodejs';
export function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const account = await currentAccount(request), { id } = await context.params;
    const query = new URL(request.url).searchParams;
    return json(await searchTranscript(database(), account, id, query.get('q') ?? '', query.get('cursor') ?? undefined));
  });
}
