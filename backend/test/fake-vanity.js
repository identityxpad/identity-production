#!/usr/bin/env node
// Stand-in for the GPU grinder: same flags and the same output as the real `vanity grind-keypair`
// build used on the 5090s. It writes the key to ./<pubkey>.json in the current folder and prints
// "pubkey:" and "keypair generated at:" lines. CPU speed, so use short prefixes in tests.
const path = require('path');
const fs = require('fs');
const nacl = require(path.join(__dirname, '../worker/node_modules/tweetnacl'));
const bs58 = require(path.join(__dirname, '../worker/node_modules/bs58'));
const a = process.argv.slice(2);
const pat = a[a.indexOf('--pattern') + 1];
const ci = a.includes('--case-insensitive');
let n = 0;
for (;;) {
  const kp = nacl.sign.keyPair(); n++;
  const pk = bs58.encode(kp.publicKey);
  if (ci ? pk.toLowerCase().startsWith(pat.toLowerCase()) : pk.startsWith(pat)) {
    fs.writeFileSync(`${pk}.json`, JSON.stringify(Array.from(kp.secretKey)));
    console.log(`pubkey: ${pk}`);
    console.log(`keypair generated at: ./${pk}.json`);
    console.log(` ${pat} 1/1 | expected 0 | ETA capped`);
    console.log(`${n.toLocaleString('en-US')} attempts | ${n} attempts/sec | elapsed: 1s`);
    process.exit(0);
  }
}
