import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { requestCode, verifyCode } from '../packages/domain/src/auth.ts';
import { askChat, checkChat, chatPage, changeChat, claimChat, finishChat, bridgeSeen, RETRIEVAL_TASK_TYPE } from '../packages/domain/src/chat.ts';
import { createSavedItem, listSavedItems } from '../packages/domain/src/knowledge.ts';
import { removeLibraryMedia } from '../packages/domain/src/storage.ts';
import { retrievalCorpus } from './fixtures/retrieval-corpus.mjs';

const url = process.env.YUQU_TEST_DATABASE_URL;
const pool = url ? new pg.Pool({ connectionString: url, max: 8 }) : null;
const integration = (name, work) => test(name, { skip: !url }, work);
const secret = 'retrieval-integration-only-secret-12345678901234567890';
const oldWorker = { agentId: 'retrieval-old-worker', projectId: 'yuqu' };
const retrievalWorker = { agentId: 'retrieval-test-worker', projectId: 'yuqu' };
const rejectCode = (promise, code) => assert.rejects(promise, error => error.code === code);

before(async () => {
  if (!pool) return;
  const parsed = new URL(url);
  assert.match(parsed.pathname, /_test$/u, 'Refusing to reset a database without _test suffix');
  assert.match((await pool.query('SELECT current_database() AS name')).rows[0].name, /_test$/u);
  await pool.query('DROP SCHEMA IF EXISTS yuqu CASCADE');
  await pool.query('DROP TABLE IF EXISTS public.yuqu_schema_migrations');
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/migrate.mjs', import.meta.url))], {
    env: { ...process.env, DATABASE_URL: url }, windowsHide: true, timeout: 15000
  });
});
after(async () => { await pool?.end(); });
afterEach(async () => {
  if (!pool) return;
  // Each case creates its own account/media, but chat claims are global to the worker queue.
  // Retire a failed case's unfinished rows so the next case cannot claim another test's job.
  await pool.query("UPDATE yuqu.chat_turns SET status='failed',lease_id=NULL,lease_until=NULL WHERE status IN ('queued','running')");
});

async function account(prefix = 'retrieval') {
  let delivered;
  const issued = await requestCode(pool, secret, { email: `${prefix}-${randomUUID()}@example.test` }, async value => { delivered = value; return 'local'; });
  return verifyCode(pool, secret, { ...issued, ...delivered, client: 'web', deviceName: 'retrieval-test' });
}

async function media(owner, { ready = true, audio = true } = {}) {
  const id = randomUUID(), jobId = randomUUID(), duration = 3600000, corpus = retrievalCorpus();
  await pool.query(`INSERT INTO yuqu.media_versions(id,content_id,title,duration_ms,owner_user_id,storage_key,mime_type,byte_size,audio_available)
    VALUES($1,$2,$3,$4,$5,$6,'audio/mpeg',100,$7)`, [id, randomUUID(), '整期检索受控资料', duration, owner.user.id, `${randomUUID()}-${randomUUID()}.media`, audio]);
  await pool.query(`INSERT INTO yuqu.transcript_jobs(id,media_version_id,user_id,status,completed_ms,model,model_info)
    VALUES($1,$2,$3,$4,$5,'retrieval-test-model',$6)`, [jobId, id, owner.user.id, ready ? 'ready' : 'processing', ready ? duration : 1800000, JSON.stringify({ pipeline: 'yuqu-qwen3-episode-v3' })]);
  for (let chunk = 0; chunk < 120; chunk++) {
    const segments = corpus.slice(chunk * 6, chunk * 6 + 6).map(({ startMs, endMs, text }) => ({ startMs, endMs, text }));
    await pool.query(`INSERT INTO yuqu.transcript_chunks(job_id,chunk_index,start_ms,end_ms,segments,language)
      VALUES($1,$2,$3,$4,$5,'Chinese')`, [jobId, chunk, chunk * 30000, (chunk + 1) * 30000, JSON.stringify(segments)]);
  }
  return { id, jobId, duration };
}
const retrievalInput = (question, requestId = randomUUID()) => ({ requestId, question, anchor: { kind: 'retrieval' } });
const citeAnswer = '根据冻结文稿，缓存命中不等于文件完整，仍需核对摘要。[S1–S2]';

