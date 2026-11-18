import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runEpisode } from '../workers/transcription/process.mjs';
import { acquireModelLock } from '../workers/transcription/lock.mjs';
import {
  createInferenceDiagnosticCollector,
  INFERENCE_DIAGNOSTIC_LIMITS,
  parseInferenceDiagnosticLine,
  safeDiagnosticForError,
  safeInferenceFailure,
} from '../workers/transcription/inference-diagnostics.mjs';

test('collects a fixed diagnostic across UTF-8 chunks and CRLF', () => {
  const collector = createInferenceDiagnosticCollector();
  collector.push(Buffer.from('{"code":"DECODE_'));
  collector.push(Buffer.from('FAILED"}\r'));
  collector.push(Buffer.from('\n')); 
  assert.deepEqual(collector.finish(), { code: 'DECODE_FAILED' });
  assert.equal(collector.finish().code, 'DECODE_FAILED');
});

test('accepts the generic error type only from the Python allow-list', () => {
  assert.deepEqual(
    parseInferenceDiagnosticLine('{"code":"GPU_OUT_OF_MEMORY","errorType":"OutOfMemoryError"}'),
    { code: 'GPU_OUT_OF_MEMORY', errorType: 'OutOfMemoryError' },
  );
  assert.deepEqual(
    parseInferenceDiagnosticLine('{"code":"TRANSCRIPTION_FAILED","errorType":"RuntimeError"}'),
    { code: 'TRANSCRIPTION_FAILED', errorType: 'RuntimeError' },
  );
  assert.equal(parseInferenceDiagnosticLine('{"code":"DECODE_FAILED","errorType":"RuntimeError"}'), null);
  assert.equal(parseInferenceDiagnosticLine('{"code":"TRANSCRIPTION_FAILED","errorType":"SecretError"}'), null);
});

test('ignores ordinary stderr but rejects malformed or expanded diagnostic JSON', () => {
  const collector = createInferenceDiagnosticCollector();
  collector.push('warning: /private/audio.mp3 token=do-not-log\n');
  collector.push('{"code":"DECODE_FAILED","path":"/private/model"}\n');
  assert.equal(collector.finish(), null);
  assert.equal(parseInferenceDiagnosticLine('{"code":"NOT_A_PYTHON_CODE"}'), null);
  assert.equal(parseInferenceDiagnosticLine('{"code":"DECODE_FAILED"'), null);
  assert.equal(parseInferenceDiagnosticLine('[{"code":"DECODE_FAILED"}]'), null);
});

test('fails closed on an overlong line and on total stderr overflow', () => {
  const lineCollector = createInferenceDiagnosticCollector();
  lineCollector.push(`{"code":"DECODE_FAILED","padding":"${'x'.repeat(INFERENCE_DIAGNOSTIC_LIMITS.maxLineBytes)}"}\n`);
  assert.equal(lineCollector.finish(), null);

  const totalCollector = createInferenceDiagnosticCollector();
  totalCollector.push(Buffer.alloc(INFERENCE_DIAGNOSTIC_LIMITS.maxStderrBytes + 1, 0x78));
  totalCollector.push('{"code":"DECODE_FAILED"}\n');
  assert.equal(totalCollector.finish(), null);
});

test('turns a fake subprocess failure into safe structured data', () => {
  const stderr = createInferenceDiagnosticCollector();
  stderr.push('loader warning: C:\\secret\\model.bin\n');
  stderr.push(Buffer.from('{"code":"GPU_OUT_OF_'));
  stderr.push(Buffer.from('MEMORY","errorType":"OutOfMemoryError"}\n'));
  const failure = safeInferenceFailure(stderr.finish());
  assert.equal(failure.message, 'Local inference failed');
  assert.deepEqual(safeDiagnosticForError(failure), {
    code: 'GPU_OUT_OF_MEMORY', errorType: 'OutOfMemoryError',
  });
  assert.equal(failure.stack.includes('C:\\secret\\model.bin'), false);

  // Cancellation must take precedence over a child diagnostic and reveal no
  // child stderr when the parent stops the worker.
  assert.deepEqual(safeDiagnosticForError(failure, { aborted: true }), { code: 'ABORTED' });
  assert.deepEqual(safeDiagnosticForError(new Error('raw /private/token')), { code: 'TRANSCRIPTION_FAILED' });
  assert.deepEqual(safeDiagnosticForError({ name: 'RemoteTranscriptionError', code: 'ASR_MEDIA_LENGTH', message: 'secret' }), { code: 'ASR_MEDIA_LENGTH' });
  assert.deepEqual(safeDiagnosticForError({ name: 'RemoteTranscriptionError', code: 'ASR_SECRET_123', message: 'secret' }), { code: 'TRANSCRIPTION_FAILED' });
});

test('reads a real fake child failure without invoking the model', async () => {
  const child = spawn(process.execPath, ['-e',
    "process.stderr.write('{\\\"code\\\":\\\"DECODE_FAILED\\\"}\\n'); process.exit(7);"],
  { stdio: ['ignore', 'ignore', 'pipe'] });
  const collector = createInferenceDiagnosticCollector();
  child.stderr.on('data', block => collector.push(block));
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code));
  });
  assert.equal(exitCode, 7);
  assert.deepEqual(safeDiagnosticForError(safeInferenceFailure(collector.finish())), { code: 'DECODE_FAILED' });
});

