import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createBilibiliProvider } from '../packages/domain/src/bilibili.ts';

const canonical = 'https://www.bilibili.com/video/BV1Hw4m1v7V9';
function client(plans = []) {
  const calls = [];
  const provider = createBilibiliProvider({openTransport: async (url, signal, options) => {
    signal.throwIfAborted();
    const plan = plans[calls.length]; assert.ok(plan, `unexpected request ${url}`);
    const response = Readable.from([plan.body ?? 'unused body']);
    Object.assign(response, {statusCode:plan.status ?? 302,headers:plan.headers ?? {location:plan.to},sourceUrl:url});
    calls.push({url,options,response});
    plan.onRequest?.();
    return response;
  }});
  return {...provider,calls};
}
const signal = () => AbortSignal.timeout(1000);
test('opaque and BV short paths resolve without fetching the final HTML page', async () => {
  for (const short of ['https://b23.tv/Ab8kXy', 'https://b23.tv/BV1Hw4m1v7V9']) {
    const p = client([{to:canonical+'?spm_id_from=share&p=2#tracking'}]);
    assert.deepEqual(await p.resolveBilibiliSource(short, signal()), {bvid:'BV1Hw4m1v7V9',page:2,url:canonical+'?p=2',explicitPage:true});
    assert.equal(p.calls.length,1); assert.equal(p.calls[0].options.redirect,'manual');
    assert.ok(p.calls[0].response.destroyed);
  }
  const p = client();
  assert.equal((await p.resolveBilibiliSource(canonical,signal())).url,canonical+'?p=1');
  assert.equal(p.calls.length,0);
});
test('relative short redirects and requested parts survive canonicalization; conflicting parts fail', async () => {
  const p=client([{to:'/next?p=2'},{to:canonical+'?tracking=x'}]);
  assert.equal((await p.resolveBilibiliSource('https://b23.tv/start?p=2',signal())).url,canonical+'?p=2');
  assert.ok(p.calls.every(call=>call.response.destroyed));
  for (const to of [canonical+'?p=3','/next?p=3']) {
    const bad=client([{to}]);
    await assert.rejects(bad.resolveBilibiliSource('https://b23.tv/start?p=2',signal()), /不一致/);
    assert.equal(bad.calls.length,1);
  }
});
test('short redirects reject unapproved sites and invalid BV targets before another connection', async () => {
  const targets=['https://example.com/a','http://www.bilibili.com/video/BV1Hw4m1v7V9','https://127.0.0.1/a',
    'https://b23.tv.attacker.test/a','https://sub.b23.tv/a','https://b23.tv/a/b',
    'https://me:secret@b23.tv/a','https://b23.tv:8443/a','http://b23.tv/a',
    'https://www.bilibili.com/bangumi/play/ep1','https://space.bilibili.com/123',
    canonical+'?p=0',canonical+'?p=1&p=2','https://www.bilibili.com/video/av123'];
  for (const to of targets) {
    const p=client([{to}]);
    await assert.rejects(p.resolveBilibiliSource('https://b23.tv/start',signal()));
    assert.equal(p.calls.length,1,to); assert.ok(p.calls[0].response.destroyed);
  }
});
test('invalid short sources, nonredirect bodies, missing locations, loops and excess hops fail bounded', async () => {
  for (const url of ['http://b23.tv/a','https://b23.tv/','https://b23.tv/a/b','https://b23.tv/%61','https://b23.tv/a?p=0','https://b23.tv/a?p=1&p=2']) {
    const p=client(); await assert.rejects(p.resolveBilibiliSource(url,signal())); assert.equal(p.calls.length,0);
  }
  for (const plan of [{status:200},{headers:{}},{to:'/start'}]) {
    const p=client([plan]); await assert.rejects(p.resolveBilibiliSource('https://b23.tv/start',signal()));
    assert.equal(p.calls.length,1); assert.ok(p.calls[0].response.destroyed);
  }
  const p=client(Array.from({length:5},(_,i)=>({to:`/next${i}`})));
  await assert.rejects(p.resolveBilibiliSource('https://b23.tv/start',signal()),/次数/);
  assert.equal(p.calls.length,5); assert.ok(p.calls.every(call=>call.response.destroyed));
});
test('cancellation closes a short-link response and never requests its destination', async () => {
  const controller=new AbortController(), reason=new Error('cancelled');
  const p=client([{to:canonical,onRequest:()=>controller.abort(reason)}]);
  await assert.rejects(p.resolveBilibiliSource('https://b23.tv/start',controller.signal),e=>e===reason);
  assert.ok(p.calls[0].response.destroyed); assert.equal(p.calls.length,1);
  await assert.rejects(p.resolveBilibiliSource('https://b23.tv/start',controller.signal),e=>e===reason);
  assert.equal(p.calls.length,1);
});

test('a stalled short-link request is cancelled by its own 20 second deadline', async t => {
  const deadline=new AbortController(), reason=new DOMException('short-link deadline','TimeoutError');
  const durations=[]; let calls=0;
  t.mock.method(AbortSignal,'timeout',ms=>{durations.push(ms);return deadline.signal;});
  const p=createBilibiliProvider({openTransport:async(_url,bounded)=>{
    calls++;
    return new Promise((_resolve,reject)=>{
      bounded.addEventListener('abort',()=>reject(bounded.reason),{once:true});
      queueMicrotask(()=>deadline.abort(reason));
    });
  }});
  await assert.rejects(p.resolveBilibiliSource('https://b23.tv/stalled',new AbortController().signal),e=>e===reason);
  assert.deepEqual(durations,[20000]); assert.equal(calls,1);
});
test('preview and audio resolution share the short-link normalization path', async () => {
  const metadata = {code:0,data:{bvid:'BV1Hw4m1v7V9',title:'课程',state:0,is_upower_exclusive:false,
    rights:{pay:0,ugc_pay:0,ugc_pay_preview:0,arc_pay:0,movie:0},pages:[{page:1,cid:1,part:'',duration:90}]}};
  const p=client([{to:canonical},{status:200,headers:{},body:JSON.stringify(metadata)}]);
  assert.deepEqual(await p.previewBilibili('https://b23.tv/start',signal()),{title:'课程',episodes:[{url:canonical+'?p=1',title:'课程'}]});
  const playback={code:0,data:{timelength:90000,dash:{audio:[{mimeType:'audio/mp4',codecs:'mp4a.40.2',bandwidth:64000,baseUrl:'https://x.bilivideo.com/a.m4s'}]}}};
  const a=client([{to:canonical},{status:200,headers:{},body:JSON.stringify(metadata)},{status:200,headers:{},body:JSON.stringify(playback)}]);
  assert.equal((await a.resolveBilibiliAudio('https://b23.tv/start',signal())).cid,1);
});
