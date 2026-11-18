import { bridgeSeen, claimChat, RETRIEVAL_TASK_TYPE } from '@yuqu/domain/chat';
import { CHAPTER_TASK_TYPE, claimChapters } from '@yuqu/domain/chapters';
import { SUMMARY_PART_TASK, SUMMARY_OVERVIEW_TASK, SUMMARY_PART_V2_TASK, SUMMARY_OVERVIEW_V2_TASK, claimSummary } from '@yuqu/domain/summaries';
import { api, json, jsonBody } from '../../../../../../lib/api.ts';
import { bridgeAccount } from '../../../../../../lib/bridge.ts';
import { database } from '../../../../../../lib/server.ts';
export const runtime = 'nodejs';
export function POST(request: Request) {
  return api(async () => {
    const agent = bridgeAccount(request), input = await jsonBody(request);
    const accepted = Array.isArray(input.acceptedTaskTypes) ? input.acceptedTaskTypes.filter((type): type is string => typeof type === 'string' && ['yuqu.chat.answer.v1', RETRIEVAL_TASK_TYPE, CHAPTER_TASK_TYPE, SUMMARY_PART_TASK, SUMMARY_OVERVIEW_TASK, SUMMARY_PART_V2_TASK, SUMMARY_OVERVIEW_V2_TASK].includes(type)) : [];
    await bridgeSeen(database(), agent, accepted);
    // Interactive questions take priority over background chapter generation.
    const job = (accepted.includes('yuqu.chat.answer.v1') || accepted.includes(RETRIEVAL_TASK_TYPE) ? await claimChat(database(), agent, accepted) : null)
      ?? (accepted.includes(CHAPTER_TASK_TYPE) ? await claimChapters(database(), agent) : null)
      ?? ([SUMMARY_PART_TASK, SUMMARY_OVERVIEW_TASK, SUMMARY_PART_V2_TASK, SUMMARY_OVERVIEW_V2_TASK].some(type => accepted.includes(type)) ? await claimSummary(database(), agent, accepted) : null);
    return job ? json({ job }) : new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  });
}
