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
 const context={exports:{},Date:Clock,JSON,Number,Math,Error,Promise,Record:undefined,
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
console.log(JSON.stringify({passed:true,checks},null,2));


