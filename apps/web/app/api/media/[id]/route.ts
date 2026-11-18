import { api } from '../../../../lib/api.ts';
import { streamMedia } from '../../../../lib/media.ts';
export const runtime = 'nodejs';
export function GET(request: Request, context: { params: Promise<{ id: string }> }) { return api(async () => streamMedia(request, (await context.params).id)); }
export const HEAD = GET;
