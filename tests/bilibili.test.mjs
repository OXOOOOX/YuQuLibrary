import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createBilibiliProvider, isBilibiliUrl, parseBilibiliUrl, validateBilibiliAudioUrl } from '../packages/domain/src/bilibili.ts';
import { importedMime } from '../packages/domain/src/ingestion.ts';

test('fragmented Bili MP4 brands need a real independent audio track', () => {
  const format = { container: 'iso5/avc1/dsms/msix/dash', hasAudio: true, hasVideo: false };
  assert.equal(importedMime(format), 'audio/mp4');
  assert.equal(importedMime({ ...format, hasVideo: true }), '');
  assert.equal(importedMime({ ...format, hasAudio: false }), '');
  assert.equal(importedMime({ container: format.container }), '');
  assert.equal(importedMime({ ...format, container: 'not-iso5' }), '');
});

const bvid = 'BV1bK411W797';
const url = `https://www.bilibili.com/video/${bvid}`;
const view = () => ({ code: 0, data: { bvid, title: '测试课程', state: 0, is_upower_exclusive: false,
  rights: { pay: 0, ugc_pay: 0, ugc_pay_preview: 0, arc_pay: 0, movie: 0 },
  pages: [{ page: 1, cid: 191557669, part: '第一讲', duration: 91 }, { page: 2, cid: 191559297, part: '第二讲', duration: 98 }] } });
const audio = (bandwidth = 132826, suffix = 'medium') => ({ mimeType: 'audio/mp4', codecs: 'mp4a.40.2', bandwidth,
  baseUrl: `https://upos-hz-mirrorakam.akamaized.net/test/${suffix}.m4s?deadline=1` });
const play = () => ({ code: 0, data: { timelength: 90314, accept_description: ['480P 标清'], dash: {
  audio: [audio(67382, 'low'), audio(179531, 'high'), audio()] } } });
function response(body, headers = {}) {
  const result = Readable.from([typeof body === 'string' ? body : JSON.stringify(body)]);
  result.headers = headers;
  return result;
}
function provider(metadata = view(), playback = play()) {
  const calls = [];
  const client = createBilibiliProvider({ openTransport: async (endpoint, signal) => {
    signal.throwIfAborted(); calls.push(new URL(endpoint));
    return response(endpoint.includes('/view?') ? metadata : playback);
  } });
  return { ...client, calls };
}
const signal = () => AbortSignal.timeout(2000);

