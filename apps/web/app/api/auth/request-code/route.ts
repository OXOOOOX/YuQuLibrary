import { requestCode } from '@yuqu/domain/auth';
import { api, checkOrigin, json, jsonBody } from '../../../../lib/api.ts';
import { authSecret, database } from '../../../../lib/server.ts';
import { deliverCode } from '../../../../lib/mail.ts';

export const runtime = 'nodejs';
export function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    return json(await requestCode(database(), authSecret(), await jsonBody(request), deliverCode));
  });
}
