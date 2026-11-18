import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceUrl, publicAddress, parseFeed, abortable, decodeXml } from '../packages/domain/src/remote.ts';
import { byteRange } from '../apps/web/lib/media.ts';

test('import URLs exclude local networks, credentials, alternate ports and non-HTTP schemes', () => {
  for (const url of ['file:///tmp/a','https://user:pass@example.com/a','http://127.1/a','http://0x7f000001/a','http://2130706433/a','http://10.0.0.1','http://169.254.169.254/','http://[::1]/','http://[::ffff:127.0.0.1]/','https://localhost./','https://example.local/','https://example.com:8443/']) assert.throws(() => sourceUrl(url), url);
  assert.equal(sourceUrl('https://example.com/audio.mp3#fragment').href,'https://example.com/audio.mp3');
  for (const ip of ['198.18.0.1','0.0.0.0','100.64.0.1','192.168.1.1','224.0.0.1','fc00::1','fe80::1','64:ff9b::7f00:1','2002:7f00:1::']) assert.equal(publicAddress(ip),false,ip);
  assert.equal(publicAddress('8.8.8.8'),true);assert.equal(publicAddress('2606:4700:4700::1111'),true);
});
test('RSS parses enclosure entities, relative URLs, deduplication and bounded entries', () => {
  const xml='<rss><channel><title>A &amp; B</title><item><title>One</title><enclosure url="episode.mp3?a=1&#38;b=2" /></item><item><enclosure url="episode.mp3?a=1&amp;b=2" /></item><item><enclosure url="http://127.0.0.1/private" /></item></channel></rss>';
  assert.deepEqual(parseFeed(xml,'https://cdn.example/shows/feed.xml'),{title:'A & B',episodes:[{title:'One',url:'https://cdn.example/shows/episode.mp3?a=1&b=2'}]});
  assert.equal(decodeXml('&amp;#38;'), '&#38;');
  const items=Array.from({length:130},(_,i)=>`<item><enclosure url="https://cdn.example/${i}.mp3"/></item>`).join('');
  assert.equal(parseFeed(`<rss><channel>${items}</channel></rss>`,'https://feed.example').episodes.length,100);
  assert.equal(parseFeed('<feed><title>Atom</title><entry><title>A</title><link rel="enclosure" href="a.mp3"/></entry></feed>','https://cdn.example/').episodes[0].url,'https://cdn.example/a.mp3');
});
test('RSS rejects DTD/entity expansion, malformed and oversized payloads', () => {
  for(const xml of ['<!DOCTYPE rss><rss/>','<!ENTITY x "abc"><rss/>','<rss>','<html></html>',' '.repeat(2*1024*1024+1)])assert.throws(()=>parseFeed(xml,'https://example.com'));
});
test('DNS cancellation ends promptly even if the underlying lookup never returns', async () => {
  const controller=new AbortController();const task=abortable(new Promise(()=>{}),controller.signal);
  controller.abort(new Error('cancelled'));await assert.rejects(task,/cancelled/);
  await assert.rejects(abortable(Promise.reject(new Error('late lookup failure')),controller.signal),/cancelled/);
});
test('media single ranges handle prefix, suffix, clamping and reject malformed requests', () => {
  assert.equal(byteRange(null,100),null);assert.deepEqual(byteRange('bytes=0-9',100),{start:0,end:9});
  assert.deepEqual(byteRange('bytes=90-',100),{start:90,end:99});assert.deepEqual(byteRange('bytes=-20',100),{start:80,end:99});
  assert.deepEqual(byteRange('bytes=95-999',100),{start:95,end:99});
  for(const value of ['bytes=100-','bytes=-0','bytes=10-2','bytes=0-1,3-4','bytes=-','bytes=9007199254740999-','invalid'])assert.throws(()=>byteRange(value,100));
});
