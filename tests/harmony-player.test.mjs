import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import vm from 'node:vm';
import ts from 'typescript';
import { randomUUID } from 'node:crypto';
const services = ['DiagnosticReport', 'PlaybackService'];
const source = (await Promise.all(services.map(async name =>
  (await readFile(new URL(`../apps/harmony/entry/src/main/ets/services/${name}.ets`, import.meta.url), 'utf8'))
    .replace(/^import .*;$/gm, '')))).join('\n');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};};
const settle=async()=>{for(let i=0;i<50;i++)await Promise.resolve();};
function create(clock = {}){
 const players=[],sessions=[],sources=[],logs=[];let nextPlan={},starts=0,stops=0,opened=0,closed=0;
 const downloads=[],settings=new Map();
 class PlaybackCacheDownload {
  constructor(){this.transfer=deferred();this.closed=0;downloads.push(this);}
  read(directory,url,token,onPercent){Object.assign(this,{directory,url,token,onPercent});return this.transfer.promise;}
  cancel(){this.cancelled=true;}
  close(){this.closed++;}
 }
 class Player{constructor(plan){this.plan=plan;this.state='idle';this.duration=plan.duration??240000;this.handlers={};this.plays=0;this.seeks=[];this.released=false;players.push(this);}on(k,f){this.handlers[k]=f;}off(k){delete this.handlers[k];}emit(k,...a){this.handlers[k]?.(...a);}change(s){this.state=s;this.emit('stateChange',s);}set fdSrc(v){this.duration=120000;this.change('initialized');}setMediaSource(src,strategy){assert.ok(strategy);this.source=src;if(this.plan.fail)return Promise.reject(new Error('Authorization test-secret and '+src.url));this.change('initialized');return this.plan.promiseSource ? Promise.resolve() : undefined;}async prepare(){if(this.plan.prepare)await this.plan.prepare.promise;this.change('prepared');}async play(){this.plays++;if(this.plan.play)await this.plan.play.promise;this.change('playing');}async pause(){this.change('paused');}seek(p){this.seeks.push(p);this.emit('seekDone',p);}setSpeed(v){this.emit('speedDone',v);}async release(){this.released=true;this.state='released';}}
 class Session{handlers={};on(k,f){this.handlers[k]=f;}off(k){delete this.handlers[k];}async setLaunchAbility(){}async activate(){}async deactivate(){}async destroy(){}async setAVMetadata(v){this.metadata=v;}async setAVPlaybackState(v){this.playback=v;}}
 const context={exports:{},Date,Math,Error,Promise,JSON,Number,setTimeout,clearTimeout,...clock,encodeURIComponent,PlaybackCacheDownload,
 util:{generateRandomUUID:randomUUID},deviceInfo:{sdkApiVersion:20},
 bundleManager:{BundleFlag:{GET_BUNDLE_INFO_DEFAULT:0},getBundleInfoForSelfSync:()=>({versionName:'1.2.3'})},
 preferences:{getPreferencesSync:()=>({getSync:(key,fallback)=>settings.get(key)??fallback,putSync:(key,value)=>settings.set(key,value),flush:async()=>{}})},
 media:{createAVPlayer:async()=>{const p=new Player(nextPlan);nextPlan={};return p;},createMediaSourceWithUrl:(url,headers)=>{const src={url,headers};sources.push(src);return src;},SeekMode:{SEEK_CLOSEST:0},PlaybackSpeed:{SPEED_FORWARD_1_00_X:1,SPEED_FORWARD_1_25_X:1.25,SPEED_FORWARD_1_50_X:1.5,SPEED_FORWARD_2_00_X:2},BufferingInfoType:{BUFFERING_START:1,BUFFERING_END:2}},
 audio:{StreamUsage:{STREAM_USAGE_MUSIC:1},InterruptMode:{SHARE_MODE:1},InterruptHint:{INTERRUPT_HINT_PAUSE:1,INTERRUPT_HINT_STOP:2,INTERRUPT_HINT_RESUME:3},AudioStreamDeviceChangeReason:{REASON_OLD_DEVICE_UNAVAILABLE:1}},
 wantAgent:{OperationType:{START_ABILITY:1},WantAgentFlags:{UPDATE_PRESENT_FLAG:1},getWantAgent:async()=>({})},
 avSession:{createAVSession:async()=>{const s=new Session();sessions.push(s);return s;},PlaybackState:{PLAYBACK_STATE_PAUSE:1,PLAYBACK_STATE_PLAY:2,PLAYBACK_STATE_STOP:3}},
 backgroundTaskManager:{BackgroundMode:{AUDIO_PLAYBACK:1},startBackgroundRunning:async()=>{starts++;},stopBackgroundRunning:async()=>{stops++;}},
 hilog:{error:(...a)=>logs.push(a.join(' ')),warn:(...a)=>logs.push(a.join(' '))}};
 vm.runInNewContext(compiled,context);const player=context.exports.PlaybackService.getInstance();
 const ability={abilityInfo:{bundleName:'test',name:'EntryAbility'},resourceManager:{getRawFd:async()=>{opened++;return {fd:1,offset:0,length:100};},closeRawFd:async()=>{closed++;}}};
 return {player,players,sessions,sources,logs,ability,downloads,settings,diagnostics:context.exports,setPlan:p=>nextPlan=p,counts:()=>({starts,stops,opened,closed})};
}
const checks=[];
{
 const e=create();await e.player.initialize(e.ability);assert.equal(e.player.getSnapshot().ready,true);await e.player.loadMedia('content-a','media-a','A','http://127.0.0.1:3000','test-secret');assert.equal(e.sources[0].url,'http://127.0.0.1:3000/api/media/media-a');assert.equal(e.sources[0].headers.Authorization,'Bearer test-secret');assert.equal(e.player.getSnapshot().mediaVersionId,'media-a');assert.equal(e.player.getSnapshot().durationMs,240000);assert.equal(e.sessions.at(-1).metadata.title,'A');assert.equal(JSON.stringify(e.player.getSnapshot()).includes('test-secret'),false);
 let allowed=true;e.player.setPlaybackPermission(()=>allowed);await e.player.play();await e.player.pause();const p=e.players.at(-1);const count=p.plays;allowed=false;e.sessions.at(-1).handlers.play();await settle();assert.equal(p.plays,count);allowed=true;e.sessions.at(-1).handlers.play();await settle();assert.equal(p.plays,count+1);await e.player.pause();
 p.emit('bufferingUpdate',1,0);assert.equal(e.player.getSnapshot().buffering,true);p.emit('bufferingUpdate',2,0);assert.equal(e.player.getSnapshot().buffering,false);const oldSeek=e.player.seek(55000);await e.player.loadMedia('content-b','media-b','B','http://127.0.0.1:3000','test-secret');await oldSeek;assert.equal(e.players.at(-1).seeks.length,0);assert.equal(e.player.getSnapshot().positionMs,0);await e.player.loadFixture();assert.equal(e.player.getSnapshot().mediaVersionId,'fixture-pcm-v1');assert.equal(e.player.sourceToken,'');assert.equal(e.player.sourceUrl,'');checks.push('real service uses same-origin Bearer MediaSource; IDs/title/duration, card permissions, buffering, queued old seek cancellation and private-source cleanup');await e.player.release();
}
{
 const e=create();await e.player.initialize(e.ability);const gate=deferred();e.setPlan({prepare:gate,promiseSource:true});const oldLoad=e.player.loadMedia('content-a','media-a','A','http://127.0.0.1:3000','test-secret').catch(x=>x);await settle();const oldPlayer=e.players.at(-1);const lateTime=oldPlayer.handlers.timeUpdate,lateState=oldPlayer.handlers.stateChange;const fresh=e.player.loadMedia('content-b','media-b','B','http://127.0.0.1:3000','test-secret');await fresh;assert.ok(await oldLoad instanceof Error);gate.resolve();await settle();lateTime(199999);lateState('playing');assert.equal(e.player.getSnapshot().mediaVersionId,'media-b');assert.equal(e.player.getSnapshot().positionMs,0);assert.equal(e.player.getSnapshot().playerState,'prepared');assert.equal(oldPlayer.released,true);checks.push('A prepare canceled by B; late A prepare/time/state callbacks cannot overwrite B or play');await e.player.release();
}
{
 const e=create();await e.player.initialize(e.ability);e.setPlan({fail:true});await assert.rejects(e.player.loadMedia('content-a','media-a','A','https://fish.example.test','test-secret'));assert.equal(e.player.getSnapshot().ready,false);assert.equal(JSON.stringify(e.player.getSnapshot()).includes('test-secret'),false);assert.equal(e.logs.join('').includes('test-secret'),false);checks.push('loadMedia rejects failed setMediaSource and strips private network error details from UI/logs');await e.player.release();
}
{
 const e=create();
 await e.player.initialize(e.ability);
 await e.player.loadMedia('content-a','media-a','A','https://fish.example.test','test-secret');
 await e.player.play();
 const network=e.players.at(-1);
 assert.equal(e.downloads.length,0);
 e.player.setPlaybackCacheEnabled(true);
 const download=e.downloads[0];
 assert.equal(network.state,'playing');
 assert.equal(e.player.getSnapshot().cacheStatus,'downloading');
 assert.equal(e.settings.get('cacheCurrentEpisode'),true);
 await e.player.seek(53000);
 await e.player.setRate(1.5);
 await e.player.setLooping(true);
 download.onPercent(100);
 assert.notEqual(e.player.getSnapshot().cacheStatus,'ready');
 download.transfer.resolve({fd:88,offset:0,length:4096});
 await settle();
 const local=e.players.at(-1);
 assert.notEqual(network,local);
 assert.equal(network.released,true);
 assert.equal(local.state,'playing');
 assert.equal(local.loop,true);
 assert.deepEqual(local.seeks,[53000]);
 assert.equal(e.player.getSnapshot().rate,1.5);
 assert.equal(e.player.getSnapshot().cacheStatus,'ready');
 const session=e.sessions.at(-1);
 session.handlers.pause();await settle();assert.equal(local.state,'paused');
 session.handlers.seek(81000);await settle();assert.deepEqual(local.seeks,[53000,81000]);
 e.player.setPlaybackCacheEnabled(false);
 session.handlers.play();await settle();assert.equal(local.state,'playing');
 assert.equal(e.downloads.length,1);assert.equal(e.sources.length,1);
 e.player.cancelMediaLoading();await settle();
 assert.equal(local.released,true);assert.equal(download.closed,1);
 assert.equal(e.player.getSnapshot().cacheStatus,'idle');assert.equal(e.player.getSnapshot().ready,false);
 await e.player.release();
 checks.push('opt-in keeps network audio playing until a completed local source takes over at the current position, rate and loop; existing media card controls work offline, opt-out keeps this copy and loss of control releases it');
}
{
 const e=create();e.settings.set('cacheCurrentEpisode',true);
 await e.player.initialize(e.ability);
 assert.equal(e.player.getSnapshot().cacheEnabled,true);
 await e.player.loadMedia('content-a','media-a','A','https://fish.example.test','test-secret');
 assert.equal(e.downloads.length,0);
 await e.player.play();
 const network=e.players.at(-1), first=e.downloads[0], prepare=deferred();
 e.setPlan({prepare});
 first.transfer.resolve({fd:88,offset:0,length:4096});
 await settle();
 const cancelled=e.players.at(-1);
 assert.equal(network.state,'playing');
 e.player.setPlaybackCacheEnabled(false);
 prepare.resolve();await settle();
 assert.equal(cancelled.released,true);assert.equal(first.closed,1);
 assert.equal(network.state,'playing');assert.equal(e.player.getSnapshot().cacheStatus,'idle');
 e.player.setPlaybackCacheEnabled(true);
 const second=e.downloads[1];second.transfer.reject(new Error('disk full'));await settle();
 assert.equal(second.closed,1);assert.equal(e.player.getSnapshot().cacheStatus,'failed');
 assert.equal(network.state,'playing');assert.equal(e.player.getSnapshot().error,'');
 e.player.setPlaybackCacheEnabled(false);e.player.setPlaybackCacheEnabled(true);
 const late=e.downloads[2];
 await e.player.loadFixture();late.onPercent(100);late.transfer.resolve({fd:99,offset:0,length:4096});await settle();
 assert.equal(late.cancelled,true);assert.equal(late.closed,1);
 assert.equal(e.player.getSnapshot().cacheStatus,'idle');
 assert.equal(e.player.getSnapshot().mediaVersionId,'fixture-pcm-v1');
 await e.player.release();
 checks.push('saved opt-in starts only after play; cancellation while the local decoder prepares, failed writes and a late switched-away download preserve playback or the newly selected track');
}
{
 const cacheSource=(await readFile(new URL('../apps/harmony/entry/src/main/ets/services/PlaybackCache.ets',import.meta.url),'utf8')).replace(/^import .*;$/gm,'');
 const cacheCode=ts.transpileModule(cacheSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const chunkSize=2*1024*1024, size=chunkSize+13;
 function storage(response) {
  const calls=[],destroyed=[],writes=[],closed=[],paths=[];
  const context={exports:{},ArrayBuffer,Error,Number,Math,
   fs:{OpenMode:{CREATE:1,TRUNC:2,READ_WRITE:4},openSync:()=>({fd:19}),unlinkSync:path=>paths.push(path),
    write:async(fd,data)=>{assert.equal(fd,19);writes.push(data.byteLength);return data.byteLength;},closeSync:file=>closed.push(file.fd)},
   http:{RequestMethod:{GET:'GET'},HttpDataType:{ARRAY_BUFFER:'buffer'},createHttp:()=>({
    request:async(url,options)=>{calls.push({url,options});return response(options,calls.length-1);},destroy:()=>destroyed.push(true)})}};
  vm.runInNewContext(cacheCode,context);
  return {cache:new context.exports.PlaybackCacheDownload(),calls,destroyed,writes,closed,paths};
 }
 const reply=(start,end,total)=>({responseCode:206,header:{'content-range':`bytes ${start}-${end}/${total}`},result:new ArrayBuffer(end-start+1)});
 const e=storage((_options,i)=>i===0?reply(0,chunkSize-1,size):reply(chunkSize,size-1,size));
 const progress=[];
 const file=await e.cache.read('/private','https://fish.example.test/api/media/a','token',percent=>progress.push(percent));
 assert.equal(file.fd,19);assert.equal(file.length,size);
 assert.deepEqual(e.writes,[chunkSize,13]);assert.deepEqual(progress,[99,100]);
 assert.deepEqual(e.calls.map(({options})=>options.header.Range),[`bytes=0-${chunkSize-1}`,`bytes=${chunkSize}-${size-1}`]);
 assert.ok(e.calls.every(({url,options})=>url==='https://fish.example.test/api/media/a'&&options.maxRedirects===0&&options.header.Authorization==='Bearer token'));
 assert.deepEqual(e.paths,['/private/yuqu-listening-cache.tmp']);
 e.cache.close();assert.deepEqual(e.closed,[19]);assert.equal(e.destroyed.length,2);
 for(const bad of [{...reply(0,1,2),responseCode:200},reply(0,1,100*1024*1024+1),{...reply(0,1,2),result:new ArrayBuffer(1)}]){
  const invalid=storage(()=>bad);
  await assert.rejects(invalid.cache.read('/private','https://fish.example.test/api/media/a','token',()=>{}));
  invalid.cache.close();assert.equal(invalid.writes.length,0);assert.deepEqual(invalid.closed,[19]);
 }
 checks.push('the native cache reader validates and appends authenticated byte ranges, disables redirects, bounds the file to 100 MiB and rejects truncated or invalid responses before storing them');
}
async function playingEpisode() {
  const timers = new Map();
  let timerId = 0;
  let now = Date.now();
  const e = create({
    Date: class extends Date { static now() { return now; } },
    setTimeout(callback, ms) { timers.set(++timerId, { callback, ms }); return timerId; },
    clearTimeout(id) { timers.delete(id); }
  });
  await e.player.initialize(e.ability);
  await e.player.loadMedia('content-a', 'media-a', 'A', 'https://fish.example.test', 'test-secret');
  let owner = true;
  e.player.setPlaybackPermission(() => owner && e.player.getSnapshot().ready, () => owner);
  await e.player.play();
  const original = e.players.at(-1);
  original.emit('timeUpdate', 62000);
  function interrupt(player, code = 5400103) {
    player.change('error');
    player.emit('error', { code, message: 'private error test-secret' });
  }
  async function fireRetry() {
    const timer = [...timers].find(([, item]) => [0, 2000, 8000].includes(item.ms));
    assert.ok(timer, 'expected a scheduled reconnect');
    timers.delete(timer[0]);
    timer[1].callback();
    await settle();
  }
  return { ...e, original, timers, fireRetry, interrupt, loseControl() { owner = false; }, advance(ms) { now += ms; } };
}

{
  const e = await playingEpisode();
  await e.player.setRate(1.5);
  await e.player.setLooping(true);
  const prepare = deferred();
  e.setPlan({ prepare });
  e.interrupt(e.original);
  e.original.emit('error', { code: 5400103 });
  e.original.emit('timeUpdate', 0);
  assert.equal(e.player.getSnapshot().recovering, true);
  assert.equal(e.player.getSnapshot().positionMs, 62000);
  await e.fireRetry();
  const next = e.players.at(-1);
  assert.notEqual(next, e.original);
  assert.equal(e.original.released, true);
  next.seek = function(position) { this.seeks.push(position); };
  prepare.resolve();
  await settle();
  assert.deepEqual(next.seeks, [62000]);
  assert.equal(next.plays, 0);
  next.emit('seekDone', 62040);
  await settle();
  const state = e.player.getSnapshot();
  assert.equal(state.ready, true);
  assert.equal(state.recovering, false);
  assert.equal(state.positionMs, 62040);
  assert.equal(next.loop, true);
  assert.equal(state.rate, 1.5);
  assert.equal(next.state, 'playing');
  assert.equal(e.sources.at(-1).headers.Authorization, 'Bearer test-secret');
  assert.ok(!JSON.stringify(state).includes('test-secret'));
  // An independent interruption after healthy playback starts a new budget.
  e.advance(16000);
  next.emit('timeUpdate', 80000);
  e.interrupt(next, 5411003);
  assert.ok([...e.timers.values()].some(timer => timer.ms === 0));
  await e.fireRetry();
  for (const delay of [2000, 8000]) {
    // A user seek, even after time spent waiting, does not prove stable decoding.
    e.advance(20000);
    await e.player.seek(108000);
    e.players.at(-1).emit('timeUpdate', 108100);
    e.interrupt(e.players.at(-1));
    assert.ok([...e.timers.values()].some(timer => timer.ms === delay));
    await e.fireRetry();
  }
  e.interrupt(e.players.at(-1));
  await settle();
  assert.equal(e.player.getSnapshot().recovering, false);
  assert.equal(e.player.getSnapshot().ready, false);
  assert.equal(e.timers.size, 0);
  await e.player.release();
  checks.push('remote I/O recovery waits for confirmed seek and restores loop/speed; real sustained progress renews the retry budget, while seeking and repeatedly hitting a bad segment exhaust bounded attempts at 0, 2 and 8 seconds');
}

{
  const e = await playingEpisode();
  const prepare = deferred();
  e.setPlan({ prepare });
  e.interrupt(e.original);
  await e.fireRetry();
  const next = e.players.at(-1);
  next.play = async function() {
    this.change('playing');
    this.emit('error', { code: 5411002, message: 'connection lost after play' });
  };
  prepare.resolve();
  await settle();
  assert.equal(next.released, true);
  assert.equal(e.player.getSnapshot().ready, false);
  assert.equal(e.player.getSnapshot().recovering, true);
  await e.fireRetry();
  assert.equal(e.player.getSnapshot().playerState, 'playing');
  await e.player.release();
  checks.push('errors delivered between confirmed play and binding the replacement decoder cannot be mistaken for a successful recovery');
}

for (const action of ['pause', 'release', 'switch', 'ownership', 'headphones', 'audioFocus']) {
  const e = await playingEpisode();
  const prepare = deferred();
  e.setPlan({ prepare });
  e.interrupt(e.original);
  await e.fireRetry();
  const candidate = e.players.at(-1);
  let pending;
  if (action === 'pause') pending = e.player.pause();
  if (action === 'release') pending = e.player.release();
  if (action === 'switch') pending = e.player.loadMedia('content-b', 'media-b', 'B', 'https://fish.example.test', 'test-secret');
  if (action === 'ownership') e.loseControl();
  if (action === 'headphones') candidate.emit('audioOutputDeviceChangeWithInfo', { changeReason: 1 });
  if (action === 'audioFocus') candidate.emit('audioInterrupt', { hintType: 1 });
  prepare.resolve();
  await pending;
  await settle();
  assert.equal(candidate.released, true, action);
  assert.equal(candidate.plays, 0, action);
  assert.equal(e.player.getSnapshot().recovering, false, action);
  if (action === 'switch') assert.equal(e.player.getSnapshot().mediaVersionId, 'media-b');
  await e.player.release();
}
checks.push('pause, app release, switching episodes, losing ownership, removing headphones and audio interruption all cancel recovery without resuming');

{
  const e = await playingEpisode();
  const prepare = deferred();
  e.setPlan({ prepare });
  e.interrupt(e.original);
  await e.fireRetry();
  const candidate = e.players.at(-1);
  const release = candidate.release.bind(candidate);
  // The operation can reject before the media service dispatches its more specific source error.
  candidate.release = async function() {
    this.emit('error', { code: 5411004, message: 'I/O network unavailable' });
    await release();
  };
  const operationError = new Error('operation not permitted in error state');
  operationError.code = 5400102;
  prepare.reject(operationError);
  await settle();
  assert.equal(e.player.getSnapshot().recovering, true);
  await e.fireRetry();
  assert.equal(e.player.getSnapshot().playerState, 'playing');
  assert.deepEqual(e.players.at(-1).seeks, [62000]);
  await e.player.release();
  checks.push('a failed candidate prepare and late source I/O error can be reported in either order without ending backoff early');
}

for (const code of [5400102, 5411005, 5400106]) {
  const e = await playingEpisode();
  const prepare = deferred();
  e.setPlan({ prepare });
  e.interrupt(e.original, 5411004);
  await e.fireRetry();
  const failed = e.players.at(-1);
  const error = new Error('candidate prepare rejected without a native error callback');
  error.code = code;
  prepare.reject(error);
  await settle();
  assert.equal(failed.released, true);
  assert.equal(e.player.getSnapshot().recovering, code === 5400102);
  if (code === 5400102) {
    assert.ok([...e.timers.values()].some(timer => timer.ms === 2000));
    await e.fireRetry();
    assert.equal(e.player.getSnapshot().playerState, 'playing');
    assert.deepEqual(e.players.at(-1).seeks, [62000]);
  } else {
    assert.equal(e.timers.size, 0);
  }
  await e.player.release();
}
checks.push('the native HTTP 503/5411004 sequence retries candidate prepare 5400102 even without an ArkTS error event; permission and unsupported-format failures still terminate');

{
  const e = await playingEpisode();
  e.player.setPlaybackCacheEnabled(true);
  const download = e.downloads[0];
  download.transfer.resolve({ fd: 88, offset: 0, length: 4096 });
  await settle();
  const local = e.players.at(-1);
  e.advance(10000);
  local.emit('timeUpdate', 71111);
  e.interrupt(local);
  await e.fireRetry();
  assert.equal(local.released, true);
  assert.equal(e.sources.length, 1);
  assert.deepEqual(e.players.at(-1).seeks, [71111]);
  assert.equal(e.players.at(-1).state, 'playing');
  assert.equal(download.closed, 0);
  await e.player.release();
  assert.equal(download.closed, 1);
  checks.push('an active downloaded file is reopened offline only after releasing its old decoder, with a single descriptor cleanup');
}

for (const seekConfirmed of [false, true]) {
  const e = await playingEpisode();
  e.original.seek = function(position) { this.seeks.push(position); };
  await e.player.seek(90000);
  e.original.emit('timeUpdate', e.original.duration);
  assert.equal(e.player.getSnapshot().positionMs, 62000);
  if (seekConfirmed) {
    e.original.emit('seekDone', 90040);
    e.original.emit('timeUpdate', e.original.duration);
    assert.equal(e.player.getSnapshot().positionMs, 90040);
  }
  e.interrupt(e.original);
  await e.fireRetry();
  const resumed = e.players.at(-1);
  assert.deepEqual(resumed.seeks, [seekConfirmed ? 90040 : 62000]);
  await e.player.seek(resumed.duration - 1800);
  e.advance(1900);
  resumed.emit('timeUpdate', resumed.duration);
  resumed.change('completed');
  assert.equal(e.player.getSnapshot().positionMs, resumed.duration);
  assert.equal(e.player.getSnapshot().playerState, 'completed');
  await e.player.release();
}
checks.push('a spurious end-of-file progress sample before or after seekDone cannot replace the last confirmed recovery point; real near-end playback still completes');

for (const wrongConfirmation of [false, true]) {
  const e = await playingEpisode();
  e.original.seek = function(position) { this.seeks.push(position); };
  await e.player.seek(90000);
  if (wrongConfirmation) e.original.emit('seekDone', e.original.duration);
  e.original.emit('timeUpdate', e.original.duration);
  const timeout = [...e.timers.values()].find(timer => timer.ms === 15000);
  assert.ok(timeout);
  timeout.callback();
  await settle();
  const stalled = e.player.getSnapshot();
  assert.equal(stalled.positionMs, 62000);
  assert.equal(stalled.playerState, 'error');
  assert.equal(stalled.ready, false);
  assert.equal(e.original.state, 'paused');
  assert.equal(e.timers.size, 0);
  e.original.emit('seekDone', 90000);
  assert.equal(e.player.getSnapshot().positionMs, 62000);
  await e.player.loadMedia('content-a', 'media-a', 'A', 'https://fish.example.test', 'test-secret');
  await e.player.seek(stalled.positionMs);
  await e.player.play();
  assert.equal(e.player.getSnapshot().playerState, 'playing');
  assert.equal(e.player.getSnapshot().positionMs, 62000);
  await e.player.release();
}
checks.push('a missing or out-of-range seek confirmation times out into a paused, retryable state with the last trusted position; late callbacks cannot overwrite it');

{
  const e = await playingEpisode();
  await e.player.seek(180000);
  // Elapsed wall time alone, including a long buffer, cannot prove the decoder is playing the wrong part.
  e.original.emit('bufferingUpdate', 1);
  e.original.emit('timeUpdate', 21000);
  e.advance(20000);
  e.original.emit('timeUpdate', 21000);
  assert.equal(e.player.getSnapshot().ready, true);
  e.original.emit('bufferingUpdate', 2);
  e.original.emit('timeUpdate', 25000);
  e.advance(3000);
  e.original.emit('timeUpdate', 28000);
  e.advance(3000);
  e.original.emit('timeUpdate', 31000);
  await settle();
  assert.equal(e.player.getSnapshot().ready, false);
  assert.equal(e.player.getSnapshot().positionMs, 180000);
  assert.equal(e.player.getSnapshot().playerState, 'error');
  assert.equal(e.original.state, 'paused');
  await e.player.release();
  checks.push('sustained active native progress on the wrong part of an episode after a confirmed seek ends in a retryable pause; time spent paused or buffering cannot trigger the check');
}

{
  const e = await playingEpisode();
  e.interrupt(e.original, 5411005);
  await settle();
  assert.equal(e.player.getSnapshot().recovering, false);
  assert.equal(e.timers.size, 0);
  await e.player.release();
  checks.push('permission failures never trigger automatic reconnection');
}
{
  const e = await playingEpisode();
  await e.player.seek(70000);
  e.player.setForeground(false);
  e.original.emit('bufferingUpdate', 1, 0);
  e.original.emit('bufferingUpdate', 2, 0);
  e.interrupt(e.original);
  const incidentId = e.player.getSnapshot().diagnosticIncidentId;
  assert.match(incidentId, /^[\da-f-]{36}$/);
  e.original.emit('timeUpdate', 0);
  await e.fireRetry();
  const report = e.player.getDiagnosticReport();
  assert.equal(report.reportId, incidentId);
  assert.equal(report.mediaVersionId, 'media-a');
  const events = Array.from(report.events, event => event.type);
  assert.deepEqual(events, ['foreground','play','seek','seek_done','background','buffer_start','buffer_end','error','retry','seek','seek_done','resumed']);
  const failure = report.events.find(event => event.type === 'error');
  assert.equal(failure.positionMs, 70000);
  assert.equal(failure.code, 5400103);
  assert.equal(report.events.at(-1).positionMs, 70000);
  assert.equal(report.events.every((event, i) => !i || report.events[i-1].atMs <= event.atMs), true);
  const frozen = JSON.stringify(report);
  const preview = e.diagnostics.diagnosticPreview(report);
  for (const expected of [incidentId, 'media-a', '5400103', '70000', '已续播', '1.2.3', '系统 API：20',
    new Date(failure.atMs).toISOString()]) assert.ok(preview.includes(expected));
  for (const secret of ['test-secret', 'fish.example.test', 'private error', 'Bearer', 'content-a']) {
    assert.ok(!frozen.includes(secret) && !preview.includes(secret));
  }
  report.events[0].positionMs = 999;
  e.player.setForeground(true);
  assert.equal(JSON.stringify(e.player.getDiagnosticReport()), frozen);
  // The old callback and the old player's current events cannot resurrect a cleared account's incident.
  const old = e.players.at(-1);
  e.player.clearDiagnosticReports();
  e.interrupt(old);
  assert.equal(e.player.getSnapshot().diagnosticIncidentId, '');
  assert.equal(e.player.getDiagnosticReport(), undefined);
  await e.player.loadMedia('content-b','media-b','B','https://fish.example.test','other-account');
  e.interrupt(old);
  assert.equal(e.player.getDiagnosticReport(), undefined);
  e.interrupt(e.players.at(-1), 5411005);
  const other = e.player.getDiagnosticReport();
  assert.notEqual(other.reportId, incidentId);
  assert.equal(other.mediaVersionId,'media-b');
  assert.deepEqual(Array.from(other.events, event => event.type), ['foreground','error']);
  assert.equal(other.events.at(-1).code, 5411005);
  await e.player.loadFixture();
  assert.equal(e.player.getDiagnosticReport(), undefined);
  const fixture = e.player.getSnapshot();
  e.players.at(-1).emit('error', {code:5400103});
  assert.equal(e.player.getDiagnosticReport(), undefined);
  await e.player.loadMedia(fixture.contentId, fixture.mediaVersionId, fixture.title, '', 'test-fixture-login');
  const signedFixture = e.players.at(-1), networkSources = e.sources.length;
  await e.player.loadMedia(fixture.contentId, fixture.mediaVersionId, fixture.title, '', 'test-fixture-login');
  assert.equal(e.players.at(-1), signedFixture);
  assert.equal(e.sources.length, networkSources);
  e.players.at(-1).emit('error', {code:5400103});
  assert.equal(e.player.getDiagnosticReport().mediaVersionId, fixture.mediaVersionId);
  assert.equal(e.player.sourceUrl, '');
  await e.player.loadFixture();
  assert.equal(e.player.sourceToken, '');
  assert.equal(e.player.getDiagnosticReport(), undefined);
  await e.player.release();
  checks.push('actual buffering, trusted seeks, native causes and confirmed automatic resume survive one fault with an immutable private preview; switched media and signed-out players cannot inherit an incident');
}
{
  const e = await playingEpisode();
  for (let i = 0; i < 25; i++) e.player.setForeground(i % 2 !== 0);
  e.interrupt(e.original);
  const early = e.player.getDiagnosticReport();
  assert.equal(early.events.length, 20);
  assert.equal(early.events.at(-1).code, 5400103);
  const frozen = JSON.stringify(early);
  await e.fireRetry();
  assert.equal(JSON.stringify(e.player.getDiagnosticReport()), frozen);
  assert.equal(e.player.getSnapshot().diagnosticIncidentId, early.reportId);
  const jobId = randomUUID(), failedAt = Date.now() - 12000;
  const report = e.diagnostics.createTranscriptDiagnosticReport('media-a', jobId, 374099, 3, failedAt);
  assert.equal(report.kind, 'transcription');
  assert.equal(report.jobId, jobId);
  assert.deepEqual(JSON.parse(JSON.stringify(report.events)), [
    {type:'transcript_failed', atMs:failedAt, positionMs:374099, attempts:3}
  ]);
  const preview = e.diagnostics.diagnosticPreview(report);
  for (const expected of [jobId, report.reportId, '374099', '已尝试 3 次', new Date(failedAt).toISOString()]) {
    assert.ok(preview.includes(expected));
  }
  await e.player.release();
  checks.push('only the last twenty structured events are offered; previewing before recovery freezes exactly that body, including the stable retry id; transcription diagnostics describe just the failed job and its measured progress');
}
console.log(JSON.stringify({passed:true,checks},null,2));
