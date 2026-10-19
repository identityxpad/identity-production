import { Connection, PublicKey } from '@solana/web3.js';
import { config } from './config';

/*
  Reads a coin's market cap straight from its pump.fun bonding curve account.

  Trades from PumpPortal only tell us the price when somebody trades, and only for trades
  we were subscribed for. That leaves a brand-new coin with no price at all (the creator's
  own buy happens inside the create transaction, before we subscribe), and any coin with
  gaps if trades land while the server is restarting. The curve account always holds the
  current reserves, so it gives a real number from the first second.

  Account layout (pump.fun BondingCurve, after the 8-byte Anchor discriminator):
    u64 virtual_token_reserves   @ 8
    u64 virtual_sol_reserves     @ 16
    u64 real_token_reserves      @ 24
    u64 real_sol_reserves        @ 32
    u64 token_total_supply       @ 40
    bool complete                @ 48
  SOL is in lamports (9 decimals); pump.fun tokens use 6 decimals.
*/

const connection = new Connection(config.rpcUrl, 'confirmed');
const PUMP = new PublicKey(config.pumpProgramId);

export type CurveState = { marketCapSol: number; complete: boolean; realSolReserves: number };

const cache = new Map<string, { at: number; v: CurveState | null }>();
const TTL_MS = 5_000;

export function bondingCurveAddress(mint: string): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()], PUMP)[0];
}

export function parseCurve(data: Buffer): CurveState | null {
  if (data.length < 49) return null;
  const vTok = data.readBigUInt64LE(8);
  const vSol = data.readBigUInt64LE(16);
  const rSol = data.readBigUInt64LE(32);
  const supply = data.readBigUInt64LE(40);
  if (vTok === 0n || supply === 0n) return null;
  // price (SOL/token) = (vSol / 1e9) / (vTok / 1e6); market cap = price * supply / 1e6.
  // The token decimals cancel, leaving: vSol * supply / (vTok * 1e9).
  const mc = (Number(vSol) * Number(supply)) / (Number(vTok) * 1e9);
  if (!(mc > 0 && mc < 1e8)) return null; // refuse anything implausible rather than show it
  return { marketCapSol: mc, complete: data[48] === 1, realSolReserves: Number(rSol) / 1e9 };
}

/** Current curve state, or null if it can't be read. Cached briefly per mint. */
export async function curveState(mint: string, fresh = false): Promise<CurveState | null> {
  const hit = cache.get(mint);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.v;
  let v: CurveState | null = null;
  try {
    const acc = await connection.getAccountInfo(bondingCurveAddress(mint), 'confirmed');
    if (acc && acc.owner.equals(PUMP)) v = parseCurve(acc.data as Buffer);
  } catch {
    /* RPC hiccup: fall back to whatever trades told us */
  }
  cache.set(mint, { at: Date.now(), v });
  return v;
}