integration('full-episode retrieval bypasses the old all-range limit and freezes source mapping', async () => {
  const owner = await account(), item = await media(owner);
  await rejectCode(askChat(pool, owner, item.id, { requestId: randomUUID(), question: '整期内容', positionMs: 0, scope: 'all' }), 'CONTEXT_TOO_LONG');
  const countBefore = (await pool.query('SELECT count(*)::int AS n FROM yuqu.chat_turns')).rows[0].n;
  const check = await checkChat(pool, owner, item.id, { anchor: { kind: 'retrieval' } });
  assert.deepEqual(check, { available: true, positionMs: 0, scope: 'retrieval', segmentCount: 0, characterCount: 0 });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM yuqu.chat_turns')).rows[0].n, countBefore);
  const input = retrievalInput('缓存命中就能说明文件完整吗？');
  const turn = await askChat(pool, owner, item.id, input);
  assert.equal((await askChat(pool, owner, item.id, input)).id, turn.id);
  await rejectCode(askChat(pool, owner, item.id, { ...input, question: '另外的问题' }), 'REQUEST_REUSED');
  assert.equal(turn.scope, 'retrieval'); assert.equal(turn.status, 'queued'); assert.equal(turn.positionMs, 3090000);
  const payload = (await pool.query('SELECT context FROM yuqu.chat_turns WHERE id=$1', [turn.id])).rows[0].context;
  assert.equal(payload.retrieval.strategy, 'lexical-v1'); assert.equal(payload.retrieval.snapshot.throughMs, item.duration);
  assert.equal(payload.retrieval.totalSegments, 720); assert.ok(payload.retrieval.selectedSegments <= 32);
  assert.equal(payload.segments.length, payload.retrieval.selectedSegments);
  assert.deepEqual(payload.retrieval.sourceSegmentIds, payload.segments.map(row => {
    const index = Math.floor(row.startMs / 5000);
    return `${item.jobId}:${Math.floor(index / 6)}:${index % 6}`;
  }));
  assert.ok(payload.segments.some(row => row.text.includes('缓存命中并不说明文件完整')));
  assert.ok(payload.segments.reduce((n, row) => n + row.text.length, 0) <= 24000);
  assert.equal((await checkChat(pool, owner, item.id, { anchor: { kind: 'retrieval' } })).segmentCount, 0);
});

integration('retrieval readiness, ownership and capability negotiation are explicit', async () => {
  const owner = await account(), stranger = await account(), partial = await media(owner, { ready: false });
  await rejectCode(checkChat(pool, owner, partial.id, { anchor: { kind: 'retrieval' } }), 'TRANSCRIPT_PENDING');
  await pool.query("UPDATE yuqu.transcript_jobs SET status='ready' WHERE id=$1", [partial.jobId]);
  await rejectCode(checkChat(pool, owner, partial.id, { anchor: { kind: 'retrieval' } }), 'TRANSCRIPT_PENDING');
  await rejectCode(askChat(pool, owner, partial.id, retrievalInput('缓存完整吗？')), 'TRANSCRIPT_PENDING');
  await rejectCode(askChat(pool, stranger, partial.id, retrievalInput('缓存完整吗？')), 'MEDIA_NOT_FOUND');
  const item = await media(owner);
  const turn = await askChat(pool, owner, item.id, retrievalInput('路由器掉线后的最长等待多久？'));
  await bridgeSeen(pool, oldWorker, ['yuqu.chat.answer.v1']);
  assert.equal((await chatPage(pool, owner, item.id, undefined, true, true)).retrievalOnline, false);
  assert.equal(await claimChat(pool, oldWorker), null);
  await bridgeSeen(pool, retrievalWorker, ['yuqu.chat.answer.v1', RETRIEVAL_TASK_TYPE]);
  const page = await chatPage(pool, owner, item.id, undefined, true, true);
  assert.equal(page.bridgeOnline, true); assert.equal(page.retrievalOnline, true);
  await rejectCode(chatPage(pool, owner, item.id, undefined, true, false), 'UPGRADE_REQUIRED');
  const claimed = await claimChat(pool, retrievalWorker, [RETRIEVAL_TASK_TYPE]);
  assert.equal(claimed.jobId, turn.id); assert.equal(claimed.taskType, RETRIEVAL_TASK_TYPE);
  await rejectCode(finishChat(pool, retrievalWorker, turn.id, { leaseId: claimed.lease.id, result: { answer: '路由器等待依次增长，但这里没有引用。' } }), 'INVALID_INPUT');
  await finishChat(pool, retrievalWorker, turn.id, { leaseId: claimed.lease.id, result: { answer: '路由器等待依次增长，文稿说明了指数退避。[S1–S2]' } });
  assert.equal((await chatPage(pool, owner, item.id, undefined, true, true)).turns[0].scope, 'retrieval');
});

