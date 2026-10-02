// Run once to prove a standalone cloud source connection. No report rendering,
// publishing, GitHub mutation, source fallback, or scheduling is implemented.
import crypto from 'node:crypto';
import { captureCloudIbAction,captureCloudIbFull } from './ib_mcp.mjs';

const PROJECT = 'family-portfolio-gateway';
const SECRET = `projects/${PROJECT}/secrets/xuan-preopen-ib-mcp`;
const BUCKET = `${PROJECT}-xuan-preopen-private`;
let googleToken;
async function jsonRequest(url, options = {}) {
  let response;
  try { response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
  catch { throw new Error('CLOUD_NETWORK_FAILED'); }
  if (!response.ok) throw new Error('CLOUD_HTTP_' + response.status);
  const text = await response.text();
  if (text.length > 8_000_000) throw new Error('CLOUD_RESPONSE_TOO_LARGE');
  try { return JSON.parse(text); } catch { throw new Error('CLOUD_RESPONSE_INVALID'); }
}
async function headers() {
  if (!googleToken) {
    const result = await jsonRequest('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' } });
    if (!result.access_token) throw new Error('CLOUD_IDENTITY_UNAVAILABLE');
    googleToken = result.access_token;
  }
  return { Authorization: `Bearer ${googleToken}`, 'content-type': 'application/json' };
}
const store = {
  async load() {
    const result = await jsonRequest(`https://secretmanager.googleapis.com/v1/${SECRET}/versions/latest:access`, { headers: await headers() });
    if (!result.payload?.data) throw new Error('CLOUD_CREDENTIAL_UNAVAILABLE');
    try { return JSON.parse(Buffer.from(result.payload.data, 'base64').toString('utf8')); }
    catch { throw new Error('CLOUD_CREDENTIAL_INVALID'); }
  },
  async save(value) {
    await jsonRequest(`https://secretmanager.googleapis.com/v1/${SECRET}:addVersion`,
      { method: 'POST', headers: await headers(), body: JSON.stringify({ payload: { data: Buffer.from(JSON.stringify(value)).toString('base64') } }) });
  },
};
async function savePrivate(name, value) {
  const data = Buffer.from(JSON.stringify(value));
  const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o`);
  url.searchParams.set('uploadType', 'media'); url.searchParams.set('name', name);
  url.searchParams.set('ifGenerationMatch', '0');
  await jsonRequest(url, { method: 'POST', headers: await headers(), body: data });
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function main() {
  const mode=process.argv.slice(2).join(' ');
  if (!['--source-check','--full-source-check'].includes(mode)) throw new Error('SOURCE_CHECK_ONLY');
  const startedAt = new Date().toISOString();
  const result = await (mode==='--full-source-check'?captureCloudIbFull:captureCloudIbAction)(store);
  const prefix = `source-check/${startedAt}-${crypto.randomUUID()}/`;
  const sources = [];
  for (const source of result.sources) {
    const object = prefix + source.sourceKey + '.json';
    sources.push({ sourceKey: source.sourceKey, startedAt: source.startedAt, completedAt: source.completedAt,
      rawFingerprint: source.rawFingerprint, privateObject: object, evidenceSha256: await savePrivate(object, source) });
  }
  const positions = result.sources.find(source => source.sourceKey === 'ib.positions').raw.positions;
  const orders = result.sources.find(source => source.sourceKey === 'ib.orders').raw.orders;
  const receipt = { status: 'captured', mode: 'read_only', startedAt, completedAt: new Date().toISOString(),
    sourceCount: sources.length, positionCount: positions.length, orderCount: orders.length, sources,
    publication: 'none', scheduler: 'none' };
  await savePrivate(prefix + 'receipt.json', receipt);
  process.stdout.write(JSON.stringify(receipt) + '\n');
}
main().catch(error => {
  const code = /^[A-Z_0-9]+$/.test(error?.message || '') ? error.message : 'SOURCE_CHECK_FAILED';
  process.stdout.write(JSON.stringify({ status: 'failed', code, publication: 'none', scheduler: 'none' }) + '\n');
  process.exitCode = 1;
});
