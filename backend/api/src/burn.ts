import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import nacl from 'tweetnacl';
import {
  Connection, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, VersionedMessage,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { pool, tx } from './db';
import { config } from './config';

/*
  Burn to reveal.

  When BURN_AMOUNT is set (and IDENTITY_MINT is the coin), a vanity wallet's private key is
  only handed over after its owner burns that many $IDENTITY. Grinding stays free (the holding
  gate still applies), so nobody ever burns for a key they don't receive.

    1. prepare: the server builds a burn transaction — the token program's BurnChecked from the
       user's own token account, plus a memo naming the vanity address — with their wallet paying.
    2. the wallet signs it.
    3. submit: the server checks it's the transaction it built, sends it, waits for confirmation,
       and records the burn against that key. Only then does reveal work.

  One confirmed burn unlocks one key, and a key never needs a second burn: if the reveal fails
  after the burn (dropped connection, closed tab), revealing again works without burning again.
  Burned tokens are destroyed (total supply goes down), visible to anyone on Solscan.
*/

const connection = new Connection(config.rpcUrl, 'confirmed');
const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const TOKEN_PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
// Programs a wallet may add on its own when signing (fee tweaks, Phantom's safety checks).
const WALLET_ADDED = new Set(['ComputeBudget111111111111111111111111111111', 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95']);

export function burnEnabled(): boolean {
  return config.burnAmount > 0 && !!config.identityMint;
}

/** Whole tokens → base units, exactly (no floating-point drift). */
function baseUnits(amount: number, decimals: number): bigint {
  const [w, f = ''] = String(amount).split('.');
  return BigInt(w + f.padEnd(decimals, '0').slice(0, decimals));
}

function burnCheckedIx(account: PublicKey, mint: PublicKey, owner: PublicKey, amount: bigint, decimals: number, program: PublicKey) {
  const data = Buffer.alloc(10);
  data[0] = 15; // BurnChecked: the same instruction in SPL Token and Token-2022
  data.writeBigUInt64LE(amount, 1);
  data[9] = decimals;
  return new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

function programIds(m: VersionedMessage): Set<string> {
  return new Set(m.compiledInstructions.map((i) => m.staticAccountKeys[i.programIdIndex].toBase58()));
}

function tokenIxData(m: VersionedMessage): string {
  return m.compiledInstructions
    .filter((i) => TOKEN_PROGRAMS.has(m.staticAccountKeys[i.programIdIndex].toBase58()))
    .map((i) => Buffer.from(i.data).toString('hex')).join(',');
}

type KeyRow = {
  keypair_id: number; pubkey: string; wallet: string; sealed_secret: string | null; expires_at: Date;
  burn_signature: string | null; burn_state: string | null; burn_wallet: string | null; burn_message_b64: string | null;
};

async function keyFor(jobId: number, sessionToken: string): Promise<{ row?: KeyRow; error?: string; code?: number }> {
  const { rows } = await pool.query(
    `SELECT k.id AS keypair_id, k.pubkey, j.wallet, k.sealed_secret, k.expires_at,
            k.burn_signature, k.burn_state, k.burn_wallet, k.burn_message_b64
       FROM grind_jobs j JOIN wallet_keypairs k ON k.id = j.keypair_id
      WHERE j.id=$1 AND j.type='wallet'`, [jobId]);
  const row = rows[0] as KeyRow | undefined;
  if (!row) return { error: 'No such key, or it is not ground yet.', code: 404 };
  if (row.wallet !== sessionToken) return { error: 'Not your key.', code: 403 };
  if (!row.sealed_secret) return { error: 'This key has expired and was permanently deleted from our servers. Generate a new one.', code: 410 };
  return { row };
}

async function recordBurn(keypairId: number, signature: string): Promise<void> {
  // Unlock the key, and give its owner at least 5 more minutes to reveal and save it.
  await pool.query(
    `UPDATE wallet_keypairs SET burn_signature=$2, burn_state='done', burn_pending_sig=NULL, burned_at=now(),
            expires_at = GREATEST(expires_at, now() + interval '5 minutes')
      WHERE id=$1`, [keypairId, signature]);
}

/**
 * A burn whose confirmation we lost: look its signature up on chain. Confirmed → record it.
 * Failed, or never landed and its blockhash has expired (~90s) → release the lock so a new burn
 * can be built. Never builds a second burn while the first could still land.
 */
async function settlePending(keypairId: number): Promise<boolean> {
  const { rows } = await pool.query(`SELECT burn_pending_sig, burn_message_b64 FROM wallet_keypairs WHERE id=$1`, [keypairId]);
  const sig = rows[0]?.burn_pending_sig;
  const release = () => pool.query(
    `UPDATE wallet_keypairs SET burn_state=NULL, burn_pending_sig=NULL WHERE id=$1 AND burn_signature IS NULL`, [keypairId]);
  if (!sig) { await release(); return false; } // never sent: nothing can land
  const st = await connection.getSignatureStatus(sig, { searchTransactionHistory: true }).catch(() => null);
  if (st?.value && !st.value.err && st.value.confirmationStatus) { await recordBurn(keypairId, sig); return true; }
  if (st?.value?.err) { await release(); return false; }
  const m = rows[0]?.burn_message_b64 ? VersionedMessage.deserialize(Buffer.from(rows[0].burn_message_b64, 'base64')) : null;
  const stillValid = m ? await connection.isBlockhashValid(m.recentBlockhash).then((r) => r.value).catch(() => true) : false;
  if (!stillValid) await release();
  return false;
}

/** True when this key may be revealed: burning is off, or its burn is confirmed. */
export async function burnSatisfied(keypairId: number): Promise<boolean> {
  if (!burnEnabled()) return true;
  const { rows } = await pool.query(`SELECT burn_signature, burn_state FROM wallet_keypairs WHERE id=$1`, [keypairId]);
  if (rows[0]?.burn_signature) return true;
  return rows[0]?.burn_state === 'sending' ? settlePending(keypairId) : false;
}

export function registerBurnRoutes(app: FastifyInstance): void {
  // 1. Build the burn for this key, for the user's wallet to sign.
  app.post('/api/wallet/grind/:id/burn/prepare', async (req, reply) => {
    if (!burnEnabled()) return reply.code(400).send({ error: 'Burning is not switched on.' });
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const b = z.object({ sessionToken: z.string().min(16).max(128), wallet: z.string() }).parse(req.body);
    let owner: PublicKey;
    try { owner = new PublicKey(b.wallet); } catch { return reply.code(400).send({ error: 'That wallet address is not valid.' }); }

    const k = await keyFor(id, b.sessionToken);
    if (!k.row) return reply.code(k.code!).send({ error: k.error });
    if (k.row.burn_signature) return { alreadyBurned: true };
    if (k.row.burn_state === 'sending') {
      if (await settlePending(k.row.keypair_id)) return { alreadyBurned: true };
      const again = await pool.query(`SELECT burn_state FROM wallet_keypairs WHERE id=$1`, [k.row.keypair_id]);
      if (again.rows[0]?.burn_state === 'sending') {
        return reply.code(409).send({ error: 'Your burn is still confirming. Wait a few seconds, then press reveal again.' });
      }
    }
    if (new Date(k.row.expires_at).getTime() - Date.now() < 60_000) {
      return reply.code(410).send({ error: 'Less than a minute is left on this key, not enough to burn safely. Generate a new one.' });
    }

    const mint = new PublicKey(config.identityMint);
    const mintInfo = await connection.getParsedAccountInfo(mint);
    const program = mintInfo.value?.owner;
    const decimals = (mintInfo.value?.data as any)?.parsed?.info?.decimals;
    if (!program || !TOKEN_PROGRAMS.has(program.toBase58()) || typeof decimals !== 'number') {
      return reply.code(502).send({ error: 'Could not read the $IDENTITY coin on chain. Try again in a moment.' });
    }
    const need = baseUnits(config.burnAmount, decimals);

    // The user's token account holding the most $IDENTITY.
    const accts = await connection.getParsedTokenAccountsByOwner(owner, { mint });
    let best: { pubkey: PublicKey; amount: bigint } | null = null;
    for (const a of accts.value) {
      const amt = BigInt(a.account.data.parsed?.info?.tokenAmount?.amount ?? '0');
      if (!best || amt > best.amount) best = { pubkey: a.pubkey, amount: amt };
    }
    const have = best?.amount ?? 0n;
    if (!best || have < need) {
      const fmt = (v: bigint) => (Number(v) / 10 ** decimals).toLocaleString('en-US');
      return reply.code(400).send({ error: `Revealing burns ${config.burnAmount.toLocaleString('en-US')} $IDENTITY. This wallet holds ${fmt(have)}.` });
    }

    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({
      payerKey: owner,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }),
        burnCheckedIx(best.pubkey, mint, owner, need, decimals, program),
        new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(`Identity: burned to reveal vanity wallet ${k.row.pubkey}`) }),
      ],
    }).compileToV0Message();
    await pool.query(
      `UPDATE wallet_keypairs SET burn_wallet=$2, burn_message_b64=$3 WHERE id=$1 AND burn_signature IS NULL`,
      [k.row.keypair_id, owner.toBase58(), Buffer.from(message.serialize()).toString('base64')]);
    return { transaction: Buffer.from(new VersionedTransaction(message).serialize()).toString('base64'), amount: config.burnAmount };
  });

  // 3. Send the signed burn, wait for it to confirm, and unlock the key.
  app.post('/api/wallet/grind/:id/burn/submit', async (req, reply) => {
    if (!burnEnabled()) return reply.code(400).send({ error: 'Burning is not switched on.' });
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const b = z.object({ sessionToken: z.string().min(16).max(128), signedTransaction: z.string() }).parse(req.body);

    const k = await keyFor(id, b.sessionToken);
    if (!k.row) return reply.code(k.code!).send({ error: k.error });
    if (k.row.burn_signature) return { ok: true, signature: k.row.burn_signature };
    if (!k.row.burn_message_b64 || !k.row.burn_wallet) return reply.code(400).send({ error: 'Prepare the burn first.' });

    let signed: VersionedTransaction;
    try { signed = VersionedTransaction.deserialize(Buffer.from(b.signedTransaction, 'base64')); }
    catch { return reply.code(400).send({ error: 'That is not a valid signed transaction.' }); }
    const msg = signed.message;
    const original = VersionedMessage.deserialize(Buffer.from(k.row.burn_message_b64, 'base64'));
    if (msg.staticAccountKeys[0].toBase58() !== k.row.burn_wallet) return reply.code(400).send({ error: 'The burn was signed by a different wallet.' });
    if (Buffer.compare(Buffer.from(msg.serialize()), Buffer.from(original.serialize())) !== 0) {
      // Wallets may add fee or safety instructions; nothing else may change, least of all the burn.
      const allowed = programIds(original);
      for (const p of programIds(msg)) if (!allowed.has(p) && !WALLET_ADDED.has(p)) return reply.code(400).send({ error: `The burn calls a program we did not expect: ${p}` });
      if (tokenIxData(original) !== tokenIxData(msg)) return reply.code(400).send({ error: 'The burn amount was changed.' });
    }
    const sig = signed.signatures[0];
    if (!sig || !nacl.sign.detached.verify(msg.serialize(), sig, new PublicKey(k.row.burn_wallet).toBytes())) {
      return reply.code(400).send({ error: 'Your wallet signature is missing or invalid.' });
    }

    // One sender at a time, so a double click can't send two burns.
    const claimed = await tx(async (c) => {
      const r = await c.query(
        `UPDATE wallet_keypairs SET burn_state='sending' WHERE id=$1 AND burn_signature IS NULL AND burn_state IS DISTINCT FROM 'sending' RETURNING id`,
        [k.row!.keypair_id]);
      return (r.rowCount ?? 0) > 0;
    });
    if (!claimed) return reply.code(409).send({ error: 'Your burn is already being confirmed. Wait a few seconds, then press reveal again.' });

    let signature: string | null = null;
    try {
      signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 5 });
      await pool.query(`UPDATE wallet_keypairs SET burn_pending_sig=$2 WHERE id=$1`, [k.row.keypair_id, signature]);
      const conf = await connection.confirmTransaction(
        { signature, blockhash: msg.recentBlockhash, lastValidBlockHeight: (await connection.getLatestBlockhash()).lastValidBlockHeight }, 'confirmed');
      if (conf.value.err) throw new Error(JSON.stringify(conf.value.err));
      await recordBurn(k.row.keypair_id, signature);
      return { ok: true, signature };
    } catch (e: any) {
      const m = String(e?.message || e);
      if (signature) {
        // Before saying "nothing was burned", ask the chain: a lost confirmation is not a lost
        // transaction, and the same key must never be burned for twice.
        if (await settlePending(k.row.keypair_id)) return { ok: true, signature };
        const still = await pool.query(`SELECT burn_state FROM wallet_keypairs WHERE id=$1`, [k.row.keypair_id]);
        if (still.rows[0]?.burn_state === 'sending') {
          return reply.code(202).send({ pending: true, error: 'Your burn was sent and is still confirming. Wait a few seconds, then press reveal again.' });
        }
      } else {
        await pool.query(`UPDATE wallet_keypairs SET burn_state=NULL WHERE id=$1 AND burn_signature IS NULL`, [k.row.keypair_id]);
      }
      return reply.code(502).send({
        error: /insufficient/i.test(m)
          ? 'Not enough SOL for the network fee, or not enough $IDENTITY. Nothing was burned.'
          : `The burn did not go through: ${m.slice(0, 200)}. Nothing was burned; try again.`,
      });
    }
  });
}
