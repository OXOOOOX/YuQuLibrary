import test from 'node:test';
import assert from 'node:assert/strict';
import { SseDecoder } from '../packages/domain/src/sse.ts';
const encoder = new TextEncoder();

test('split UTF-8 bytes and CRLF preserve payload and event id', () => {
  const bytes = encoder.encode('id: 42\r\nevent: probe\r\ndata: {"text":"鱼趣"}\r\n\r\n');
  const parser = new SseDecoder();
  const events = [...bytes].flatMap(byte => parser.push(Uint8Array.of(byte)));
  assert.deepEqual(events, [{ id: '42', event: 'probe', data: '{"text":"鱼趣"}' }]);
});

test('comments and incomplete messages are not emitted; multiline data joins', () => {
  const parser = new SseDecoder();
  assert.deepEqual(parser.push(encoder.encode(': heartbeat\ndata: first\ndata: sec')), []);
  assert.deepEqual(parser.push(encoder.encode('ond\n\n')), [{ event: 'message', data: 'first\nsecond' }]);
});

test('batched events retain last id while event type resets', () => {
  const parser = new SseDecoder();
  assert.deepEqual(parser.push(encoder.encode('id: 1\nevent: probe\ndata: a\n\ndata: b\n\n')), [
    { id: '1', event: 'probe', data: 'a' }, { id: '1', event: 'message', data: 'b' }
  ]);
});

test('NUL ids are ignored and oversized incomplete input is rejected', () => {
  const parser = new SseDecoder();
  assert.deepEqual(parser.push(encoder.encode('id: invalid\0id\ndata: x\n\n')), [{ event: 'message', data: 'x' }]);
  assert.throws(() => parser.push(encoder.encode('x'.repeat(65537))), /64 KiB/);
});

test('one large network chunk can contain many valid bounded events', () => {
  const parser = new SseDecoder();
  const frame = `data: ${'x'.repeat(80)}\n\n`;
  const events = parser.push(encoder.encode(frame.repeat(1000)));
  assert.equal(events.length, 1000);
  assert.equal(events[999].data, 'x'.repeat(80));
});

test('CR-only terminators dispatch immediately and a following LF is absorbed', () => {
  const parser = new SseDecoder();
  assert.deepEqual(parser.push(encoder.encode('data: hello\r\r')), [{ event: 'message', data: 'hello' }]);
  assert.deepEqual(parser.push(encoder.encode('\ndata: next\r\n\r\n')), [{ event: 'message', data: 'next' }]);
});

test('empty data lines count toward the bounded event size', () => {
  const parser = new SseDecoder();
  assert.throws(() => parser.push(encoder.encode('data:\n'.repeat(65538))), /64 KiB/);
});
