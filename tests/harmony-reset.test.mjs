import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const dir=new URL('../apps/harmony/entry/src/main/ets/services/',import.meta.url);
const source=fs.readFileSync(new URL('AccountSync.ets',dir),'utf8').replace(/^import .*;$/gm,'');
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
 class FakeStream{constructor(event,state){this.event=event;this.state=state;this.foreground=true;streams.push(this);}start(url,token){this.starts=(this.starts??0)+1;this.cursor='' ;this.url=url;this.token=token;this.state({status:'connected'});}stop(){this.token='';this.state({status:'stopped'});}setForeground(v){this.foreground=v;}reconnect(){}}
 class FakeRequest{destroyed=false;destroy(){this.destroyed=true;}async request(url,options){const path=new URL(url).pathname;const body=options.extraData?JSON.parse(options.extraData):undefined;const req={path,body,options,native:this};requests.push(req);if(path==='/api/playback/report'){reportCount++;maxReports=Math.max(maxReports,reportCount);}try{const v=await handler(path,body,options);if(v?.__status)return {responseCode:v.__status,result:JSON.stringify(v.reply)};return {responseCode:200,result:JSON.stringify(v)};}finally{if(path==='/api/playback/report')reportCount--;}}}
 class Clock extends Date{constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}}
 const context={exports:{},Date:Clock,JSON,Number,Math,Error,Promise,Record:undefined,
 http:{RequestMethod:{GET:'GET',POST:'POST'},HttpDataType:{STRING:0},createHttp:()=>new FakeRequest()},
 util:{generateRandomUUID:()=>`req-${requests.length}`},PlaybackService:{getInstance:()=>player},SessionVault:FakeVault,EventStream:FakeStream,
 setInterval:()=>1,clearInterval:()=>{},setTimeout,clearTimeout};vm.runInNewContext(compiled,context);
 const account=context.exports.AccountSync.getInstance();
 return {account,player,record,requests,streams,calls,profile,setHandler:f=>handler=f,initialHandler,setSnapshot:v=>snapshot=v,getSnapshot:()=>clone(snapshot),advance:ms=>now+=ms,getMax:()=>maxReports};
}
async function signIn(e){await e.account.initialize();await e.account.requestCode('http://127.0.0.1:3000','a@example.com');await e.account.verifyCode('http://127.0.0.1:3000','a@example.com','123456');await settle();}
const checks=[];
async function owning(){const e=create();e.setSnapshot({...e.getSnapshot(),revision:17,generation:6});await signIn(e);await e.account.takeover();await settle();assert.equal(e.account.getSnapshot().revision,20);assert.equal(e.account.getSnapshot().generation,7);return e;}
const low=e=>({...e.getSnapshot(),revision:5,generation:2,sequence:0,positionMs:41000,state:'paused',ownerSessionId:'s1',playbackSessionId:'reset-p2'});
function sendReset(e,s){e.setSnapshot(s);e.streams[0].event({event:'reset',data:JSON.stringify(s),id:String(s.revision)});}
{
 const e=await owning();const before=e.requests.filter(r=>r.path.endsWith('/report')).length;const starts=e.streams[0].starts;const s=low(e);sendReset(e,s);assert.equal(e.account.getSnapshot().revision,5);assert.equal(e.account.getSnapshot().generation,2);assert.equal(e.player.state.playerState,'paused');assert.equal(e.account.getSnapshot().owner,false);assert.equal(e.streams[0].starts,starts+1);assert.equal(e.streams[0].cursor,'');assert.equal(e.streams[0].token,'secret-token');assert.equal(e.record.clears,0);assert.equal(e.account.pendingReport,undefined);assert.equal(e.account.pendingTakeover,undefined);await settle();e.advance(3000);e.account.tick();await settle();assert.equal(e.requests.filter(r=>r.path.endsWith('/report')).length,before);
 const newer={...s,revision:6,positionMs:45000};e.setSnapshot(newer);e.streams[0].event({event:'playback',data:JSON.stringify(newer),id:'6'});assert.equal(e.account.getSnapshot().revision,6);await e.account.takeover();await settle();assert.equal(e.account.getSnapshot().generation,3);assert.equal(e.account.getSnapshot().owner,true);assert.equal(e.player.state.playerState,'playing');checks.push('20/7 -> reset 5/2 pauses and clears control/cursor, preserves login/Asset, accepts 6 and fresh manual generation 3 takeover');e.account.release();
}
{
 const e=await owning();const old=deferred(),fresh=deferred();let gets=0;e.setHandler((p,b,o)=>p==='/api/playback'?(++gets===1?old.promise:fresh.promise):e.initialHandler(p,b,o));const pending=e.account.refresh();await settle();const request=e.requests.at(-1);sendReset(e,low(e));await settle();assert.equal(request.native.destroyed,true);assert.equal(gets,2);const currentEpoch=e.account.refreshEpoch;old.resolve({snapshot:{...e.getSnapshot(),revision:20,generation:7,positionMs:1000}});await pending;assert.equal(e.account.getSnapshot().revision,5);assert.equal(e.account.refreshEpoch,currentEpoch);await e.account.refresh();assert.equal(gets,2);fresh.resolve({snapshot:e.getSnapshot()});await settle();assert.equal(e.account.getSnapshot().revision,5);checks.push('late pre-reset GET cannot restore revision20 or unlock current GET');e.account.release();
}
{
 const e=await owning();const old=deferred(),fresh=deferred();let reports=0;e.setHandler((p,b,o)=>p.endsWith('/report')?(++reports===1?old.promise:fresh.promise):e.initialHandler(p,b,o));await e.account.seek(23000);await settle();const oldRequest=e.requests.filter(r=>r.path.endsWith('/report')).at(-1);sendReset(e,low(e));await settle();assert.equal(oldRequest.native.destroyed,true);await e.account.takeover();await settle();assert.equal(reports,2);const currentEpoch=e.account.reportEpoch;old.resolve({snapshot:{...e.getSnapshot(),revision:20,generation:7,sequence:99,positionMs:23000},accepted:true});await settle();assert.equal(e.account.getSnapshot().generation,3);assert.ok(e.account.getSnapshot().revision<20);assert.equal(e.account.reportEpoch,currentEpoch);await e.account.seek(55000);await settle();assert.equal(reports,2);const body=e.requests.filter(r=>r.path.endsWith('/report')).at(-1).body;e.setHandler(e.initialHandler);fresh.resolve({snapshot:{...e.getSnapshot(),...body,revision:e.getSnapshot().revision+1},accepted:true});await settle();assert.equal(e.account.getSnapshot().generation,3);assert.equal(e.account.getSnapshot().owner,true);checks.push('late pre-reset report cannot alter new ownership or unlock new report; latest state remains queued');e.account.release();
}
{
 const e=create();e.setSnapshot({...e.getSnapshot(),revision:20,generation:7});await signIn(e);const old=deferred(),fresh=deferred();let takes=0;e.setHandler((p,b,o)=>p.endsWith('/takeover')?(++takes===1?old.promise:fresh.promise):e.initialHandler(p,b,o));const oldTake=e.account.takeover();await settle();const oldRequest=e.requests.at(-1);sendReset(e,low(e));await settle();assert.equal(e.account.getSnapshot().busy,false);assert.equal(oldRequest.native.destroyed,true);const newTake=e.account.takeover();await settle();assert.equal(e.account.getSnapshot().busy,true);old.resolve({snapshot:{...e.getSnapshot(),revision:21,generation:8,ownerSessionId:'s1',playbackSessionId:'old8'},accepted:true});await oldTake;assert.equal(e.account.getSnapshot().revision,5);assert.equal(e.account.getSnapshot().owner,false);assert.equal(e.account.getSnapshot().busy,true);assert.equal(e.calls.includes('play'),false);const newReq=e.requests.filter(r=>r.path.endsWith('/takeover')).at(-1);assert.equal(newReq.body.expectedGeneration,2);const next={...e.getSnapshot(),revision:6,generation:3,ownerSessionId:'s1',playbackSessionId:'new3',sequence:0};e.setSnapshot(next);fresh.resolve({snapshot:next,accepted:true});await newTake;await settle();assert.equal(e.account.getSnapshot().owner,true);assert.equal(e.account.getSnapshot().busy,false);assert.equal(e.account.getSnapshot().generation,3);checks.push('late pre-reset accepted takeover cannot play or clear newer takeover busy lock');e.account.release();
}
{
 const e=await owning();const old=deferred();let gets=0;e.setHandler((p,b,o)=>p==='/api/playback'&&++gets===1?old.promise:e.initialHandler(p,b,o));const pending=e.account.refresh();await settle();sendReset(e,low(e));await settle();old.resolve({__status:401,reply:{error:{code:'expired',message:'late old unauthorized'}}});await pending;await settle();assert.equal(e.account.getSnapshot().loggedIn,true);assert.equal(e.record.clears,0);assert.equal(e.account.getSnapshot().revision,5);checks.push('old history unauthorized response cannot expire current authenticated sync era');e.account.release();
}
const result={passed:true,checks};console.log(JSON.stringify(result,null,2));