integration('no evidence completes deterministically without a bridge task and cannot be followed up', async () => {
  const owner = await account(), item = await media(owner), requestId = randomUUID();
  const before = (await pool.query('SELECT count(*)::int AS n FROM yuqu.chat_turns')).rows[0].n;
  const first = await askChat(pool, owner, item.id, retrievalInput('火星着陆器的燃料预算是多少？', requestId));
  assert.equal(first.status, 'complete'); assert.equal(first.answer, '未在这期已完成文稿中检索到与问题直接相关的原文。请尝试节目中的具体关键词，或选定原文片段后提问。检索未命中不代表节目一定没有提到，也不能据此补造答案。');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM yuqu.chat_turns')).rows[0].n, before + 1);
  assert.equal(await claimChat(pool, retrievalWorker, [RETRIEVAL_TASK_TYPE]), null);
  await rejectCode(askChat(pool, owner, item.id, { requestId: randomUUID(), question: '继续', parentTurnId: first.id }), 'RETRIEVAL_EMPTY_TOPIC');
  assert.equal((await askChat(pool, owner, item.id, retrievalInput('火星着陆器的燃料预算是多少？', requestId))).id, first.id);
});

integration('retrieval followups preserve frozen evidence through a changed transcript and stale lease', async () => {
  const owner = await account(), item = await media(owner);
  const first = await askChat(pool, owner, item.id, retrievalInput('缓存命中就能说明文件完整吗？'));
  const original = (await pool.query('SELECT context FROM yuqu.chat_turns WHERE id=$1', [first.id])).rows[0].context;
  const old = await claimChat(pool, retrievalWorker, [RETRIEVAL_TASK_TYPE]); assert.equal(old.jobId, first.id);
  await pool.query('UPDATE yuqu.transcript_chunks SET segments=$2 WHERE job_id=$1 AND chunk_index=103', [item.jobId, JSON.stringify([{ startMs: 3090000, endMs: 3095000, text: '后来修改的伪造缓存结论。' }])]);
  await pool.query("UPDATE yuqu.chat_turns SET lease_until=now()-interval '1 second' WHERE id=$1", [first.id]);
  const fresh = await claimChat(pool, retrievalWorker, [RETRIEVAL_TASK_TYPE]); assert.notEqual(fresh.lease.id, old.lease.id);
  assert.deepEqual(fresh.payload, old.payload); assert.deepEqual(fresh.payload, original);
  await rejectCode(finishChat(pool, retrievalWorker, first.id, { leaseId: old.lease.id, result: { answer: '迟到答案[S1]' } }), 'LEASE_LOST');
  await pool.query("UPDATE yuqu.chat_turns SET updated_at=now()-interval '4 seconds' WHERE id=$1", [first.id]);
  await changeChat(pool, owner, first.id, 'cancel');
  await rejectCode(finishChat(pool, retrievalWorker, first.id, { leaseId: fresh.lease.id, result: { answer: '取消后答案[S1]' } }), 'LEASE_LOST');
  await pool.query("UPDATE yuqu.chat_turns SET updated_at=now()-interval '4 seconds' WHERE id=$1", [first.id]);
  const retried = await changeChat(pool, owner, first.id, 'retry');
  assert.deepEqual((await pool.query('SELECT context FROM yuqu.chat_turns WHERE id=$1', [retried.id])).rows[0].context, original);
  const retryJob = await claimChat(pool, retrievalWorker, [RETRIEVAL_TASK_TYPE]);
  await finishChat(pool, retrievalWorker, retried.id, { leaseId: retryJob.lease.id, result: { answer: '仍以冻结文稿为准。[S1]' } });
  const next = await askChat(pool, owner, item.id, { requestId: randomUUID(), question: '缓存还需要什么校验？', parentTurnId: first.id });
  const nextContext = (await pool.query('SELECT context FROM yuqu.chat_turns WHERE id=$1', [next.id])).rows[0].context;
  assert.equal(next.scope, 'retrieval'); assert.deepEqual(nextContext.segments, original.segments); assert.deepEqual(nextContext.retrieval, original.retrieval);
  await pool.query("UPDATE yuqu.chat_turns SET status='failed',lease_id=NULL,lease_until=NULL WHERE id=$1", [retried.id]);
});

