import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';
import { pool, tx } from './db';
import { config } from './config';
import { checkTicker } from './ticker';
import { verifySealed } from './sealed';

/*
  Queue design
  - One table, claimed with SELECT ... FOR UPDATE SKIP LOCKED, so any number of GPU workers
    can pull jobs safely.
  - Two lanes. Fast lane = prefixes up to FAST_LANE_MAX (default 6). Long lane = longer.
    Each worker says the longest prefix it accepts, so with 2 GPUs you run one worker that
    only takes fast jobs (keeps launches snappy) and one that takes anything.
  - Shortest prefix first, then oldest. A 7-letter job can never block a 5-letter one.
  - User jobs always beat pool jobs (wallet IS NULL = pre-grinding for the pool).
  - Each running job has a lease. If a worker dies, the job goes back to the queue.
*/

function isWallet(s: string): boolean {
  try { new PublicKey(s); return true; } catch { return false; }
}

/** Expected seconds of work ahead of a job in its lane, spread over the GPUs that serve it. */
async function etaSeconds(jobId: number, prefixLen: number): Promise<{ ahead: number; seconds: number }> {
  const lane = prefixLen <= config.fastLaneMax ? 'fast' : 'long';
  const { rows } = await pool.query(
    `SELECT length(prefix) AS len FROM grind_jobs
      WHERE status IN ('queued','running') AND wallet IS NOT NULL AND type = 'coin'
        AND ($2 = 'long' OR length(prefix) <= $3)
        AND (length(prefix) < $4 OR (length(prefix) = $4 AND id < $1))`,
    [jobId, lane, config.fastLaneMax, prefixLen],
  );
  const workAhead = rows.reduce((s, r) => s + Math.pow(58, Number(r.len)), 0);
  const gpus = lane === 'fast' ? config.gpuCount : Math.max(1, config.gpuCount - 1);
  const own = Math.pow(58, prefixLen);
  return { ahead: rows.length, seconds: (workAhead / gpus + own) / config.gpuRate };
}

/**
 * Cancel a queued or running job. A running job's worker learns at its next heartbeat (≤20s)
 * and kills the grinder, so the GPU goes straight back to the queue.
 */
export async function cancelJob(id: number, type: 'coin' | 'wallet', owner: string, why: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE grind_jobs SET status='cancelled', error=$4, lease_until=NULL, finished_at=now()
      WHERE id=$1 AND type=$2 AND wallet=$3 AND status IN ('queued','running')`, [id, type, owner, why]);
  return (r.rowCount ?? 0) > 0;
}

/** Cancel jobs whose page stopped checking in (tab closed, phone locked for a long time). */
export async function cancelAbandonedJobs(): Promise<number> {
  const r = await pool.query(
    `UPDATE grind_jobs SET status='cancelled', lease_until=NULL, finished_at=now(),
            error='Cancelled because the page was closed. Start again to grind a new one.'
      WHERE status IN ('queued','running') AND wallet IS NOT NULL
        AND last_seen < now() - ($1 || ' minutes')::interval`, [String(config.abandonMinutes)]);
  return r.rowCount ?? 0;
}

/** Reserve a pre-ground pool address for this wallet, if one exists. */
async function takeFromPool(prefix: string, wallet: string): Promise<{ id: number; pubkey: string } | null> {
  const { rows } = await pool.query(
    `UPDATE coin_keypairs SET status='reserved', wallet=$2, reserved_until=now() + ($3 || ' minutes')::interval
      WHERE id = (SELECT id FROM coin_keypairs WHERE prefix=$1 AND status='available'
                   AND sealed_secret IS NOT NULL
                   ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, pubkey`,
    [prefix, wallet, String(config.reserveMinutes)],
  );
  return rows[0] || null;
}

export async function releaseExpiredReservations(): Promise<void> {
  // Reserved but never launched: the secret never left the server, so it can go back to the pool.
  // Wallet keypairs live in their own table now and are never reachable from here, so a personal
  // grind can't be recycled into the coin pool no matter what happens to its reservation.
  await pool.query(
    `UPDATE coin_keypairs SET status='available', wallet=NULL, reserved_until=NULL
      WHERE status='reserved' AND reserved_until < now() AND sealed_secret IS NOT NULL`,
  );
  // A coin keypair with no secret left can't sign anything; retire it rather than re-pool it.
  await pool.query(
    `UPDATE coin_keypairs SET status='used', wallet=NULL, reserved_until=NULL, used_at=COALESCE(used_at, now())
      WHERE status='reserved' AND reserved_until < now() AND sealed_secret IS NULL`,
  );
  // Vanity wallets are handled by purgeUnclaimedWalletKeys(), which wipes the secret and
  // marks the row expired in one statement. Doing it here too would race with it.
  // Workers that stopped heart-beating: put their jobs back in the queue.
  await pool.query(
    `UPDATE grind_jobs SET status='queued', worker=NULL, lease_until=NULL
      WHERE status='running' AND lease_until < now()`,
  );
}

/** Queue pool jobs for popular tickers when the pool is low. Runs every minute. */
export async function topUpPool(): Promise<void> {
  for (const t of config.poolTickers) {
    const chk = checkTicker(t);
    if (!chk.ok || chk.lane !== 'fast') continue;
    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*) FROM coin_keypairs WHERE prefix=$1 AND status='available')::int AS avail,
         (SELECT count(*) FROM grind_jobs WHERE prefix=$1 AND wallet IS NULL AND status IN ('queued','running'))::int AS pending`,
      [chk.prefix],
    );
    const missing = config.poolTarget - rows[0].avail - rows[0].pending;
    for (let i = 0; i < missing; i++) {
      await pool.query(`INSERT INTO grind_jobs (prefix) VALUES ($1)`, [chk.prefix]);
    }
  }
}

