import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import nacl from 'tweetnacl';
import { Connection, PublicKey, VersionedTransaction, VersionedMessage } from '@solana/web3.js';
import { pool, tx } from './db';
import { config } from './config';
import { uploadCoinMetadata } from './pinata';
import { secretFromSealed } from './sealed';
import { curveState } from './curve';
import { publishEvent, watchMint } from './feed';

/*
  Launch flow (non-custodial: the user's wallet pays and signs; we never hold user funds)

  1. POST /api/metadata          image + text -> pump.fun IPFS -> metadataUri (banner stored by us)
  2. POST /api/grind             reserve or grind an address that starts with the ticker   (grind.ts)
  3. POST /api/launch/prepare    PumpPortal builds the create transaction with
                                 publicKey = user's wallet and mint = our ground address
  4. Browser: wallet.signTransaction(tx)    (the user's wallet signs FIRST, as Phantom recommends)
  5. POST /api/launch/submit     we check the signed transaction, add the mint key's
                                 signature, send it, confirm it, then delete the mint secret.

  The mint secret never leaves this server. We only sign a transaction that is the one
  PumpPortal built for this mint (or that same transaction with extra wallet-safety
  instructions some wallets add).
*/

const connection = new Connection(config.rpcUrl, 'confirmed');

// Programs a wallet may add on top of PumpPortal's transaction (compute budget, memo, Lighthouse guards).
const WALLET_ADDED_PROGRAMS = new Set([
  'ComputeBudget111111111111111111111111111111',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95',
]);

