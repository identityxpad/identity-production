import { Connection, ParsedTransactionWithMeta } from '@solana/web3.js';
import { config } from './config';
import { pool } from './db';
import { bondingCurveAddress, curveState } from './curve';
import { publishEvent } from './feed';

/*
  Trades read straight from the chain.

  PumpPortal's free websocket is the fast path for trades, but it is a third party: it can drop
  the connection, miss a coin we subscribed to late, or ignore a server's IP — and then the coin
  page shows no trades at all. This poller does not depend on it. It asks our own RPC (Helius)
  for every transaction that touched a coin's bonding curve and records each buy and sell, with
  the time the block was produced. Trades PumpPortal already reported are skipped (same
  signature), so the two never double up.

  Who gets polled:
    - coins someone has open right now (the coin page's live stream): every POLL_FAST_MS
    - coins launched in the last 24 hours: every POLL_SLOW_MS
*/

const connection = new Connection(config.rpcUrl, 'confirmed');
const POLL_FAST_MS = 2_000;
const POLL_SLOW_MS = 30_000;
const PUMP_SUPPLY = 1_000_000_000; // every pump.fun coin has 1B tokens

const viewers = new Map<string, number>();
const lastSig = new Map<string, string | null>(); // newest signature already handled, per coin

export function viewerJoin(mint: string): void { viewers.set(mint, (viewers.get(mint) || 0) + 1); }
export function viewerLeave(mint: string): void {
  const n = (viewers.get(mint) || 0) - 1;
  if (n > 0) viewers.set(mint, n); else viewers.delete(mint);
}

export const chainWatchStatus = { lastRunAt: 0, lastError: '', coinsPolled: 0, tradesFound: 0 };

function ui(b: { uiTokenAmount: { uiAmountString?: string; uiAmount: number | null } }): number {
  return Number(b.uiTokenAmount.uiAmountString ?? b.uiTokenAmount.uiAmount ?? 0) || 0;
}

/** Net change per owner of one mint's token balance within a transaction. */
function tokenDeltas(tx: ParsedTransactionWithMeta, mint: string): Map<string, number> {
  const d = new Map<string, number>();
  for (const b of tx.meta?.postTokenBalances || []) if (b.mint === mint && b.owner) d.set(b.owner, (d.get(b.owner) || 0) + ui(b));
  for (const b of tx.meta?.preTokenBalances || []) if (b.mint === mint && b.owner) d.set(b.owner, (d.get(b.owner) || 0) - ui(b));
  return d;
}

export type Trade = { type: 'buy' | 'sell'; wallet: string; tokens: number; sol: number };

