#!/usr/bin/env node
// Incident-specific repair for the 2026-08-20 BRK/B in-kind transfer.
//
// Default mode is read-only.  --apply is accepted only when the encrypted
// payload contains exactly four legacy effective rows for the known event and
// no canonical or unresolved copy.  Any other shape is refused byte-for-byte.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { flowId, inKindBusinessKey } from "./daily-core.mjs";

const die = message => { console.error("error: " + message); process.exit(1); };

const INCIDENT = Object.freeze({
  date: "2026-08-20",
  acct: "webull",
  amount: 387550.8,
  sourceTradeId: 135783050,
  tradeId: 135784216,
  holdingId: 28921427
});
const EXPECTED_LEGACY_COUNT = 4;

let file = "data.json";
let apply = false;
for (const arg of process.argv.slice(2)) {
  if (arg === "--apply") { apply = true; continue; }
  if (arg.startsWith("--file=")) {
    if (file !== "data.json") die("duplicate --file");
    file = arg.slice("--file=".length);
    if (!file) die("--file must not be empty");
    continue;
  }
  if (arg === "--key" || arg.startsWith("--key="))
    die("--key is refused; supply FEE_DATA_KEY through the environment");
  die(`unknown argument ${JSON.stringify(arg)}`);
}

const rawKey = (process.env.FEE_DATA_KEY || "").trim();
if (!rawKey) die("FEE_DATA_KEY is not set (32-byte base64url key required)");
if (!/^[A-Za-z0-9_+/-]{43}={0,2}$/.test(rawKey))
  die("FEE_DATA_KEY must be a 32-byte base64url value");
const key = Buffer.from(rawKey.replace(/-/g, "+").replace(/_/g, "/"), "base64");
if (key.length !== 32) die("FEE_DATA_KEY must decode to exactly 32 bytes");

const decrypt = b64 => {
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length < 29) throw new Error("ciphertext too short");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  return Buffer.concat([
    decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()
  ]).toString("utf8");
};

const encrypt = text => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString("base64");
};

let outer;
try { outer = JSON.parse(fs.readFileSync(file, "utf8")); }
catch { die(`${file} is not valid JSON`); }
if (!outer || outer.enc !== true || outer.v !== 3 || typeof outer.data !== "string")
  die(`${file} must be an encrypted v3 envelope`);

let payload;
try { payload = JSON.parse(decrypt(outer.data)); }
catch { die("decrypt failed or payload is invalid — nothing written"); }
if (!payload || typeof payload !== "object" || Array.isArray(payload))
  die("decrypted payload has an unexpected shape");
if (!Array.isArray(payload.flowsAuto) || !Array.isArray(payload.flowsUnresolved))
  die("decrypted payload is missing flow arrays");

const sameAmount = value => Number.isFinite(Number(value))
  && Math.abs(Number(value) - INCIDENT.amount) < 0.005;
const sameTuple = flow => flow && flow.date === INCIDENT.date
  && flow.acct === INCIDENT.acct && sameAmount(flow.amount);
const businessRaw = {
  ...INCIDENT,
  desc: "BRK/B 780 shares received from IB-HK by FOP",
  evidence: "external_asset_transfer"
};
const businessKey = inKindBusinessKey(businessRaw);
const canonicalId = flowId(businessRaw);

const tupleAuto = payload.flowsAuto.filter(sameTuple);
const legacy = tupleAuto.filter(flow => flow.effective === true
  && /^verified external asset transfer\b/.test(String(flow.reason || ""))
  && !flow.businessKey);
const canonical = tupleAuto.filter(flow => flow.businessKey === businessKey
  && flow.id === canonicalId && flow.effective === true);
const unresolved = payload.flowsUnresolved.filter(sameTuple);

if (canonical.length === 1 && legacy.length === 0 && tupleAuto.length === 1 && unresolved.length === 0) {
  console.log("no-op canonical=1 legacy=0");
  process.exit(0);
}

if (canonical.length !== 0 || tupleAuto.length !== EXPECTED_LEGACY_COUNT
  || legacy.length !== EXPECTED_LEGACY_COUNT || unresolved.length !== 0) {
  die("incident rows do not match the expected four-legacy-row shape — nothing written");
}
const legacyIds = new Set(legacy.map(flow => String(flow.id || "")));
if (legacyIds.size !== EXPECTED_LEGACY_COUNT || legacyIds.has(""))
  die("legacy incident rows do not have four distinct ids — nothing written");

if (!apply) {
  console.log("ready canonical=0 legacy=4 apply=false");
  process.exit(0);
}

const firstIndex = payload.flowsAuto.findIndex(flow => legacy.includes(flow));
const canonicalRecord = {
  id: canonicalId,
  date: INCIDENT.date,
  acct: INCIDENT.acct,
  amount: INCIDENT.amount,
  desc: businessRaw.desc,
  reason: `verified external asset transfer ${businessKey}`,
  effective: true,
  businessKey,
  sourceTradeId: INCIDENT.sourceTradeId,
  tradeId: INCIDENT.tradeId,
  holdingId: INCIDENT.holdingId
};
payload.flowsAuto = payload.flowsAuto.filter(flow => !legacy.includes(flow));
payload.flowsAuto.splice(firstIndex, 0, canonicalRecord);
payload.updatedAt = new Date().toISOString();

const writeAtomic = (target, contents) => {
  const absolute = path.resolve(target);
  const dir = path.dirname(absolute);
  const temporary = path.join(dir, `.${path.basename(absolute)}.${process.pid}.tmp`);
  let mode = 0o600;
  try { mode = fs.statSync(absolute).mode & 0o777; } catch { /* new file */ }
  const fd = fs.openSync(temporary, "wx", mode);
  try { fs.writeFileSync(fd, contents); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, absolute); }
  catch (error) { try { fs.unlinkSync(temporary); } catch { /* ignore */ } throw error; }
  try {
    const dirFd = fs.openSync(dir, "r");
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch { /* ignore */ }
};

writeAtomic(file, JSON.stringify({ enc: true, v: 3, data: encrypt(JSON.stringify(payload)) }));
console.log("ok repaired=3 canonical=1");
