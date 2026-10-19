import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Connection, PublicKey } from '@solana/web3.js';
import { pool } from './db';
import { config } from './config';
import { onCreate, publishEvent, watchMint } from './feed';
import { curveState } from './curve';

/*
  Launch watcher

  You add PUBLIC addresses you ground yourself (e.g. iDeNTity…) to a watchlist. They stay hidden.
  As soon as one becomes a real coin, from Proxima or anywhere else, it appears on the site with
  its name, ticker, image, description, links and live market cap.

  Two ways a launch is detected:
  1. PumpPortal's live new-coin stream (instant).
  2. A poller that asks your RPC every WATCH_POLL_SECONDS whether a watched address now exists.
     Catches anything the stream missed, including coins launched before the backend was running.
*/

const connection = new Connection(config.rpcUrl, 'confirmed');
const watched = new Set<string>();
const inFlight = new Set<string>();
let solUsd = 0;

export function getSolUsd(): number { return solUsd; }

function isAddress(s: string): boolean {
  try { new PublicKey(s); return true; } catch { return false; }
}

/** Only keep http(s) links, so a coin's metadata can't inject javascript: or other schemes. */
function safeUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString().slice(0, 300) : null;
  } catch { return null; }
}

function clip(v: unknown, n: number): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null;
}

const GATEWAYS = ['https://ipfs.io/ipfs/', 'https://gateway.pinata.cloud/ipfs/', 'https://dweb.link/ipfs/'];

/** Fetch JSON metadata, retrying IPFS links through other gateways if the first one is slow. */
async function fetchJson(url: string): Promise<any> {
  const tries = [url];
  const cid = url.match(/\/ipfs\/(.+)$/)?.[1] || url.match(/^ipfs:\/\/(.+)$/)?.[1];
  if (cid) for (const g of GATEWAYS) if (!tries.includes(g + cid)) tries.push(g + cid);
  let lastErr: unknown;
  for (const t of tries) {
    try {
      const r = await fetch(t, { signal: AbortSignal.timeout(8000) });
      if (r.ok) return await r.json();
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

/** Helius DAS getAsset: metadata for any token, used when the stream didn't give us a URI. */
async function getAsset(mint: string): Promise<any | null> {
  try {
    const r = await fetch(config.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'watch', method: 'getAsset', params: { id: mint } }),
      signal: AbortSignal.timeout(8000),
    });
    const j: any = await r.json();
    return j?.result || null;
  } catch { return null; }
}

/** Longest stretch at the start of the address that spells the ticker (case-insensitive). */
function matchedPrefix(mint: string, symbol: string): string {
  let p = '';
  for (let i = 0; i < symbol.length && i < mint.length; i++) {
    if (mint[i].toLowerCase() !== symbol[i].toLowerCase()) break;
    p += symbol[i].toLowerCase();
  }
  return p;
}

type Hint = { uri?: string; name?: string; symbol?: string; creator?: string; marketCapSol?: number; signature?: string };

async function readMetadata(mint: string, hint: Hint) {
  let asset: any = null;
  let uri = hint.uri;
  if (!uri) { asset = await getAsset(mint); uri = asset?.content?.json_uri; }
  let meta: any = {};
  if (uri) { try { meta = await fetchJson(uri); } catch { meta = {}; } }
  if (!asset && (!meta.image || !meta.name)) asset = await getAsset(mint);
  const m = asset?.content?.metadata || {};
  const name = clip(meta.name, 64) || clip(hint.name, 64) || clip(m.name, 64);
  const symbol = clip(meta.symbol, 16) || clip(hint.symbol, 16) || clip(m.symbol, 16);
  const image = safeUrl(meta.image) || safeUrl(asset?.content?.links?.image) || safeUrl(asset?.content?.files?.[0]?.uri);
  return {
    name, symbol, image,
    description: clip(meta.description, 500) || clip(m.description, 500),
    website: safeUrl(meta.website) || safeUrl(asset?.content?.links?.external_url),
    twitter: safeUrl(meta.twitter),
    telegram: safeUrl(meta.telegram),
    ok: Boolean(name && image),
  };
}

/**
 * Who created the coin, and in which transaction, when the live stream didn't tell us: the
 * oldest transaction on the mint address is the create, and its fee payer is the creator.
 */
async function creationOf(mint: string): Promise<{ creator?: string; signature?: string }> {
  try {
    const sigs = await connection.getSignaturesForAddress(new PublicKey(mint), { limit: 1000 });
    const first = sigs.filter((x) => !x.err).pop();
    if (!first) return {};
    const tx = await connection.getParsedTransaction(first.signature, { maxSupportedTransactionVersion: 0 });
    const payer = tx?.transaction.message.accountKeys.find((k) => k.signer)?.pubkey.toBase58();
    return { creator: payer, signature: first.signature };
  } catch { return {}; }
}

