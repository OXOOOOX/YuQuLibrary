import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const dir=new URL('../apps/harmony/entry/src/main/ets/services/',import.meta.url);
const source=fs.readFileSync(new URL('AccountSync.ets', dir),'utf8').replace(/^import .*;$/gm,'');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const diagnosticSource = fs.readFileSync(new URL('DiagnosticReport.ets', dir), 'utf8').replace(/^import .*;$/gm, '');
const diagnosticModule = { exports: {}, util: { generateRandomUUID: randomUUID } };
vm.runInNewContext(ts.transpileModule(diagnosticSource, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
} }).outputText, diagnosticModule);
const diagnosticApi = diagnosticModule.exports;
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};};
const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const clone=v=>JSON.parse(JSON.stringify(v));
function create(){
 let now=1800000000000;const requests=[],streams=[],calls=[];let reportCount=0,maxReports=0;
 const record={value:undefined,saves:0,clears:0};
 let snapshot={contentId:'yuqu-playback-check-v1',mediaVersionId:'fixture-pcm-v1',positionMs:12000,durationMs:120000,speed:1,state:'paused',revision:0,generation:0,sequence:0,ownerSessionId:null,playbackSessionId:null,looping:false,updatedAt:new Date(now).toISOString()};
 const profile={user:{id:'u1',email:'a@example.com'},session:{id:'s1',deviceName:'鸿蒙手机',client:'harmony',expiresAt:new Date(now+86400000).toISOString()}};
 const player={state:{mediaVersionId:'fixture-pcm-v1',contentId:'yuqu-playback-check-v1',title:'样本',buffering:false,ready:true,busy:false,playerState:'paused',positionMs:0,durationMs:120000,rate:1,looping:false,backgroundActive:false,backgroundStatus:'未申请',foreground:true,error:'',events:[]},listeners:[],
 getSnapshot(){return {...this.state,events:[...this.state.events]};},subscribe(f){this.listeners.push(f);f(this.getSnapshot());return()=>this.listeners.splice(this.listeners.indexOf(f),1);},emit(){for(const f of this.listeners)f(this.getSnapshot());},
 clearDiagnosticReports(){this.state.diagnosticIncidentId='';},
 setPlaybackPermission(f){this.permission=f;},cancelMediaLoading(){calls.push('cancel-load');},
 async loadMedia(contentId,mediaVersionId,title,base='',token=''){calls.push(['load',mediaVersionId,base]);Object.assign(this.state,{contentId,mediaVersionId,title,ready:true,positionMs:0,durationMs:mediaVersionId==='fixture-pcm-v1'?120000:240000,playerState:'prepared'});this.emit();},
 async loadFixture(){await this.loadMedia('yuqu-playback-check-v1','fixture-pcm-v1','样本');},
 async pause(){calls.push('pause');this.state.playerState='paused';this.emit();},async play(){calls.push('play');this.state.playerState='playing';this.emit();},
 async seek(p){calls.push(['seek',p]);this.state.positionMs=p;this.state.events.unshift(`${calls.length} 跳转完成`);this.emit();},
 async setRate(r){calls.push(['rate',r]);this.state.rate=r;this.emit();},async setLooping(l){calls.push(['loop',l]);this.state.looping=l;this.emit();}};
 let handler=async(path,body)=>{
 if(path==='/api/library')return {items:[]};if(path==='/api/imports'&&!body)return {jobs:[]};
 if(path==='/api/auth/request-code')return {challengeId:'c1',expiresIn:600,retryAfter:60,delivery:'local'};
 if(path==='/api/auth/verify-code')return {...profile,token:'secret-token'};
 if(path==='/api/auth/me')return profile;
 if(path==='/api/auth/logout')return {};
 if(path==='/api/playback')return {snapshot:clone(snapshot)};
 if(path==='/api/playback/takeover'){snapshot={...snapshot,generation:body.expectedGeneration+1,revision:snapshot.revision+1,sequence:0,ownerSessionId:'s1',playbackSessionId:'p1',state:'paused',updatedAt:new Date(now).toISOString()};return {snapshot:clone(snapshot),accepted:true};}
 if(path==='/api/playback/report'){snapshot={...snapshot,...body,revision:snapshot.revision+1,updatedAt:new Date(now).toISOString()};return {snapshot:clone(snapshot),accepted:true};}
 throw new Error(path);
 };
 const initialHandler=handler;
 class FakeVault{async load(){return record.value;} async save(v){record.saves++;record.value=clone(v);}async clear(){record.clears++;record.value=undefined;}}
 class FakeStream{constructor(event,state){this.event=event;this.state=state;this.foreground=true;streams.push(this);}start(url,token){this.url=url;this.token=token;this.state({status:'connected'});}stop(){this.token='';this.state({status:'stopped'});}setForeground(v){this.foreground=v;}reconnect(){}}
 class FakeRequest{destroyed=false;destroy(){this.destroyed=true;}async request(url,options){const path=new URL(url).pathname;const body=options.extraData?JSON.parse(options.extraData):undefined;const req={path,body,options};requests.push(req);if(path==='/api/playback/report'){reportCount++;maxReports=Math.max(maxReports,reportCount);}try{const v=await handler(path,body,options);if(v?.__status)return {responseCode:v.__status,result:JSON.stringify(v.reply)};return {responseCode:200,result:JSON.stringify(v)};}finally{if(path==='/api/playback/report')reportCount--;}}}
 class Clock extends Date{constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}}
 const context={...diagnosticApi,exports:{},Date:Clock,JSON,Number,Math,Error,Promise,Record:undefined,
 http:{RequestMethod:{GET:'GET',POST:'POST'},HttpDataType:{STRING:0},createHttp:()=>new FakeRequest()},
 util:{generateRandomUUID:()=>`req-${requests.length}`},PlaybackService:{getInstance:()=>player},SessionVault:FakeVault,EventStream:FakeStream,
 setInterval:()=>1,clearInterval:()=>{},setTimeout,clearTimeout};vm.runInNewContext(compiled,context);
 const account=context.exports.AccountSync.getInstance();
 return {account,player,record,requests,streams,calls,profile,setHandler:f=>handler=f,initialHandler,setSnapshot:v=>snapshot=v,getSnapshot:()=>clone(snapshot),advance:ms=>now+=ms,getMax:()=>maxReports};
}
async function signIn(e){await e.account.initialize();await e.account.requestCode('http://127.0.0.1:3000','a@example.com');await e.account.verifyCode('http://127.0.0.1:3000','a@example.com','123456');await settle();}
const checks=[];
{
 const e=create();await signIn(e);assert.equal(e.account.getSnapshot().loggedIn,true);assert.equal(e.account.getSnapshot().owner,false);assert.equal(e.calls.includes('play'),false);assert.equal(e.record.value.token,'secret-token');assert.equal(e.requests.some(r=>r.path.includes('/report')),false);checks.push('login stores device credentials and follows without autoplay');
 await e.account.takeover();await settle();assert.equal(e.account.getSnapshot().owner,true);assert.equal(e.player.state.playerState,'playing');assert.ok(e.calls.findIndex(c=>Array.isArray(c)&&c[0]==='seek')<e.calls.indexOf('play'));checks.push('explicit CAS takeover aligns before play');
 const seeks=e.calls.filter(c=>Array.isArray(c)&&c[0]==='seek').length;e.player.state.positionMs=50000;const s={...e.getSnapshot(),revision:99,positionMs:1000};e.streams[0].event({event:'playback',data:JSON.stringify(s),id:'99'});assert.equal(e.player.state.positionMs,50000);assert.equal(e.calls.filter(c=>Array.isArray(c)&&c[0]==='seek').length,seeks);checks.push('own acknowledgements never seek back');
 e.account.setForeground(false);assert.equal(e.streams[0].foreground,true);await e.account.playOrPause();await settle();assert.equal(e.streams[0].foreground,false);checks.push('background playing retains transport; paused releases it');
 const peer={...s,revision:100,generation:s.generation+1,ownerSessionId:'s2',playbackSessionId:'p2'};e.streams[0].event({event:'playback',data:JSON.stringify(peer),id:'100'});await settle();assert.equal(e.account.getSnapshot().owner,false);assert.equal(e.player.state.playerState,'paused');const count=e.requests.filter(r=>r.path.endsWith('/report')).length;await e.account.seek(80000);e.advance(5000);e.account.tick();await settle();assert.equal(e.requests.filter(r=>r.path.endsWith('/report')).length,count);checks.push('owner loss pauses and prevents writes or controls');
 e.account.release();
}
{
 const e=create();await signIn(e);e.setHandler(async(p,b,o)=>p.endsWith('/takeover')?{accepted:false,snapshot:{...e.getSnapshot(),revision:1,generation:b.expectedGeneration+1,ownerSessionId:'s1',playbackSessionId:'p1'}}:e.initialHandler(p,b,o));await e.account.takeover();assert.equal(e.calls.includes('play'),false);assert.equal(e.account.getSnapshot().owner,false);checks.push('accepted=false cannot activate playback even with matching owner');e.account.release();
}
{
 const e=create();await signIn(e);await e.account.takeover();await settle();const d=deferred();let reports=0;const bodies=[];e.setHandler(async(p,b,o)=>{if(p.endsWith('/report')){bodies.push(clone(b));if(++reports===1)return await d.promise;}return e.initialHandler(p,b,o);});
 await e.account.seek(20000);await settle();await e.account.seek(35000);await settle();assert.equal(reports,1);d.reject(new Error('network lost'));await settle();e.advance(3001);e.account.tick();await settle();assert.equal(e.getMax(),1);assert.deepEqual(bodies[0],bodies[1]);assert.equal(bodies.at(-1).positionMs,35000);assert.equal(bodies.at(-1).sequence,bodies[0].sequence+1);checks.push('one in-flight report; ambiguous retry keeps original seq and payload; newer state coalesces');e.account.release();
}
{
 const e=create();await e.account.initialize();await e.account.requestCode('http://127.0.0.1:3000','a@example.com');const d=deferred();e.setHandler((p,b,o)=>p.endsWith('/verify-code')?d.promise:e.initialHandler(p,b,o));const verify=e.account.verifyCode('http://127.0.0.1:3000','a@example.com','123456');await settle();await e.account.logout();d.resolve({...e.profile,token:'late-token'});await verify;assert.equal(e.account.getSnapshot().loggedIn,false);assert.equal(e.record.saves,0);checks.push('late verification cannot resurrect logged-out session');e.account.release();
}
{
 const e=create();await signIn(e);const old={...e.getSnapshot(),revision:20,updatedAt:'2000-01-01T00:00:00.000Z'};e.streams[0].event({event:'playback',data:JSON.stringify(old),id:'20'});assert.equal(e.account.getSnapshot().stale,false);e.streams[0].event({event:'playback',data:JSON.stringify({...old,revision:21,state:'playing'}),id:'21'});assert.equal(e.account.getSnapshot().stale,true);assert.equal(e.account.getSnapshot().positionMs,old.positionMs);e.streams[0].event({event:'playback',data:JSON.stringify({...old,revision:21,state:'playing'}),id:'21'});assert.equal(e.account.getSnapshot().stale,true);checks.push('old paused snapshot remains valid; stale playing position freezes even after same revision refresh');
 e.streams[0].event({event:'session-expired',data:'{}',id:''});await settle();assert.equal(e.account.getSnapshot().loggedIn,false);assert.equal(e.record.value,undefined);assert.equal(e.player.state.playerState,'paused');checks.push('session expiration clears vault and pauses');e.account.release();
}
{
 const e=create();e.record.value={token:'restored-token',baseUrl:'http://127.0.0.1:3000'};e.setSnapshot({...e.getSnapshot(),revision:12,generation:3,ownerSessionId:'s1',playbackSessionId:'p3',state:'playing'});await e.account.initialize();await settle();assert.equal(e.account.getSnapshot().loggedIn,true);assert.equal(e.account.getSnapshot().owner,false);assert.equal(e.calls.includes('play'),false);checks.push('restoring a previous owner still requires explicit takeover');e.account.release();
}
{
 const e=create();await e.account.initialize();for(const base of ['http://example.com','https://name:password@example.com','https://example.com/path']){await e.account.requestCode(base,'a@example.com');assert.equal(e.requests.length,0);}checks.push('service origin rejects cleartext remote, credentials, and paths');e.account.release();
}
{
 const e=create();await signIn(e);let failed=true;
 e.setHandler(async(p,b,o)=>{if(p==='/api/playback'&&failed){failed=false;return {__status:502,reply:{error:{message:'请求失败（502）'}}};}return e.initialHandler(p,b,o);});
 await e.account.refresh();await settle();assert.equal(e.account.getSnapshot().error,'请求失败（502）');
 await e.account.refresh();await settle();assert.equal(e.account.getSnapshot().error,'');
 checks.push('background refresh error clears after the next authoritative snapshot');e.account.release();
}
{
 const e=create();await signIn(e);let failed=true;
 e.setHandler(async(p,b,o)=>{if(p==='/api/playback'&&failed){failed=false;return {__status:502,reply:{error:{message:'请求失败（502）'}}};}if(p.endsWith('/takeover'))return {__status:409,reply:{error:{message:'播放设备已发生变化，请重新确认接管'}}};return e.initialHandler(p,b,o);});
 await e.account.refresh();await settle();await e.account.takeover();await settle();assert.equal(e.account.getSnapshot().error,'播放设备已发生变化，请重新确认接管');
 await e.account.refresh();await settle();assert.equal(e.account.getSnapshot().error,'播放设备已发生变化，请重新确认接管');
 checks.push('explicit takeover failure remains after background sync recovers');e.account.release();
}
function simulatePlaybackIncident(e) {
  const recorder = new diagnosticApi.PlaybackDiagnostics();
  recorder.reset(e.player.state.mediaVersionId);
  recorder.fail(374000, true, 5400103);
  recorder.record('resumed', 374000);
  e.player.getDiagnosticReport = () => recorder.snapshot();
  e.player.state.diagnosticIncidentId = recorder.incidentId;
  e.player.emit();
}

