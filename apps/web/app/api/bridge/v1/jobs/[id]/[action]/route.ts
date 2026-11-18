import { bridgeSeen, heartbeatChat, streamChat, finishChat, failChat } from '@yuqu/domain/chat';
import { isChapterTask, heartbeatChapters, finishChapters, failChapters } from '@yuqu/domain/chapters';
import { isSummaryTask, heartbeatSummary, finishSummary, failSummary } from '@yuqu/domain/summaries';
import { AppError } from '@yuqu/domain/errors';
import { uuid } from '@yuqu/domain/validation';
import { api, json, jsonBody } from '../../../../../../../lib/api.ts';
import { bridgeAccount } from '../../../../../../../lib/bridge.ts';
import { database } from '../../../../../../../lib/server.ts';
export const runtime = 'nodejs';
export function POST(request: Request, context: { params: Promise<{ id: string; action: string }> }) {
  return api(async () => {
    const agent = bridgeAccount(request), { id, action } = await context.params;
    const input = await jsonBody(request, 100000), leaseId = uuid(input.leaseId);
    await bridgeSeen(database(), agent);
    if (await isSummaryTask(database(), id)) {
      if (action === 'heartbeat') return json(await heartbeatSummary(database(), agent, id, leaseId));
      if (action === 'complete') await finishSummary(database(), agent, id, input);
      else if (action === 'fail') await failSummary(database(), agent, id, leaseId);
      else throw new AppError(404, 'NOT_FOUND', '总结任务不支持这个操作。');
      return json({ ok: true });
    }
    if (await isChapterTask(database(), id)) {
      if (action === 'heartbeat') return json(await heartbeatChapters(database(), agent, id, leaseId));
      if (action === 'complete') await finishChapters(database(), agent, id, input);
      else if (action === 'fail') await failChapters(database(), agent, id, leaseId);
      else throw new AppError(404, 'NOT_FOUND', '章节任务不支持这个操作。');
      return json({ ok: true });
    }
    if (action === 'heartbeat') return json(await heartbeatChat(database(), agent, id, leaseId));
    if (action === 'events') await streamChat(database(), agent, id, input);
    else if (action === 'complete') await finishChat(database(), agent, id, input);
    else if (action === 'fail') await failChat(database(), agent, id, leaseId);
    else throw new AppError(404, 'NOT_FOUND', 'Bridge 操作不存在。');
    return json({ ok: true });
  });
}
