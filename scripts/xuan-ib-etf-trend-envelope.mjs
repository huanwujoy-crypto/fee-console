// The entire trend view, including normalized indices, is private.
// Pure WebCrypto codec: no filesystem, storage, network or credential discovery.
import { TREND_METHOD, renderEtfTrend } from './xuan-ib-etf-trend.mjs';

export const ETF_TREND_AAD = 'XUAN-ETF:indicative-v2:envelope-v1';
export const MAX_ETF_ENVELOPE_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const arms = ['A', 'B', 'C'];
const symbols = ['CSPX', 'EXUS', 'EIMI', 'USSC'];
const check = (ok, message) => { if (!ok) throw new Error(message); };
const record = value => value !== null && typeof value === 'object'
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const money = value => finite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
function exactKeys(value, names) {
  check(record(value) && Object.keys(value).sort().join(',') === [...names].sort().join(','), 'Unexpected ETF field');
}
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const epoch = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(epoch) && new Date(epoch).toISOString().slice(0, 10) === value;
}
function utf8(text) {
  check(typeof text === 'string' && text.length < MAX_ETF_ENVELOPE_BYTES, 'ETF input exceeds size limit');
  const bytes = encoder.encode(text);
  check(bytes.byteLength < MAX_ETF_ENVELOPE_BYTES, 'ETF input exceeds size limit');
  return bytes;
}
function boundedJson(value) { return utf8(JSON.stringify(value)); }
function parseJson(bytes) {
  check(bytes instanceof Uint8Array && bytes.byteLength < MAX_ETF_ENVELOPE_BYTES, 'ETF input exceeds size limit');
  const text = decoder.decode(bytes);
  // Generated envelopes/payloads use ordinary JSON objects. A duplicate member
  // must not silently override an earlier authenticated member.
  const parsed = JSON.parse(text);
  check(JSON.stringify(parsed) === text, 'ETF JSON must be canonical generated JSON');
  return parsed;
}
function base64url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function decode64(value, expectedLength = null) {
  check(typeof value === 'string' && value.length > 0 && value.length < MAX_ETF_ENVELOPE_BYTES
    && /^[A-Za-z0-9_-]+$/.test(value) && value.length % 4 !== 1, 'Invalid ETF base64url');
  let binary;
  try { binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)); }
  catch { throw new Error('Invalid ETF base64url'); }
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  check(base64url(bytes) === value && (expectedLength === null || bytes.length === expectedLength), 'Invalid ETF encoded length');
  return bytes;
}
function webcrypto() {
  check(globalThis.crypto?.subtle && typeof globalThis.crypto.getRandomValues === 'function', 'WebCrypto is unavailable');
  return globalThis.crypto;
}
async function importKey(value, usage) {
  const bytes = decode64(value, 32);
  try { return await webcrypto().subtle.importKey('raw', bytes, 'AES-GCM', false, [usage]); }
  finally { bytes.fill(0); }
}
function calendarDay(now, timeZone) {
  const epoch = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now);
  check(Number.isFinite(epoch), 'Invalid ETF verification time');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(epoch)).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function validatePrivateResult(result) {
  exactKeys(result, ['methodId', 'startDate', 'frozenDate', 'initialUsd', 'latestCompleteDate', 'rows', 'stop']);
  check(result.methodId === TREND_METHOD && date(result.startDate) && date(result.frozenDate)
    && date(result.latestCompleteDate) && money(result.initialUsd) && result.initialUsd > 0, 'Invalid private ETF result');
  check(Array.isArray(result.rows) && result.rows.length > 0 && result.rows.length <= 10000, 'Invalid private ETF rows');
  if (result.stop !== null) {
    exactKeys(result.stop, ['date', 'reason']);
    check(date(result.stop.date) && typeof result.stop.reason === 'string'
      && result.stop.reason.length > 0 && result.stop.reason.length <= 500, 'Invalid private ETF stop');
  }
  for (const row of result.rows) {
    exactKeys(row, ['date', 'estimated', 'historyEstimated', 'retrospective', 'canTrade', 'reserveUsed',
      'index', 'endingUsd', 'cumulativeFlowUsd', 'gainUsd', 'maxDrawdown', 'quoteDates', 'sourceRef']);
    check(date(row.date) && ['estimated', 'historyEstimated', 'retrospective', 'canTrade', 'reserveUsed']
      .every(key => typeof row[key] === 'boolean'), 'Invalid private ETF row');
    check(money(row.cumulativeFlowUsd) && typeof row.sourceRef === 'string'
      && row.sourceRef.length > 0 && row.sourceRef.length <= 500, 'Invalid private ETF source');
    exactKeys(row.quoteDates, symbols);
    check(Object.values(row.quoteDates).every(date), 'Invalid private ETF price dates');
    for (const field of ['index', 'endingUsd', 'gainUsd', 'maxDrawdown']) {
      exactKeys(row[field], arms);
      check(Object.values(row[field]).every(value => money(value) && (field === 'gainUsd' || value >= 0)), 'Invalid private ETF metric');
    }
    check(arms.every(arm => Math.abs(row.gainUsd[arm]
      - (row.endingUsd[arm] - result.initialUsd - row.cumulativeFlowUsd)) < .005), 'ETF gain and cash flow differ');
  }
}

