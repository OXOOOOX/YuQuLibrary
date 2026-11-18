import { claimTranscript, remoteTranscriptTask } from '@yuqu/domain/transcripts';
import { api, json } from '../../../../../../lib/api.ts';
import { asrWorker } from '../../../../../../lib/asr-worker.ts';
import { database } from '../../../../../../lib/server.ts';
export const runtime = 'nodejs';
export function POST(request: Request) {
  return api(async () => {
    asrWorker(request);
    const task = await claimTranscript(database());
    return task ? json({ job: remoteTranscriptTask(task) }) : new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  });
}
