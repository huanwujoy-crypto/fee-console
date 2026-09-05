import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeHookResponse, MAX_HOOK_RESPONSE_BYTES } from './xuan-ib-hook-response.mjs';
import { canonicalJson, fingerprint } from './xuan-ib-run-manifest.mjs';
import { CAPTURE_SOURCE_KEYS } from './xuan-ib-source-capture.mjs';

const decode = value => decodeHookResponse(value, { sourceKey: 'ib.positions' });
const raw = () => ({ positions: [{ contract_description: 'SYNTHETIC @ native', position: 2,
  market_price: 10, market_value: 20, currency: 'USD' }] });
const ssKey = CAPTURE_SOURCE_KEYS.find(key => key.startsWith('sharesight.'));
const ssId = Number(ssKey.slice('sharesight.'.length));
const sharesight = (id = ssId) => ({ result: { mode: 'read_only', portfolio: { id, currency_code: 'USD' },
  data: { report: { portfolio_id: id, value: 100, end_date: '2026-09-05', currency: { code: 'USD' },
    holdings: [], cash_accounts: [] } } } });

test('native object is returned unchanged with equal canonical transport/raw hashes', () => {
  const input = raw(), before = JSON.stringify(input), result = decode(input);
  assert.equal(result.raw, input); assert.equal(JSON.stringify(input), before);
  assert.equal(result.wrapper, 'native-object');
  assert.equal(result.transportFingerprint, fingerprint(input));
  assert.equal(result.rawFingerprint, fingerprint(input));
  assert.deepEqual(Object.keys(result).sort(), ['raw', 'rawFingerprint', 'transportFingerprint', 'wrapper']);
});

test('one JSON string decodes without financial rewrites and keeps distinct transport/raw fingerprints', () => {
  const native = raw(), transport = JSON.stringify(native, null, 2), result = decode(transport);
  assert.deepEqual(result.raw, native); assert.equal(result.wrapper, 'json-string');
  assert.equal(result.transportFingerprint, fingerprint(transport));
  assert.equal(result.rawFingerprint, fingerprint(native));
  assert.notEqual(result.transportFingerprint, result.rawFingerprint);
  const compact = decode(JSON.stringify(native));
  assert.notEqual(result.transportFingerprint, compact.transportFingerprint);
  assert.equal(result.rawFingerprint, compact.rawFingerprint);
});

test('unicode, escaped quotation marks, backslashes and control escapes survive exactly one parse', () => {
  const native = raw(); native.positions[0].contract_description = '中文🌏 "quoted" \\ path\nline\ttab';
  const transport = JSON.stringify(native), result = decode(transport);
  assert.deepEqual(result.raw, native);
  const escaped = transport.replace('中文🌏', '\\u4e2d\\u6587\\ud83c\\udf0f');
  const alternative = decode(escaped);
  assert.deepEqual(alternative.raw, native);
  assert.equal(alternative.rawFingerprint, result.rawFingerprint);
  assert.notEqual(alternative.transportFingerprint, result.transportFingerprint);
});

test('object order including integer-like keys follows repo canonicalJson, never a bespoke serializer', () => {
  const a = { positions: [], z: { '10': 'ten', '2': 'two', '01': 'one', a: 'last' }, a: true };
  const b = { a: true, z: { a: 'last', '01': 'one', '2': 'two', '10': 'ten' }, positions: [] };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(decode(a).rawFingerprint, decode(b).rawFingerprint);
  assert.equal(decode(a).transportFingerprint, fingerprint(a));
  const strings = [JSON.stringify(a), JSON.stringify(b)].map(value => decode(value));
  assert.equal(strings[0].rawFingerprint, strings[1].rawFingerprint);
  assert.notEqual(strings[0].transportFingerprint, strings[1].transportFingerprint);
});

test('duplicates including escaped duplicate keys and nested duplicates are rejected before JSON.parse loses them', () => {
  for (const value of ['{"positions":[],"positions":[]}', '{"positions":[],"\\u0070ositions":[]}',
    '{"positions":[],"extra":{"a":1,"a":2}}']) {
    assert.throws(() => decode(value), /INVALID_TOOL_RESPONSE_JSON/);
  }
});

test('depth above 32 and nonfinite values fail in native and encoded transports', () => {
  const value = raw(); let node = value;
  for (let i = 0; i < 34; i++) { node.child = {}; node = node.child; }
  assert.throws(() => decode(value), /MAX_DEPTH_EXCEEDED/);
  assert.throws(() => decode(JSON.stringify(value)), /INVALID_TOOL_RESPONSE_JSON/);
  for (const number of [NaN, Infinity, -Infinity]) assert.throws(() => decode({ positions: [], extra: number }), /NONFINITE_NUMBER/);
  assert.throws(() => decode('{"positions":[],"extra":1e400}'), /NONFINITE_NUMBER/);
});

test('error payloads cannot be recast as success using native fields or an encoded wrapper', () => {
  for (const marker of [{ error: 'SYNTHETIC upstream failure' }, { error: null }, { isError: true },
    { isError: 'false' }, { isError: 0 }]) {
    for (const value of [{ positions: [], ...marker }, JSON.stringify({ positions: [], ...marker })]) {
      assert.throws(() => decode(value), /UPSTREAM_ERROR/);
    }
  }
  assert.equal(decode({ positions: [], isError: false }).wrapper, 'native-object');
});