function programIds(msg: VersionedMessage): Set<string> {
  const keys = msg.staticAccountKeys.map((k) => k.toBase58());
  return new Set(msg.compiledInstructions.map((ix) => keys[ix.programIdIndex]));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Recover launches stuck in 'sent' status.
 *
 * If the server crashes between setting status='sent' and the final
 * 'confirmed'/'failed' update, the launch sits in limbo forever.
 * Solana blockhashes expire after ~60-90 seconds, so any launch stuck
 * in 'sent' for more than 2 minutes is definitely not going to land.
 * Mark it failed so the user can try again with a fresh address.
 */
export async function recoverStuckLaunches(): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE launches SET status = 'failed', error = 'Server interrupted during submission. The transaction did not confirm. Please try again.'
       WHERE status = 'sent'
         AND created_at < now() - interval '2 minutes'`,
  );
  if (rowCount) console.log(`[launch] recovered ${rowCount} stuck launch(es)`);
  return rowCount ?? 0;
}

export function registerLaunchRoutes(app: FastifyInstance): void {
  // ---------- 1. metadata ----------
  app.post('/api/metadata', async (req, reply) => {
    const fields: Record<string, string> = {};
    let image: { buf: Buffer; name: string; mime: string } | null = null;
    let banner: { buf: Buffer; name: string; mime: string } | null = null;

    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const buf = await part.toBuffer();
        const f = { buf, name: part.filename || 'file', mime: part.mimetype };
        if (part.fieldname === 'image') image = f;
        else if (part.fieldname === 'banner') banner = f;
      } else {
        fields[part.fieldname] = String(part.value ?? '');
      }
    }

    const meta = z.object({
      name: z.string().trim().min(1).max(32),
      symbol: z.string().trim().min(1).max(10),
      description: z.string().max(500).optional().default(''),
      website: z.string().max(200).optional().default(''),
      twitter: z.string().max(200).optional().default(''),
      telegram: z.string().max(200).optional().default(''),
    }).parse(fields);

    if (!image) return reply.code(400).send({ error: 'Add an image or video.' });
    const okMedia = /^image\/(png|jpeg|gif)$/.test(image.mime) || image.mime === 'video/mp4';
    if (!okMedia) return reply.code(400).send({ error: 'Use a .png, .jpg or .gif image, or an .mp4 video.' });
    const limit = image.mime === 'video/mp4' ? 30 : 15;
    if (image.buf.length > limit * 1024 * 1024) return reply.code(400).send({ error: `That file is over ${limit} MB.` });
    if (banner && !/^image\/(png|jpeg|gif)$/.test(banner.mime)) return reply.code(400).send({ error: 'Banners must be an image.' });

    const { metadataUri, imageUri } = await uploadCoinMetadata(image, meta);

    let bannerUri: string | null = null;
    if (banner) {
      if (banner.buf.length > 5 * 1024 * 1024) return reply.code(400).send({ error: 'Banners can be at most 5 MB.' });
      const bid = randomUUID();
      await pool.query(`INSERT INTO banners (id, mime, data) VALUES ($1, $2, $3)`, [bid, banner.mime, banner.buf]);
      bannerUri = `${config.publicApiUrl}/api/banner/${bid}`;
    }
    return { metadataUri, imageUri, bannerUri, ...meta };
  });

  // Self-hosted coin images and metadata JSON (see pinata.ts). Public and immutable:
  // a coin's on-chain URI points here for the life of the coin.
  app.get('/media/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { rows } = await pool.query(`SELECT mime, data FROM media WHERE id=$1`, [id]);
    if (!rows[0]) return reply.code(404).send({ error: 'Not found.' });
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    reply.header('Access-Control-Allow-Origin', '*');
    return reply.type(rows[0].mime).send(rows[0].data);
  });

  app.get('/api/banner/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { rows } = await pool.query(`SELECT mime, data FROM banners WHERE id=$1`, [id]);
    if (!rows[0]) return reply.code(404).send({ error: 'No such banner.' });
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    return reply.type(rows[0].mime).send(rows[0].data);
  });

  // ---------- 3. prepare ----------
  app.post('/api/launch/prepare', async (req, reply) => {
    const b = z.object({
      keypairId: z.coerce.number(),
      wallet: z.string(),
      name: z.string().trim().min(1).max(32),
      symbol: z.string().trim().min(1).max(10),
      description: z.string().max(500).optional().default(''),
      metadataUri: z.string().url(),
      imageUri: z.string().url().optional(),
      bannerUri: z.string().url().nullable().optional(),
      website: z.string().optional().default(''),
      twitter: z.string().optional().default(''),
      telegram: z.string().optional().default(''),
      devBuySol: z.number().min(0).max(85).default(0),
      slippage: z.number().min(1).max(50).default(10),
      priorityFee: z.number().min(0).max(0.01).default(0.0005),
    }).parse(req.body);

    try { new PublicKey(b.wallet); } catch { return reply.code(400).send({ error: 'That wallet address is not valid.' }); }

    const { rows } = await pool.query(
      `SELECT id, pubkey, prefix FROM coin_keypairs WHERE id=$1 AND wallet=$2 AND status='reserved' AND reserved_until > now()`,
      [b.keypairId, b.wallet]);
    const kp = rows[0];
    if (!kp) return reply.code(409).send({ error: 'Your address reservation expired. Grind again to get a new one.' });
    if (!b.symbol.toLowerCase().startsWith(kp.prefix)) return reply.code(400).send({ error: 'The ticker no longer matches your ground address.' });

    const res = await fetch(config.pumpPortalTradeLocal, {
      signal: AbortSignal.timeout(20_000),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: b.wallet,
        action: 'create',
        tokenMetadata: { name: b.name, symbol: b.symbol, uri: b.metadataUri },
        mint: kp.pubkey,
        denominatedInSol: 'true',
        amount: b.devBuySol,
        slippage: b.slippage,
        priorityFee: b.priorityFee,
        pool: 'pump',
      }),
    }).catch(() => null);
    if (!res) return reply.code(502).send({ error: 'Could not reach PumpPortal to build the launch. Try again in a moment.' });
    if (!res.ok) return reply.code(502).send({ error: `PumpPortal could not build the transaction (${res.status}): ${await res.text()}` });

    const bytes = new Uint8Array(await res.arrayBuffer());
    const unsigned = VersionedTransaction.deserialize(bytes);
    if (unsigned.message.staticAccountKeys[0].toBase58() !== b.wallet) {
      return reply.code(502).send({ error: 'PumpPortal returned a transaction for a different fee payer.' });
    }
    if (!unsigned.message.staticAccountKeys.some((k) => k.toBase58() === kp.pubkey)) {
      return reply.code(502).send({ error: 'PumpPortal returned a transaction that does not use our mint.' });
    }

    // Simulate before the wallet ever sees it. Phantom warns on transactions that fail simulation,
    // so catch problems (not enough SOL, bad metadata) here and show a clear error instead.
    const sim = await connection.simulateTransaction(unsigned, { sigVerify: false });
    if (sim.value.err) {
      const logs = (sim.value.logs || []).join('\n');
      const lowSol = /insufficient (lamports|funds)/i.test(logs) || JSON.stringify(sim.value.err).includes('InsufficientFunds');
      return reply.code(400).send({
        error: lowSol
          ? 'Your wallet does not have enough SOL for this launch and first buy.'
          : `The launch would fail on chain: ${JSON.stringify(sim.value.err)}`,
      });
    }

    const id = randomUUID();
    await pool.query(
      `INSERT INTO launches (id, keypair_id, wallet, name, symbol, description, image_uri, banner_uri, metadata_uri,
                             website, twitter, telegram, dev_buy_sol, message_b64, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now() + interval '2 minutes')`,
      [id, kp.id, b.wallet, b.name, b.symbol, b.description, b.imageUri ?? null, b.bannerUri ?? null, b.metadataUri,
       b.website, b.twitter, b.telegram, b.devBuySol, Buffer.from(unsigned.message.serialize()).toString('base64')]);

    return { launchId: id, mint: kp.pubkey, transaction: Buffer.from(bytes).toString('base64') };
  });

  // ---------- 5. submit ----------
  app.post('/api/launch/submit', async (req, reply) => {
    const b = z.object({ launchId: z.string().uuid(), signedTransaction: z.string() }).parse(req.body);

    // Claim the launch row so a double click cannot send twice.
    const claimed = await tx(async (c) => {
      const { rows } = await c.query(
        `SELECT l.*, k.pubkey, k.sealed_secret, k.prefix FROM launches l JOIN coin_keypairs k ON k.id = l.keypair_id
          WHERE l.id=$1 FOR UPDATE OF l`, [b.launchId]);
      const l = rows[0];
      if (!l || l.status !== 'prepared') return { error: 'This launch was already submitted or does not exist.' };
      if (new Date(l.expires_at) < new Date()) return { error: 'This launch expired. Prepare it again.' };
      await c.query(`UPDATE launches SET status='sent' WHERE id=$1`, [b.launchId]);
      return { l };
    });
    if ('error' in claimed) return reply.code(409).send({ error: claimed.error });
    const l = claimed.l;

    let signed: VersionedTransaction;
    try {
      signed = VersionedTransaction.deserialize(Buffer.from(b.signedTransaction, 'base64'));
    } catch {
      await pool.query(`UPDATE launches SET status='prepared' WHERE id=$1`, [l.id]);
      return reply.code(400).send({ error: 'That is not a valid signed transaction.' });
    }

    // --- checks before the mint key signs anything ---
    const original = VersionedMessage.deserialize(Buffer.from(l.message_b64, 'base64'));
    const msg = signed.message;
    const keys = msg.staticAccountKeys.map((k) => k.toBase58());
    const fail = async (why: string) => {
      await pool.query(`UPDATE launches SET status='failed', error=$2 WHERE id=$1`, [l.id, why]);
      return reply.code(400).send({ error: why });
    };

    if (keys[0] !== l.wallet) return fail('The fee payer is not your wallet.');
    if (!keys.includes(l.pubkey)) return fail('The transaction does not create our mint.');
    if (!sameBytes(msg.serialize(), original.serialize())) {
      // Some wallets add safety instructions. Allow that, but nothing else new.
      const allowed = programIds(original);
      for (const p of programIds(msg)) {
        if (!allowed.has(p) && !WALLET_ADDED_PROGRAMS.has(p)) return fail(`The transaction calls a program we did not expect: ${p}`);
      }
    }
    const walletSig = signed.signatures[0];
    if (!walletSig || !nacl.sign.detached.verify(msg.serialize(), walletSig, new PublicKey(l.wallet).toBytes())) {
      return fail('Your wallet signature is missing or invalid.');
    }

    // --- add the mint signature and send ---
    // Sign with the raw secret, then wipe it. (A web3.js Keypair can't be wiped reliably:
    // its .secretKey getter returns a copy, and fromSecretKey() aliases its input.)
    const mintPub = new PublicKey(l.pubkey);
    const messageBytes = msg.serialize();
    const mintSecret = secretFromSealed(l.sealed_secret, l.pubkey);
    let mintSig: Uint8Array;
    try {
      mintSig = nacl.sign.detached(messageBytes, mintSecret);
    } finally {
      mintSecret.fill(0);
    }
    // Check our own work before the RPC does, so a bad signature fails with a clear message.
    if (!nacl.sign.detached.verify(messageBytes, mintSig, mintPub.toBytes())) {
      return fail('Internal error: the mint signature did not verify. Nothing was sent.');
    }
    signed.addSignature(mintPub, mintSig);

    let signature: string;
    try {
      signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 });
      const conf = await connection.confirmTransaction(
        { signature, blockhash: msg.recentBlockhash, lastValidBlockHeight: (await connection.getLatestBlockhash()).lastValidBlockHeight },
        'confirmed');
      if (conf.value.err) throw new Error(JSON.stringify(conf.value.err));
    } catch (e: any) {
      // The mint was not created, so the address is still unused and stays reserved for this wallet.
      await pool.query(`UPDATE launches SET status='failed', error=$2 WHERE id=$1`, [l.id, String(e?.message || e)]);
      return reply.code(502).send({ error: `The launch did not go through: ${e?.message || e}` });
    }

    await tx(async (c) => {
      await c.query(`UPDATE launches SET status='confirmed', signature=$2 WHERE id=$1`, [l.id, signature]);
      // The coin exists now. Destroy our copy of the mint secret.
      await c.query(`UPDATE coin_keypairs SET status='used', sealed_secret=NULL, used_at=now() WHERE id=$1`, [l.keypair_id]);
      await c.query(
        `INSERT INTO coins (mint, launch_id, name, symbol, prefix, creator, image_uri, banner_uri, description,
                            website, twitter, telegram)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (mint) DO NOTHING`,
        [l.pubkey, l.id, l.name, l.symbol, l.prefix, l.wallet, l.image_uri, l.banner_uri, l.description,
         l.website || null, l.twitter || null, l.telegram || null]);
    });

    // The coin's real starting price, straight from its bonding curve. This is what the coin
    // page shows before anyone else trades — including the creator's own buy, which happened
    // inside the create transaction and which no trade stream will ever report to us.
    const curve = await curveState(l.pubkey, true);
    const mc = curve?.marketCapSol;
    if (mc) await pool.query(`UPDATE coins SET market_cap_sol=$2 WHERE mint=$1`, [l.pubkey, mc]);

    // Record the launch (and dev buy) BEFORE subscribing to the coin's trades, so the
    // stream can't report the dev buy to us a second time as an ordinary buy.
    await publishEvent({ type: 'launch', mint: l.pubkey, prefix: l.prefix, wallet: l.wallet, signature, marketCapSol: mc });
    if (Number(l.dev_buy_sol) > 0) {
      await publishEvent({ type: 'dev', mint: l.pubkey, wallet: l.wallet, sol: Number(l.dev_buy_sol), marketCapSol: mc, signature: signature + ':dev' });
    }
    watchMint(l.pubkey);
    return { signature, mint: l.pubkey };
  });
}
