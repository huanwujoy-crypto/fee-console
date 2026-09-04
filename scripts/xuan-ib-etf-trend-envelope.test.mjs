import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { TREND_METHOD, simulateEtfTrend, projectEtfTrend } from './xuan-ib-etf-trend.mjs';
import { ETF_TREND_AAD, MAX_ETF_ENVELOPE_BYTES, encryptEtfTrend, decryptEtfTrend,
  validateEtfTrendPayload } from './xuan-ib-etf-trend-envelope.mjs';

const NOW = '2026-09-04T02:00:00Z';
const OPTIONS = { now: NOW };
const key = () => Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64url');
function payload() {
  const days = ['2026-09-01', '2026-09-02'].map((date, i) => ({ date,
    actualUsd: 1200000 + i * 10000, actualComplete: true, flowsComplete: true, flows: [],
    quotes: Object.fromEntries(['CSPX', 'EXUS', 'EIMI', 'USSC'].map(symbol => [symbol,
      { status: 'close', usd: 100 + i, date, source: 'synthetic-test' }])), sourceRef: 'synthetic-test' }));
  const result = simulateEtfTrend({ methodId: TREND_METHOD, startDate: '2026-09-01',
    frozenDate: '2026-09-04', initialUsd: 1200000, reserveUsd: 240000, days });
  return { projection: projectEtfTrend(result), result };
}
async function sealRaw(text, secret, aad = ETF_TREND_AAD) {
  const cryptoKey = await webcrypto.subtle.importKey('raw', Buffer.from(secret, 'base64url'), 'AES-GCM', false, ['encrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv,
    additionalData: new TextEncoder().encode(aad), tagLength: 128 }, cryptoKey, bytes);
  return { schemaVersion: 1, algorithm: 'AES-256-GCM', aad: ETF_TREND_AAD,
    iv: Buffer.from(iv).toString('base64url'), ciphertext: Buffer.from(ciphertext).toString('base64url') };
}

test('round-trip checked payload through object, string and UTF-8 JSON', async () => {
  const secret = key(), source = payload();
  const envelope = await encryptEtfTrend(source, secret, OPTIONS);
  for (const encoded of [envelope, JSON.stringify(envelope), new TextEncoder().encode(JSON.stringify(envelope))]) {
    assert.deepEqual(await decryptEtfTrend(encoded, secret, OPTIONS), source);
  }
  assert.ok(!JSON.stringify(envelope).includes('1200000'));
  assert.ok(!JSON.stringify(envelope).includes('sourceRef'));
});

test('fresh random 12-byte IV for every encryption of the same data', async () => {
  const secret = key(), source = payload();
  const a = await encryptEtfTrend(source, secret, OPTIONS);
  const b = await encryptEtfTrend(source, secret, OPTIONS);
  assert.equal(Buffer.from(a.iv, 'base64url').length, 12);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
});

test('wrong key, corrupted ciphertext and corrupted IV fail authentication', async () => {
  const secret = key(), envelope = await encryptEtfTrend(payload(), secret, OPTIONS);
  await assert.rejects(decryptEtfTrend(envelope, key(), OPTIONS), /authenticated/);
  for (const field of ['ciphertext', 'iv']) {
    const bytes = Buffer.from(envelope[field], 'base64url'); bytes[0] ^= 1;
    await assert.rejects(decryptEtfTrend({ ...envelope, [field]: bytes.toString('base64url') }, secret, OPTIONS), /authenticated/);
  }
});

test('domain changed in header or actual GCM AAD is rejected', async () => {
  const secret = key(), envelope = await encryptEtfTrend(payload(), secret, OPTIONS);
  await assert.rejects(decryptEtfTrend({ ...envelope, aad: 'fee-data' }, secret, OPTIONS), /domain/);
  const wrongDomain = await sealRaw(JSON.stringify(payload()), secret, 'fee-data');
  await assert.rejects(decryptEtfTrend(wrongDomain, secret, OPTIONS), /authenticated/);
});

test('missing, padded, noncanonical or wrong-length keys are rejected', async () => {
  for (const bad of [undefined, '', key() + '=', 'x'.repeat(42), ' '.repeat(43), Buffer.alloc(16).toString('base64url')]) {
    await assert.rejects(encryptEtfTrend(payload(), bad, OPTIONS), /base64url|length/);
  }
});

test('unknown payload, result, nested row and projection fields are rejected', async () => {
  const secret = key();
  for (const target of ['payload', 'result', 'row', 'projection']) {
    const p = payload();
    const object = target === 'payload' ? p : target === 'result' ? p.result
      : target === 'row' ? p.result.rows[0] : p.projection;
    object.unexpected = 'not-allowed';
    await assert.rejects(encryptEtfTrend(p, secret, OPTIONS), /field/);
    await assert.rejects(decryptEtfTrend(await sealRaw(JSON.stringify(p), secret), secret, OPTIONS), /field/);
  }
});

