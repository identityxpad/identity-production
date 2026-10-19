# Identity — Deployment Guide

## Architecture

```
vast.ai GPU #1 (4x 5090)  ──► polls /worker/claim
vast.ai GPU #2 (4x 5090)  ──► polls /worker/claim
                                      │
                               ┌──────▼──────┐
Users ──────────────────────►  │  Railway     │
  (site + API on same server)  │  ┌────────┐  │
                               │  │Postgres│  │
                               │  └────────┘  │
                               └──────────────┘
```

## Step 1: Railway Setup

### Create the project

1. Go to [railway.app](https://railway.app) and create a new project
2. Add a **PostgreSQL** database (New → Database → PostgreSQL)
3. Add a **service** from your GitHub repo (New → GitHub Repo → select your repo)
4. Railway detects the `railway.json` and knows how to build

### Set environment variables

In Railway, go to your service → Variables and add:

```
DATABASE_URL          → (click the Postgres service, copy the DATABASE_URL — Railway can auto-link this)
SOLANA_RPC_URL        → https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY
BOX_SECRET_KEY        → (generate: node -e "console.log(require('tweetnacl').box.keyPair().secretKey.toString('base64'))")
WORKER_TOKEN          → (generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
CORS_ORIGINS          → https://yourdomain.com
PUBLIC_API_URL        → https://yourdomain.com
PORT                  → 8080

# GPU config — 4 GPUs per instance, 2 instances = 8 total
GPU_COUNT             → 8
GPU_RATE              → 1250000000

# Token gate (leave IDENTITY_MINT empty until you launch your coin)
IDENTITY_MINT         →
TOKEN_GATE_AMOUNT     → 100000

# Private beta password (remove to go public)
SITE_PASSWORD         → your-secret-password

# Admin endpoint protection
ADMIN_TOKEN           → (generate another random string)
```

### Custom domain

In Railway → service → Settings → Domains:
- Add your custom domain (e.g. `identity.yourdomain.com`)
- Point your DNS CNAME to the Railway-provided domain
- Railway handles HTTPS automatically

## Step 2: Generate Keys

SSH into any machine with Node.js, or run in Railway's shell:

```bash
# Generate BOX_SECRET_KEY (NaCl box keypair — this is what seals/unseals ground secrets)
node -e "const nacl=require('tweetnacl'); const kp=nacl.box.keyPair(); console.log('secret:', Buffer.from(kp.secretKey).toString('base64')); console.log('public:', Buffer.from(kp.publicKey).toString('base64'))"

# Generate WORKER_TOKEN
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Generate ADMIN_TOKEN
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Save the BOX_SECRET_KEY — if you lose it, you can't unseal any ground keypairs in your DB.

## Step 3: vast.ai GPU Workers

The worker lives in `backend/worker/`. It runs one Node process per GPU; each one
claims a job over HTTPS, grinds with `vanity`, seals the secret key to your box
public key, and reports it back. No inbound ports are needed on the GPU box.

### Rent the instance

On vast.ai pick an image with the CUDA **devel** toolkit (e.g.
`nvidia/cuda:12.6-devel-ubuntu22.04`) — the runtime-only image has no `nvcc` and
the GPU build of `vanity` will not compile. 4x RTX 5090 is a good unit.

### Set it up

SSH in, clone your repo, then:

```bash
cd identity/backend/worker
bash setup-gpu-box.sh
```

That installs Rust, builds `vanity` with `--features=gpu`, installs Node 20,
builds the worker, and runs a 6-letter benchmark. **Note the attempts/sec it
prints** and put that number in the API's `GPU_RATE` so the live ETAs are honest.

### Configure and start

```bash
cp worker.env.example worker.env
nano worker.env          # API_URL, WORKER_TOKEN, BOX_PUBLIC_KEY
bash run-workers.sh      # starts one worker per GPU
```

`BOX_PUBLIC_KEY` is the **public** half — fetch it from your running API:

```bash
curl -s https://yourdomain.com/api/health
```

Never put `BOX_SECRET_KEY` on a GPU box. The workers only ever encrypt to the
public key; only your API can decrypt.

Watch and stop them with:

```bash
tail -f logs/gpu*.log
pkill -f dist/worker.js
```

### Testing without a GPU

Set `GRINDER=solana-keygen` in `worker.env` to grind on CPU instead. Thousands of
times slower, but it exercises the whole loop (claim → grind → seal → complete)
so you can verify the pipeline before renting anything.

### Dedicated lanes

`MAX_LEN` is the lane control — it caps the longest prefix a worker will accept.
Run one box with `MAX_LEN=6` so short tickers stay instant, and another with
`MAX_LEN=12` to chew through the long ones. Without this, a single 8-character
job can occupy every GPU you have.

## Step 4: Verify Everything Works

1. Open `https://yourdomain.com` — you should see the password page
2. Enter your `SITE_PASSWORD` — you should see the Identity site
3. Check the API: `curl https://yourdomain.com/api/health` — should return `{"ok":true,"boxPublicKey":"..."}`
4. Check GPU workers are connected: watch your Railway logs for `[grind] worker gpu-1 claimed job ...`

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| DATABASE_URL | yes | — | Postgres connection string |
| SOLANA_RPC_URL | yes | — | Helius or other Solana RPC |
| BOX_SECRET_KEY | yes | — | NaCl box secret (base64), unseals ground keys |
| WORKER_TOKEN | yes | — | Shared secret for GPU workers |
| PORT | no | 8080 | Server port |
| CORS_ORIGINS | no | localhost | Allowed origins (comma separated) |
| PUBLIC_API_URL | no | — | Public URL of this API (for banner links) |
| GPU_COUNT | no | 2 | Total GPUs across all workers |
| GPU_RATE | no | 1.25e9 | Attempts/sec per GPU (for ETAs) |
| IDENTITY_MINT | no | — | SPL mint for token gate (empty = disabled) |
| TOKEN_GATE_AMOUNT | no | 100000 | Tokens required for vanity wallets |
| BURN_AMOUNT | no | 0 (off) | $IDENTITY burned (from the user's wallet) to reveal a vanity key; needs IDENTITY_MINT |
| SITE_PASSWORD | no | — | Password gate (empty = public) |
| ADMIN_TOKEN | no | — | Protects /admin/* routes |
| DB_POOL_MAX | no | 25 | Max Postgres connections |
| LONG_GPUS_PER_LANE | no | 2 | Max GPUs per lane (coin / wallet) on 7–8 letter jobs at once; the rest stay free for short ones |
| ABANDON_MINUTES | no | 10 | Cancel a grind whose page stopped checking in for this long |
| MAX_QUEUED_LONG | no | 6 | Max long coin-address jobs queued site-wide |
| MAX_QUEUED_LONG_WALLET | no | 6 | Max long vanity-wallet jobs queued site-wide |
| CHAIN_RPC_BUDGET | no | 6 | Max RPC calls/second for reading live trades (Helius free ≈ 10) |
