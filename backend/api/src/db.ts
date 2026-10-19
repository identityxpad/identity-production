import { Pool, PoolClient, types } from 'pg';

// Postgres BIGINT/BIGSERIAL (type 20) comes back as a string by default. Our ids are far below
// 2^53, so parse them as numbers; otherwise job ids round-trip as "3" and fail validation.
types.setTypeParser(20, (v) => Number(v));
import { config } from './config';
import { SCHEMA_SQL } from './schema';

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: Number(process.env.DB_POOL_MAX) || 25,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export async function migrate(): Promise<void> {
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is not set. Add it in Railway → service → Variables.');
  }
  // Mask credentials before logging the target.
  const target = config.databaseUrl.replace(/\/\/[^@]*@/, '//***@');
  console.log(`[migrate] connecting to ${target}`);

  // Railway's private network can take a few seconds to come up after the
  // container starts, so a DNS miss at boot is expected rather than fatal.
  const MAX_ATTEMPTS = 10;
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query(SCHEMA_SQL);
      break;
    } catch (e: any) {
      const code = e?.code;
      const retryable = code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT';
      if (!retryable || attempt >= MAX_ATTEMPTS) {
        console.error(`[migrate] FAILED after ${attempt} attempt(s):`, e?.message || e);
        if (code === 'ENOTFOUND') {
          console.error(
            '[migrate] The database hostname does not resolve. Check that DATABASE_URL uses a\n' +
              '          Railway reference such as ${{Postgres.DATABASE_URL}}, and that the API and\n' +
              '          Postgres services live in the same project.',
          );
        }
        throw e;
      }
      const waitMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
      console.warn(`[migrate] ${code} — retrying in ${waitMs}ms (attempt ${attempt}/${MAX_ATTEMPTS})`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = 'public'`,
  );
  console.log(`[migrate] schema up to date — ${rows[0].count} tables in public schema`);
}

export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
