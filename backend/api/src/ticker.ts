import { readFileSync } from 'fs';
import { config } from './config';

// Lowercase characters that exist in base58. Note: no 'l' and no '0'.
export const LOWER_B58 = '123456789abcdefghijkmnopqrstuvwxyz';

let blocklist: Set<string> | null = null;
function loadBlocklist(): Set<string> {
  if (blocklist) return blocklist;
  blocklist = new Set();
  if (config.blocklistFile) {
    try {
      readFileSync(config.blocklistFile, 'utf8')
        .split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter(Boolean)
        .forEach((w) => blocklist!.add(w));
    } catch {
      /* no file: nothing blocked */
    }
  }
  return blocklist;
}

export type TickerCheck =
  | { ok: true; ticker: string; prefix: string; length: number; expectedAttempts: number; expectedSeconds: number; lane: 'fast' | 'long' }
  | { ok: false; error: string };

/** Validates a ticker and returns the address prefix we will grind for it. */
export function checkTicker(raw: string): TickerCheck {
  const ticker = String(raw || '').trim();
  const lower = ticker.toLowerCase();
  if (lower.length < config.minTicker) return { ok: false, error: `Tickers need at least ${config.minTicker} characters.` };
  const bad = [...new Set([...lower].filter((ch) => !LOWER_B58.includes(ch)))];
  if (bad.length) return { ok: false, error: `These characters can never appear in a Solana address: ${bad.join(' ')}` };
  const prefix = lower.slice(0, config.maxTicker);
  if (loadBlocklist().has(lower)) return { ok: false, error: 'This ticker is not available on Identity.' };
  const expectedAttempts = Math.pow(58, prefix.length);
  return {
    ok: true,
    ticker,
    prefix,
    length: prefix.length,
    expectedAttempts,
    expectedSeconds: expectedAttempts / config.gpuRate,
    lane: prefix.length <= config.fastLaneMax ? 'fast' : 'long',
  };
}
