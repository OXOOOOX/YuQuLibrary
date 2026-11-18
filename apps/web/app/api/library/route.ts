import { listLibrary } from '@yuqu/domain/library';
import { getStorageUsage } from '@yuqu/domain/storage';
import { api, currentAccount, json } from '../../../lib/api.ts';
import { database } from '../../../lib/server.ts';
export const runtime = 'nodejs';
export function GET(request: Request) { return api(async () => {
  const profile = await currentAccount(request);
  const [items, usage] = await Promise.all([listLibrary(database(), profile), getStorageUsage(database(), profile)]);
  return json({ items, usage });
}); }