/** A watched address just became a coin: add it to the site and announce it. */
export async function ingest(mint: string, hint: Hint = {}): Promise<boolean> {
  if (inFlight.has(mint)) return false;
  inFlight.add(mint);
  try {
    if (!hint.creator) hint = { ...(await creationOf(mint)), ...hint };
    const md = await readMetadata(mint, hint);
    // Market cap straight from the bonding curve, so the coin list shows a number immediately.
    const mcNow = hint.marketCapSol || (await curveState(mint, true))?.marketCapSol || 0;
    const symbol = md.symbol || '';
    const prefix = matchedPrefix(mint, symbol);
    const featured = (await pool.query(`SELECT featured FROM watched_mints WHERE mint=$1`, [mint])).rows[0]?.featured
      || config.featuredMints.includes(mint);
    await pool.query(
      `INSERT INTO coins (mint, name, symbol, prefix, creator, image_uri, description, website, twitter, telegram,
                          market_cap_sol, featured, source, meta_ok)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'watched',$13)
       ON CONFLICT (mint) DO UPDATE SET
         name=EXCLUDED.name, symbol=EXCLUDED.symbol, prefix=EXCLUDED.prefix, image_uri=EXCLUDED.image_uri,
         description=EXCLUDED.description, website=EXCLUDED.website, twitter=EXCLUDED.twitter,
         telegram=EXCLUDED.telegram, featured=EXCLUDED.featured, meta_ok=EXCLUDED.meta_ok,
         creator=CASE WHEN coins.creator = '' THEN EXCLUDED.creator ELSE coins.creator END,
         market_cap_sol=GREATEST(coins.market_cap_sol, EXCLUDED.market_cap_sol)`,
      [mint, md.name || 'New coin', symbol, prefix, hint.creator || '', md.image, md.description,
       md.website, md.twitter, md.telegram, mcNow, featured, md.ok]);
    const first = await pool.query(
      `UPDATE watched_mints SET live_at=now() WHERE mint=$1 AND live_at IS NULL RETURNING mint`, [mint]);
    watched.delete(mint);
    watchMint(mint); // start following its trades for the feed and market cap
    if (first.rowCount) {
      await publishEvent({ type: 'launch', mint, prefix, wallet: hint.creator, signature: hint.signature || `watch:${mint}`, marketCapSol: mcNow || undefined });
    }
    console.log(`[watch] ${mint} is live: ${md.name} ($${symbol})${md.ok ? '' : ' — metadata incomplete, will retry'}`);
    return true;
  } catch (e) {
    console.error(`[watch] could not add ${mint}`, e);
    return false;
  } finally {
    inFlight.delete(mint);
  }
}

async function loadWatched(): Promise<void> {
  for (const m of config.watchMints) {
    if (!isAddress(m)) { console.error(`[watch] skipping invalid address in WATCH_MINTS: ${m}`); continue; }
    await pool.query(
      `INSERT INTO watched_mints (mint, featured) VALUES ($1, $2)
       ON CONFLICT (mint) DO UPDATE SET featured = watched_mints.featured OR EXCLUDED.featured`,
      [m, config.featuredMints.includes(m)]);
  }
  const { rows } = await pool.query(`SELECT mint FROM watched_mints WHERE live_at IS NULL`);
  watched.clear();
  rows.forEach((r) => watched.add(r.mint));
}

/** Fallback: does any watched address exist on chain yet? */
async function poll(): Promise<void> {
  const list = [...watched];
  for (let i = 0; i < list.length; i += 100) {
    const batch = list.slice(i, i + 100);
    const infos = await connection.getMultipleAccountsInfo(batch.map((m) => new PublicKey(m))).catch(() => null);
    if (!infos) return;
    await pool.query(`UPDATE watched_mints SET last_check=now() WHERE mint = ANY($1)`, [batch]);
    for (let j = 0; j < batch.length; j++) if (infos[j]) await ingest(batch[j]);
  }
}

/** Coins whose image or name didn't load at launch (IPFS can lag): try again for a day. */
async function retryMetadata(): Promise<void> {
  const { rows } = await pool.query(
    `SELECT mint FROM coins WHERE meta_ok = false AND launched_at > now() - interval '1 day' LIMIT 20`);
  for (const r of rows) await ingest(r.mint);
}

// SOL/USD, so the site can show market caps in dollars. CoinGecko's free API often refuses
// requests from shared cloud servers (Railway included), and without a price every market cap
// falls back to SOL. So try several free sources in turn and keep the first that answers.
const PRICE_SOURCES: { url: () => string; read: (j: any) => unknown }[] = [
  { url: () => config.solPriceUrl, read: (j) => j?.solana?.usd },
  { url: () => 'https://api.coinbase.com/v2/prices/SOL-USD/spot', read: (j) => j?.data?.amount },
  { url: () => 'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', read: (j) => j?.price },
  { url: () => 'https://api.kraken.com/0/public/Ticker?pair=SOLUSD', read: (j) => j?.result?.SOLUSD?.c?.[0] },
];

