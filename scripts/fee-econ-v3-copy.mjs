#!/usr/bin/env node
// Private, copy-only recovery of the economic v3 schema in 9d9bc98:index.html.
// This is NOT the page's permissive migrate(), a source-freshness attestation,
// or an assertion that historical v3 and current v4 fee formulas are identical.
// Never print the returned object/buffer or put a real fixture in this repo.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isCalendarDate } from "./fee-engine.mjs";
import { normalizeEconomicInputs } from "./fee-receipt-core.mjs";

export const V3_COPY_SCHEMA = "fee-console.economic-v3-copy.v1";
const MAX_BYTES = 5 * 1024 * 1024;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const ACCOUNTS = ["schwab", "webull"];
const LEGACY_FX = ["USD", "HKD", "CNY", "EUR", "SGD", "GBP", "JPY"];
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
const numeric = (value, code) => {
  requireThat(typeof value === "number" || (typeof value === "string"
    && value.trim() !== "" && NUMBER.test(value.trim())), code);
  const n = Number(value);
  requireThat(Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER / 100, code);
  return n;
};
const id = (value, code) => requireThat(typeof value === "string" && value.length > 0
  && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value), code);
const date = (value, code) => requireThat(typeof value === "string" && isCalendarDate(value), code);
const unique = (values, code) => requireThat(new Set(values).size === values.length, code);
const clone = value => structuredClone(value);

// JSON.parse alone silently accepts duplicate keys. Scan valid JSON as well,
// rejecting duplicate keys (including escaped spellings) without logging text.
const parseExactJson = bytes => {
  requireThat(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_BYTES, "INPUT_BYTES_INVALID");
  let text, parsed;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); parsed = JSON.parse(text); }
  catch { reject("INPUT_JSON_INVALID"); }
  let pos = 0;
  const ws = () => { while (/\s/.test(text[pos] || "") && pos < text.length) pos++; };
  const string = () => {
    const start = pos++;
    while (pos < text.length) {
      if (text[pos] === "\\") { pos += 2; continue; }
      if (text[pos++] === '"') return JSON.parse(text.slice(start, pos));
    }
    reject("INPUT_JSON_INVALID");
  };
  const value = depth => {
    requireThat(depth < 64, "INPUT_JSON_DEPTH"); ws();
    if (text[pos] === '"') { string(); return; }
    if (text[pos] === "{") {
      pos++; ws(); const seen = new Set();
      if (text[pos] === "}") { pos++; return; }
      for (;;) {
        ws(); const key = string();
        requireThat(!seen.has(key), "INPUT_DUPLICATE_JSON_KEY"); seen.add(key);
        ws(); pos++; value(depth + 1); ws();
        if (text[pos++] === "}") return;
      }
    }
    if (text[pos] === "[") {
      pos++; ws(); if (text[pos] === "]") { pos++; return; }
      for (;;) { value(depth + 1); ws(); if (text[pos++] === "]") return; }
    }
    while (pos < text.length && !/[\s,\]}]/.test(text[pos])) pos++;
  };
  value(0);
  return parsed;
};

