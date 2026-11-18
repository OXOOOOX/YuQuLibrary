import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';
import { mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { requestCode, verifyCode, authenticate, tokenDigest } from '../packages/domain/src/auth.ts';
import { getPlayback, takeOver, reportPlayback, revokeSession, eventBatch } from '../packages/domain/src/playback.ts';
import { playbackEvents } from '../apps/web/lib/events.ts';
import { checkOrigin, currentAccount, jsonBody, sessionCookie, sessionToken } from '../apps/web/lib/api.ts';
import { SseDecoder } from '../packages/domain/src/sse.ts';
import { createImport, listImports, listLibrary, mediaFile, claimImport, renewImport, completeImport, failImport, retryImport, reservePreview } from '../packages/domain/src/library.ts';
import { streamMedia } from '../apps/web/lib/media.ts';
import { transcriptPage, retryTranscript, claimTranscript, renewTranscript, saveTranscriptChunk, completeTranscript, failTranscript, leasedTranscript } from '../packages/domain/src/transcripts.ts';
import { getStorageUsage, removeLibraryMedia, removeImport } from '../packages/domain/src/storage.ts';
import { cleanupOne } from '../packages/domain/src/storage-cleanup.ts';
import { MAX_IMPORT_BYTES } from '../packages/domain/src/storage-limits.ts';
import { transcribeOne } from '../workers/transcription/process.mjs';
import { TRANSCRIPTION_WORKER_LOCK } from '../workers/transcription/lock.mjs';
import { GET as getTranscriptRoute } from '../apps/web/app/api/media/[id]/transcript/route.ts';
import { askChat, checkChat, chatPage, changeChat, claimChat, heartbeatChat, streamChat, finishChat, failChat, bridgeSeen } from '../packages/domain/src/chat.ts';
import { bridgeAccount } from '../apps/web/lib/bridge.ts';
import { asrWorker } from '../apps/web/lib/asr-worker.ts';
import { POST as claimAsrRoute } from '../apps/web/app/api/asr/v1/jobs/claim/route.ts';
import { POST as asrActionRoute } from '../apps/web/app/api/asr/v1/jobs/[id]/[action]/route.ts';
import { GET as asrMediaRoute } from '../apps/web/app/api/asr/v1/jobs/[id]/media/route.ts';

const url = process.env.YUQU_TEST_DATABASE_URL;
const enabled = Boolean(url);
const pool = enabled ? new pg.Pool({ connectionString: url, max: 6 }) : null;
const secret = 'integration-only-secret-do-not-use-in-production-123456789';
const integration = (name, fn) => test(name, { skip: !enabled }, fn);
const run = promisify(execFile);
let initialMigration = '';
let repeatedMigration = '';
const migrations = (await readdir(new URL('../db/migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort();
before(async () => {
  if (!enabled) return;
  const parsed = new URL(url);
  assert.match(parsed.pathname, /_test$/u, 'Refusing to reset a database without _test suffix');
  const current = (await pool.query('SELECT current_database() AS name')).rows[0].name;
  assert.match(current, /_test$/u);
  // This suite is explicitly opt-in and only resets its dedicated test schema.
  await pool.query('DROP SCHEMA IF EXISTS yuqu CASCADE');
  await pool.query('DROP TABLE IF EXISTS public.yuqu_schema_migrations');
  const migrate = () => run(process.execPath, [fileURLToPath(new URL('../scripts/migrate.mjs', import.meta.url))], {
    env: { ...process.env, DATABASE_URL: url }, windowsHide: true, timeout: 15000
  });
  initialMigration = (await migrate()).stdout;
  repeatedMigration = (await migrate()).stdout;
  process.env.DATABASE_URL = url;
  process.env.YUQU_ORIGIN = 'http://127.0.0.1:3000';
});

integration('migration runner initializes an empty database and safely reruns with checksums', async () => {
  for (const name of migrations) {
    assert.ok(initialMigration.includes(`Applied: ${name}`));
    assert.ok(repeatedMigration.includes(`Already applied: ${name}`));
  }
  const rows = (await pool.query('SELECT name,checksum FROM public.yuqu_schema_migrations ORDER BY name')).rows;
  assert.equal(rows.length, migrations.length);
  for (const row of rows) assert.match(row.checksum, /^[0-9a-f]{64}$/);
  assert.equal((await pool.query("SELECT to_regclass('yuqu.yuqu_schema_migrations') AS duplicate")).rows[0].duplicate, null);
});
after(async () => {
  await pool?.end();
  await globalThis.yuquPool?.end();
  delete globalThis.yuquPool;
});

let count = 0;
const address = () => `case-${++count}@example.test`;
async function challenge(email = address(), deliver = null) {
  let message;
  const issued = await requestCode(pool, secret, { email }, deliver || (async value => { message = value; return 'local'; }));
  return { ...issued, ...message };
}
async function login(email = address(), client = 'harmony') {
  const code = await challenge(email);
  return verifyCode(pool, secret, { ...code, client, deviceName: client });
}
async function secondLogin(email, client = 'web') {
  await pool.query("UPDATE yuqu.login_challenges SET created_at=now()-interval '61 seconds' WHERE email=$1", [email]);
  return login(email, client);
}
function report(snapshot, changes = {}) {
  return { contentId: snapshot.contentId, mediaVersionId: snapshot.mediaVersionId,
    generation: snapshot.generation, playbackSessionId: snapshot.playbackSessionId,
    sequence: snapshot.sequence + 1, positionMs: 42000, speed: 1, state: 'playing', looping: false, ...changes };
}
async function rejectsCode(promise, code) { await assert.rejects(promise, error => error.code === code); }

integration('OTP normalization, random code, digest-only storage and persistent send cooldown', async () => {
  const email = address(); const item = await challenge(`  ${email.toUpperCase()} `);
  assert.match(item.code, /^\d{6}$/);
  const row = (await pool.query('SELECT * FROM yuqu.login_challenges WHERE id=$1', [item.challengeId])).rows[0];
  assert.equal(row.email, email); assert.equal(row.status, 'sent'); assert.notEqual(row.code_hash, item.code); assert.equal(row.code_hash.length, 64);
  await rejectsCode(challenge(email), 'RATE_LIMITED');
});
integration('a running transcription worker does not block real email challenge creation', async () => {
  const worker = await pool.connect(), sender = await pool.connect();
  try {
    await worker.query('SELECT pg_advisory_lock($1)', [TRANSCRIPTION_WORKER_LOCK]);
    await sender.query("SET statement_timeout='1s'");
    const singleConnectionPool = { connect: async () => ({ query: sender.query.bind(sender), release() {} }), query: sender.query.bind(sender) };
    const issued = await requestCode(singleConnectionPool, secret, { email: address() }, async () => 'smtp');
    assert.equal(issued.delivery, 'smtp');
    assert.equal((await sender.query('SELECT status FROM yuqu.login_challenges WHERE id=$1', [issued.challengeId])).rows[0].status, 'sent');
  } finally {
    await sender.query('RESET statement_timeout');
    await worker.query('SELECT pg_advisory_unlock($1)', [TRANSCRIPTION_WORKER_LOCK]);
    sender.release();worker.release();
  }
});
integration('failed delivery invalidates the pending challenge and still consumes send budget', async () => {
  const email = address();
  await rejectsCode(challenge(email, async () => { throw new Error('mail offline'); }), 'EMAIL_UNAVAILABLE');
  assert.equal((await pool.query('SELECT status FROM yuqu.login_challenges WHERE email=$1', [email])).rows[0].status, 'failed');
  await rejectsCode(challenge(email), 'RATE_LIMITED');
});
integration('five wrong attempts commit; correct code after lockout, expired code and replay are rejected', async () => {
  const item = await challenge(); const wrong = item.code === '000000' ? '000001' : '000000';
  for (let attempt = 0; attempt < 5; attempt++) await rejectsCode(verifyCode(pool, secret, { ...item, code: wrong, client: 'web', deviceName: 'web' }), 'INVALID_CODE');
  assert.equal((await pool.query('SELECT attempts FROM yuqu.login_challenges WHERE id=$1', [item.challengeId])).rows[0].attempts, 5);
  await rejectsCode(verifyCode(pool, secret, { ...item, client: 'web', deviceName: 'web' }), 'INVALID_CODE');
  const expired = await challenge(); await pool.query("UPDATE yuqu.login_challenges SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.challengeId]);
  await rejectsCode(verifyCode(pool, secret, { ...expired, client: 'web', deviceName: 'web' }), 'INVALID_CODE');
});
integration('concurrent OTP consumption creates exactly one session', async () => {
  const item = await challenge(); const input = { ...item, client: 'harmony', deviceName: 'phone' };
  const outcomes = await Promise.allSettled([verifyCode(pool, secret, input), verifyCode(pool, secret, input)]);
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(value => value.status === 'rejected' && value.reason.code === 'INVALID_CODE').length, 1);
  const account = outcomes.find(value => value.status === 'fulfilled').value;
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM yuqu.device_sessions WHERE user_id=$1', [account.user.id])).rows[0].count, 1);
  assert.equal((await authenticate(pool, account.token)).user.id, account.user.id);
  assert.notEqual((await pool.query('SELECT token_hash FROM yuqu.device_sessions WHERE id=$1', [account.session.id])).rows[0].token_hash, account.token);
});
integration('failure while creating a session rolls back OTP consumption and user creation', async () => {
  const item = await challenge();
  await pool.query("CREATE FUNCTION yuqu.test_fail_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test'; END $$; CREATE TRIGGER test_fail BEFORE INSERT ON yuqu.device_sessions FOR EACH ROW EXECUTE FUNCTION yuqu.test_fail_session()");
  try { await assert.rejects(verifyCode(pool, secret, { ...item, client: 'web', deviceName: 'web' })); }
  finally { await pool.query('DROP TRIGGER test_fail ON yuqu.device_sessions; DROP FUNCTION yuqu.test_fail_session()'); }
  assert.equal((await pool.query('SELECT status FROM yuqu.login_challenges WHERE id=$1', [item.challengeId])).rows[0].status, 'sent');
  assert.equal((await pool.query('SELECT id FROM yuqu.users WHERE email=$1', [item.email])).rowCount, 0);
  await verifyCode(pool, secret, { ...item, client: 'web', deviceName: 'web' });
});
integration('same normalized email has independent web/native sessions; different users stay isolated', async () => {
  const a = await login(); const b = await secondLogin(a.user.email); const other = await login();
  assert.equal(a.user.id, b.user.id); assert.notEqual(a.session.id, b.session.id);
  const takeover = await takeOver(pool, a, { requestId: randomUUID(), expectedGeneration: 0 });
  await reportPlayback(pool, a, report(takeover.snapshot));
  assert.equal((await getPlayback(pool, b)).positionMs, 42000);
  assert.equal((await getPlayback(pool, other)).positionMs, 0);
  assert.equal((await eventBatch(pool, other, null)).snapshot.revision, 0);
  await rejectsCode(reportPlayback(pool, other, report(takeover.snapshot)), 'PLAYBACK_CONFLICT');
  await revokeSession(pool, a);
  await rejectsCode(authenticate(pool, a.token), 'UNAUTHENTICATED');
  assert.equal((await authenticate(pool, b.token)).user.id, b.user.id);
  assert.equal((await getPlayback(pool, b)).ownerSessionId, null);
  assert.equal((await getPlayback(pool, b)).state, 'paused');
});
integration('simultaneous takeover has one winner; retry is idempotent and cannot reclaim ownership', async () => {
  const a = await login(); const b = await secondLogin(a.user.email);
  const requestA = { requestId: randomUUID(), expectedGeneration: 0 };
  const requestB = { requestId: randomUUID(), expectedGeneration: 0 };
  const outcomes = await Promise.allSettled([takeOver(pool, a, requestA), takeOver(pool, b, requestB)]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  const index = outcomes.findIndex(result => result.status === 'fulfilled');
  const winner = [a, b][index]; const loser = [a, b][1 - index]; const original = [requestA, requestB][index];
  const first = outcomes[index].value;
  const retried = await takeOver(pool, winner, original);
  assert.equal(retried.snapshot.revision, first.snapshot.revision); assert.equal(retried.accepted, true);
  await rejectsCode(takeOver(pool, loser, original), 'PLAYBACK_CONFLICT');
  await rejectsCode(takeOver(pool, winner, { ...original, expectedGeneration: 1 }), 'PLAYBACK_CONFLICT');
  const next = await takeOver(pool, loser, { requestId: randomUUID(), expectedGeneration: 1 });
  const late = await takeOver(pool, winner, original);
  assert.equal(late.accepted, false); assert.equal(late.snapshot.ownerSessionId, loser.session.id); assert.equal(late.snapshot.revision, next.snapshot.revision);
  await rejectsCode(reportPlayback(pool, winner, report(first.snapshot)), 'PLAYBACK_CONFLICT');
});
integration('monotonic sequence deduplicates out-of-order updates and permits rewind; invalid payloads fail', async () => {
  const a = await login(); const { snapshot } = await takeOver(pool, a, { requestId: randomUUID(), expectedGeneration: 0 });
  const first = await reportPlayback(pool, a, report(snapshot, { sequence: 10, positionMs: 90000, speed: 1.5 }));
  const old = await reportPlayback(pool, a, report(snapshot, { sequence: 9, positionMs: 100000 }));
  assert.equal(old.accepted, false); assert.equal(old.snapshot.revision, first.snapshot.revision);
  const duplicate = await reportPlayback(pool, a, report(snapshot, { sequence: 10, positionMs: 90000, speed: 1.5 }));
  assert.equal(duplicate.snapshot.revision, first.snapshot.revision);
  const rewind = await reportPlayback(pool, a, report(snapshot, { sequence: 11, positionMs: 20000, state: 'paused' }));
  assert.equal(rewind.snapshot.positionMs, 20000);
  for (const bad of [{ positionMs: NaN }, { positionMs: -1 }, { positionMs: 120001 }, { speed: Infinity }, { speed: 3 }, { mediaVersionId: 'wrong' }, { state: 'invalid' }]) await rejectsCode(reportPlayback(pool, a, report(snapshot, { sequence: 12, ...bad })), 'INVALID_INPUT');
});
integration('snapshots/events commit together, replay is ordered, expired/future cursors reset, data survives new connections', async () => {
  const a = await login(); const { snapshot } = await takeOver(pool, a, { requestId: randomUUID(), expectedGeneration: 0 });
  await reportPlayback(pool, a, report(snapshot, { sequence: 1 })); await reportPlayback(pool, a, report(snapshot, { sequence: 2, positionMs: 30000 }));
  assert.deepEqual((await eventBatch(pool, a, 0)).events.map(value => value.revision), [1, 2, 3]);
  assert.equal((await eventBatch(pool, a, 3)).events.length, 0);
  assert.equal((await eventBatch(pool, a, 999)).reset, true);
  await pool.query('DELETE FROM yuqu.user_events WHERE user_id=$1 AND revision=1', [a.user.id]);
  const reset = await eventBatch(pool, a, 0); assert.equal(reset.reset, true); assert.equal(reset.snapshot.positionMs, 30000);
  const restarted = new pg.Pool({ connectionString: url });
  try { assert.equal((await getPlayback(restarted, a)).positionMs, 30000); } finally { await restarted.end(); }
});
integration('live SSE stops after session revocation; aborted streams and malformed cursors are handled', async () => {
  const a = await login();
  const response = playbackEvents(new Request('http://127.0.0.1:3000/api/events'), pool, a);
  const reader = response.body.getReader(); const decoder = new SseDecoder(); let events = [];
  while (!events.length) events.push(...decoder.push((await reader.read()).value));
  assert.equal(events[0].event, 'snapshot');
  await revokeSession(pool, a);
  events = [];
  while (true) { const part = await reader.read(); if (part.done) break; events.push(...decoder.push(part.value)); }
  assert.equal(events.at(-1).event, 'session-expired');
  assert.throws(() => playbackEvents(new Request('http://127.0.0.1:3000/api/events', { headers: { 'Last-Event-ID': '-1' } }), pool, a));
  const controller = new AbortController(); controller.abort();
  const aborted = playbackEvents(new Request('http://127.0.0.1:3000/api/events', { signal: controller.signal }), pool, a);
  assert.equal((await aborted.body.getReader().read()).done, true);
});
integration('Cookie write origin enforcement, invalid Bearer precedence, JSON size bound and session cookie flags', async () => {
  const a = await login();
  const headers = { Cookie: `yuqu_session=${a.token}` };
  await rejectsCode(currentAccount(new Request('http://127.0.0.1:3000/api/playback', { headers }), true), 'ORIGIN_REJECTED');
  await rejectsCode(currentAccount(new Request('http://127.0.0.1:3000/api/playback', { headers: { ...headers, Origin: 'https://evil.example' } }), true), 'ORIGIN_REJECTED');
  const own = await currentAccount(new Request('http://127.0.0.1:3000/api/playback', { headers: { ...headers, Origin: 'http://127.0.0.1:3000' } }), true);
  assert.equal(own.user.id, a.user.id);
  const native = await currentAccount(new Request('http://127.0.0.1:3000/api/playback', { headers: { Authorization: `Bearer ${a.token}` } }), true); assert.equal(native.user.id, a.user.id);
  assert.throws(() => sessionToken(new Request('http://127.0.0.1/', { headers: { ...headers, Authorization: 'Bearer bad' } })));
  assert.throws(() => checkOrigin(new Request('http://127.0.0.1/', { headers: { Origin: 'null' } })));
  await rejectsCode(jsonBody(new Request('http://127.0.0.1/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(8193) })), 'BODY_TOO_LARGE');
  assert.match(sessionCookie(a.token), /HttpOnly; SameSite=Lax/); assert.match(sessionCookie('', true), /Max-Age=0/);
  assert.equal(tokenDigest(a.token).length, 64);
});

const importedFile = () => ({ storageKey: `${randomUUID()}-${randomUUID()}.media`, byteSize: 10, mimeType: 'audio/mpeg', sha256: 'a'.repeat(64), durationMs: 300000 });
integration('Bili canonical parts deduplicate and source identity persists with the automatic transcript task', async () => {
  const account=await login();
  const first=await createImport(pool,account,{url:'https://bilibili.com/video/BV1bK411W797/?p=1&spm_id_from=share'});
  const repeated=await createImport(pool,account,{url:'https://www.bilibili.com/video/BV1bK411W797'});
  assert.equal(first.id,repeated.id);assert.equal(first.sourceUrl,'https://www.bilibili.com/video/BV1bK411W797?p=1');
  const otherPart=await createImport(pool,account,{url:'https://www.bilibili.com/video/BV1bK411W797?p=2'});assert.notEqual(first.id,otherPart.id);
  const resolveSource=async(url,signal)=>{signal.throwIfAborted();assert.equal(url,'https://b23.tv/example');return {url:first.sourceUrl};};
  const short=await createImport(pool,account,{url:'https://b23.tv/example'},{resolveSource});
  assert.equal(short.id,first.id);
  await rejectsCode(createImport(pool,account,{url:'https://b23.tv/example'},{resolveSource}),'PREVIEW_LIMIT');
  const item=await claimImport(pool);const source={kind:'bilibili',url:first.sourceUrl,title:'课程 · P1 导论',bvid:'BV1bK411W797',cid:191557669,page:1};
  assert.equal(await completeImport(pool,item,{...importedFile(),source}),true);
  const imported=(await listImports(pool,account)).find(job=>job.id===first.id);
  const media=await mediaFile(pool,account,imported.mediaVersionId);
  assert.equal(media.title,source.title);assert.deepEqual(media.source,source);
  assert.equal((await transcriptPage(pool,account,media.id)).job.status,'queued');
  const remaining=await claimImport(pool);assert.equal(remaining.id,otherPart.id);
  await failImport(pool,remaining,'End of isolated test fixture');
});

integration('short-link resolution requires a valid session, preserves requested part and does not queue failures', async () => {
  const account=await login(); let calls=0;
  const resolveSource=async()=>{calls++;return {url:'https://www.bilibili.com/video/BV1bK411W797?p=2'};};
  const invalid={...account,session:{...account.session,id:randomUUID()}};
  await assert.rejects(createImport(pool,invalid,{url:'https://b23.tv/second'},{resolveSource}));
  assert.equal(calls,0);
  const short=await createImport(pool,account,{url:'https://b23.tv/second'},{resolveSource});
  const full=await createImport(pool,account,{url:'https://www.bilibili.com/video/BV1bK411W797?p=2'});
  assert.equal(short.id,full.id); assert.equal(calls,1);
  const failedAccount=await login();
  await assert.rejects(createImport(pool,failedAccount,{url:'https://b23.tv/bad'},{resolveSource:async()=>{throw new Error('short link unavailable');}}),/short link/);
  assert.deepEqual(await listImports(pool,failedAccount),[]);
  const pending=await claimImport(pool); assert.equal(pending.id,short.id);
  await failImport(pool,pending,'End of isolated short-link fixture');
});
async function readyMedia(profile, title='Test episode') {
  const item = await createImport(pool, profile, { url: `https://media.example/${randomUUID()}.mp3`, title });
  const claim = await claimImport(pool); assert.equal(claim.id, item.id);
  const file = importedFile(); assert.equal(await completeImport(pool, claim, file), true);
  const ready = (await listImports(pool, profile)).find(row => row.id === item.id);
  assert.equal((await transcriptPage(pool, profile, ready.mediaVersionId)).job.status, 'queued');
  return { id: ready.mediaVersionId, file };
}
integration('imports deduplicate within one account and keep media, tasks and retry private', async () => {
  const a=await login(),b=await login();const url='https://media.example/shared.mp3';
  const [one,two]=await Promise.all([createImport(pool,a,{url}),createImport(pool,a,{url})]);assert.equal(one.id,two.id);
  const other=await createImport(pool,b,{url});assert.notEqual(other.id,one.id);
  const claimed=await claimImport(pool);assert.equal(await completeImport(pool,claimed,importedFile()),true);
  const claimed2=await claimImport(pool);assert.equal(await completeImport(pool,claimed2,importedFile()),true);
  const aMedia=(await listLibrary(pool,a)).find(row=>row.mediaVersionId!=='fixture-pcm-v1');assert.ok(aMedia);
  assert.equal((await listImports(pool,b)).some(row=>row.id===one.id),false);
  assert.equal((await listLibrary(pool,b)).some(row=>row.mediaVersionId===aMedia.mediaVersionId),false);
  await rejectsCode(mediaFile(pool,b,aMedia.mediaVersionId),'MEDIA_NOT_FOUND');
  await rejectsCode(retryImport(pool,b,one.id),'IMPORT_NOT_FOUND');
  await reservePreview(pool,a);await rejectsCode(reservePreview(pool,a),'PREVIEW_LIMIT');
});
integration('worker leases exclude concurrent claims and discard expired or superseded writers', async () => {
  const a=await login();const item=await createImport(pool,a,{url:'https://media.example/lease.mp3'});
  const claims=await Promise.all([claimImport(pool),claimImport(pool)]);assert.equal(claims.filter(Boolean).length,1);
  const old=claims.find(Boolean);assert.equal(old.id,item.id);
  await pool.query("UPDATE yuqu.import_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[item.id]);
  assert.equal(await renewImport(pool,old),false);assert.equal(await completeImport(pool,old,importedFile()),false);
  const fresh=await claimImport(pool);assert.notEqual(fresh.leaseId,old.leaseId);
  await failImport(pool,old,'stale failure');assert.equal((await listImports(pool,a))[0].status,'downloading');
  assert.equal(await renewImport(pool,fresh),true);assert.equal(await completeImport(pool,fresh,importedFile()),true);
  assert.equal(await completeImport(pool,old,importedFile()),false);assert.equal((await listLibrary(pool,a)).length,2);
});
integration('failed imports retry at most three times and pending quota cannot be raced', async () => {
  const a=await login();const item=await createImport(pool,a,{url:'https://media.example/fail.mp3'});
  for(let i=0;i<3;i++){const claim=await claimImport(pool);await failImport(pool,claim,'download failed');if(i<2)await retryImport(pool,a,item.id);}
  await rejectsCode(retryImport(pool,a,item.id),'IMPORT_LIMIT');
  const jobs=await Promise.allSettled(Array.from({length:6},(_,i)=>createImport(pool,a,{url:`https://media.example/${i}.mp3`})));
  assert.equal(jobs.filter(row=>row.status==='fulfilled').length,5);
  await pool.query("UPDATE yuqu.import_jobs SET status='failed' WHERE user_id=$1 AND status='queued'",[a.user.id]);
});
integration('episode switching binds request target, restores per-episode position and rejects old media writes', async () => {
  const a=await login(),b=await login();const first=await readyMedia(a,'First'),second=await readyMedia(a,'Second');
  const request={requestId:randomUUID(),expectedGeneration:0,mediaVersionId:first.id};
  const chosen=await takeOver(pool,a,request);assert.equal(chosen.snapshot.durationMs,300000);assert.equal(chosen.snapshot.title,'First');
  const played=await reportPlayback(pool,a,report(chosen.snapshot,{positionMs:185000,speed:1.5,state:'paused'}));
  await rejectsCode(takeOver(pool,a,{...request,mediaVersionId:second.id}),'PLAYBACK_CONFLICT');
  await rejectsCode(takeOver(pool,b,{requestId:randomUUID(),expectedGeneration:0,mediaVersionId:first.id}),'MEDIA_NOT_FOUND');
  const next=await takeOver(pool,a,{requestId:randomUUID(),expectedGeneration:played.snapshot.generation,mediaVersionId:second.id});assert.equal(next.snapshot.positionMs,0);
  assert.equal((await takeOver(pool,a,request)).accepted,false);
  await rejectsCode(reportPlayback(pool,a,report(played.snapshot,{sequence:99})),'PLAYBACK_CONFLICT');
  const restored=await takeOver(pool,a,{requestId:randomUUID(),expectedGeneration:next.snapshot.generation,mediaVersionId:first.id});assert.equal(restored.snapshot.positionMs,185000);assert.equal(restored.snapshot.speed,1.5);
});
integration('citation replay atomically selects its media and position; retries never rewind or change intent', async () => {
  const account=await login(),peer=await secondLogin(account.user.email),other=await login();
  const cited=await readyMedia(account,'Cited episode'),playing=await readyMedia(account,'Another episode');
  const original=await takeOver(pool,account,{requestId:randomUUID(),expectedGeneration:0,mediaVersionId:cited.id});
  await reportPlayback(pool,account,report(original.snapshot,{positionMs:185000,speed:1.5}));
  const switched=await takeOver(pool,peer,{requestId:randomUUID(),expectedGeneration:1,mediaVersionId:playing.id});
  const intent={requestId:randomUUID(),expectedGeneration:2,mediaVersionId:cited.id,positionMs:12340};
  const replay=await takeOver(pool,account,intent);
  assert.equal(replay.snapshot.mediaVersionId,cited.id);assert.equal(replay.snapshot.positionMs,12340);
  assert.equal(replay.snapshot.state,'paused');assert.equal(replay.snapshot.speed,1.5);
  const events=await eventBatch(pool,peer,switched.snapshot.revision);
  assert.equal(events.events[0].positionMs,12340,'First published takeover already contains the citation position');
  await rejectsCode(reportPlayback(pool,peer,report(switched.snapshot)), 'PLAYBACK_CONFLICT');
  const progressed=await reportPlayback(pool,account,report(replay.snapshot,{positionMs:15000}));
  assert.equal((await takeOver(pool,account,intent)).snapshot.positionMs,15000,'Retry must not seek back again');
  await rejectsCode(takeOver(pool,account,{...intent,positionMs:20000}),'PLAYBACK_CONFLICT');
  await rejectsCode(takeOver(pool,account,{...intent,positionMs:undefined}),'PLAYBACK_CONFLICT');
  await rejectsCode(takeOver(pool,other,{...intent,requestId:randomUUID(),expectedGeneration:0}),'MEDIA_NOT_FOUND');
  for(const positionMs of [-1,1.5,NaN,300000,300001]) {
    await rejectsCode(takeOver(pool,account,{...intent,requestId:randomUUID(),expectedGeneration:3,positionMs}),'INVALID_INPUT');
  }
  await rejectsCode(takeOver(pool,account,{requestId:randomUUID(),expectedGeneration:3,positionMs:0}),'INVALID_INPUT');
  assert.equal((await getPlayback(pool,account)).revision,progressed.snapshot.revision);
  const zero=await takeOver(pool,account,{...intent,requestId:randomUUID(),expectedGeneration:3,positionMs:0});
  assert.equal(zero.snapshot.positionMs,0);
  assert.equal((await chatPage(pool,account,cited.id)).audioAvailable,true);
  await pool.query('UPDATE yuqu.media_versions SET audio_available=false WHERE id=$1',[cited.id]);
  assert.equal((await chatPage(pool,account,cited.id)).audioAvailable,false);
  await rejectsCode(takeOver(pool,account,{...intent,requestId:randomUUID(),expectedGeneration:4}),'MEDIA_AUDIO_REMOVED');
});
integration('authenticated media supports byte ranges, HEAD, revoke and cross-user denial', async () => {
  const a=await login(),b=await login();const media=await readyMedia(a);
  const directory=await mkdtemp(join(tmpdir(),'yuqu-media-test-'));const original=process.env.MEDIA_STORAGE_DIR;process.env.MEDIA_STORAGE_DIR=directory;
  try{
    await writeFile(join(directory,media.file.storageKey),Buffer.from('0123456789'));
    const request=(token,headers={},method='GET')=>new Request('http://127.0.0.1:3000/api/media/'+media.id,{method,headers:{Authorization:'Bearer '+token,...headers}});
    const range=await streamMedia(request(a.token,{Range:'bytes=2-5'}),media.id);assert.equal(range.status,206);assert.equal(range.headers.get('content-range'),'bytes 2-5/10');assert.equal(await range.text(),'2345');
    const head=await streamMedia(request(a.token,{},'HEAD'),media.id);assert.equal(head.headers.get('content-length'),'10');assert.equal(await head.text(),'');
    assert.equal((await streamMedia(request(a.token,{Range:'bytes=99-'}),media.id)).status,416);
    await rejectsCode(streamMedia(request(b.token),media.id),'MEDIA_NOT_FOUND');
    await revokeSession(pool,a);await rejectsCode(streamMedia(request(a.token),media.id),'UNAUTHENTICATED');
  }finally{if(original===undefined)delete process.env.MEDIA_STORAGE_DIR;else process.env.MEDIA_STORAGE_DIR=original;assert.ok(resolve(directory).startsWith(resolve(tmpdir(),'yuqu-media-test-')));await rm(directory,{recursive:true,force:true});}
});

integration('deleting media interrupts an already-open slow stream without recalling bytes already delivered', async () => {
  const account=await login(),directory=await mkdtemp(join(tmpdir(),'yuqu-slow-stream-test-'));
  const previous=process.env.MEDIA_STORAGE_DIR,controller=new AbortController();
  let reader,deadline;
  try {
    process.env.MEDIA_STORAGE_DIR=directory;
    const item=await createImport(pool,account,{url:'https://media.example/slow-stream-fixture.mp3'}),task=await claimImport(pool);
    assert.equal(task.id,item.id);
    const file={...importedFile(),byteSize:2*1024*1024};
    await writeFile(join(directory,file.storageKey),Buffer.alloc(file.byteSize,0x31));
    assert.equal(await completeImport(pool,task,file),true);
    const mediaId=(await listImports(pool,account)).find(row=>row.id===item.id).mediaVersionId;
    const response=await streamMedia(new Request('http://127.0.0.1:3000/api/media/'+mediaId,{
      signal:controller.signal,headers:{Authorization:'Bearer '+account.token}
    }),mediaId);
    assert.equal(response.status,200);assert.equal(response.headers.get('content-length'),String(file.byteSize));
    reader=response.body.getReader();
    // Consume only one chunk, then let backpressure keep the filesystem stream open.
    // These bytes are already delivered and deletion cannot retract them.
    const ended=reader.closed.then(()=>({kind:'closed'}),()=>({kind:'error'}));
    const first=await reader.read();assert.equal(first.done,false);assert.ok(first.value.byteLength>0&&first.value.byteLength<file.byteSize);
    assert.equal(first.value[0],0x31);
    const started=Date.now();await removeLibraryMedia(pool,account,mediaId,'all');
    const outcome=await Promise.race([ended,new Promise((_,reject)=>{
      deadline=setTimeout(()=>reject(new Error('Removed media stream remained open beyond the 8-second verification deadline')),8000);
    })]);
    assert.ok(['closed','error'].includes(outcome.kind));
    assert.ok(Date.now()-started<8000,'The five-second authorization poll must stop an active stream before the bounded deadline');
    assert.equal(first.value[0],0x31,'Already-delivered bytes remain readable; this is not a claim of remote cache erasure');
    await rejectsCode(streamMedia(new Request('http://127.0.0.1:3000/api/media/'+mediaId,{headers:{Authorization:'Bearer '+account.token}}),mediaId),'MEDIA_NOT_FOUND');
  } finally {
    clearTimeout(deadline);controller.abort();if(reader){await reader.cancel().catch(()=>{});reader.releaseLock();}
    if(previous===undefined)delete process.env.MEDIA_STORAGE_DIR;else process.env.MEDIA_STORAGE_DIR=previous;
    assert.ok(resolve(directory).startsWith(resolve(tmpdir(),'yuqu-slow-stream-test-')));await rm(directory,{recursive:true,force:true});
  }
});

const transcriptChunk = index => ({ index, startMs: index * 30000, endMs: (index + 1) * 30000,
  language: 'Chinese', model: { id: 'integration-pipeline', revision: 'sha256:' + 'b'.repeat(64) },
  segments: [{ startMs: index * 30000 + 100, endMs: index * 30000 + 2000, text: `测试片段 ${index}` }] });
async function transcriptFixture() {
  // All rows are in this suite's explicitly isolated _test database.
  await pool.query("UPDATE yuqu.transcript_jobs SET status='failed',lease_id=NULL,lease_until=NULL WHERE status IN ('queued','processing')");
  const account = await login(), media = await readyMedia(account);
  return { account, media };
}
integration('semantic sentences survive pagination, position lookup, replay, resume and frozen chat contexts', async () => {
  const { account, media } = await transcriptFixture();
  let task = await claimTranscript(pool);
  assert.equal(task.pipeline, 'semantic-v3');
  const semanticChunk = index => ({ ...transcriptChunk(index),
    model: { ...transcriptChunk(index).model, pipeline: 'yuqu-qwen3-episode-v3' },
    segments: index === 4 ? [{ text: '要注意程', startMs: 149000, endMs: 150000 }] : index === 5
      ? [{ text: '序是自上而下执行的，这样也可以保证顺序不会乱。', startMs: 149960, endMs: 161000, continuesPrevious: true }]
      : [{ text: `完整句${index}。`, startMs: index * 30000 + 100, endMs: index * 30000 + 2000 }] });
  for (let index = 0; index < 5; index++) await saveTranscriptChunk(pool, task, semanticChunk(index));
  const partial = await askChat(pool, account, media.id, question({ scope: 'until', positionMs: 150000 }));
  const originalContext = (await pool.query('SELECT context FROM yuqu.chat_turns WHERE id=$1', [partial.id])).rows[0].context;
  assert.equal(originalContext.segments.at(-1).text, '要注意程');
  await changeChat(pool, account, partial.id, 'cancel');
  await failTranscript(pool, task);
  await pool.query("UPDATE yuqu.transcript_jobs SET available_at=now()-interval '1 second' WHERE id=$1", [task.id]);
  task = await claimTranscript(pool);
  assert.equal(task.completedMs, 150000);
  assert.equal(task.pipeline, 'semantic-v3');
  for (let index = 5; index < 10; index++) await saveTranscriptChunk(pool, task, semanticChunk(index));
  assert.equal(await saveTranscriptChunk(pool, task, semanticChunk(5)), true);
  assert.equal(await completeTranscript(pool, task), true);
  const first = await transcriptPage(pool, account, media.id);
  const second = await transcriptPage(pool, account, media.id, first.nextCursor);
  assert.match(first.segments.at(-1).text, /^要注意程序.*保证/u);
  assert.equal(first.segments.at(-1).endMs, 161000);
  assert.equal(first.segments.at(-1).id, `${task.id}:4:0`);
  assert.equal(new Set([...first.segments, ...second.segments].map(s => s.id)).size, 9);
  const located = await transcriptPage(pool, account, media.id, -1, 155000);
  assert.equal(located.pageCursor, 3);
  assert.equal(located.segments[0].id, `${task.id}:4:0`);
  const turn = await askChat(pool, account, media.id, question({ scope: 'until', positionMs: 155000 }));
  const context = (await pool.query('SELECT context FROM yuqu.chat_turns WHERE id=$1', [turn.id])).rows[0].context;
  assert.ok(context.segments.every(segment => segment.endMs <= 155000));
  assert.ok(!context.segments.some(segment => segment.text.includes('程序')));
  assert.deepEqual((await pool.query('SELECT context FROM yuqu.chat_turns WHERE id=$1', [partial.id])).rows[0].context, originalContext);
});

integration('transcripts publish incrementally, paginate stably and isolate accounts without altering playback', async () => {
  const { account, media } = await transcriptFixture(), other = await login();
  const before = await getPlayback(pool, account);
  assert.equal((await transcriptPage(pool, account, 'fixture-pcm-v1')).job, null);
  const claims = await Promise.all([claimTranscript(pool), claimTranscript(pool)]);
  assert.equal(claims.filter(Boolean).length, 1);
  const task = claims.find(Boolean); assert.equal(task.mediaVersionId, media.id);
  assert.equal(await completeTranscript(pool, task), false);
  assert.equal(await saveTranscriptChunk(pool, task, transcriptChunk(0)), true);
  let page = await transcriptPage(pool, account, media.id);
  assert.equal(page.job.status, 'processing'); assert.equal(page.job.completedMs, 30000); assert.equal(page.nextCursor, null);
  await rejectsCode(transcriptPage(pool, other, media.id), 'MEDIA_NOT_FOUND');
  await rejectsCode(retryTranscript(pool, other, media.id), 'MEDIA_NOT_FOUND');
  await assert.rejects(saveTranscriptChunk(pool, task, transcriptChunk(2)), /Non-contiguous/);
  await assert.rejects(saveTranscriptChunk(pool, task, { ...transcriptChunk(1), model: { id: 'changed', revision: 'sha256:' + 'c'.repeat(64) } }), /model changed/);
  for (let index = 1; index < 10; index++) assert.equal(await saveTranscriptChunk(pool, task, transcriptChunk(index)), true);
  assert.equal(await completeTranscript(pool, task), true);
  page = await transcriptPage(pool, account, media.id);
  assert.equal(page.job.status, 'ready'); assert.equal(page.job.completedMs, 300000); assert.equal(page.nextCursor, 4); assert.equal(page.segments.length, 5);
  const rest = await transcriptPage(pool, account, media.id, page.nextCursor);
  assert.equal(rest.segments.length, 5); assert.equal(rest.nextCursor, null);
  assert.equal(new Set([...page.segments, ...rest.segments].map(s => s.id)).size, 10);
  const response = await getTranscriptRoute(new Request(`http://127.0.0.1:3000/api/media/${media.id}/transcript?at=185000`,
    { headers: { Authorization: `Bearer ${account.token}` } }), { params: Promise.resolve({ id: media.id }) });
  assert.equal(response.status, 200); const located = await response.json(); assert.equal(located.pageCursor, 5); assert.equal(located.segments[0].startMs, 180100);
  assert.deepEqual(await getPlayback(pool, account), before);
  await revokeSession(pool, account); await rejectsCode(transcriptPage(pool, account, media.id), 'UNAUTHENTICATED');
});
integration('expired transcription leases resume committed chunks and reject stale publication and failure', async () => {
  const { account, media } = await transcriptFixture();
  const old = await claimTranscript(pool); await saveTranscriptChunk(pool, old, transcriptChunk(0));
  await pool.query("UPDATE yuqu.transcript_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [old.id]);
  assert.equal(await renewTranscript(pool, old), false); assert.equal(await saveTranscriptChunk(pool, old, transcriptChunk(1)), false);
  const current = await claimTranscript(pool); assert.equal(current.completedMs, 30000); assert.notEqual(current.leaseId, old.leaseId);
  await failTranscript(pool, old); assert.equal((await transcriptPage(pool, account, media.id)).job.status, 'processing');
  assert.equal(await completeTranscript(pool, old), false); assert.equal(await renewTranscript(pool, current), true);
  await saveTranscriptChunk(pool, current, transcriptChunk(1));
  assert.equal((await transcriptPage(pool, account, media.id)).job.completedMs, 60000);
});
integration('worker failure keeps committed transcript, backs off then resumes once without duplicate segments', async () => {
  const { account, media } = await transcriptFixture();
  await transcribeOne(pool, {}, undefined, async (task, settings, signal, publish) => {
    await publish(transcriptChunk(0)); throw new Error('Simulated GPU failure');
  });
  let page = await transcriptPage(pool, account, media.id); assert.equal(page.job.status, 'queued'); assert.equal(page.job.completedMs, 30000);
  assert.equal(await claimTranscript(pool), null);
  await pool.query("UPDATE yuqu.transcript_jobs SET available_at=now()-interval '1 second' WHERE id=$1", [page.job.id]);
  await transcribeOne(pool, {}, undefined, async (task, settings, signal, publish) => {
    assert.equal(task.completedMs, 30000); for (let index = 1; index < 10; index++) await publish(transcriptChunk(index));
  });
  page = await transcriptPage(pool, account, media.id); assert.equal(page.job.status, 'ready'); assert.equal(page.job.attempts, 2);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM yuqu.transcript_chunks WHERE job_id=$1', [page.job.id])).rows[0].n, 10);
});
integration('transcription failure budget is bounded and manual retry retains saved work with a cooldown', async () => {
  const { account, media } = await transcriptFixture();
  let task;
  for (let attempt = 0; attempt < 3; attempt++) {
    task = await claimTranscript(pool); assert.ok(task);
    if (attempt === 0) await saveTranscriptChunk(pool, task, transcriptChunk(0));
    await failTranscript(pool, task);
    await pool.query("UPDATE yuqu.transcript_jobs SET available_at=now()-interval '1 second' WHERE id=$1", [task.id]);
  }
  assert.equal(await claimTranscript(pool), null);
  const failed = await transcriptPage(pool, account, media.id); assert.equal(failed.job.status, 'failed'); assert.equal(failed.job.completedMs, 30000);
  await rejectsCode(retryTranscript(pool, account, media.id), 'TRANSCRIPT_RETRY_WAIT');
  await pool.query("UPDATE yuqu.transcript_jobs SET updated_at=now()-interval '31 seconds' WHERE id=$1", [task.id]);
  await retryTranscript(pool, account, media.id);
  const resumed = await claimTranscript(pool); assert.equal(resumed.completedMs, 30000); assert.equal(resumed.attempts, 1);
  await failTranscript(pool, task); assert.equal((await transcriptPage(pool, account, media.id)).job.status, 'processing');
});

const bridge = { agentId: 'isolated-test-agent', projectId: 'yuqu' };
async function chatFixture() {
  await pool.query("UPDATE yuqu.chat_turns SET status='failed',lease_id=NULL,lease_until=NULL WHERE status IN ('queued','running')");
  const fixture = await transcriptFixture(), task = await claimTranscript(pool);
  for (let i = 0; i < 10; i++) await saveTranscriptChunk(pool, task, transcriptChunk(i));
  await completeTranscript(pool, task); return fixture;
}
const question = (changes = {}) => ({ requestId: randomUUID(), question: '刚才讲了什么？', positionMs: 63000, scope: 'near', ...changes });
const anchoredQuestion = (positionMs = 63000) => ({ requestId: randomUUID(), question: '解释固定片段',
  anchor: { kind: 'position', positionMs, scope: 'near', capturedAt: '2026-11-18T00:00:00.000Z', positionSource: 'local' } });
async function finishTestAnswer(turn, answer = '这是固定片段。[S1]') {
  const task = await claimChat(pool, bridge); assert.equal(task.jobId, turn.id);
  await finishChat(pool, bridge, turn.id, { leaseId: task.lease.id, result: { answer } });
  return task.payload;
}
integration('new anchored topics isolate history and followups inherit their frozen source across devices', async () => {
  const { account, media } = await chatFixture();
  const before = await checkChat(pool, account, media.id, anchoredQuestion());
  assert.equal(before.available, true); assert.equal((await chatPage(pool, account, media.id)).turns.length, 0);
  const first = await askChat(pool, account, media.id, anchoredQuestion());
  assert.equal(first.topicRootTurnId, first.id); assert.equal(first.parentTurnId, null);
  const frozen = await finishTestAnswer(first, '第一个话题。[S1]');
  const second = await askChat(pool, account, media.id, anchoredQuestion(180000));
  const separate = await finishTestAnswer(second, '另一个话题。[S1]');
  assert.deepEqual(separate.history, []);
  const peer = await secondLogin(account.user.email);
  const input = { requestId: randomUUID(), question: '继续第一个话题', parentTurnId: first.id };
  const followup = await askChat(pool, peer, media.id, input);
  assert.equal(followup.positionMs, first.positionMs); assert.deepEqual(followup.anchor, first.anchor);
  assert.equal(followup.topicRootTurnId, first.id); assert.equal(followup.parentTurnId, first.id);
  assert.equal((await askChat(pool, peer, media.id, input)).id, followup.id);
  await rejectsCode(askChat(pool, peer, media.id, { ...input, parentTurnId: second.id }), 'REQUEST_REUSED');
  await rejectsCode(askChat(pool, peer, media.id, { ...input, anchor: anchoredQuestion().anchor }), 'INVALID_INPUT');
  const continued = await finishTestAnswer(followup);
  assert.deepEqual(continued.segments, frozen.segments);
  assert.deepEqual(continued.history, [{ question: first.question, answer: '第一个话题。[S1]' }]);
  const other = await login();
  await rejectsCode(askChat(pool, other, media.id, { ...input, requestId: randomUUID() }), 'MEDIA_NOT_FOUND');
});
integration('selected transcript and answer references are resolved server-side without changing previous context', async () => {
  const { account, media } = await chatFixture(); const page = await transcriptPage(pool, account, media.id);
  const anchor = { kind: 'transcript-selection', transcriptJobId: page.job.id, throughMs: page.job.completedMs,
    segmentIds: page.segments.slice(1, 3).map(part => part.id) };
  const turn = await askChat(pool, account, media.id, { requestId: randomUUID(), question: '解释选段', anchor });
  assert.equal(turn.scope, 'selection');
  const frozen = await finishTestAnswer(turn);
  assert.deepEqual(frozen.segments.map(item => item.text), page.segments.slice(1, 3).map(item => item.text));
  await rejectsCode(checkChat(pool, account, media.id, { anchor: { ...anchor, segmentIds: [page.segments[0].id, page.segments[2].id] } }), 'INVALID_INPUT');
  await rejectsCode(checkChat(pool, account, media.id, { anchor: { kind: 'citation-selection', sourceTurnId: turn.id, citationIds: ['S2'] } }), 'INVALID_INPUT');
  const cited = await askChat(pool, account, media.id, { requestId: randomUUID(), question: '只解释这个引用',
    anchor: { kind: 'citation-selection', sourceTurnId: turn.id, citationIds: ['S1'] } });
  const payload = await finishTestAnswer(cited);
  assert.equal(payload.segments.length, 1); assert.deepEqual(payload.segments[0], frozen.segments[0]);
  assert.deepEqual(payload.history, []);
  assert.deepEqual((await pool.query('SELECT context FROM yuqu.chat_turns WHERE id=$1', [turn.id])).rows[0].context, frozen);
  await rejectsCode(chatPage(pool, account, media.id, undefined, false), 'UPGRADE_REQUIRED');
  assert.equal((await chatPage(pool, account, media.id, undefined, true)).turns.length, 2);
  const outsider = await login();
  await rejectsCode(chatPage(pool, outsider, media.id, undefined, false), 'MEDIA_NOT_FOUND');
  // Selection in the 21st lookahead item must not block a legacy-compatible page.
  await pool.query(`INSERT INTO yuqu.chat_turns(id,conversation_id,user_id,request_id,sequence,media_version_id,transcript_id,position_ms,scope,question,context,status)
    SELECT gen_random_uuid(),conversation_id,user_id,gen_random_uuid(),n,media_version_id,transcript_id,position_ms,'near','旧客户端可读记录',context,'complete'
    FROM yuqu.chat_turns CROSS JOIN generate_series(3,22) n WHERE id=$1`, [turn.id]);
  const legacyPage = await chatPage(pool, account, media.id, undefined, false);
  assert.equal(legacyPage.turns.length, 20); assert.equal(legacyPage.nextBefore, 3);
  await rejectsCode(chatPage(pool, account, media.id, 3, false), 'UPGRADE_REQUIRED');
});
integration('restoring a replay requires exact current ownership and never overwrites another device', async () => {
  const account = await login(), peer = await secondLogin(account.user.email), media = await readyMedia(account);
  const start = await takeOver(pool, account, { requestId: randomUUID(), expectedGeneration: 0, mediaVersionId: media.id, positionMs: 60000 });
  const replay = await takeOver(pool, account, { requestId: randomUUID(), expectedGeneration: start.snapshot.generation, mediaVersionId: media.id, positionMs: 10000 });
  const intent = { requestId: randomUUID(), intent: 'restore', expectedGeneration: replay.snapshot.generation,
    expectedPlaybackSessionId: replay.snapshot.playbackSessionId, mediaVersionId: media.id, positionMs: 60000, speed: 1.5, looping: true };
  await rejectsCode(takeOver(pool, peer, intent), 'PLAYBACK_CONFLICT');
  await rejectsCode(takeOver(pool, account, { ...intent, expectedPlaybackSessionId: randomUUID() }), 'PLAYBACK_CONFLICT');
  const restored = await takeOver(pool, account, intent);
  assert.equal(restored.snapshot.positionMs, 60000); assert.equal(restored.snapshot.speed, 1.5);
  assert.equal(restored.snapshot.looping, true); assert.equal(restored.snapshot.state, 'paused');
  assert.equal((await takeOver(pool, account, intent)).snapshot.generation, restored.snapshot.generation);
  await rejectsCode(takeOver(pool, account, { ...intent, speed: 1 }), 'PLAYBACK_CONFLICT');
  const newOwner = await takeOver(pool, peer, { requestId: randomUUID(), expectedGeneration: restored.snapshot.generation });
  assert.equal((await takeOver(pool, account, intent)).accepted, false);
  await rejectsCode(takeOver(pool, account, { ...intent, requestId: randomUUID() }), 'PLAYBACK_CONFLICT');
  assert.deepEqual(await getPlayback(pool, account), newOwner.snapshot);
});
integration('chat freezes media, position, transcript and history; deduplicates concurrent requests and denies cross-user access', async () => {
  const { account, media } = await chatFixture(), other = await login(), input = question();
  const [one,two] = await Promise.all([askChat(pool, account, media.id, input),askChat(pool, account, media.id, input)]);
  assert.equal(one.id,two.id); assert.equal(one.positionMs,63000);
  await rejectsCode(askChat(pool,account,media.id,{...input,positionMs:65000}),'REQUEST_REUSED');
  await rejectsCode(askChat(pool,account,media.id,question()),'CHAT_BUSY');
  await rejectsCode(chatPage(pool,other,media.id),'MEDIA_NOT_FOUND');
  await rejectsCode(changeChat(pool,other,one.id,'cancel'),'CHAT_NOT_FOUND');
  const [a,b] = await Promise.all([claimChat(pool,bridge),claimChat(pool,bridge)]);const job=a||b;assert.ok(job);assert.equal(Boolean(a)+Boolean(b),1);
  const selected=await takeOver(pool,account,{requestId:randomUUID(),expectedGeneration:0,mediaVersionId:media.id});
  await reportPlayback(pool,account,report(selected.snapshot,{positionMs:185000}));
  assert.equal(job.payload.positionMs,63000);assert.equal(job.payload.segments.length,3);assert.equal(job.payload.transcriptId,(await transcriptPage(pool,account,media.id)).job.id);
  await streamChat(pool,bridge,job.jobId,{leaseId:job.lease.id,sequence:1,text:'这是'});
  await streamChat(pool,bridge,job.jobId,{leaseId:job.lease.id,sequence:1,text:'这是'});
  await rejectsCode(streamChat(pool,bridge,job.jobId,{leaseId:job.lease.id,sequence:3,text:'这是片段'}),'EVENT_CONFLICT');
  await rejectsCode(streamChat(pool,bridge,job.jobId,{leaseId:job.lease.id,sequence:2,text:'改写'}),'EVENT_CONFLICT');
  await rejectsCode(finishChat(pool,bridge,job.jobId,{leaseId:job.lease.id,result:{answer:'这是未知引用[S999]'}}),'INVALID_INPUT');
  await rejectsCode(finishChat(pool,bridge,job.jobId,{leaseId:job.lease.id,result:{answer:'这是未知范围[S1–S4]'}}),'INVALID_INPUT');
  await finishChat(pool,bridge,job.jobId,{leaseId:job.lease.id,result:{answer:'这是已保存的文稿内容。[S1–S3][S2]'}});
  await finishChat(pool,bridge,job.jobId,{leaseId:job.lease.id,result:{answer:'这是已保存的文稿内容。[S1–S3][S2]'}});
  const page=await chatPage(pool,account,media.id);assert.equal(page.turns[0].status,'complete');assert.equal(page.turns[0].citations[0].text,'测试片段 0');
  assert.deepEqual(page.turns[0].citations, job.payload.segments);
  await askChat(pool,account,media.id,question({question:'请进一步解释。'}));const next=await claimChat(pool,bridge);
  assert.equal(next.payload.history[0].answer,'这是已保存的文稿内容。[S1–S3][S2]');
});
integration('chat cancellation and expired leases reject stale output; retries keep the original question snapshot', async () => {
  const {account,media}=await chatFixture();const turn=await askChat(pool,account,media.id,question());
  const old=await claimChat(pool,bridge);await streamChat(pool,bridge,old.jobId,{leaseId:old.lease.id,sequence:1,text:'未完成的回答'});
  await pool.query("UPDATE yuqu.chat_turns SET lease_until=now()-interval '1 second' WHERE id=$1",[turn.id]);
  const fresh=await claimChat(pool,bridge);assert.notEqual(old.lease.id,fresh.lease.id);assert.equal(fresh.attempt,2);
  await rejectsCode(heartbeatChat(pool,bridge,old.jobId,old.lease.id),'LEASE_LOST');
  await rejectsCode(failChat(pool,bridge,old.jobId,old.lease.id),'LEASE_LOST');
  assert.equal((await chatPage(pool,account,media.id)).turns[0].answer,'');
  await heartbeatChat(pool,bridge,fresh.jobId,fresh.lease.id);
  await changeChat(pool,account,turn.id,'cancel');
  await rejectsCode(streamChat(pool,bridge,fresh.jobId,{leaseId:fresh.lease.id,sequence:1,text:'迟到回答'}),'LEASE_LOST');
  await rejectsCode(finishChat(pool,bridge,fresh.jobId,{leaseId:fresh.lease.id,result:{answer:'迟到回答[S1]'}}),'LEASE_LOST');
  await pool.query("UPDATE yuqu.chat_turns SET updated_at=now()-interval '4 seconds' WHERE id=$1",[turn.id]);
  const retry=await changeChat(pool,account,turn.id,'retry');assert.equal(retry.id,turn.id);assert.equal(retry.positionMs,63000);
  const retried=await claimChat(pool,bridge);assert.deepEqual(retried.payload,old.payload);
});
integration('chat refuses missing or unprocessed transcript and never calls partial text a full episode', async () => {
  const {account,media}=await transcriptFixture();
  await rejectsCode(askChat(pool,account,media.id,question({scope:'all'})),'TRANSCRIPT_PENDING');
  const task=await claimTranscript(pool);await saveTranscriptChunk(pool,task,transcriptChunk(0));
  await rejectsCode(askChat(pool,account,media.id,question({scope:'all'})),'TRANSCRIPT_PENDING');
  await rejectsCode(askChat(pool,account,media.id,question()),'TRANSCRIPT_PENDING');
  assert.equal((await askChat(pool,account,media.id,question({positionMs:20000}))).status,'queued');
});
integration('chat history pagination stays complete under the native response byte limit and recovers after reconnection', async () => {
  const {account,media}=await chatFixture();
  for(let i=0;i<25;i++){
    const turn=await askChat(pool,account,media.id,question({question:`问题 ${i}`}));const job=await claimChat(pool,bridge);
    await finishChat(pool,bridge,job.jobId,{leaseId:job.lease.id,result:{answer:i>=20?'中'.repeat(23990)+'[S1]':`答案 ${i}[S1]`}});
    await pool.query("UPDATE yuqu.chat_turns SET created_at=now()-interval '2 minutes' WHERE id=$1",[turn.id]);
  }
  await bridgeSeen(pool,bridge);const seen=[];let before;
  do{const page=await chatPage(pool,account,media.id,before);assert.ok(Buffer.byteLength(JSON.stringify(page))<262144);assert.ok(page.turns.length<=20);assert.equal(page.bridgeOnline,true);seen.push(...page.turns.map(t=>t.sequence));before=page.nextBefore;}while(before!==null);
  assert.equal(new Set(seen).size,25);assert.equal(seen.length,25);
  const restarted=new pg.Pool({connectionString:url});try{assert.ok((await chatPage(restarted,account,media.id)).turns.length>0);}finally{await restarted.end();}
});
integration('bridge credentials are separate from user sessions and enforce the configured agent identity', async () => {
  const previousToken=process.env.YUQU_BRIDGE_TOKEN,previousAgent=process.env.YUQU_BRIDGE_AGENT_ID;
  try{
    process.env.YUQU_BRIDGE_TOKEN='bridge-test-only-secret-'.padEnd(43,'x');process.env.YUQU_BRIDGE_AGENT_ID='test-agent';
    const req=(token,agent='test-agent')=>new Request('http://127.0.0.1:3000/api/bridge/v1/health',{headers:{Authorization:`Bearer ${token}`,'x-bridge-agent-id':agent}});
    assert.equal(bridgeAccount(req(process.env.YUQU_BRIDGE_TOKEN)).agentId,'test-agent');
    assert.throws(()=>bridgeAccount(req('x'.repeat(43))),error=>error.code==='BRIDGE_UNAUTHENTICATED');
    assert.throws(()=>bridgeAccount(req(process.env.YUQU_BRIDGE_TOKEN,'another-agent')),error=>error.code==='BRIDGE_UNAUTHENTICATED');
  }finally{if(previousToken===undefined)delete process.env.YUQU_BRIDGE_TOKEN;else process.env.YUQU_BRIDGE_TOKEN=previousToken;if(previousAgent===undefined)delete process.env.YUQU_BRIDGE_AGENT_ID;else process.env.YUQU_BRIDGE_AGENT_ID=previousAgent;}
});

integration('remote ASR requires its own identity and never exposes database paths or user identity', async () => {
  const previous = { token: process.env.YUQU_ASR_WORKER_TOKEN, worker: process.env.YUQU_ASR_WORKER_ID };
  try {
    process.env.YUQU_ASR_WORKER_TOKEN = 'asr-test-only-'.padEnd(64, 'x'); process.env.YUQU_ASR_WORKER_ID = 'test-worker';
    const { account } = await transcriptFixture();
    const request = (token, worker = 'test-worker') => new Request('https://fish.example/api/asr/v1/health', {
      headers: { authorization: `Bearer ${token}`, 'x-yuqu-asr-worker': worker } });
    asrWorker(request(process.env.YUQU_ASR_WORKER_TOKEN));
    for (const token of [account.token, 'bridge-token-'.padEnd(64, 'b'), '', 'bad']) {
      assert.throws(() => asrWorker(request(token)), e => e.code === 'ASR_UNAUTHENTICATED');
    }
    assert.throws(() => asrWorker(request(process.env.YUQU_ASR_WORKER_TOKEN, 'other-worker')), e => e.code === 'ASR_UNAUTHENTICATED');
    const response = await claimAsrRoute(request(process.env.YUQU_ASR_WORKER_TOKEN));
    assert.equal(response.status, 200);
    const { job } = await response.json();
    assert.equal(job.durationMs, 300000); assert.equal(job.byteSize, 10);
    assert.equal('storageKey' in job, false); assert.equal('userId' in job, false);
    assert.equal((await claimAsrRoute(request(process.env.YUQU_ASR_WORKER_TOKEN))).status, 204);
  } finally {
    if (previous.token === undefined) delete process.env.YUQU_ASR_WORKER_TOKEN; else process.env.YUQU_ASR_WORKER_TOKEN = previous.token;
    if (previous.worker === undefined) delete process.env.YUQU_ASR_WORKER_ID; else process.env.YUQU_ASR_WORKER_ID = previous.worker;
  }
});

integration('audio cleanup keeps transcript/chat but fences playback and charges bytes until file removal', async () => {
  const {account,media}=await chatFixture(),other=await login();
  const turn=await askChat(pool,account,media.id,question()),job=await claimChat(pool,bridge);
  await finishChat(pool,bridge,job.jobId,{leaseId:job.lease.id,result:{answer:'保留文稿答案[S1]'}});
  const selected=await takeOver(pool,account,{requestId:randomUUID(),expectedGeneration:0,mediaVersionId:media.id});
  const playing=await reportPlayback(pool,account,report(selected.snapshot,{positionMs:50000,state:'playing'}));
  await rejectsCode(removeLibraryMedia(pool,other,media.id,'audio'),'MEDIA_NOT_FOUND');
  await rejectsCode(removeLibraryMedia(pool,account,'fixture-pcm-v1','all'),'MEDIA_NOT_DELETABLE');
  await rejectsCode(removeLibraryMedia(pool,account,media.id,'invalid'),'REMOVE_MODE_INVALID');
  const directory=await mkdtemp(join(tmpdir(),'yuqu-storage-test-'));
  try {
    await writeFile(join(directory,media.file.storageKey),'0123456789');
    await removeLibraryMedia(pool,account,media.id,'audio');
    const current=await getPlayback(pool,account);
    assert.equal(current.mediaVersionId,'fixture-pcm-v1');assert.equal(current.state,'paused');assert.equal(current.ownerSessionId,null);
    assert.equal(current.generation,playing.snapshot.generation+1);assert.ok(current.revision>playing.snapshot.revision);
    const events=await eventBatch(pool,account,playing.snapshot.revision);assert.equal((events.snapshot??events.events.at(-1)).mediaVersionId,'fixture-pcm-v1');
    await rejectsCode(reportPlayback(pool,account,report(playing.snapshot,{sequence:99})),'PLAYBACK_CONFLICT');
    await rejectsCode(takeOver(pool,account,{requestId:randomUUID(),expectedGeneration:current.generation,mediaVersionId:media.id}),'MEDIA_AUDIO_REMOVED');
    await rejectsCode(mediaFile(pool,account,media.id),'MEDIA_AUDIO_REMOVED');
    await rejectsCode(retryTranscript(pool,account,media.id),'MEDIA_AUDIO_REMOVED');
    assert.equal((await transcriptPage(pool,account,media.id)).job.status,'ready');
    assert.equal((await chatPage(pool,account,media.id)).turns[0].id,turn.id);
    assert.equal((await chatPage(pool,account,media.id)).turns[0].answer,'保留文稿答案[S1]');
    assert.equal((await chatPage(pool,account,media.id)).audioAvailable,false);
    const retained=(await listLibrary(pool,account)).find(x=>x.mediaVersionId===media.id);
    assert.equal(retained.audioAvailable,false);assert.equal(retained.byteSize,0);assert.equal(retained.deletable,true);
    const usage=await getStorageUsage(pool,account);assert.equal(usage.usedBytes,0);assert.equal(usage.reclaimingBytes,10);assert.equal(usage.itemCount,1);
    await access(join(directory,media.file.storageKey));
    await pool.query("UPDATE yuqu.media_cleanup_jobs SET available_at=now()+interval '1 hour'");
    await pool.query('UPDATE yuqu.media_cleanup_jobs SET available_at=now() WHERE user_id=$1',[account.user.id]);
    assert.equal(await cleanupOne(pool,directory),true);await assert.rejects(access(join(directory,media.file.storageKey)));
    assert.equal((await getStorageUsage(pool,account)).reclaimingBytes,0);
    const followup=await askChat(pool,account,media.id,question({question:'仅凭保留文稿继续提问'}));await changeChat(pool,account,followup.id,'cancel');
    await removeLibraryMedia(pool,account,media.id,'all');assert.equal((await getStorageUsage(pool,account)).itemCount,0);
  } finally {assert.ok(resolve(directory).startsWith(resolve(tmpdir(),'yuqu-storage-test-')));await rm(directory,{recursive:true,force:true});}
});

integration('full deletion fences active transcript/chat leases and removes every media reference', async () => {
  const {account,media}=await transcriptFixture();
  await pool.query("UPDATE yuqu.chat_turns SET status='failed',lease_id=NULL,lease_until=NULL WHERE status IN ('queued','running')");
  const task=await claimTranscript(pool);await saveTranscriptChunk(pool,task,transcriptChunk(0));
  await rejectsCode(removeLibraryMedia(pool,account,media.id,'audio'),'TRANSCRIPT_NOT_READY');
  assert.equal((await getStorageUsage(pool,account)).reclaimingBytes,0);
  await askChat(pool,account,media.id,question({positionMs:20000}));const chat=await claimChat(pool,bridge);
  const selected=await takeOver(pool,account,{requestId:randomUUID(),expectedGeneration:0,mediaVersionId:media.id});
  await reportPlayback(pool,account,report(selected.snapshot,{positionMs:10000,state:'playing'}));
  await removeLibraryMedia(pool,account,media.id,'all');
  assert.equal(await renewTranscript(pool,task),false);assert.equal(await saveTranscriptChunk(pool,task,transcriptChunk(1)),false);
  assert.equal(await completeTranscript(pool,task),false);await rejectsCode(leasedTranscript(pool,task.id,task.leaseId),'LEASE_LOST');
  await rejectsCode(heartbeatChat(pool,bridge,chat.jobId,chat.lease.id),'LEASE_LOST');
  await rejectsCode(finishChat(pool,bridge,chat.jobId,{leaseId:chat.lease.id,result:{answer:'迟到内容[S1]'}}),'LEASE_LOST');
  await rejectsCode(askChat(pool,account,media.id,question()),'MEDIA_NOT_FOUND');
  for(const table of ['media_versions','chat_turns','chat_conversations','transcript_jobs','playback_history','import_jobs']){
    const field=table==='media_versions'?'id':'media_version_id';
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM yuqu.${table} WHERE ${field}=$1`,[media.id])).rows[0].n,0,table);
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM yuqu.transcript_chunks WHERE job_id=$1',[task.id])).rows[0].n,0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM yuqu.user_events WHERE user_id=$1 AND payload->>'mediaVersionId'=$2",[account.user.id,media.id])).rows[0].n,0);
  assert.equal((await getPlayback(pool,account)).mediaVersionId,'fixture-pcm-v1');
});

integration('deletion races with chat and transcript writes without resurrecting removed records', async () => {
  const {account,media}=await chatFixture();
  const outcomes=await Promise.allSettled([removeLibraryMedia(pool,account,media.id,'all'),askChat(pool,account,media.id,question())]);
  assert.equal(outcomes[0].status,'fulfilled');
  if(outcomes[1].status==='rejected')assert.equal(outcomes[1].reason.code,'MEDIA_NOT_FOUND');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM yuqu.chat_conversations WHERE media_version_id=$1',[media.id])).rows[0].n,0);
  const other=await transcriptFixture(),task=await claimTranscript(pool);
  const raced=await Promise.all([removeLibraryMedia(pool,other.account,other.media.id,'all'),saveTranscriptChunk(pool,task,transcriptChunk(0))]);
  assert.equal(raced[0].removed,true);assert.equal((await pool.query('SELECT count(*)::int AS n FROM yuqu.transcript_chunks WHERE job_id=$1',[task.id])).rows[0].n,0);
});

integration('queued and failed imports can be removed, while active downloads and ready media are protected', async () => {
  const account=await login(),other=await login();
  const queued=await createImport(pool,account,{url:'https://media.example/remove-queued.mp3'});
  await rejectsCode(removeImport(pool,other,queued.id),'IMPORT_NOT_FOUND');
  await removeImport(pool,account,queued.id);assert.equal((await getStorageUsage(pool,account)).reservedBytes,0);
  const item=await createImport(pool,account,{url:'https://media.example/remove-active.mp3'}),task=await claimImport(pool);
  assert.equal(task.id,item.id);await rejectsCode(removeImport(pool,account,item.id),'IMPORT_DOWNLOADING');
  await failImport(pool,task,'fixture failure');await removeImport(pool,account,item.id);
  const usage=await getStorageUsage(pool,account);assert.equal(usage.itemCount,0);assert.equal(usage.reclaimingBytes,MAX_IMPORT_BYTES);
  const ready=await readyMedia(other);const readyJob=(await listImports(pool,other)).find(x=>x.mediaVersionId===ready.id);
  await rejectsCode(removeImport(pool,other,readyJob.id),'IMPORT_HAS_MEDIA');
});

integration('storage reservations are atomic, account-scoped and count pending cleanup before retry', async () => {
  const before=process.env.YUQU_USER_STORAGE_LIMIT_BYTES;process.env.YUQU_USER_STORAGE_LIMIT_BYTES=String(MAX_IMPORT_BYTES*2);
  const directory=await mkdtemp(join(tmpdir(),'yuqu-quota-test-'));
  try {
    const account=await login();
    const outcomes=await Promise.allSettled([1,2,3].map(i=>createImport(pool,account,{url:`https://media.example/quota-${i}.mp3`})));
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,2);
    assert.equal(outcomes.find(x=>x.status==='rejected').reason.code,'STORAGE_LIMIT');
    assert.equal((await getStorageUsage(pool,account)).reservedBytes,MAX_IMPORT_BYTES*2);
    const claimed=await claimImport(pool);assert.equal(claimed.userId,account.user.id);
    await completeImport(pool,claimed,importedFile());
    const usage=await getStorageUsage(pool,account);assert.equal(usage.usedBytes,10);assert.equal(usage.reservedBytes,MAX_IMPORT_BYTES);
    await rejectsCode(createImport(pool,account,{url:'https://media.example/quota-extra.mp3'}),'STORAGE_LIMIT');
    const pending=(await listImports(pool,account)).find(x=>x.status==='queued');await removeImport(pool,account,pending.id);
    const failed=await createImport(pool,account,{url:'https://media.example/quota-retry.mp3'}),leased=await claimImport(pool);
    assert.equal(leased.id,failed.id);await failImport(pool,leased,'fixture failure');
    await rejectsCode(retryImport(pool,account,failed.id),'STORAGE_LIMIT');
    await pool.query("UPDATE yuqu.media_cleanup_jobs SET available_at=now()+interval '1 hour'");
    await pool.query('UPDATE yuqu.media_cleanup_jobs SET available_at=now() WHERE user_id=$1',[account.user.id]);
    assert.equal(await cleanupOne(pool,directory),true);assert.equal((await getStorageUsage(pool,account)).reclaimingBytes,0);
    assert.equal((await retryImport(pool,account,failed.id)).status,'queued');await removeImport(pool,account,failed.id);
    process.env.YUQU_USER_STORAGE_LIMIT_BYTES='1';
    assert.equal((await listLibrary(pool,account)).length,2);await rejectsCode(createImport(pool,account,{url:'https://media.example/over-existing.mp3'}),'STORAGE_LIMIT');
  } finally {if(before===undefined)delete process.env.YUQU_USER_STORAGE_LIMIT_BYTES;else process.env.YUQU_USER_STORAGE_LIMIT_BYTES=before;assert.ok(resolve(directory).startsWith(resolve(tmpdir(),'yuqu-quota-test-')));await rm(directory,{recursive:true,force:true});}
});

integration('cleanup retains referenced files and retries a failed attempt without freeing quota early', async () => {
  const account=await login(),media=await readyMedia(account),directory=await mkdtemp(join(tmpdir(),'yuqu-reclaim-test-'));
  try {
    await writeFile(join(directory,media.file.storageKey),'0123456789');
    await pool.query("UPDATE yuqu.media_cleanup_jobs SET available_at=now()+interval '1 hour'");
    await pool.query('INSERT INTO yuqu.media_cleanup_jobs(storage_key,user_id,byte_size,available_at) VALUES($1,$2,10,now())',[media.file.storageKey,account.user.id]);
    await cleanupOne(pool,directory);
    assert.equal(await readFile(join(directory,media.file.storageKey),'utf8'),'0123456789');
    const queue=(await pool.query('SELECT * FROM yuqu.media_cleanup_jobs WHERE storage_key=$1',[media.file.storageKey])).rows[0];
    assert.equal(queue.attempts,1);assert.equal(queue.error_code,'CLEANUP_STILL_REFERENCED');assert.ok(queue.available_at>new Date());
    assert.equal((await getStorageUsage(pool,account)).reclaimingBytes,10);
    await removeLibraryMedia(pool,account,media.id,'all');await pool.query('UPDATE yuqu.media_cleanup_jobs SET available_at=now() WHERE storage_key=$1',[media.file.storageKey]);
    assert.equal(await cleanupOne(pool,directory),true);assert.equal((await getStorageUsage(pool,account)).reclaimingBytes,0);
    await assert.rejects(access(join(directory,media.file.storageKey)));
  } finally {assert.ok(resolve(directory).startsWith(resolve(tmpdir(),'yuqu-reclaim-test-')));await rm(directory,{recursive:true,force:true});}
});

integration('expired import leases retain old file identities across both retry and exhausted attempts', async () => {
  const account=await login(),directory=await mkdtemp(join(tmpdir(),'yuqu-expired-files-test-'));
  try {
    const item=await createImport(pool,account,{url:'https://media.example/crashed-download.mp3'}),old=await claimImport(pool);
    assert.equal(old.id,item.id);const oldKey=`${old.id}-${old.leaseId}.media`;
    await writeFile(join(directory,oldKey),'renamed before crash');
    await pool.query("UPDATE yuqu.import_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[item.id]);
    const current=await claimImport(pool);assert.equal(current.id,item.id);assert.notEqual(current.leaseId,old.leaseId);
    const oldQueue=(await pool.query('SELECT * FROM yuqu.media_cleanup_jobs WHERE storage_key=$1',[oldKey])).rows[0];
    assert.equal(oldQueue.include_partial,true);assert.ok(oldQueue.available_at>new Date());assert.equal(Number(oldQueue.byte_size),MAX_IMPORT_BYTES);
    assert.equal(await renewImport(pool,old),false);assert.equal(await completeImport(pool,old,importedFile()),false);
    const finalKey=`${current.id}-${current.leaseId}.media`;await writeFile(join(directory,`${finalKey}.part`),'partial before crash');
    await pool.query("UPDATE yuqu.import_jobs SET attempts=3,lease_until=now()-interval '1 second' WHERE id=$1",[item.id]);
    assert.equal(await claimImport(pool),null);
    assert.equal((await listImports(pool,account))[0].status,'failed');
    assert.equal((await getStorageUsage(pool,account)).reclaimingBytes,MAX_IMPORT_BYTES*2);
    await removeImport(pool,account,item.id);
    await pool.query("UPDATE yuqu.media_cleanup_jobs SET available_at=now()+interval '1 hour'");
    await pool.query('UPDATE yuqu.media_cleanup_jobs SET available_at=now() WHERE user_id=$1',[account.user.id]);
    assert.equal(await cleanupOne(pool,directory),true);assert.equal(await cleanupOne(pool,directory),true);
    await assert.rejects(access(join(directory,oldKey)));await assert.rejects(access(join(directory,`${finalKey}.part`)));
    assert.equal((await getStorageUsage(pool,account)).reclaimingBytes,0);
  } finally {assert.ok(resolve(directory).startsWith(resolve(tmpdir(),'yuqu-expired-files-test-')));await rm(directory,{recursive:true,force:true});}
});

integration('a crash at the storage limit waits for reclamation and does not block another account', async () => {
  const before=process.env.YUQU_USER_STORAGE_LIMIT_BYTES;process.env.YUQU_USER_STORAGE_LIMIT_BYTES=String(MAX_IMPORT_BYTES);
  const directory=await mkdtemp(join(tmpdir(),'yuqu-expired-quota-test-'));
  try {
    const account=await login(),other=await login();
    const item=await createImport(pool,account,{url:'https://media.example/full-crash.mp3'}),old=await claimImport(pool);assert.equal(old.id,item.id);
    await pool.query("UPDATE yuqu.import_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[item.id]);
    const otherItem=await createImport(pool,other,{url:'https://media.example/free-account.mp3'}),next=await claimImport(pool);
    assert.equal(next.id,otherItem.id);assert.equal((await listImports(pool,account))[0].status,'queued');
    assert.equal((await getStorageUsage(pool,account)).reclaimingBytes,MAX_IMPORT_BYTES);
    await completeImport(pool,next,importedFile());assert.equal(await claimImport(pool),null);
    await pool.query("UPDATE yuqu.media_cleanup_jobs SET available_at=now()+interval '1 hour'");
    await pool.query('UPDATE yuqu.media_cleanup_jobs SET available_at=now() WHERE user_id=$1',[account.user.id]);
    assert.equal(await cleanupOne(pool,directory),true);
    const recovered=await claimImport(pool);assert.equal(recovered.id,item.id);assert.notEqual(recovered.leaseId,old.leaseId);
    await completeImport(pool,recovered,importedFile());assert.equal((await getStorageUsage(pool,account)).usedBytes,10);
  } finally {if(before===undefined)delete process.env.YUQU_USER_STORAGE_LIMIT_BYTES;else process.env.YUQU_USER_STORAGE_LIMIT_BYTES=before;assert.ok(resolve(directory).startsWith(resolve(tmpdir(),'yuqu-expired-quota-test-')));await rm(directory,{recursive:true,force:true});}
});

integration('twenty quota-blocked accounts back off so the next eligible account can be claimed', async () => {
  const before=process.env.YUQU_USER_STORAGE_LIMIT_BYTES;process.env.YUQU_USER_STORAGE_LIMIT_BYTES=String(MAX_IMPORT_BYTES);
  const blocked=[];
  try {
    for(let i=0;i<20;i++){
      const account=await login(),item=await createImport(pool,account,{url:`https://media.example/blocked-${i}.mp3`});blocked.push({account,item});
      await pool.query("INSERT INTO yuqu.media_cleanup_jobs(storage_key,user_id,byte_size,available_at) VALUES($1,$2,$3,now()+interval '1 hour')",[importedFile().storageKey,account.user.id,MAX_IMPORT_BYTES]);
    }
    const eligible=await login(),item=await createImport(pool,eligible,{url:'https://media.example/eligible-after-twenty.mp3'});
    assert.equal(await claimImport(pool),null);
    const task=await claimImport(pool);assert.equal(task.id,item.id);await completeImport(pool,task,importedFile());
    for(const {account,item:blockedItem} of blocked){
      const row=(await pool.query('SELECT available_at,status FROM yuqu.import_jobs WHERE id=$1',[blockedItem.id])).rows[0];
      assert.equal(row.status,'queued');assert.ok(row.available_at>new Date());await removeImport(pool,account,blockedItem.id);
    }
  } finally {if(before===undefined)delete process.env.YUQU_USER_STORAGE_LIMIT_BYTES;else process.env.YUQU_USER_STORAGE_LIMIT_BYTES=before;}
});

integration('remote ASR fences media and writes, derives duration on the server and acknowledges lost replies idempotently', async () => {
  const previous = { token: process.env.YUQU_ASR_WORKER_TOKEN, worker: process.env.YUQU_ASR_WORKER_ID, media: process.env.MEDIA_STORAGE_DIR };
  const directory = await mkdtemp(join(tmpdir(), 'yuqu-asr-api-test-'));
  try {
    process.env.YUQU_ASR_WORKER_TOKEN = 'asr-test-only-'.padEnd(64, 'x'); process.env.YUQU_ASR_WORKER_ID = 'test-worker'; process.env.MEDIA_STORAGE_DIR = directory;
    const { media } = await transcriptFixture(), task = await claimTranscript(pool);
    await writeFile(join(directory, media.file.storageKey), '0123456789');
    const headers = { authorization: `Bearer ${process.env.YUQU_ASR_WORKER_TOKEN}`, 'x-yuqu-asr-worker': 'test-worker', 'content-type': 'application/json' };
    const action = (kind, lease = task.leaseId, body = {}) => asrActionRoute(new Request('https://fish.example/api/asr/action', {
      method: 'POST', headers, body: JSON.stringify({ leaseId: lease, ...body })
    }), { params: Promise.resolve({ id: task.id, action: kind }) });
    const audio = lease => asrMediaRoute(new Request('https://fish.example/api/asr/media', {
      headers: { ...headers, 'x-yuqu-asr-lease': lease }
    }), { params: Promise.resolve({ id: task.id }) });
    assert.equal((await audio(randomUUID())).status, 409);
    assert.equal(await (await audio(task.leaseId)).text(), '0123456789');
    assert.equal((await action('heartbeat')).status, 200);
    assert.equal((await action('chunk', task.leaseId, { chunk: transcriptChunk(0), durationMs: 30000 })).status, 200);
    assert.equal((await action('chunk', task.leaseId, { chunk: transcriptChunk(0) })).status, 200);
    assert.equal((await action('chunk', task.leaseId, { chunk: { ...transcriptChunk(0), segments: [] } })).status, 409);
    assert.equal((await action('complete', task.leaseId, { durationMs: 30000 })).status, 409);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM yuqu.transcript_chunks WHERE job_id=$1', [task.id])).rows[0].n, 1);
    await pool.query("UPDATE yuqu.transcript_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [task.id]);
    assert.equal((await audio(task.leaseId)).status, 409);
    for (const kind of ['heartbeat', 'chunk', 'complete', 'fail']) assert.equal((await action(kind, task.leaseId, { chunk: transcriptChunk(0) })).status, 409);
    const next = await claimTranscript(pool); assert.equal(next.completedMs, 30000);
    for (let i = 1; i < 10; i++) assert.equal((await action('chunk', next.leaseId, { chunk: transcriptChunk(i) })).status, 200);
    assert.equal((await action('complete', next.leaseId)).status, 200);
    assert.equal((await action('complete', next.leaseId)).status, 200);
    assert.equal((await action('complete', task.leaseId)).status, 409);
    assert.equal((await audio(next.leaseId)).status, 409);
  } finally {
    for (const [key, value] of [['YUQU_ASR_WORKER_TOKEN', previous.token], ['YUQU_ASR_WORKER_ID', previous.worker], ['MEDIA_STORAGE_DIR', previous.media]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    assert.ok(resolve(directory).startsWith(resolve(tmpdir(), 'yuqu-asr-api-test-')));
    await rm(directory, { recursive: true, force: true });
  }
});
