import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { requestCode, verifyCode } from '../packages/domain/src/auth.ts';
import { bridgeSeen } from '../packages/domain/src/chat.ts';
import { generateSummary, summariesPage, summaryEvidence, changeSummary, claimSummary, heartbeatSummary, finishSummary, failSummary, isSummaryTask, SUMMARY_PART_TASK, SUMMARY_OVERVIEW_TASK } from '../packages/domain/src/summaries.ts';
import { removeLibraryMedia } from '../packages/domain/src/storage.ts';

const url = process.env.YUQU_TEST_DATABASE_URL, pool = url ? new pg.Pool({ connectionString: url, max: 8 }) : null;
const integration = (name, work) => test(name, { skip: !url }, work);
const agent = { agentId: 'summary-test-worker', projectId: 'yuqu' }, capabilities = [SUMMARY_PART_TASK, SUMMARY_OVERVIEW_TASK];
before(async () => {
  if (!pool) return;
  assert.match(new URL(url).pathname, /_test$/u);
  assert.match((await pool.query('SELECT current_database() AS name')).rows[0].name, /_test$/u);
  await pool.query('DROP SCHEMA IF EXISTS yuqu CASCADE');
  await pool.query('DROP TABLE IF EXISTS public.yuqu_schema_migrations');
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/migrate.mjs', import.meta.url))], { env: { ...process.env, DATABASE_URL: url }, windowsHide: true, timeout: 15000 });
});
after(async () => { await pool?.end(); });
async function account() {
  let delivered; const secret = 'summaries-test-only-secret-123456789012345678901234';
  const issue = await requestCode(pool, secret, { email: `summary-${randomUUID()}@example.test` }, async value => { delivered = value; return 'local'; });
  return verifyCode(pool, secret, { ...issue, ...delivered, client: 'web', deviceName: 'summary-test' });
}
async function media(owner, count = 720, text = '主持人强调：试点只能在预算获批后开始，尚未批准全国推广。'.repeat(3)) {
  const id = randomUUID(), job = randomUUID(), chunks = Math.ceil(count / 60), duration = chunks * 30000;
  await pool.query('INSERT INTO yuqu.media_versions(id,content_id,title,duration_ms,owner_user_id,storage_key,mime_type,byte_size) VALUES($1,$2,$3,$4,$5,$6,$7,100)',
    [id, randomUUID(), '总结验收资料', duration, owner.user.id, `${randomUUID()}-${randomUUID()}.media`, 'audio/mpeg']);
  await pool.query("INSERT INTO yuqu.transcript_jobs(id,media_version_id,user_id,status,completed_ms,model,model_info) VALUES($1,$2,$3,'ready',$4,'test-model',$5)", [job, id, owner.user.id, duration, JSON.stringify({ pipeline: 'yuqu-qwen3-episode-v3' })]);
  for (let chunk = 0; chunk < chunks; chunk++) {
    const segments = Array.from({ length: Math.min(60, count - chunk * 60) }, (_, i) => ({ startMs: chunk * 30000 + i * 500, endMs: chunk * 30000 + i * 500 + 450, text: `${chunk * 60 + i + 1}：${text}` }));
    await pool.query('INSERT INTO yuqu.transcript_chunks(job_id,chunk_index,start_ms,end_ms,segments,language) VALUES($1,$2,$3,$4,$5,$6)', [job, chunk, chunk * 30000, (chunk + 1) * 30000, JSON.stringify(segments), 'Chinese']);
  }
  return { id, job };
}
const rejected = (promise, code) => assert.rejects(promise, error => error.code === code);
const claim = (types = capabilities) => claimSummary(pool, agent, types);
const response = job => ({ title: job.taskType === SUMMARY_PART_TASK ? `分段 ${job.payload.partIndex + 1}` : '汇总', points: [{ text: '试点以预算批准为前提，未批准全国推广。', citationIds: [job.taskType === SUMMARY_PART_TASK ? 'S1' : 'P1'] }] });
const complete = (job, result = response(job)) => finishSummary(pool, agent, job.jobId, { leaseId: job.lease.id, result });
const generate = (owner, source) => generateSummary(pool, owner, source.id, { requestId: randomUUID() });
async function drain() { let job; while ((job = await claim())) await complete(job); }

