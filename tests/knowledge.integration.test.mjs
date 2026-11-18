import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { requestCode, verifyCode } from '../packages/domain/src/auth.ts';
import { transaction } from '../packages/domain/src/database.ts';
import { searchTranscript, resolveTranscriptSelection, createSavedItem, listSavedItems, updateSavedItem, deleteSavedItem } from '../packages/domain/src/knowledge.ts';
import { removeLibraryMedia } from '../packages/domain/src/storage.ts';
import { listLibrary } from '../packages/domain/src/library.ts';

const url = process.env.YUQU_TEST_DATABASE_URL;
const pool = url ? new pg.Pool({ connectionString: url, max: 8 }) : null;
const integration = (name, work) => test(name, { skip: !url }, work);
before(async () => {
  if (!pool) return;
  assert.match(new URL(url).pathname, /_test$/u, 'Refusing to reset a non-test database');
  assert.match((await pool.query('SELECT current_database() AS name')).rows[0].name, /_test$/u);
  // The integration command runs test files serially: each suite owns this isolated test schema.
  await pool.query('DROP SCHEMA IF EXISTS yuqu CASCADE');
  await pool.query('DROP TABLE IF EXISTS public.yuqu_schema_migrations');
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/migrate.mjs', import.meta.url))], {
    env: { ...process.env, DATABASE_URL: url }, windowsHide: true, timeout: 15000
  });
});
after(async () => { await pool?.end(); });
async function account() {
  let delivered;
  const email = `knowledge-${randomUUID()}@example.test`, secret = 'knowledge-integration-only-secret-12345678901234567890';
  const issued = await requestCode(pool, secret, { email }, async message => { delivered = message; return 'local'; });
  return verifyCode(pool, secret, { ...issued, ...delivered, client: 'web', deviceName: 'knowledge-test' });
}
async function media(profile, durationMs = 60000, chunks = 1, words = 25) {
  const id = randomUUID(), jobId = randomUUID();
  await pool.query('INSERT INTO yuqu.media_versions(id,content_id,title,duration_ms,owner_user_id,storage_key,mime_type,byte_size) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, randomUUID(), '搜索与收藏验证', durationMs, profile.user.id, `${randomUUID()}-${randomUUID()}.media`, 'audio/mpeg', 100]);
  await pool.query(`INSERT INTO yuqu.transcript_jobs(id,media_version_id,user_id,status,completed_ms,model,model_info)
    VALUES($1,$2,$3,$4,$5,'test-model',$6)`, [jobId, id, profile.user.id, chunks * 30000 === durationMs ? 'ready' : 'processing', chunks * 30000, JSON.stringify({ pipeline: 'yuqu-qwen3-episode-v3' })]);
  const rows = Array.from({ length: chunks }, (_, index) => ({ job_id: jobId, chunk_index: index, start_ms: index * 30000, end_ms: (index + 1) * 30000,
    segments: Array.from({ length: words }, (_, word) => ({ startMs: index * 30000 + word * 400, endMs: index * 30000 + word * 400 + 350, text: `关键词，第 ${index} 块第 ${word} 句。` })), language: 'Chinese' }));
  await pool.query(`INSERT INTO yuqu.transcript_chunks(job_id,chunk_index,start_ms,end_ms,segments,language)
    SELECT job_id,chunk_index,start_ms,end_ms,segments,language FROM jsonb_to_recordset($1::jsonb)
    AS x(job_id uuid,chunk_index integer,start_ms integer,end_ms integer,segments jsonb,language text)`, [JSON.stringify(rows)]);
  return { id, jobId, source: { kind: 'transcript-selection', transcriptJobId: jobId, throughMs: chunks * 30000, segmentIds: [`${jobId}:0:0`] } };
}
const rejectsCode = (work, code) => assert.rejects(work, error => error.code === code);

integration('search paginates one frozen watermark and new searches can see newly committed speech', async () => {
  const owner = await account(), item = await media(owner);
  const first = await searchTranscript(pool, owner, item.id, '关键词');
  assert.equal(first.results.length, 20); assert.equal(first.partial, true); assert.ok(first.nextCursor);
  await pool.query('INSERT INTO yuqu.transcript_chunks(job_id,chunk_index,start_ms,end_ms,segments,language) VALUES($1,1,30000,60000,$2,$3)',
    [item.jobId, JSON.stringify([{ startMs: 30000, endMs: 32000, text: '新增关键词。' }]), 'Chinese']);
  await pool.query("UPDATE yuqu.transcript_jobs SET completed_ms=60000,status='ready' WHERE id=$1", [item.jobId]);
  const second = await searchTranscript(pool, owner, item.id, '关键词', first.nextCursor);
  assert.equal(second.results.length, 5); assert.equal(second.snapshot.throughMs, 30000); assert.equal(second.nextCursor, null);
  const latest = await searchTranscript(pool, owner, item.id, '新增关键词');
  assert.equal(latest.results.length, 1); assert.equal(latest.partial, false);
  await rejectsCode(searchTranscript(pool, owner, item.id, '不同词', first.nextCursor), 'INVALID_INPUT');
  assert.equal((await listLibrary(pool, owner)).find(row => row.mediaVersionId === item.id).transcript.completedMs, 60000);
});
integration('selection is contiguous, bound to owner and watermark, and saved text survives sentence growth', async () => {
  const owner = await account(), outsider = await account(), item = await media(owner, 60000, 1, 1);
  await pool.query('UPDATE yuqu.transcript_chunks SET segments=$2 WHERE job_id=$1 AND chunk_index=0',
    [item.jobId, JSON.stringify([{ startMs: 29000, endMs: 29900, text: '关注程' }])]);
  const request = { requestId: randomUUID(), mediaVersionId: item.id, source: item.source, note: '我的备注' };
  const saved = await createSavedItem(pool, owner, request);
  await pool.query('INSERT INTO yuqu.transcript_chunks(job_id,chunk_index,start_ms,end_ms,segments,language) VALUES($1,1,30000,60000,$2,$3)',
    [item.jobId, JSON.stringify([{ startMs: 30000, endMs: 31000, text: '序边界。', continuesPrevious: true }]), 'Chinese']);
  await pool.query("UPDATE yuqu.transcript_jobs SET completed_ms=60000,status='ready' WHERE id=$1", [item.jobId]);
  assert.equal((await createSavedItem(pool, owner, request)).id, saved.id);
  assert.equal((await listSavedItems(pool, owner)).items[0].content.text, '关注程');
  assert.equal((await searchTranscript(pool, owner, item.id, '程序')).results[0].text, '关注程序边界。');
  const old = await transaction(pool, db => resolveTranscriptSelection(db, owner, item.id, item.source));
  assert.equal(old.segments[0].text, '关注程');
  await rejectsCode(createSavedItem(pool, owner, { ...request, note: 'changed' }), 'REQUEST_REUSED');
  await rejectsCode(createSavedItem(pool, outsider, { ...request, requestId: randomUUID() }), 'MEDIA_NOT_FOUND');
  await rejectsCode(transaction(pool, db => resolveTranscriptSelection(db, owner, item.id, { ...item.source, throughMs: 45000 })), 'TRANSCRIPT_SNAPSHOT_INVALID');
  await rejectsCode(transaction(pool, db => resolveTranscriptSelection(db, owner, item.id, { ...item.source, segmentIds: [item.source.segmentIds[0], `${item.jobId}:9:0`] })), 'INVALID_INPUT');
  assert.equal((await updateSavedItem(pool, owner, saved.id, { note: '更新备注' })).note, '更新备注');
  await rejectsCode(updateSavedItem(pool, outsider, saved.id, { note: '越权' }), 'SAVED_ITEM_NOT_FOUND');
  assert.deepEqual(await deleteSavedItem(pool, outsider, saved.id), { removed: false });
  await removeLibraryMedia(pool, owner, item.id, 'audio');
  const archived = (await listSavedItems(pool, owner)).items[0];
  assert.equal(archived.audioAvailable, false); assert.equal(archived.content.text, '关注程');
  await removeLibraryMedia(pool, owner, item.id, 'all');
  assert.equal((await listSavedItems(pool, owner)).items.length, 0);
});
integration('saved answer freezes the completed answer and its per-turn citations', async () => {
  const owner = await account(), item = await media(owner, 30000), conversation = randomUUID(), turn = randomUUID();
  await pool.query('INSERT INTO yuqu.chat_conversations(id,user_id,media_version_id) VALUES($1,$2,$3)', [conversation, owner.user.id, item.id]);
  const citations = [{ id: 'S1', startMs: 0, endMs: 1000, text: '原始依据' }];
  await pool.query(`INSERT INTO yuqu.chat_turns(id,conversation_id,user_id,request_id,sequence,media_version_id,transcript_id,position_ms,scope,question,context,answer,citations,status)
    VALUES($1,$2,$3,$4,1,$5,$6,1000,'near','原问题',$7,'完成的回答 [S1]',$8,'complete')`,
    [turn, conversation, owner.user.id, randomUUID(), item.id, item.jobId, JSON.stringify({ segments: citations }), JSON.stringify(citations)]);
  const saved = await createSavedItem(pool, owner, { requestId: randomUUID(), mediaVersionId: item.id, source: { kind: 'answer', turnId: turn } });
  assert.equal(saved.content.question, '原问题'); assert.deepEqual(saved.content.citations, citations);
  await pool.query("UPDATE yuqu.chat_turns SET answer='另一个答案',citations='[]' WHERE id=$1", [turn]);
  assert.equal((await listSavedItems(pool, owner)).items[0].content.text, '完成的回答 [S1]');
});
integration('saved pagination handles timestamp ties and creation racing with full deletion leaves no orphan', async () => {
  const owner = await account(), item = await media(owner, 30000);
  const saved = await Promise.all(Array.from({ length: 4 }, () => createSavedItem(pool, owner, { requestId: randomUUID(), mediaVersionId: item.id, source: item.source })));
  await pool.query("UPDATE yuqu.saved_items SET created_at='2026-11-18T00:00:00.123456Z' WHERE user_id=$1", [owner.user.id]);
  const first = await listSavedItems(pool, owner, { limit: 2 }), second = await listSavedItems(pool, owner, { limit: 2, cursor: first.nextCursor });
  assert.equal(new Set([...first.items, ...second.items].map(row => row.id)).size, 4); assert.equal(second.nextCursor, null);
  assert.equal(saved.length, 4);
  const outcomes = await Promise.allSettled([
    createSavedItem(pool, owner, { requestId: randomUUID(), mediaVersionId: item.id, source: item.source }),
    removeLibraryMedia(pool, owner, item.id, 'all')
  ]);
  assert.equal(outcomes[1].status, 'fulfilled');
  if (outcomes[0].status === 'rejected') assert.equal(outcomes[0].reason.code, 'MEDIA_NOT_FOUND');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM yuqu.saved_items WHERE media_version_id=$1', [item.id])).rows[0].n, 0);
});
integration('four-hour authenticated database search meets the two-second P95 budget', async t => {
  const owner = await account(), item = await media(owner, 14400000, 480, 60), durations = [];
  for (let index = 0; index < 20; index++) {
    const start = performance.now(), page = await searchTranscript(pool, owner, item.id, '关键词');
    durations.push(performance.now() - start);
    assert.equal(page.results.length, 20); assert.equal(page.snapshot.throughMs, 14400000);
  }
  durations.sort((a, b) => a - b); const p95 = durations[18];
  t.diagnostic(`4h, 480 chunks, 28800 sentences, authenticated database search P95 ${p95.toFixed(1)} ms (excludes HTTP)`);
  assert.ok(p95 < 2000, `search P95 ${p95} ms exceeds target`);
});