const validateV3 = raw => {
  keys(raw, ["v", "updatedAt", "settings", "accounts", "months", "fees"], [], "LEDGER_FIELDS_UNSUPPORTED");
  requireThat(raw.v === 3, "LEDGER_VERSION_UNSUPPORTED");
  requireThat(typeof raw.updatedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(raw.updatedAt)
    && isCalendarDate(raw.updatedAt.slice(0, 10)) && Number.isFinite(Date.parse(raw.updatedAt)), "LEDGER_UPDATED_AT_INVALID");
  const s = raw.settings;
  keys(s, ["start", "mgmt", "carry", "who", "openingAt", "fx"], [], "SETTINGS_FIELDS_UNSUPPORTED");
  date(s.start, "START_INVALID"); date(s.openingAt, "OPENING_DATE_INVALID");
  requireThat(Date.parse(s.start + "T00:00:00Z") - Date.parse(s.openingAt + "T00:00:00Z") === 86400000,
    "OPENING_DATE_REQUIRES_REVIEW");
  requireThat(typeof s.who === "string", "OWNER_LABEL_INVALID");
  numeric(s.mgmt, "MANAGEMENT_RATE_INVALID"); numeric(s.carry, "CARRY_RATE_INVALID");
  requireThat(object(s.fx) && LEGACY_FX.every(ccy => own(s.fx, ccy)), "FX_MAP_INCOMPLETE");
  for (const [ccy, fx] of Object.entries(s.fx)) {
    requireThat(/^[A-Z]{3}$/.test(ccy) && numeric(fx, "FX_RATE_INVALID") > 0, "FX_RATE_INVALID");
  }
  requireThat(Number(s.fx.USD) === 1, "USD_FX_REQUIRES_REVIEW");
  requireThat(Array.isArray(raw.accounts) && raw.accounts.length === 2, "ACCOUNT_SET_INVALID");
  for (const a of raw.accounts) {
    keys(a, ["id", "name", "opening"], [], "ACCOUNT_FIELDS_UNSUPPORTED");
    requireThat(ACCOUNTS.includes(a.id), "ACCOUNT_SET_INVALID");
    requireThat(typeof a.name === "string" && a.name.trim() !== "", "ACCOUNT_NAME_INVALID");
    requireThat(numeric(a.opening, "OPENING_AMOUNT_INVALID") >= 0, "OPENING_AMOUNT_INVALID");
  }
  unique(raw.accounts.map(a => a.id), "ACCOUNT_SET_INVALID");
  requireThat(raw.accounts.reduce((sum, a) => sum + Number(a.opening), 0) > 0, "BLANK_LEDGER_REJECTED");

  requireThat(Array.isArray(raw.months), "MONTHS_MISSING");
  const flows = [];
  for (const m of raw.months) {
    keys(m, ["ym", "locked", "lockedAt", "snap", "flows", "manualClose"], [], "MONTH_FIELDS_UNSUPPORTED");
    requireThat(typeof m.ym === "string" && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(m.ym)
      && m.ym >= s.start.slice(0, 7), "MONTH_INVALID");
    // Even an empty-looking historical snapshot or manual-close entry is not
    // discarded. A separate reviewed migration is required for these features.
    requireThat(m.locked === false && m.lockedAt === null && m.snap === null, "LEGACY_LOCK_REQUIRES_REVIEW");
    requireThat(object(m.manualClose) && Object.keys(m.manualClose).length === 0, "LEGACY_MANUAL_CLOSE_REQUIRES_REVIEW");
    requireThat(Array.isArray(m.flows), "FLOWS_MISSING");
    for (const f of m.flows) {
      keys(f, ["id", "date", "acct", "amount", "note"], ["src"], "FLOW_FIELDS_UNSUPPORTED");
      id(f.id, "FLOW_ID_INVALID"); date(f.date, "FLOW_DATE_INVALID");
      requireThat(f.date.slice(0, 7) === m.ym && f.date >= s.start, "FLOW_DATE_REQUIRES_REVIEW");
      requireThat(ACCOUNTS.includes(f.acct), "FLOW_ACCOUNT_INVALID");
      requireThat(numeric(f.amount, "FLOW_AMOUNT_INVALID") !== 0, "FLOW_AMOUNT_INVALID");
      requireThat(typeof f.note === "string", "FLOW_NOTE_INVALID");
      if (own(f, "src")) {
        requireThat(typeof f.src === "string", "FLOW_SOURCE_INVALID");
        if (f.src !== "") id(f.src, "FLOW_SOURCE_INVALID");
      }
      flows.push(f);
    }
  }
  unique(raw.months.map(m => m.ym), "DUPLICATE_MONTH");
  requireThat(raw.months.every((m, index) => index === 0 || raw.months[index - 1].ym < m.ym),
    "MONTH_ORDER_REQUIRES_REVIEW");
  unique(flows.map(f => f.id), "DUPLICATE_FLOW_ID");
  unique(flows.filter(f => f.src).map(f => f.src), "DUPLICATE_FLOW_SOURCE");

  requireThat(Array.isArray(raw.fees), "FEES_MISSING");
  for (const f of raw.fees) {
    keys(f, ["id", "type", "date", "amount", "ccy", "fx", "note"], ["cat"], "FEE_FIELDS_UNSUPPORTED");
    requireThat(f.type === "pay", "LEGACY_EXPENSE_OR_TYPE_REQUIRES_REVIEW");
    id(f.id, "PAYMENT_ID_INVALID"); date(f.date, "PAYMENT_DATE_INVALID");
    requireThat(f.date >= s.start, "PAYMENT_DATE_REQUIRES_REVIEW");
    requireThat(numeric(f.amount, "PAYMENT_AMOUNT_INVALID") > 0, "PAYMENT_AMOUNT_INVALID");
    requireThat(typeof f.ccy === "string" && /^[A-Z]{3}$/.test(f.ccy) && own(s.fx, f.ccy), "PAYMENT_CURRENCY_INVALID");
    // An explicitly blank FX uses the existing, required map in BOTH versions;
    // it is preserved blank, not replaced by a new default or live quote.
    requireThat(f.fx === "" || numeric(f.fx, "PAYMENT_FX_INVALID") > 0, "PAYMENT_FX_INVALID");
    requireThat(typeof f.note === "string" && (!own(f, "cat") || typeof f.cat === "string"), "PAYMENT_TEXT_INVALID");
  }
  unique(raw.fees.map(f => f.id), "DUPLICATE_PAYMENT_ID");
  return raw;
};

