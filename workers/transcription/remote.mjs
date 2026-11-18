import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inferenceSettings, processClaimedTask, runEpisode } from './process.mjs';
import { acquireModelLock } from './lock.mjs';
import { remoteSettings, createRemoteClient } from './remote-client.mjs';

const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
process.on('SIGTERM', () => controller.abort());
process.on('message', message => { if (message?.type === 'stop') controller.abort(); });
process.on('disconnect', () => controller.abort());
let state = { phase: 'starting', jobId: null, completedMs: 0, durationMs: 0 };
const report = () => { if (process.connected) process.send({ type: 'status', ...state }, () => {}); };
const update = changes => { state = { ...state, ...changes }; report(); };
const statusTimer = setInterval(report, 5000);
const wait = ms => delay(ms, undefined, { signal: controller.signal }).catch(() => {});
let releaseModel;
try {
  const settings = inferenceSettings(), client = createRemoteClient(remoteSettings(process.env));
  releaseModel = await acquireModelLock(settings.YUQU_ASR_MODEL_DIR);
  settings.modelLease = releaseModel;
  console.info('YuQu production transcription worker started');
  while (!controller.signal.aborted) {
    update({ phase: 'idle', jobId: null, completedMs: 0, durationMs: 0 });
    let job;
    try { job = await client.claim(controller.signal); }
    catch {
      if (controller.signal.aborted) break;
      console.warn('YuQu transcription connection unavailable; waiting for the lease window before retrying.');
      update({ phase: 'waiting' });
      if (process.argv.includes('--once')) { process.exitCode = 1; break; }
      await wait(95000); continue;
    }
    if (!job) {
      if (process.argv.includes('--once')) break;
      await wait(5000); continue;
    }
    const task = { ...job, storageKey: `${job.id}.media` };
    update({ phase: 'working', jobId: job.id, completedMs: job.completedMs, durationMs: job.durationMs, lastErrorCode: null });
    const operations = { ...client, diagnostic: diagnostic => update({ lastErrorCode: diagnostic.code }), save: async (item, chunk) => {
      const saved = await client.save(item, chunk);
      if (saved) update({ completedMs: chunk.endMs });
      return saved;
    } };
    const completed = await processClaimedTask(task, settings, controller.signal, operations, async (item, paths, signal, onChunk) => {
      try {
        await client.download(item, paths.MEDIA_STORAGE_DIR, signal);
        await runEpisode(item, paths, signal, onChunk);
      } finally {
        // This name is derived solely from a validated task UUID in our private cache.
        await unlink(join(paths.MEDIA_STORAGE_DIR, item.storageKey)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    });
    if (process.argv.includes('--once')) { if (!completed) process.exitCode = 1; break; }
  }
} catch { console.error('YuQu production transcription worker stopped; check configuration or model ownership.'); process.exitCode = 1; }
finally {
  clearInterval(statusTimer); update({ phase: 'stopping' });
  await releaseModel?.();
  if (process.connected) process.disconnect();
}
