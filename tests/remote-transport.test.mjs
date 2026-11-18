import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { openRemote } from '../packages/domain/src/remote.ts';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createBilibiliProvider } from '../packages/domain/src/bilibili.ts';

function transport(t, plans) {
  const calls = [];
  t.mock.method(https, 'get', (url, options, receive) => {
    const request = new EventEmitter(), plan = plans[calls.length] ?? {};
    request.setTimeout = (_ms, callback) => { request.idle = callback; };
    request.destroy = error => { queueMicrotask(() => request.emit('error', error)); };
    const response = new PassThrough();
    Object.assign(response, { statusCode: plan.status ?? 200, headers: plan.headers ?? {} });
    const abort = () => request.destroy(Object.assign(new Error('Aborted'), { code: 'ABORT_ERR' }));
    options.signal.addEventListener('abort', abort, { once: true });
    response.on('close', () => options.signal.removeEventListener('abort', abort));
    calls.push({ url, options, request, response });
    if (!plan.hang) queueMicrotask(() => { receive(response); if (plan.body !== undefined) response.end(plan.body); });
    return request;
  });
  return calls;
}
const signal = () => new AbortController().signal;
const consume = async response => { const chunks = []; for await (const c of response) chunks.push(c); return Buffer.concat(chunks).toString(); };

test('resume request exposes only validated Range and strong If-Range headers', async t => {
  const calls = transport(t, [{ status: 206, headers: { 'content-range': 'bytes 10-12/13' }, body: 'end' }]);
  const result = await openRemote('https://8.8.8.8/audio.mp3', signal(), { range: { start: 10, etag: '"version-1"' } });
  assert.equal(await consume(result), 'end');
  assert.equal(calls[0].options.headers.Range, 'bytes=10-');
  assert.equal(calls[0].options.headers['If-Range'], '"version-1"');
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(result.sourceUrl, 'https://8.8.8.8/audio.mp3');
  for (const range of [{ start: -1, etag: '"v"' }, { start: 1, etag: 'W/"v"' }, { start: 1, etag: '"v"\r\nSecret: x' }]) {
    await assert.rejects(openRemote('https://8.8.8.8/a', signal(), { range }));
  }
  assert.equal(calls.length, 1);
});
test('every resume redirect rechecks URL before connecting to a private address', async t => {
  const calls = transport(t, [{ status: 302, headers: { location: 'http://127.0.0.1/private' } }]);
  await assert.rejects(openRemote('https://8.8.8.8/a', signal(), { range: { start: 10, etag: '"v"' } }), /内网/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].response.destroyed, true);
});

test('manual redirects expose headers without connecting to the target and retain public-address pinning', async t => {
  const calls = transport(t, [{ status: 302, headers: { location: 'http://127.0.0.1/private' } }]);
  const result = await openRemote('https://8.8.8.8/a', signal(), { redirect: 'manual' });
  assert.equal(result.statusCode, 302);
  assert.equal(result.headers.location, 'http://127.0.0.1/private');
  assert.equal(calls.length, 1);
  calls[0].options.lookup('ignored', {}, (_error, address, family) => {
    assert.equal(address, '8.8.8.8'); assert.equal(family, 4);
  });
  result.destroy();
  await assert.rejects(openRemote('https://127.0.0.1/a', signal(), { redirect: 'manual' }), /内网/);
  assert.equal(calls.length, 1);
});

test('manual short-link hops reject mixed public/private DNS and recheck each new connection', async t => {
  const calls=transport(t,[{status:302,headers:{location:'https://b23.tv/second'}}]);
  let resolutions=0;
  t.mock.method(dns,'lookup',async()=>++resolutions===1?[{address:'8.8.8.8',family:4}]:[
    {address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}]);
  syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  const provider=createBilibiliProvider();
  await assert.rejects(provider.resolveBilibiliSource('https://b23.tv/first',signal()),/网络地址/);
  assert.equal(resolutions,2); assert.equal(calls.length,1); assert.ok(calls[0].response.destroyed);
  await assert.rejects(openRemote('https://b23.tv/third',signal(),{redirect:'manual'}),/网络地址/);
  assert.equal(calls.length,1);
});
test('HTTP status and encoding failures remain explicit and cannot enter a downloader', async t => {
  const calls = transport(t, [{ status: 403 }, { status: 200, headers: { 'content-encoding': 'gzip' } }]);
  await assert.rejects(openRemote('https://8.8.8.8/a', signal()), error => error.code === 'REMOTE_HTTP_STATUS' && error.message.includes('403'));
  await assert.rejects(openRemote('https://8.8.8.8/b', signal()), /内容编码/);
  assert.ok(calls.every(call => call.response.destroyed));
});
test('body idle timeout retains its cause rather than masquerading as upstream reset', async t => {
  const calls = transport(t, [{}]);
  const result = await openRemote('https://8.8.8.8/a', signal());
  const reading = consume(result);
  calls[0].request.idle();
  await assert.rejects(reading, error => error.code === 'REMOTE_IDLE_TIMEOUT');
});
test('connection and response-header deadline bounds a source that never responds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  transport(t, [{ hang: true }]);
  const pending = openRemote('https://8.8.8.8/a', signal());
  t.mock.timers.tick(30000);
  await assert.rejects(pending, error => error.code === 'REMOTE_HEADERS_TIMEOUT');
});
test('parent cancellation interrupts the body with its original reason', async t => {
  transport(t, [{}]);
  const controller = new AbortController();
  const result = await openRemote('https://8.8.8.8/a', controller.signal);
  const reading = consume(result), reason = Object.assign(new Error('Lease expired'), { code: 'IMPORT_LEASE_LOST' });
  controller.abort(reason);
  await assert.rejects(reading, error => error === reason);
});
