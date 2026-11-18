import { api, json } from '../../../../../lib/api.ts';
import { asrWorker } from '../../../../../lib/asr-worker.ts';
export const runtime = 'nodejs';
export function GET(request: Request) {
  return api(async () => { asrWorker(request); return json({ protocolVersion: '1.0' }); });
}
