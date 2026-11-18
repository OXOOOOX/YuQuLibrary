import { summariesPage, generateSummary, changeSummary, SUMMARY_TOPICS_CAPABILITY } from '@yuqu/domain/summaries';
import { invalid } from '@yuqu/domain/validation';
import { api, currentAccount, json, jsonBody } from '../../../../../lib/api.ts';
import { database } from '../../../../../lib/server.ts';
export const runtime = 'nodejs';
export function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const query = new URL(request.url).searchParams, after = query.get('after');
    if (after !== null && !/^\d{1,3}$/u.test(after)) throw invalid('总结页码无效。');
    return json(await summariesPage(database(), await currentAccount(request), (await context.params).id,
      query.get('documentId') ?? undefined, after === null ? 0 : Number(after), query.get('capabilities')?.split(',').includes(SUMMARY_TOPICS_CAPABILITY) ?? false));
  });
}
export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const account = await currentAccount(request, true), mediaId = (await context.params).id, input = await jsonBody(request);
    const supportsTopics = new URL(request.url).searchParams.get('capabilities')?.split(',').includes(SUMMARY_TOPICS_CAPABILITY) ?? false;
    if (input.action === 'generate') return json(await generateSummary(database(), account, mediaId, input, supportsTopics));
    if ((input.action === 'retry' || input.action === 'cancel') && typeof input.documentId === 'string') {
      return json(await changeSummary(database(), account, mediaId, input.documentId, input.action, supportsTopics));
    }
    throw invalid('总结操作无效。');
  });
}
