#!/usr/bin/env node
// Private, copy-only recovery of the economic v3 schema in 9d9bc98:index.html.
// This is NOT the page's permissive migrate(), a source-freshness attestation,
// or an assertion that historical v3 and current v4 fee formulas are identical.
// Never print the returned object/buffer or put a real fixture in this repo.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createLegacyPolicy } from "./fee-legacy-policy.mjs";
import { normalizeEconomicInputs } from "./fee-receipt-core.mjs";

export const V3_COPY_SCHEMA = "fee-console.economic-v3-copy.v1";
export const V3_LEGACY_COPY_SCHEMA = "fee-console.economic-v3-copy.v2";
const MAX_BYTES = 5 * 1024 * 1024;
const policy = createLegacyPolicy();
const { STRICT_POLICY_ID, LEGACY_POLICY_ID } = policy;
const own = (o, key) => Object.hasOwn(o, key);
const object = o => o !== null && typeof o === "object" && !Array.isArray(o);

export class V3CopyError extends Error {
  constructor(code) { super(code); this.name = "V3CopyError"; this.code = code; }
}
const reject = code => { throw new V3CopyError(code); };
const requireThat = (condition, code) => { if (!condition) reject(code); };
const keys = (o, required, optional, code) => {
  requireThat(object(o), code);
  requireThat(required.every(key => own(o, key))
    && Object.keys(o).every(key => required.includes(key) || optional.includes(key)), code);
};
const policyCall = operation => {
  try { return operation(); }
  catch (error) {
    if (error?.name === "LegacyPolicyError" && /^[A-Z_]+$/.test(error.code)) reject(error.code);
    throw error;
  }
};
const parseExactJson = bytes => policyCall(() => policy.parseExactJson(bytes));
const projection = (raw, policyId) => policyCall(() => policy.projectV3(raw, policyId));
const selectedPolicyId = options => {
  keys(options, [], ["policyId"], "COPY_OPTIONS_UNSUPPORTED");
  const id = own(options, "policyId") ? options.policyId : STRICT_POLICY_ID;
  requireThat(id === STRICT_POLICY_ID || id === LEGACY_POLICY_ID, "LEGACY_POLICY_UNSUPPORTED");
  return id;
};
const canonical = value => JSON.stringify((function sort(input) {
  if (Array.isArray(input)) return input.map(sort);
  if (!object(input)) return input;
  return Object.fromEntries(Object.keys(input).sort().map(key => [key, sort(input[key])]));
})(value));

/** Preserve every source byte/field inside encrypted provenance. No defaults,
 * generated IDs, expense-to-payment coercion, or source authority claim.
 */
function copyV3EconomicLedger(payloadBytes, sourceEnvelopeBytes, policyId) {
  const { economic, paymentIds, legacyRecords } = projection(parseExactJson(payloadBytes), policyId);
  requireThat(Buffer.isBuffer(sourceEnvelopeBytes) && sourceEnvelopeBytes.length > 0
    && sourceEnvelopeBytes.length <= MAX_BYTES, "SOURCE_ENVELOPE_BYTES_REQUIRED");
  const result = {
    ...economic,
    legacyV3Copy: {
      schema: policyId === STRICT_POLICY_ID ? V3_COPY_SCHEMA : V3_LEGACY_COPY_SCHEMA,
      policy: policyId,
      sourceEnvelopeBase64: sourceEnvelopeBytes.toString("base64"),
      sourcePayloadBase64: payloadBytes.toString("base64"),
      ...(policyId === LEGACY_POLICY_ID ? { paymentIds, legacyRecords } : {})
    }
  };
  try { normalizeEconomicInputs(result); }
  catch { reject("CURRENT_ECONOMIC_SCHEMA_REJECTED"); }
  return result;
}

