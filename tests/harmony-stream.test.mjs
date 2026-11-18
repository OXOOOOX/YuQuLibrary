import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=fs.readFileSync(new URL('../apps/harmony/entry/src/main/ets/services/EventStream.ets', import.meta.url),'utf8').replace(/^import .*;$/gm,'')+'\nexport { StreamDecoder };';
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
let now=0,next=1; const timers=new Map(); const requests=[];
class FakeRequest {
 callbacks={}; destroyed=false; options; resolve;
 on(kind,callback){this.callbacks[kind]=callback;}
 off(kind){delete this.callbacks[kind];}
 destroy(){this.destroyed=true;}
 requestInStream(url,options){this.url=url;this.options=options; return new Promise(resolve=>this.resolve=resolve);}
 emit(kind,value){this.callbacks[kind]?.(value);}
}
const context={exports:{},ArrayBuffer,Uint8Array,Error,Number,Math,JSON,
 util:{TextDecoder:{create:()=>({decodeToString:(function(){const d=new TextDecoder();return (chunk,options)=>d.decode(chunk,options);})()})}},
 http:{RequestMethod:{GET:'GET'},createHttp:()=>{const r=new FakeRequest();requests.push(r);return r;}},
 setTimeout:(fn,delay)=>{const id=next++;timers.set(id,{fn,at:now+delay});return id;},clearTimeout:id=>timers.delete(id)};
vm.runInNewContext(compiled,context);
const {EventStream,StreamDecoder}=context.exports;
const encode=text=>new TextEncoder().encode(text);
function advance(ms){const until=now+ms;while(true){const due=[...timers].filter(([,t])=>t.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;now=due[1].at;timers.delete(due[0]);due[1].fn();}now=until;}
const decoder=new StreamDecoder('');const bytes=encode('retry: 1000\r\nid: 123\r\nevent: probe\r\ndata: 鱼趣\r\ndata: 连接\r\n\r\n');
const decoded=[];for(const byte of bytes)decoded.push(...decoder.push(Uint8Array.of(byte).buffer));
assert.equal(decoded.length,1);assert.equal(decoded[0].data,'鱼趣\n连接');assert.equal(decoded[0].id,'123');assert.equal(decoder.retryMs,1000);
assert.equal(new StreamDecoder('').push(encode('data: unfinished').buffer).length,0);
assert.throws(()=>new StreamDecoder('').push(encode('data: '+'x'.repeat(65537)).buffer),/64 KiB/);
const events=[],states=[];const stream=new EventStream(e=>events.push(e),s=>states.push(s));
stream.start('http://127.0.0.1:3000/events','test-token');assert.equal(requests.length,1);assert.equal(requests[0].options.header.Authorization,'Bearer test-token');
requests[0].emit('headersReceive',{'content-type':'text/event-stream; charset=utf-8','status-line':'HTTP/1.1 200 OK'});
const staleData=requests[0].callbacks.dataReceive;
requests[0].emit('dataReceive',encode('id: 123\nevent: probe\ndata: ok\n\n').buffer);assert.equal(events.length,1);
requests[0].emit('dataEnd');requests[0].resolve(200);await Promise.resolve();await Promise.resolve();
advance(1000);assert.equal(requests.length,2);assert.equal(requests[1].options.header['Last-Event-ID'],'123');
staleData(encode('id: 999\ndata: stale\n\n').buffer);assert.equal(events.length,1);
stream.setForeground(false);assert.equal(requests[1].destroyed,true);advance(120000);assert.equal(requests.length,2);
stream.setForeground(true);assert.equal(requests.length,3);assert.equal(requests[2].options.header['Last-Event-ID'],'123');
stream.reconnect();stream.stop();advance(120000);assert.equal(requests.length,3);
const bad=new EventStream(()=>{throw new Error('consumer failed');},()=>{});bad.start('http://127.0.0.1:3000/events');
requests[3].emit('headersReceive',{'content-type':'text/event-stream','status-line':'HTTP/1.1 200 OK'});requests[3].emit('dataReceive',encode('id: 77\ndata: fail\n\n').buffer);advance(1000);
assert.equal(requests[4].options.header['Last-Event-ID'],undefined);bad.stop();
const auth=new EventStream(()=>{},s=>states.push(s));auth.start('http://127.0.0.1:3000/events');requests[5].emit('headersReceive',{'content-type':'application/json','status-line':'HTTP/1.1 401 Unauthorized'});advance(120000);assert.equal(requests.length,6);assert.equal(states.at(-1).status,'error');
const earlyEvents=[];const early=new EventStream(e=>earlyEvents.push(e),()=>{});early.start('http://127.0.0.1:3000/events');
requests[6].emit('dataReceive',encode('id: 98\ndata: before-headers\n\n').buffer);assert.equal(earlyEvents.length,0);
requests[6].emit('headersReceive',{'content-type':'text/event-stream'});assert.equal(earlyEvents.length,1);assert.equal(earlyEvents[0].id,'98');early.stop();
const missingStatus=new EventStream(()=>{},s=>states.push(s));missingStatus.start('http://127.0.0.1:3000/events');
requests[7].emit('headersReceive',{'content-type':'application/json'});requests[7].emit('dataEnd');requests[7].resolve(401);await Promise.resolve();await Promise.resolve();advance(120000);assert.equal(requests.length,8);assert.equal(states.at(-1).status,'error');
console.log('Native transport: UTF-8 framing, bounded buffers, cursor recovery, cancellation, early data and headerless 401 passed.');
const stoppedStates=[];const stoppedByConsumer=new EventStream(()=>stoppedByConsumer.stop(),state=>stoppedStates.push(state));
stoppedByConsumer.start('http://127.0.0.1/events');const consumerRequest=requests.at(-1);
consumerRequest.emit('headersReceive',{'content-type':'text/event-stream'});consumerRequest.emit('dataReceive',encode('event: session-expired\ndata: {}\n\n').buffer);
assert.equal(stoppedStates.at(-1).status,'stopped');
const idle=new EventStream(()=>{},()=>{});idle.start('http://127.0.0.1/events');
for(let i=0;i<8;i++) {const request=requests.at(-1);const count=requests.length;request.emit('headersReceive',{'content-type':'text/event-stream'});request.emit('dataReceive',encode(': heartbeat\n\n').buffer);request.emit('dataEnd');request.resolve(200);await Promise.resolve();await Promise.resolve();advance(1000);assert.equal(requests.length,count+1,'Healthy idle rotation must reconnect in 1 second');}
idle.stop();

