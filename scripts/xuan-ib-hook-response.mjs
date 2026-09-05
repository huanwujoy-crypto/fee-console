// Strict, pure transport decoding for an actual PostToolUse tool_response.
// No hooks are installed here; no financial call, persistence or publication.
// Original transport persistence, timestamps and authorization belong to the
// controller. Decoding is not proof that the response came from a connector.
import { canonicalJson, fingerprint } from './xuan-ib-run-manifest.mjs';
import { parseDecisionJson } from './xuan-ib-decision-menu.mjs';
import { unwrapSource } from './xuan-ib-source-adapter.mjs';
import { CAPTURE_SOURCE_KEYS } from './xuan-ib-source-capture.mjs';

export const MAX_HOOK_RESPONSE_BYTES = 4 * 1024 * 1024;
const fail = code => { throw new Error(`XUAN-IB hook response: ${code}`); };
const plain = value => value !== null && typeof value === 'object'
  && Object.getPrototypeOf(value) === Object.prototype;
const unpairedSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;
const validString = value => { if (unpairedSurrogate.test(value)) fail('INVALID_UNICODE'); };

function validateNativeJson(value, depth = 0, ancestors = new Set()) {
  if (depth > 32) fail('MAX_DEPTH_EXCEEDED');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') { validString(value); return; }
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('NONFINITE_NUMBER'); return; }
  const array = Array.isArray(value);
  if ((!array && !plain(value)) || (array && Object.getPrototypeOf(value) !== Array.prototype)) fail('NON_JSON_NATIVE_VALUE');
  if (ancestors.has(value)) fail('CYCLIC_VALUE');
  ancestors.add(value);
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) fail('NON_JSON_NATIVE_VALUE');
  for (const key of keys) {
    if (typeof key !== 'string') fail('NON_JSON_NATIVE_VALUE');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (array && key === 'length') continue;
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('NON_JSON_NATIVE_VALUE');
    if (array && (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) fail('NON_JSON_NATIVE_VALUE');
    validString(key);
    validateNativeJson(descriptor.value, depth + 1, ancestors);
  }
  ancestors.delete(value);
}

function size(value, code) {
  // Hashing and size checks use the repository's existing canonical algorithm,
  // including its JavaScript numeric-like object-key ordering semantics.
  if (Buffer.byteLength(canonicalJson(value), 'utf8') > MAX_HOOK_RESPONSE_BYTES) fail(code);
}

/** Accept a native JSON object or exactly one JSON string encoding that object.
 * Fingerprints deliberately name different things: the original transport
 * value versus its decoded native response. A string's whitespace, escapes
 * and key order remain part of its transport fingerprint. Native-object
 * transport has equal hashes, which is expected, not a missing receipt.
 * This is not a byte API: the controller must fatally decode UTF-8 first.
 */
export function decodeHookResponse(toolResponse, { sourceKey } = {}) {
  if (!CAPTURE_SOURCE_KEYS.includes(sourceKey)) fail('INVALID_SOURCE_KEY');
  const wrapper = typeof toolResponse === 'string' ? 'json-string' : 'native-object';
  if (wrapper === 'native-object' && !plain(toolResponse)) fail('UNSUPPORTED_TOOL_RESPONSE');
  validateNativeJson(toolResponse);
  size(toolResponse, 'TOOL_RESPONSE_TOO_LARGE');
  let raw = toolResponse;
  if (wrapper === 'json-string') {
    if (Buffer.byteLength(toolResponse, 'utf8') > MAX_HOOK_RESPONSE_BYTES) fail('TOOL_RESPONSE_TOO_LARGE');
    // First validate duplicate keys, depth and complete syntax. The second
    // parser restores ordinary object prototypes; it does NOT decode another
    // wrapper layer or normalize any financial values.
    try { parseDecisionJson(toolResponse, MAX_HOOK_RESPONSE_BYTES); raw = JSON.parse(toolResponse); }
    catch { fail('INVALID_TOOL_RESPONSE_JSON'); }
    if (!plain(raw)) fail('UNSUPPORTED_TOOL_RESPONSE');
    validateNativeJson(raw);
  }
  if (Object.hasOwn(raw, 'error') || (Object.hasOwn(raw, 'isError') && raw.isError !== false)) fail('UPSTREAM_ERROR');
  // Do not peel MCP content/structuredContent or mixed wrappers to recover a
  // success-looking subsection. New transport shapes need separate review.
  if (Object.hasOwn(raw, 'content') || Object.hasOwn(raw, 'structuredContent')
    || Object.hasOwn(raw, 'tool_response')) fail('UNSUPPORTED_RESPONSE_WRAPPER');
  size(raw, 'RAW_RESPONSE_TOO_LARGE');
  try { unwrapSource(sourceKey.startsWith('ib.') ? sourceKey.slice(3) : 'sharesight', raw); }
  catch { fail('UNSUPPORTED_NATIVE_SOURCE'); }
  if (sourceKey.startsWith('sharesight.') && raw.result.portfolio.id !== Number(sourceKey.slice('sharesight.'.length))) fail('SOURCE_PORTFOLIO_MISMATCH');
  return { raw, transportFingerprint: fingerprint(toolResponse), rawFingerprint: fingerprint(raw), wrapper };
}
