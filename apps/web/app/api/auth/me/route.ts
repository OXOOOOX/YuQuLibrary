import { api, currentAccount, json } from '../../../../lib/api.ts';

export const runtime = 'nodejs';
export function GET(request: Request) {
  return api(async () => json(await currentAccount(request)));
}