/** Private in-memory copy. Every source byte/field is retained in provenance.
 * IDs, dates, monetary representations, FX, and updatedAt are never synthesized.
 * Provenance belongs only inside the encrypted economic copy, never a receipt.
 */
function copyV3EconomicLedger(payloadBytes, sourceEnvelopeBytes) {
  const raw = validateV3(parseExactJson(payloadBytes));
  requireThat(Buffer.isBuffer(sourceEnvelopeBytes) && sourceEnvelopeBytes.length > 0
    && sourceEnvelopeBytes.length <= MAX_BYTES, "SOURCE_ENVELOPE_BYTES_REQUIRED");
  const result = {
    v: 4,
    updatedAt: raw.updatedAt,
    settings: clone(raw.settings),
    accounts: clone(raw.accounts),
    months: raw.months.map(m => ({ ym: m.ym, flows: clone(m.flows) })),
    fees: raw.fees.map(({ type, cat, ...payment }) => clone(payment)),
    legacyV3Copy: {
      schema: V3_COPY_SCHEMA,
      policy: "strict-safe-subset-copy-only",
      sourceEnvelopeBase64: sourceEnvelopeBytes.toString("base64"),
      sourcePayloadBase64: payloadBytes.toString("base64")
    }
  };
  // Payment type/cat and inactive lock/manualClose fields are accounted for in
  // exact provenance, not silently forgotten. Current monetary inputs must pass
  // the same strict normalizer used by the receipt writer and reader.
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
export function convertEncryptedV3Copy(sourceBytes, key) {
  requireThat(Buffer.isBuffer(key) && key.length === 32, "KEY_INVALID");
  const plain = decrypt(decodeEnvelope(sourceBytes, 3), key);
  let converted;
  try {
    converted = Buffer.from(JSON.stringify(copyV3EconomicLedger(plain, sourceBytes)), "utf8");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const sealed = Buffer.concat([iv, cipher.update(converted), cipher.final(), cipher.getAuthTag()]);
    const result = Buffer.from(JSON.stringify({ enc: true, v: 4, data: sealed.toString("base64") }), "utf8");
    requireThat(result.length <= MAX_BYTES, "COPY_EXCEEDS_CONSUMER_LIMIT");
    return result;
  } finally { plain.fill(0); converted?.fill(0); }
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
    const copy = convertEncryptedV3Copy(first, key);
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