const uploads = e => e.requests.filter(request => request.path === '/api/diagnostics');
{
  const e = create();
  await signIn(e);
  const loadMedia = e.player.loadMedia.bind(e.player);
  let fixtureSource;
  e.player.loadMedia = async (contentId, mediaVersionId, title, base, token) => {
    fixtureSource = { mediaVersionId, base, token };
    return loadMedia(contentId, mediaVersionId, title, base, token);
  };
  await e.account.takeover();
  assert.deepEqual(fixtureSource, { mediaVersionId: 'fixture-pcm-v1', base: '', token: 'secret-token' });
  simulatePlaybackIncident(e);
  e.account.previewDiagnostic('playback');
  const preview = e.account.getSnapshot();
  assert.match(preview.diagnosticPreview, /5400103/);
  assert.match(preview.diagnosticPreview, /已续播/);
  e.account.cancelDiagnostic(preview.diagnosticId);
  await e.account.submitDiagnostic(preview.diagnosticId);
  assert.equal(uploads(e).length, 0);

  e.account.previewDiagnostic('playback');
  assert.equal(e.account.getSnapshot().diagnosticId, preview.diagnosticId);
  const pending = deferred();
  e.setHandler((path, body, opts) => path === '/api/diagnostics' ? pending.promise : e.initialHandler(path, body, opts));
  const first = e.account.submitDiagnostic(preview.diagnosticId);
  await e.account.submitDiagnostic(preview.diagnosticId);
  e.account.cancelDiagnostic(preview.diagnosticId);
  assert.equal(uploads(e).length, 1);
  assert.equal(e.account.getSnapshot().diagnosticPhase, 'sending');
  assert.equal(uploads(e)[0].options.method, 'POST');
  assert.equal(uploads(e)[0].options.header.Authorization, 'Bearer secret-token');
  assert.equal(diagnosticApi.diagnosticPreview(uploads(e)[0].body), preview.diagnosticPreview);
  pending.reject(new Error('network unavailable'));
  await first;
  assert.equal(e.account.getSnapshot().diagnosticPhase, 'failed');
  e.setHandler((path, body, opts) => path === '/api/diagnostics' ? { reportId: 'wrong receipt' } : e.initialHandler(path, body, opts));
  await e.account.submitDiagnostic(preview.diagnosticId);
  assert.equal(e.account.getSnapshot().diagnosticPhase, 'failed');
  e.setHandler((path, body, opts) => path === '/api/diagnostics' ? { reportId: body.reportId } : e.initialHandler(path, body, opts));
  await e.account.submitDiagnostic(preview.diagnosticId);
  const receipt = e.account.getSnapshot();
  assert.equal(receipt.diagnosticPhase, 'sent');
  assert.equal(receipt.diagnosticId, preview.diagnosticId);
  await e.account.submitDiagnostic(preview.diagnosticId);
  assert.equal(uploads(e).length, 3);
  assert.ok(uploads(e).every(request => request.options.extraData === uploads(e)[0].options.extraData));
  checks.push('recovered playback can be reported; preview/cancel stay local, confirmed retry uses exact same payload and matched receipt');
  e.account.release();
}
{
  const e = create();
  await signIn(e);
  simulatePlaybackIncident(e);
  e.account.previewDiagnostic('playback');
  const obsolete = e.account.getSnapshot().diagnosticId;
  const next = { ...e.getSnapshot(), revision: 80, mediaVersionId: 'next-media' };
  e.streams[0].event({ event: 'playback', data: JSON.stringify(next), id: '80' });
  await e.account.submitDiagnostic(obsolete);
  assert.equal(uploads(e).length, 0);
  assert.equal(e.account.getSnapshot().diagnosticId, '');
  e.streams[0].event({ event: 'playback', data: JSON.stringify({ ...e.getSnapshot(), revision: 81 }), id: '81' });
  e.account.previewDiagnostic('playback');
  const pending = deferred();
  e.setHandler((path, body, opts) => path === '/api/diagnostics' ? pending.promise : e.initialHandler(path, body, opts));
  const sending = e.account.submitDiagnostic(obsolete);
  await e.account.logout();
  await signIn(e);
  pending.resolve({ reportId: obsolete });
  await sending;
  e.account.previewDiagnostic('playback');
  assert.equal(e.account.getSnapshot().diagnosticId, '');
  assert.equal(e.account.getSnapshot().diagnosticPreview, '');
  assert.equal(uploads(e).length, 1);
  checks.push('media changes invalidate consent and old session uploads cannot display in a new session');
  e.account.release();
}
{
  const e = create();
  await signIn(e);
  simulatePlaybackIncident(e);
  const mediaId = 'reading-media-id';
  const otherId = 'other-reading-id';
  const job = { id: '044027a2-d274-46a2-80fc-6661cf85cabe', status: 'failed', attempts: 2,
    durationMs: 240000, completedMs: 73000, updatedAt: '2026-11-01T00:00:00Z', model: null, error: 'sample private failure' };
  let upload;
  e.setHandler((path, body, opts) => {
    if (path === '/api/library') return { items: [mediaId, otherId].map(mediaVersionId =>
      ({ mediaVersionId, durationMs: 240000, audioAvailable: false })) };
    for (const mediaVersionId of [mediaId, otherId]) {
      if (path === `/api/media/${mediaVersionId}/transcript`) return { mediaVersionId, job, segments: [], pageCursor: -1, nextCursor: null };
    }
    if (path === '/api/diagnostics') return upload.promise;
    return e.initialHandler(path, body, opts);
  });
  e.account.setLibraryOpen(true);
  await settle();
  e.account.selectReading(mediaId);
  await settle();
  assert.equal(e.account.getSnapshot().transcriptDiagnosticAvailable, true);
  e.account.previewDiagnostic('transcription');
  const first = e.account.getSnapshot();
  assert.ok(first.diagnosticPreview.includes(mediaId) && first.diagnosticPreview.includes(job.id));
  assert.doesNotMatch(first.diagnosticPreview, /5400103|fixture-pcm-v1|sample private failure/);
  job.updatedAt = '2026-11-02T00:00:00Z';
  await e.account.refreshTranscript();
  assert.equal(e.account.getSnapshot().diagnosticId, '');
  e.account.previewDiagnostic('transcription');
  const latest = e.account.getSnapshot();
  assert.notEqual(latest.diagnosticId, first.diagnosticId);
  await e.account.submitDiagnostic(first.diagnosticId);
  assert.equal(uploads(e).length, 0);
  upload = deferred();
  const sending = e.account.submitDiagnostic(latest.diagnosticId);
  const body = uploads(e)[0].body;
  assert.equal(body.jobId, job.id);
  assert.deepEqual(body.events, [{ type: 'transcript_failed', atMs: Date.parse(job.updatedAt), positionMs: 73000, attempts: 2 }]);
  assert.equal(diagnosticApi.diagnosticPreview(body), latest.diagnosticPreview);
  e.account.returnToCurrent();
  assert.equal(e.account.getSnapshot().diagnosticId, '');
  e.account.selectReading(otherId);
  await settle();
  e.account.previewDiagnostic('transcription');
  assert.notEqual(e.account.getSnapshot().diagnosticId, latest.diagnosticId);
  e.account.selectReading(mediaId);
  await settle();
  e.account.previewDiagnostic('transcription');
  assert.equal(e.account.getSnapshot().diagnosticId, latest.diagnosticId);
  assert.equal(e.account.getSnapshot().diagnosticPreview, latest.diagnosticPreview);
  upload.resolve({ reportId: latest.diagnosticId });
  await sending;
  assert.equal(e.account.getSnapshot().diagnosticPhase, 'preview');
  await e.account.logout();
  await signIn(e);
  e.account.setLibraryOpen(true);
  await settle();
  e.account.selectReading(mediaId);
  await settle();
  e.account.previewDiagnostic('transcription');
  assert.notEqual(e.account.getSnapshot().diagnosticId, '');
  assert.notEqual(e.account.getSnapshot().diagnosticId, latest.diagnosticId);
  checks.push('archived reading item diagnostics bind to its latest failed job; old receipt hidden after leaving that item');
  e.account.release();
}
console.log(JSON.stringify({passed:true,checks},null,2));


