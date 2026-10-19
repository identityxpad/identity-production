// All settings come from environment variables. See .env.example for the full list.

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

function num(name: string, def: number): number {
  const v = process.env[name];
  return v ? Number(v) : def;
}

const publicUrl = (process.env.PUBLIC_API_URL || '').replace(/\/$/, '');

export const config = {
  port: num('PORT', 8080),
  // Written into every coin's metadata as "createdOn", which is permanent once a coin
  // launches. The site and API share a server, so the API's public URL is the right
  // fallback — never a placeholder that would end up on-chain.
  siteUrl: (process.env.SITE_URL || publicUrl || 'https://example.com').replace(/\/$/, ''),
  databaseUrl: req('DATABASE_URL'),
  rpcUrl: req('SOLANA_RPC_URL'),
  // Origins allowed to call the API from a browser (your site), comma separated.
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',').map((s) => s.trim()),

  // Server box keypair (base64). Workers seal ground secret keys to the public half;
  // only this server can open them. Generate with `npm run gen-keys`.
  boxSecretKey: req('BOX_SECRET_KEY'),

  // Shared secret the GPU workers send as a Bearer token.
  workerToken: req('WORKER_TOKEN'),

  // Where coin images + metadata go: "pumpfun" (pump.fun's IPFS endpoint, default) or "pinata".
  metadataUpload: (process.env.METADATA_UPLOAD || 'pumpfun') as 'pumpfun' | 'pinata' | 'self',
  pumpFunIpfsUrl: process.env.PUMPFUN_IPFS_URL || 'https://pump.fun/api/ipfs',
  pinataJwt: process.env.PINATA_JWT || '',   // optional: only for METADATA_UPLOAD=pinata or as a fallback
  ipfsGateway: process.env.IPFS_GATEWAY || 'https://ipfs.io/ipfs/',
  // Public URL of this API (used for banner links), e.g. https://api.yoursite.com
  publicApiUrl: (process.env.PUBLIC_API_URL || '').replace(/\/$/, ''),

  pumpPortalTradeLocal: process.env.PUMPPORTAL_TRADE_LOCAL || 'https://pumpportal.fun/api/trade-local',
  pumpPortalWs: process.env.PUMPPORTAL_WS || 'wss://pumpportal.fun/api/data',
  // pump.fun's bonding-curve program. Coin market caps are read from its curve accounts.
  pumpProgramId: process.env.PUMP_PROGRAM_ID || '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',

  // Grinding policy
  minTicker: num('MIN_TICKER', 2),
  maxTicker: num('MAX_TICKER', 8),          // longest prefix we will grind
  fastLaneMax: num('FAST_LANE_MAX', 6),     // prefixes up to this length are "fast lane"
  gpuRate: num('GPU_RATE', 1.25e9),         // attempts/sec per GPU, used only for ETAs
  gpuCount: num('GPU_COUNT', 2),
  reserveMinutes: num('RESERVE_MINUTES', 30), // how long a ground address is held for its wallet
  longJobsPerWalletPerDay: num('LONG_JOBS_PER_WALLET_PER_DAY', 1),
  maxQueuedLong: num('MAX_QUEUED_LONG', 6),
  jobLeaseSeconds: num('JOB_LEASE_SECONDS', 90),
  // Heavy-use protection. At most this many GPUs per lane (coin / wallet) work on long prefixes
  // at once, so the other GPUs always stay free for short requests. With 4 GPUs per lane, 2.
  longGpusPerLane: num('LONG_GPUS_PER_LANE', 2),
  // A job whose page stops checking in for this long is cancelled and its GPU freed. Browsers
  // keep checking (at least once a minute) while the tab is open, even in the background.
  abandonMinutes: num('ABANDON_MINUTES', 10),
  maxQueuedLongWallet: num('MAX_QUEUED_LONG_WALLET', 6),
  // Live trade reading: the most RPC calls per second the chain reader may make (Helius free
  // plan allows ~10). Busy coins are polled less often rather than going over it.
  chainRpcBudget: num('CHAIN_RPC_BUDGET', 6),

  // How long a ground vanity wallet stays downloadable before its secret is wiped.
  walletKeyTtlMinutes: num('WALLET_KEY_TTL_MINUTES', 10),

  // Token gate: users must hold this many of the Identity coin to use vanity wallets.
  // Set IDENTITY_MINT to the SPL mint address of the Identity coin. Leave empty to disable the gate.
  identityMint: process.env.IDENTITY_MINT || '',
  tokenGateAmount: num('TOKEN_GATE_AMOUNT', 100_000),
  // Burn to reveal: how many $IDENTITY (IDENTITY_MINT) a user burns to unlock a vanity
  // wallet's private key. 0 = off (reveal is free, as before).
  burnAmount: num('BURN_AMOUNT', 0),


  // Tickers kept pre-ground in the pool when GPUs are idle (comma separated).
  poolTickers: (process.env.POOL_TICKERS || 'fire,moon,pepe,doge,cat,frog,based,gm,wagmi,bonk,apes,zen,neko,ghost,orbit,void')
    .split(',').map((s) => s.trim()).filter(Boolean),
  poolTarget: num('POOL_TARGET', 3),

  // Launch watcher. Public addresses only (never keys). Comma separated.
  watchMints: (process.env.WATCH_MINTS || '').split(',').map((s) => s.trim()).filter(Boolean),
  featuredMints: (process.env.FEATURED_MINTS || '').split(',').map((s) => s.trim()).filter(Boolean),
  watchPollSeconds: num('WATCH_POLL_SECONDS', 20),
  // Protects /admin/* (add/remove watched addresses, feature or hide coins). Empty = admin disabled.
  adminToken: process.env.ADMIN_TOKEN || '',
  solPriceUrl: process.env.SOL_PRICE_URL || 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',

  // Optional: words that cannot be launched (one per line in this file). Empty by default.
  blocklistFile: process.env.BLOCKLIST_FILE || '',

  // Simple password gate for private testing. Set SITE_PASSWORD to enable.
  // When set, all site pages and API calls (except /api/health and /worker/*) require
  // this password via a cookie. Leave empty to disable.
  sitePassword: process.env.SITE_PASSWORD || '',
};