const decodeEnvelope = (bytes, version) => {
  const outer = parseExactJson(bytes);
  keys(outer, ["enc", "v", "data"], [], "ENVELOPE_FIELDS_UNSUPPORTED");
  requireThat(outer.enc === true && outer.v === version && typeof outer.data === "string", "ENVELOPE_VERSION_UNSUPPORTED");
  requireThat(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(outer.data), "CIPHERTEXT_INVALID");
  const encrypted = Buffer.from(outer.data, "base64");
  requireThat(encrypted.length >= 29 && encrypted.toString("base64") === outer.data, "CIPHERTEXT_INVALID");
  return encrypted;
};
const decrypt = (encrypted, key) => {
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, encrypted.subarray(0, 12));
    decipher.setAuthTag(encrypted.subarray(-16));
    return Buffer.concat([decipher.update(encrypted.subarray(12, -16)), decipher.final()]);
  } catch { reject("SOURCE_AUTHENTICATION_FAILED"); }
};

/** No network or filesystem access. Returns encrypted v4 bytes only. */
export function convertEncryptedV3Copy(sourceBytes, key, options = {}) {
  requireThat(Buffer.isBuffer(key) && key.length === 32, "KEY_INVALID");
  const policyId = selectedPolicyId(options);
  const plain = decrypt(decodeEnvelope(sourceBytes, 3), key);
  let converted;
  try {
    converted = Buffer.from(JSON.stringify(copyV3EconomicLedger(plain, sourceBytes, policyId)), "utf8");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const sealed = Buffer.concat([iv, cipher.update(converted), cipher.final(), cipher.getAuthTag()]);
    const result = Buffer.from(JSON.stringify({ enc: true, v: 4, data: sealed.toString("base64") }), "utf8");
    requireThat(result.length <= MAX_BYTES, "COPY_EXCEEDS_CONSUMER_LIMIT");
    return result;
  } finally { plain.fill(0); converted?.fill(0); }
}

const provenanceBytes = value => {
  requireThat(typeof value === "string"
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),
    "COPY_PROVENANCE_BASE64_INVALID");
  const bytes = Buffer.from(value, "base64");
  requireThat(bytes.length > 0 && bytes.length <= MAX_BYTES && bytes.toString("base64") === value,
    "COPY_PROVENANCE_BASE64_INVALID");
  return bytes;
};

/** Authenticate copy provenance with the existing key, in memory only. This
 * proves source/copy integrity, NOT freshness, authority, or actual payment.
 * A native v4 without provenance is unchanged; declared provenance never gets
 * ignored, even when malformed or from an unsupported policy/schema.
 */