integration('summaries are owner-bound, ready-only, idempotent and capability negotiated before claiming', async () => {
  const owner = await account(), stranger = await account(), source = await media(owner, 3), requestId = randomUUID();
  await bridgeSeen(pool, agent, [SUMMARY_PART_TASK]);
  assert.equal((await summariesPage(pool, owner, source.id)).bridgeOnline, false);
  await bridgeSeen(pool, agent, capabilities); await bridgeSeen(pool, agent);
  assert.equal((await summariesPage(pool, owner, source.id)).bridgeOnline, true);
  const page = await generateSummary(pool, owner, source.id, { requestId });
  assert.equal(page.document.totalTasks, 1); assert.equal(page.document.status, 'queued');
  assert.equal((await generateSummary(pool, owner, source.id, { requestId })).document.id, page.document.id);
  assert.equal((await generate(owner, source)).document.id, page.document.id);
  await rejected(summariesPage(pool, stranger, source.id), 'MEDIA_NOT_FOUND');
  await rejected(changeSummary(pool, stranger, source.id, page.document.id, 'retry'), 'MEDIA_NOT_FOUND');
  const other = await media(owner, 3);
  await rejected(generateSummary(pool, owner, other.id, { requestId }), 'REQUEST_REUSED');
  await pool.query("UPDATE yuqu.transcript_jobs SET status='processing' WHERE id=$1", [other.job]);
  await rejected(generate(owner, other), 'TRANSCRIPT_PENDING');
  assert.equal(await claim(['yuqu.chat.answer.v1', 'yuqu.transcript.chapters.v1']), null);
  assert.equal(await claim([SUMMARY_OVERVIEW_TASK]), null);
  await drain();
});
integration('long summaries expose partial leaves then merge only child points with frozen exact evidence', async () => {
  const owner = await account(), source = await media(owner), page = await generate(owner, source);
  assert.ok(page.document.totalParts > 1); assert.ok(page.document.totalTasks > page.document.totalParts);
  const original = (await pool.query('SELECT segments FROM yuqu.transcript_chunks WHERE job_id=$1 ORDER BY chunk_index', [source.job])).rows;
  const first = await claim(); await complete(first);
  let current = await summariesPage(pool, owner, source.id);
  assert.equal(current.document.completedParts, 1); assert.equal(current.overview, null); assert.equal(current.parts.length, 1);
  for (let i = 1; i < page.document.totalParts; i++) await complete(await claim([SUMMARY_PART_TASK]));
  assert.equal(await claim([SUMMARY_PART_TASK]), null);
  const merge = await claim([SUMMARY_OVERVIEW_TASK]);
  assert.equal(merge.payload.isFinal, true); assert.equal(merge.payload.parts.length, page.document.totalParts);
  assert.equal(merge.payload.segments, undefined); assert.equal(merge.payload.parts[0].text, response(first).points[0].text);
  await complete(merge, { title: '整期总结', points: [{ text: '总结保留最初条件。', citationIds: ['P1', `P${page.document.totalParts}`] }] });
  current = await summariesPage(pool, owner, source.id);
  assert.equal(current.document.status, 'complete'); assert.equal(current.overview.points[0].evidenceCount, 2);
  const evidence = await summaryEvidence(pool, owner, source.id, page.document.id, merge.jobId, 0);
  assert.equal(evidence.segments[0].id, `${source.job}:0:0`); assert.equal(evidence.segments[0].text, original[0].segments[0].text);
  assert.equal('order' in evidence.segments[0], false);
  assert.deepEqual((await pool.query('SELECT segments FROM yuqu.transcript_chunks WHERE job_id=$1 ORDER BY chunk_index', [source.job])).rows, original);
  await rejected(summaryEvidence(pool, owner, source.id, page.document.id, merge.jobId, 5), 'INVALID_INPUT');
  await rejected(summaryEvidence(pool, await account(), source.id, page.document.id, merge.jobId, 0), 'MEDIA_NOT_FOUND');
});
integration('summary concurrent claims, lease expiry and exact completion retries prevent stale writes', async () => {
  const owner = await account(), source = await media(owner), page = await generate(owner, source);
  const jobs = await Promise.all([claim(), claim()]); assert.equal(jobs.filter(Boolean).length, 1);
  const old = jobs.find(Boolean);
  await pool.query("UPDATE yuqu.summary_nodes SET lease_until=now()-interval '1 second' WHERE id=$1", [old.jobId]);
  const fresh = await claim(); assert.equal(fresh.jobId, old.jobId); assert.notEqual(fresh.lease.id, old.lease.id); assert.deepEqual(fresh.payload, old.payload);
  await rejected(complete(old), 'LEASE_LOST'); await rejected(heartbeatSummary(pool, agent, old.jobId, old.lease.id), 'LEASE_LOST');
  await heartbeatSummary(pool, agent, fresh.jobId, fresh.lease.id);
  await rejected(complete(fresh, { ...response(fresh), points: [{ text: '伪造', citationIds: ['S999'] }] }), 'INVALID_INPUT');
  await complete(fresh); await complete(fresh);
  await rejected(complete(fresh, { ...response(fresh), title: '改写' }), 'LEASE_LOST');
  assert.equal((await summariesPage(pool, owner, source.id)).document.completedTasks, 1);
  await changeSummary(pool, owner, source.id, page.document.id, 'cancel');
});
integration('failed or cancelled summaries resume only unfinished nodes with unchanged source and model input', async () => {
  const owner = await account(), source = await media(owner), page = await generate(owner, source);
  const first = await claim(); await complete(first);
  const second = await claim(); await failSummary(pool, agent, second.jobId, second.lease.id);
  assert.equal((await summariesPage(pool, owner, source.id)).document.status, 'failed'); assert.equal(await claim(), null);
  await pool.query("UPDATE yuqu.transcript_chunks SET segments='[]'::jsonb WHERE job_id=$1", [source.job]);
  await changeSummary(pool, owner, source.id, page.document.id, 'retry');
  const retry = await claim(); assert.equal(retry.jobId, second.jobId); assert.deepEqual(retry.payload, second.payload);
  await changeSummary(pool, owner, source.id, page.document.id, 'cancel'); await rejected(complete(retry), 'LEASE_LOST');
  const stopped = await summariesPage(pool, owner, source.id); assert.equal(stopped.document.status, 'cancelled'); assert.equal(stopped.parts[0].id, first.jobId);
  await changeSummary(pool, owner, source.id, page.document.id, 'retry'); await drain();
  const final = await summariesPage(pool, owner, source.id); assert.equal(final.document.status, 'complete'); assert.equal(final.parts[0].id, first.jobId);
  assert.ok((await summaryEvidence(pool, owner, source.id, page.document.id, final.overview.id, 0)).segments[0].text.includes('尚未批准'));
  assert.equal((await pool.query('SELECT attempts FROM yuqu.summary_nodes WHERE id=$1', [first.jobId])).rows[0].attempts, 1);
});
integration('summary paging, archived evidence and whole-media cascading retain correct ownership and lifetime', async () => {
  const owner = await account(), source = await media(owner, 5400, '原文。'), page = await generate(owner, source);
  assert.equal(page.document.totalParts, 9); await drain();
  const first = await summariesPage(pool, owner, source.id); assert.equal(first.parts.length, 8); assert.equal(first.nextAfter, 8);
  const end = await summariesPage(pool, owner, source.id, page.document.id, 8); assert.equal(end.parts.length, 1); assert.equal(end.nextAfter, null);
  await rejected(summariesPage(pool, owner, source.id, undefined, 8), 'INVALID_INPUT');
  await rejected(summariesPage(pool, owner, source.id, randomUUID()), 'SUMMARY_NOT_FOUND');
  await removeLibraryMedia(pool, owner, source.id, 'audio');
  const archived = await summariesPage(pool, owner, source.id); assert.equal(archived.audioAvailable, false); assert.deepEqual(archived.overview, first.overview);
  assert.equal((await summaryEvidence(pool, owner, source.id, page.document.id, first.overview.id, 0)).audioAvailable, false);
  await removeLibraryMedia(pool, owner, source.id, 'all');
  assert.equal(await isSummaryTask(pool, first.overview.id), false);
  assert.equal((await pool.query('SELECT 1 FROM yuqu.summary_documents WHERE id=$1', [page.document.id])).rowCount, 0);
  await rejected(heartbeatSummary(pool, agent, first.overview.id, randomUUID()), 'LEASE_LOST');
});
integration('summary quotas ignore blocked downstream nodes and exhausted leases can explicitly retry', async () => {
  const owner = await account(), sources = await Promise.all([media(owner, 3), media(owner, 3), media(owner, 3)]);
  const first = await generate(owner, sources[0]); await generate(owner, sources[1]);
  await rejected(generate(owner, sources[2]), 'SUMMARY_LIMIT');
  const job = await claim();
  await pool.query("UPDATE yuqu.summary_nodes SET attempts=3,lease_until=now()-interval '1 second' WHERE id=$1", [job.jobId]);
  const other = await claim(); await complete(other);
  assert.equal((await summariesPage(pool, owner, sources[0].id)).document.status, 'failed');
  await generate(owner, sources[2]); await changeSummary(pool, owner, sources[0].id, first.document.id, 'retry'); await drain();
  assert.equal((await summariesPage(pool, owner, sources[0].id)).document.status, 'complete');
});
integration('upgrading summary strategy creates an explicit new document and preserves old results and request identity', async () => {
  const owner = await account(), source = await media(owner, 3), requestId = randomUUID();
  const old = await generateSummary(pool, owner, source.id, { requestId }); await drain();
  await pool.query("UPDATE yuqu.summary_documents SET strategy='hierarchical-summary-v1' WHERE id=$1", [old.document.id]);
  const before = await summariesPage(pool, owner, source.id, old.document.id);
  assert.equal(before.canGenerate, true);
  const updated = await generate(owner, source); assert.notEqual(updated.document.id, old.document.id);
  assert.equal((await generate(owner, source)).document.id, updated.document.id);
  assert.equal((await generateSummary(pool, owner, source.id, { requestId })).document.id, old.document.id);
  await drain();
  const preserved = await summariesPage(pool, owner, source.id, old.document.id);
  assert.deepEqual(preserved.overview, before.overview); assert.deepEqual(preserved.parts, before.parts);
  assert.deepEqual(await summaryEvidence(pool, owner, source.id, old.document.id, before.overview.id, 0),
    await summaryEvidence(pool, owner, source.id, old.document.id, preserved.overview.id, 0));
  assert.equal((await summariesPage(pool, owner, source.id)).canGenerate, false);
});