export function registerGrindRoutes(app: FastifyInstance): void {
  // ---------- public ----------

  app.get('/api/check', async (req) => {
    const q = z.object({ ticker: z.string().max(32) }).parse(req.query);
    const chk = checkTicker(q.ticker);
    if (!chk.ok) return chk;
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM coin_keypairs WHERE prefix=$1 AND status='available'`, [chk.prefix]);
    return { ...chk, inPool: rows[0].n };
  });

  app.post('/api/grind', async (req, reply) => {
    const body = z.object({ ticker: z.string().max(32), wallet: z.string() }).parse(req.body);
    if (!isWallet(body.wallet)) return reply.code(400).send({ error: 'That wallet address is not valid.' });
    const chk = checkTicker(body.ticker);
    if (!chk.ok) return reply.code(400).send({ error: chk.error });

    // Already holding an address for this prefix? Hand it back.
    const held = await pool.query(
      `SELECT id, pubkey FROM coin_keypairs WHERE wallet=$1 AND prefix=$2 AND status='reserved' AND reserved_until > now() LIMIT 1`,
      [body.wallet, chk.prefix],
    );
    if (held.rows[0]) return { status: 'ready', keypairId: held.rows[0].id, pubkey: held.rows[0].pubkey };

    const fromPool = await takeFromPool(chk.prefix, body.wallet);
    if (fromPool) return { status: 'ready', keypairId: fromPool.id, pubkey: fromPool.pubkey, source: 'pool' };

    // Limits: one active job per wallet; long jobs are rationed.
    // One active grind per wallet. Asking again for the same ticker (e.g. after a page reload)
    // picks the running one back up; asking for a different ticker replaces it.
    const active = await pool.query(
      `SELECT id, prefix FROM grind_jobs WHERE wallet=$1 AND type='coin' AND status IN ('queued','running') ORDER BY id DESC LIMIT 1`, [body.wallet]);
    if (active.rows[0]) {
      const old = active.rows[0];
      if (old.prefix === chk.prefix) {
        await pool.query(`UPDATE grind_jobs SET last_seen=now() WHERE id=$1`, [old.id]);
        return { status: 'queued', jobId: Number(old.id), prefix: chk.prefix, resumed: true, ...(await etaSeconds(Number(old.id), chk.length)) };
      }
      await cancelJob(Number(old.id), 'coin', body.wallet, 'Replaced by a newer request.');
    }

    if (chk.lane === 'long') {
      const today = await pool.query(
        `SELECT count(*)::int AS n FROM grind_jobs WHERE wallet=$1 AND length(prefix) > $2 AND created_at > now() - interval '1 day'
           AND NOT (status = 'cancelled' AND started_at IS NULL)`,
        [body.wallet, config.fastLaneMax]);
      if (today.rows[0].n >= config.longJobsPerWalletPerDay) {
        return reply.code(429).send({ error: `Long tickers (over ${config.fastLaneMax} letters) are limited to ${config.longJobsPerWalletPerDay} per wallet per day.` });
      }
      const queued = await pool.query(
        `SELECT count(*)::int AS n FROM grind_jobs WHERE length(prefix) > $1 AND wallet IS NOT NULL AND type = 'coin' AND status IN ('queued','running')`,
        [config.fastLaneMax]);
      if (queued.rows[0].n >= config.maxQueuedLong) {
        return reply.code(503).send({ error: 'The long-ticker queue is full right now. Try a shorter ticker or come back later.' });
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO grind_jobs (prefix, wallet) VALUES ($1, $2) RETURNING id`, [chk.prefix, body.wallet]);
    const eta = await etaSeconds(rows[0].id, chk.length);
    return { status: 'queued', jobId: rows[0].id, prefix: chk.prefix, ...eta };
  });

  app.get('/api/grind/:id', async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const { rows } = await pool.query(
      `SELECT j.id, j.prefix, j.status, j.error, j.keypair_id, k.pubkey
         FROM grind_jobs j LEFT JOIN coin_keypairs k ON k.id = j.keypair_id WHERE j.id=$1 AND j.wallet IS NOT NULL`, [id]);
    const j = rows[0];
    if (!j) return reply.code(404).send({ error: 'No such job.' });
    if (j.status === 'done') return { status: 'ready', keypairId: j.keypair_id, pubkey: j.pubkey };
    if (j.status === 'failed') return { status: 'failed', error: j.error };
    if (j.status === 'cancelled') return { status: 'cancelled', error: j.error || 'This grind was cancelled.' };
    // The page is still waiting: keep the job alive.
    await pool.query(`UPDATE grind_jobs SET last_seen=now() WHERE id=$1`, [j.id]);
    const eta = await etaSeconds(j.id, j.prefix.length);
    return { status: j.status, prefix: j.prefix, ...eta };
  });

  // Cancel your own coin-address grind. Only the wallet that asked for it can.
  app.post('/api/grind/:id/cancel', async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const b = z.object({ wallet: z.string() }).parse(req.body);
    const r = await cancelJob(id, 'coin', b.wallet, 'Cancelled.');
    if (!r) return reply.code(404).send({ error: 'No active grind to cancel.' });
    return { ok: true };
  });

  // ---------- workers (GPU boxes) ----------

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/worker/')) return;
    if (req.headers.authorization !== `Bearer ${config.workerToken}`) return reply.code(401).send({ error: 'unauthorized' });
  });

  app.post('/worker/claim', async (req) => {
    const b = z.object({
      worker: z.string().max(64),
      maxLen: z.number().int().min(1).max(12),
      // Which queue this worker serves. 'any' (the default) takes whatever is next;
      // set it to dedicate a box to coin mints or to vanity wallets.
      lane: z.enum(['any', 'coin', 'wallet']).default('any'),
    }).parse(req.body);
    const job = await tx(async (c) => {
      // Claims are serialized (they take a millisecond), so the long-job cap below holds even
      // when every GPU asks for work at the same instant.
      await c.query(`SELECT pg_advisory_xact_lock(727274)`);
      // Order: real requests before pool pre-grinds, then shortest first, then oldest.
      // A long prefix is only handed out while fewer than LONG_GPUS_PER_LANE GPUs are already
      // on long work in its lane, so short requests always have free GPUs.
      const { rows } = await c.query(
        `SELECT id, prefix FROM grind_jobs g
          WHERE status='queued' AND length(prefix) <= $1
            AND ($2 = 'any' OR type = $2)
            AND (length(prefix) <= $3 OR
                 (SELECT count(*) FROM grind_jobs r
                   WHERE r.status='running' AND r.type = g.type AND length(r.prefix) > $3) < $4)
          ORDER BY (wallet IS NULL), length(prefix), id
          LIMIT 1 FOR UPDATE SKIP LOCKED`, [b.maxLen, b.lane, config.fastLaneMax, config.longGpusPerLane]);
      if (!rows[0]) return null;
      await c.query(
        `UPDATE grind_jobs SET status='running', worker=$2, started_at=now(),
           lease_until=now() + ($3 || ' seconds')::interval WHERE id=$1`,
        [rows[0].id, b.worker, String(config.jobLeaseSeconds)]);
      return rows[0];
    });
    return { job };
  });

  app.post('/worker/heartbeat', async (req) => {
    const b = z.object({ jobId: z.coerce.number(), worker: z.string() }).parse(req.body);
    const r = await pool.query(
      `UPDATE grind_jobs SET lease_until=now() + ($3 || ' seconds')::interval
        WHERE id=$1 AND worker=$2 AND status='running'`, [b.jobId, b.worker, String(config.jobLeaseSeconds)]);
    return { keepGoing: r.rowCount === 1 };
  });

  app.post('/worker/complete', async (req, reply) => {
    const b = z.object({
      jobId: z.coerce.number(), worker: z.string(), pubkey: z.string(), sealedSecret: z.string(), attempts: z.number().optional(),
    }).parse(req.body);
    const { rows } = await pool.query(`SELECT prefix, wallet, type, status, worker FROM grind_jobs WHERE id=$1`, [b.jobId]);
    const job = rows[0];
    if (!job || job.status !== 'running' || job.worker !== b.worker) return reply.code(409).send({ error: 'job not held by this worker' });
    try {
      verifySealed(b.sealedSecret, b.pubkey, job.prefix);
    } catch (e) {
      await pool.query(`UPDATE grind_jobs SET status='queued', worker=NULL, lease_until=NULL, error=$2 WHERE id=$1`, [b.jobId, String(e)]);
      return reply.code(400).send({ error: String(e) });
    }
    await tx(async (c) => {
      // The two kinds of keypair have different lifecycles, so they go to different tables.
      // grind_jobs.type is what says which; grind_jobs.keypair_id then points into that table.
      const k = job.type === 'wallet'
        ? await c.query(
            `INSERT INTO wallet_keypairs (prefix, pubkey, sealed_secret, status, session_token, expires_at)
             VALUES ($1, $2, $3, 'pending', $4, now() + ($5 || ' minutes')::interval)
             RETURNING id`,
            [job.prefix, b.pubkey, b.sealedSecret, job.wallet, String(config.walletKeyTtlMinutes)])
        : await c.query(
            `INSERT INTO coin_keypairs (prefix, pubkey, sealed_secret, status, wallet, reserved_until)
             VALUES ($1, $2, $3, $4, $5,
                     CASE WHEN $5::text IS NULL THEN NULL ELSE now() + ($6 || ' minutes')::interval END)
             RETURNING id`,
            [
              job.prefix, b.pubkey, b.sealedSecret,
              job.wallet ? 'reserved' : 'available', job.wallet,
              String(config.reserveMinutes),
            ]);
      await c.query(
        `UPDATE grind_jobs SET status='done', keypair_id=$2, attempts=$3, finished_at=now(), lease_until=NULL WHERE id=$1`,
        [b.jobId, k.rows[0].id, b.attempts ?? null]);
    });
    // Deliberately no feed event here: announcing a ground ticker before launch would tip off snipers.
    return { ok: true };
  });

  app.post('/worker/fail', async (req) => {
    const b = z.object({ jobId: z.coerce.number(), worker: z.string(), error: z.string().max(2000) }).parse(req.body);
    // Retry a couple of times (a GPU hiccup), then give up so a broken job can't burn GPU time forever.
    await pool.query(
      `UPDATE grind_jobs SET fails = fails + 1, worker=NULL, lease_until=NULL, error=$3,
              status = CASE WHEN fails + 1 >= 3 THEN 'failed' ELSE 'queued' END
        WHERE id=$1 AND worker=$2`,
      [b.jobId, b.worker, b.error]);
    return { ok: true };
  });
}
