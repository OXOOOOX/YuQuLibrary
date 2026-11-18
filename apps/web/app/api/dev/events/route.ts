import { probeResponse } from '../../../../lib/probe';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: Request) {
  if (process.env.NODE_ENV !== 'development' || process.env.ENABLE_PLAYBACK_PROBE !== '1') {
    return new Response(null, { status: 404 });
  }
  return probeResponse(request);
}
