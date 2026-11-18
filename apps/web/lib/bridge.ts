import { timingSafeEqual } from 'node:crypto';
import type { BridgeAccount } from '@yuqu/domain/chat';
import { AppError } from '@yuqu/domain/errors';

export function bridgeAccount(request: Request): BridgeAccount {
  const expected = process.env.YUQU_BRIDGE_TOKEN, agentId = process.env.YUQU_BRIDGE_AGENT_ID;
  if (!expected || !/^[A-Za-z0-9_-]{32,128}$/.test(expected) || !agentId) throw new AppError(503, 'BRIDGE_NOT_CONFIGURED', '问答服务尚未配置。');
  const received = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/)?.[1] ?? '';
  if (received.length !== expected.length || !timingSafeEqual(Buffer.from(received), Buffer.from(expected)) || request.headers.get('x-bridge-agent-id') !== agentId) throw new AppError(401, 'BRIDGE_UNAUTHENTICATED', 'Bridge 凭据无效。');
  return { agentId, projectId: process.env.YUQU_BRIDGE_PROJECT_ID || 'yuqu' };
}
