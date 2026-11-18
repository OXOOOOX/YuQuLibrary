import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createRemoteClient, remoteSettings, validateRemoteTask } from '../workers/transcription/remote-client.mjs';

const token = 'asr-worker-test-only-'.padEnd(64, 'x');
const environment = { YUQU_ORIGIN: 'https://fish.example.test', YUQU_ASR_WORKER_TOKEN: token, YUQU_ASR_WORKER_ID: 'worker-test' };
const settings = remoteSettings(environment);
const content = Buffer.from('public podcast sample');
const task = (changes = {}) => ({
  id: 'e61a4623-a38a-44d3-a4d5-76a8b11f9336', leaseId: 'fe109cb3-fac4-4d85-98e2-0ffb7388cb3a',
  sha256: createHash('sha256').update(content).digest('hex'), byteSize: content.length,
  durationMs: 65000, completedMs: 30000, attempts: 1, model: null, ...changes
});
const json = (value, status = 200) => Response.json(value, { status });
const media = (bytes = content, headers = {}) => new Response(bytes,
  { headers: { 'content-length': String(content.length), ...headers } });
function clientWith(plans) {
  const calls = [];
  const client = createRemoteClient(settings, { fetchImpl: async (url, init) => {
    const plan = plans[calls.length]; calls.push({ url, init });
    if (plan instanceof Error) throw plan;
    return typeof plan === 'function' ? plan(url, init) : plan;
  } });
  return { client, calls };
}
async function directory(t) {
  const root = resolve(tmpdir()), target = await mkdtemp(join(root, 'yuqu-remote-client-'));
  t.after(async () => {
    assert.equal(dirname(resolve(target)), root);
    assert.ok(basename(target).startsWith('yuqu-remote-client-'));
    await rm(target, { recursive: true, force: true });
  });
  return target;
}
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);

test('configuration accepts an exact HTTPS origin or explicit loopback test host only', () => {
  assert.deepEqual(settings, { origin: environment.YUQU_ORIGIN, token, workerId: 'worker-test' });
  assert.equal(remoteSettings({ ...environment, YUQU_ORIGIN: 'http://127.0.0.1:3000' }).origin, 'http://127.0.0.1:3000');
  assert.equal(remoteSettings({ ...environment, YUQU_ORIGIN: 'http://localhost:3000' }).origin, 'http://localhost:3000');
  for (const origin of ['http://fish.example.test', 'http://192.168.1.1', 'http://[::1]:3000',
    'https://fish.example.test/', 'https://u:p@fish.example.test', 'https://fish.example.test/path',
    'https://fish.example.test?secret=1', 'https://fish.example.test#fragment']) {
    assert.throws(() => remoteSettings({ ...environment, YUQU_ORIGIN: origin }), error => error.code === 'ASR_CONFIG_INVALID');
  }
  for (const change of [{ YUQU_ASR_WORKER_TOKEN: 'short' }, { YUQU_ASR_WORKER_TOKEN: `${token}\r\nsecret` },
    { YUQU_ASR_WORKER_ID: '' }, { YUQU_ASR_WORKER_ID: 'worker\r\nInjected: value' },
    { YUQU_ASR_WORKER_ID: 'worker/id' }, { YUQU_ASR_WORKER_ID: 'x'.repeat(81) }]) {
    assert.throws(() => remoteSettings({ ...environment, ...change }), error => error.code === 'ASR_CONFIG_INVALID');
  }
});

test('task metadata rejects unsafe paths, impossible progress and resource limits', () => {
  for (const value of [null, [], {}, task({ id: '../../outside' }), task({ leaseId: 'bad' }),
    task({ sha256: 'g'.repeat(64) }), task({ byteSize: 0 }), task({ byteSize: 100 * 1024 * 1024 + 1 }),
    task({ durationMs: 0 }), task({ durationMs: 14400001 }), task({ completedMs: 1 }),
    task({ completedMs: 65001 }), task({ completedMs: NaN }), task({ attempts: 0 }),
    task({ attempts: 4 }), task({ model: {} }), task({ model: '' })]) {
    assert.throws(() => validateRemoteTask(value), error => error.code === 'ASR_TASK_INVALID');
  }
  assert.equal(validateRemoteTask(task({ completedMs: 65000 })).completedMs, 65000);
  const clean = validateRemoteTask({ ...task(), id: task().id.toUpperCase(), storageKey: '../private',
    userId: 'another-user', url: 'https://different.example/media' });
  assert.deepEqual(Object.keys(clean).sort(), Object.keys(task()).sort());
  assert.equal(clean.id, task().id);
});

