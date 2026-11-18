import { leasedTranscript, renewTranscript, saveTranscriptChunk, completeTranscript, failTranscript, validateTranscriptChunk } from '@yuqu/domain/transcripts';
import { AppError } from '@yuqu/domain/errors';
import { invalid } from '@yuqu/domain/validation';
import { api, json, jsonBody } from '../../../../../../../lib/api.ts';
import { asrWorker } from '../../../../../../../lib/asr-worker.ts';
import { database } from '../../../../../../../lib/server.ts';
export const runtime = 'nodejs';
export function POST(request: Request, context: { params: Promise<{ id: string; action: string }> }) {
  return api(async () => {
    asrWorker(request);
    const { id, action } = await context.params;
    if (!['heartbeat', 'chunk', 'complete', 'fail'].includes(action)) throw new AppError(404, 'NOT_FOUND', '转写操作不存在。');
    const input = await jsonBody(request, 32768);
    const task = await leasedTranscript(database(), id, input.leaseId, action === 'complete');
    let ok = false;
    if (action === 'heartbeat') ok = await renewTranscript(database(), task);
    else if (action === 'chunk') {
      try { validateTranscriptChunk(input.chunk, task.durationMs); } catch { throw invalid('文稿片段格式无效。'); }
      ok = await saveTranscriptChunk(database(), task, input.chunk);
    } else if (action === 'complete') ok = await completeTranscript(database(), task);
    else ok = await failTranscript(database(), task);
    if (!ok) throw new AppError(409, 'LEASE_LOST', '转写租约已失效或尚未全部完成。');
    return json({ ok: true });
  });
}