test('unknown envelope fields and unsupported encryption parameters are rejected', async () => {
  const secret = key(), envelope = await encryptEtfTrend(payload(), secret, OPTIONS);
  for (const bad of [{ ...envelope, extra: true }, { ...envelope, schemaVersion: 2 },
    { ...envelope, algorithm: 'AES-CBC' }, { ...envelope, iv: Buffer.alloc(8).toString('base64url') },
    { ...envelope, ciphertext: 'AQ' }]) {
    await assert.rejects(decryptEtfTrend(bad, secret, OPTIONS));
  }
});

test('future source/freeze dates rejected on encryption and decryption', async () => {
  const secret = key(), source = payload();
  await assert.rejects(encryptEtfTrend(source, secret, { now: '2026-09-03T12:00:00Z' }), /Future/);
  const envelope = await encryptEtfTrend(source, secret, OPTIONS);
  await assert.rejects(decryptEtfTrend(envelope, secret, { now: '2026-08-31T12:00:00Z' }), /Future/);
  // Separately isolate the last source date from the method freeze date.
  source.result.frozenDate = '2026-09-01';
  source.result.rows.forEach(row => { row.retrospective = false; });
  source.projection = projectEtfTrend(source.result);
  await assert.rejects(encryptEtfTrend(source, secret, { now: '2026-09-01T02:00:00Z' }), /Future/);
});

test('Hong Kong day boundary governs the owner approval date', async () => {
  const secret = key(), source = payload();
  await assert.rejects(encryptEtfTrend(source, secret, { now: '2026-09-03T15:59:59Z' }), /Future/);
  const envelope = await encryptEtfTrend(source, secret, { now: '2026-09-03T16:00:00Z' });
  assert.ok(envelope.ciphertext);
});

test('business source date cannot advance before New York midnight', async () => {
  const secret = key(), source = payload();
  source.result.frozenDate = '2026-09-01';
  source.result.rows.forEach(row => { row.retrospective = false; });
  source.projection = projectEtfTrend(source.result);
  await assert.rejects(encryptEtfTrend(source, secret, { now: '2026-09-02T03:59:59Z' }), /Future ETF source business/);
  const envelope = await encryptEtfTrend(source, secret, { now: '2026-09-02T04:00:00Z' });
  assert.ok(envelope.ciphertext);
});

test('maxSeenDate rejects rollback but accepts same-date and newer sources', async () => {
  const secret = key(), envelope = await encryptEtfTrend(payload(), secret, OPTIONS);
  for (const maxSeenDate of ['2026-09-01', '2026-09-02']) {
    assert.ok(await decryptEtfTrend(envelope, secret, { ...OPTIONS, maxSeenDate }));
  }
  await assert.rejects(decryptEtfTrend(envelope, secret, { ...OPTIONS, maxSeenDate: '2026-09-03' }), /older/);
  await assert.rejects(encryptEtfTrend(payload(), secret, { ...OPTIONS, maxSeenDate: '2026-09-03' }), /older/);
  await assert.rejects(decryptEtfTrend(envelope, secret, { ...OPTIONS, maxSeenDate: 'bad-date' }), /previously/);
  await assert.rejects(decryptEtfTrend(envelope, secret, { ...OPTIONS, maxSeenDate: '2026-09-05' }), /previously/);
});

test('malformed UTF-8 is rejected before or after decryption', async () => {
  const secret = key();
  await assert.rejects(decryptEtfTrend(new Uint8Array([0xc3, 0x28]), secret, OPTIONS));
  const envelope = await sealRaw(new Uint8Array([0xc3, 0x28]), secret);
  await assert.rejects(decryptEtfTrend(envelope, secret, OPTIONS));
});

test('envelope and authenticated plaintext both enforce strict sub-2MB limits', async () => {
  const secret = key();
  await assert.rejects(decryptEtfTrend(new Uint8Array(MAX_ETF_ENVELOPE_BYTES), secret, OPTIONS), /size/);
  const huge = { ...payload(), oversized: 'x'.repeat(MAX_ETF_ENVELOPE_BYTES) };
  await assert.rejects(encryptEtfTrend(huge, secret, OPTIONS), /size/);
  const large = await sealRaw('x'.repeat(MAX_ETF_ENVELOPE_BYTES), secret);
  await assert.rejects(decryptEtfTrend(large, secret, OPTIONS), /size/);
});

test('duplicate JSON members are rejected instead of silently overridden', async () => {
  const secret = key(), envelope = await encryptEtfTrend(payload(), secret, OPTIONS);
  const duplicateHeader = JSON.stringify(envelope).replace('{', '{"schemaVersion":1,');
  await assert.rejects(decryptEtfTrend(duplicateHeader, secret, OPTIONS), /canonical/);
  const duplicatePayload = JSON.stringify(payload()).replace('{', '{"projection":null,');
  await assert.rejects(decryptEtfTrend(await sealRaw(duplicatePayload, secret), secret, OPTIONS), /canonical/);
});

test('absolute balances and chart must be the same checked result', async () => {
  const p = payload(), secret = key();
  p.result.rows[1].endingUsd.A += 100;
  p.result.rows[1].gainUsd.A += 100;
  await assert.rejects(encryptEtfTrend(p, secret, OPTIONS), /same result/);
  const badGain = payload(); badGain.result.rows[1].gainUsd.A += 1;
  assert.throws(() => validateEtfTrendPayload(badGain, OPTIONS), /cash flow/);
});