test('health and claims use worker credentials, fixed paths and redirect:error', async () => {
  const { client, calls } = clientWith([json({ protocolVersion: '1.0' }), new Response(null, { status: 204 }), json({ job: task() })]);
  assert.equal((await client.health()).protocolVersion, '1.0');
  assert.equal(await client.claim(), null);
  assert.deepEqual(await client.claim(), task());
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), ['/api/asr/v1/health', '/api/asr/v1/jobs/claim', '/api/asr/v1/jobs/claim']);
  for (const call of calls) {
    assert.equal(call.init.headers.Authorization, `Bearer ${token}`);
    assert.equal(call.init.headers['x-yuqu-asr-worker'], 'worker-test');
    assert.equal(call.init.redirect, 'error');
    assert.ok(call.init.signal instanceof AbortSignal);
    assert.equal(call.init.body, undefined);
  }
});

test('the server explicitly negotiates v3; older server claims remain legacy', () => {
  assert.equal(validateRemoteTask(task()).pipeline, undefined);
  assert.equal(validateRemoteTask(task({ pipeline: 'semantic-v3' })).pipeline, 'semantic-v3');
  assert.throws(() => validateRemoteTask(task({ pipeline: 'arbitrary' })), error => error.code === 'ASR_TASK_INVALID');
});

test('an uncertain claim is never automatically retried and its error cannot expose remote data', async () => {
  const raw = new Error(`Network failed with ${token}`);
  const { client, calls } = clientWith([raw, json({ job: task() })]);
  await assert.rejects(client.claim(), error => error.code === 'ASR_NETWORK' && !String(error).includes(token) && error.cause === undefined);
  assert.equal(calls.length, 1);
  const failed = clientWith([new Response(`secret ${token}`, { status: 503 }), json({ job: task() })]);
  await assert.rejects(failed.client.claim(), error => error.status === 503 && !String(error).includes(token));
  assert.equal(failed.calls.length, 1);
});

test('idempotent writes retry a lost reply and 5xx with identical payload only', async () => {
  const chunk = { index: 1, text: 'already saved by the server' };
  const { client, calls } = clientWith([new TypeError('fetch failed'), json({ error: 'private diagnostic' }, 503), json({ ok: true })]);
  assert.equal(await client.save(task(), chunk), true);
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map(call => call.init.body)).size, 1);
  assert.deepEqual(JSON.parse(calls[0].init.body), { leaseId: task().leaseId, chunk });
  assert.equal(calls[0].url, `${settings.origin}/api/asr/v1/jobs/${task().id}/chunk`);
});

test('permanent statuses never retry; network retries stop after three attempts', async () => {
  for (const status of [400, 401, 409, 429, 302]) {
    const { client, calls } = clientWith([json({ message: token }, status), json({ ok: true })]);
    await assert.rejects(client.complete(task()), error => error.status === status && !String(error).includes(token));
    assert.equal(calls.length, 1);
  }
  const { client, calls } = clientWith([new Error('connection closed'), new Error('connection closed'), new Error('connection closed'), json({ ok: true })]);
  await rejectsCode(client.renew(task()), 'ASR_NETWORK');
  assert.equal(calls.length, 3);
});

test('redirect failures and already redirected responses cannot reach another origin or retry', async () => {
  const redirect = new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
  const { client, calls } = clientWith([redirect, json({ ok: true })]);
  await rejectsCode(client.fail(task()), 'ASR_REDIRECT_REJECTED');
  assert.equal(calls.length, 1);
  const response = json({ ok: true });
  Object.defineProperty(response, 'redirected', { value: true });
  const changed = clientWith([response, json({ ok: true })]);
  await rejectsCode(changed.client.renew(task()), 'ASR_REDIRECT_REJECTED');
  assert.equal(changed.calls.length, 1);
});

test('JSON body is bounded by both announced and actual size and ignores private failure bodies', async () => {
  for (const response of [new Response('x', { headers: { 'content-type': 'application/json', 'content-length': '65537' } }),
    new Response(' '.repeat(65537), { headers: { 'content-type': 'application/json' } })]) {
    const { client, calls } = clientWith([response]);
    await rejectsCode(client.claim(), 'ASR_RESPONSE_TOO_LARGE');
    assert.equal(calls.length, 1);
  }
  const invalid = clientWith([new Response(`private ${token}`, { headers: { 'content-type': 'application/json' } })]);
  await assert.rejects(invalid.client.claim(), error => error.code === 'ASR_RESPONSE_INVALID' && !String(error).includes(token));
});

test('download constructs the same-origin lease-bound URL and publishes only complete hashed bytes', async t => {
  const target = await directory(t), { client, calls } = clientWith([media()]);
  const file = await client.download({ ...task(), url: 'https://untrusted.example/secret', storageKey: '../private' }, target);
  assert.equal(file, join(target, `${task().id}.media`));
  assert.deepEqual(await readFile(file), content);
  assert.deepEqual(await readdir(target), [`${task().id}.media`]);
  assert.equal(calls[0].url, `${settings.origin}/api/asr/v1/jobs/${task().id}/media`);
  assert.equal(calls[0].init.headers['x-yuqu-asr-lease'], task().leaseId);
  assert.equal(calls[0].init.headers.Range, undefined);
  assert.equal(calls[0].init.headers['Accept-Encoding'], 'identity');
  assert.equal(calls[0].init.redirect, 'error');
});

