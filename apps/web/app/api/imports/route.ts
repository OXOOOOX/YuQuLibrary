import { createImport, listImports } from '@yuqu/domain/library';
import { api, currentAccount, json, jsonBody } from '../../../lib/api.ts';
import { database } from '../../../lib/server.ts';
export const runtime = 'nodejs';
export function GET(request: Request) { return api(async () => json({ jobs: await listImports(database(), await currentAccount(request)) })); }
export function POST(request: Request) { return api(async () => json({ job: await createImport(database(), await currentAccount(request, true), await jsonBody(request), { signal: request.signal }) })); }