test('truncation, fences, MCP content, structured content and double-encoding never become native success', () => {
  for (const value of ['{"positions": [', '{"positions":[]} cutoff', '```json\n{"positions":[]}\n```']) {
    assert.throws(() => decode(value), /INVALID_TOOL_RESPONSE_JSON/);
  }
  for (const value of [{ content: [{ type: 'text', text: JSON.stringify(raw()) }] },
    { positions: [], content: [] }, { structuredContent: raw() },
    { positions: [], structuredContent: raw() }, { tool_response: raw() }]) {
    assert.throws(() => decode(value), /UNSUPPORTED_RESPONSE_WRAPPER/);
    assert.throws(() => decode(JSON.stringify(value)), /UNSUPPORTED_RESPONSE_WRAPPER/);
  }
  assert.throws(() => decode(JSON.stringify(JSON.stringify(raw()))), /UNSUPPORTED_TOOL_RESPONSE/);
});

test('arrays, null, primitive transports, bytes and unpaired surrogates are not a native JSON-object API', () => {
  for (const value of [[], null, 0, true, undefined, Buffer.from([0xff]), new Uint8Array([0xff]),
    '[]', 'null', 'true', '1', '"hello"']) assert.throws(() => decode(value), /UNSUPPORTED_TOOL_RESPONSE/);
  for (const value of [{ positions: [], extra: '\ud800' }, '{"positions":[],"extra":"\\ud800"}',
    '{"positions":[],"extra":"\ud800"}']) assert.throws(() => decode(value), /INVALID_UNICODE/);
});

test('native values that JSON would silently alter or execute are rejected without running accessors', () => {
  let reads = 0;
  const accessor = { positions: [] }; Object.defineProperty(accessor, 'extra', { enumerable: true, get() { reads++; return 1; } });
  const hidden = { positions: [] }; Object.defineProperty(hidden, 'extra', { enumerable: false, value: 1 });
  const sparse = { positions: new Array(1) };
  const arrayExtra = { positions: [] }; arrayExtra.positions.extra = true;
  const symbol = { positions: [], [Symbol('hidden')]: true };
  for (const value of [accessor, hidden, sparse, arrayExtra, symbol, { positions: [], extra: undefined },
    { positions: [], extra: 1n }, { positions: [], extra: new Date() },
    { positions: [], toJSON() { reads++; return { positions: [] }; } }, Object.assign(Object.create(null), { positions: [] })]) {
    assert.throws(() => decode(value), /NON_JSON_NATIVE_VALUE|UNSUPPORTED_TOOL_RESPONSE/);
  }
  assert.equal(reads, 0);
  const cyclic = raw(); cyclic.again = cyclic; assert.throws(() => decode(cyclic), /CYCLIC_VALUE/);
});

test('source keys are exactly the existing production capture allowlist, not public hook-probe tools', () => {
  for (const sourceKey of [undefined, 'ib.whats_new', 'whats_new', 'get_whats_new', 'ib.positions.extra', 'sharesight.0', '__proto__']) {
    assert.throws(() => decodeHookResponse(raw(), { sourceKey }), /INVALID_SOURCE_KEY/);
  }
  for (const [sourceKey, value] of [['ib.accountSummary', { currency: 'USD', net_liquidation: 100, total_cash_value: 10 }],
    ['ib.balances', { balances: [] }], ['ib.positions', { positions: [] }],
    ['ib.orders', { orders: [] }], ['ib.trades', { trades: [] }]]) {
    assert.deepEqual(decodeHookResponse(JSON.stringify(value), { sourceKey }).raw, value);
  }
});

test('portfolio agreement and existing native shell/read-only validation remain mandatory', () => {
  const input = sharesight();
  assert.deepEqual(decodeHookResponse(input, { sourceKey: ssKey }).raw, input);
  const otherKey = CAPTURE_SOURCE_KEYS.find(key => key.startsWith('sharesight.') && key !== ssKey);
  assert.throws(() => decodeHookResponse(input, { sourceKey: otherKey }), /SOURCE_PORTFOLIO_MISMATCH/);
  input.result.mode = 'write'; assert.throws(() => decodeHookResponse(input, { sourceKey: ssKey }), /UNSUPPORTED_NATIVE_SOURCE/);
  for (const value of [{ positions: null }, { wrongField: [] }, { positions: [], error: 'no' }]) assert.throws(() => decode(value));
});

test('UTF-8 byte bounds cover both object serialization and encoded-string transport', () => {
  assert.equal(MAX_HOOK_RESPONSE_BYTES, 4 * 1024 * 1024);
  assert.throws(() => decode({ positions: [], padding: 'a'.repeat(MAX_HOOK_RESPONSE_BYTES) }), /TOOL_RESPONSE_TOO_LARGE/);
  const escaped = { positions: [], padding: '\n'.repeat(MAX_HOOK_RESPONSE_BYTES / 3) };
  assert.ok(Buffer.byteLength(canonicalJson(escaped)) < MAX_HOOK_RESPONSE_BYTES);
  assert.ok(Buffer.byteLength(canonicalJson(JSON.stringify(escaped))) > MAX_HOOK_RESPONSE_BYTES);
  assert.equal(decode(escaped).wrapper, 'native-object');
  assert.throws(() => decode(JSON.stringify(escaped)), /TOOL_RESPONSE_TOO_LARGE/);
  assert.throws(() => decode({ positions: [], padding: '中'.repeat(MAX_HOOK_RESPONSE_BYTES / 2) }), /TOOL_RESPONSE_TOO_LARGE/);
});

test('error messages are static and never echo raw payload, source descriptions or portfolio identities', () => {
  assert.throws(() => decode({ positions: [], error: 'SYNTHETIC PRIVATE PAYLOAD must not echo' }),
    error => error.message === 'XUAN-IB hook response: UPSTREAM_ERROR');
});
