// Fixed private destinations. No filesystem credential, bucket or secret flags.
import crypto from 'node:crypto';
export const PROJECT = 'family-portfolio-gateway';
export const BUCKET = `${PROJECT}-xuan-preopen-private`;
const IB_SECRET = `projects/${PROJECT}/secrets/xuan-preopen-ib-mcp`;
const READ_SECRET = `projects/${PROJECT}/secrets/family-portfolio-gateway-key`;

export async function boundedText(response, limit = 8_000_000) {
  if (!response.body) throw new Error('CLOUD_EMPTY_RESPONSE');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('CLOUD_RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)); }
  catch { throw new Error('CLOUD_INVALID_UTF8'); }
}

export function privateCloudIo({fetchImpl = fetch} = {}) {
  let googleToken;
  async function request(url, options = {}) {
    let response;
    try { response = await fetchImpl(url, {...options, redirect: 'error', signal: AbortSignal.timeout(30_000)}); }
    catch { throw new Error('CLOUD_NETWORK_FAILED'); }
    if (!response.ok) throw new Error(`CLOUD_HTTP_${response.status}`);
    try { return JSON.parse(await boundedText(response)); }
    catch (error) { if (/^CLOUD_/.test(error.message)) throw error; throw new Error('CLOUD_RESPONSE_INVALID'); }
  }
  async function headers() {
    if (!googleToken) {
      const result = await request('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        {headers: {'Metadata-Flavor': 'Google'}});
      if (!result.access_token) throw new Error('CLOUD_IDENTITY_UNAVAILABLE');
      googleToken = result.access_token;
    }
    return {Authorization: `Bearer ${googleToken}`, 'content-type': 'application/json'};
  }
  async function secret(name) {
    const result = await request(`https://secretmanager.googleapis.com/v1/${name}/versions/latest:access`, {headers: await headers()});
    if (!result.payload?.data) throw new Error('CLOUD_CREDENTIAL_UNAVAILABLE');
    return Buffer.from(result.payload.data, 'base64').toString('utf8');
  }
  return {
    ibStore: {
      async load() { try { return JSON.parse(await secret(IB_SECRET)); } catch { throw new Error('CLOUD_IB_CREDENTIAL_UNAVAILABLE'); } },
      async save(value) {
        await request(`https://secretmanager.googleapis.com/v1/${IB_SECRET}:addVersion`,
          {method: 'POST', headers: await headers(), body: JSON.stringify({payload: {data: Buffer.from(JSON.stringify(value)).toString('base64')}})});
      },
    },
    async loadGatewayToken() {
      const value = (await secret(READ_SECRET)).trim();
      if (!value || /[\r\n]/.test(value)) throw new Error('CLOUD_GATEWAY_CREDENTIAL_INVALID');
      return value;
    },
    async savePrivate(name, value) {
      if (!/^report-check\/[a-zA-Z0-9:._-]+\/[a-zA-Z0-9._-]+$/.test(name)
          && !/^delivery\/\d{4}-\d{2}-\d{2}\/(?:europe-regular-v1-\d{4}-\d{2}-\d{2}-\d+\/)?(report\.html|receipt\.json|start\.json)$/.test(name)) throw new Error('PRIVATE_OBJECT_PATH_INVALID');
      const data = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
      const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o`);
      url.searchParams.set('uploadType', 'media'); url.searchParams.set('name', name); url.searchParams.set('ifGenerationMatch', '0');
      const result = await request(url, {method: 'POST', headers: {...await headers(), 'content-type': 'application/octet-stream'}, body: data});
      if (result.name !== name || String(result.size) !== String(data.length) || !result.generation) throw new Error('PRIVATE_UPLOAD_NOT_CONFIRMED');
      return {sha256: crypto.createHash('sha256').update(data).digest('hex'), generation: String(result.generation)};
    },
  };
}
