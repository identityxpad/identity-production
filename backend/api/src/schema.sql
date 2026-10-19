-- Identity database schema. Safe to run more than once.
--
-- REFERENCE COPY ONLY. The server no longer reads this file at runtime.
-- The live schema is src/schema.ts — edit that one, or your change won't ship.

CREATE TABLE IF NOT EXISTS grind_jobs (
  id            BIGSERIAL PRIMARY KEY,
  prefix        TEXT NOT NULL,
  wallet        TEXT,
  status        TEXT NOT NULL DEFAULT 'queued',
  worker        TEXT,
  lease_until   TIMESTAMPTZ,
  attempts      BIGINT,
  error         TEXT,
  keypair_id    BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);
ALTER TABLE grind_jobs ADD COLUMN IF NOT EXISTS fails INT NOT NULL DEFAULT 0;
ALTER TABLE grind_jobs ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'coin';
CREATE INDEX IF NOT EXISTS grind_jobs_queue ON grind_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS grind_jobs_wallet ON grind_jobs (wallet, created_at);
CREATE INDEX IF NOT EXISTS grind_jobs_type ON grind_jobs (type, status);
CREATE INDEX IF NOT EXISTS grind_jobs_keypair ON grind_jobs (keypair_id) WHERE keypair_id IS NOT NULL;
-- When the requester's page last checked on the job. A job nobody is waiting for any more is
-- cancelled (status 'cancelled') so it stops holding a GPU.
ALTER TABLE grind_jobs ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS grind_jobs_active ON grind_jobs (status, type, last_seen) WHERE status IN ('queued','running');

-- ---------------------------------------------------------------------------
-- Keypairs live in two tables, one per purpose.
--
--   coin_keypairs   — mint addresses for coin launches. Pooled and reusable
--                     until a launch consumes one.
--   wallet_keypairs — personal vanity addresses a user grinds and downloads.
--                     Handed out once, then the secret is gone.
--
-- They were one table ('keypairs'). The rename below migrates an existing
-- database and is a no-op once it has run. The launches foreign key follows
-- the rename automatically, so no launch history is lost.
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS keypairs RENAME TO coin_keypairs;

