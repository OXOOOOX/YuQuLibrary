import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { requestCode, verifyCode } from '../packages/domain/src/auth.ts';
import { bridgeSeen } from '../packages/domain/src/chat.ts';
import { generateChapters, chaptersPage, changeChapters, claimChapters, heartbeatChapters, finishChapters, failChapters, isChapterTask, CHAPTER_TASK_TYPE } from '../packages/domain/src/chapters.ts';
import { removeLibraryMedia } from '../packages/domain/src/storage.ts';

const url = process.env.YUQU_TEST_DATABASE_URL, pool = url ? new pg.Pool({ connectionString: url, max: 8 }) : null;
const integration = (name, work) => test(name, { skip: !url }, work);
const agent = { agentId: 'chapter-test-worker', projectId: 'yuqu' };
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
  let delivered; const secret = 'chapters-test-only-secret-123456789012345678901234';
  const issue = await requestCode(pool, secret, { email: `chapters-${randomUUID()}@example.test` }, async value => { delivered = value; return 'local'; });
  return verifyCode(pool, secret, { ...issue, ...delivered, client: 'web', deviceName: 'chapter-test' });
}
async function media(owner, count = 2, words = 330) {
  const id = randomUUID(), job = randomUUID(), duration = count * 30000;
  await pool.query('INSERT INTO yuqu.media_versions(id,content_id,title,duration_ms,owner_user_id,storage_key,mime_type,byte_size) VALUES($1,$2,$3,$4,$5,$6,$7,100)',
    [id, randomUUID(), '章节验收资料', duration, owner.user.id, `${randomUUID()}-${randomUUID()}.media`, 'audio/mpeg']);
  await pool.query("INSERT INTO yuqu.transcript_jobs(id,media_version_id,user_id,status,completed_ms,model,model_info) VALUES($1,$2,$3,'ready',$4,'test-model',$5)", [job, id, owner.user.id, duration, JSON.stringify({ pipeline: 'yuqu-qwen3-episode-v3' })]);
  for (let chunk = 0; chunk < count; chunk++) {
    const segments = Array.from({ length: words }, (_, index) => ({ startMs: chunk * 30000 + Math.floor(index * 30000 / words), endMs: chunk * 30000 + Math.floor((index + 1) * 30000 / words) - 1, text: `第${chunk * words + index + 1}句介绍章节来源。` }));
    await pool.query('INSERT INTO yuqu.transcript_chunks(job_id,chunk_index,start_ms,end_ms,segments,language) VALUES($1,$2,$3,$4,$5,$6)', [job, chunk, chunk * 30000, (chunk + 1) * 30000, JSON.stringify(segments), 'Chinese']);
  }
  return { id, job };
}
const rejected = (promise, code) => assert.rejects(promise, error => error.code === code);
const response = (job, count = 1, continuesPrevious = false) => ({ continuesPrevious, chapters: Array.from({ length: count }, (_, i) => ({
  title: `主题${i + 1}`, startSegmentId: `S${Math.floor(i * job.payload.segments.length / count) + 1}`, endSegmentId: `S${Math.floor((i + 1) * job.payload.segments.length / count)}`
})) });
const complete = (job, result = response(job)) => finishChapters(pool, agent, job.jobId, { leaseId: job.lease.id, result });

