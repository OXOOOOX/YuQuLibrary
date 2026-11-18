import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createMediaDownloader } from '../packages/domain/src/download.ts';
import { bilibiliHeaders } from '../packages/domain/src/remote.ts';

const source = 'https://feed.example/audio.mp3', final = 'https://cdn.example/audio.mp3';
const body = Buffer.from('abcdefghijklmnopqrstuvwxyz');
const etag = '"audio-v1"';
test('Bili fixed referer is confined to checked HTTPS audio hosts', () => {
  assert.deepEqual(bilibiliHeaders(new URL('https://upos-hz-mirrorakam.akamaized.net/a'), 'bilibili'), { Referer: 'https://www.bilibili.com/' });
  assert.deepEqual(bilibiliHeaders(new URL('https://cdn.example/a')), {});
  for (const url of ['http://a.bilivideo.com/a','https://evil.example/a','https://bilivideo.com.evil.example/a','https://random.akamaized.net/a']) {
    assert.throws(() => bilibiliHeaders(new URL(url), 'bilibili'));
  }
});
const error = (code = 'ECONNRESET') => Object.assign(new Error('private-url?token=test-secret'), { code });
const hash = value => createHash('sha256').update(value).digest('hex');
function response(chunks, { headers = {}, status = 200, url = final, fault } = {}) {
  const stream = Readable.from((async function* () {
    for (const chunk of chunks) { yield chunk; await nextTurn(); }
    if (fault) throw fault;
  })(), { objectMode: false, highWaterMark: 1 });
  return Object.assign(stream, { statusCode: status, headers, sourceUrl: url });
}
const first = (chunk = body.subarray(0, 8), extra = {}) => response([chunk], {
  headers: { 'content-length': String(body.length), etag }, fault: error(), ...extra
});
const remaining = (start = 8, extra = {}) => response([body.subarray(start)], {
  status: 206, headers: { 'content-length': String(body.length - start), 'content-range': `bytes ${start}-${body.length - 1}/${body.length}`, etag }, ...extra
});
async function withFile(run) {
  const directory = await mkdtemp(join(tmpdir(), 'yuqu-download-test-'));
  try { return await run(join(directory, 'audio.part')); }
  finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    assert.ok(directory.split(sep).at(-1).startsWith('yuqu-download-test-'));
    await rm(directory, { recursive: true, force: true });
  }
}
function transport(responses) {
  const calls = [];
  const openTransport = async (url, signal, options) => {
    calls.push({ url, signal, options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    assert.ok(next, 'unexpected extra connection');
    return next;
  };
  return { calls, openTransport };
}
function memoryFile({ short = Infinity, failAt = Infinity, closeFailure = false } = {}) {
  const chunks = [], writes = []; let closes = 0;
  return {
    chunks, writes, get closes() { return closes; },
    async openFile(_path, flags) {
      assert.equal(flags, 'wx');
      return {
        async write(buffer, offset, length, position) {
          if (writes.length === failAt) throw error();
          const bytesWritten = Math.min(length, short);
          writes.push({ position, bytesWritten });
          chunks.push(Buffer.from(buffer.subarray(offset, offset + bytesWritten)));
          return { bytesWritten };
        },
        async close() { closes++; if (closeFailure) throw error(); }
      };
    }
  };
}

test('full response and safe resume write exact bytes, digest and final URL', async () => withFile(async path => {
  const t = transport([first(), remaining()]), signal = new AbortController().signal, progress = [];
  const result = await createMediaDownloader(t)(source, path, signal, value => progress.push(value));
  assert.deepEqual(result, { byteSize: body.length, sha256: hash(body), connections: 2 });
  assert.deepEqual(await readFile(path), body);
  assert.equal(t.calls[0].url, source);
  assert.deepEqual(t.calls[1], { url: final, signal, options: { range: { start: 8, etag } } });
  assert.deepEqual(progress.at(-1), { receivedBytes: body.length, expectedBytes: body.length, connections: 2 });
  assert.ok(progress.every((value, i) => i === 0 || value.receivedBytes >= progress[i - 1].receivedBytes));
}));

test('clean premature EOF resumes but a complete response needs no validator', async () => {
  await withFile(async path => {
    const t = transport([first(body.subarray(0, 8), { fault: undefined }), remaining()]);
    assert.equal((await createMediaDownloader(t)(source, path, new AbortController().signal)).connections, 2);
  });
  await withFile(async path => {
    const t = transport([response([body])]);
    assert.deepEqual(await createMediaDownloader(t)(source, path, new AbortController().signal), { byteSize: body.length, sha256: hash(body), connections: 1 });
  });
});

test('Bili site policy remains applied to resumed media requests', async () => withFile(async path => {
  const t = transport([first(), remaining()]);
  await createMediaDownloader(t)(source, path, new AbortController().signal, undefined, { site: 'bilibili' });
  assert.deepEqual(t.calls[0].options, { site: 'bilibili' });
  assert.deepEqual(t.calls[1].options, { site: 'bilibili', range: { start: 8, etag } });
}));

test('missing or weak validator, unknown length and zero-byte failure never resume', async () => {
  for (const headers of [{ 'content-length': '26' }, { 'content-length': '26', etag: 'W/"v1"' },
    { 'content-length': '26', etag: '"' + 'x'.repeat(511) + '"' }, { etag }]) {
    await withFile(async path => {
      const t = transport([first(undefined, { headers })]);
      await assert.rejects(createMediaDownloader(t)(source, path, new AbortController().signal), { code: 'MEDIA_DOWNLOAD_INTERRUPTED' });
      assert.equal(t.calls.length, 1);
    });
  }
  await withFile(async path => {
    const t = transport([first(Buffer.alloc(0))]);
    await assert.rejects(createMediaDownloader(t)(source, path, new AbortController().signal), { code: 'MEDIA_DOWNLOAD_INTERRUPTED' });
    assert.equal(t.calls.length, 1);
  });
});

test('resume rejects ignored ranges, 416, changed media and inconsistent range metadata', async () => {
  const good = { 'content-length': '18', 'content-range': 'bytes 8-25/26', etag };
  const cases = [
    { status: 200 }, { status: 416 }, { url: 'https://other.example/audio.mp3' },
    { headers: { ...good, etag: '"audio-v2"' } }, { headers: { ...good, etag: 'W/"audio-v1"' } },
    { headers: { ...good, etag: undefined } }, { headers: { ...good, 'content-range': undefined } },
    { headers: { ...good, 'content-range': 'bytes 7-25/26' } },
    { headers: { ...good, 'content-range': 'bytes 8-24/26' } },
    { headers: { ...good, 'content-range': 'bytes 8-25/27' } },
    { headers: { ...good, 'content-length': '17' } }, { headers: { ...good, 'content-length': undefined } }
  ];
  for (const options of cases) await withFile(async path => {
    const t = transport([first(), remaining(8, options)]);
    await assert.rejects(createMediaDownloader(t)(source, path, new AbortController().signal), { code: 'MEDIA_RESUME_INVALID' });
    assert.equal(t.calls.length, 2);
    assert.deepEqual(await readFile(path), body.subarray(0, 8));
  });
});

test('at most three connections; a failed resumed connection consumes its allowance', async () => withFile(async path => {
  const third = response([body.subarray(8, 12)], { status: 206,
    headers: { 'content-length': '18', 'content-range': 'bytes 8-25/26', etag }, fault: error() });
  const t = transport([first(), error('REMOTE_HEADERS_TIMEOUT'), third]);
  await assert.rejects(createMediaDownloader(t)(source, path, new AbortController().signal), { code: 'MEDIA_DOWNLOAD_INTERRUPTED' });
  assert.equal(t.calls.length, 3);
}));

test('success after three partial transfers uses only fully written offsets', async () => {
  const middle = response([body.subarray(8, 12)], { status: 206,
    headers: { 'content-length': '18', 'content-range': 'bytes 8-25/26', etag }, fault: error('REMOTE_IDLE_TIMEOUT') });
  const t = transport([first(), middle, remaining(12)]), disk = memoryFile({ short: 3 });
  const result = await createMediaDownloader({ ...t, openFile: disk.openFile })(source, 'unused', new AbortController().signal);
  assert.equal(result.connections, 3);
  assert.equal(result.sha256, hash(body));
  assert.deepEqual(Buffer.concat(disk.chunks), body);
  assert.deepEqual(t.calls.map(call => call.options?.range?.start), [undefined, 8, 12]);
  assert.equal(disk.closes, 1);
});

test('abort before open and during a stalled body stops promptly without reconnecting', async () => {
  const early = new AbortController(); early.abort(error()); let opened = 0;
  await assert.rejects(createMediaDownloader({ openFile: async () => { opened++; throw error(); } })(source, 'unused', early.signal), { code: 'MEDIA_DOWNLOAD_ABORTED' });
  assert.equal(opened, 0);
  await withFile(async path => {
    const controller = new AbortController(), stalled = Object.assign(new Readable({ read() {} }), { statusCode: 200, headers: { 'content-length': '26', etag }, sourceUrl: final });
    const t = transport([stalled]);
    const task = createMediaDownloader(t)(source, path, controller.signal);
    const rejection = assert.rejects(task, { code: 'MEDIA_DOWNLOAD_ABORTED' });
    while (t.calls.length === 0) await nextTurn();
    controller.abort(error());
    await rejection;
    assert.equal(stalled.destroyed, true);
    assert.equal(t.calls.length, 1);
  });
});

test('size limit applies to declared and streamed bytes, never restarting or writing the excess', async () => {
  const limit = 100 * 1024 * 1024;
  const declared = transport([response([], { headers: { 'content-length': String(limit + 1), etag } })]), disk = memoryFile();
  await assert.rejects(createMediaDownloader({ ...declared, openFile: disk.openFile })(source, 'unused', new AbortController().signal), { code: 'MEDIA_TOO_LARGE' });
  assert.equal(disk.writes.length, 0);
  let stored = 0, closed = false;
  const block = Buffer.alloc(4 * 1024 * 1024), chunks = [...Array(25).fill(block), Buffer.from('x')];
  const streamed = transport([response(chunks)]);
  await assert.rejects(createMediaDownloader({ ...streamed, openFile: async () => ({
    async write(_chunk, _offset, length) { stored += length; return { bytesWritten: length }; },
    async close() { closed = true; }
  }) })(source, 'unused', new AbortController().signal), { code: 'MEDIA_TOO_LARGE' });
  assert.equal(stored, limit); assert.equal(closed, true); assert.equal(streamed.calls.length, 1);
});

test('oversized response body and malformed length fail instead of accepting a partial file', async () => {
  for (const length of ['25', '-1', '26, 26', '9007199254740993']) await withFile(async path => {
    const t = transport([response([body], { headers: { 'content-length': length, etag } })]);
    await assert.rejects(createMediaDownloader(t)(source, path, new AbortController().signal), { code: 'MEDIA_RESPONSE_INVALID' });
    assert.equal(t.calls.length, 1);
  });
});

test('disk failures, including a partial write with a network-shaped error, are never retried', async () => {
  const t = transport([response([body], { headers: { 'content-length': '26', etag } })]), disk = memoryFile({ short: 3, failAt: 1 });
  const progress = [];
  await assert.rejects(createMediaDownloader({ ...t, openFile: disk.openFile })(source, 'unused', new AbortController().signal, value => progress.push(value)), error => {
    assert.equal(error.code, 'MEDIA_STORAGE_WRITE_FAILED'); assert.equal(error.message.includes('test-secret'), false); return true;
  });
  assert.equal(t.calls.length, 1); assert.equal(disk.closes, 1);
  assert.ok(progress.every(value => value.receivedBytes === 0));
  await withFile(async path => {
    await writeFile(path, 'keep existing file'); const existing = transport([]);
    await assert.rejects(createMediaDownloader(existing)(source, path, new AbortController().signal), { code: 'MEDIA_STORAGE_WRITE_FAILED' });
    assert.equal(existing.calls.length, 0); assert.equal(await readFile(path, 'utf8'), 'keep existing file');
  });
  const closing = memoryFile({ closeFailure: true }), complete = transport([response([body])]);
  await assert.rejects(createMediaDownloader({ ...complete, openFile: closing.openFile })(source, 'unused', new AbortController().signal), { code: 'MEDIA_STORAGE_WRITE_FAILED' });
});

test('non-transient errors are not retried and private details never escape', async () => withFile(async path => {
  const t = transport([first(undefined, { fault: error('EACCES') })]);
  await assert.rejects(createMediaDownloader(t)(source, path, new AbortController().signal), err => {
    assert.equal(err.code, 'MEDIA_DOWNLOAD_FAILED'); assert.equal(err.message.includes('test-secret'), false); return true;
  });
  assert.equal(t.calls.length, 1);
}));

test('diagnostic transport codes survive normalization while DNS, TLS and HTTP messages stay fixed', async () => {
  const cases = [
    ['ECONNRESET', 'MEDIA_DOWNLOAD_INTERRUPTED'], ['ENOTFOUND', 'REMOTE_DNS_FAILED'], ['EAI_AGAIN', 'REMOTE_DNS_FAILED'],
    ['REMOTE_HTTP_STATUS', 'REMOTE_HTTP_STATUS'], ['REMOTE_IDLE_TIMEOUT', 'REMOTE_IDLE_TIMEOUT'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'REMOTE_TLS_FAILED'], ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'REMOTE_TLS_FAILED'],
    ['CERT_HAS_EXPIRED', 'REMOTE_TLS_FAILED']
  ];
  for (const [transportCode, code] of cases) await withFile(async path => {
    const t = transport([error(transportCode)]);
    await assert.rejects(createMediaDownloader(t)(source, path, new AbortController().signal), err => {
      assert.equal(err.code, code); assert.equal(err.transportCode, transportCode);
      assert.equal(err.message.includes('test-secret'), false); assert.equal(err.message.includes('https:'), false); return true;
    });
    assert.equal(t.calls.length, 1);
  });
  await withFile(async path => {
    const t = transport([Object.assign(error('private-url?token=test-secret'), { transportCode: 'private-token' })]);
    await assert.rejects(createMediaDownloader(t)(source, path, new AbortController().signal), err => {
      assert.equal(err.code, 'MEDIA_DOWNLOAD_FAILED'); assert.equal(err.transportCode, undefined);
      assert.equal(err.message.includes('test-secret'), false); return true;
    });
  });
});
