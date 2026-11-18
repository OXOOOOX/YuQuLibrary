import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

if (!process.env.DATABASE_URL) {
  console.error('请先配置独立开发数据库的 DATABASE_URL；没有执行迁移。');
  process.exit(1);
}
const directory = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
let locked = false;
try {
  await client.connect();
  await client.query('SELECT pg_advisory_lock($1)', [5173801]);
  locked = true;
  // A role named yuqu puts the new application schema first in "$user",public.
  // Keep the ledger location stable before and after 0001 creates that schema.
  await client.query('CREATE TABLE IF NOT EXISTS public.yuqu_schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  const files = (await readdir(directory)).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  for (const name of files) {
    const sql = await readFile(new URL(`../db/migrations/${name}`, import.meta.url), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const { rows } = await client.query('SELECT checksum FROM public.yuqu_schema_migrations WHERE name = $1', [name]);
    if (rows.length) {
      if (rows[0].checksum !== checksum) throw new Error(`已执行迁移发生变化：${name}`);
      console.log(`Already applied: ${name}`);
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO public.yuqu_schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
      await client.query('COMMIT');
      console.log(`Applied: ${name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} catch (error) {
  // Connection error objects can contain private hostnames; print only a code.
  console.error(`迁移未完成（${error.code ?? 'migration-error'}）。请检查本地数据库及迁移文件。`);
  process.exitCode = 1;
} finally {
  if (locked) await client.query('SELECT pg_advisory_unlock($1)', [5173801]).catch(() => {});
  await client.end().catch(() => {});
}
