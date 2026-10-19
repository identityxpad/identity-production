# identity/ backend

The backend for Identity, a pump.fun launchpad where every coin's contract address starts with its lowercase ticker.

```
 browser (your site)                 API server (Railway)                      GPU box (2x RTX 5090)
 ───────────────────                 ──────────────────────                    ─────────────────────
 launch form ──── /api/metadata ───▶ image + metadata → pump.fun IPFS
             ──── /api/grind ──────▶ pool hit? reserve it. else queue a job ◀── /worker/claim   (worker per GPU)
             ◀─── /api/grind/:id ─── status + ETA                            ◀── /worker/complete (sealed key)
             ──── /api/launch/prepare ▶ PumpPortal builds the create tx
 wallet signs ─── /api/launch/submit ─▶ checks tx, adds mint signature, sends, confirms, deletes key
 feed / coins ◀── /api/feed/stream ──── trades from PumpPortal's data websocket
```

- **api/**: Fastify + Postgres. Validates tickers, runs the grind queue, uploads metadata, builds and co-signs launches, serves coins and the live feed.
- **worker/**: runs on the GPU machine, one process per GPU. Claims jobs, runs the [`vanity`](https://crates.io/crates/vanity) GPU grinder, seals each key to the API's public key and reports it.

## How a launch works

1. The browser uploads the image, optional banner and text to `/api/metadata`. The image and metadata go to pump.fun's own IPFS endpoint, the one most launchpads use, so no extra account is needed. Banners are stored in our database, because pump.fun has no banner field. If pump.fun ever refuses uploads from your server, set `METADATA_UPLOAD=pinata` (or just add a `PINATA_JWT` and it becomes an automatic fallback).
2. `/api/grind` with the ticker and the user's wallet. If the pool already holds an address with that prefix, it's reserved for the wallet right away. Otherwise a job is queued and the browser polls `/api/grind/:id` for status and an ETA.
3. `/api/launch/prepare` asks PumpPortal (`/api/trade-local`, action `create`) for a create transaction where the fee payer is the user's wallet and the mint is our ground address. It simulates the transaction first, so problems like low SOL show up as a clear error instead of a wallet warning.
4. The user's wallet signs it first (`signTransaction`). This is the order Phantom recommends for transactions with extra signers.
5. `/api/launch/submit` checks the signed transaction:
   - the fee payer is the user,
   - it creates our mint,
   - it is the transaction PumpPortal built, or that transaction plus wallet safety instructions,
   - the user's signature is valid.

   The API then adds the mint signature, sends and confirms the transaction, deletes the mint secret, records the coin and posts it to the feed.

The user's wallet pays and signs. Identity never holds user funds.

## Key safety

- Workers seal each ground secret to the API's box public key (X25519 + XSalsa20-Poly1305 via tweetnacl). Only the API server can open it, and the database only stores sealed secrets.
- The API opens a secret only to sign the launch. It wipes the buffer afterwards and sets `sealed_secret = NULL` once the coin is confirmed.
- If a reservation expires without a launch, the secret never left the server. The address goes back to the pool.
- **Rented GPUs.** Whoever runs the GPU machine could in theory read memory while a key is being ground. A leaked mint key lets someone create that mint first, which steals the address before your user launches. To reduce the risk:
  - rent "secure cloud" or verified datacenter hosts,
  - keep the time between grind and launch short (`RESERVE_MINUTES`),
  - move to your own hardware once volume justifies it.

  After launch the key is worthless, because pump.fun's program controls the mint.

## Setup

### 1. API server on Railway

1. Generate keys once on your computer: `cd api && npm install && npm run build && npm run gen-keys`. Keep the output.
2. Push this repo to GitHub. In Railway: **New Project → Deploy from GitHub repo**, and set the service's **Root Directory** to `api`. It builds from the Dockerfile (`railway.json` is included).
3. In the same project: **New → Database → PostgreSQL**. In the API service's variables, set `DATABASE_URL` to `${{Postgres.DATABASE_URL}}`.
4. Add the rest of the variables from `.env.example`:
   - `SOLANA_RPC_URL` is your Helius RPC URL, which covers everything Solana-side.
   - Paste `BOX_SECRET_KEY` and `WORKER_TOKEN` from step 1.
   - Set `PUBLIC_API_URL` to the service's Railway domain (Settings → Networking → Generate Domain), or a custom one like `api.yoursite.com`.
   - Railway sets `PORT` itself.
5. Deploy, then open `https://<your-api-domain>/api/health`. It should return `{"ok":true,...}`. The database schema is created automatically on first start.

Using a VPS instead? `cp .env.example .env`, fill it in, and run `docker compose up -d --build`.

What you need in total:
- **Railway** for the API and Postgres.
- **Helius** for the Solana RPC. The free tier works for testing; move to a paid plan before launch day.
- **Vast.ai** for the GPUs.

Nothing else is required.

### 2. GPU machine (Vast.ai, 2x RTX 5090)

Pick a template with the CUDA **devel** toolkit (it needs `nvcc`). Then:

```bash
git clone <this repo> && cd identity-backend/worker
bash setup-gpu-box.sh          # installs Rust, vanity (GPU build), Node; runs a 6-letter benchmark
cp worker.env.example worker.env   # API_URL, WORKER_TOKEN, BOX_PUBLIC_KEY
bash run-workers.sh            # GPU 0 = fast lane (≤6 letters), GPU 1 = any length
```

Put the benchmark's attempts/sec in `GPU_RATE` in the API's `.env` so the ETAs users see are accurate.

No GPU yet? Set `GRINDER=solana-keygen` to test the whole flow on a CPU with 2–4 letter tickers.

### 3. Website

Set the API URL at the top of the site's script: `window.IDENTITY_API = 'https://api.yoursite.com'`. Without it, the site runs in demo mode with example data.

## API

| Method | Path | What it does |
|---|---|---|
| GET | `/api/check?ticker=` | Validity, prefix, expected attempts and seconds, lane, pool count |
| POST | `/api/grind` `{ticker, wallet}` | `ready` with `keypairId` and `pubkey`, or `queued` with `jobId` and ETA |
| GET | `/api/grind/:id` | Job status and ETA, or `ready` with `pubkey` |
| POST | `/api/metadata` (multipart) | `image`, optional `banner`, `name`, `symbol`, `description`, `website`, `twitter`, `telegram` → `metadataUri` |
| POST | `/api/launch/prepare` | `{keypairId, wallet, name, symbol, metadataUri, devBuySol, slippage, priorityFee, …}` → base64 unsigned tx |
| POST | `/api/launch/submit` | `{launchId, signedTransaction}` → `{signature, mint}` |
| GET | `/api/coins?view=&sort=&q=` | Coins launched through Identity |
| GET | `/api/feed`, `/api/feed/stream` | Recent events and a live SSE stream |
| GET | `/api/stats` | Numbers for the stats strip |

Workers use `/worker/claim`, `/worker/heartbeat`, `/worker/complete` and `/worker/fail` with `Authorization: Bearer WORKER_TOKEN`.

## Grind queue and limits

- Jobs are ordered shortest prefix first, and user jobs always run before pool pre-grinding.
- GPU 0 only takes prefixes up to 6 letters, so a 7–8 letter grind can never hold up a normal launch.
- Each wallet can have one active job at a time. Long tickers (7+ letters) are limited to 1 per wallet per day, and at most 6 can be queued at once.
- When GPUs are idle, the pool keeps 3 ready addresses for each ticker in `POOL_TICKERS`.
- Nothing public reveals which tickers are being ground. The queue is private, and the feed only shows coins after they launch, so snipers get no early warning.
- If a worker stops heart-beating for 90 s, its job goes back into the queue.

## What two RTX 5090s handle

The figures below assume ~1.25 billion attempts/sec per GPU. That's the RTX 4090 measured by the vanity author; the 5090 should be at least that fast, so replace it with your own benchmark.

| Ticker length | One grind, average | 10 people at once (2 GPUs): average wait / last one done (typical, worst 1 in 20) |
|---|---|---|
| 4 | ~0.01 s | everyone in ~2–5 s (startup time dominates) |
| 5 | ~0.5 s | ~6 s / ~11 s (12 s) |
| 6 | ~30 s | ~1.5 min / ~2.8 min (4.6 min) |
| 7 | ~29 min | ~1.4 h / ~2.6 h (4.3 h) |
| 8 | ~28 h | days. This is why long tickers are rationed and queued |

These come from a simulation of 10 simultaneous jobs on 2 GPUs, with random grind times and 1.5 s of startup per job. Grind time is luck-based: about 1 grind in 20 takes three times the average.

**Rented 24/7, two 5090s cost about $25–40 a day** on Vast.ai (about $0.53–0.80/hour each in mid-October 2026). Since Identity is free, that's your cost. Ways to cut it:
- run one GPU around the clock and start the second through Vast's API only when the queue is long,
- use interruptible instances: a restarted job loses its progress, but the lease system re-queues it.

## Limits of this version

- **PumpPortal's create endpoint takes:** name, symbol, metadata URI, mint, first buy, slippage, priority fee and pool.
- **Not supported yet:** pump.fun's mayhem mode, the USDC pair and "creator rewards to holders" aren't in that API. Adding them means building the pump program instructions directly with pump.fun's own SDK instead of PumpPortal.
- **Banners:** they're stored and shown on Identity, but pump.fun's own page won't display them, for the same reason.
- **The `vanity` grinder takes one prefix per run.** A grinder that checks many prefixes at once would let 10 simultaneous 6-letter jobs finish in about 2.3× the time of one instead of 5×. That's the next big speed-up.
- **The feed listens for trades only on coins launched here.** Holder milestones need an indexer or a Helius webhook; that hook isn't wired up yet.

## Testing before you deploy

`test/e2e.sh` runs the whole grind pipeline against a real Postgres: ticker checks, queueing, workers grinding and returning sealed keys, reservations, the pool, expiry, worker auth, forged-key rejection, the retry cap, and the site endpoints. `test/fake-vanity.js` stands in for the GPU grinder (same flags and output format, CPU speed), so you can run it on any machine.

```bash
# Postgres running locally, API env loaded, then:
cd api && npm run build && node dist/index.js &
cd ../worker && npm run build && VANITY_BIN=../test/fake-vanity.js API_URL=http://127.0.0.1:8080 \
  WORKER_TOKEN=... BOX_PUBLIC_KEY=... node dist/worker.js &
bash ../test/e2e.sh   # edit the A= line at the top to match your port
```

Last run: 23/23 passed (grinding) and 29/29 (launch watcher, see below).

**Not covered by the test (needs mainnet):** building the create transaction through PumpPortal, the wallet signing it, sending and confirming it on Solana, the pump.fun image upload and the live trade feed. Do your first real launch with a cheap test coin and a tiny first buy.

## Launch watcher: coins launched elsewhere (e.g. Proxima)

Give the backend the **public addresses** you ground yourself. Each stays hidden until it becomes a real coin. The moment it launches, from Proxima or anywhere else, it shows up on the site with its name, ticker, image, description, X/Telegram/website links and live market cap, and a "is live" post goes into the feed.

Two ways a launch is detected:
1. **Instantly**, from PumpPortal's new-coin stream.
2. **Within 20 seconds**, from a backup check against your Helius RPC. This also catches coins that launched before the backend was running.

If a coin's image hasn't loaded on IPFS yet at launch, the backend keeps retrying for a day.

**Set up in Railway variables:**
- `WATCH_MINTS`: addresses to watch, comma separated.
- `FEATURED_MINTS`: addresses pinned to the top of the grid.
- `ADMIN_TOKEN`: a long random password for the commands below.

**Admin commands** (PowerShell; replace the URL and token):
```powershell
$api = "https://YOUR-API.up.railway.app"; $h = @{ Authorization = "Bearer YOUR_ADMIN_TOKEN" }

# watch another pre-ground address (add -featured if you want it pinned)
Invoke-RestMethod -Method Post "$api/admin/watch" -Headers $h -ContentType "application/json" -Body '{"mint":"PUBLIC_ADDRESS","featured":false}'

# see everything you're watching and what's live
Invoke-RestMethod "$api/admin/watch" -Headers $h

# reload a coin's name, image and links
Invoke-RestMethod -Method Post "$api/admin/coins/PUBLIC_ADDRESS/refresh" -Headers $h

# take a coin off the site (e.g. a test launch)
Invoke-RestMethod -Method Delete "$api/admin/coins/PUBLIC_ADDRESS" -Headers $h
```

Only ever paste public addresses. The admin API rejects anything that isn't a valid Solana address.

`test/watch-test.sh` (with `test/fake-chain.js`) tests all of this against a fake PumpPortal stream and RPC. Last run: 29/29 passed.
