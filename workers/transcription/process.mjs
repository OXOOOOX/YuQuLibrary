import { spawn, execFile } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTranscriptionWorkspace } from './workspace.mjs';
import { claimTranscript, renewTranscript, saveTranscriptChunk, completeTranscript, failTranscript } from '../../packages/domain/src/transcripts.ts';
import {
  createInferenceDiagnosticCollector,
  safeDiagnosticForError,
  safeInferenceFailure,
} from './inference-diagnostics.mjs';

export function inferenceSettings() {
  const names = ['YUQU_ASR_PYTHON', 'YUQU_ASR_MODEL_DIR', 'YUQU_ASR_ALIGNER_DIR', 'YUQU_ASR_FFMPEG', 'MEDIA_STORAGE_DIR'];
  const paths = {};
  for (const name of names) {
    const value = process.env[name];
    if (!value || !isAbsolute(value) || !existsSync(value)) throw new Error(`Missing local transcription setting: ${name}`);
    paths[name] = value;
  }
  return paths;
}
function inferenceEnvironment() {
  const allowed = new Set(['path', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'userprofile', 'localappdata',
    'appdata', 'programdata', 'programfiles', 'programfiles(x86)', 'systemdrive', 'number_of_processors',
    'processor_architecture', 'cuda_path', 'cuda_path_v12_8', 'cuda_visible_devices']);
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase()))),
    PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_IMPLICIT_TOKEN: '1', TOKENIZERS_PARALLELISM: 'false' };
}
export async function runEpisode(task, settings, signal, onChunk, spawnChild = spawn) {
  const directory = resolve(settings.MEDIA_STORAGE_DIR), audio = resolve(directory, task.storageKey);
  const childPath = relative(directory, audio);
  if (!childPath || childPath === '..' || childPath.startsWith(`..${sep}`) || isAbsolute(childPath)) throw new Error('Invalid media storage path');
  const digest = createHash('sha256');
  for await (const block of createReadStream(audio, { signal })) digest.update(block);
  if (digest.digest('hex') !== task.sha256) throw new Error('Media content changed');
  signal.throwIfAborted();
  const workspace = await createTranscriptionWorkspace(directory);
  const workDirectory = workspace.path;
  let child;
  try {
    child = spawnChild(settings.YUQU_ASR_PYTHON, [fileURLToPath(new URL('./episode.py', import.meta.url)),
    '--audio', audio, '--model-path', settings.YUQU_ASR_MODEL_DIR, '--aligner-path', settings.YUQU_ASR_ALIGNER_DIR,
    '--manifest', settings.modelManifestPath ?? fileURLToPath(new URL('./model-manifest.json', import.meta.url)), '--ffmpeg-path', settings.YUQU_ASR_FFMPEG,
    '--duration-ms', String(task.durationMs), '--resume-ms', String(task.completedMs), '--work-dir', workDirectory,
    ...(settings.diagnosticsPath ? ['--diagnostics', settings.diagnosticsPath] : []),
    '--pipeline', settings.pipeline ?? task.pipeline ?? 'legacy-v2'],
      { env: inferenceEnvironment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  } catch {
    await workspace.remove();
    throw safeInferenceFailure();
  }
  // Model progress and exceptions can include local paths or transcript text. Do not publish them.
  const stderr = createInferenceDiagnosticCollector();
  child.stderr.on('data', block => stderr.push(block));
  child.stdin.on('error', () => {});
  let ended = false, attached = false, timer, lastEnd = task.completedMs, pending = '', done = false;
  const terminated = new Promise(resolveClose => child.once('close', resolveClose));
  const closed = new Promise((resolveClose, reject) => {
    child.once('error', () => reject(safeInferenceFailure()));
    child.once('close', (code, killed) => {
      ended = true;
      const diagnostic = stderr.finish();
      code === 0 && !killed ? resolveClose() : reject(safeInferenceFailure(diagnostic));
    });
  });
  // Consume a rejected process result even while publication is in flight.
  void closed.catch(() => {});
  let stopping = false;
  const stop = () => {
    if (stopping || ended) return;
    stopping = true;
    if (process.platform === 'win32' && child.pid) {
      execFile(resolve(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:/Windows', 'System32/taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000, env: inferenceEnvironment() },
        () => { if (!ended) child.kill(); });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); }
    }
  };
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  const resetDeadline = () => { clearTimeout(timer); timer = setTimeout(stop, 300000); };
  resetDeadline();
  try {
    if (child.pid) await workspace.attachChild(child.pid);
    if (settings.modelLease && child.pid) {
      await settings.modelLease.attachChild(child.pid);
      attached = true;
    }
    signal.throwIfAborted();
    // Python must stay idle until its PID is covered by the durable model lock.
    // Test subprocesses can omit the lease, but use the same private handshake.
    if (child.pid && !ended) child.stdin.write('start\n');
    for await (const block of child.stdout.setEncoding('utf8')) {
      pending += block;
      if (Buffer.byteLength(pending) > 65536) throw new Error('Inference output limit exceeded');
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline).trim(); pending = pending.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line);
        signal.throwIfAborted();
        if (event.type === 'chunk' && !done) {
          if (event.startMs !== lastEnd) throw new Error('Inference chunks out of order');
          await onChunk(event);
          signal.throwIfAborted();
          lastEnd = event.endMs;
          resetDeadline();
          child.stdin.write('continue\n');
        } else if (event.type === 'done' && !done && event.durationMs === task.durationMs && lastEnd === task.durationMs) {
          done = true;
        } else throw new Error('Unexpected inference event');
      }
    }
    await closed;
    signal.throwIfAborted();
    if (!done || pending.trim()) throw new Error('Incomplete inference output');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
    if (!ended) stop();
    await closed.catch(() => {});
    await terminated;
    try {
      if (attached) await settings.modelLease.detachChild(child.pid);
    } finally {
      await workspace.remove();
    }
  }
}
export async function transcribeOne(pool, settings, stopSignal, execute = runEpisode) {
  const task = await claimTranscript(pool);
  if (!task) return false;
  await processClaimedTask(task, settings, stopSignal, {
    renew: task => renewTranscript(pool, task),
    save: (task, chunk) => saveTranscriptChunk(pool, task, chunk),
    complete: task => completeTranscript(pool, task),
    fail: task => failTranscript(pool, task)
  }, execute);
  return true;
}