export function validateEtfTrendPayload(payload, { now = new Date(), maxSeenDate = null } = {}) {
  boundedJson(payload);
  exactKeys(payload, ['projection', 'result']);
  validatePrivateResult(payload.result);
  // The renderer validates the projection and binds absolute amounts to the
  // exact same computed result. Do not merely validate JSON field names.
  renderEtfTrend(payload.projection, { privateResult: payload.result });
  const today = calendarDay(now, 'Asia/Hong_Kong');
  const projection = payload.projection;
  const sourceDate = projection.rows.at(-1).date;
  check([projection.startDate, projection.frozenDate, projection.latestCompleteDate, sourceDate,
    ...(projection.stoppedAt === null ? [] : [projection.stoppedAt])].every(value => value <= today), 'Future ETF data is not allowed');
  // Approval dates belong to Hong Kong; completed business-date rows must not
  // jump ahead merely because Hong Kong has already passed midnight.
  check(sourceDate <= calendarDay(now, 'America/New_York'), 'Future ETF source business date is not allowed');
  check(maxSeenDate === null || (date(maxSeenDate) && maxSeenDate <= today), 'Invalid previously seen ETF date');
  check(maxSeenDate === null || sourceDate >= maxSeenDate, 'ETF data is older than the last accepted source');
  return payload;
}

export async function encryptEtfTrend(payload, keyBase64Url, options = {}) {
  validateEtfTrendPayload(payload, options);
  const plaintext = boundedJson(payload);
  const key = await importKey(keyBase64Url, 'encrypt');
  // A dedicated ETF-only key avoids granting fee-ledger share-link holders access.
  // A fresh random IV is required for every encryption, including same-day revisions.
  const iv = webcrypto().getRandomValues(new Uint8Array(12));
  let ciphertext;
  try {
    ciphertext = new Uint8Array(await webcrypto().subtle.encrypt({ name: 'AES-GCM', iv,
      additionalData: encoder.encode(ETF_TREND_AAD), tagLength: 128 }, key, plaintext));
  } finally { plaintext.fill(0); }
  const envelope = { schemaVersion: 1, algorithm: 'AES-256-GCM', aad: ETF_TREND_AAD,
    iv: base64url(iv), ciphertext: base64url(ciphertext) };
  boundedJson(envelope);
  return envelope;
}

export async function decryptEtfTrend(encodedEnvelope, keyBase64Url, options = {}) {
  const envelope = typeof encodedEnvelope === 'string' ? parseJson(utf8(encodedEnvelope))
    : encodedEnvelope instanceof Uint8Array ? parseJson(encodedEnvelope) : encodedEnvelope;
  boundedJson(envelope);
  exactKeys(envelope, ['schemaVersion', 'algorithm', 'aad', 'iv', 'ciphertext']);
  check(envelope.schemaVersion === 1 && envelope.algorithm === 'AES-256-GCM'
    && envelope.aad === ETF_TREND_AAD, 'Unsupported ETF envelope domain');
  const iv = decode64(envelope.iv, 12);
  const ciphertext = decode64(envelope.ciphertext);
  check(ciphertext.length >= 16, 'Invalid ETF authentication tag');
  const key = await importKey(keyBase64Url, 'decrypt');
  let plaintext;
  try {
    plaintext = new Uint8Array(await webcrypto().subtle.decrypt({ name: 'AES-GCM', iv,
      additionalData: encoder.encode(ETF_TREND_AAD), tagLength: 128 }, key, ciphertext));
  } catch { throw new Error('ETF encrypted data could not be authenticated'); }
  try { return validateEtfTrendPayload(parseJson(plaintext), options); }
  finally { plaintext.fill(0); }
}
