import { summaryTopicPage, SUMMARY_TOPICS_CAPABILITY } from '@yuqu/domain/summaries';
import { invalid } from '@yuqu/domain/validation';
import { AppError } from '@yuqu/domain/errors';
import { api, currentAccount, json } from '../../../../../../lib/api.ts';
import { database } from '../../../../../../lib/server.ts';
export const runtime = 'nodejs';
export function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const query = new URL(request.url).searchParams, topic = query.get('topicIndex'), after = query.get('after') ?? '0';
    if (!query.get('capabilities')?.split(',').includes(SUMMARY_TOPICS_CAPABILITY)) throw new AppError(409, 'CLIENT_UPGRADE_REQUIRED', '请更新客户端以查看总结主题。');
    if (topic === null || !/^(?:[0-9]|1[01])$/u.test(topic) || !/^\d{1,4}$/u.test(after)) throw invalid('总结主题页码无效。');
    return json(await summaryTopicPage(database(), await currentAccount(request), (await context.params).id,
      query.get('documentId') ?? '', Number(topic), Number(after)));
  });
}
