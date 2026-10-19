import { randomUUID } from 'crypto';
import { config } from './config';
import { pool } from './db';

/*
  Metadata uploads. Picked with METADATA_UPLOAD:

  - "pumpfun" (default): pump.fun's own IPFS endpoint, the same one most launchpads use.
    It uploads the image and builds the metadata JSON in one call. No extra account needed.
    Retried a few times, because it fails intermittently — and more often from datacenter
    IPs like Railway's.
  - "pinata": your own Pinata account. Permanent IPFS hosting you control.
  - "self": store the image and metadata in our own Postgres and serve them from this API.

  If pump.fun still fails after retrying, we fall back to Pinata when PINATA_JWT is set,
  otherwise to self-hosting, so a launch never dies on someone else's outage.

  The trade-off with self-hosting: a pump.fun coin's metadata URI is fixed forever at
  launch. IPFS content outlives us; a URI pointing at this server only works while this
  server does. If it ever goes away, coins launched this way lose their name and image
  everywhere — pump.fun, Solscan, wallets. Pinata avoids that.
*/

export type UploadResult = { metadataUri: string; imageUri: string };

type Meta = { name: string; symbol: string; description?: string; twitter?: string; telegram?: string; website?: string };

async function viaPumpFun(img: { buf: Buffer; name: string; mime: string }, meta: Meta): Promise<UploadResult> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(img.buf)], { type: img.mime }), img.name);
  form.append('name', meta.name);
  form.append('symbol', meta.symbol);
  form.append('description', meta.description || '');
  form.append('twitter', meta.twitter || '');
  form.append('telegram', meta.telegram || '');
  form.append('website', meta.website || '');
  form.append('showName', 'true');
  const res = await fetch(config.pumpFunIpfsUrl, {
    method: 'POST', body: form, signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    // pump.fun answers failures with a full Next.js error page; keep the log readable.
    const text = (await res.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    throw new Error(`pump.fun upload failed (${res.status})${text ? ': ' + text.slice(0, 120) : ''}`);
  }
  const json: any = await res.json();
  if (!json?.metadataUri) throw new Error('pump.fun upload returned no metadataUri');
  return { metadataUri: json.metadataUri, imageUri: json?.metadata?.image || '' };
}

async function viaPumpFunWithRetry(img: { buf: Buffer; name: string; mime: string }, meta: Meta): Promise<UploadResult> {
  const attempts = 3;
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await viaPumpFun(img, meta);
    } catch (e) {
      last = e;
      console.warn(`[upload] pump.fun attempt ${i}/${attempts} failed: ${(e as Error).message}`);
      if (i < attempts) await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
  throw last;
}

async function storeMedia(mime: string, data: Buffer): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO media (id, mime, data) VALUES ($1, $2, $3)`, [id, mime, data]);
  return `${config.publicApiUrl}/media/${id}`;
}

async function viaSelfHost(img: { buf: Buffer; name: string; mime: string }, meta: Meta): Promise<UploadResult> {
  if (!/^https:\/\//.test(config.publicApiUrl)) {
    throw new Error('Self-hosted metadata needs PUBLIC_API_URL set to this server\'s public https address.');
  }
  const imageUri = await storeMedia(img.mime, img.buf);
  // Same shape pump.fun's uploader produces, so explorers and wallets read it the same way.
  const json: Record<string, unknown> = {
    name: meta.name,
    symbol: meta.symbol,
    description: meta.description || '',
    image: imageUri,
    showName: true,
    createdOn: config.siteUrl,
  };
  if (img.mime === 'video/mp4') json.animation_url = imageUri;
  if (meta.twitter) json.twitter = meta.twitter;
  if (meta.telegram) json.telegram = meta.telegram;
  if (meta.website) json.website = meta.website;
  const metadataUri = await storeMedia('application/json', Buffer.from(JSON.stringify(json)));
  console.log(`[upload] self-hosted metadata at ${metadataUri}`);
  return { metadataUri, imageUri };
}

async function pinataUpload(file: Blob, filename: string): Promise<string> {
  if (!config.pinataJwt) throw new Error('PINATA_JWT is not set');
  const form = new FormData();
  form.append('network', 'public');
  form.append('file', file, filename);
  const res = await fetch('https://uploads.pinata.cloud/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.pinataJwt}` },
    body: form,
  });
  if (!res.ok) throw new Error(`IPFS upload failed (${res.status}): ${await res.text()}`);
  const json: any = await res.json();
  const cid = json?.data?.cid;
  if (!cid) throw new Error('IPFS upload returned no CID');
  return config.ipfsGateway + cid;
}

async function viaPinata(img: { buf: Buffer; name: string; mime: string }, meta: Meta): Promise<UploadResult> {
  const imageUri = await pinataUpload(new Blob([new Uint8Array(img.buf)], { type: img.mime }), img.name);
  const body = JSON.stringify({ ...meta, image: imageUri, showName: true, createdOn: config.siteUrl });
  const metadataUri = await pinataUpload(new Blob([body], { type: 'application/json' }), 'metadata.json');
  return { metadataUri, imageUri };
}

export async function uploadCoinMetadata(img: { buf: Buffer; name: string; mime: string }, meta: Meta): Promise<UploadResult> {
  if (config.metadataUpload === 'pinata') return viaPinata(img, meta);
  if (config.metadataUpload === 'self') return viaSelfHost(img, meta);
  try {
    return await viaPumpFunWithRetry(img, meta);
  } catch (e) {
    // pump.fun is down or refusing us. Don't fail the launch over someone else's outage.
    if (config.pinataJwt) {
      console.warn('[upload] falling back to Pinata');
      return viaPinata(img, meta);
    }
    console.warn('[upload] falling back to self-hosted metadata');
    return viaSelfHost(img, meta);
  }
}
