export const dynamic = 'force-dynamic';
export function GET() {
  return Response.json({ service: 'yuqu-library', status: 'ok', stage: 'playback-prototype' });
}
