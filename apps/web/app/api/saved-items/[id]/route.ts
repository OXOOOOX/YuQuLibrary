import { deleteSavedItem, updateSavedItem } from '@yuqu/domain/knowledge';
import { api, currentAccount, json, jsonBody } from '../../../../lib/api.ts';
import { database } from '../../../../lib/server.ts';

export const runtime = 'nodejs';
export function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const account = await currentAccount(request, true), { id } = await context.params;
    return json(await updateSavedItem(database(), account, id, await jsonBody(request, 20000)));
  });
}
export function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const account = await currentAccount(request, true), { id } = await context.params;
    return json(await deleteSavedItem(database(), account, id));
  });
}
