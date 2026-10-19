import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { config } from './config';

// Workers encrypt each ground secret key to the server's box public key ("sealed").
// Format: base64(ephemeralPublicKey[32] | nonce[24] | ciphertext)

const serverBox = nacl.box.keyPair.fromSecretKey(Buffer.from(config.boxSecretKey, 'base64'));

export function serverBoxPublicKeyB64(): string {
  return Buffer.from(serverBox.publicKey).toString('base64');
}

export function openSealed(sealedB64: string): Uint8Array {
  const raw = Buffer.from(sealedB64, 'base64');
  const ephPub = raw.subarray(0, 32);
  const nonce = raw.subarray(32, 56);
  const ct = raw.subarray(56);
  const out = nacl.box.open(ct, nonce, ephPub, serverBox.secretKey);
  if (!out) throw new Error('Could not open sealed secret');
  return out;
}

/**
 * Opens a sealed secret and checks it is the 64-byte Solana keypair for expectedPubkey.
 * Returns the raw secret. THE CALLER MUST ZERO IT (secret.fill(0)) when done.
 *
 * Deliberately not a web3.js Keypair: Keypair.fromSecretKey() keeps a reference to the
 * array it is given rather than copying it, so wiping our buffer would silently wipe the
 * Keypair's key too — its public key still looks right, but everything it signs is
 * invalid. That bug made every launch fail signature verification.
 */
export function secretFromSealed(sealedB64: string, expectedPubkey: string): Uint8Array {
  const secret = openSealed(sealedB64);
  try {
    if (secret.length !== 64) throw new Error('Sealed secret has the wrong length');
    const derived = nacl.sign.keyPair.fromSecretKey(secret);
    if (bs58.encode(derived.publicKey) !== expectedPubkey) throw new Error('Sealed secret does not match its pubkey');
    return secret;
  } catch (e) {
    secret.fill(0);
    throw e;
  }
}

/** Opens a sealed secret as a Keypair holding its own copy of the key. */
export function keypairFromSealed(sealedB64: string, expectedPubkey: string): Keypair {
  const secret = secretFromSealed(sealedB64, expectedPubkey);
  try {
    return Keypair.fromSecretKey(Uint8Array.from(secret)); // copy — see secretFromSealed
  } finally {
    secret.fill(0);
  }
}

/** Checks a sealed secret without keeping the key around. Used when a worker reports a result. */
export function verifySealed(sealedB64: string, pubkey: string, prefix: string): void {
  // Matching is case-insensitive ("stylized"), so compare in lower case.
  if (!pubkey.toLowerCase().startsWith(prefix.toLowerCase())) throw new Error(`Pubkey ${pubkey} does not start with ${prefix}`);
  bs58.decode(pubkey); // throws on malformed
  secretFromSealed(sealedB64, pubkey).fill(0);
}