export async function processClaimedTask(task, settings, stopSignal, operations, execute = runEpisode) {
  let completed = false;
  const controller = new AbortController();
  const startedAt = Date.now();
  const abort = () => controller.abort();
  stopSignal?.addEventListener('abort', abort, { once: true });
  if (stopSignal?.aborted) abort();
  let renewing = false;
  const heartbeat = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void operations.renew(task).then(ok => { if (!ok) controller.abort(); }, () => controller.abort())
      .finally(() => { renewing = false; });
  }, 15000);
  const limit = setTimeout(abort, 6 * 3600000);
  console.info(JSON.stringify({ event: 'transcription_started', jobId: task.id, resumeMs: task.completedMs }));
  try {
    if (task.completedMs < task.durationMs) {
      await execute(task, settings, controller.signal, async chunk => {
        controller.signal.throwIfAborted();
        if (!await operations.save(task, chunk)) { controller.abort(); throw new Error('Transcript lease lost'); }
        console.info(JSON.stringify({ event: 'transcription_progress', jobId: task.id, completedMs: chunk.endMs, durationMs: task.durationMs }));
      });
    }
    controller.signal.throwIfAborted();
    const ready = await operations.complete(task);
    completed = ready;
    console.info(JSON.stringify({ event: ready ? 'transcription_ready' : 'transcription_superseded', jobId: task.id,
      elapsedMs: Date.now() - startedAt }));
  } catch (error) {
    await operations.fail(task).catch(() => {});
    const diagnostic = safeDiagnosticForError(error, { aborted: controller.signal.aborted });
    operations.diagnostic?.(diagnostic);
    console.warn(JSON.stringify({ event: 'transcription_interrupted', jobId: task.id, aborted: controller.signal.aborted,
      errorCode: diagnostic.code, ...(diagnostic.errorType ? { errorType: diagnostic.errorType } : {}),
      elapsedMs: Date.now() - startedAt }));
  } finally {
    clearInterval(heartbeat); clearTimeout(limit); stopSignal?.removeEventListener('abort', abort);
  }
  return completed;
}
