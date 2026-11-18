export const dynamic = 'force-dynamic';
export function GET() {
  return Response.json({
    service: 'yuqu-library', status: 'ok', stage: 'playback-prototype',
    revision: process.env.YUQU_REVISION || undefined,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