test('maps a fake child cancellation to ABORTED without exposing stderr', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000);'],
    { stdio: ['ignore', 'ignore', 'ignore'] });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const controller = new AbortController();
  controller.signal.addEventListener('abort', () => child.kill(), { once: true });
  controller.abort();
  await closed;
  assert.deepEqual(safeDiagnosticForError(new Error('cancelled /private/token'), { aborted: true }), { code: 'ABORTED' });
});

test('runEpisode propagates safe child diagnostics and cleans every launch failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yuqu-diagnostic-test-'));
  const data = Buffer.from('test media');
  await writeFile(join(directory, 'audio.bin'), data);
  const task = { storageKey: 'audio.bin', sha256: createHash('sha256').update(data).digest('hex'), durationMs: 30000, completedMs: 0 };
  const settings = { MEDIA_STORAGE_DIR: directory, YUQU_ASR_PYTHON: process.execPath,
    YUQU_ASR_MODEL_DIR: directory, YUQU_ASR_ALIGNER_DIR: directory, YUQU_ASR_FFMPEG: process.execPath };
  try {
    const spawnFailure = (_file, _args, options) => spawn(process.execPath, ['-e',
      `process.stderr.write('private path and token must not escape\\n');
       process.stderr.write('{"code":"TRANSCRIPTION_FAILED",');
       setTimeout(() => { process.stderr.write('"errorType":"ModuleNotFoundError"}'); process.exitCode = 7; }, 10);`], options);
    await assert.rejects(runEpisode(task, settings, new AbortController().signal, () => assert.fail('no chunk expected'), spawnFailure),
      error => error.message === 'Local inference failed' && error.diagnosticCode === 'TRANSCRIPTION_FAILED' && error.diagnosticType === 'ModuleNotFoundError');
    assert.deepEqual(await readdir(directory), ['audio.bin']);
    await assert.rejects(runEpisode(task, settings, new AbortController().signal, () => {}, () => { throw new Error('private spawn error'); }),
      { message: 'Local inference failed' });
    assert.deepEqual(await readdir(directory), ['audio.bin']);
    await assert.rejects(runEpisode(task, { ...settings, YUQU_ASR_PYTHON: join(directory, 'missing-python') },
      new AbortController().signal, () => {}), { message: 'Local inference failed' });
    assert.deepEqual(await readdir(directory), ['audio.bin']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('runEpisode cancellation terminates the owned child and removes its work directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yuqu-diagnostic-cancel-'));
  const data = Buffer.from('test media');
  await writeFile(join(directory, 'audio.bin'), data);
  const controller = new AbortController();
  const lease = await acquireModelLock(directory);
  let attached = false, detached = false;
  const modelLease = {
    async attachChild(pid) { await lease.attachChild(pid); attached = true; },
    async detachChild(pid) {
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      await lease.detachChild(pid); detached = true;
    },
  };
  let child;
  try {
    const spawnWaiting = (_file, _args, options) => {
      child = spawn(process.execPath, ['-e', `process.stdin.once('data',data=>{
        if(data.toString()!=='start\\n') process.exit(8);
        process.stdout.write(JSON.stringify({type:'chunk',startMs:0,endMs:30000})+'\\n');
      });setInterval(()=>{},1000);`], options);
      return child;
    };
    await assert.rejects(runEpisode({ storageKey: 'audio.bin', sha256: createHash('sha256').update(data).digest('hex'),
      durationMs: 60000, completedMs: 0 }, { MEDIA_STORAGE_DIR: directory, YUQU_ASR_PYTHON: process.execPath,
      YUQU_ASR_MODEL_DIR: directory, YUQU_ASR_ALIGNER_DIR: directory, YUQU_ASR_FFMPEG: process.execPath, modelLease },
      controller.signal, () => { assert.equal(attached, true); controller.abort(); }, spawnWaiting));
    assert.equal(controller.signal.aborted, true);
    assert.equal(detached, true);
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
    assert.deepEqual(await readdir(directory), ['audio.bin']);
  } finally { await lease(); await rm(directory, { recursive: true, force: true }); }
});

test('runEpisode does not start inference when child registration fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yuqu-register-failure-'));
  const data = Buffer.from('test media');
  await writeFile(join(directory, 'audio.bin'), data);
  let child;
  try {
    const spawnWaiting = (_file, _args, options) => {
      child = spawn(process.execPath, ['-e', `process.stdin.once('data',()=>process.stdout.write('started'));setInterval(()=>{},1000);`], options);
      return child;
    };
    await assert.rejects(runEpisode({ storageKey: 'audio.bin', sha256: createHash('sha256').update(data).digest('hex'),
      durationMs: 30000, completedMs: 0 }, { MEDIA_STORAGE_DIR: directory, YUQU_ASR_PYTHON: process.execPath,
      YUQU_ASR_MODEL_DIR: directory, YUQU_ASR_ALIGNER_DIR: directory, YUQU_ASR_FFMPEG: process.execPath,
      modelLease: { attachChild: async () => { throw new Error('Registration failed'); },
        detachChild: () => assert.fail('unregistered child must not detach another child') } },
      new AbortController().signal, () => assert.fail('inference must not start'), spawnWaiting), /Registration failed/);
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
    assert.deepEqual(await readdir(directory), ['audio.bin']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

