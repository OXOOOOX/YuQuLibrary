import { retryTranscript, transcriptPage } from '@yuqu/domain/transcripts';
import { api, currentAccount, json } from '../../../../../../lib/api.ts';
import { database } from '../../../../../../lib/server.ts';

export const runtime = 'nodejs';
export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const account = await currentAccount(request, true), { id } = await context.params;
    await retryTranscript(database(), account, id);
    return json(await transcriptPage(database(), account, id));
  });
}
