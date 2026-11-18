import pg from 'pg';
import { ingestOne } from '../../packages/domain/src/ingestion.ts';
import { cleanupOne } from '../../packages/domain/src/storage-cleanup.ts';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
try {
  if (!process.env.DATABASE_URL || !process.env.MEDIA_STORAGE_DIR) throw new Error('Configuration required');
  console.log('YuQu ingestion worker ready');
  do {
    const cleaned = await cleanupOne(pool, process.env.MEDIA_STORAGE_DIR);
    const worked = await ingestOne(pool);
    if (process.argv.includes('--once')) break;
    if (!worked && !cleaned) await new Promise(resolve => setTimeout(resolve, 2000));
  } while (!stopping);
} catch { console.error('YuQu ingestion worker stopped; check database and storage configuration.'); process.exitCode = 1; }
finally { await pool.end(); }
