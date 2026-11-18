import type { Pool, PoolClient } from 'pg';

export async function transaction<T>(pool: Pool, work: (db: PoolClient) => Promise<T>, readOnly = false): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    await db.query("SET LOCAL statement_timeout = '5s'");
    const value = await work(db);
    await db.query('COMMIT');
    return value;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { db.release(); }
}
