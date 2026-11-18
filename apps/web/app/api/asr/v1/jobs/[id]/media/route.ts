import { api } from '../../../../../../../lib/api.ts';
import { streamAsrMedia } from '../../../../../../../lib/asr-worker.ts';
export const runtime = 'nodejs';
export function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => streamAsrMedia(request, (await context.params).id));
}
