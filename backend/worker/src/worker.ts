/*
  Identity GPU worker. Run one per GPU on the grinding machine.

  Loop: claim a job from the API -> run the grinder for that prefix -> check the result ->
  seal the secret key to the API's public key -> report it. The secret is only ever in this
  process's memory and in sealed form; it is never written to disk (in "vanity" mode).
*/
import { spawn, ChildProcess } from 'child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir, hostname } from 'os';
import { join } from 'path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const API = must('API_URL');                       // e.g. https://api.yoursite.com
const TOKEN = must('WORKER_TOKEN');
const BOX_PUBLIC_KEY = Buffer.from(must('BOX_PUBLIC_KEY'), 'base64');
const GPU_ID = process.env.GPU_ID ?? '0';
const MAX_LEN = Number(process.env.MAX_LEN ?? 8);  // longest prefix this worker accepts
// Which queue to serve: any (default), coin (mint addresses) or wallet (vanity wallets).
const LANE = (process.env.LANE ?? 'any') as 'any' | 'coin' | 'wallet';
const GRINDER = process.env.GRINDER ?? 'vanity';   // vanity | solana-keygen
// Case-insensitive ("stylized") matching: fiRE... counts as fire. Much faster; the default.
const CASE_INSENSITIVE = (process.env.CASE_INSENSITIVE ?? 'true') !== 'false';
const VANITY_BIN = process.env.VANITY_BIN ?? 'vanity';
const WORKER_ID = process.env.WORKER_ID ?? `${hostname()}-gpu${GPU_ID}`;
const IDLE_MS = Number(process.env.IDLE_MS ?? 1000);

function must(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`Missing env ${name}`); process.exit(1); }
  return v;
}

async function api(path: string, body: unknown): Promise<any> {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

function seal(secret: Uint8Array): string {
  const eph = nacl.box.keyPair();
  const nonce = nacl.randomBytes(24);
  const ct = nacl.box(secret, nonce, BOX_PUBLIC_KEY, eph.secretKey);
  eph.secretKey.fill(0);
  return Buffer.concat([Buffer.from(eph.publicKey), Buffer.from(nonce), Buffer.from(ct)]).toString('base64');
}

type Result = { secret: Uint8Array; attempts?: number };

/** Runs the grinder and resolves with the 64-byte Solana secret key. */
function grind(prefix: string, onChild: (c: ChildProcess) => void): Promise<Result> {
  const env = { ...process.env, CUDA_VISIBLE_DEVICES: GPU_ID };

  if (GRINDER === 'solana-keygen') {
    // CPU fallback / testing. Writes a key file, which we read and delete immediately.
    const dir = mkdtempSync(join(tmpdir(), 'grind-'));
    return new Promise((resolve, reject) => {
      const child = spawn('solana-keygen', ['grind', '--starts-with', `${prefix}:1`], { cwd: dir, env });
      onChild(child);
      child.on('error', reject);
      child.on('exit', (code) => {
        try {
          if (code !== 0) throw new Error(`solana-keygen exited with ${code}`);
          const file = readdirSync(dir).find((f) => f.endsWith('.json'));
          if (!file) throw new Error('solana-keygen wrote no key file');
          const path = join(dir, file);
          const secret = Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')));
          writeFileSync(path, '0'.repeat(200)); // overwrite before deleting
          resolve({ secret });
        } catch (e) { reject(e); } finally { rmSync(dir, { recursive: true, force: true }); }
      });
    });
  }

  // GPU: cavemanloverboy's `vanity grind-keypair`. Flags: --pattern, --case-insensitive.
  // Current builds WRITE the key to a file and print "keypair generated at: ./<pubkey>.json";
  // older builds print "keypair json (solana-compatible): [...]". We handle both. The grinder
  // runs in a private temp folder, and the key file is overwritten and deleted right after reading.
  const args = ['grind-keypair', '--pattern', prefix, '--num-gpus', '1'];
  if (CASE_INSENSITIVE) args.push('--case-insensitive');
  const dir = mkdtempSync(join(tmpdir(), 'grind-'));
  return new Promise((resolve, reject) => {
    const child = spawn(VANITY_BIN, args, { env, cwd: dir });
    onChild(child);
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('error', (e) => { rmSync(dir, { recursive: true, force: true }); reject(e); });
    child.on('exit', (code) => {
      try {
        const a = out.match(/([\d,]+)\s*attempts/g);
        const attempts = a ? Number(a[a.length - 1].replace(/[^\d]/g, '')) : undefined;
        let secret: Uint8Array | null = null;
        const inline = out.match(/keypair json[^\[]*(\[[\d,\s]+\])/);
        if (inline) secret = Uint8Array.from(JSON.parse(inline[1]));
        const file = readdirSync(dir).find((f) => f.endsWith('.json'));
        if (file) {
          const p = join(dir, file);
          if (!secret) secret = Uint8Array.from(JSON.parse(readFileSync(p, 'utf8')));
          writeFileSync(p, '0'.repeat(400)); // overwrite before deleting
        }
        out = '';
        if (!secret) return reject(new Error(`grinder exited with ${code} and produced no keypair`));
        resolve({ secret, attempts });
      } catch (e) {
        reject(e);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

async function runJob(job: { id: number; prefix: string }) {
  console.log(`[${WORKER_ID}] job ${job.id}: grinding "${job.prefix}"`);
  let child: ChildProcess | null = null;
  let cancelled = false;
  const beat = setInterval(async () => {
    try {
      const r = await api('/worker/heartbeat', { jobId: job.id, worker: WORKER_ID });
      if (!r.keepGoing) { cancelled = true; child?.kill('SIGKILL'); }
    } catch (e) { console.error('heartbeat failed', e); }
  }, 20_000);

  const t0 = Date.now();
  try {
    const { secret, attempts } = await grind(job.prefix, (c) => { child = c; });
    if (cancelled) return;
    if (secret.length !== 64) throw new Error(`secret has length ${secret.length}`);
    const derived = nacl.sign.keyPair.fromSecretKey(secret).publicKey;
    const pubkey = bs58.encode(derived);
    const starts = CASE_INSENSITIVE
      ? pubkey.toLowerCase().startsWith(job.prefix.toLowerCase())
      : pubkey.startsWith(job.prefix);
    if (!starts) throw new Error(`grinder returned ${pubkey}, which does not start with ${job.prefix}`);
    const sealedSecret = seal(secret);
    secret.fill(0);
    await api('/worker/complete', { jobId: job.id, worker: WORKER_ID, pubkey, sealedSecret, attempts });
    console.log(`[${WORKER_ID}] job ${job.id}: ${pubkey} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e: any) {
    if (cancelled) return;
    console.error(`[${WORKER_ID}] job ${job.id} failed:`, e?.message || e);
    await api('/worker/fail', { jobId: job.id, worker: WORKER_ID, error: String(e?.message || e) }).catch(() => {});
  } finally {
    clearInterval(beat);
  }
}

async function loop() {
  console.log(`[${WORKER_ID}] up · GPU ${GPU_ID} · prefixes up to ${MAX_LEN} · lane ${LANE} · grinder ${GRINDER}`);
  for (;;) {
    try {
      const { job } = await api('/worker/claim', { worker: WORKER_ID, maxLen: MAX_LEN, lane: LANE });
      if (job) { await runJob(job); continue; }
    } catch (e: any) {
      console.error('claim failed:', e?.message || e);
      await new Promise((r) => setTimeout(r, 5000));
    }
    await new Promise((r) => setTimeout(r, IDLE_MS));
  }
}

loop();
