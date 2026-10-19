import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from './db';
import { getSolUsd } from './watch';
import { curveState } from './curve';

/** Headline numbers for the coin page, all from trades we have recorded. */
async function coinStats(mint: string) {
  const { rows } = await pool.query(
    `SELECT count(*) FILTER (WHERE type IN ('buy','sell','dev'))::int               AS trades,
            count(*) FILTER (WHERE type IN ('buy','dev'))::int                      AS buys,
            count(*) FILTER (WHERE type = 'sell')::int                              AS sells,
            count(DISTINCT wallet) FILTER (WHERE type IN ('buy','sell','dev'))::int AS traders,
            coalesce(sum(sol) FILTER (WHERE type IN ('buy','sell','dev')), 0)::float AS "volumeSol",
            coalesce(sum(sol) FILTER (WHERE type IN ('buy','sell','dev')
                                     AND created_at > now() - interval '24 hours'), 0)::float AS "volume24hSol",
            max(market_cap_sol)::float                                             AS "athSol",
            (array_agg(market_cap_sol ORDER BY id) FILTER (WHERE market_cap_sol IS NOT NULL))[1]::float AS "firstSol",
            coalesce(sum(sol) FILTER (WHERE type = 'dev'), 0)::float               AS "devBuySol"
       FROM events WHERE mint=$1`, [mint]);
  return rows[0];
}