test('streamed responses without Content-Length still require exact bytes and hash', async t => {
  const target = await directory(t), { client } = clientWith([new Response(content)]);
  assert.deepEqual(await readFile(await client.download(task(), target)), content);
  for (const bytes of [content.subarray(1), Buffer.concat([content, Buffer.from('extra')]), Buffer.alloc(content.length)]) {
    const failedDirectory = await directory(t), failed = clientWith([new Response(bytes)]);
    await rejectsCode(failed.client.download(task(), failedDirectory), bytes.length === content.length ? 'ASR_MEDIA_HASH' : 'ASR_MEDIA_LENGTH');
    assert.deepEqual(await readdir(failedDirectory), []);
  }
});

test('download refuses announced mismatch, truncated, oversized, encoded or hash-corrupt bodies', async t => {
  const cases = [
    { response: media(content, { 'content-length': String(content.length + 1) }), code: 'ASR_MEDIA_LENGTH' },
    { response: media(content.subarray(1)), code: 'ASR_MEDIA_LENGTH' },
    { response: media(Buffer.concat([content, Buffer.from('extra')])), code: 'ASR_MEDIA_LENGTH' },
    { response: media(Buffer.alloc(content.length)), code: 'ASR_MEDIA_HASH' },
    { response: media(content, { 'content-encoding': 'gzip' }), code: 'ASR_MEDIA_LENGTH' },
    { response: media(content, { 'content-length': String(100 * 1024 * 1024 + 1) }), code: 'ASR_MEDIA_LENGTH' }
  ];
  for (const item of cases) {
    const target = await directory(t), { client } = clientWith([item.response]);
    const sentinel = join(target, 'keep-this-file'); await writeFile(sentinel, 'keep');
    await rejectsCode(client.download(task(), target), item.code);
    assert.deepEqual(await readdir(target), ['keep-this-file']);
  }
});

test('a failed replacement preserves an existing verified file', async t => {
  const target = await directory(t), file = join(target, `${task().id}.media`);
  await writeFile(file, 'previous verified content');
  const { client } = clientWith([media(Buffer.alloc(content.length))]);
  await rejectsCode(client.download(task(), target), 'ASR_MEDIA_HASH');
  assert.equal(await readFile(file, 'utf8'), 'previous verified content');
  assert.deepEqual(await readdir(target), [`${task().id}.media`]);
});

test('media response is cancelled if its private directory disappears before file creation', async t => {
  const target = await directory(t);
  let cancelled = false;
  const { client } = clientWith([async () => {
    assert.equal(dirname(resolve(target)), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('yuqu-remote-client-'));
    await rmdir(target);
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }),
      { headers: { 'content-length': String(content.length) } });
  }]);
  await rejectsCode(client.download(task(), target), 'ASR_MEDIA_STORAGE');
  assert.equal(cancelled, true);
});

test('lease loss or caller cancellation stops a stalled download and cleans its own partial file', async t => {
  const target = await directory(t), controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream({ start(stream) { stream.enqueue(content.subarray(0, 2)); }, cancel() { cancelled = true; } });
  const { client } = clientWith([new Response(body, { headers: { 'content-length': String(content.length) } })]);
  const downloading = client.download(task(), target, controller.signal);
  // Wait until this download owns its partial file, then emulate lease cancellation.
  for (let count = 0; count < 100 && !(await readdir(target)).length; count++) await new Promise(resolveWait => setTimeout(resolveWait, 2));
  controller.abort(new Error(`Do not expose ${token}`));
  await rejectsCode(downloading, 'ASR_ABORTED');
  assert.equal(cancelled, true);
  assert.deepEqual(await readdir(target), []);
});

test('pre-cancelled requests do not fetch or create media files', async t => {
  const target = await directory(t), controller = new AbortController(); controller.abort();
  const { client, calls } = clientWith([json({ job: task() })]);
  await rejectsCode(client.claim(controller.signal), 'ASR_ABORTED');
  await rejectsCode(client.download(task(), target, controller.signal), 'ASR_ABORTED');
  assert.equal(calls.length, 0);
  assert.deepEqual(await readdir(target), []);
});

test('idle media timeout and JSON request timeout are finite and safe', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client } = clientWith([(_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  })]);
  const pending = client.claim();
  t.mock.timers.tick(15000);
  await rejectsCode(pending, 'ASR_TIMEOUT');
  const target = await directory(t);
  let started;
  const ready = new Promise(resolveReady => { started = resolveReady; });
  const idle = clientWith([() => { started(); return new Response(new ReadableStream(),
    { headers: { 'content-length': String(content.length) } }); }]);
  const download = idle.client.download(task(), target);
  await ready;
  // Open/write scheduling can occur after the response; let it enter the read loop.
  await new Promise(resolveTurn => setImmediate(resolveTurn));
  t.mock.timers.tick(15000);
  await rejectsCode(download, 'ASR_TIMEOUT');
  assert.deepEqual(await readdir(target), []);
});
