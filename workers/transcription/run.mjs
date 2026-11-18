import pg from 'pg';
import { inferenceSettings, transcribeOne } from './process.mjs';
import { TRANSCRIPTION_WORKER_LOCK, acquireModelLock } from './lock.mjs';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
process.on('SIGTERM', () => controller.abort());
let lock, releaseModel;
try {
  if (!process.env.DATABASE_URL) throw new Error('Configuration required');
  const settings = inferenceSettings();
  releaseModel = await acquireModelLock(settings.YUQU_ASR_MODEL_DIR);
  settings.modelLease = releaseModel;
  // A single local GPU worker per database; do not load multiple model copies accidentally.
  lock = await pool.connect();
  lock.on('error', () => controller.abort());
  if (!(await lock.query('SELECT pg_try_advisory_lock($1) AS acquired', [TRANSCRIPTION_WORKER_LOCK])).rows[0].acquired) throw new Error('Worker already active');
  console.info('YuQu transcription worker ready');
  do {
    const worked = await transcribeOne(pool, settings, controller.signal);
    if (process.argv.includes('--once')) break;
    if (!worked && !controller.signal.aborted) await new Promise(resolve => setTimeout(resolve, 2000));
  } while (!controller.signal.aborted);
} catch { console.error('YuQu transcription worker stopped; check local model, media and database settings.'); process.exitCode = 1; }
finally {
  if (lock) { await lock.query('SELECT pg_advisory_unlock($1)', [TRANSCRIPTION_WORKER_LOCK]).catch(() => {}); lock.release(); }
  await pool.end();
  await releaseModel?.();
}
