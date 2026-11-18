import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { requestCode, verifyCode } from '../packages/domain/src/auth.ts';
import { generateSummary, summariesPage, summaryTopicPage, summaryEvidence, claimSummary, finishSummary, changeSummary,
  SUMMARY_PART_TASK, SUMMARY_OVERVIEW_TASK, SUMMARY_PART_V2_TASK, SUMMARY_OVERVIEW_V2_TASK } from '../packages/domain/src/summaries.ts';
import { removeLibraryMedia } from '../packages/domain/src/storage.ts';
const url=process.env.YUQU_TEST_DATABASE_URL,pool=url?new pg.Pool({connectionString:url,max:8}):null;
const integration=(name,fn)=>test(name,{skip:!url},fn),agent={agentId:'topic-worker',projectId:'yuqu'},types=[SUMMARY_PART_V2_TASK,SUMMARY_OVERVIEW_V2_TASK];
before(async()=>{if(!pool)return;assert.match(new URL(url).pathname,/_test$/);assert.match((await pool.query('SELECT current_database() AS name')).rows[0].name,/_test$/);await pool.query('DROP SCHEMA IF EXISTS yuqu CASCADE');await pool.query('DROP TABLE IF EXISTS public.yuqu_schema_migrations');await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../scripts/migrate.mjs',import.meta.url))],{env:{...process.env,DATABASE_URL:url},windowsHide:true,timeout:15000});});
after(async()=>pool?.end());
async function account(){let delivered;const secret='topics-test-only-secret-123456789012345678901234';const issue=await requestCode(pool,secret,{email:`topic-${randomUUID()}@example.test`},async v=>{delivered=v;return 'local';});return verifyCode(pool,secret,{...issue,...delivered,client:'web',deviceName:'topic-test'});}
async function media(owner,count=960){const id=randomUUID(),job=randomUUID(),chunks=Math.ceil(count/60),duration=chunks*30000;await pool.query('INSERT INTO yuqu.media_versions(id,content_id,title,duration_ms,owner_user_id,storage_key,mime_type,byte_size) VALUES($1,$2,$3,$4,$5,$6,$7,100)',[id,randomUUID(),'主题完整测试',duration,owner.user.id,`${randomUUID()}-${randomUUID()}.media`,'audio/mpeg']);await pool.query("INSERT INTO yuqu.transcript_jobs(id,media_version_id,user_id,status,completed_ms,model,model_info) VALUES($1,$2,$3,'ready',$4,'test-model',$5)",[job,id,owner.user.id,duration,JSON.stringify({pipeline:'yuqu-qwen3-episode-v3'})]);for(let chunk=0;chunk<chunks;chunk++){const segments=Array.from({length:Math.min(60,count-chunk*60)},(_,i)=>({startMs:chunk*30000+i*500,endMs:chunk*30000+i*500+450,text:`原文 ${chunk*60+i}：预算批准后才可执行。`.repeat(4)}));await pool.query('INSERT INTO yuqu.transcript_chunks(job_id,chunk_index,start_ms,end_ms,segments,language) VALUES($1,$2,$3,$4,$5,$6)',[job,chunk,chunk*30000,(chunk+1)*30000,JSON.stringify(segments),'Chinese']);}return{id,job};}
const proposal=job=>job.taskType===SUMMARY_PART_V2_TASK?{title:'阶段要点',points:Array.from({length:12},(_,i)=>({text:`主题 ${job.payload.partIndex} 条件 ${i} 以预算批准为前提。`,citationIds:['S1']}))}:{title:'完整整期主题',topics:[{title:'全部主题',itemIds:job.payload.items.map(p=>p.id)}]};
const claim=()=>claimSummary(pool,agent,types),complete=(job,result=proposal(job))=>finishSummary(pool,agent,job.jobId,{leaseId:job.lease.id,result});
const rejected=(promise,code)=>assert.rejects(promise,e=>e.code===code);
async function drain(){let job;while((job=await claim()))await complete(job);}

integration('topic summaries negotiate workers, preserve every leaf point, page facts and expose the twelfth frozen evidence',async()=>{
  const owner=await account(),stranger=await account(),m=await media(owner),page=await generateSummary(pool,owner,m.id,{requestId:randomUUID()},true);assert.equal(page.document.format,'topics-v1');assert.ok(page.document.totalParts>=3);
  assert.equal(await claimSummary(pool,agent,[SUMMARY_PART_TASK,SUMMARY_OVERVIEW_TASK]),null);await rejected(summariesPage(pool,owner,m.id),'CLIENT_UPGRADE_REQUIRED');
  let job=await claim();assert.equal(job.taskType,SUMMARY_PART_V2_TASK);await complete(job);let partial=await summariesPage(pool,owner,m.id,undefined,0,true);assert.equal(partial.overview,null);assert.equal(partial.topicOverview,undefined);assert.equal(partial.parts[0].points.length,12);
  while((job=await claim())){if(job.taskType===SUMMARY_OVERVIEW_V2_TASK){const missing=proposal(job);missing.topics[0].itemIds.pop();await rejected(complete(job,missing),'INVALID_INPUT');}await complete(job);}
  const final=await summariesPage(pool,owner,m.id,undefined,0,true);assert.equal(final.document.status,'complete');assert.equal(final.overview,null);assert.equal(final.topicOverview.topics[0].pointCount,final.document.totalParts*12);
  const first=await summaryTopicPage(pool,owner,m.id,final.document.id,0);assert.equal(first.points.length,20);assert.equal(first.nextAfter,20);let all=first.points;let next=first.nextAfter;while(next!==null){const p=await summaryTopicPage(pool,owner,m.id,final.document.id,0,next);all=all.concat(p.points);next=p.nextAfter;}assert.equal(new Set(all.map(p=>`${p.nodeId}:${p.pointIndex}`)).size,final.document.totalParts*12);
  const lastPoint=all.find(p=>p.pointIndex===11),evidence=await summaryEvidence(pool,owner,m.id,final.document.id,lastPoint.nodeId,11);assert.ok(evidence.segments.length<=16);assert.ok(evidence.segments.every(s=>s.text.includes('预算批准后')));
  await rejected(summaryTopicPage(pool,stranger,m.id,final.document.id,0),'MEDIA_NOT_FOUND');await rejected(summaryTopicPage(pool,owner,m.id,final.document.id,12),'INVALID_INPUT');await rejected(summaryEvidence(pool,owner,m.id,final.document.id,lastPoint.nodeId,12),'INVALID_INPUT');
  await removeLibraryMedia(pool,owner,m.id,'audio');assert.equal((await summariesPage(pool,owner,m.id,undefined,0,true)).audioAvailable,false);assert.equal((await summaryTopicPage(pool,owner,m.id,final.document.id,0)).totalPoints,all.length);assert.equal((await summaryEvidence(pool,owner,m.id,final.document.id,lastPoint.nodeId,11)).audioAvailable,false);
});

integration('topic stop and retry preserve frozen unit mapping and stale leases cannot commit',async()=>{
  const owner=await account(),m=await media(owner,60),requestId=randomUUID(),page=await generateSummary(pool,owner,m.id,{requestId},true),first=await claim();assert.equal(page.document.totalTasks,2);
  await changeSummary(pool,owner,m.id,page.document.id,'cancel',true);await rejected(complete(first),'LEASE_LOST');await changeSummary(pool,owner,m.id,page.document.id,'retry',true);const second=await claim();assert.equal(second.jobId,first.jobId);assert.deepEqual(second.payload,first.payload);assert.notEqual(second.lease.id,first.lease.id);await complete(second);await complete(second);await drain();assert.equal((await generateSummary(pool,owner,m.id,{requestId},true)).document.id,page.document.id);
});

integration('topic upgrade leaves legacy document, request identity and original evidence unchanged',async()=>{
  const owner=await account(),m=await media(owner,60),requestId=randomUUID(),legacy=await generateSummary(pool,owner,m.id,{requestId});const oldJob=await claimSummary(pool,agent,[SUMMARY_PART_TASK,SUMMARY_OVERVIEW_TASK]);assert.equal(oldJob.taskType,SUMMARY_PART_TASK);await finishSummary(pool,agent,oldJob.jobId,{leaseId:oldJob.lease.id,result:{title:'旧总结',points:[{text:'预算批准后才可执行。',citationIds:['S1']} ]}});const oldEvidence=await summaryEvidence(pool,owner,m.id,legacy.document.id,oldJob.jobId,0);
  const fresh=await generateSummary(pool,owner,m.id,{requestId:randomUUID()},true);assert.notEqual(fresh.document.id,legacy.document.id);await drain();assert.equal((await generateSummary(pool,owner,m.id,{requestId},true)).document.id,legacy.document.id);assert.equal((await summariesPage(pool,owner,m.id,legacy.document.id)).overview.title,'旧总结');assert.deepEqual(await summaryEvidence(pool,owner,m.id,legacy.document.id,oldJob.jobId,0),oldEvidence);await rejected(summariesPage(pool,owner,m.id),'CLIENT_UPGRADE_REQUIRED');
});
