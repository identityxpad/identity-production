#!/usr/bin/env node
// Fake PumpPortal websocket + fake Solana/Helius RPC + fake metadata host, for testing the launch
// watcher without touching mainnet.
//   ws://127.0.0.1:8790        PumpPortal-style stream (records subscriptions)
//   http://127.0.0.1:8791      JSON-RPC (getAccountInfo, getMultipleAccountsInfo, getAsset),
//                              /meta/<id>.json metadata, /price SOL price
//   Control: POST /ctl/emit {msg}        push a message to every stream client
//            POST /ctl/live {mint, asset} make an address "exist" on chain (optional DAS asset)
//            POST /ctl/meta {id, json}    set the metadata served at /meta/<id>.json
const path = require('path');
const http = require('http');
const { WebSocketServer } = require(path.join(__dirname, '../api/node_modules/ws'));

const clients = new Set();
const subs = [];
const live = new Map();   // mint -> DAS asset (or {})
const metas = new Map();  // id -> json

const wss = new WebSocketServer({ port: 8790 });
wss.on('connection', (s) => {
  clients.add(s);
  s.on('message', (b) => { try { subs.push(JSON.parse(b.toString())); } catch {} });
  s.on('close', () => clients.delete(s));
});

const acct = { data: ['', 'base64'], executable: false, lamports: 1461600, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', rentEpoch: 0, space: 82 };

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c)).on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const j = body ? JSON.parse(body) : {};
    if (req.url === '/price') return send(200, { solana: { usd: 150 } });
    if (req.url.startsWith('/meta/')) {
      const id = req.url.slice(6).replace('.json', '');
      return metas.has(id) ? send(200, metas.get(id)) : send(404, {});
    }
    if (req.url === '/ctl/emit') { clients.forEach((c) => c.send(JSON.stringify(j.msg))); return send(200, { ok: true, clients: clients.size }); }
    if (req.url === '/ctl/live') { live.set(j.mint, j.asset || {}); return send(200, { ok: true }); }
    if (req.url === '/ctl/meta') { metas.set(j.id, j.json); return send(200, { ok: true }); }
    if (req.url === '/ctl/subs') return send(200, subs);
    // JSON-RPC
    const ctx = { context: { slot: 1 } };
    if (j.method === 'getAccountInfo') return send(200, { jsonrpc: '2.0', id: j.id, result: { ...ctx, value: live.has(j.params[0]) ? acct : null } });
    if (j.method === 'getMultipleAccounts' || j.method === 'getMultipleAccountsInfo') return send(200, { jsonrpc: '2.0', id: j.id, result: { ...ctx, value: j.params[0].map((m) => (live.has(m) ? acct : null)) } });
    if (j.method === 'getAsset') {
      const a = live.get(j.params.id);
      return send(200, a && a.content ? { jsonrpc: '2.0', id: j.id, result: a } : { jsonrpc: '2.0', id: j.id, error: { code: -32000, message: 'not found' } });
    }
    return send(200, { jsonrpc: '2.0', id: j.id, error: { code: -32601, message: 'method not found' } });
  });
}).listen(8791, () => console.log('fake chain up: ws 8790, http 8791'));
