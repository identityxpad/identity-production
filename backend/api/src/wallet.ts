import { FastifyInstance } from 'fastify';
import { cancelJob } from './grind';
import { burnEnabled, burnSatisfied } from './burn';
import { z } from 'zod';
import { Connection, PublicKey } from '@solana/web3.js';
import { pool, tx } from './db';
import { config } from './config';
import { openSealed } from './sealed';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

const connection = new Connection(config.rpcUrl, 'confirmed');

/** SPL Token program ID */
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

/**
 * Check how many tokens of `mint` the `owner` holds.
 * Uses getTokenAccountsByOwner RPC — no extra dependency needed.
 * Returns the raw token amount (before decimals).
 */
async function getTokenBalance(owner: string, mint: string): Promise<bigint> {
  const ownerPk = new PublicKey(owner);
  const mintPk = new PublicKey(mint);
  const { value } = await connection.getTokenAccountsByOwner(ownerPk, { mint: mintPk });
  let total = 0n;
  for (const acc of value) {
    // SPL token account data layout: first 32 bytes = mint, next 32 = owner, next 8 = amount (LE u64)
    const data = acc.account.data;
    if (data.length >= 72) {
      const amt = data.readBigUInt64LE(64);
      total += amt;
    }
  }
  return total;
}

/*
  Vanity wallet grinding.

  Uses the same grind_jobs queue and GPU workers as coin grinding.
  Difference: when the job finishes, we unseal the secret key and hand the full
  keypair to the user (they need the private key). The sealed_secret is deleted
  from the keypairs table after retrieval so it doesn't linger.

  Jobs are identified by a session token (random hex) rather than a wallet address,
  since users don't have a wallet yet — they're generating one.
*/

const LOWER = '123456789abcdefghijkmnopqrstuvwxyz';

function validatePrefix(raw: string): { ok: true; prefix: string } | { ok: false; error: string } {
  const prefix = raw.toLowerCase().trim();
  if (prefix.length < 1) return { ok: false, error: 'Prefix must be at least 1 character.' };
  if (prefix.length > config.maxTicker) return { ok: false, error: `Prefix too long (max ${config.maxTicker}).` };
  for (const ch of prefix) {
    if (!LOWER.includes(ch)) return { ok: false, error: `Character "${ch}" cannot appear in a Solana address (base58).` };
  }
  return { ok: true, prefix };
}

/** ETA for a wallet job based on queue position */
async function walletEta(jobId: number, prefixLen: number): Promise<{ ahead: number; seconds: number }> {
  const lane = prefixLen <= config.fastLaneMax ? 'fast' : 'long';
  const { rows } = await pool.query(
    `SELECT length(prefix) AS len FROM grind_jobs
      WHERE status IN ('queued','running')
        AND type = 'wallet'
        AND ($2 = 'long' OR length(prefix) <= $3)
        AND (length(prefix) < $4 OR (length(prefix) = $4 AND id < $1))`,
    [jobId, lane, config.fastLaneMax, prefixLen],
  );
  const workAhead = rows.reduce((s: number, r: any) => s + Math.pow(58, Number(r.len)), 0);
  const gpus = lane === 'fast' ? config.gpuCount : Math.max(1, config.gpuCount - 1);
  const own = Math.pow(58, prefixLen);
  return { ahead: rows.length, seconds: (workAhead / gpus + own) / config.gpuRate };
}