export function registerCoinRoutes(app: FastifyInstance): void {
  app.get('/api/coins', async (req) => {
    const q = z.object({
      view: z.enum(['all', 'curve', 'grad']).default('all'),
      sort: z.enum(['new', 'mc', 'len']).default('new'),
      q: z.string().max(64).optional(),
      limit: z.coerce.number().min(1).max(100).default(48),
      offset: z.coerce.number().min(0).default(0),
    }).parse(req.query);

    const where: string[] = [];
    const args: any[] = [];
    if (q.view === 'curve') where.push('graduated = false');
    if (q.view === 'grad') where.push('graduated = true');
    if (q.q) { args.push(`%${q.q.toLowerCase()}%`); where.push(`(lower(name) LIKE $${args.length} OR lower(symbol) LIKE $${args.length} OR lower(mint) LIKE $${args.length})`); }
    const order = q.sort === 'mc' ? 'market_cap_sol DESC' : q.sort === 'len' ? 'length(prefix) DESC, launched_at DESC' : 'launched_at DESC';
    args.push(q.limit, q.offset);

    const { rows } = await pool.query(
      `SELECT mint AS address, name, symbol, prefix AS ticker, creator, image_uri AS "imageUri", banner_uri AS "bannerUri",
              description, website, twitter, telegram, featured, source,
              market_cap_sol::float AS "marketCapSol", graduated, launched_at AS "launchedAt"
         FROM coins ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY featured DESC, ${order} LIMIT $${args.length - 1} OFFSET $${args.length}`, args);
    return { coins: rows, solUsd: getSolUsd() };
  });

  // ---------- coin page ----------

  // Every open coin page asks for this every few seconds. With hundreds of viewers on one coin
  // that is hundreds of identical queries, so answer from a 2-second cache.
  const detailCache = new Map<string, { at: number; v: any }>();
  app.get('/api/coins/:mint', async (req, reply) => {
    const { mint } = z.object({ mint: z.string().max(64) }).parse(req.params);
    const hit = detailCache.get(mint);
    if (hit && Date.now() - hit.at < 2_000) return hit.v;
    if (detailCache.size > 2000) detailCache.clear();
    const { rows } = await pool.query(
      `SELECT mint AS address, name, symbol, prefix AS ticker, creator, image_uri AS "imageUri", banner_uri AS "bannerUri",
              description, website, twitter, telegram, featured, source,
              market_cap_sol::float AS "marketCapSol", graduated, launched_at AS "launchedAt"
         FROM coins WHERE mint=$1`, [mint]);
    if (!rows[0]) return reply.code(404).send({ error: 'Not an Identity coin.' });
    const coin = rows[0];
    const [stats, curve] = await Promise.all([coinStats(mint), coin.graduated ? null : curveState(mint)]);
    // The bonding curve is the live truth for price; trades are only snapshots of it, and we
    // can miss some. Use it while the coin is on the curve, and keep the DB copy in step.
    if (curve && !curve.complete) {
      if (Math.abs(curve.marketCapSol - (coin.marketCapSol || 0)) > 1e-6) {
        coin.marketCapSol = curve.marketCapSol;
        pool.query(`UPDATE coins SET market_cap_sol=$2 WHERE mint=$1`, [mint, curve.marketCapSol]).catch(() => {});
      }
      if (!stats.athSol || curve.marketCapSol > stats.athSol) stats.athSol = curve.marketCapSol;
      if (!stats.firstSol) stats.firstSol = curve.marketCapSol;
    }
    const out = { coin, stats, solUsd: getSolUsd(), priceSource: curve && !curve.complete ? 'curve' : 'trades' };
    detailCache.set(mint, { at: Date.now(), v: out });
    return out;
  });

  // The trade tape: newest first, paged by event id.
  app.get('/api/coins/:mint/trades', async (req) => {
    const { mint } = z.object({ mint: z.string().max(64) }).parse(req.params);
    const q = z.object({
      before: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(60),
    }).parse(req.query);
    const { rows } = await pool.query(
      `SELECT id, type, wallet, sol::float, token_amount::float AS "tokenAmount",
              market_cap_sol::float AS "marketCapSol", signature, created_at AS at
         FROM events
        WHERE mint=$1 AND type IN ('launch','dev','buy','sell','grad')
          AND ($2::bigint IS NULL OR id < $2)
        ORDER BY id DESC LIMIT $3`, [mint, q.before ?? null, q.limit]);
    return { trades: rows };
  });

  // Market-cap candles. Bucketed in SQL so a busy coin doesn't ship every trade to the browser.
  app.get('/api/coins/:mint/chart', async (req) => {
    const { mint } = z.object({ mint: z.string().max(64) }).parse(req.params);
    const q = z.object({ interval: z.enum(['1s', '15s', '1m', '5m', '15m', '1h']).default('1m') }).parse(req.query);
    const secs = { '1s': 1, '15s': 15, '1m': 60, '5m': 300, '15m': 900, '1h': 3600 }[q.interval];
    const { rows } = await pool.query(
      `SELECT (floor(extract(epoch FROM created_at) / $2) * $2)::bigint AS t,
              ((array_agg(market_cap_sol ORDER BY id))[1])::float      AS o,
              max(market_cap_sol)::float                                AS h,
              min(market_cap_sol)::float                                AS l,
              ((array_agg(market_cap_sol ORDER BY id DESC))[1])::float  AS c,
              coalesce(sum(sol), 0)::float                              AS v
         FROM events
        WHERE mint=$1 AND type IN ('launch','dev','buy','sell') AND market_cap_sol IS NOT NULL
        GROUP BY 1 ORDER BY 1 DESC LIMIT 2000`, [mint, secs]);
    return { interval: q.interval, seconds: secs, candles: rows.reverse() };
  });

  app.get('/api/stats', async () => {
    const { rows } = await pool.query(`
      SELECT (SELECT count(*) FROM coins)::int AS "coinsLaunched",
             (SELECT (SELECT count(*) FROM coin_keypairs) + (SELECT count(*) FROM wallet_keypairs))::int AS "addressesGround",
             (SELECT count(*) FROM coin_keypairs WHERE status='available')::int AS "readyInPool",
             (SELECT coalesce(max(length(prefix)),0) FROM coins)::int AS "longestTicker",
             (SELECT count(*) FROM grind_jobs WHERE status IN ('queued','running') AND wallet IS NOT NULL)::int AS "inQueue"`);
    return rows[0];
  });
}
