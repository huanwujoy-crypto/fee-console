// Bounded transport only. Callers retain their fixed-route and identity gates.
export class BoundedJsonError extends Error {
  constructor(code) { super(`BOUNDED_JSON_${code}`); this.code = code; }
}

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
  let timer, reader;
  const operation = (async () => {
    if (controller.signal.aborted) reject('ABORTED');
    const response = await fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal });
    if (!response || response.url !== url || response.redirected) reject('HTTP');
    if (!statuses.includes(response.status)) reject('HTTP');
    if (response.status === 204) return null;
    const type = String(response.headers?.get?.('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (requireJsonType && type !== 'application/json') reject('TYPE');
    const length = response.headers?.get?.('content-length');
    if (length && /^\d+$/.test(length) && Number(length) > maxBytes) reject('SIZE');
    if (typeof response.body?.getReader !== 'function') reject('BODY');
    reader = response.body.getReader();
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
    if (error instanceof BoundedJsonError) throw error;
    reject(controller.signal.aborted ? (external?.aborted ? 'ABORTED' : 'TIMEOUT') : 'NETWORK');
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