export function assertLegacyCopyAuthenticity(raw, key) {
  requireThat(object(raw) && raw.v === 4, "COPY_LEDGER_INVALID");
  if (!own(raw, "legacyV3Copy")) return;
  requireThat(Buffer.isBuffer(key) && key.length === 32, "KEY_INVALID");
  keys(raw, ["v", "updatedAt", "settings", "accounts", "months", "fees", "legacyV3Copy"], [], "COPY_LEDGER_FIELDS_UNSUPPORTED");
  const provenance = raw.legacyV3Copy;
  requireThat(object(provenance), "COPY_PROVENANCE_INVALID");
  const legacy = provenance.schema === V3_LEGACY_COPY_SCHEMA && provenance.policy === LEGACY_POLICY_ID;
  const strict = provenance.schema === V3_COPY_SCHEMA && provenance.policy === STRICT_POLICY_ID;
  requireThat(legacy || strict, "COPY_PROVENANCE_POLICY_UNSUPPORTED");
  keys(provenance, ["schema", "policy", "sourceEnvelopeBase64", "sourcePayloadBase64",
    ...(legacy ? ["paymentIds", "legacyRecords"] : [])], [], "COPY_PROVENANCE_FIELDS_UNSUPPORTED");
  let claimed, authenticated;
  try {
    const source = provenanceBytes(provenance.sourceEnvelopeBase64);
    claimed = provenanceBytes(provenance.sourcePayloadBase64);
    authenticated = decrypt(decodeEnvelope(source, 3), key);
    requireThat(claimed.equals(authenticated), "COPY_SOURCE_PAYLOAD_MISMATCH");
    const expected = projection(parseExactJson(authenticated), provenance.policy);
    const { legacyV3Copy, ...economic } = raw;
    requireThat(canonical(economic) === canonical(expected.economic), "COPY_ECONOMIC_PROJECTION_MISMATCH");
    if (legacy) {
      requireThat(JSON.stringify(provenance.paymentIds) === JSON.stringify(expected.paymentIds)
        && JSON.stringify(provenance.legacyRecords) === JSON.stringify(expected.legacyRecords), "COPY_FEE_PARTITION_MISMATCH");
    }
    try { normalizeEconomicInputs(raw); }
    catch { reject("CURRENT_ECONOMIC_SCHEMA_REJECTED"); }
  } finally { claimed?.fill(0); authenticated?.fill(0); }
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outsideRepo = target => {
  const rel = path.relative(repoRoot, target);
  requireThat(rel === ".." || rel.startsWith(".." + path.sep), "PRIVATE_PATH_INSIDE_REPOSITORY");
};

// CLI accepts no arguments, so paths/keys cannot accidentally enter argv or be
// reflected by an argument parser. Existing env key only; never creates a key.
export function runCopyCli() {
  let key, written = null;
  try {
    requireThat(!/^(?:1|true)$/i.test(String(process.env.GITHUB_ACTIONS || "").trim()), "ACTIONS_REFUSED");
    requireThat(process.argv.length === 2, "ARGUMENTS_REFUSED_USE_ENV");
    const encoded = String(process.env.FEE_DATA_KEY || "").trim();
    requireThat(/^[A-Za-z0-9_+/-]{43}=?$/.test(encoded), "KEY_UNAVAILABLE_OR_INVALID");
    const normalizedKey = encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=$/, "");
    key = Buffer.from(normalizedKey, "base64url");
    requireThat(key.length === 32 && key.toString("base64url") === normalizedKey, "KEY_UNAVAILABLE_OR_INVALID");
    const input = String(process.env.FEE_ECON_V3_FILE || "");
    const output = String(process.env.FEE_ECON_COPY_FILE || "");
    requireThat(path.isAbsolute(input) && path.isAbsolute(output), "PRIVATE_ABSOLUTE_PATHS_REQUIRED");
    const source = fs.realpathSync(input);
    const target = path.join(fs.realpathSync(path.dirname(output)), path.basename(output));
    outsideRepo(source); outsideRepo(target);
    requireThat(source !== target, "SOURCE_OVERWRITE_REFUSED");
    const stat = fs.statSync(source);
    requireThat(stat.isFile() && stat.size > 0 && stat.size <= MAX_BYTES, "SOURCE_FILE_INVALID");
    const first = fs.readFileSync(source), second = fs.readFileSync(source);
    requireThat(first.equals(second), "SOURCE_CHANGED_DURING_READ");
    const policyId = process.env.FEE_ECON_V3_POLICY === undefined ? STRICT_POLICY_ID : process.env.FEE_ECON_V3_POLICY;
    const copy = convertEncryptedV3Copy(first, key, { policyId });
    const fd = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    written = target;
    try { fs.writeFileSync(fd, copy); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    requireThat(fs.readFileSync(target).equals(copy) && (fs.statSync(target).mode & 0o777) === 0o600, "COPY_READBACK_FAILED");
    requireThat(fs.readFileSync(source).equals(first), "SOURCE_CHANGED_DURING_COPY");
    // No values, identifiers, hashes, paths, source bytes or ciphertext in logs.
    console.log("FEE_ECON_V3_ENCRYPTED_COPY_CREATED; SOURCE_UNCHANGED; AUTHORITY_NOT_ATTESTED");
    written = null;
  } catch (error) {
    if (written) { try { fs.unlinkSync(written); } catch {} }
    console.error("FEE_ECON_V3_COPY_REJECTED: " + (error instanceof V3CopyError ? error.code : "PRIVATE_IO_FAILED"));
    process.exitCode = 1;
  } finally { key?.fill(0); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCopyCli();