/** One buy or sell on the curve, or null if this transaction isn't one (the create, a fee sweep, …). */
export function parseTrade(tx: ParsedTransactionWithMeta, mint: string, curve: string): Trade | null {
  if (!tx.meta || tx.meta.err) return null;
  let wallet = '', tokens = 0;
  for (const [owner, v] of tokenDeltas(tx, mint)) if (owner !== curve && Math.abs(v) > Math.abs(tokens)) { wallet = owner; tokens = v; }
  if (!wallet || Math.abs(tokens) < 1e-9) return null;
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
  const i = keys.indexOf(curve);
  if (i < 0) return null;
  const sol = Math.abs(tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 1e9; // SOL into / out of the curve
  return { type: tokens > 0 ? 'buy' : 'sell', wallet, tokens: Math.abs(tokens), sol };
}

async function pollMint(mint: string): Promise<void> {
  const curve = bondingCurveAddress(mint);
  const curveKey = curve.toBase58();
  // First time this run: start after the newest trade we already have, if any.
  if (!lastSig.has(mint)) {
    const { rows } = await pool.query(
      `SELECT signature FROM events WHERE mint=$1 AND type IN ('buy','sell','launch') AND signature IS NOT NULL
         AND signature NOT LIKE '%:%' ORDER BY id DESC LIMIT 1`, [mint]);
    lastSig.set(mint, rows[0]?.signature || null);
  }
  const until = lastSig.get(mint) || undefined;
  const sigs = await connection.getSignaturesForAddress(curve, { until, limit: 100 }, 'confirmed');
  if (!sigs.length) return;
  lastSig.set(mint, sigs[0].signature);

  const ok = sigs.filter((s) => !s.err);
  if (!ok.length) return;
  // Skip what we already have: PumpPortal trades, and the launch itself (its dev buy is a 'dev' event).
  const { rows: known } = await pool.query(`SELECT signature FROM events WHERE signature = ANY($1::text[])`, [ok.map((s) => s.signature)]);
  const have = new Set(known.map((r) => r.signature));
  const todo = ok.filter((s) => !have.has(s.signature)).reverse(); // oldest first: the tape and chart run in order
  if (!todo.length) return;

  const txs = await connection.getParsedTransactions(todo.map((s) => s.signature), { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
  let newest: number | undefined;
  for (let i = 0; i < todo.length; i++) {
    const tx = txs[i];
    if (!tx) continue;
    const t = parseTrade(tx, mint, curveKey);
    if (!t) continue;
    // The trade's own average price, as a market cap: available for every past trade (the
    // curve only tells us the price right now). The newest trade uses the live curve price.
    let mc = t.sol > 0 && t.tokens > 0 ? (t.sol / t.tokens) * PUMP_SUPPLY : undefined;
    if (i === todo.length - 1) {
      const now = await curveState(mint, true);
      if (now?.marketCapSol) mc = now.marketCapSol;
    }
    const bt = todo[i].blockTime ?? tx.blockTime;
    await publishEvent({
      type: t.type, mint, wallet: t.wallet, sol: t.sol || undefined, marketCapSol: mc, signature: todo[i].signature,
      tokenAmount: t.tokens, at: bt ? new Date(bt * 1000) : undefined,
    });
    chainWatchStatus.tradesFound++;
    if (mc) newest = mc;
  }
  if (newest) await pool.query(`UPDATE coins SET market_cap_sol=$2 WHERE mint=$1`, [mint, newest]);
}

let recent: string[] = [];
let recentAt = 0;
const lastPolled = new Map<string, number>();

/*
  Scheduling under load. Every second, poll the coins that are due — open coin pages every
  POLL_FAST_MS, other recent coins every POLL_SLOW_MS — most overdue first, but never more than
  CHAIN_RPC_BUDGET coins a second. With many busy coins each one is simply polled a little less
  often; the RPC plan's rate limit is never exceeded.
*/
async function runOnce(): Promise<void> {
  if (Date.now() - recentAt > POLL_SLOW_MS) {
    const { rows } = await pool.query(
      `SELECT mint FROM coins WHERE graduated = false AND launched_at > now() - interval '24 hours'
        ORDER BY launched_at DESC LIMIT 200`);
    recent = rows.map((r) => r.mint);
    recentAt = Date.now();
  }
  const now = Date.now();
  const due: { mint: string; late: number }[] = [];
  const seen = new Set<string>();
  for (const m of viewers.keys()) { seen.add(m); due.push({ mint: m, late: now - (lastPolled.get(m) || 0) - POLL_FAST_MS }); }
  for (const m of recent) if (!seen.has(m)) due.push({ mint: m, late: now - (lastPolled.get(m) || 0) - POLL_SLOW_MS });
  const pick = due.filter((d) => d.late >= 0).sort((a, b) => b.late - a.late).slice(0, Math.max(1, config.chainRpcBudget));
  await Promise.all(pick.map(async ({ mint }) => {
    lastPolled.set(mint, Date.now());
    try { await pollMint(mint); } catch (e: any) { chainWatchStatus.lastError = `${mint.slice(0, 6)}…: ${e?.message || e}`; }
  }));
  chainWatchStatus.coinsPolled = pick.length;
  chainWatchStatus.lastRunAt = Date.now();
}

export function startChainWatch(): void {
  let busy = false;
  const tick = async () => {
    if (busy) return; // the previous round is still waiting on the RPC: skip, don't pile up
    busy = true;
    try { await runOnce(); } catch (e: any) { chainWatchStatus.lastError = String(e?.message || e); }
    finally { busy = false; }
  };
  setInterval(tick, 1_000);
  tick();
  console.log('[chainwatch] reading trades from the chain as a backup to PumpPortal');
}
