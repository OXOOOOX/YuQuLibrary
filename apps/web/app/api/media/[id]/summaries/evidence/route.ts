import { summaryEvidence } from '@yuqu/domain/summaries';
import { invalid } from '@yuqu/domain/validation';
import { api, currentAccount, json } from '../../../../../../lib/api.ts';
import { database } from '../../../../../../lib/server.ts';
export const runtime = 'nodejs';
export function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const query = new URL(request.url).searchParams, point = query.get('pointIndex');
    if (point === null || !/^(?:[0-9]|1[01])$/u.test(point)) throw invalid('总结要点无效。');
    return json(await summaryEvidence(database(), await currentAccount(request), (await context.params).id,
      query.get('documentId') ?? '', query.get('nodeId') ?? '', Number(point)));
  });
}
