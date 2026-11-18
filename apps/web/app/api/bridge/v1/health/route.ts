import { api, json } from '../../../../../lib/api.ts';
import { bridgeAccount } from '../../../../../lib/bridge.ts';
export const runtime = 'nodejs';
export function GET(request: Request) {
  return api(async () => { const agent = bridgeAccount(request); return json({ protocolVersion: '1.0', projectId: agent.projectId }); });
}
