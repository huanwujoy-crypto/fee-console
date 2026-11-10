// Bounded transport only. Callers retain their fixed-route and identity gates.
export class BoundedJsonError extends Error {
  constructor(code) { super(`BOUNDED_JSON_${code}`); this.code = code; }
}

// Value-free transport facts attached only to errors this helper creates. No
// message, stack, URL, header or body is ever read into them. A cause code is
// kept only when it is on this fixed list; anything else (or a throwing
// getter) is OTHER. A rejected fetch is never guessed to be a redirect.
export const TRANSPORT_PHASES = Object.freeze(['FETCH', 'HEADERS', 'BODY', 'PARSE']);
export const TRANSPORT_CAUSE_CODES = Object.freeze(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ENOTFOUND',
  'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CLOSED', 'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_TLS_CERT_ALTNAME_INVALID']);
// DEADLINE is this helper's own whole-request deadline; a fast underlying
// connect timeout keeps its own cause code (for example UND_ERR_CONNECT_TIMEOUT).
export const TRANSPORT_CATEGORIES = Object.freeze(['DEADLINE', 'EXTERNAL_ABORT', ...TRANSPORT_CAUSE_CODES,
  'FETCH_REJECTED_OTHER', 'RESPONSE_OTHER']);
const transportDiagnostics = new WeakMap();
export const boundedJsonTransportDiagnostic = error =>
  error instanceof BoundedJsonError ? transportDiagnostics.get(error) || null : null;
const causeCategory = (error, phase) => {
  let code = null;
  try {
    const cause = error?.cause, candidate = cause?.code ?? error?.code;
    if (typeof candidate === 'string' && TRANSPORT_CAUSE_CODES.includes(candidate)) code = candidate;
  } catch { code = null; }
  return code || (phase === 'FETCH' ? 'FETCH_REJECTED_OTHER' : 'RESPONSE_OTHER');
};
const noteTransport = (error, phase, category) => {
  transportDiagnostics.set(error, Object.freeze({ phase, category }));
  return error;
};

export async function boundedJson(fetchImpl, url, init = {}, {
  timeoutMs = 20_000, maxBytes = 2 * 1024 * 1024,
  statuses = [200], requireJsonType = false, includeBytes = false,
} = {}) {
  const reject = code => { throw new BoundedJsonError(code); };
  if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1
      || timeoutMs > 300_000 || !Number.isInteger(maxBytes) || maxBytes < 1
      || maxBytes > 16 * 1024 * 1024) reject('CONFIG');
  const controller = new AbortController();
  const external = init.signal;
  const abort = () => controller.abort();
  external?.addEventListener('abort', abort, { once: true });
  if (external?.aborted) controller.abort();
  let timer, reader, phase = 'FETCH';
  const operation = (async () => {
    if (controller.signal.aborted) reject('ABORTED');
    const response = await fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal });
    phase = 'HEADERS';
    if (!response || response.url !== url || response.redirected) reject('HTTP');
    if (!statuses.includes(response.status)) reject('HTTP');
    if (response.status === 204) return null;
    const type = String(response.headers?.get?.('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (requireJsonType && type !== 'application/json') reject('TYPE');
    const length = response.headers?.get?.('content-length');
    if (length && /^\d+$/.test(length) && Number(length) > maxBytes) reject('SIZE');
    if (typeof response.body?.getReader !== 'function') reject('BODY');
    reader = response.body.getReader();
    phase = 'BODY';
    const chunks = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (controller.signal.aborted) reject(external?.aborted ? 'ABORTED' : 'TIMEOUT');
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) reject('BODY');
      size += chunk.value.byteLength;
      if (size > maxBytes) reject('SIZE');
      chunks.push(Buffer.from(chunk.value));
    }
    if (!size) reject('SIZE');
    phase = 'PARSE';
    try {
      const bytes = Buffer.concat(chunks, size);
      const json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      return includeBytes ? { json, bytes } : json;
    }
    catch { reject('JSON'); }
  })();
  const deadline = new Promise((_, fail) => {
    timer = setTimeout(() => {
      controller.abort();
      fail(new BoundedJsonError('TIMEOUT'));
    }, timeoutMs);
  });
  // An injected/nonconforming transport may ignore abort; the race still bounds
  // our wait. No mutation is retried by this helper.
  try { return await Promise.race([operation, deadline]); }
  catch (error) {
    if (error instanceof BoundedJsonError) {
      if (error.code === 'TIMEOUT' || error.code === 'ABORTED') {
        noteTransport(error, phase, error.code === 'ABORTED' ? 'EXTERNAL_ABORT' : 'DEADLINE');
      }
      throw error;
    }
    const aborted = controller.signal.aborted, externalAbort = aborted && !!external?.aborted;
    throw noteTransport(new BoundedJsonError(aborted ? (externalAbort ? 'ABORTED' : 'TIMEOUT') : 'NETWORK'), phase,
      aborted ? (externalAbort ? 'EXTERNAL_ABORT' : 'DEADLINE') : causeCategory(error, phase));
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', abort);
    controller.abort();
    if (reader) {
      try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* best effort */ }
      try { reader.releaseLock(); } catch { /* pending nonconforming read */ }
    }
  }
}