CREATE TABLE IF NOT EXISTS coin_keypairs (
  id             BIGSERIAL PRIMARY KEY,
  prefix         TEXT NOT NULL,
  pubkey         TEXT NOT NULL UNIQUE,
  sealed_secret  TEXT,                       -- sealed to the box key; NULLed once launched
  status         TEXT NOT NULL DEFAULT 'available', -- available | reserved | used
  wallet         TEXT,                       -- the launcher's wallet while reserved
  reserved_until TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS coin_keypairs_pool ON coin_keypairs (prefix, status);

CREATE TABLE IF NOT EXISTS wallet_keypairs (
  id             BIGSERIAL PRIMARY KEY,
  prefix         TEXT NOT NULL,
  pubkey         TEXT NOT NULL UNIQUE,
  sealed_secret  TEXT,                       -- NULLed on download, or after the 10-minute purge
  status         TEXT NOT NULL DEFAULT 'pending',   -- pending | delivered | expired
  session_token  TEXT,                       -- whoever asked for it; proves ownership on download
  expires_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS wallet_keypairs_session ON wallet_keypairs (session_token, created_at);
-- Burn to reveal (BURN_AMOUNT). One confirmed burn unlocks one key, recorded here.
ALTER TABLE wallet_keypairs ADD COLUMN IF NOT EXISTS burn_signature   TEXT;
ALTER TABLE wallet_keypairs ADD COLUMN IF NOT EXISTS burn_state       TEXT;   -- NULL | sending | done
ALTER TABLE wallet_keypairs ADD COLUMN IF NOT EXISTS burn_wallet      TEXT;
ALTER TABLE wallet_keypairs ADD COLUMN IF NOT EXISTS burn_message_b64 TEXT;
ALTER TABLE wallet_keypairs ADD COLUMN IF NOT EXISTS burn_pending_sig TEXT;
ALTER TABLE wallet_keypairs ADD COLUMN IF NOT EXISTS burned_at        TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS wallet_keypairs_burn_sig ON wallet_keypairs (burn_signature) WHERE burn_signature IS NOT NULL;

-- Move vanity-wallet rows out of the old combined table. Needs the 'type' column
-- the previous schema added; the ADDs below make this safe on a fresh database too.
ALTER TABLE coin_keypairs ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'coin';

INSERT INTO wallet_keypairs
  (prefix, pubkey, sealed_secret, status, session_token, expires_at, created_at, delivered_at)
SELECT prefix, pubkey, sealed_secret,
       CASE WHEN sealed_secret IS NULL THEN 'delivered' ELSE 'pending' END,
       wallet, reserved_until, created_at, used_at
  FROM coin_keypairs WHERE type = 'wallet'
ON CONFLICT (pubkey) DO NOTHING;

DELETE FROM coin_keypairs WHERE type = 'wallet';

-- The table name now carries the meaning, so these columns are dead weight.
ALTER TABLE coin_keypairs DROP COLUMN IF EXISTS type;
ALTER TABLE coin_keypairs DROP COLUMN IF EXISTS debug_sealed_secret;
-- Production never retains a second copy of a sealed secret. If a test build created
-- this column, drop it (and whatever it held) on the next boot.
ALTER TABLE wallet_keypairs DROP COLUMN IF EXISTS debug_sealed_secret;

CREATE TABLE IF NOT EXISTS launches (
  id            UUID PRIMARY KEY,
  keypair_id    BIGINT NOT NULL REFERENCES coin_keypairs(id),
  wallet        TEXT NOT NULL,
  name          TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  description   TEXT,
  image_uri     TEXT,
  banner_uri    TEXT,
  metadata_uri  TEXT NOT NULL,
  website       TEXT,
  twitter       TEXT,
  telegram      TEXT,
  dev_buy_sol   NUMERIC NOT NULL DEFAULT 0,
  message_b64   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'prepared',
  signature     TEXT,
  error         TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coins (
  mint            TEXT PRIMARY KEY,
  launch_id       UUID REFERENCES launches(id),
  name            TEXT NOT NULL,
  symbol          TEXT NOT NULL,
  prefix          TEXT NOT NULL,
  creator         TEXT NOT NULL,
  image_uri       TEXT,
  banner_uri      TEXT,
  description     TEXT,
  market_cap_sol  NUMERIC NOT NULL DEFAULT 0,
  graduated       BOOLEAN NOT NULL DEFAULT false,
  launched_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coins_launched ON coins (launched_at DESC);

ALTER TABLE coins ADD COLUMN IF NOT EXISTS website  TEXT;
ALTER TABLE coins ADD COLUMN IF NOT EXISTS twitter  TEXT;
ALTER TABLE coins ADD COLUMN IF NOT EXISTS telegram TEXT;
ALTER TABLE coins ADD COLUMN IF NOT EXISTS featured BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE coins ADD COLUMN IF NOT EXISTS source   TEXT NOT NULL DEFAULT 'identity';
ALTER TABLE coins ADD COLUMN IF NOT EXISTS meta_ok  BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS watched_mints (
  mint        TEXT PRIMARY KEY,
  label       TEXT,
  featured    BOOLEAN NOT NULL DEFAULT false,
  live_at     TIMESTAMPTZ,
  last_check  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS banners (
  id          UUID PRIMARY KEY,
  mime        TEXT NOT NULL,
  data        BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Coin images and metadata JSON we host ourselves, used when pump.fun's IPFS
-- uploader is unavailable. Served publicly at /media/:id. A coin's on-chain URI
-- is permanent, so rows here must never be deleted once a coin has launched.
CREATE TABLE IF NOT EXISTS media (
  id          UUID PRIMARY KEY,
  mime        TEXT NOT NULL,
  data        BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id          BIGSERIAL PRIMARY KEY,
  type        TEXT NOT NULL,
  mint        TEXT,
  prefix      TEXT,
  wallet      TEXT,
  sol         NUMERIC,
  market_cap_sol NUMERIC,
  signature   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_recent ON events (id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS events_sig_type ON events (signature, type) WHERE signature IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_mint ON events (mint) WHERE mint IS NOT NULL;
-- Coin page: the trade tape pages through one coin's events newest-first, and the
-- chart buckets that coin's trades by time.
CREATE INDEX IF NOT EXISTS events_mint_id ON events (mint, id DESC) WHERE mint IS NOT NULL;
ALTER TABLE events ADD COLUMN IF NOT EXISTS token_amount NUMERIC;