test('Bili detection routes unsupported Bili URLs to the strict parser', () => {
  assert.equal(isBilibiliUrl(url), true);
  assert.equal(isBilibiliUrl('https://space.bilibili.com/123'), true);
  assert.equal(isBilibiliUrl('https://b23.tv/example'), true);
  assert.equal(isBilibiliUrl('https://bilibili.com.attacker.test/video/BV1bK411W797'), false);
  assert.equal(isBilibiliUrl('not a URL'), false);
});
test('canonical BV URLs discard tracking and keep one positive page', () => {
  assert.deepEqual(parseBilibiliUrl(`${url}/?spm_id_from=tracking&p=2#x`), { bvid, page: 2, url: `${url}?p=2`, explicitPage: true });
  assert.equal(parseBilibiliUrl(url).url, `${url}?p=1`);
  assert.equal(parseBilibiliUrl(url.replace('www.', '')).url, `${url}?p=1`);
});
test('invalid protocols, credentials, ports, paths and pages fail closed', () => {
  for (const value of [url.replace('https:', 'http:'), url.replace('www.', 'me:secret@www.'), url.replace('.com/', '.com:8080/'),
    url.replace('www.', 'api.'), `${url}/extra`, `${url}?p=0`, `${url}?p=-1`, `${url}?p=1.5`, `${url}?p=1&p=2`,
    `${url}?p=`, `${url}?p=9007199254740993`, 'https://www.bilibili.com/bangumi/play/ep123', 'https://www.bilibili.com/video/av123']) {
    assert.throws(() => parseBilibiliUrl(value), { code: 'BILIBILI_URL_INVALID' }, value);
  }
  assert.throws(() => parseBilibiliUrl('https://b23.tv/example'), { code: 'BILIBILI_URL_INVALID' });
});
test('preview uses source titles and returns independently selectable canonical pages', async () => {
  const client = provider();
  assert.deepEqual(await client.previewBilibili(url, signal()), { title: '测试课程', episodes: [
    { url: `${url}?p=1`, title: '测试课程 · P1 第一讲' }, { url: `${url}?p=2`, title: '测试课程 · P2 第二讲' }
  ] });
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].origin, 'https://api.bilibili.com');
  assert.equal(client.calls[0].searchParams.get('bvid'), bvid);
});
test('preview is bounded to 100 parts and rejects a nonexistent requested page', async () => {
  const metadata = view();
  metadata.data.pages = Array.from({ length: 101 }, (_, i) => ({ page: i + 1, cid: i + 1, part: String(i), duration: 90 }));
  const client = provider(metadata);
  assert.equal((await client.previewBilibili(url, signal())).episodes.length, 100);
  await assert.rejects(client.previewBilibili(`${url}?p=101`, signal()), { code: 'BILIBILI_PAGE_UNAVAILABLE' });
});
test('resolver selects moderate AAC, uses API CID, and preserves signed URL', async () => {
  const client = provider();
  const result = await client.resolveBilibiliAudio(url, signal());
  assert.deepEqual(result, { audioUrl: audio().baseUrl, title: '测试课程 · P1 第一讲', bvid, cid: 191557669, page: 1, durationMs: 90314 });
  assert.equal(client.calls[1].pathname, '/x/player/playurl');
  assert.equal(client.calls[1].searchParams.get('cid'), '191557669');
  assert.equal(client.calls[1].searchParams.has('try_look'), false);
});
test('a requested part resolves its own CID and duration', async () => {
  const playback = play(); playback.data.timelength = 98000;
  const client = provider(view(), playback);
  const result = await client.resolveBilibiliAudio(`${url}?p=2`, signal());
  assert.equal(result.cid, 191559297); assert.equal(result.page, 2);
  assert.equal(client.calls[1].searchParams.get('cid'), '191559297');
});
test('paid, exclusive, login and preview content is rejected before downloading', async () => {
  for (const key of ['pay', 'ugc_pay', 'ugc_pay_preview', 'arc_pay', 'movie']) {
    const metadata = view(); metadata.data.rights[key] = 1;
    const client = provider(metadata);
    await assert.rejects(client.resolveBilibiliAudio(url, signal()), { code: 'BILIBILI_SOURCE_RESTRICTED' });
    assert.equal(client.calls.length, 1);
  }
  const metadata = view(); metadata.data.is_upower_exclusive = true;
  await assert.rejects(provider(metadata).previewBilibili(url, signal()), { code: 'BILIBILI_SOURCE_RESTRICTED' });
  await assert.rejects(provider({ code: -101 }).previewBilibili(url, signal()), { code: 'BILIBILI_SOURCE_RESTRICTED' });
  for (const key of ['is_preview', 'isPreview', 'need_login', 'need_vip']) {
    const playback = play(); playback.data[key] = 1;
    await assert.rejects(provider(view(), playback).resolveBilibiliAudio(url, signal()), { code: 'BILIBILI_SOURCE_RESTRICTED' });
  }
  const playback = play(); playback.data.accept_description = ['试看'];
  await assert.rejects(provider(view(), playback).resolveBilibiliAudio(url, signal()), { code: 'BILIBILI_SOURCE_RESTRICTED' });
});
test('materially shorter playback cannot be labelled as a complete part', async () => {
  const playback = play(); playback.data.timelength = 30000;
  await assert.rejects(provider(view(), playback).resolveBilibiliAudio(url, signal()), { code: 'BILIBILI_SOURCE_RESTRICTED' });
});
test('missing or non-AAC audio has no fallback to video or manifests', async () => {
  for (const tracks of [[], [{ ...audio(), codecs: 'ec-3' }], [{ ...audio(), mimeType: 'video/mp4' }], [{ ...audio(), bandwidth: 0 }]]) {
    const playback = play(); playback.data.dash.audio = tracks;
    await assert.rejects(provider(view(), playback).resolveBilibiliAudio(url, signal()), { code: 'BILIBILI_AUDIO_UNAVAILABLE' });
  }
});
test('audio CDN validation does not allow arbitrary Akamai, private hosts or credentials', async () => {
  for (const value of ['https://attacker.akamaized.net/a.m4s', 'https://bilivideo.com.attacker.test/a', 'https://127.0.0.1/a',
    'https://me:secret@upos-hz-mirrorakam.akamaized.net/a', 'http://upos-hz-mirrorakam.akamaized.net/a', 'https://x.bilivideo.com:8443/a']) {
    assert.throws(() => validateBilibiliAudioUrl(value));
    const playback = play(); playback.data.dash.audio = [{ ...audio(), baseUrl: value }];
    await assert.rejects(provider(view(), playback).resolveBilibiliAudio(url, signal()), { code: 'BILIBILI_AUDIO_UNAVAILABLE' });
  }
  assert.equal(validateBilibiliAudioUrl('https://upos-sz-mirrorcoso1.bilivideo.com/a'), 'https://upos-sz-mirrorcoso1.bilivideo.com/a');
});
test('four-hour content selects a smaller audio track to remain within the byte limit', async () => {
  const metadata = view(); metadata.data.pages[0].duration = 14400;
  const playback = play(); playback.data.timelength = 14400000; playback.data.dash.audio = [audio(132000), audio(48000, 'low')];
  assert.match((await provider(metadata, playback).resolveBilibiliAudio(url, signal())).audioUrl, /low\.m4s/);
  playback.data.dash.audio = [audio(132000)];
  await assert.rejects(provider(metadata, playback).resolveBilibiliAudio(url, signal()), { code: 'BILIBILI_AUDIO_UNAVAILABLE' });
});
test('malformed metadata and JSON do not produce guessed IDs or titles', async () => {
  const metadata = view(); metadata.data.bvid = 'BV13x41117TL';
  await assert.rejects(provider(metadata).previewBilibili(url, signal()), { code: 'BILIBILI_RESPONSE_INVALID' });
  const duplicate = view(); duplicate.data.pages[1].page = 1;
  await assert.rejects(provider(duplicate).previewBilibili(url, signal()), { code: 'BILIBILI_RESPONSE_INVALID' });
  const missingRights = view(); delete missingRights.data.rights.ugc_pay;
  await assert.rejects(provider(missingRights).previewBilibili(url, signal()), { code: 'BILIBILI_RESPONSE_INVALID' });
  const client = createBilibiliProvider({ openTransport: async () => response('not json') });
  await assert.rejects(client.previewBilibili(url, signal()), { code: 'BILIBILI_RESPONSE_INVALID' });
});
test('both declared and streamed JSON sizes are bounded', async () => {
  for (const fixture of [response('{}', { 'content-length': String(2 * 1024 * 1024 + 1) }), response('x'.repeat(2 * 1024 * 1024 + 1))]) {
    const client = createBilibiliProvider({ openTransport: async () => fixture });
    await assert.rejects(client.previewBilibili(url, signal()), { code: 'BILIBILI_RESPONSE_INVALID' });
    assert.equal(fixture.destroyed, true);
  }
});
test('caller cancellation stops before transport and interrupts a stalled response', async () => {
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  const client = provider();
  await assert.rejects(client.previewBilibili(url, controller.signal), /cancelled/);
  assert.equal(client.calls.length, 0);
  const stalled = new Readable({ read() {} }); stalled.headers = {};
  const slow = createBilibiliProvider({ openTransport: async () => stalled });
  const cancellation = new AbortController();
  const operation = slow.previewBilibili(url, cancellation.signal);
  setTimeout(() => cancellation.abort(new Error('stop')), 10);
  await assert.rejects(operation, /stop/); assert.equal(stalled.destroyed, true);
});
