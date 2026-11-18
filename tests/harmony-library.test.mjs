import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const dir=new URL('../apps/harmony/entry/src/main/ets/services/',import.meta.url);
const source=fs.readFileSync(new URL('AccountSync.ets', dir),'utf8').replace(/^import .*;$/gm,'');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
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
 if(path==='/api/auth/logout')return {};if(path.endsWith('/chat/check'))return {available:true};
 if(path==='/api/playback')return {snapshot:clone(snapshot)};
 if(path==='/api/playback/takeover'){snapshot={...snapshot,generation:body.expectedGeneration+1,revision:snapshot.revision+1,sequence:0,ownerSessionId:'s1',playbackSessionId:'p1',state:'paused',updatedAt:new Date(now).toISOString()};return {snapshot:clone(snapshot),accepted:true};}
 if(path==='/api/playback/report'){snapshot={...snapshot,...body,revision:snapshot.revision+1,updatedAt:new Date(now).toISOString()};return {snapshot:clone(snapshot),accepted:true};}
 throw new Error(path);
 };
 const initialHandler=handler;
 class FakeVault{async load(){return record.value;} async save(v){record.saves++;record.value=clone(v);}async clear(){record.clears++;record.value=undefined;}}
 class FakeStream{constructor(event,state){this.event=event;this.state=state;this.foreground=true;streams.push(this);}start(url,token){this.url=url;this.token=token;this.state({status:'connected'});}stop(){this.token='';this.state({status:'stopped'});}setForeground(v){this.foreground=v;}reconnect(){}}
 class FakeRequest{destroyed=false;destroy(){this.destroyed=true;}async request(url,options){const path=new URL(url).pathname;const body=options.extraData?JSON.parse(options.extraData):undefined;const req={path,body,options,url};requests.push(req);if(path==='/api/playback/report'){reportCount++;maxReports=Math.max(maxReports,reportCount);}try{const v=await handler(path,body,options);if(v?.__status)return {responseCode:v.__status,result:JSON.stringify(v.reply)};return {responseCode:200,result:JSON.stringify(v)};}finally{if(path==='/api/playback/report')reportCount--;}}}
 class Clock extends Date{constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}}
 const context={exports:{},Date:Clock,JSON,Number,Math,Error,Promise,Record:undefined,
 http:{RequestMethod:{GET:'GET',POST:'POST',PATCH:'PATCH',DELETE:'DELETE'},HttpDataType:{STRING:0},createHttp:()=>new FakeRequest()},
 util:{generateRandomUUID:()=>`req-${requests.length}`},PlaybackService:{getInstance:()=>player},SessionVault:FakeVault,EventStream:FakeStream,
 setInterval:()=>1,clearInterval:()=>{},setTimeout,clearTimeout};vm.runInNewContext(compiled,context);
 const account=context.exports.AccountSync.getInstance();
 return {account,player,record,requests,streams,calls,profile,setHandler:f=>handler=f,initialHandler,setSnapshot:v=>snapshot=v,getSnapshot:()=>clone(snapshot),advance:ms=>now+=ms,getMax:()=>maxReports};
}
async function signIn(e){await e.account.initialize();await e.account.requestCode('http://127.0.0.1:3000','a@example.com');await e.account.verifyCode('http://127.0.0.1:3000','a@example.com','123456');await settle();}

// Exercise the actual page event methods without claiming ArkUI rendering coverage.
const pagePrefix=fs.readFileSync(new URL('../apps/harmony/entry/src/main/ets/pages/Index.ets',import.meta.url),'utf8').split('  build() {')[0]
 .replace(/^import .*;$/gm,'').replace(/@(Entry|Component)\s*/g,'').replace(/@State\s+/g,'').replace('struct Index','class Index');
