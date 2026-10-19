import { FastifyInstance } from 'fastify';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { z } from 'zod';
import { pool } from './db';
import { config } from './config';
import { viewerJoin, viewerLeave } from './chainwatch';

/*
  Live feed
  - Every event is stored in the `events` table and pushed to browsers over Server-Sent Events.
  - Trades and graduations come from PumpPortal's free data websocket: we subscribe to the
    trades of every coin launched through Identity, plus the global migration stream.
*/

export type FeedEvent = {
  type: 'launch' | 'buy' | 'sell' | 'dev' | 'grad' | 'ground' | 'holders';
  mint?: string; prefix?: string; wallet?: string; sol?: number; marketCapSol?: number; signature?: string;
  tokenAmount?: number;
  /** When it happened on chain (block time). Defaults to now. */
  at?: Date;
};

const bus = new EventEmitter();
bus.setMaxListeners(0);

// In-memory cache for coin metadata used by SSE, avoids one DB query per event per client.
const coinCache = new Map<string, { name: string; symbol: string; imageUri: string | null; ts: number }>();
const COIN_CACHE_TTL = 60_000; // 1 minute

async function getCoinMeta(mint: string): Promise<{ name?: string; symbol?: string; imageUri?: string | null }> {
  const cached = coinCache.get(mint);
  if (cached && Date.now() - cached.ts < COIN_CACHE_TTL) return cached;
  const { rows } = await pool.query(`SELECT name, symbol, image_uri AS "imageUri" FROM coins WHERE mint=$1`, [mint]);
  if (rows[0]) {
    coinCache.set(mint, { ...rows[0], ts: Date.now() });
    return rows[0];
  }
  return {};
}

export async function publishEvent(e: FeedEvent): Promise<void> {
  const { rows } = await pool.query(
    `INSERT INTO events (type, mint, prefix, wallet, sol, market_cap_sol, signature, token_amount, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, coalesce($9::timestamptz, now()))
     ON CONFLICT (signature, type) WHERE signature IS NOT NULL DO NOTHING
     RETURNING id, created_at`,
    [e.type, e.mint ?? null, e.prefix ?? null, e.wallet ?? null, e.sol ?? null, e.marketCapSol ?? null,
     e.signature ?? null, e.tokenAmount ?? null, e.at ?? null]);
  if (!rows[0]) return; // duplicate
  bus.emit('event', { ...e, id: Number(rows[0].id), at: rows[0].created_at });
}

async function recentEvents(limit: number) {
  const { rows } = await pool.query(
    `SELECT e.id, e.type, e.mint, e.prefix, e.wallet, e.sol::float, e.market_cap_sol::float AS "marketCapSol", e.signature, e.created_at AS at,
            c.name, c.symbol, c.image_uri AS "imageUri"
       FROM events e LEFT JOIN coins c ON c.mint = e.mint
      ORDER BY e.id DESC LIMIT $1`, [limit]);
  return rows;
}

export function registerFeedRoutes(app: FastifyInstance): void {
  app.get('/api/feed', async (req) => {
    const q = z.object({ limit: z.coerce.number().min(1).max(100).default(30) }).parse(req.query);
    return { events: await recentEvents(q.limit) };
  });

  // Live events over SSE. ?mint=<address> narrows it to one coin, for the coin page.
  app.get('/api/feed/stream', (req, reply) => {
    const only = typeof (req.query as any)?.mint === 'string' ? String((req.query as any).mint).slice(0, 64) : '';
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': (req.headers.origin && config.corsOrigins.includes(req.headers.origin)) ? req.headers.origin : config.corsOrigins[0],
    });
    const send = async (e: any) => {
      if (only && e.mint !== only) return;
      if (e.mint) {
        const meta = await getCoinMeta(e.mint);
        Object.assign(e, meta);
      }
      reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    // Write something straight away. Node holds the headers back until the first write, so a
    // quiet coin would otherwise leave the browser waiting — showing "connecting" — until the
    // first ping 25 seconds later.
    reply.raw.write(': connected\n\n');
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25000);
    bus.on('event', send);
    // Someone has this coin's page open: read its trades from the chain every couple of seconds.
    if (only) viewerJoin(only);
    req.raw.on('close', () => { clearInterval(ping); bus.off('event', send); if (only) viewerLeave(only); });
  });
}

