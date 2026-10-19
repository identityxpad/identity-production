# How Identity handles keys

This repository is public so the claims on the site can be checked against the
code. This file points at the lines that matter.

## The short version

A vanity address is found by generating random keypairs until one starts with
your ticker. That search runs on our GPUs, not in your browser. So for a moment,
a private key exists on hardware we rent — and the rest of this document is about
making that moment as small and as useless to an attacker as possible.

## Keys are encrypted before they leave the grinder

A GPU worker never sends a raw private key. It encrypts each one to the server's
NaCl box **public** key, using a throwaway keypair and a random nonce:

    base64( ephemeral public key[32] | nonce[24] | ciphertext )

See `backend/worker/src/worker.ts` (`seal`) and `backend/api/src/sealed.ts`.

The GPU boxes only ever hold `BOX_PUBLIC_KEY`. That key can encrypt and cannot
decrypt. A rented machine that is compromised, or resold with the disk intact,
yields nothing that opens a key.

## Only the API server can decrypt

`BOX_SECRET_KEY` lives in the API's environment and nowhere else. It is not in
this repository, not in the database, and not on any GPU box. Every decryption
in the system goes through `openSealed()` in `backend/api/src/sealed.ts`, called
from exactly three places:

| Where | Why |
|---|---|
| `grind.ts` `/worker/complete` | Verify a worker's result really matches the address it claims, then discard |
| `wallet.ts` keypair download | Hand your key to you, once |
| `launch.ts` launch send | Sign the pump.fun create transaction with the mint key, once |

## Your key is deleted when you take it

Revealing a vanity wallet key unseals it and nulls the column in the same
request (`wallet.ts`). Ask a second time and you get a 410, because the row no
longer holds anything. A key you never reveal is wiped after
`WALLET_KEY_TTL_MINUTES` (default 10) by `purgeUnclaimedWalletKeys()`.

A coin's mint key is wiped the moment the launch transaction is sent
(`launch.ts`). It signs once and is never used again.

## What a stolen database would give an attacker

Nothing it can spend. Rows hold ciphertext, and the key that opens it is not in
the database. The two must be stolen together, and the only rows worth stealing
are mint keys for coins not yet launched, plus any wallet ground in the last ten
minutes and not yet collected.

## What we do not claim

- Grinding happens on our servers, not in your browser. Between finding your key
  and you taking it, we could read it. The design shrinks that window; it cannot
  remove it. If you want a key no one else could ever have touched, generate it
  yourself offline — that is a real alternative and we would rather say so.
- Rented GPUs are third-party hardware. The sealing above is what makes that
  acceptable, not a claim that the hardware is trusted.
- `SOLANA_RPC_URL`, hosting, and pump.fun are third parties with their own
  visibility into what passes through them.

## Reporting something

If you find a flaw in any of this, please open an issue describing the path
rather than posting a working exploit.
