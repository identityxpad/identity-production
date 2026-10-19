#!/usr/bin/env node
/*
  Learning tool — manually unseal a vanity keypair, step by step.

  Every secret a GPU worker produces is encrypted to the server's box PUBLIC key
  before it leaves the worker. Only BOX_SECRET_KEY can open it. This script does
  by hand exactly what openSealed() in src/sealed.ts does on the server, printing
  each stage so you can see the structure.

  Two ways to run it, from backend/api:

  A) Pull the newest un-collected wallet straight from the database:

       node unseal.js --latest

     Queue one first, so the browser never auto-collects it:

       INSERT INTO grind_jobs (prefix, type, wallet)
       VALUES ('test', 'wallet', 'manual-learning-session-0001');

     Your GPU worker grinds it and the sealed secret then sits in
     wallet_keypairs for the full TTL. Needs DATABASE_URL set.

  B) Paste a blob you copied yourself:

       node unseal.js '<sealed_secret>' '<pubkey>'

  BOX_SECRET_KEY comes from the environment, or as a third argument.
  Run this on your own machine, never on a rented GPU box.
*/
const nacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');

const argv = process.argv.slice(2);
const useLatest = argv.includes('--latest');
const [sealedArg, pubkeyArg, boxKeyArg] = argv.filter((a) => !a.startsWith('--'));
const boxSecretB64 = boxKeyArg || process.env.BOX_SECRET_KEY;

if (!boxSecretB64 || (!useLatest && !sealedArg)) {
  console.error('Usage: node unseal.js --latest');
  console.error('   or: node unseal.js <sealed_secret> [pubkey] [box_secret_key]');
  console.error('       BOX_SECRET_KEY can come from the environment instead.');
  process.exit(2);
}

async function fetchLatest() {
  if (!process.env.DATABASE_URL) {
    console.error('\n  --latest needs DATABASE_URL. Use the PUBLIC url from Railway:');
    console.error('    Postgres service -> Variables -> DATABASE_PUBLIC_URL');
    console.error('    export DATABASE_URL="postgresql://...proxy.rlwy.net:43xxx/railway"\n');
    process.exit(2);
  }
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 8000 });
  try {
    const { rows } = await pool.query(
      `SELECT pubkey, sealed_secret, status, session_token,
              GREATEST(0, EXTRACT(EPOCH FROM (expires_at - now())))::int AS seconds_left
         FROM wallet_keypairs
        WHERE sealed_secret IS NOT NULL
        ORDER BY id DESC LIMIT 1`,
    );
    if (!rows[0]) {
      console.error('\n  No wallet row still holds a sealed secret.');
      console.error('  Either none has been ground, or every one was collected or expired.');
      console.error('  Queue one that the browser will not auto-collect:\n');
      console.error("    INSERT INTO grind_jobs (prefix, type, wallet)");
      console.error("    VALUES ('test', 'wallet', 'manual-learning-session-0001');\n");
      process.exit(1);
    }
    const r = rows[0];
    console.log('\n── 0. Row pulled from wallet_keypairs ────────────────────────');
    console.log(`  pubkey                 ${r.pubkey}`);
    console.log(`  status                 ${r.status}`);
    console.log(`  session_token          ${r.session_token}`);
    console.log(`  wiped in               ${r.seconds_left}s  (${Math.floor(r.seconds_left / 60)}m ${r.seconds_left % 60}s)`);
    return { sealed: r.sealed_secret, pubkey: r.pubkey };
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error('\n  ' + (e.message || e) + '\n'); process.exit(1); });

async function main() {
  const src = useLatest ? await fetchLatest() : { sealed: sealedArg, pubkey: pubkeyArg };
  run(src.sealed, src.pubkey);
}

function run(sealedB64, expectedPubkey) {

const line = (label, value) => console.log(`  ${label.padEnd(22)} ${value}`);

console.log('\n── 1. The sealed blob ────────────────────────────────────────');
const raw = Buffer.from(sealedB64, 'base64');
line('base64 length', `${sealedB64.length} chars`);
line('decoded length', `${raw.length} bytes`);

console.log('\n── 2. Split into its three parts ─────────────────────────────');
// Layout the worker wrote: ephemeral public key | nonce | ciphertext
const ephPub = raw.subarray(0, 32);
const nonce = raw.subarray(32, 56);
const ciphertext = raw.subarray(56);
line('ephemeral pubkey', `${ephPub.length} bytes  ${ephPub.toString('hex').slice(0, 32)}...`);
line('nonce', `${nonce.length} bytes  ${nonce.toString('hex').slice(0, 32)}...`);
line('ciphertext', `${ciphertext.length} bytes  ${ciphertext.toString('hex').slice(0, 32)}...`);
console.log('\n  The worker generated a throwaway keypair for this one message and');
console.log('  threw the private half away. That is why each blob is unique even');
console.log('  when the same key is sealed twice.');

console.log('\n── 3. Derive the server box keypair ──────────────────────────');
const boxSecret = Buffer.from(boxSecretB64, 'base64');
if (boxSecret.length !== 32) {
  console.error(`\n  BOX_SECRET_KEY must decode to 32 bytes, got ${boxSecret.length}.`);
  process.exit(1);
}
const serverBox = nacl.box.keyPair.fromSecretKey(boxSecret);
line('box public key', Buffer.from(serverBox.publicKey).toString('base64'));
console.log('  ^ this is what the GPU workers hold. It can encrypt, never decrypt.');

console.log('\n── 4. Decrypt ────────────────────────────────────────────────');
const secret = nacl.box.open(ciphertext, nonce, ephPub, serverBox.secretKey);
if (!secret) {
  console.error('  FAILED — wrong BOX_SECRET_KEY, or the blob is corrupt.');
  console.error('  Nothing else can open it. This is the whole point of the design.');
  process.exit(1);
}
line('plaintext length', `${secret.length} bytes (a Solana keypair: 32 seed + 32 public)`);

console.log('\n── 5. The keypair itself ─────────────────────────────────────');
const derived = nacl.sign.keyPair.fromSecretKey(secret);
const derivedPub = bs58.encode(Buffer.from(derived.publicKey));
line('private key (base58)', bs58.encode(Buffer.from(secret)));
line('public key (address)', derivedPub);

if (expectedPubkey) {
  const ok = derivedPub === expectedPubkey;
  console.log();
  line('expected address', expectedPubkey);
  line('match?', ok ? 'YES — this blob really holds that wallet' : 'NO — mismatch');
  if (!ok) process.exit(1);
}

console.log('\n  That base58 private key imports straight into Phantom.');
console.log('  The server does this once at download, then wipes the column.\n');

secret.fill(0);
}