integration('chapter generation is owner-bound, idempotent, ready-only and negotiated with worker capabilities', async () => {
  const owner = await account(), stranger = await account(), source = await media(owner, 1, 3), requestId = randomUUID();
  await bridgeSeen(pool, agent, ['yuqu.chat.answer.v1']);
  assert.equal((await chaptersPage(pool, owner, source.id)).bridgeOnline, false);
  await bridgeSeen(pool, agent, ['yuqu.chat.answer.v1', CHAPTER_TASK_TYPE]); await bridgeSeen(pool, agent);
  assert.equal((await chaptersPage(pool, owner, source.id)).bridgeOnline, true);
  const first = await generateChapters(pool, owner, source.id, { requestId });
  assert.equal(first.document.status, 'queued'); assert.equal(first.document.totalBatches, 1);
  assert.equal((await generateChapters(pool, owner, source.id, { requestId })).document.id, first.document.id);
  assert.equal((await generateChapters(pool, owner, source.id, { requestId: randomUUID() })).document.id, first.document.id);
  await rejected(chaptersPage(pool, stranger, source.id), 'MEDIA_NOT_FOUND');
  await rejected(changeChapters(pool, stranger, source.id, first.document.id, 'retry'), 'MEDIA_NOT_FOUND');
  const other = await media(owner, 1, 3);
  await rejected(generateChapters(pool, owner, other.id, { requestId }), 'REQUEST_REUSED');
  await pool.query("UPDATE yuqu.transcript_jobs SET status='processing' WHERE id=$1", [other.job]);
  await rejected(generateChapters(pool, owner, other.id, { requestId: randomUUID() }), 'TRANSCRIPT_PENDING');
  await complete(await claimChapters(pool, agent));
});
integration('concurrent claims serialize each document, stale leases cannot commit, completion retries are exact', async () => {
  const owner = await account(), source = await media(owner), page = await generateChapters(pool, owner, source.id, { requestId: randomUUID() });
  const claimed = await Promise.all([claimChapters(pool, agent), claimChapters(pool, agent)]);
  assert.equal(claimed.filter(Boolean).length, 1);
  const old = claimed.find(Boolean);
  await pool.query("UPDATE yuqu.chapter_batches SET lease_until=now()-interval '1 second' WHERE id=$1", [old.jobId]);
  const fresh = await claimChapters(pool, agent);
  assert.equal(fresh.jobId, old.jobId); assert.notEqual(fresh.lease.id, old.lease.id); assert.deepEqual(fresh.payload, old.payload);
  await rejected(complete(old), 'LEASE_LOST'); await rejected(heartbeatChapters(pool, agent, old.jobId, old.lease.id), 'LEASE_LOST');
  await heartbeatChapters(pool, agent, fresh.jobId, fresh.lease.id);
  const result = response(fresh); await complete(fresh, result); await complete(fresh, result);
  await rejected(complete(fresh, { ...result, chapters: [{ ...result.chapters[0], title: '改写' }] }), 'LEASE_LOST');
  assert.equal((await chaptersPage(pool, owner, source.id)).document.completedBatches, 1);
  const next = await claimChapters(pool, agent); assert.equal(next.payload.batchIndex, 1); assert.equal(next.payload.previous.title, '主题1');
  await complete(next, response(next, 1, true));
  const final = await chaptersPage(pool, owner, source.id, page.document.id);
  assert.equal(final.document.status, 'complete'); assert.equal(final.chapters.length, 1);
  assert.equal(final.chapters[0].endSegmentId, `${source.job}:1:329`);
});
integration('failure and cancellation preserve completed batches and frozen input; retry resumes without regenerating them', async () => {
  const owner = await account(), source = await media(owner), page = await generateChapters(pool, owner, source.id, { requestId: randomUUID() });
  const first = await claimChapters(pool, agent); await complete(first);
  const second = await claimChapters(pool, agent); await failChapters(pool, agent, second.jobId, second.lease.id);
  assert.equal((await chaptersPage(pool, owner, source.id)).document.status, 'failed');
  assert.equal(await claimChapters(pool, agent), null);
  await pool.query('UPDATE yuqu.transcript_chunks SET segments=$2 WHERE job_id=$1 AND chunk_index=1', [source.job, JSON.stringify([{ startMs: 30000, endMs: 50000, text: '模拟后来修改的资料。' }])]);
  await changeChapters(pool, owner, source.id, page.document.id, 'retry');
  const retry = await claimChapters(pool, agent); assert.equal(retry.jobId, second.jobId); assert.deepEqual(retry.payload, second.payload);
  await changeChapters(pool, owner, source.id, page.document.id, 'cancel');
  await rejected(complete(retry), 'LEASE_LOST');
  const stopped = await chaptersPage(pool, owner, source.id); assert.equal(stopped.document.status, 'cancelled'); assert.equal(stopped.document.completedBatches, 1);
  await changeChapters(pool, owner, source.id, page.document.id, 'retry');
  await complete(await claimChapters(pool, agent));
  assert.equal((await chaptersPage(pool, owner, source.id)).document.status, 'complete');
});
integration('generated chapter paging is bound to its document and survives audio cleanup; whole deletion retires jobs', async () => {
  const owner = await account(), source = await media(owner), page = await generateChapters(pool, owner, source.id, { requestId: randomUUID() });
  const first = await claimChapters(pool, agent); await complete(first, response(first, 32));
  const second = await claimChapters(pool, agent); await complete(second, response(second, 10));
  const start = await chaptersPage(pool, owner, source.id); assert.equal(start.chapters.length, 40); assert.equal(start.nextAfter, 40);
  const end = await chaptersPage(pool, owner, source.id, start.document.id, start.nextAfter); assert.equal(end.chapters.length, 2); assert.equal(end.nextAfter, null);
  await rejected(chaptersPage(pool, owner, source.id, undefined, 40), 'INVALID_INPUT');
  await removeLibraryMedia(pool, owner, source.id, 'audio');
  const archived = await chaptersPage(pool, owner, source.id); assert.equal(archived.audioAvailable, false); assert.deepEqual(archived.chapters, start.chapters);
  await removeLibraryMedia(pool, owner, source.id, 'all');
  assert.equal(await isChapterTask(pool, first.jobId), false);
  assert.equal((await pool.query('SELECT 1 FROM yuqu.chapter_documents WHERE id=$1', [page.document.id])).rowCount, 0);
  await rejected(complete(first, response(first, 32)), 'LEASE_LOST');
});
integration('invalid model coverage is never stored and exhausted leases become visibly retryable', async () => {
  const owner = await account(), source = await media(owner, 1, 3), page = await generateChapters(pool, owner, source.id, { requestId: randomUUID() });
  const job = await claimChapters(pool, agent);
  await rejected(complete(job, { continuesPrevious: false, chapters: [{ title: '漏句', startSegmentId: 'S2', endSegmentId: 'S3' }] }), 'INVALID_INPUT');
  assert.equal((await chaptersPage(pool, owner, source.id)).chapters.length, 0);
  await pool.query("UPDATE yuqu.chapter_batches SET attempts=3,lease_until=now()-interval '1 second' WHERE id=$1", [job.jobId]);
  assert.equal(await claimChapters(pool, agent), null);
  assert.equal((await chaptersPage(pool, owner, source.id)).document.status, 'failed');
  await changeChapters(pool, owner, source.id, page.document.id, 'retry'); await complete(await claimChapters(pool, agent));
});