integration('retrieval citations are verified against frozen segments and saved answer content is immutable', async () => {
  const owner = await account(), item = await media(owner);
  const turn = await askChat(pool, owner, item.id, retrievalInput('缓存命中就能说明文件完整吗？'));
  const job = await claimChat(pool, retrievalWorker, [RETRIEVAL_TASK_TYPE]);
  await rejectCode(finishChat(pool, retrievalWorker, turn.id, { leaseId: job.lease.id, result: { answer: '没有引用的回答' } }), 'INVALID_INPUT');
  await rejectCode(finishChat(pool, retrievalWorker, turn.id, { leaseId: job.lease.id, result: { answer: '未知片段[S99]' } }), 'INVALID_INPUT');
  await finishChat(pool, retrievalWorker, turn.id, { leaseId: job.lease.id, result: { answer: citeAnswer } });
  const saved = await createSavedItem(pool, owner, { requestId: randomUUID(), mediaVersionId: item.id, source: { kind: 'answer', turnId: turn.id } });
  assert.equal(saved.content.text, citeAnswer); assert.equal(saved.content.citations.length, 2);
  await pool.query("UPDATE yuqu.chat_turns SET answer='后改答案',citations='[]' WHERE id=$1", [turn.id]);
  assert.equal((await listSavedItems(pool, owner)).items[0].content.text, citeAnswer);
});

integration('archived retrieval remains readable; full deletion removes chats and fences late leases', async () => {
  const owner = await account(), item = await media(owner);
  const completeTurn = await askChat(pool, owner, item.id, retrievalInput('缓存命中就能说明文件完整吗？'));
  const completeJob = await claimChat(pool, retrievalWorker, [RETRIEVAL_TASK_TYPE]);
  await finishChat(pool, retrievalWorker, completeTurn.id, { leaseId: completeJob.lease.id, result: { answer: citeAnswer } });
  await removeLibraryMedia(pool, owner, item.id, 'audio');
  assert.equal((await chatPage(pool, owner, item.id, undefined, true, true)).audioAvailable, false);
  const archived = await askChat(pool, owner, item.id, retrievalInput('缓存还需要什么校验？'));
  assert.equal(archived.scope, 'retrieval');
  const archivedJob = await claimChat(pool, retrievalWorker, [RETRIEVAL_TASK_TYPE]);
  await finishChat(pool, retrievalWorker, archived.id, { leaseId: archivedJob.lease.id, result: { answer: '归档文稿仍可读。[S1]' } });
  const late = await askChat(pool, owner, item.id, retrievalInput('路由器掉线后的最长等待多久？'));
  const lateJob = await claimChat(pool, retrievalWorker, [RETRIEVAL_TASK_TYPE]); assert.equal(lateJob.jobId, late.id);
  await removeLibraryMedia(pool, owner, item.id, 'all');
  for (const table of ['media_versions', 'transcript_jobs', 'transcript_chunks', 'chat_turns', 'chat_conversations']) {
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM yuqu.${table} WHERE ${table === 'media_versions' ? 'id' : table === 'transcript_chunks' ? 'job_id' : 'media_version_id'}=$1`, [table === 'transcript_chunks' ? item.jobId : item.id])).rows[0].n, 0, table);
  }
  await rejectCode(finishChat(pool, retrievalWorker, late.id, { leaseId: lateJob.lease.id, result: { answer: '迟到[S1]' } }), 'LEASE_LOST');
});