const pageCompiled=ts.transpileModule(`${pagePrefix}\n}\nexports.Index=Index;`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function createPage(e){
 const probe={getSnapshot:()=>({}),subscribe:f=>{f({});return()=>{};}};
 const context={exports:{},AccountSync:{getInstance:()=>e.account},PlaybackService:{getInstance:()=>e.player},ConnectionProbe:{getInstance:()=>probe},Scroller:class {offset(){return {xOffset:0,yOffset:0};}scrollTo(){}},setTimeout,clearTimeout,DEBUG:false};
 vm.runInNewContext(pageCompiled,context);const page=new context.exports.Index();page.aboutToAppear();return page;
}
const savedItem=(id)=>({id,mediaVersionId:'fixture-pcm-v1',mediaTitle:'测试资料',kind:'excerpt',source:{kind:'transcript-selection'},content:{text:`原文${id}`,segments:[],citations:[]},note:`旧备注${id}`,audioAvailable:true,createdAt:'2026-11-18T00:00:00Z',updatedAt:'2026-11-18T00:00:00Z'});

const checks=[];
{
 const e=create();await signIn(e);const base=e.initialHandler;const a={...e.getSnapshot(),mediaVersionId:'media-a',contentId:'content-a',title:'A',durationMs:240000,positionMs:180000};
 e.setHandler(async(p,b,o)=>{if(p.endsWith('/takeover')){const next={...a,revision:2,generation:1,sequence:0,ownerSessionId:'s1',playbackSessionId:'p-a'};e.setSnapshot(next);return {accepted:true,snapshot:next};}return base(p,b,o);});
 await e.account.takeover('media-a');await settle();assert.equal(e.account.getSnapshot().title,'A');assert.equal(e.account.getSnapshot().durationMs,240000);assert.equal(e.account.getSnapshot().owner,true);assert.equal(e.player.state.mediaVersionId,'media-a');assert.equal(e.player.state.positionMs,180000);const t=e.requests.find(r=>r.path.endsWith('/takeover'));assert.equal(t.body.mediaVersionId,'media-a');const r=e.requests.filter(r=>r.path.endsWith('/report')).at(-1).body;assert.equal(r.mediaVersionId,'media-a');assert.equal(r.contentId,'content-a');assert.equal(r.positionMs,180000);assert.ok(e.calls.findIndex(c=>Array.isArray(c)&&c[0]==='load')<e.calls.indexOf('play'));
 e.player.state.positionMs=250000;await e.account.seek(250000);await settle();assert.equal(e.requests.filter(r=>r.path.endsWith('/report')).at(-1).body.positionMs,240000);
 e.player.state.buffering=true;e.player.emit();await settle();assert.equal(e.requests.filter(r=>r.path.endsWith('/report')).at(-1).body.state,'buffering');
 const before=e.requests.filter(r=>r.path.endsWith('/report')).length;e.player.state.mediaVersionId='wrong-media';e.player.emit();e.advance(3000);e.account.tick();await settle();assert.equal(e.requests.filter(r=>r.path.endsWith('/report')).length,before);
 await e.account.logout();assert.equal(e.player.state.mediaVersionId,'fixture-pcm-v1');assert.equal(e.account.getSnapshot().loggedIn,false);checks.push('targeted media takeover loads same-origin source before playback; real duration/IDs, clamp, buffering, identity guard and logout fixture restoration');e.account.release();
}
{
 const e=create();await signIn(e);let loads=0;const a={...e.getSnapshot(),mediaVersionId:'media-a',contentId:'content-a',title:'A',durationMs:240000,positionMs:0,revision:1,generation:1,sequence:0,ownerSessionId:'s1',playbackSessionId:'p-a'};e.setHandler((p,b,o)=>p.endsWith('/takeover')?{snapshot:a,accepted:true}:e.initialHandler(p,b,o));e.player.loadMedia=async()=>{loads++;throw new Error('network media rejected');};await e.account.takeover('media-a');assert.equal(loads,1);assert.equal(e.calls.includes('play'),false);assert.equal(e.account.getSnapshot().owner,false);assert.match(e.account.getSnapshot().error,/network/);checks.push('failed network load never activates playback or sends a false playing report');e.account.release();
}
{
 const e=create();await signIn(e);const pending=deferred();e.setHandler((p,b,o)=>p==='/api/library'?pending.promise:p==='/api/imports'?{jobs:[]}:e.initialHandler(p,b,o));e.account.setLibraryOpen(true);await settle();await e.account.logout();pending.resolve({items:[{mediaVersionId:'private-a',title:'old account title'}]});await settle();assert.equal(e.account.getSnapshot().libraryItems.length,0);assert.equal(e.account.getSnapshot().libraryBusy,false);checks.push('late library response after logout cannot restore private account items');e.account.release();
}
{
 const e=create();await signIn(e);const items=[{mediaVersionId:'media-a',contentId:'content-a',durationMs:240000,title:'A',createdAt:new Date().toISOString()}];const jobs=[{id:'job-a',status:'ready',title:'A',mediaVersionId:'media-a',sourceUrl:'https://example.com/a.mp3',attempts:1,error:null,createdAt:new Date().toISOString()}];
 e.setHandler((p,b,o)=>{if(p==='/api/library')return {items};if(p==='/api/imports'&&!b)return {jobs};if(p==='/api/imports/preview')return {title:'Feed',episodes:[{title:'Episode',url:'https://example.com/a.mp3'}]};if(p==='/api/imports'&&b)return {job:jobs[0]};return e.initialHandler(p,b,o);});
 e.account.setLibraryOpen(true);await settle();assert.equal(e.account.getSnapshot().libraryItems[0].title,'A');await e.account.previewFeed('https://example.com/rss');assert.equal(e.account.getSnapshot().feedEpisodes[0].title,'Episode');await e.account.importAudio('https://example.com/a.mp3','Episode');assert.equal(e.requests.find(r=>r.path==='/api/imports'&&r.body).body.title,'Episode');e.account.setForeground(false);const before=e.requests.length;e.advance(6000);e.account.tick();await settle();assert.equal(e.requests.length,before);checks.push('library/import/RSS contracts work and foreground-only poll stops in background');e.account.release();
}
const usage={usedBytes:4096,reservedBytes:1024,reclaimingBytes:512,limitBytes:1073741824,itemCount:1,itemLimit:100};
const libraryItem=(id='media-a',audioAvailable=false)=>({mediaVersionId:id,contentId:`content-${id}`,title:id,durationMs:240000,createdAt:new Date().toISOString(),byteSize:4096,audioAvailable,deletable:true});
const transcript=(id,text='保留文稿')=>({mediaVersionId:id,job:{id:`job-${id}`,status:'ready',attempts:1,durationMs:240000,completedMs:240000,model:'model',error:null,updatedAt:new Date().toISOString()},segments:[{id:`segment-${id}`,startMs:150000,endMs:180000,text}],pageCursor:-1,nextCursor:null});
const chat=(id,turns=[],audioAvailable=true)=>({mediaVersionId:id,turns,bridgeOnline:true,audioAvailable,nextBefore:null});
const retrieval=(id='retrieval-1',status='matched',overrides={})=>({
 id,sequence:1,question:'节目讲了什么',answer:status==='no-evidence'?'整期文稿中没有找到与问题直接相关的原文。':'已找到相关原文',status:'complete',positionMs:status==='no-evidence'?0:30000,scope:'retrieval',createdAt:new Date().toISOString(),error:null,citations:[],anchor:{kind:'retrieval'},
 ...overrides,
 retrieval:{strategy:'lexical-v1',status,totalSegments:120,matchedSegments:status==='no-evidence'?0:8,selectedSegments:status==='no-evidence'?0:2,sourceSegmentIds:status==='no-evidence'?[]:['segment-r1','segment-r2'],queryTerms:status==='no-evidence'?[]:['节目'],...(overrides.retrieval||{}),snapshot:{transcriptJobId:'job-fixture',throughMs:120000,...((overrides.retrieval||{}).snapshot||{})}}
});
const chapter=(id='chapter-1',startMs=10000,endMs=20000,startSegmentId='segment-fixture')=>({id,title:`章节 ${id}`,startMs,endMs,startSegmentId,endSegmentId:`${startSegmentId}-end`});
const chapterDocument=(id='doc-1',status='complete',completedBatches=1,totalBatches=1,throughMs=120000)=>({id,snapshot:{transcriptJobId:'job-fixture',throughMs},status,completedBatches,totalBatches,createdAt:'2026-11-18T00:00:00.000Z'});
const chapterPage=(mediaVersionId='fixture-pcm-v1',overrides={})=>({mediaVersionId,audioAvailable:true,canGenerate:false,bridgeOnline:true,document:chapterDocument(),chapters:[chapter()],nextAfter:null,...overrides});
const chapterTranscript=(mediaVersionId,startMs=1000)=>({mediaVersionId,job:{id:`job-${mediaVersionId}`,status:'ready',attempts:1,durationMs:240000,completedMs:240000,model:'model',error:null,updatedAt:new Date().toISOString()},segments:[{id:`segment-${mediaVersionId}`,startMs,endMs:startMs+1000,text:'章节文稿'}],pageCursor:-1,nextCursor:null});
const summaryIds={document:'11111111-1111-4111-8111-111111111111',job:'22222222-2222-4222-8222-222222222222'};
const summaryPoint=(text='总结要点',evidenceCount=1)=>({text,evidenceCount});
const summaryResult=(id='part-1',startMs=10000,endMs=20000,points=[summaryPoint()])=>({id,title:`总结 ${id}`,startMs,endMs,points});
const summaryDocument=(status='complete',completedParts=2,totalParts=2,throughMs=120000)=>({id:summaryIds.document,snapshot:{transcriptJobId:summaryIds.job,throughMs},status,completedParts,totalParts,completedTasks:completedParts,totalTasks:totalParts,createdAt:'2026-11-18T00:00:00.000Z'});
const summariesPage=(mediaVersionId='fixture-pcm-v1',overrides={})=>({mediaVersionId,audioAvailable:true,canGenerate:false,bridgeOnline:true,document:summaryDocument(),overview:summaryResult('overview',0,120000,[summaryPoint('整期概览')]),parts:[{...summaryResult('part-1'),index:0},{...summaryResult('part-2',30000,50000),index:1}],nextAfter:null,...overrides});
const summaryEvidence=(mediaVersionId='fixture-pcm-v1',overrides={})=>({mediaVersionId,documentId:summaryIds.document,nodeId:'part-1',pointIndex:0,snapshot:{transcriptJobId:summaryIds.job,throughMs:120000},audioAvailable:true,segments:[{id:'summary-segment-1',startMs:10000,endMs:12000,text:'冻结依据'}],...overrides});
function installSummaryApi(e,resolver){
 e.setHandler((p,b,o)=>{
  if(p.endsWith('/summaries/topics')) return resolver(new URL(e.requests.at(-1).url),b,false,true);
  if(p.endsWith('/summaries/evidence')) return resolver(new URL(e.requests.at(-1).url),b,true);
  if(p.endsWith('/summaries')) return resolver(new URL(e.requests.at(-1).url),b,false);
  if(p.endsWith('/transcript')) return transcript(p.split('/')[3]);
  if(p.endsWith('/chat')) return chat(p.split('/')[3]);
  return e.initialHandler(p,b,o);
 });
}
function installChapterApi(e,resolver){
 e.setHandler((p,b,o)=>{
  if(p.endsWith('/chapters')) return resolver(new URL(e.requests.at(-1).url),b,o);
  if(p.endsWith('/transcript')){const id=p.split('/')[3],url=new URL(e.requests.at(-1).url),raw=url.searchParams.get('at');return chapterTranscript(id,raw===null?1000:Number(raw));}
  if(p.endsWith('/chat')) return chat(p.split('/')[3]);
  return e.initialHandler(p,b,o);
 });
}
{
 const e=create();await signIn(e);const item=libraryItem();
 e.setHandler((p,b,o)=>{if(p==='/api/library')return {items:[item],usage};if(p==='/api/imports')return {jobs:[]};if(p.endsWith('/transcript'))return transcript(p.split('/')[3]);if(p.endsWith('/chat')){const id=p.split('/')[3];if(b)return {turn:{id:'turn-a',sequence:1,question:b.question,answer:'已保留',status:'complete',positionMs:150000,scope:'selection',createdAt:new Date().toISOString(),error:null,citations:[{id:'1',startMs:150000,endMs:180000,text:'引用文稿'}]}};return chat(id);}return e.initialHandler(p,b,o);});
 e.account.setLibraryOpen(true);await settle();assert.deepEqual(clone(e.account.getSnapshot().libraryUsage),usage);
 const callsBefore=e.calls.length;const playbackBefore=e.account.getSnapshot().mediaVersionId;
 e.account.selectReading(item.mediaVersionId);e.account.setChatOpen(true);await settle();
 assert.equal(e.account.libraryOpen,false);const listCount=e.requests.filter(r=>r.path==='/api/library').length;await e.account.refreshLibrary();assert.equal(e.requests.filter(r=>r.path==='/api/library').length,listCount);
 assert.equal(e.account.getSnapshot().readingArchived,true);assert.equal(e.account.getSnapshot().readingTitle,'media-a');assert.equal(e.account.getSnapshot().transcriptSegments[0].text,'保留文稿');assert.equal(e.account.getSnapshot().contentDurationMs,240000);assert.equal(e.account.getSnapshot().mediaVersionId,playbackBefore);assert.equal(e.calls.length,callsBefore);
 e.account.setChatScope('near');e.account.setChatDraft('解释这段');assert.equal(e.account.getSnapshot().chatCanSend,false);
 e.account.toggleSegment('segment-media-a');e.account.askSelection();await e.account.sendChat();await settle();
 const question=e.requests.find(r=>r.path==='/api/media/media-a/chat'&&r.body);assert.equal(question.body.anchor.kind,'transcript-selection');assert.equal(question.body.anchor.throughMs,240000);assert.deepEqual(question.body.anchor.segmentIds,['segment-media-a']);assert.equal(e.account.getSnapshot().chatError,'');
 const newer={...e.getSnapshot(),revision:1,mediaVersionId:'media-b',contentId:'content-b',title:'正在听 B',durationMs:60000,positionMs:20000};e.setSnapshot(newer);e.streams[0].event({event:'playback',data:JSON.stringify(newer),id:'1'});await settle();
 assert.equal(e.account.getSnapshot().readingTitle,'media-a');assert.equal(e.account.getSnapshot().transcriptSegments[0].text,'保留文稿');assert.equal(e.account.getSnapshot().mediaVersionId,'media-b');assert.equal(e.calls.length,callsBefore);
 const beforeTakeovers=e.requests.filter(r=>r.path.endsWith('/takeover')).length;await e.account.takeover('media-a');assert.equal(e.requests.filter(r=>r.path.endsWith('/takeover')).length,beforeTakeovers);
 e.account.returnToCurrent();await settle();assert.equal(e.account.getSnapshot().readingMediaVersionId,'');assert.equal(e.account.getSnapshot().contentPositionMs,20000);
 checks.push('archived reading keeps playback independent, validates long transcript/citations, requires explicitly selected transcript instead of borrowing the playing episode position, survives playback changes and blocks archived playback');e.account.release();
}
{
 const e=create();await signIn(e);const pending=deferred();let removed=false;
 e.setHandler((p,b,o)=>{if(p==='/api/library')return {items:[libraryItem('media-a'),libraryItem('media-b')],usage};if(p==='/api/imports')return {jobs:[]};if(p==='/api/media/media-a/transcript')return pending.promise;if(p==='/api/media/media-b/transcript')return removed?{__status:404,reply:{error:{code:'NOT_FOUND',message:'gone'}}}:transcript('media-b','B 文稿');if(p.endsWith('/transcript'))return {mediaVersionId:p.split('/')[3],job:null,segments:[],pageCursor:-1,nextCursor:null};return e.initialHandler(p,b,o);});
 e.account.setLibraryOpen(true);await settle();e.account.selectReading('media-a');await settle();e.account.selectReading('media-b');await settle();pending.resolve(transcript('media-a','旧 A 文稿'));await settle();assert.equal(e.account.getSnapshot().readingTitle,'media-b');assert.equal(e.account.getSnapshot().transcriptSegments[0].text,'B 文稿');
 removed=true;await e.account.refreshTranscript();await settle();assert.equal(e.account.getSnapshot().readingMediaVersionId,'');assert.match(e.account.getSnapshot().hint,/已删除/);assert.equal(e.account.getSnapshot().transcriptSegments.length,0);
 checks.push('late reading responses cannot cross selections; a selected transcript deleted on another device returns to current media');e.account.release();
}
{
 const e=create();await signIn(e);let items=[libraryItem('media-a',true),{...libraryItem('fixture'),deletable:false}];let jobs=[{id:'queued-job',status:'queued'},{id:'failed-job',status:'failed'},{id:'active-job',status:'downloading'}];
 e.setHandler((p,b,o)=>{if(p==='/api/library')return {items,usage};if(p==='/api/imports'&&!b)return {jobs};if(p.endsWith('/transcript'))return transcript(p.split('/')[3]);if(p==='/api/library/media-a/remove'){if(b.mode==='audio')items=items.map(i=>i.mediaVersionId==='media-a'?{...i,audioAvailable:false}:i);else items=items.filter(i=>i.mediaVersionId!=='media-a');return {};}if(p.endsWith('/remove')&&p.startsWith('/api/imports/')){jobs=jobs.filter(j=>!p.includes(j.id));return {};}return e.initialHandler(p,b,o);});
 e.account.setLibraryOpen(true);await settle();e.account.selectReading('media-a');await settle();e.account.setLibraryOpen(true);await settle();const callsBefore=e.calls.length;
 await e.account.removeLibrary('media-a','audio');await settle();assert.equal(e.account.getSnapshot().readingArchived,true);assert.equal(e.account.getSnapshot().transcriptSegments[0].text,'保留文稿');assert.equal(e.calls.length,callsBefore);assert.deepEqual(clone(e.requests.find(r=>r.path==='/api/library/media-a/remove').body),{mode:'audio'});
 await e.account.removeLibrary('media-a','all');await settle();assert.equal(e.account.getSnapshot().readingMediaVersionId,'');assert.equal(e.account.getSnapshot().libraryItems.some(i=>i.mediaVersionId==='media-a'),false);assert.equal(e.requests.filter(r=>r.path==='/api/playback').length>=3,true);
 const removesBefore=e.requests.filter(r=>r.path.endsWith('/remove')).length;await e.account.removeImport('active-job');await e.account.removeLibrary('fixture','all');assert.equal(e.requests.filter(r=>r.path.endsWith('/remove')).length,removesBefore);
 await e.account.removeImport('queued-job');await e.account.removeImport('failed-job');assert.deepEqual(clone(e.requests.find(r=>r.path==='/api/imports/queued-job/remove').body),{});assert.equal(e.account.getSnapshot().importJobs.length,1);
 checks.push('audio cleanup retains reading/chat access; whole deletion clears selection and refreshes playback; only queued/failed imports and deletable media can be removed');e.account.release();
}
{
 const e=create();await signIn(e);const pendingList=deferred();let lists=0,removed=false;
 e.setHandler((p,b,o)=>{if(p==='/api/library'){lists++;return lists===2?pendingList.promise:{items:removed?[]:[libraryItem('media-a',true)],usage};}if(p==='/api/imports')return {jobs:[]};if(p==='/api/library/media-a/remove'){removed=true;return {};}return e.initialHandler(p,b,o);});
 e.account.setLibraryOpen(true);await settle();const old=e.account.refreshLibrary();await settle();await e.account.removeLibrary('media-a','all');pendingList.resolve({items:[libraryItem('media-a',true)],usage});await old;await settle();assert.equal(e.account.getSnapshot().libraryItems.length,0);
 checks.push('pre-deletion list cannot restore removed media after the mutation');e.account.release();
}
{
 const e=create();await signIn(e);
 e.setHandler((p,b,o)=>{if(p==='/api/library')return {items:[libraryItem()],usage};if(p==='/api/imports')return {jobs:[]};if(p.endsWith('/transcript'))return transcript(p.split('/')[3]);if(p==='/api/media/media-a/chat')return {__status:404,reply:{error:{code:'NOT_FOUND',message:'gone'}}};if(p.endsWith('/chat'))return chat(p.split('/')[3]);return e.initialHandler(p,b,o);});
 e.account.setLibraryOpen(true);await settle();e.account.selectReading('media-a');await settle();e.account.setTranscriptOpen(false);e.account.setChatOpen(true);await settle();
 assert.equal(e.account.getSnapshot().readingMediaVersionId,'');assert.match(e.account.getSnapshot().hint,/已删除/);assert.equal(e.account.getSnapshot().chatLoaded,true);assert.equal(e.account.getSnapshot().chatError,'');
 checks.push('chat-only 404 for a removed reading object returns to the current conversation');e.account.release();
}
{
 const e=create();await signIn(e);const removal=deferred();let fail=true;
 e.setHandler((p,b,o)=>{if(p==='/api/library')return {items:[libraryItem('media-a',true)],usage};if(p==='/api/imports')return {jobs:[]};if(p==='/api/library/media-a/remove')return fail?{__status:409,reply:{error:{code:'BUSY',message:'正在处理中，请稍后再试'}}}:removal.promise;return e.initialHandler(p,b,o);});
 e.account.setLibraryOpen(true);await settle();await e.account.removeLibrary('media-a','all');assert.equal(e.account.getSnapshot().libraryItems.length,1);assert.equal(e.account.getSnapshot().libraryBusy,false);assert.match(e.account.getSnapshot().libraryError,/稍后/);
 fail=false;const pending=e.account.removeLibrary('media-a','all');await settle();await e.account.logout();removal.resolve({});await pending;await settle();assert.equal(e.account.getSnapshot().libraryItems.length,0);assert.equal(e.account.getSnapshot().libraryUsage,null);assert.equal(e.account.getSnapshot().readingMediaVersionId,'');assert.equal(e.account.getSnapshot().hint,'已退出登录');
 checks.push('rejected deletion retains rows and reports the error; a late mutation response cannot restore data or overwrite logout');e.account.release();
}
const citationTurn=()=>({id:'citation-turn',sequence:1,question:'之前的问题',answer:'根据原文回答',status:'complete',positionMs:190000,scope:'near',createdAt:new Date().toISOString(),error:null,citations:[{id:'S1',startMs:150000,endMs:180000,text:'第一段引用'},{id:'S2',startMs:30000,endMs:45000,text:'第二段引用'}]});
async function readingCitation(e,available=true){
 await signIn(e);const item=libraryItem('media-a',true),turn=citationTurn(),takeovers=new Map();
 const peer={...e.getSnapshot(),revision:1,mediaVersionId:'media-b',contentId:'content-b',title:'正在听 B',durationMs:240000,positionMs:42000,state:'playing',ownerSessionId:'s2',playbackSessionId:'p-b'};
 e.setSnapshot(peer);e.streams[0].event({event:'playback',data:JSON.stringify(peer),id:'1'});
 const handler=async(p,b,o)=>{
  if(p==='/api/library')return {items:[item],usage};if(p==='/api/imports')return {jobs:[]};
  if(p.endsWith('/transcript'))return transcript(p.split('/')[3]);
  if(p.endsWith('/chat')){const response=chat(p.split('/')[3],[turn],available);if(available===undefined)delete response.audioAvailable;return response;}
  if(p.endsWith('/takeover')){
   if(!takeovers.has(b.requestId)){const next={...e.getSnapshot(),generation:b.expectedGeneration+1,revision:e.getSnapshot().revision+1,sequence:0,mediaVersionId:b.mediaVersionId,contentId:'content-media-a',title:'media-a',durationMs:240000,positionMs:b.positionMs??185000,speed:b.speed??1,looping:b.looping??false,state:'paused',ownerSessionId:'s1',playbackSessionId:`p-${b.requestId}`};e.setSnapshot(next);takeovers.set(b.requestId,next);}
   return {accepted:true,snapshot:e.getSnapshot()};
  }
  return e.initialHandler(p,b,o);
 };
 e.setHandler(handler);e.account.setLibraryOpen(true);await settle();e.account.selectReading('media-a');e.account.setChatOpen(true);await settle();e.account.setChatDraft('尚未发送的追问');
 return {handler,turn,item};
}
{
 const e=create();const {turn}=await readingCitation(e);const before=clone(e.account.getSnapshot().chatTurns);const calls=e.calls.length;
 assert.equal(e.account.getSnapshot().mediaVersionId,'media-b');assert.equal(e.account.getSnapshot().readingMediaVersionId,'media-a');
 assert.equal(e.requests.some(r=>r.path.endsWith('/takeover')),false);
 await e.account.playCitation(turn.id,'S1');await settle();
 const request=e.requests.find(r=>r.path.endsWith('/takeover')).body;assert.equal(request.mediaVersionId,'media-a');assert.equal(request.positionMs,150000);
 const playbackCalls=e.calls.slice(calls);assert.ok(playbackCalls.findIndex(c=>Array.isArray(c)&&c[0]==='seek'&&c[1]===150000)<playbackCalls.indexOf('play'));
 assert.equal(e.player.state.mediaVersionId,'media-a');assert.equal(e.player.state.positionMs,150000);assert.equal(e.player.state.playerState,'playing');
 assert.equal(e.account.getSnapshot().readingMediaVersionId,'media-a');assert.equal(e.account.getSnapshot().chatDraft,'尚未发送的追问');assert.deepEqual(clone(e.account.getSnapshot().chatTurns),before);
 await e.account.playCitation(turn.id,'S2');await settle();const all=e.requests.filter(r=>r.path.endsWith('/takeover')).map(r=>r.body);assert.notEqual(all[0].requestId,all[1].requestId);assert.equal(all[1].positionMs,30000);assert.equal(e.player.state.positionMs,30000);
 checks.push('reading A while B plays replays A only after seeking the frozen citation; current-owner second citation gets a fresh intent and retains reading, draft and question snapshot');e.account.release();
}
{
 const e=create();const {handler,turn}=await readingCitation(e);let attempts=0;
 e.setHandler(async(p,b,o)=>{const reply=await handler(p,b,o);if(p.endsWith('/takeover')&&++attempts===1)throw new Error('reply lost after commit');return reply;});
 await e.account.playCitation(turn.id,'S1');await settle();assert.equal(e.calls.includes('play'),false);
 await e.account.playCitation(turn.id,'S1');await settle();const all=e.requests.filter(r=>r.path.endsWith('/takeover')).map(r=>r.body);assert.equal(all.length,2);assert.deepEqual(all[0],all[1]);assert.equal(e.player.state.positionMs,150000);assert.equal(e.calls.filter(c=>c==='play').length,1);
 checks.push('ambiguous citation takeover retries the same request and frozen starting position without premature playback');e.account.release();
}
{
 const e=create();const {handler,turn}=await readingCitation(e);let attempts=0;
 e.setHandler(async(p,b,o)=>{if(p.endsWith('/takeover')&&++attempts===1)throw new Error('request was not sent');return handler(p,b,o);});
 await e.account.playCitation(turn.id,'S1');await settle();await e.account.playCitation(turn.id,'S2');await settle();
 const all=e.requests.filter(r=>r.path.endsWith('/takeover')).map(r=>r.body);assert.notEqual(all[0].requestId,all[1].requestId);assert.equal(all[1].positionMs,30000);assert.equal(e.player.state.positionMs,30000);
 checks.push('choosing a different citation after an uncertain request never reuses the old intent or timestamp');e.account.release();
}
for(const available of [false,null]){
 const e=create();const {handler,turn}=await readingCitation(e,available);
 if(available===null){e.setHandler(async(p,b,o)=>{const reply=await handler(p,b,o);if(p.endsWith('/chat'))delete reply.audioAvailable;return reply;});await e.account.refreshChat();await settle();}
 assert.equal(e.account.getSnapshot().chatAudioAvailable,false);await e.account.playCitation(turn.id,'S1');assert.equal(e.requests.some(r=>r.path.endsWith('/takeover')),false);assert.equal(e.calls.includes('play'),false);assert.match(e.account.getSnapshot().error,/状态|清理/);
 checks.push(available===false?'server-confirmed removed audio disables replay while retaining citations':'older chat response without audio availability allows reading but refuses replay');e.account.release();
}
{
 const e=create();const {handler,turn}=await readingCitation(e);e.account.libraryItems[0].audioAvailable=false;
 await e.account.playCitation(turn.id,'S1');assert.equal(e.requests.some(r=>r.path.endsWith('/takeover')),false);
 e.account.libraryItems[0].audioAvailable=true;e.setHandler(async(p,b,o)=>p.endsWith('/takeover')?{__status:409,reply:{error:{message:'音频已清理，仍可查看文稿和聊天。'}}}:handler(p,b,o));
 await e.account.playCitation(turn.id,'S1');await settle();assert.equal(e.calls.includes('play'),false);assert.equal(e.account.getSnapshot().readingMediaVersionId,'media-a');assert.equal(e.account.getSnapshot().chatDraft,'尚未发送的追问');
 checks.push('local archival blocks stale chat replay; server rejection of newly removed audio never plays or clears the reader');e.account.release();
}
{
 const e=create();const {handler,turn}=await readingCitation(e);const late=deferred();let next;
 e.setHandler(async(p,b,o)=>{if(p.endsWith('/takeover')){next=await handler(p,b,o);return late.promise;}return handler(p,b,o);});
 const pending=e.account.playCitation(turn.id,'S1');await settle();await e.account.logout();late.resolve(next);await pending;await settle();assert.equal(e.calls.includes('play'),false);assert.equal(e.account.getSnapshot().loggedIn,false);
 checks.push('a late citation takeover reply after logout cannot load private audio or start playback');e.account.release();
}
{
 const e=create();const {turn}=await readingCitation(e);const gate=deferred();e.player.loadMedia=async(contentId,mediaVersionId,title)=>{e.calls.push(['load',mediaVersionId]);await gate.promise;Object.assign(e.player.state,{contentId,mediaVersionId,title,ready:true,positionMs:0,playerState:'prepared'});};
 const pending=e.account.playCitation(turn.id,'S1');await settle();const peer={...e.getSnapshot(),revision:e.getSnapshot().revision+1,generation:e.getSnapshot().generation+1,ownerSessionId:'s2',playbackSessionId:'peer-new'};e.setSnapshot(peer);e.streams[0].event({event:'playback',data:JSON.stringify(peer),id:String(peer.revision)});gate.resolve();await pending;await settle();assert.equal(e.calls.includes('play'),false);assert.equal(e.account.getSnapshot().owner,false);
 checks.push('another device taking control during citation audio loading invalidates the old play operation');e.account.release();
}
{
 const e=create();const {turn}=await readingCitation(e);await e.account.playCitation('old-turn','S1');await e.account.playCitation(turn.id,'unknown');assert.equal(e.requests.some(r=>r.path.endsWith('/takeover')),false);
 e.account.chatTurns[0].citations[0].startMs=240000;await e.account.playCitation(turn.id,'S1');assert.equal(e.requests.some(r=>r.path.endsWith('/takeover')),false);
 checks.push('stale or unknown citation IDs and end-of-media timestamps cannot create a playback intent');e.account.release();
}

{
 const e=create();await signIn(e);let turns=[];
 e.setHandler((p,b,o)=>{
  if(p.endsWith('/chat/check'))return {available:true};
  if(p.endsWith('/chat')){if(!b)return chat('fixture-pcm-v1',turns);const turn={id:`new-${turns.length}`,sequence:turns.length+1,question:b.question,answer:'说明',status:'complete',positionMs:b.anchor?.positionMs??12000,scope:b.anchor?.scope??'near',createdAt:new Date().toISOString(),error:null,citations:[]};turns.push(turn);return {turn};}
  return e.initialHandler(p,b,o);
 });
 e.account.setChatOpen(true);await settle();assert.equal(new URL(e.requests.filter(r=>r.path.endsWith('/chat')&&!r.body).at(-1).url).searchParams.get('capabilities'),'anchored-v1,retrieval-v1');e.account.setChatDraft('解释开头');
 const anchor=clone(e.account.draftAnchor);assert.equal(anchor.positionMs,12000);assert.equal(anchor.positionSource,'synced');
 const newer={...e.getSnapshot(),positionMs:40000,revision:1};e.setSnapshot(newer);e.streams[0].event({event:'playback',data:JSON.stringify(newer),id:'1'});
 e.account.setChatDraft('解释开头这段');assert.deepEqual(clone(e.account.draftAnchor),anchor);
 await e.account.sendChat();await settle();const first=e.requests.find(r=>r.path.endsWith('/chat')&&r.body).body;
 assert.deepEqual(first.anchor,anchor);e.account.setChatDraft('再举个例子');await e.account.sendChat();await settle();
 const second=e.requests.filter(r=>r.path.endsWith('/chat')&&r.body).at(-1).body;
 assert.equal(second.parentTurnId,'new-0');assert.equal(second.anchor,undefined);assert.equal(second.positionMs,undefined);
 e.account.setChatDraft('保留草稿');e.account.askNow();assert.equal(e.account.getSnapshot().chatDraft,'保留草稿');assert.equal(e.account.draftAnchor.positionMs,40000);assert.equal(e.account.parentTurnId,'');
 e.account.chatNextBefore=2;e.account.earlierChat();await settle();const historyUrl=new URL(e.requests.filter(r=>r.path.endsWith('/chat')&&!r.body).at(-1).url);assert.equal(historyUrl.searchParams.get('capabilities'),'anchored-v1,retrieval-v1');assert.equal(historyUrl.searchParams.get('before'),'2');
 checks.push('first nonempty input freezes anchor across playback and typing; followups send only the parent; ask-now preserves draft and creates a fresh anchor');e.account.release();
}
{
 const e=create();await signIn(e);const item=libraryItem('media-a',false);let turns=[];let postBodies=[];
 e.setHandler((p,b,o)=>{
  if(p==='/api/library')return {items:[item],usage};if(p==='/api/imports')return {jobs:[]};
  if(p.endsWith('/transcript'))return transcript('media-a');
  if(p.endsWith('/chat/check'))return {available:true};
  if(p.endsWith('/chat')){if(!b)return {...chat('media-a',turns,false),retrievalOnline:false};postBodies.push(clone(b));const turn=retrieval(`retrieval-${turns.length}`, 'matched',{question:b.question,retrieval:{snapshot:{throughMs:240000},matchedSegments:1,selectedSegments:3,sourceSegmentIds:['segment-r1','segment-r2','segment-r3']}});turns.push(turn);return {turn};}
  return e.initialHandler(p,b,o);
 });
 e.account.setLibraryOpen(true);await settle();e.account.selectReading('media-a');await settle();e.account.setChatOpen(true);await settle();
 const callsBefore=e.calls.length;e.account.askRetrieval();assert.equal(e.account.getSnapshot().chatScope,'retrieval');assert.equal(e.account.getSnapshot().chatRetrievalOnline,false);assert.equal(e.account.draftAnchor.kind,'retrieval');
 e.account.setChatDraft('查找节目中的例子');assert.equal(e.account.getSnapshot().chatCanSend,true);await e.account.sendChat();await settle();
 const check=e.requests.find(r=>r.path.endsWith('/chat/check'));assert.deepEqual(clone(check.body.anchor),{kind:'retrieval'});
 assert.equal(postBodies.length,1);assert.deepEqual(clone(postBodies[0].anchor),{kind:'retrieval'});assert.equal(postBodies[0].positionMs,undefined);assert.equal(postBodies[0].parentTurnId,undefined);
 assert.equal(e.requests.filter(r=>r.path.endsWith('/takeover')).length,0);assert.equal(e.calls.length,callsBefore);assert.equal(e.account.getSnapshot().readingArchived,true);assert.equal(e.account.getSnapshot().chatTurns[0].retrieval.matchedSegments,1);assert.equal(e.account.getSnapshot().chatTurns[0].retrieval.selectedSegments,3);
 checks.push('archived independent reading can submit retrieval without a playback position or takeover even when retrieval AI is offline');e.account.release();
}
{
 const e=create();await signIn(e);const turn=retrieval('history-retrieval');
 e.setHandler((p,b,o)=>p.endsWith('/chat')&&!b?{...chat('fixture-pcm-v1',[turn]),retrievalOnline:true}:e.initialHandler(p,b,o));
 e.account.setChatOpen(true);await settle();const state=e.account.getSnapshot();const url=new URL(e.requests.filter(r=>r.path.endsWith('/chat')&&!r.body).at(-1).url);
 assert.equal(url.searchParams.get('capabilities'),'anchored-v1,retrieval-v1');assert.equal(state.chatRetrievalOnline,true);assert.equal(state.chatTurns[0].scope,'retrieval');assert.equal(state.chatTurns[0].retrieval.snapshot.throughMs,120000);assert.equal(state.chatTurns[0].positionMs,30000);
 const page=createPage(e);assert.equal(page.chatScope('retrieval'),'整期检索');const label=page.chatRetrievalMeta(state.chatTurns[0]);assert.match(label,/2\/120 段/);assert.match(label,/2:00/);assert.equal(label.includes('节目'),false);page.aboutToDisappear();checks.push('retrieval GET advertises both capabilities and the reader renders selected/total segments plus watermark without query terms');e.account.release();
}
{
 const e=create();await signIn(e);const turn=retrieval('no-evidence','no-evidence');
 e.setHandler((p,b,o)=>p.endsWith('/chat')&&!b?{...chat('fixture-pcm-v1',[turn]),retrievalOnline:true}:e.initialHandler(p,b,o));
 e.account.setChatOpen(true);await settle();assert.equal(e.account.getSnapshot().chatTurns[0].retrieval.status,'no-evidence');assert.equal(e.account.parentTurnId,'');
 e.account.followTurn('no-evidence');assert.equal(e.account.parentTurnId,'');assert.equal(e.account.getSnapshot().chatCanSend,false);e.account.askRetrieval();assert.equal(e.account.getSnapshot().chatScope,'retrieval');assert.equal(e.account.draftAnchor.kind,'retrieval');
 checks.push('a no-evidence retrieval turn cannot become a follow-up parent and offers a fresh retrieval anchor instead');e.account.release();
}
{
 const e=create();await signIn(e);const badStrategy=retrieval('bad-strategy');badStrategy.retrieval={...badStrategy.retrieval,strategy:'server-secret-v2'};const badSnapshot=retrieval('bad-snapshot');badSnapshot.retrieval={...badSnapshot.retrieval,snapshot:null};let variant='strategy';
 e.setHandler((p,b,o)=>p.endsWith('/chat')&&!b?{...chat('fixture-pcm-v1',[variant==='strategy'?badStrategy:badSnapshot]),retrievalOnline:true}:e.initialHandler(p,b,o));
 e.account.setChatOpen(true);await settle();assert.equal(e.account.getSnapshot().chatLoaded,false);assert.match(e.account.getSnapshot().chatError,/整期检索内容无效/);assert.equal(e.account.getSnapshot().chatTurns.length,0);variant='snapshot';e.account.setChatOpen(false);e.account.setChatOpen(true);await settle();assert.equal(e.account.getSnapshot().chatLoaded,false);assert.match(e.account.getSnapshot().chatError,/整期检索内容无效/);checks.push('invalid retrieval strategy or null snapshot metadata is rejected before it can enter the Harmony chat list');e.account.release();
}
{
 const e=create();await signIn(e);
 e.setHandler((p,b,o)=>p.endsWith('/chat')&&!b?{...chat('fixture-pcm-v1'),retrievalOnline:'yes'}:e.initialHandler(p,b,o));
 e.account.setChatOpen(true);await settle();assert.equal(e.account.getSnapshot().chatLoaded,false);assert.equal(e.account.getSnapshot().chatRetrievalOnline,false);assert.match(e.account.getSnapshot().chatError,/对话响应无效/);checks.push('malformed retrieval capability flags fail closed without enabling the retrieval entry');e.account.release();
}
{
 const e=create();await signIn(e);const seed=retrieval('seed');let turns=[seed],bodies=[];
 e.setHandler((p,b,o)=>{
  if(p.endsWith('/chat/check'))return {available:true};
  if(p.endsWith('/chat')){if(!b)return {...chat('fixture-pcm-v1',turns),retrievalOnline:true};bodies.push(clone(b));const next=retrieval('followed','matched',{sequence:2,question:b.question,parentTurnId:b.parentTurnId});turns=[seed,next];return {turn:next};}
  return e.initialHandler(p,b,o);
 });
 e.account.setChatOpen(true);await settle();e.account.followTurn('seed');assert.equal(e.account.parentTurnId,'seed');assert.equal(e.account.getSnapshot().chatScope,'retrieval');e.account.setChatDraft('继续解释原文');await e.account.sendChat();await settle();
 assert.equal(bodies.length,1);assert.equal(bodies[0].parentTurnId,'seed');assert.equal(bodies[0].anchor,undefined);assert.equal(bodies[0].positionMs,undefined);assert.equal(e.account.getSnapshot().chatTurns.at(-1).retrieval.status,'matched');checks.push('matched retrieval follow-ups reuse the frozen parent evidence and never silently run a new retrieval');e.account.release();
}
{
 const e=create();await signIn(e);let attempts=0,bodies=[];
 e.setHandler((p,b,o)=>{
  if(p.endsWith('/chat/check'))return {available:true};
  if(p.endsWith('/chat')){if(!b)return {...chat('fixture-pcm-v1'),retrievalOnline:true};bodies.push(clone(b));if(++attempts===1)throw new Error('检索响应丢失');return {turn:retrieval('retry-retrieval','no-evidence',{question:b.question})};}
  return e.initialHandler(p,b,o);
 });
 e.account.setChatOpen(true);await settle();e.account.askRetrieval();e.account.setChatDraft('找不到这句话');await e.account.sendChat();await settle();assert.equal(e.account.getSnapshot().chatUnconfirmed,true);const requestId=bodies[0].requestId;await e.account.sendChat();await settle();assert.equal(bodies.length,2);assert.equal(bodies[1].requestId,requestId);assert.deepEqual(bodies[1].anchor,{kind:'retrieval'});assert.equal(e.account.parentTurnId,'');assert.equal(e.account.draftAnchor.kind,'retrieval');assert.equal(e.account.getSnapshot().chatScope,'retrieval');checks.push('a lost retrieval response keeps the request ID for retry and still leaves no-evidence without a parent topic');e.account.release();
}
{
 const collapsed=create();await signIn(collapsed);const collapsedReply=deferred();collapsed.setHandler((p,b,o)=>p.endsWith('/chat')&&!b?collapsedReply.promise:collapsed.initialHandler(p,b,o));collapsed.account.setChatOpen(true);await settle();collapsed.account.setChatOpen(false);collapsedReply.resolve({...chat('fixture-pcm-v1'),retrievalOnline:true});await settle();assert.equal(collapsed.account.getSnapshot().chatOpen,false);assert.equal(collapsed.account.getSnapshot().chatTurns.length,0);collapsed.account.release();
 const switched=create();await signIn(switched);const items=[libraryItem('media-a',true),libraryItem('media-b',true)];const oldChat=deferred();switched.setHandler((p,b,o)=>{if(p==='/api/library')return {items,usage};if(p==='/api/imports')return {jobs:[]};if(p.endsWith('/transcript'))return transcript(p.split('/')[3]);if(p.endsWith('/chat')&&!b)return p.includes('/media-a/')?oldChat.promise:{...chat('media-b'),retrievalOnline:true};return switched.initialHandler(p,b,o);});switched.account.setLibraryOpen(true);await settle();switched.account.selectReading('media-a');await settle();switched.account.setChatOpen(true);await settle();switched.account.selectReading('media-b');await settle();oldChat.resolve({...chat('media-a',[retrieval('late-a')]),retrievalOnline:true});await settle();assert.equal(switched.account.getSnapshot().readingMediaVersionId,'media-b');assert.equal(switched.account.getSnapshot().chatTurns.length,0);switched.account.release();
 const loggedOut=create();await signIn(loggedOut);const oldOut=deferred();loggedOut.setHandler((p,b,o)=>p.endsWith('/chat')&&!b?oldOut.promise:loggedOut.initialHandler(p,b,o));loggedOut.account.setChatOpen(true);await settle();await loggedOut.account.logout();oldOut.resolve({...chat('fixture-pcm-v1',[retrieval('late-out')]),retrievalOnline:true});await settle();assert.equal(loggedOut.account.getSnapshot().loggedIn,false);assert.equal(loggedOut.account.getSnapshot().chatTurns.length,0);checks.push('late retrieval pages are discarded after panel collapse, media switching, and logout');loggedOut.account.release();
}
{
 const e=create();await signIn(e);const item=libraryItem('media-a',true);let text='旧句子';
 e.setHandler((p,b,o)=>{if(p==='/api/library')return {items:[item],usage};if(p==='/api/imports')return {jobs:[]};if(p.endsWith('/transcript'))return transcript('media-a',text);if(p.endsWith('/chat'))return chat('media-a');return e.initialHandler(p,b,o);});
 e.account.setLibraryOpen(true);await settle();e.account.selectReading('media-a');await settle();e.account.toggleSegment('segment-media-a');e.account.askSelection();
 text='旧句子和新增续句';await e.account.refreshTranscript();assert.equal(e.account.getSnapshot().transcriptSegments[0].text,'旧句子');assert.equal(e.account.draftAnchor.throughMs,240000);
 e.account.clearSelection();await e.account.refreshTranscript();assert.equal(e.account.getSnapshot().transcriptSegments[0].text,text);assert.equal(e.account.draftAnchor.throughMs,240000);
 checks.push('selected projection and question source remain frozen when later transcript responses extend the same sentence ID');e.account.release();
}
{
 const e=create();const {turn}=await readingCitation(e);await e.account.playCitation(turn.id,'S1');await settle();
 const generation=e.getSnapshot().generation,session=e.getSnapshot().playbackSessionId;
 e.player.state.positionMs=180000;e.player.emit();await settle();assert.equal(e.player.state.playerState,'paused');assert.match(e.account.getSnapshot().replayReturnLabel,/0:42/);
 await e.account.playCitation(turn.id,'S2');await settle();assert.match(e.account.getSnapshot().replayReturnLabel,/0:42/);
 const expected=e.getSnapshot();await e.account.returnFromReplay();await settle();const request=e.requests.filter(r=>r.path.endsWith('/takeover')).at(-1).body;
 assert.equal(request.intent,'restore');assert.equal(request.expectedGeneration,expected.generation);assert.equal(request.expectedPlaybackSessionId,expected.playbackSessionId);
 assert.equal(request.mediaVersionId,'media-b');assert.equal(request.positionMs,42000);assert.equal(e.player.state.playerState,'playing');assert.equal(e.account.getSnapshot().replayReturnLabel,'');
 checks.push('citation stops at its end; consecutive replay preserves the first return point; restore uses the stored playback generation and session');e.account.release();
}
{
 const e=create();const {turn}=await readingCitation(e);const paused={...e.getSnapshot(),revision:2,positionMs:50000,state:'paused',speed:1.5,looping:true};e.setSnapshot(paused);e.streams[0].event({event:'playback',data:JSON.stringify(paused),id:'2'});
 await e.account.playCitation(turn.id,'S1');await settle();await e.account.returnFromReplay();await settle();
 assert.equal(e.account.getSnapshot().playing,false);assert.equal(e.player.state.rate,1.5);assert.equal(e.player.state.looping,true);assert.equal(e.player.state.positionMs,50000);
 checks.push('return restores paused state, rate and loop without starting playback');e.account.release();
}
{
 const e=create();const {turn}=await readingCitation(e);await e.account.playCitation(turn.id,'S1');await settle();const count=e.requests.filter(r=>r.path.endsWith('/takeover')).length;
 const peer={...e.getSnapshot(),revision:e.getSnapshot().revision+1,generation:e.getSnapshot().generation+1,ownerSessionId:'s2',playbackSessionId:'peer-return'};e.setSnapshot(peer);e.streams[0].event({event:'playback',data:JSON.stringify(peer),id:String(peer.revision)});
 await e.account.returnFromReplay();assert.equal(e.requests.filter(r=>r.path.endsWith('/takeover')).length,count);assert.equal(e.account.getSnapshot().replayReturnLabel,'');assert.equal(e.account.getSnapshot().owner,false);
 checks.push('another device taking over invalidates return before any restore request');e.account.release();
}
{
 const e=create();const {handler,turn}=await readingCitation(e);await e.account.playCitation(turn.id,'S1');await settle();
 const peer={...e.getSnapshot(),revision:e.getSnapshot().revision+1,generation:e.getSnapshot().generation+1,ownerSessionId:'s2',playbackSessionId:'peer-server'};
 e.setHandler((p,b,o)=>p.endsWith('/takeover')&&b.intent==='restore'?{__status:409,reply:{error:{message:'播放状态已变化'},snapshot:peer}}:handler(p,b,o));
 const count=e.requests.filter(r=>r.path.endsWith('/takeover')).length;await e.account.returnFromReplay();await settle();
 assert.equal(e.requests.filter(r=>r.path.endsWith('/takeover')).length,count+1);assert.equal(e.account.getSnapshot().replayReturnLabel,'');assert.equal(e.account.getSnapshot().owner,false);assert.match(e.account.getSnapshot().error,/已变化/);
 checks.push('server restore conflict never retries with a newer generation or steals peer playback');e.account.release();
}
{
 const e=create();await signIn(e);let savedCalls=0;const response={mediaVersionId:'fixture-pcm-v1',query:'中文',snapshot:{transcriptJobId:'job-fixed',throughMs:90000},results:[{id:'sentence-1',startMs:30000,endMs:35000,text:'中文搜索',highlights:[{start:0,end:2}]}],nextCursor:'fixed-cursor',partial:true};
 e.setHandler((p,b,o)=>{if(p.endsWith('/transcript/search'))return response;if(p==='/api/saved-items'&&b){savedCalls++;if(savedCalls===1)throw new Error('reply lost');return {item:{id:'saved-1'}};}if(p==='/api/saved-items')return {items:[],nextCursor:null};if(p.endsWith('/chat'))return chat('fixture-pcm-v1');return e.initialHandler(p,b,o);});
 await e.account.searchTranscript('中文');const result=e.account.getSnapshot().searchResults[0];assert.equal(result.text,'中文搜索');assert.equal(e.account.getSnapshot().searchThroughMs,90000);
 await e.account.searchTranscript('中文',true);assert.equal(new URL(e.requests.filter(r=>r.path.endsWith('/transcript/search')).at(-1).url).searchParams.get('cursor'),'fixed-cursor');
 e.account.askSearchResult(result);assert.equal(e.account.draftAnchor.throughMs,90000);assert.deepEqual(clone(e.account.draftAnchor.segmentIds),['sentence-1']);
 await e.account.saveSearchResult(result);assert.match(e.account.getSnapshot().savedError,/reply lost/);await e.account.saveSearchResult(result);
 const requests=e.requests.filter(r=>r.path==='/api/saved-items'&&r.body);assert.equal(requests[0].body.requestId,requests[1].body.requestId);assert.equal(requests[1].body.source.throughMs,90000);
 checks.push('search uses fixed pagination cursor; questions and saves refer to returned snapshot; ambiguous save retries keep the same request ID');e.account.release();
}
{
 const e=create();await signIn(e);const pending=deferred();e.setHandler((p,b,o)=>p==='/api/saved-items'?pending.promise:e.initialHandler(p,b,o));
 e.account.setSavedOpen(true);await settle();await e.account.logout();pending.resolve({items:[{id:'private-old'}],nextCursor:null});await settle();assert.equal(e.account.getSnapshot().savedItems.length,0);assert.equal(e.account.getSnapshot().savedOpen,false);
 checks.push('late saved-list response after logout cannot restore private saved data');e.account.release();
}


{
 const e=create();const {handler,turn}=await readingCitation(e);let attempts=0;
 e.setHandler(async(p,b,o)=>{const reply=await handler(p,b,o);if(p.endsWith('/takeover')&&++attempts===1){e.streams[0].event({event:'playback',data:JSON.stringify(reply.snapshot),id:String(reply.snapshot.revision)});throw new Error('reply lost after event');}return reply;});
 await e.account.playCitation(turn.id,'S1');await settle();assert.equal(e.account.getSnapshot().mediaVersionId,'media-a');
 await e.account.playCitation(turn.id,'S1');await settle();assert.match(e.account.getSnapshot().replayReturnLabel,/0:42/);await e.account.returnFromReplay();await settle();
 const restore=e.requests.filter(r=>r.path.endsWith('/takeover')).at(-1).body;assert.equal(restore.mediaVersionId,'media-b');assert.equal(restore.positionMs,42000);
 checks.push('ambiguous replay keeps original return point even when its committed SSE arrives before the lost HTTP reply');e.account.release();
}
{
 const e=create();await signIn(e);e.setHandler((p,b,o)=>p.endsWith('/chat/check')?{__status:422,reply:{error:{message:'范围太长'}}}:p.endsWith('/chat')?chat('fixture-pcm-v1'):e.initialHandler(p,b,o));
 e.account.setChatOpen(true);await settle();e.account.setChatDraft('保留问题');await e.account.sendChat();await settle();
 assert.equal(e.account.getSnapshot().chatDraft,'保留问题');assert.equal(e.account.getSnapshot().chatUnconfirmed,false);assert.match(e.account.getSnapshot().chatError,/范围太长/);assert.equal(e.requests.filter(r=>r.path.endsWith('/chat')&&r.body).length,0);
 checks.push('known preflight refusal preserves draft and does not falsely show an unconfirmed submitted question');e.account.release();
}


{
 const e=create();await signIn(e);const page=createPage(e);let items=[{...libraryItem('fixture'),transcript:null},{...libraryItem('legacy')},{...libraryItem('ready'),transcript:{status:'ready',completedMs:240000,durationMs:240000}}];
 e.setHandler((p,b,o)=>p==='/api/library'?{items,usage}:p==='/api/imports'?{jobs:[]}:e.initialHandler(p,b,o));
 e.account.setLibraryOpen(true);await settle();assert.equal(e.account.getSnapshot().libraryError,'');assert.equal(page.libraryTranscriptLabel(e.account.getSnapshot().libraryItems[0]),'');assert.equal(page.libraryTranscriptLabel(e.account.getSnapshot().libraryItems[1]),'');assert.match(page.libraryTranscriptLabel(e.account.getSnapshot().libraryItems[2]),/整期可问/);
 items=[{...libraryItem('bad'),transcript:{status:'ready',completedMs:250000,durationMs:240000}}];await e.account.refreshLibrary();await settle();assert.match(e.account.getSnapshot().libraryError,/文稿状态响应无效/);assert.equal(e.account.getSnapshot().libraryItems.length,3);
 checks.push('nullable and omitted library transcript summaries render safely; malformed summaries are rejected before replacing valid rows');page.aboutToDisappear();e.account.release();
}
{
 const e=create();await signIn(e);const page=createPage(e);let first=savedItem('first'),second=savedItem('second');
 e.setHandler((p,b,o)=>{
  if(p==='/api/saved-items')return new URL(e.requests.at(-1).url).searchParams.get('cursor')==='page-two'?{items:[second],nextCursor:'page-three'}:{items:[first],nextCursor:'page-two'};
  if(p==='/api/saved-items/second'&&o.method==='PATCH'){second={...second,note:b.note,updatedAt:'2026-11-18T01:00:00Z'};return second;}
  if(p==='/api/saved-items/second'&&o.method==='DELETE')return {};
  return e.initialHandler(p,b,o);
 });
 e.account.setSavedOpen(true);await settle();await e.account.refreshSaved(true);assert.deepEqual(clone(e.account.getSnapshot().savedItems.map(i=>i.id)),['first','second']);
 page.beginNote(e.account.getSnapshot().savedItems[1]);assert.equal(page.hasEditingSavedItem(),true);page.noteDraft='尚未保存的新备注';const count=e.requests.filter(r=>r.path==='/api/saved-items').length;
 e.advance(6000);e.account.tick();await settle();assert.equal(e.requests.filter(r=>r.path==='/api/saved-items').length,count);assert.equal(e.account.savedCursor,'page-three');assert.equal(page.account.savedItems[1].id,'second');assert.equal(page.editingSaved,'second');assert.equal(page.noteDraft,'尚未保存的新备注');
 e.account.setSavedOpen(false);e.account.setSavedOpen(true);await settle();assert.equal(page.account.savedItems[1].id,'second');assert.equal(page.noteDraft,'尚未保存的新备注');
 await page.commitNote('second');await settle();assert.equal(page.editingSaved,'');assert.equal(e.account.getSnapshot().savedItems[1].note,'尚未保存的新备注');assert.equal(e.account.savedCursor,'page-three');
 e.advance(6000);e.account.tick();await settle();assert.equal(e.account.getSnapshot().savedItems.length,2);assert.equal(e.requests.filter(r=>r.path==='/api/saved-items').length,count);
 await e.account.deleteSaved('second');assert.deepEqual(clone(e.account.getSnapshot().savedItems.map(i=>i.id)),['first']);assert.equal(e.account.savedCursor,'page-three');
 await e.account.refreshSaved(false,true);assert.equal(e.account.savedCursor,'page-two');assert.equal(e.account.savedExpanded,false);
 checks.push('loading a second saved page and editing its note survives timed polling; save/delete update loaded rows and only explicit refresh resets pagination');page.aboutToDisappear();e.account.release();
}
{
 const e=create();await signIn(e);const page=createPage(e);e.setHandler((p,b,o)=>p==='/api/saved-items'?{items:[savedItem('first')],nextCursor:null}:e.initialHandler(p,b,o));
 e.account.setSavedOpen(true);await settle();page.beginNote(e.account.getSnapshot().savedItems[0]);page.noteDraft='第一页草稿';const count=e.requests.filter(r=>r.path==='/api/saved-items').length;e.advance(6000);e.account.tick();await settle();assert.equal(e.requests.filter(r=>r.path==='/api/saved-items').length,count);assert.equal(page.noteDraft,'第一页草稿');page.cancelNote();e.advance(6000);e.account.tick();await settle();assert.equal(e.requests.filter(r=>r.path==='/api/saved-items').length,count+1);
 checks.push('editing a first-page note also suspends replacement polling and cancelling restores it');page.aboutToDisappear();e.account.release();
}
{
 const e=create();await signIn(e);const page=createPage(e);
 e.setHandler((p,b,o)=>p.endsWith('/transcript')?{mediaVersionId:'fixture-pcm-v1',job:null,segments:[],pageCursor:-1,nextCursor:null}:p.endsWith('/chat')?chat('fixture-pcm-v1'):e.initialHandler(p,b,o));
 page.showTranscript();await settle();assert.equal(page.account.transcriptOpen,true);assert.equal(page.account.chatOpen,false);page.showChat();await settle();assert.equal(page.account.chatOpen,true);assert.equal(page.account.transcriptOpen,false);page.showChat();await settle();assert.equal(page.account.chatOpen,true);page.showTranscript();await settle();assert.equal(page.account.transcriptOpen,true);assert.equal(page.account.chatOpen,false);
 checks.push('the actual transcript/chat page actions select exactly one panel and reselecting a tab leaves it visible');page.aboutToDisappear();e.account.release();
}
{
 const e=create();await signIn(e);let delayed=false;const pending=deferred();const items=[libraryItem('media-a',true),libraryItem('media-b',true)];
 e.setHandler((p,b,o)=>{if(p==='/api/library')return delayed?pending.promise:{items,usage};if(p==='/api/imports')return {jobs:[]};if(p.endsWith('/transcript'))return transcript(p.split('/')[3]);return e.initialHandler(p,b,o);});
 e.account.setLibraryOpen(true);await settle();delayed=true;const read=e.account.readSaved({...savedItem('a'),mediaVersionId:'media-a'});await settle();e.account.selectReading('media-b');await settle();pending.resolve({items,usage});await read;await settle();assert.equal(e.account.getSnapshot().readingMediaVersionId,'media-b');assert.equal(e.account.getSnapshot().transcriptSegments[0].id,'segment-media-b');
 checks.push('a delayed saved-source lookup cannot overwrite a newer explicit reading selection');e.account.release();
}
{
 const e=create();await signIn(e);const pending=deferred();e.setHandler((p,b,o)=>p==='/api/library'?pending.promise:p==='/api/imports'?{jobs:[]}:e.initialHandler(p,b,o));const read=e.account.readSaved({...savedItem('a'),mediaVersionId:'media-a'});await settle();await e.account.logout();pending.resolve({items:[libraryItem('media-a',true)],usage});await read;await settle();assert.equal(e.account.getSnapshot().readingMediaVersionId,'');assert.equal(e.account.getSnapshot().loggedIn,false);assert.equal(e.account.getSnapshot().savedError,'');
 checks.push('a delayed saved-source lookup after logout cannot restore a private reader or report stale lookup errors');e.account.release();
}


{
 const e=create();await signIn(e);const page=createPage(e),first=savedItem('first'),second={...savedItem('second'),mediaVersionId:'media-a',mediaTitle:'A'};let removed=false;
 e.setHandler((p,b,o)=>{if(p==='/api/library')return {items:[libraryItem('media-a',true)],usage};if(p==='/api/imports')return {jobs:[]};if(p==='/api/saved-items')return new URL(e.requests.at(-1).url).searchParams.has('cursor')?{items:removed?[]:[second],nextCursor:'page-three'}:{items:[first],nextCursor:'page-two'};if(p==='/api/saved-items/second'||p==='/api/library/media-a/remove'){removed=true;return {};}return e.initialHandler(p,b,o);});
 e.account.setSavedOpen(true);await settle();await e.account.refreshSaved(true);page.beginNote(second);page.noteDraft='待删除的草稿';let dialog;
 page.getUIContext=()=>({showAlertDialog:value=>{dialog=value;}});page.confirmSavedRemoval(second);dialog.secondaryButton.action();await settle();assert.equal(page.editingSaved,'');assert.equal(page.noteDraft,'');assert.equal(e.account.getSnapshot().savedEditing,false);assert.equal(e.account.savedEditing,false);assert.equal(e.account.getSnapshot().savedItems.some(i=>i.id==='second'),false);
 removed=false;await e.account.refreshSaved(false,true);await e.account.refreshSaved(true);page.beginNote(second);e.account.setLibraryOpen(true);await settle();await e.account.removeLibrary('media-a','all');await settle();assert.equal(page.editingSaved,'');assert.equal(e.account.savedEditing,false);assert.equal(e.account.getSnapshot().savedItems.some(i=>i.mediaVersionId==='media-a'),false);
 checks.push('deleting the edited saved item through its actual confirmation action or deleting its episode clears editor locks and draft');page.aboutToDisappear();e.account.release();
}
{
 const e=create();await signIn(e);const page=createPage(e),first=savedItem('first'),second=savedItem('second'),pending=deferred();
 e.setHandler((p,b,o)=>{if(p==='/api/library')return {items:[],usage};if(p==='/api/imports')return {jobs:[]};if(p==='/api/saved-items')return new URL(e.requests.at(-1).url).searchParams.has('cursor')?{items:[second],nextCursor:'page-three'}:{items:[first],nextCursor:'page-two'};if(p==='/api/saved-items/second')return pending.promise;return e.initialHandler(p,b,o);});
 page.switchSection('saved');await settle();await e.account.refreshSaved(true);page.beginNote(second);page.noteDraft='离开页面后确认的新备注';const write=page.commitNote('second');await settle();page.switchSection('library');await settle();assert.equal(e.account.getSnapshot().savedBusy,true);
 pending.resolve({...second,note:'离开页面后确认的新备注',updatedAt:'2026-11-18T02:00:00Z'});await write;await settle();assert.equal(page.editingSaved,'');page.switchSection('saved');await settle();assert.equal(page.account.savedItems[1].note,'离开页面后确认的新备注');assert.equal(e.account.savedCursor,'page-three');assert.equal(e.account.getSnapshot().savedBusy,false);
 checks.push('a delayed second-page note PATCH still updates retained rows after leaving the panel and clears its mutation lock');page.aboutToDisappear();e.account.release();
}
{
 const e=create();await signIn(e);const page=createPage(e),a1={...savedItem('a1'),mediaVersionId:'media-a',mediaTitle:'A'},a2={...savedItem('a2'),mediaVersionId:'media-a',mediaTitle:'A'},b1={...savedItem('b1'),mediaVersionId:'media-b',mediaTitle:'B'};const pending=deferred();
 e.setHandler((p,b,o)=>{if(p==='/api/library')return {items:[libraryItem('media-a',true),libraryItem('media-b',true)],usage};if(p==='/api/imports')return {jobs:[]};if(p.endsWith('/transcript'))return transcript(p.split('/')[3]);if(p==='/api/saved-items'){const q=new URL(e.requests.at(-1).url).searchParams;return q.get('mediaVersionId')==='media-b'?{items:[b1],nextCursor:null}:q.has('cursor')?{items:[a2],nextCursor:'third-a'}:{items:[a1],nextCursor:'second-a'};}if(p==='/api/saved-items/a2')return pending.promise;return e.initialHandler(p,b,o);});
 e.account.setLibraryOpen(true);await settle();e.account.selectReading('media-a');await settle();e.account.setSavedOpen(true,true);await settle();await e.account.refreshSaved(true);page.beginNote(a2);page.noteDraft='独立保留的A草稿';
 page.switchSection('library');e.account.selectReading('media-b');await settle();assert.equal(e.account.savedMediaId,'media-b');assert.equal(e.account.getSnapshot().savedItems.length,0);assert.equal(e.account.savedExpanded,false);
 page.switchSection('saved');await settle();assert.deepEqual(clone(page.account.savedItems.map(i=>i.mediaVersionId)),['media-b']);assert.equal(page.editingSaved,'a2');assert.equal(page.editingSavedTitle,'A');assert.equal(page.noteDraft,'独立保留的A草稿');assert.equal(page.hasEditingSavedItem(),false);
 const write=page.commitNote('a2');await settle();pending.resolve({...a2,note:'独立保留的A草稿',updatedAt:'2026-11-18T02:00:00Z'});await write;await settle();assert.equal(page.editingSaved,'');assert.deepEqual(clone(page.account.savedItems.map(i=>i.id)),['b1']);assert.equal(page.account.savedItems[0].note,b1.note);
 checks.push('episode-filter caches bind to media ID; changing A to B discards A pages but retains a separately labelled A draft, and late A PATCH cannot insert or overwrite B');page.aboutToDisappear();e.account.release();
}
{
 const e=create();await signIn(e);const page=createPage(e),old=savedItem('old'),fresh=savedItem('fresh'),pending=deferred();let nextAccount=false;
 e.setHandler((p,b,o)=>{if(p==='/api/saved-items')return {items:[nextAccount?fresh:old],nextCursor:null};if(p==='/api/saved-items/old')return pending.promise;return e.initialHandler(p,b,o);});
 page.switchSection('saved');await settle();page.beginNote(old);page.noteDraft='旧账号备注';const write=page.commitNote('old');await settle();await e.account.logout();nextAccount=true;e.profile.user.id='u2';e.profile.session.id='s2';await signIn(e);page.switchSection('saved');await settle();
 pending.resolve({...old,note:'旧账号备注',updatedAt:'2026-11-18T02:00:00Z'});await write;await settle();assert.deepEqual(clone(page.account.savedItems.map(i=>i.id)),['fresh']);assert.equal(page.account.savedItems[0].note,fresh.note);assert.equal(page.editingSaved,'');assert.equal(e.account.getSnapshot().savedBusy,false);
 checks.push('a late successful note mutation from an old account cannot change the new account cache, editor or busy state');page.aboutToDisappear();e.account.release();
}

for (const failure of ['before-commit', 'http-lost', 'sse-before-error', 'sse-after-error', 408, 429, 503]) {
 const e=create();const {handler,turn}=await readingCitation(e);
 await e.account.playCitation(turn.id,'S1');await settle();
 const before=e.getSnapshot();let attempts=0,committed;
 e.setHandler(async(p,b,o)=>{
  if(p.endsWith('/takeover')&&b.intent==='restore'&&++attempts===1){
   if(typeof failure==='number')return {__status:failure,reply:{error:{message:'try again'}}};
   if(failure!=='before-commit')committed=await handler(p,b,o);
   if(failure==='sse-before-error')e.streams[0].event({event:'playback',data:JSON.stringify(committed.snapshot)});
   throw new Error('transport failed');
  }
  return handler(p,b,o);
 });
 await e.account.returnFromReplay();await settle();
 if(failure==='sse-after-error'){e.streams[0].event({event:'playback',data:JSON.stringify(committed.snapshot)});await settle();}
 assert.match(e.account.getSnapshot().replayReturnLabel,/0:42/);
 assert.equal(e.account.getSnapshot().owner,false);assert.equal(e.player.state.playerState,'paused');
 const plays=e.calls.filter(c=>c==='play').length;
 await e.account.returnFromReplay();await settle();
 const requests=e.requests.filter(r=>r.path.endsWith('/takeover')&&r.body.intent==='restore');
 assert.equal(requests.length,2);assert.deepEqual(requests[0].body,requests[1].body);
 assert.equal(requests[1].body.expectedGeneration,before.generation);
 assert.equal(e.getSnapshot().generation,before.generation+1);
 assert.equal(e.player.state.mediaVersionId,'media-b');assert.equal(e.player.state.positionMs,42000);
 assert.equal(e.calls.filter(c=>c==='play').length,plays+1);assert.equal(e.account.getSnapshot().replayReturnLabel,'');
 checks.push(`restore ${failure} preserves the original request and return point, pauses until confirmed, and commits exactly one generation`);e.account.release();
}
for(const notify of [true,false]){
 const e=create();const {handler,turn}=await readingCitation(e);await e.account.playCitation(turn.id,'S1');await settle();
 let first=true;
 e.setHandler(async(p,b,o)=>{if(p.endsWith('/takeover')&&b.intent==='restore'&&first){first=false;await handler(p,b,o);throw new Error('lost');}return handler(p,b,o);});
 await e.account.returnFromReplay();await settle();const request=clone(e.requests.filter(r=>r.path.endsWith('/takeover')).at(-1).body);
 // A second tab can have the same login session, but must still invalidate the old generation.
 const peer={...e.getSnapshot(),revision:e.getSnapshot().revision+1,generation:e.getSnapshot().generation+1,ownerSessionId:'s1',playbackSessionId:'other-tab'};
 e.setSnapshot(peer);if(notify)e.streams[0].event({event:'playback',data:JSON.stringify(peer)});
 e.setHandler((p,b,o)=>p.endsWith('/takeover')?{accepted:false,snapshot:peer}:handler(p,b,o));
 const count=e.requests.filter(r=>r.path.endsWith('/takeover')).length;
 await e.account.returnFromReplay();await settle();
 const all=e.requests.filter(r=>r.path.endsWith('/takeover'));assert.equal(all.length,count+(notify?0:1));
 if(!notify)assert.deepEqual(all.at(-1).body,request);
 assert.equal(e.account.getSnapshot().replayReturnLabel,'');assert.equal(e.account.pendingTakeover,undefined);
 assert.equal(e.account.getSnapshot().owner,false);assert.equal(e.player.state.playerState,'paused');
 assert.equal(e.getSnapshot().playbackSessionId,'other-tab');
 checks.push(`same-session peer takeover ${notify?'with':'without'} SSE cancels pending restore without rebasing or reclaiming playback`);e.account.release();
}
{
 const e=create();const {handler,turn}=await readingCitation(e);await e.account.playCitation(turn.id,'S1');await settle();
 e.setHandler((p,b,o)=>p.endsWith('/takeover')?{__status:404,reply:{error:{message:'removed'}}}:handler(p,b,o));
 await e.account.returnFromReplay();await settle();assert.equal(e.account.getSnapshot().replayReturnLabel,'');assert.equal(e.account.pendingTakeover,undefined);
 const count=e.requests.length;await e.account.returnFromReplay();assert.equal(e.requests.length,count);
 checks.push('permanent restore refusal removes the retry and cannot create further requests');e.account.release();
}
{
 const e=create();const {handler,turn}=await readingCitation(e);await e.account.playCitation(turn.id,'S1');await settle();const gate=deferred();let reply;
 e.setHandler(async(p,b,o)=>{if(p.endsWith('/takeover')){reply=await handler(p,b,o);return gate.promise;}return handler(p,b,o);});
 const restore=e.account.returnFromReplay();await settle();await e.account.logout();gate.resolve(reply);await restore;await settle();
 assert.equal(e.account.getSnapshot().loggedIn,false);assert.equal(e.account.getSnapshot().replayReturnLabel,'');assert.equal(e.account.pendingTakeover,undefined);
 assert.equal(e.player.state.playerState,'paused');assert.equal(e.account.getSnapshot().hint,'已退出登录');
 checks.push('late restore result after logout cannot replay private media or replace the cleared account state');e.account.release();
}
for(const retire of ['logout','reset']){
 const e=create();const {handler,turn}=await readingCitation(e);await e.account.playCitation(turn.id,'S1');await settle();
 const old=deferred(),fresh=deferred();let oldReply,freshReply;
 e.setHandler(async(p,b,o)=>{if(p.endsWith('/takeover')){oldReply=await handler(p,b,o);return old.promise;}return handler(p,b,o);});
 const staleReturn=e.account.returnFromReplay();await settle();
 if(retire==='logout'){await e.account.logout();e.setHandler(handler);await signIn(e);}
 else{e.streams[0].event({event:'reset',data:JSON.stringify(e.getSnapshot())});await settle();}
 assert.equal(e.account.replayChanging,false);assert.equal(e.account.getSnapshot().replayReturnLabel,'');
 e.setHandler(async(p,b,o)=>{if(p.endsWith('/takeover')){freshReply=await handler(p,b,o);return fresh.promise;}return handler(p,b,o);});
 const newReplay=e.account.playExcerpt('media-a',30000,45000);await settle();assert.equal(e.account.replayChanging,true);
 old.resolve(oldReply);await staleReturn;await settle();assert.equal(e.account.replayChanging,true,'old finally must not unlock new replay');
 fresh.resolve(freshReply);await newReplay;await settle();assert.equal(e.account.replayChanging,false);assert.equal(e.player.state.playerState,'playing');assert.equal(e.player.state.positionMs,30000);
 checks.push(`${retire} retires the restore lock and a late result cannot unlock a subsequent replay`);e.account.release();
}
{
 const e=create();const {handler,turn}=await readingCitation(e);await e.account.playCitation(turn.id,'S1');await settle();
 const load=e.player.loadMedia;let once=true;e.player.loadMedia=async function(...args){if(once){once=false;throw Error('media load failed');}return load.apply(this,args);};
 await e.account.returnFromReplay();await settle();assert.match(e.account.getSnapshot().replayReturnLabel,/0:42/);assert.equal(e.account.getSnapshot().owner,false);
 await e.account.returnFromReplay();await settle();const requests=e.requests.filter(r=>r.path.endsWith('/takeover')&&r.body.intent==='restore');
 assert.equal(requests.length,2);assert.deepEqual(requests[0].body,requests[1].body);assert.equal(e.player.state.mediaVersionId,'media-b');assert.equal(e.player.state.positionMs,42000);
 checks.push('media load failure after a confirmed restore can retry the original request without another takeover generation');e.account.release();
}
{
 const e=create();await signIn(e);e.account.setTranscriptOpen(true);await settle();
 const hit=(id,start)=>({id,startMs:start,endMs:start+1000,text:`关键词 ${id}`,highlights:[]});
 const first=hit('result-1',1000),second=hit('result-2',32000),third=hit('result-3',63000);
 const snap={transcriptJobId:'job-fixed',throughMs:90000};let changed=false;
 e.setHandler((p,b,o)=>{
  if(p.endsWith('/transcript/search')){const url=new URL(e.requests.at(-1).url),cursor=url.searchParams.get('cursor');return {mediaVersionId:'fixture-pcm-v1',query:'关键词',snapshot:changed?{...snap,throughMs:120000}:snap,results:cursor==='page-2'?[second]:cursor==='page-3'?[third]:[first],nextCursor:cursor==='page-2'?'page-3':cursor==='page-3'?null:'page-2',partial:true};}
  if(p.endsWith('/transcript'))return {mediaVersionId:'fixture-pcm-v1',job:{...transcript('fixture-pcm-v1').job,id:'job-fixed',durationMs:120000,completedMs:120000},segments:[second],pageCursor:0,nextCursor:null};
  if(p==='/api/saved-items'&&b)return {item:{id:'saved-search'}};
  return e.initialHandler(p,b,o);
 });
 await e.account.searchTranscript('关键词');await e.account.searchTranscript('changed draft text',true);
 assert.deepEqual(clone(e.account.getSnapshot().searchResults.map(x=>x.id)),['result-1','result-2']);
 const before=e.calls.length;await e.account.showContext(32000,'result-2');await settle();
 assert.equal(e.account.getSnapshot().searchView,'context');assert.equal(e.account.getSnapshot().searchContextId,'result-2');assert.deepEqual(clone(e.account.getSnapshot().selectedSegmentIds),[]);assert.equal(e.calls.length,before);
 e.account.returnToSearch();assert.equal(e.account.getSnapshot().searchView,'results');assert.equal(e.account.getSnapshot().searchResults.length,2);
 await e.account.saveSearchResult(second);const save=e.requests.filter(r=>r.path==='/api/saved-items'&&r.body).at(-1).body;assert.equal(save.source.throughMs,90000);
 changed=true;await e.account.searchTranscript('关键词',true);assert.equal(e.account.getSnapshot().searchResults.length,2);assert.match(e.account.getSnapshot().searchError,/范围已变化/);
 changed=false;await e.account.searchTranscript('关键词',true);assert.equal(e.account.getSnapshot().searchResults.length,3);assert.equal(e.account.getSnapshot().searchCanNext,false);
 assert.equal(new URL(e.requests.filter(r=>r.path.endsWith('/search')).at(-1).url).searchParams.get('cursor'),'page-3');
 checks.push('search context retains appended results and cursor; navigation never plays or selects, saves use the frozen watermark, changed next-page snapshots cannot replace results');e.account.release();
}
{
 const e=create();await signIn(e);const pending=deferred();
 e.setHandler((p,b,o)=>p.endsWith('/search')?{mediaVersionId:'fixture-pcm-v1',query:'词',snapshot:{transcriptJobId:'job-a',throughMs:90000},results:[{id:'target',startMs:1000,endMs:2000,text:'词',highlights:[]}],nextCursor:null,partial:true}:p.endsWith('/transcript')?pending.promise:e.initialHandler(p,b,o));
 await e.account.searchTranscript('词');const loading=e.account.showContext(1000,'target');await settle();e.account.returnToSearch();
 pending.resolve({mediaVersionId:'fixture-pcm-v1',job:null,segments:[],pageCursor:-1,nextCursor:null});await loading;await settle();
 assert.equal(e.account.getSnapshot().searchView,'results');assert.equal(e.account.getSnapshot().searchResults.length,1);assert.equal(e.account.getSnapshot().transcriptLoaded,false);
 e.account.clearSearch();assert.equal(e.account.getSnapshot().searchView,'');assert.equal(e.account.getSnapshot().searchQuery,'');
 checks.push('returning to search retires a delayed context read; clearing search removes cached result mode');e.account.release();
}
{
 const e=create();await signIn(e);const first=chapterPage('fixture-pcm-v1',{document:chapterDocument('doc-1'),chapters:[chapter('chapter-1')],nextAfter:40});const second=chapterPage('fixture-pcm-v1',{document:chapterDocument('doc-1'),chapters:[chapter('chapter-2',30000,42000,'segment-fixture-2')],nextAfter:null});
 installChapterApi(e,(url)=>url.searchParams.get('after')==='40'?second:first);
 e.account.setTranscriptOpen(true);await settle();e.account.setChaptersOpen(true);await settle();
 let chapterRequests=e.requests.filter(r=>r.path.endsWith('/chapters'));assert.equal(chapterRequests.length,1);assert.equal(new URL(chapterRequests[0].url).search,'');assert.equal(e.account.getSnapshot().chaptersPage.document.id,'doc-1');
 e.account.nextChapters();await settle();chapterRequests=e.requests.filter(r=>r.path.endsWith('/chapters'));let nextUrl=new URL(chapterRequests.at(-1).url);assert.equal(nextUrl.searchParams.get('documentId'),'doc-1');assert.equal(nextUrl.searchParams.get('after'),'40');assert.equal(e.account.getSnapshot().chaptersPage.chapters[0].id,'chapter-2');
 e.account.previousChapters();await settle();chapterRequests=e.requests.filter(r=>r.path.endsWith('/chapters'));const previousUrl=new URL(chapterRequests.at(-1).url);assert.equal(previousUrl.searchParams.get('documentId'),'doc-1');assert.equal(previousUrl.searchParams.get('after'),'0');assert.equal(e.account.getSnapshot().chaptersPage.chapters[0].id,'chapter-1');assert.equal(e.account.getSnapshot().chaptersCanPrevious,false);
 checks.push('chapter reads bind every page to one document snapshot and preserve next/previous cursors');e.account.release();
}
{
 const e=create();await signIn(e);const pageData=chapterPage();installChapterApi(e,()=>pageData);const page=createPage(e);
 e.account.setTranscriptOpen(true);await settle();e.account.setChaptersOpen(true);await settle();const beforeCalls=e.calls.length;const item=pageData.chapters[0];
 page.openChapterContext(item);await settle();let state=e.account.getSnapshot();assert.equal(page.contextFocusId,item.startSegmentId);assert.equal(state.chapterContext.id,item.id);assert.deepEqual(clone(state.selectedSegmentIds),[]);assert.equal(e.calls.length,beforeCalls);assert.equal(state.transcriptSegments[0].id,'segment-fixture-pcm-v1');
 e.account.returnToChapters();state=e.account.getSnapshot();assert.equal(state.chapterContext,null);assert.equal(state.chaptersOpen,true);assert.equal(e.calls.length,beforeCalls);page.aboutToDisappear();checks.push('chapter reading focuses its start segment without taking over playback and returns to the directory without selecting text');e.account.release();
}
{
 const e=create();await signIn(e);const empty=chapterPage('fixture-pcm-v1',{document:null,canGenerate:true,chapters:[]});const queued=chapterPage('fixture-pcm-v1',{document:chapterDocument('doc-g','queued',0,2),chapters:[]});const bodies=[];let attempts=0;
 installChapterApi(e,(url,body)=>{if(body?.action==='generate'){bodies.push(clone(body));if(++attempts===1)throw new Error('生成响应丢失');return queued;}return empty;});
 e.account.setTranscriptOpen(true);await settle();e.account.setChaptersOpen(true);await settle();await e.account.chapterAction('generate');await settle();assert.match(e.account.getSnapshot().chaptersError,/生成响应丢失/);await e.account.chapterAction('generate');await settle();assert.equal(bodies.length,2);assert.equal(bodies[0].requestId,bodies[1].requestId);assert.ok(bodies[0].requestId.length>0);assert.equal(e.account.getSnapshot().chaptersPage.document.id,'doc-g');assert.equal(e.account.getSnapshot().chaptersPage.document.status,'queued');
 checks.push('a lost chapter-generation response retries the same requestId and accepts the queued document on the next response');e.account.release();
}
{
 const e=create();await signIn(e);const failed=chapterPage('fixture-pcm-v1',{document:chapterDocument('doc-f','failed',1,2),chapters:[chapter()]});const running=chapterPage('fixture-pcm-v1',{document:chapterDocument('doc-f','running',1,2),chapters:[chapter()]});const cancelled=chapterPage('fixture-pcm-v1',{document:chapterDocument('doc-f','cancelled',1,2),chapters:[chapter()]});const bodies=[];
 installChapterApi(e,(url,body)=>{if(body?.action){bodies.push(clone(body));return body.action==='retry'?running:cancelled;}return failed;});
 e.account.setTranscriptOpen(true);await settle();e.account.setChaptersOpen(true);await settle();await e.account.chapterAction('retry');await settle();assert.deepEqual(bodies[0],{action:'retry',documentId:'doc-f'});assert.equal(e.account.getSnapshot().chaptersPage.document.status,'running');await e.account.chapterAction('cancel');await settle();assert.deepEqual(bodies[1],{action:'cancel',documentId:'doc-f'});assert.equal(e.account.getSnapshot().chaptersPage.document.status,'cancelled');assert.equal(e.account.getSnapshot().chaptersPage.chapters.length,1);
 checks.push('failed chapter generation can retry the bound document and cancel it while retaining completed chapters');e.account.release();
}
{
 const collapsed=create();await signIn(collapsed);const collapsedReply=deferred();installChapterApi(collapsed,()=>collapsedReply.promise);collapsed.account.setTranscriptOpen(true);await settle();collapsed.account.setChaptersOpen(true);await settle();collapsed.account.setChaptersOpen(false);collapsedReply.resolve(chapterPage());await settle();assert.equal(collapsed.account.getSnapshot().chaptersOpen,false);assert.equal(collapsed.account.getSnapshot().chaptersPage,null);assert.equal(collapsed.account.getSnapshot().chaptersBusy,false);collapsed.account.release();
 const switched=create();await signIn(switched);const items=[{...libraryItem('media-a',true),durationMs:240000},{...libraryItem('media-b',true),durationMs:240000}];const oldChapters=deferred();switched.setHandler((p,b,o)=>{if(p==='/api/library')return {items,usage};if(p==='/api/imports')return {jobs:[]};if(p.endsWith('/chapters'))return p.includes('/media-a/')?oldChapters.promise:chapterPage('media-b');if(p.endsWith('/transcript'))return transcript(p.split('/')[3]);if(p.endsWith('/chat'))return chat(p.split('/')[3]);return switched.initialHandler(p,b,o);});switched.account.setLibraryOpen(true);await settle();switched.account.selectReading('media-a');await settle();switched.account.setChaptersOpen(true);await settle();switched.account.selectReading('media-b');await settle();oldChapters.resolve(chapterPage('media-a'));await settle();assert.equal(switched.account.getSnapshot().readingMediaVersionId,'media-b');assert.equal(switched.account.getSnapshot().chaptersOpen,false);assert.equal(switched.account.getSnapshot().chaptersPage,null);switched.account.release();
 const loggedOut=create();await signIn(loggedOut);const logoutReply=deferred();installChapterApi(loggedOut,()=>logoutReply.promise);loggedOut.account.setTranscriptOpen(true);await settle();loggedOut.account.setChaptersOpen(true);await settle();await loggedOut.account.logout();logoutReply.resolve(chapterPage());await settle();assert.equal(loggedOut.account.getSnapshot().loggedIn,false);assert.equal(loggedOut.account.getSnapshot().chaptersPage,null);assert.equal(loggedOut.account.getSnapshot().chaptersOpen,false);assert.equal(loggedOut.account.getSnapshot().chaptersBusy,false);loggedOut.account.release();
 checks.push('late chapter responses are discarded after panel collapse, media switching, and logout');
}
{
 const e=create();await signIn(e);let gets=0;const running=chapterPage('fixture-pcm-v1',{document:chapterDocument('doc-poll','running',1,2),chapters:[chapter()]});const complete=chapterPage('fixture-pcm-v1',{document:chapterDocument('doc-poll','complete',2,2),chapters:[chapter()]});installChapterApi(e,(url)=>gets++===0?running:complete);
 e.account.setTranscriptOpen(true);await settle();e.account.setChaptersOpen(true);await settle();assert.equal(gets,1);e.advance(5001);e.account.tick();await settle();assert.equal(gets,2);const pollUrl=new URL(e.requests.filter(r=>r.path.endsWith('/chapters')).at(-1).url);assert.equal(pollUrl.searchParams.get('documentId'),'doc-poll');assert.equal(pollUrl.searchParams.get('after'),'0');assert.equal(e.account.getSnapshot().chaptersPage.document.status,'complete');
 checks.push('foreground ticking refreshes an expanded chapter panel and advances partial generation to complete');e.account.release();
}
{
 const e=create();await signIn(e);const item={...libraryItem('media-a',false),durationMs:240000};e.setHandler((p,b,o)=>{if(p==='/api/library')return {items:[item],usage};if(p==='/api/imports')return {jobs:[]};if(p.endsWith('/transcript'))return transcript('media-a','音频已清理仍可读');if(p.endsWith('/chat'))return chat('media-a');if(p.endsWith('/chapters'))return chapterPage('media-a',{audioAvailable:false});return e.initialHandler(p,b,o);});e.account.setLibraryOpen(true);await settle();e.account.selectReading('media-a');await settle();e.account.setChaptersOpen(true);await settle();const before=e.requests.length;assert.equal(e.account.getSnapshot().chaptersPage.audioAvailable,false);assert.equal(e.account.getSnapshot().chaptersPage.chapters.length,1);await e.account.playExcerpt('media-a',10000,20000);await settle();assert.equal(e.requests.filter(r=>r.path.endsWith('/takeover')).length,0);assert.equal(e.calls.includes('play'),false);assert.match(e.account.getSnapshot().error,/音频已清理/);checks.push('archived audio leaves chapter reading available while the explicit chapter playback action stays disabled');e.account.release();
}
{
 const e=create();await signIn(e);const zero=chapter('zero',1000,1000,'zero-source');installChapterApi(e,()=>chapterPage('fixture-pcm-v1',{chapters:[zero]}));
 e.account.setTranscriptOpen(true);await settle();e.account.setChaptersOpen(true);await settle();assert.equal(e.account.getSnapshot().chaptersError,'');assert.equal(e.account.getSnapshot().chaptersPage.chapters[0].startMs,1000);
 const before=e.calls.length;await e.account.playExcerpt('fixture-pcm-v1',1000,1000);assert.equal(e.calls.length,before);assert.equal(e.requests.filter(r=>r.path.endsWith('/takeover')).length,0);
 const page=createPage(e);page.chapterTopOffset=250;page.chapterScrollOffset=999;page.turnChapters(true);assert.equal(page.chapterScrollOffset,250);assert.equal(page.restoreChapterScroll,true);page.aboutToDisappear();
 checks.push('zero-duration chapter text remains readable without invented playback; page turn restores the chapter heading offset');e.account.release();
}
{
 const e=create();await signIn(e);const page=createPage(e),moves=[];page.readerScroller={offset:()=>({yOffset:0}),scrollTo:value=>moves.push(value.yOffset)};page.account={...page.account,chapterContext:chapter('layout',1000,2000,'target')};page.contextFocusId='target';
 page.alignSearchContext('target',{globalPosition:{y:10000}});page.alignSearchContext('target',{globalPosition:{y:12000}});assert.equal(moves.length,0);await new Promise(resolve=>setTimeout(resolve,180));assert.deepEqual(moves,[11988]);assert.equal(page.contextFocusId,'');
 page.contextFocusId='target';page.alignSearchContext('target',{globalPosition:{y:5000}});page.returnToChapters();await new Promise(resolve=>setTimeout(resolve,180));assert.equal(moves.length,1);page.aboutToDisappear();
 checks.push('context focus waits for stable layout, uses its latest offset once and ignores a deferred jump after returning');e.account.release();
}
{
 const e=create();await signIn(e);let gets=0;const first=summariesPage('fixture-pcm-v1',{document:summaryDocument('running',2,4),overview:null,parts:[{...summaryResult('part-1'),index:0},{...summaryResult('part-2',30000,50000),index:1}],nextAfter:2});const second=summariesPage('fixture-pcm-v1',{document:summaryDocument('running',4,4),overview:null,parts:[{...summaryResult('part-3',60000,80000),index:2}],nextAfter:null});
 installSummaryApi(e,(url)=>{gets++;return url.searchParams.get('after')==='2'?second:first;});e.account.setTranscriptOpen(true);await settle();e.account.setSummariesOpen(true);await settle();assert.equal(gets,1);assert.equal(new URL(e.requests.filter(r=>r.path.endsWith('/summaries')).at(-1).url).searchParams.get('capabilities'),'summary-topics-v1');assert.equal(e.account.getSnapshot().summariesPage.parts.length,2);assert.equal(e.account.getSnapshot().summariesPage.overview,null);e.account.nextSummaries();await settle();let url=new URL(e.requests.filter(r=>r.path.endsWith('/summaries')).at(-1).url);assert.equal(url.searchParams.get('documentId'),summaryIds.document);assert.equal(url.searchParams.get('after'),'2');assert.equal(e.account.getSnapshot().summariesPage.parts[0].index,2);e.account.previousSummaries();await settle();url=new URL(e.requests.filter(r=>r.path.endsWith('/summaries')).at(-1).url);assert.equal(url.searchParams.get('after'),'0');checks.push('summary pages bind one document snapshot, expose partial completed ranges and preserve next/previous cursors');e.account.release();
}
{
 const e=create();await signIn(e);const empty=summariesPage('fixture-pcm-v1',{document:null,overview:null,parts:[],canGenerate:true});const queued=summariesPage('fixture-pcm-v1',{document:summaryDocument('queued',0,2),overview:null,parts:[]});const bodies=[];let attempts=0;installSummaryApi(e,(url,body)=>{if(body?.action==='generate'){bodies.push(clone(body));if(++attempts===1)throw new Error('总结响应丢失');return queued;}return empty;});e.account.setTranscriptOpen(true);await settle();e.account.setSummariesOpen(true);await settle();await e.account.summaryAction('generate');await settle();assert.match(e.account.getSnapshot().summariesError,/总结响应丢失/);await e.account.summaryAction('generate');await settle();assert.equal(bodies.length,2);assert.equal(bodies[0].requestId,bodies[1].requestId);assert.equal(e.account.getSnapshot().summariesPage.document.status,'queued');checks.push('a lost summary-generation response retries the same requestId and accepts an offline queued document');e.account.release();
}
{
 const e=create();await signIn(e);const page=summariesPage();const evidence=summaryEvidence();let evidenceGets=0;installSummaryApi(e,(url,body,isEvidence)=>isEvidence?(evidenceGets++,evidence):page);e.account.setTranscriptOpen(true);await settle();e.account.setSummariesOpen(true);await settle();await e.account.toggleSummaryPoint('part-1',0);await settle();let request=e.requests.filter(r=>r.path.endsWith('/summaries/evidence')).at(-1);assert.equal(new URL(request.url).searchParams.get('documentId'),summaryIds.document);assert.equal(new URL(request.url).searchParams.get('nodeId'),'part-1');assert.equal(new URL(request.url).searchParams.get('pointIndex'),'0');assert.equal(evidenceGets,1);assert.equal(e.account.getSnapshot().summaryEvidence.segments[0].text,'冻结依据');await e.account.toggleSummaryPoint('part-1',0);assert.equal(e.account.getSnapshot().summaryEvidence,null);checks.push('summary points fetch frozen evidence on demand, collapse clears it, and the request is bound to document/node/point');e.account.release();
}
{
 const e=create();await signIn(e);const page=summariesPage('fixture-pcm-v1',{parts:[{...summaryResult('part-1',10000,20000,[summaryPoint('第一要点'),summaryPoint('第二要点')]),index:0}]});const first=summaryEvidence('fixture-pcm-v1',{segments:[{id:'summary-a',startMs:10000,endMs:12000,text:'第一冻结依据'}]});const second=summaryEvidence('fixture-pcm-v1',{pointIndex:1,segments:[{id:'summary-b',startMs:13000,endMs:15000,text:'第二冻结依据'}]});const pending=deferred();let evidenceGets=0;installSummaryApi(e,(url,body,isEvidence)=>{if(!isEvidence)return page;if(url.searchParams.get('pointIndex')==='0')return first;evidenceGets++;return pending.promise;});e.account.setTranscriptOpen(true);await settle();e.account.setSummariesOpen(true);await settle();await e.account.toggleSummaryPoint('part-1',0);await settle();assert.equal(e.account.getSnapshot().summaryEvidence.segments[0].text,'第一冻结依据');const secondRequest=e.account.toggleSummaryPoint('part-1',1);assert.equal(e.account.getSnapshot().summaryEvidence,null);assert.equal(e.account.getSnapshot().summaryEvidenceBusy,true);pending.resolve(second);await secondRequest;await settle();assert.equal(evidenceGets,1);assert.equal(e.account.getSnapshot().summaryEvidence.segments[0].text,'第二冻结依据');checks.push('switching summary points clears the prior frozen evidence while the new evidence request is pending');e.account.release();
 }
 {
 const e=create();await signIn(e);const initial=summariesPage('fixture-pcm-v1',{document:null,overview:null,parts:[],canGenerate:true});const queued=summariesPage('fixture-pcm-v1',{document:summaryDocument('queued',0,2),overview:null,parts:[]});const stale=deferred();let gets=0;let posts=0;installSummaryApi(e,(url,body,isEvidence)=>{if(isEvidence)return summaryEvidence();if(body?.action==='generate'){posts++;return queued;}gets++;if(gets===1)return initial;if(gets===2)return stale.promise;return queued;});e.account.setTranscriptOpen(true);await settle();e.account.setSummariesOpen(true);await settle();assert.equal(gets,1);e.advance(5001);e.account.tick();await settle();assert.equal(gets,2);await e.account.summaryAction('generate');await settle();assert.equal(posts,1);assert.equal(e.account.getSnapshot().summariesBusy,false);stale.resolve(initial);await settle();e.advance(5001);e.account.tick();await settle();assert.equal(gets,3);assert.equal(e.account.getSnapshot().summariesBusy,false);checks.push('a summary generation finishing during a pending refresh leaves the summary pollable after the stale refresh settles');e.account.release();
 }
 {
 const e=create();await signIn(e);const valid=summariesPage();let malformed={...valid,parts:Array.from({length:9},(_,i)=>({...summaryResult(`p-${i}`),index:i}))};installSummaryApi(e,()=>malformed);e.account.setTranscriptOpen(true);await settle();e.account.setSummariesOpen(true);await settle();assert.match(e.account.getSnapshot().summariesError,/总结响应无效/);assert.equal(e.account.getSnapshot().summariesPage,null);e.account.release();
 const invalidEvidence=create();await signIn(invalidEvidence);installSummaryApi(invalidEvidence,(url,body,isEvidence)=>isEvidence?summaryEvidence('other-media'):valid);invalidEvidence.account.setTranscriptOpen(true);await settle();invalidEvidence.account.setSummariesOpen(true);await settle();await invalidEvidence.account.toggleSummaryPoint('part-1',0);await settle();assert.match(invalidEvidence.account.getSnapshot().summaryEvidenceError,/总结依据无效/);assert.equal(invalidEvidence.account.getSnapshot().summaryEvidence,null);checks.push('malformed summary pages and evidence fail closed before replacing reader state');invalidEvidence.account.release();
}
{
 const e=create();await signIn(e);const page=summariesPage();const pending=deferred();let requests=0;installSummaryApi(e,()=>{requests++;return pending.promise;});e.account.setTranscriptOpen(true);await settle();e.account.setSummariesOpen(true);await settle();e.account.setSummariesOpen(false);pending.resolve(page);await settle();assert.equal(e.account.getSnapshot().summariesPage,null);assert.equal(e.account.getSnapshot().summariesBusy,false);const before=e.requests.length;e.account.setForeground(false);e.advance(6000);e.account.tick();await settle();assert.equal(e.requests.length,before);checks.push('collapsed summaries discard late responses and foreground-only polling does not run in background');e.account.release();
}
{
 const e=create();await signIn(e);const item={...libraryItem('media-a',false),durationMs:240000};e.setHandler((p,b,o)=>{if(p==='/api/library')return {items:[item],usage};if(p==='/api/imports')return {jobs:[]};if(p.endsWith('/transcript'))return transcript('media-a');if(p.endsWith('/summaries'))return summariesPage('media-a',{audioAvailable:false});if(p.endsWith('/chat'))return chat('media-a');return e.initialHandler(p,b,o);});e.account.setLibraryOpen(true);await settle();e.account.selectReading('media-a');await settle();e.account.setSummariesOpen(true);await settle();assert.equal(e.account.getSnapshot().summariesPage.audioAvailable,false);const before=e.requests.filter(r=>r.path.endsWith('/takeover')).length;await e.account.playExcerpt('media-a',10000,12000);assert.equal(e.requests.filter(r=>r.path.endsWith('/takeover')).length,before);assert.equal(e.calls.includes('play'),false);checks.push('archived summary evidence remains readable while explicit replay is disabled and never creates a takeover');e.account.release();
}
{
 const e=create();await signIn(e);const partial=summariesPage('fixture-pcm-v1',{document:summaryDocument('running',1,2),overview:summaryResult('invalid-overview'),parts:[{...summaryResult('part-1'),index:0}]});installSummaryApi(e,()=>partial);e.account.setTranscriptOpen(true);await settle();e.account.setSummariesOpen(true);await settle();assert.match(e.account.getSnapshot().summariesError,/总结生成状态无效/);assert.equal(e.account.getSnapshot().summariesPage,null);checks.push('partial summary documents never expose a premature whole-episode overview');e.account.release();
}
{
 const e=create();await signIn(e);const page=createPage(e);const data=summariesPage();installSummaryApi(e,()=>data);e.account.setTranscriptOpen(true);await settle();e.account.setSummariesOpen(true);await settle();assert.equal(e.account.getSnapshot().summariesPage.parts.length,2);page.aboutToDisappear();assert.equal(e.account.getSnapshot().summariesOpen,false);checks.push('summary panel is exposed as a separate reader action without changing playback or chat state');e.account.release();
}
{
 const e=create();await signIn(e);const empty=summariesPage('fixture-pcm-v1',{document:null,overview:null,parts:[],canGenerate:true});const old=summariesPage('fixture-pcm-v1',{canGenerate:true});const next=summariesPage('fixture-pcm-v1',{document:{...summaryDocument('queued',0,2),id:'33333333-3333-4333-8333-333333333333'},overview:null,parts:[]});const late=deferred(),bodies=[];let current=empty;
 installSummaryApi(e,(url,body,isEvidence)=>{if(isEvidence)return late.promise;if(body?.action==='generate'){bodies.push(clone(body));current=bodies.length===1?old:next;}return current;});e.account.setTranscriptOpen(true);await settle();e.account.setSummariesOpen(true);await settle();await e.account.summaryAction('generate');await settle();const pending=e.account.toggleSummaryPoint('part-1',0);await settle();assert.equal(e.account.getSnapshot().summaryEvidenceBusy,true);await e.account.summaryAction('generate');await settle();late.resolve(summaryEvidence());await pending;await settle();
 assert.equal(bodies.length,2);assert.notEqual(bodies[0].requestId,bodies[1].requestId);assert.equal(e.account.getSnapshot().summariesPage.document.id,next.document.id);assert.equal(e.account.getSnapshot().summaryEvidence,null);assert.equal(e.account.getSnapshot().summaryEvidenceBusy,false);assert.equal(e.account.getSnapshot().summariesBusy,false);checks.push('successful summary regeneration starts a new request identity, switches documents, and discards late old evidence');e.account.release();
}

const topicSummary=(mediaVersionId='fixture-pcm-v1',overrides={})=>summariesPage(mediaVersionId,{
 document:{...summaryDocument(),format:'topics-v1'},overview:null,
 topicOverview:{id:'root-topics',title:'全部主题',topics:[{index:0,title:'第一主题',pointCount:21},{index:1,title:'第二主题',pointCount:1}]},
 parts:[{...summaryResult('leaf-twelve',10000,20000,Array.from({length:12},(_,i)=>summaryPoint(`叶要点 ${i}`))),index:0}],...overrides
});
const topicPage=(index=0,after=0,mediaVersionId='fixture-pcm-v1',overrides={})=>({
 mediaVersionId,documentId:summaryIds.document,topicIndex:index,title:index===0?'第一主题':'第二主题',snapshot:{transcriptJobId:summaryIds.job,throughMs:120000},
 points:Array.from({length:Math.min(20,(index===0?21:1)-after)},(_,i)=>({nodeId:`topic-leaf-${index}-${after+i}`,pointIndex:11,text:`主题原要点 ${after+i}`,evidenceCount:16,startMs:10000,endMs:20000})),
 after,nextAfter:index===0&&after===0?20:null,totalPoints:index===0?21:1,...overrides
});
{
 const e=create();await signIn(e);const actions=[];
 installSummaryApi(e,(url,body,isEvidence,isTopic)=>{
  assert.equal(isEvidence?true:url.searchParams.get('capabilities')==='summary-topics-v1',true);
  if(isEvidence)return summaryEvidence('fixture-pcm-v1',{nodeId:url.searchParams.get('nodeId'),pointIndex:Number(url.searchParams.get('pointIndex'))});
  if(isTopic)return topicPage(Number(url.searchParams.get('topicIndex')),Number(url.searchParams.get('after')));
  if(body)actions.push(body);return topicSummary('fixture-pcm-v1',{canGenerate:true});
 });
 e.account.setTranscriptOpen(true);await settle();e.account.setSummariesOpen(true);await settle();
 assert.equal(e.account.getSnapshot().summariesError,'');assert.equal(e.account.getSnapshot().summariesPage.parts[0].points.length,12);
 const playback=e.calls.length;e.account.openSummaryTopic(0);await settle();assert.equal(e.account.getSnapshot().summaryTopicPage.points.length,20);assert.equal(e.account.getSnapshot().summaryTopicPage.nextAfter,20);
 await e.account.toggleSummaryPoint('topic-leaf-0-0',11);await settle();let evidence=e.account.getSnapshot().summaryEvidence;assert.equal(evidence.nodeId,'topic-leaf-0-0');assert.equal(evidence.pointIndex,11);
 let url=new URL(e.requests.filter(r=>r.path.endsWith('/summaries/evidence')).at(-1).url);assert.equal(url.searchParams.get('nodeId'),'topic-leaf-0-0');assert.equal(url.searchParams.get('pointIndex'),'11');
 e.account.nextSummaryTopic();await settle();assert.equal(e.account.getSnapshot().summaryTopicPage.after,20);assert.equal(e.account.getSnapshot().summaryTopicPage.points.length,1);assert.equal(e.account.getSnapshot().summaryEvidence,null);assert.equal(e.account.getSnapshot().summaryTopicCanPrevious,true);
 e.account.previousSummaryTopic();await settle();assert.equal(e.account.getSnapshot().summaryTopicPage.after,0);assert.equal(e.account.getSnapshot().summaryTopicCanPrevious,false);
 e.account.openSummaryTopic(1);await settle();assert.equal(e.account.getSnapshot().summaryTopicPage.topicIndex,1);assert.equal(e.calls.length,playback);
 e.account.openSummaryTopic(1);assert.equal(e.account.getSnapshot().summaryTopicPage,null);assert.equal(e.account.getSnapshot().summaryTopicBusy,false);
 await e.account.toggleSummaryPoint('leaf-twelve',11);await settle();assert.equal(e.account.getSnapshot().summaryEvidence.pointIndex,11);
 await e.account.summaryAction('generate');assert.equal(actions.length,1);
 checks.push('topic summaries negotiate capability, retain all 12 leaf points and frozen point 11, page 21 theme points independently, and never autoplay');e.account.release();
}
{
 const e=create();await signIn(e);const oldTopic=deferred(),oldEvidence=deferred();let first=true;
 installSummaryApi(e,(url,body,isEvidence,isTopic)=>{
  if(isEvidence)return oldEvidence.promise;
  if(isTopic){if(first){first=false;return oldTopic.promise;}return topicPage(Number(url.searchParams.get('topicIndex')),Number(url.searchParams.get('after')));}
  return topicSummary();
 });e.account.setTranscriptOpen(true);await settle();e.account.setSummariesOpen(true);await settle();
 e.account.openSummaryTopic(0);await settle();assert.equal(e.account.getSnapshot().summaryTopicBusy,true);e.account.openSummaryTopic(1);await settle();
 oldTopic.resolve(topicPage());await settle();assert.equal(e.account.getSnapshot().summaryTopicPage.topicIndex,1);assert.equal(e.account.getSnapshot().summaryTopicBusy,false);
 const evidenceRequest=e.account.toggleSummaryPoint('topic-leaf-1-0',11);await settle();e.account.openSummaryTopic(0);await settle();oldEvidence.resolve(summaryEvidence('fixture-pcm-v1',{nodeId:'topic-leaf-1-0',pointIndex:11}));await evidenceRequest;
 assert.equal(e.account.getSnapshot().summaryEvidence,null);assert.equal(e.account.getSnapshot().summaryEvidenceBusy,false);assert.equal(e.account.getSnapshot().summaryTopicPage.topicIndex,0);
 checks.push('late topic and evidence responses cannot cross a theme switch, and their busy states are released');e.account.release();
}
{
 for(const stop of ['collapse','background','reading','release','regenerate']){
  const e=create();await signIn(e);const pending=deferred();const replacement=topicSummary('fixture-pcm-v1',{document:{...summaryDocument('queued',0,2),format:'topics-v1',id:'33333333-3333-4333-8333-333333333333'},topicOverview:null,parts:[]});
  installSummaryApi(e,(url,body,isEvidence,isTopic)=>isTopic?pending.promise:body?replacement:topicSummary('fixture-pcm-v1',{canGenerate:true}));
  e.account.setTranscriptOpen(true);await settle();e.account.setSummariesOpen(true);await settle();e.account.openSummaryTopic(0);await settle();
  if(stop==='collapse')e.account.setSummariesOpen(false);
  if(stop==='background')e.account.setForeground(false);
  if(stop==='reading')e.account.returnToCurrent();
  if(stop==='release')e.account.release();
  if(stop==='regenerate')await e.account.summaryAction('generate');
  pending.resolve(topicPage());await settle();assert.equal(e.account.getSnapshot().summaryTopicPage,null,stop);assert.equal(e.account.getSnapshot().summaryTopicBusy,false,stop);assert.equal(e.account.getSnapshot().summaryTopicCanPrevious,false,stop);
  e.account.release();
 }
 checks.push('late theme pages are discarded on collapse, background, reading reset, release and regenerated document');
}
{
 const invalids=[{mediaVersionId:'other'},{documentId:'33333333-3333-4333-8333-333333333333'},{topicIndex:1},{snapshot:{transcriptJobId:summaryIds.job,throughMs:110000}},{after:20},{nextAfter:19},{totalPoints:20},{title:'错主题'},{points:[...topicPage().points.slice(0,19),{...topicPage().points[19],pointIndex:12}]}];
 for(const override of invalids){
  const e=create();await signIn(e);installSummaryApi(e,(url,body,isEvidence,isTopic)=>isTopic?topicPage(0,0,'fixture-pcm-v1',override):topicSummary());e.account.setTranscriptOpen(true);await settle();e.account.setSummariesOpen(true);await settle();e.account.openSummaryTopic(0);await settle();assert.equal(e.account.getSnapshot().summaryTopicPage,null);assert.match(e.account.getSnapshot().summaryTopicError,/主题/);assert.equal(e.account.getSnapshot().summaryTopicBusy,false);e.account.release();
 }
 const e=create();await signIn(e);installSummaryApi(e,()=>topicSummary('fixture-pcm-v1',{document:{...summaryDocument('running',1,2),format:'topics-v1'}}));e.account.setTranscriptOpen(true);await settle();e.account.setSummariesOpen(true);await settle();assert.equal(e.account.getSnapshot().summariesPage,null);assert.match(e.account.getSnapshot().summariesError,/主题生成状态/);e.account.release();
 checks.push('theme pages reject mismatched identity, snapshot, count, cursor, title and invalid leaf indexes; unfinished topics cannot appear');
}
{
 const e=create();await signIn(e);const item={...libraryItem('media-a',false),durationMs:240000};
 e.setHandler((p,b,o)=>{
  if(p==='/api/library')return {items:[item],usage};if(p==='/api/imports')return {jobs:[]};if(p.endsWith('/transcript'))return transcript('media-a');if(p.endsWith('/chat'))return chat('media-a');
  if(p.endsWith('/summaries'))return topicSummary('media-a',{audioAvailable:false});if(p.endsWith('/summaries/topics'))return topicPage(0,0,'media-a');if(p.endsWith('/summaries/evidence'))return summaryEvidence('media-a',{nodeId:'topic-leaf-0-0',pointIndex:11,audioAvailable:false});return e.initialHandler(p,b,o);
 });e.account.setLibraryOpen(true);await settle();e.account.selectReading('media-a');await settle();e.account.setSummariesOpen(true);await settle();e.account.openSummaryTopic(0);await settle();await e.account.toggleSummaryPoint('topic-leaf-0-0',11);assert.equal(e.account.getSnapshot().summaryEvidence.audioAvailable,false);
 const before=e.requests.filter(r=>r.path.endsWith('/takeover')).length;await e.account.playExcerpt('media-a',10000,12000);assert.equal(e.requests.filter(r=>r.path.endsWith('/takeover')).length,before);assert.equal(e.calls.includes('play'),false);
 checks.push('archived topic summaries and point 11 evidence stay readable without takeover or playback');e.account.release();
}


{
 const e=create();await signIn(e);const pending=deferred();let first=true;
 installSummaryApi(e,(url,body,isEvidence,isTopic)=>isTopic?(first?(first=false,pending.promise):topicPage(Number(url.searchParams.get('topicIndex')),Number(url.searchParams.get('after')))):topicSummary());
 e.account.setTranscriptOpen(true);await settle();e.account.setSummariesOpen(true);await settle();const page=createPage(e),moves=[];let offset=1000;page.readerScroller={offset:()=>({yOffset:offset}),scrollTo:value=>moves.push(value.yOffset)};page.scrollWindowY=100;
 const playback=e.calls.length;page.openSummaryTopic(0);page.alignSummaryTopic({globalPosition:{y:300}});await new Promise(resolve=>setTimeout(resolve,170));assert.equal(moves.length,0);
 pending.resolve(topicPage());await settle();page.alignSummaryTopic({globalPosition:{y:250}});page.alignSummaryTopic({globalPosition:{y:300}});await new Promise(resolve=>setTimeout(resolve,170));assert.deepEqual(moves,[1188]);
 offset=9000;page.turnSummaryTopic(true);await settle();assert.equal(page.account.summaryTopicPage.after,20);page.alignSummaryTopic({globalPosition:{y:-7700}});await new Promise(resolve=>setTimeout(resolve,170));assert.deepEqual(moves,[1188,1188]);
 await e.account.refreshSummaries();await settle();page.alignSummaryTopic({globalPosition:{y:1000}});await new Promise(resolve=>setTimeout(resolve,170));assert.equal(moves.length,2);assert.equal(e.calls.length,playback);
 checks.push('user-opened topics and a 20-to-1-point page turn align once after stable successful layout; background summary polling never scrolls or changes playback');page.aboutToDisappear();e.account.release();
}
{
 const e=create();await signIn(e);let fail=true;
 installSummaryApi(e,(url,body,isEvidence,isTopic)=>{if(!isTopic)return topicSummary();if(url.searchParams.get('after')==='20'&&fail)throw new Error('主题分页临时失败');return topicPage(Number(url.searchParams.get('topicIndex')),Number(url.searchParams.get('after')));});
 e.account.setTranscriptOpen(true);await settle();e.account.setSummariesOpen(true);await settle();const page=createPage(e),moves=[];page.readerScroller={offset:()=>({yOffset:5000}),scrollTo:value=>moves.push(value.yOffset)};page.scrollWindowY=100;
 page.openSummaryTopic(0);await settle();page.turnSummaryTopic(true);await settle();assert.match(page.account.summaryTopicError,/临时失败/);page.alignSummaryTopic({globalPosition:{y:-3700}});await new Promise(resolve=>setTimeout(resolve,170));assert.deepEqual(moves,[1188]);
 fail=false;page.retrySummaryTopic();await settle();assert.equal(page.account.summaryTopicPage.after,20);page.alignSummaryTopic({globalPosition:{y:-3600}});await new Promise(resolve=>setTimeout(resolve,170));assert.deepEqual(moves,[1188,1288]);
 checks.push('failed theme page navigation aligns the retry region, and an explicit retry aligns its recovered page');page.aboutToDisappear();e.account.release();
}
{
 for(const stop of ['collapse','background','media','document','exit']){
  const e=create();await signIn(e);const replacement=topicSummary('fixture-pcm-v1',{document:{...summaryDocument('queued',0,2),format:'topics-v1',id:'33333333-3333-4333-8333-333333333333'},topicOverview:null,parts:[]});
  installSummaryApi(e,(url,body,isEvidence,isTopic)=>isTopic?topicPage():body?replacement:topicSummary('fixture-pcm-v1',{canGenerate:true}));
  e.account.setTranscriptOpen(true);await settle();e.account.setSummariesOpen(true);await settle();const page=createPage(e),moves=[];page.readerScroller={offset:()=>({yOffset:5000}),scrollTo:value=>moves.push(value.yOffset)};
  page.openSummaryTopic(0);await settle();page.alignSummaryTopic({globalPosition:{y:-3500}});
  if(stop==='collapse')page.openSummaryTopic(0);
  if(stop==='background')e.account.setForeground(false);
  if(stop==='media')e.account.returnToCurrent();
  if(stop==='document')await e.account.summaryAction('generate');
  if(stop==='exit')page.aboutToDisappear();
  await new Promise(resolve=>setTimeout(resolve,170));assert.equal(moves.length,0,stop);page.aboutToDisappear();e.account.release();
 }
 checks.push('scheduled theme alignment is retired after collapse, background, media reset, regenerated document and page exit');
}

 console.log(JSON.stringify({passed:true,checks},null,2));
