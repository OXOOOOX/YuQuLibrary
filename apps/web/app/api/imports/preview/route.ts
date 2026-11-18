import { normalizeImportUrl, previewImportSource, reservePreview } from '@yuqu/domain/library';
import { api, currentAccount, json, jsonBody } from '../../../../lib/api.ts';
import { database } from '../../../../lib/server.ts';
export const runtime = 'nodejs';
export function POST(request: Request) {
  return api(async () => {
    const profile = await currentAccount(request, true), body = await jsonBody(request);
    const url = normalizeImportUrl(body.url);
    await reservePreview(database(), profile);
    return json(await previewImportSource(url, request.signal));
  });
}
