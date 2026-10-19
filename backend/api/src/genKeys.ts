// Prints a fresh server box keypair and worker token. Put them in your .env files.
import nacl from 'tweetnacl';
import { randomBytes } from 'crypto';

const kp = nacl.box.keyPair();
console.log('# API .env');
console.log(`BOX_SECRET_KEY=${Buffer.from(kp.secretKey).toString('base64')}`);
console.log(`WORKER_TOKEN=${randomBytes(32).toString('hex')}`);
console.log('');
console.log('# worker.env (on the GPU box)');
console.log(`BOX_PUBLIC_KEY=${Buffer.from(kp.publicKey).toString('base64')}`);
console.log('WORKER_TOKEN=<same value as above>');
