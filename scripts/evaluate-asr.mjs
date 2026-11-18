/** Controlled public-sample diagnostics. Never points at a business database. */
import { loadEnvFile } from 'node:process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, relative, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { inferenceSettings, runEpisode } from '../workers/transcription/process.mjs';
import { acquireModelLock } from '../workers/transcription/lock.mjs';
import { servicePaths, serviceStatus, readJson } from '../workers/transcription/service-runtime.mjs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i]?.startsWith('--') || !process.argv[i + 1]) throw new Error('Expected named arguments.');
  args.set(process.argv[i].slice(2), process.argv[i + 1]);
}
for (const name of ['samples', 'output']) if (!args.has(name) || !isAbsolute(args.get(name))) throw new Error(`--${name} must be absolute.`);
const repository = fileURLToPath(new URL('../', import.meta.url));
loadEnvFile(join(repository, '.env'));
const source = args.get('samples'), output = args.get('output');
const manifest = JSON.parse(await readFile(source, 'utf8'));
const samples = [...manifest.samples];
if (args.has('concatenation')) samples.push(JSON.parse(await readFile(args.get('concatenation'), 'utf8')));
const storage = args.get('storage') ?? dirname(source);
process.env.MEDIA_STORAGE_DIR = storage;
const settings = inferenceSettings(), primaryModel = settings.YUQU_ASR_MODEL_DIR;
if (args.has('model')) settings.YUQU_ASR_MODEL_DIR = args.get('model');
if (args.has('manifest')) settings.modelManifestPath = args.get('manifest');
settings.pipeline = args.get('pipeline') ?? 'legacy-v2';
const paths = servicePaths();
async function requireMaintenance() {
  const [status, enabled] = await Promise.all([serviceStatus(paths), readJson(paths.enabled)]);
  if (status.running || enabled?.enabled !== false) throw new Error('Stop the idle managed service before evaluation.');
}
await requireMaintenance();
await mkdir(output, { recursive: false });
const releases = [];
const results = [];
try {
  for (const directory of new Set([primaryModel, settings.YUQU_ASR_MODEL_DIR])) releases.push(await acquireModelLock(directory));
  settings.modelLease = {
    attachChild: async pid => { for (const lease of releases) await lease.attachChild(pid); },
    detachChild: async pid => { for (const lease of releases) await lease.detachChild(pid); }
  };
  for (const sample of samples) {
    await requireMaintenance();
    const old = JSON.parse(await readFile(join(dirname(source), 'execution-results.json'), 'utf8').catch(() => '{"results":[]}'));
    const prior = old.results.find(item => item.sampleKey === sample.sampleKey);
    const durationMs = sample.durationMs ?? (prior?.ok ? prior.durationMs : null);
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > 14400000 || !sample.sha256 || !isAbsolute(sample.audioPath)) throw new Error('Unverified sample metadata.');
    const completedMs = Number(args.get('resume-ms') ?? 0);
    if (!Number.isSafeInteger(completedMs) || completedMs < 0 || completedMs >= durationMs || completedMs % 30000) throw new Error('Invalid evaluation resume checkpoint.');
    const task = { id: randomUUID(), storageKey: relative(storage, sample.audioPath), sha256: sample.sha256,
      durationMs, completedMs, model: null };
    settings.diagnosticsPath = join(output, `${sample.sampleKey}.diagnostics.jsonl`);
    const chunks = [], controller = new AbortController();
    const poll = setInterval(() => { void requireMaintenance().catch(() => controller.abort()); }, 1000);
    const began = performance.now();
    let error;
    try { await runEpisode(task, settings, controller.signal, async chunk => { chunks.push(chunk); }); }
    catch (failure) { error = { code: failure.code ?? 'EVALUATION_FAILED', message: failure.message }; }
    finally { clearInterval(poll); }
    const chunksPath = join(output, `${sample.sampleKey}.json`);
    await writeFile(chunksPath, JSON.stringify(chunks, null, 2));
    const result = { sampleKey: sample.sampleKey, ok: !error, durationMs, resumeMs: completedMs,
      elapsedSeconds: (performance.now() - began) / 1000, chunksPath, diagnosticsPath: settings.diagnosticsPath,
      ...(error ? { error } : {}) };
    results.push(result);
    await writeFile(join(output, 'execution-results.json'), JSON.stringify({ pipeline: settings.pipeline, source, results }, null, 2));
    console.log(JSON.stringify({ sample: sample.sampleKey, ok: result.ok, seconds: result.elapsedSeconds }));
    if (error) throw new Error('Evaluation failed; saved diagnostics.');
  }
} finally {
  for (const release of releases.reverse()) await release();
}
