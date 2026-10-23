// Pure codec. No credentials, storage, files or network are discovered here.
export const ACTION_SCHEMA = 'xuan.encrypted-published-action.v1';
export const ACTION_KDF_INFO = 'fee-console/xuan-ib/published-action/aes-256-gcm/v1';
export const MAX_ACTION_HTML_BYTES = 2 * 1024 * 1024;
export const MAX_ACTION_ENVELOPE_BYTES = 3 * 1024 * 1024;
export const ACTION_DISPLAY_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; font-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const utf8 = new TextEncoder();
const decode = new TextDecoder('utf-8', {fatal: true});
const check = (ok, code) => { if (!ok) throw new Error(code); };
const keys = (v, expected) => check(v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join(',') === [...expected].sort().join(','), 'ACTION_FIELDS');
function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function unb64(s, size) {
  check(typeof s === 'string' && s.length <= MAX_ACTION_ENVELOPE_BYTES && /^[\w-]+$/.test(s), 'ACTION_ENCODING');
  let bytes;
  try { bytes = Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0)); }
  catch { throw new Error('ACTION_ENCODING'); }
  check(b64(bytes) === s && (size === undefined || bytes.length === size), 'ACTION_ENCODING');
  return bytes;
}
export async function actionSha256(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
async function actionKey(master, salt, usage) {
  // The existing fee key is 32 random bytes, not a human password. HKDF does
  // not protect either report after compromise of that master or same-origin JS.
  check(typeof master === 'string' && /^[A-Za-z0-9_+/-]{43}=?$/.test(master), 'ACTION_KEY_FORMAT');
  // Match the existing fee key's standard/base64url and optional padding forms.
  const raw = unb64(master.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''), 32);
  try {
    const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
    return await crypto.subtle.deriveKey({name: 'HKDF', hash: 'SHA-256', salt, info: utf8.encode(ACTION_KDF_INFO)},
      base, {name: 'AES-GCM', length: 256}, false, [usage]);
  } finally { raw.fill(0); }
}
export function validateActionHtml(html) {
  check(typeof html === 'string' && utf8.encode(html).length <= MAX_ACTION_HTML_BYTES
    && /^<!doctype html>\s*<html\b[^>]*>\s*<head>/i.test(html)
    && html.includes(ACTION_DISPLAY_CSP) && /<\/html>\s*$/i.test(html), 'ACTION_STATIC_HTML');
  check(!/<\s*(?:script|iframe|frame|object|embed|base|link|form)\b/i.test(html)
    && !/<meta\b[^>]*http-equiv\s*=\s*["']?refresh\b/i.test(html)
    && !/<[^>]+\s+on[a-z]+\s*=/i.test(html)
    && !/<[^>]+\s+(?:href|src|action|formaction)\s*=/i.test(html), 'ACTION_ACTIVE_HTML');
  return html;
}
export async function validateActionPayload(p) {
  keys(p, ['schema', 'reportDate', 'publishedAt', 'sourceGeneration', 'displaySha256', 'html']);
  check(p.schema === ACTION_SCHEMA && /^\d{4}-\d{2}-\d{2}$/.test(p.reportDate)
    && new Date(p.reportDate + 'T00:00:00Z').toISOString().slice(0, 10) === p.reportDate, 'ACTION_DATE');
  check(typeof p.publishedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(p.publishedAt)
    && Number.isFinite(Date.parse(p.publishedAt))
    && new Date(Date.parse(p.publishedAt) + 8 * 3600_000).toISOString().slice(0, 10) >= p.reportDate, 'ACTION_PUBLISHED_AT');
  check(typeof p.sourceGeneration === 'string' && /^[1-9]\d{0,29}$/.test(p.sourceGeneration)
    && typeof p.displaySha256 === 'string' && /^[a-f0-9]{64}$/.test(p.displaySha256), 'ACTION_PIN');
  validateActionHtml(p.html);
  check(await actionSha256(utf8.encode(p.html)) === p.displaySha256, 'ACTION_HASH');
  return p;
}
export function parseActionEnvelope(text) {
  check(typeof text === 'string' && utf8.encode(text).length <= MAX_ACTION_ENVELOPE_BYTES, 'ACTION_ENVELOPE_SIZE');
  const e = JSON.parse(text);
  // Canonical generated JSON also rejects duplicate members and ambiguous encodings.
  check(JSON.stringify(e) === text, 'ACTION_CANONICAL');
  keys(e, ['schema', 'kdf', 'salt', 'iv', 'ciphertext']);
  check(e.schema === ACTION_SCHEMA && e.kdf === 'HKDF-SHA-256', 'ACTION_PROTOCOL');
  unb64(e.salt, 32); unb64(e.iv, 12);
  const bytes = unb64(e.ciphertext);
  check(bytes.length >= 16 && bytes.length <= MAX_ACTION_ENVELOPE_BYTES, 'ACTION_CIPHERTEXT');
  return e;
}
export async function encryptPublishedAction(payload, master) {
  await validateActionPayload(payload);
  const salt = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await actionKey(master, salt, 'encrypt');
  const clear = utf8.encode(JSON.stringify(payload));
  try {
    const cipher = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv,
      additionalData: utf8.encode(ACTION_SCHEMA), tagLength: 128}, key, clear));
    const text = JSON.stringify({schema: ACTION_SCHEMA, kdf: 'HKDF-SHA-256', salt: b64(salt), iv: b64(iv), ciphertext: b64(cipher)});
    parseActionEnvelope(text);
    return text;
  } finally { clear.fill(0); }
}
export async function decryptPublishedAction(text, master) {
  const e = parseActionEnvelope(text), key = await actionKey(master, unb64(e.salt, 32), 'decrypt');
  let clear;
  try {
    clear = new Uint8Array(await crypto.subtle.decrypt({name: 'AES-GCM', iv: unb64(e.iv, 12),
      additionalData: utf8.encode(ACTION_SCHEMA), tagLength: 128}, key, unb64(e.ciphertext)));
    return await validateActionPayload(JSON.parse(decode.decode(clear)));
  } catch { throw new Error('ACTION_UNLOCK_FAILED'); }
  finally { clear?.fill(0); }
}

export async function packagePublishedAction({htmlBytes, receipt, masterKey}) {
  const r = receipt?.fixedReadback;
  if (receipt?.status !== 'PRIVATE_PUBLICATION_FIXED_VERSION_VERIFIED'
    || receipt?.target?.bucket !== 'family-portfolio-gateway-xuan-preopen-private'
    || receipt?.target?.object !== 'delivery/owner-latest.html'
    || r?.status !== 'published-verified' || r?.code !== 'PINNED_READBACK_VERIFIED'
    || r?.storageStatus !== 'verified' || r?.atUtc !== receipt.completedAtUtc
    || !(htmlBytes instanceof Uint8Array) || htmlBytes.length > MAX_ACTION_HTML_BYTES
    || await actionSha256(htmlBytes) !== r.sha256) throw new Error('ACTION_PUBLISHED_SOURCE_MISMATCH');
  const html = new TextDecoder('utf-8', {fatal: true}).decode(htmlBytes);
  const payload = {schema: ACTION_SCHEMA, reportDate: receipt.reportDateHkt,
    publishedAt: r.atUtc, sourceGeneration: r.generation, displaySha256: r.sha256, html};
  // This validates consistency, not the authority of an arbitrary receipt file.
  // The separately approved operator must bind these bytes to the fixed readback.
  return encryptPublishedAction(payload, masterKey);
}