/** Wipe sealed secrets on vanity wallets that were ground but never claimed in time. */
export async function purgeUnclaimedWalletKeys(): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE wallet_keypairs SET sealed_secret = NULL, status = 'expired'
       WHERE sealed_secret IS NOT NULL AND expires_at < now()`,
  );
  return rowCount ?? 0;
}

export function registerWalletRoutes(app: FastifyInstance): void {

  /** Check if the token gate is enabled and return config for the frontend */
  app.get('/api/wallet/gate', async () => {
    return {
      enabled: !!config.identityMint,
      mint: config.identityMint || null,
      amount: config.tokenGateAmount,
      burn: burnEnabled() ? config.burnAmount : 0, // $IDENTITY burned to reveal a key (0 = free)
    };
  });

  /** Queue a vanity wallet grind job */
  app.post('/api/wallet/grind', async (req, reply) => {
    const body = z.object({
      prefix: z.string().max(32),
      sessionToken: z.string().min(16).max(128),
      walletAddress: z.string().max(64).optional(),
    }).parse(req.body);

    const chk = validatePrefix(body.prefix);
    if (!chk.ok) return reply.code(400).send({ error: chk.error });

    // --- Token gate: require 100k Identity coins ---
    if (config.identityMint) {
      if (!body.walletAddress) {
        return reply.code(400).send({ error: 'Connect your wallet to verify you hold Identity tokens.' });
      }
      try { new PublicKey(body.walletAddress); } catch {
        return reply.code(400).send({ error: 'Invalid wallet address.' });
      }
      try {
        const balance = await getTokenBalance(body.walletAddress, config.identityMint);
        // SPL tokens typically have 6 or 9 decimals. We compare raw amount vs threshold * 10^decimals.
        // For simplicity, fetch the mint's decimals from chain:
        const mintInfo = await connection.getParsedAccountInfo(new PublicKey(config.identityMint));
        const decimals = (mintInfo.value?.data as any)?.parsed?.info?.decimals ?? 6;
        const threshold = BigInt(config.tokenGateAmount) * (10n ** BigInt(decimals));
        if (balance < threshold) {
          const held = Number(balance) / (10 ** decimals);
          return reply.code(403).send({
            error: `You need at least ${config.tokenGateAmount.toLocaleString()} Identity tokens to generate a vanity wallet. You hold ${Math.floor(held).toLocaleString()}.`,
          });
        }
      } catch (e: any) {
        // If RPC is down, don't block the feature — log and allow
        console.error('[wallet] token gate check failed, allowing through:', e?.message || e);
      }
    }

    // Rate limit: max 2 active wallet jobs per session token
    const active = await pool.query(
      `SELECT id FROM grind_jobs WHERE wallet=$1 AND type='wallet' AND status IN ('queued','running') LIMIT 2`,
      [body.sessionToken],
    );
    if (active.rows.length >= 2) {
      return reply.code(429).send({ error: 'You already have wallet addresses being ground. Wait for them to finish.' });
    }

    // Long prefix rate limit for wallets too
    if (chk.prefix.length > config.fastLaneMax) {
      const today = await pool.query(
        `SELECT count(*)::int AS n FROM grind_jobs WHERE wallet=$1 AND type='wallet' AND length(prefix) > $2 AND created_at > now() - interval '1 day'
           AND NOT (status = 'cancelled' AND started_at IS NULL)`,
        [body.sessionToken, config.fastLaneMax],
      );
      if (today.rows[0].n >= config.longJobsPerWalletPerDay) {
        return reply.code(429).send({ error: `Long prefixes (over ${config.fastLaneMax} letters) are limited to ${config.longJobsPerWalletPerDay} per day.` });
      }
      // Site-wide cap, so a crowd of long requests can't build a queue that takes days.
      const queued = await pool.query(
        `SELECT count(*)::int AS n FROM grind_jobs WHERE type='wallet' AND length(prefix) > $1 AND status IN ('queued','running')`,
        [config.fastLaneMax]);
      if (queued.rows[0].n >= config.maxQueuedLongWallet) {
        return reply.code(503).send({ error: 'The queue for long prefixes is full right now. Try a shorter prefix or come back later.' });
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO grind_jobs (prefix, wallet, type) VALUES ($1, $2, 'wallet') RETURNING id`,
      [chk.prefix, body.sessionToken],
    );
    const eta = await walletEta(rows[0].id, chk.prefix.length);
    return { status: 'queued', jobId: rows[0].id, prefix: chk.prefix, ...eta };
  });

  /** Poll wallet grind job status */
  app.get('/api/wallet/grind/:id', async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const q = z.object({ sessionToken: z.string().min(16).max(128) }).parse(req.query);

    const { rows } = await pool.query(
      `SELECT j.id, j.prefix, j.status, j.error, j.keypair_id, j.wallet, k.pubkey
         FROM grind_jobs j LEFT JOIN wallet_keypairs k ON k.id = j.keypair_id
         WHERE j.id=$1 AND j.type='wallet'`, [id],
    );
    const j = rows[0];
    if (!j) return reply.code(404).send({ error: 'No such job.' });
    if (j.wallet !== q.sessionToken) return reply.code(403).send({ error: 'Not your job.' });

    if (j.status === 'done') return { status: 'ready', keypairId: j.keypair_id, pubkey: j.pubkey };
    if (j.status === 'failed') return { status: 'failed', error: j.error };
    if (j.status === 'cancelled') return { status: 'cancelled', error: j.error || 'This grind was cancelled.' };
    await pool.query(`UPDATE grind_jobs SET last_seen=now() WHERE id=$1`, [j.id]); // the page is still waiting
    const eta = await walletEta(j.id, j.prefix.length);
    return { status: j.status, prefix: j.prefix, ...eta };
  });

  /** Stop your own wallet grind. */
  app.post('/api/wallet/grind/:id/cancel', async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const b = z.object({ sessionToken: z.string().min(16).max(128) }).parse(req.body);
    const ok = await cancelJob(id, 'wallet', b.sessionToken, 'Stopped.');
    if (!ok) return reply.code(404).send({ error: 'No active grind to stop.' });
    return { ok: true };
  });

  /** Download the keypair once grinding is complete */
  app.get('/api/wallet/grind/:id/keypair', async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const q = z.object({ sessionToken: z.string().min(16).max(128) }).parse(req.query);

    const { rows } = await pool.query(
      `SELECT j.id, j.wallet, j.keypair_id, j.status, k.pubkey, k.sealed_secret
         FROM grind_jobs j JOIN wallet_keypairs k ON k.id = j.keypair_id
         WHERE j.id=$1 AND j.type='wallet'`, [id],
    );
    const j = rows[0];
    if (!j) return reply.code(404).send({ error: 'No such job or not yet complete.' });
    if (j.wallet !== q.sessionToken) return reply.code(403).send({ error: 'Not your job.' });
    if (j.status !== 'done') return reply.code(400).send({ error: 'Job not done yet.' });
    if (!(await burnSatisfied(j.keypair_id))) {
      return reply.code(402).send({ error: `Burn ${config.burnAmount.toLocaleString('en-US')} $IDENTITY to reveal this key.`, burnRequired: config.burnAmount });
    }
    if (!j.sealed_secret) {
      return reply.code(410).send({
        error: 'This key was already delivered, or it expired. Either way it is gone from our servers. Generate a new one.',
      });
    }

    // Unseal the secret key
    const secret = openSealed(j.sealed_secret);
    try {
      // Verify it matches the pubkey
      const derived = nacl.sign.keyPair.fromSecretKey(secret);
      const pubkey = bs58.encode(derived.publicKey);
      if (pubkey !== j.pubkey) throw new Error('Key mismatch');

      // Return as JSON array (Solana CLI compatible) + base58
      const secretArray = Array.from(secret);
      const secretB58 = bs58.encode(secret);

      // Wipe the sealed secret in the same breath as handing it over. From here the only
      // copy in existence is in the user's browser; the server cannot produce it again,
      // and a database dump from this moment on contains nothing to decrypt.
      await pool.query(
        `UPDATE wallet_keypairs SET sealed_secret = NULL, status = 'delivered', delivered_at = now()
          WHERE id = $1`,
        [j.keypair_id],
      );

      return {
        pubkey: j.pubkey,
        secretKey: secretArray,    // Solana CLI format: [u8; 64]
        secretKeyB58: secretB58,   // For wallet imports
      };
    } finally {
      secret.fill(0);
    }
  });
}