// ---------- PumpPortal data websocket ----------

let ws: WebSocket | null = null;
const ourMints = new Set<string>();

/** For /api/health: is the PumpPortal stream up, and is it actually sending anything? */
export const pumpPortalStatus = { connected: false, lastMessageAt: 0, lastTradeAt: 0, lastError: '' };

// Called for every new-coin event from PumpPortal (set by the launch watcher).
let createHandler: ((m: any) => Promise<void>) | null = null;
export function onCreate(fn: (m: any) => Promise<void>): void { createHandler = fn; }

export function watchMint(mint: string): void {
  ourMints.add(mint);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
  }
}

export async function startPumpPortalIngest(): Promise<void> {
  const { rows } = await pool.query(`SELECT mint FROM coins WHERE launched_at > now() - interval '30 days'`);
  rows.forEach((r) => ourMints.add(r.mint));

  const connect = () => {
    ws = new WebSocket(config.pumpPortalWs);
    ws.on('open', () => {
      pumpPortalStatus.connected = true;
      // Use one connection for everything; PumpPortal asks clients not to open one socket per token.
      if (ourMints.size) ws!.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [...ourMints] }));
      ws!.send(JSON.stringify({ method: 'subscribeMigration' }));
      // Every new pump.fun coin. The watcher picks out the addresses on your watchlist.
      ws!.send(JSON.stringify({ method: 'subscribeNewToken' }));
    });
    ws.on('message', async (buf) => {
      let m: any;
      pumpPortalStatus.lastMessageAt = Date.now();
      try { m = JSON.parse(buf.toString()); } catch { return; }
      if (m.mint && ourMints.has(m.mint) && (m.txType === 'buy' || m.txType === 'sell')) pumpPortalStatus.lastTradeAt = Date.now();
      try {
        if (m.txType === 'create' && m.mint) {
          if (createHandler) await createHandler(m);
        } else if (m.mint && ourMints.has(m.mint) && (m.txType === 'buy' || m.txType === 'sell')) {
          // The creator's buy rides inside the create transaction, which we already recorded as
          // a 'dev' event. If the stream reports it as a plain buy, don't count it twice.
          if (m.txType === 'buy' && m.signature) {
            const dup = await pool.query(`SELECT 1 FROM events WHERE type='launch' AND signature=$1 LIMIT 1`, [m.signature]);
            if (dup.rowCount) return;
          }
          const mc = Number(m.marketCapSol) || undefined;
          await publishEvent({
            type: m.txType, mint: m.mint, wallet: m.traderPublicKey, sol: Number(m.solAmount) || undefined,
            marketCapSol: mc, signature: m.signature, tokenAmount: Number(m.tokenAmount) || undefined,
          });
          if (mc) await pool.query(`UPDATE coins SET market_cap_sol=$2 WHERE mint=$1`, [m.mint, mc]);
        } else if (m.mint && ourMints.has(m.mint) && m.txType === 'migrate') {
          const r = await pool.query(`UPDATE coins SET graduated=true WHERE mint=$1 AND graduated=false`, [m.mint]);
          if (r.rowCount) await publishEvent({ type: 'grad', mint: m.mint, signature: m.signature });
        }
      } catch (e) {
        console.error('feed ingest error', e);
      }
    });
    ws.on('close', () => { pumpPortalStatus.connected = false; setTimeout(connect, 3000); });
    ws.on('error', (e) => { pumpPortalStatus.lastError = e.message; console.error('pumpportal ws error', e.message); ws?.close(); });
  };
  connect();
}
