import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { join } from 'path';
import { config } from './config';
import { migrate } from './db';
import { registerGrindRoutes, releaseExpiredReservations, topUpPool, cancelAbandonedJobs } from './grind';
import { registerLaunchRoutes, recoverStuckLaunches } from './launch';
import { registerFeedRoutes, startPumpPortalIngest, pumpPortalStatus } from './feed';
import { startChainWatch, chainWatchStatus } from './chainwatch';
import { registerCoinRoutes } from './coins';
import { registerWalletRoutes, purgeUnclaimedWalletKeys } from './wallet';
import { registerBurnRoutes } from './burn';
import { serverBoxPublicKeyB64 } from './sealed';
import { registerAdminRoutes, startWatcher } from './watch';

// One bad request or a hiccup in a background task must never take the whole site down.
process.on('unhandledRejection', (e) => { console.error('[unhandledRejection]', e); });

async function main() {
  await migrate();

  const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024, trustProxy: true });
  await app.register(cors, { origin: config.corsOrigins });
  await app.register(multipart, { limits: { fileSize: 31 * 1024 * 1024, files: 2 } });
  await app.register(rateLimit, {
    // Per visitor IP (trustProxy reads Railway's forwarded address). The page itself, its
    // scripts and images don't count; only API calls do. A coin page uses ~15 calls a minute.
    max: 300,
    timeWindow: '1 minute',
    allowList: (req) => req.url.startsWith('/worker/') || !(req.url.startsWith('/api/') || req.url.startsWith('/admin/')),
  });

  // Accept an empty body on JSON requests (e.g. admin "refresh" calls sent with a JSON header).
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, body === '' ? {} : JSON.parse(body as string));
    } catch (e: any) {
      e.statusCode = 400;
      done(e, undefined);
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'Invalid request', details: err.issues });
    app.log.error(err);
    return reply.code(err.statusCode && err.statusCode < 500 ? err.statusCode : 500).send({ error: err.message || 'Server error' });
  });

  // --- Password gate for private testing ---
  if (config.sitePassword) {
    app.addHook('onRequest', async (req, reply) => {
      // Let workers, health, and the password endpoint through
      if (req.url.startsWith('/worker/') || req.url === '/api/health' || req.url === '/api/gate/login') return;
      // Coin media is fetched by pump.fun, explorers and wallets, none of which hold our
      // beta cookie. Gating it would leave launched coins with no name, image or banner.
      if (req.url.startsWith('/media/') || req.url.startsWith('/api/banner/')) return;

      // Check cookie
      const cookies = req.headers.cookie || '';
      const match = cookies.match(/(?:^|;\s*)site_pass=([^;]+)/);
      if (match && match[1] === config.sitePassword) return;

      // If it's an API call, return 401
      if (req.url.startsWith('/api/')) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      // For page requests, serve the login page
      return reply.type('text/html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Identity — Private Beta</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#060708;color:#e4e4e7;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{background:#0C0D10;border:1px solid #1a1b20;border-radius:16px;padding:40px;max-width:360px;width:100%;text-align:center}
h1{font-size:20px;margin-bottom:8px;font-weight:600}
p{font-size:14px;color:#71717a;margin-bottom:24px}
input{width:100%;padding:12px 16px;background:#060708;border:1px solid #27272a;border-radius:8px;color:#e4e4e7;font-size:15px;margin-bottom:12px;outline:none}
input:focus{border-color:#C8F542}
button{width:100%;padding:12px;background:#C8F542;color:#060708;border:none;border-radius:8px;font-weight:600;font-size:15px;cursor:pointer}
button:hover{opacity:.9}
.err{color:#ef4444;font-size:13px;margin-top:8px;display:none}
</style></head><body>
<div class="box">
<h1>identity</h1>
<p>private beta — enter password</p>
<form onsubmit="go(event)">
<input type="password" id="pw" placeholder="password" autofocus>
<button type="submit">enter</button>
</form>
<div class="err" id="err">wrong password</div>
</div>
<script>
function go(e){e.preventDefault();var pw=document.getElementById('pw').value;
fetch('/api/gate/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})})
.then(function(r){if(r.ok){document.cookie='site_pass='+pw+';path=/;max-age=86400;SameSite=Strict';location.reload()}
else{document.getElementById('err').style.display='block'}})
.catch(function(){document.getElementById('err').style.display='block'})}
</script></body></html>`);
    });

    // Login endpoint — just validates the password
    app.post('/api/gate/login', async (req, reply) => {
      const { password } = (req.body as any) || {};
      if (password === config.sitePassword) return { ok: true };
      return reply.code(401).send({ error: 'Wrong password' });
    });
  }

  app.get('/api/health', async () => {
    const ago = (t: number) => (t ? Math.round((Date.now() - t) / 1000) + 's ago' : 'never');
    return {
      ok: true, boxPublicKey: serverBoxPublicKeyB64(),
      // Where trades come from. If PumpPortal shows nothing, the chain reader still works.
      trades: {
        pumpportal: { connected: pumpPortalStatus.connected, lastMessage: ago(pumpPortalStatus.lastMessageAt),
                      lastTrade: ago(pumpPortalStatus.lastTradeAt), lastError: pumpPortalStatus.lastError || null },
        chain: { lastRun: ago(chainWatchStatus.lastRunAt), coinsPolled: chainWatchStatus.coinsPolled,
                 tradesFound: chainWatchStatus.tradesFound, lastError: chainWatchStatus.lastError || null },
      },
    };
  });

  registerGrindRoutes(app);
  registerLaunchRoutes(app);
  registerFeedRoutes(app);
  registerCoinRoutes(app);
  registerWalletRoutes(app);
  registerBurnRoutes(app);
  registerAdminRoutes(app);

  // Serve the static frontend (site/index.html) from the same server.
  // In production, the site folder sits next to the api folder.
  const siteDir = join(__dirname, '..', '..', '..', 'site');
  await app.register(fastifyStatic, { root: siteDir, prefix: '/', wildcard: false });
  // SPA fallback: any non-API, non-file path serves index.html (for hash routing)
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/worker/')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });

  setInterval(() => releaseExpiredReservations().catch((e) => app.log.error(e)), 15_000);
  setInterval(() => cancelAbandonedJobs().then((n) => { if (n) app.log.info(`cancelled ${n} abandoned grind job(s)`); }).catch((e) => app.log.error(e)), 30_000);
  setInterval(() => purgeUnclaimedWalletKeys().catch((e) => app.log.error(e)), 60_000);
  setInterval(() => recoverStuckLaunches().catch((e) => app.log.error(e)), 30_000);
  setInterval(() => topUpPool().catch((e) => app.log.error(e)), 60_000);
  topUpPool().catch((e) => app.log.error(e));
  await startWatcher().catch((e) => app.log.error(e)); // register before the stream connects
  startPumpPortalIngest().catch((e) => app.log.error(e));
  startChainWatch();

  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((e) => { console.error(e); process.exit(1); });