async function refreshPrice(): Promise<void> {
  for (const src of PRICE_SOURCES) {
    try {
      const r = await fetch(src.url(), { signal: AbortSignal.timeout(6000), headers: { accept: 'application/json' } });
      if (!r.ok) continue;
      const p = Number(src.read(await r.json()));
      if (p > 1 && p < 100_000) { solUsd = p; return; }
    } catch { /* try the next source; keep the last known price if all fail */ }
  }
}

export async function startWatcher(): Promise<void> {
  await loadWatched();
  onCreate(async (m) => {
    if (!watched.has(m.mint)) return;
    await ingest(m.mint, {
      uri: m.uri, name: m.name, symbol: m.symbol, creator: m.traderPublicKey,
      marketCapSol: Number(m.marketCapSol) || undefined, signature: m.signature,
    });
  });
  const tick = (fn: () => Promise<void>, s: number) => setInterval(() => fn().catch((e) => console.error('[watch]', e)), s * 1000);
  poll().catch(() => {});
  refreshPrice().catch(() => {});
  tick(poll, config.watchPollSeconds);
  tick(retryMetadata, 60);
  tick(refreshPrice, 60);
  console.log(`[watch] watching ${watched.size} address(es)`);
}

// ---------- admin ----------

export function registerAdminRoutes(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/admin/')) return;
    if (!config.adminToken) return reply.code(503).send({ error: 'Admin is disabled. Set ADMIN_TOKEN to enable it.' });
    if (req.headers.authorization !== `Bearer ${config.adminToken}`) return reply.code(401).send({ error: 'unauthorized' });
  });

  // Add an address to the watchlist. If it's already live, it's added to the site right away.
  app.post('/admin/watch', async (req, reply) => {
    const b = z.object({ mint: z.string().trim(), featured: z.boolean().optional(), label: z.string().max(64).optional() }).parse(req.body);
    if (!isAddress(b.mint)) return reply.code(400).send({ error: 'That is not a valid Solana address. Use the public address, never the private key.' });
    await pool.query(
      `INSERT INTO watched_mints (mint, featured, label) VALUES ($1,$2,$3)
       ON CONFLICT (mint) DO UPDATE SET featured=EXCLUDED.featured, label=COALESCE(EXCLUDED.label, watched_mints.label)`,
      [b.mint, Boolean(b.featured), b.label ?? null]);
    const live = (await pool.query(`SELECT live_at FROM watched_mints WHERE mint=$1`, [b.mint])).rows[0]?.live_at;
    if (!live) watched.add(b.mint);
    const exists = await connection.getAccountInfo(new PublicKey(b.mint)).catch(() => null);
    if (exists) await ingest(b.mint);
    return { ok: true, mint: b.mint, status: exists ? 'live' : 'watching' };
  });

  app.get('/admin/watch', async () => {
    const { rows } = await pool.query(
      `SELECT w.mint, w.label, w.featured, w.live_at AS "liveAt", w.last_check AS "lastCheck", c.name, c.symbol
         FROM watched_mints w LEFT JOIN coins c ON c.mint = w.mint ORDER BY w.created_at`);
    return { watching: rows };
  });

  app.delete('/admin/watch/:mint', async (req) => {
    const { mint } = z.object({ mint: z.string() }).parse(req.params);
    await pool.query(`DELETE FROM watched_mints WHERE mint=$1`, [mint]);
    watched.delete(mint);
    return { ok: true };
  });

  // Re-read a coin's name, image and links (e.g. after its IPFS image finally loads).
  app.post('/admin/coins/:mint/refresh', async (req) => {
    const { mint } = z.object({ mint: z.string() }).parse(req.params);
    return { ok: await ingest(mint) };
  });

  app.post('/admin/coins/:mint/featured', async (req) => {
    const { mint } = z.object({ mint: z.string() }).parse(req.params);
    const { featured } = z.object({ featured: z.boolean() }).parse(req.body);
    await pool.query(`UPDATE coins SET featured=$2 WHERE mint=$1`, [mint, featured]);
    await pool.query(`UPDATE watched_mints SET featured=$2 WHERE mint=$1`, [mint, featured]);
    return { ok: true };
  });

  // Take a coin off the site (e.g. a test launch).
  app.delete('/admin/coins/:mint', async (req) => {
    const { mint } = z.object({ mint: z.string() }).parse(req.params);
    await pool.query(`DELETE FROM events WHERE mint=$1`, [mint]);
    await pool.query(`DELETE FROM coins WHERE mint=$1`, [mint]);
    return { ok: true };
  });
}
