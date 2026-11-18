import test from 'node:test';
import assert from 'node:assert/strict';
import { importFailure } from '../packages/domain/src/ingestion.ts';
import { AppError } from '../packages/domain/src/errors.ts';

test('import failures identify network, metadata, storage and publication without exposing raw details', () => {
  const error = Object.assign(new Error('https://private.example/audio?token=secret /private/storage/file'), { code: 'ECONNRESET' });
  const signal = new AbortController().signal;
  const messages = ['download', 'metadata', 'storage', 'publish'].map(phase => importFailure(error, phase, signal));
  assert.equal(new Set(messages).size, 4);
  for (const message of messages) assert.doesNotMatch(message, /private|secret|https|storage\/file/);
  assert.match(messages[0], /中断/); assert.match(messages[1], /解析/);
  assert.match(messages[2], /存储/); assert.match(messages[3], /确认/);
});
test('overall deadline and lost lease remain distinguishable from stream abort errors', () => {
  const signal = new AbortController();
  signal.abort(new AppError(408, 'DOWNLOAD_DEADLINE', '音频下载超过 5 分钟，请稍后重试。'));
  const aborted = Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
  assert.match(importFailure(aborted, 'download', signal.signal), /5 分钟/);
  const lease = new AbortController();
  lease.abort(new AppError(409, 'IMPORT_LEASE_LOST', '下载任务已由其他进程接管，请刷新状态。'));
  assert.match(importFailure(aborted, 'download', lease.signal), /其他进程接管/);
});
