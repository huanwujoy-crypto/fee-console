// Synthetic data only. No real snapshot, locator, credential, or financial data.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { convertEncryptedV3Copy, V3CopyError, V3_COPY_SCHEMA } from "./fee-econ-v3-copy.mjs";
import { normalizeEconomicInputs, buildFeeCalculationReceipt } from "./fee-receipt-core.mjs";

const script = fileURLToPath(new URL("./fee-econ-v3-copy.mjs", import.meta.url));
const root = path.resolve(path.dirname(script), "..");
const fixture = () => ({
  v: 3, updatedAt: "2026-08-17T01:41:16.000Z",
  settings: { start: "2026-08-01", mgmt: "2.0000", carry: 20, who: "SYNTHETIC OWNER 独立测试",
    openingAt: "2026-07-31", fx: { USD: 1, HKD: 0.125, CNY: 0.14, EUR: 1.09, SGD: 0.745, GBP: 1.27, JPY: 0.0065 } },
  accounts: [{ id: "webull", name: "SYNTHETIC WEBULL", opening: "40000.00" },
    { id: "schwab", name: "SYNTHETIC SCHWAB", opening: 60000 }],
  months: [{ ym: "2026-08", locked: false, lockedAt: null, snap: null, manualClose: {}, flows: [
    { id: "synthetic-flow-2", date: "2026-08-10", acct: "webull", amount: "-50.125", note: "SYNTHETIC FLOW NOTE" },
    { id: "synthetic-flow-1", src: "synthetic-source-1", date: "2026-08-03", acct: "schwab", amount: 120, note: "" }
  ] }],
  fees: [{ id: "synthetic-payment-2", type: "pay", date: "2026-08-11", amount: "80.00", ccy: "HKD", fx: "", note: "SYNTHETIC PAYMENT", cat: "legacy label" },
    { id: "synthetic-payment-1", type: "pay", date: "2026-08-12", amount: 12.25, ccy: "USD", fx: "1.00", note: "" }]
});
const bytes = raw => Buffer.from(JSON.stringify(raw, null, 2) + "\n", "utf8");
const seal = (plain, key, version = 3) => {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  return bytes({ enc: true, v: version, data: Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]).toString("base64") });
};
const open = (sealed, key) => {
  const outer = JSON.parse(sealed), encrypted = Buffer.from(outer.data, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, encrypted.subarray(0, 12));
  decipher.setAuthTag(encrypted.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(12, -16)), decipher.final()]));
};
const conversion = raw => {
  const key = crypto.randomBytes(32), payload = bytes(raw), source = seal(payload, key);
  return { key, payload, source, copy: convertEncryptedV3Copy(source, key) };
};
const rejects = (raw, code) => {
  const key = crypto.randomBytes(32), source = seal(bytes(raw), key);
  assert.throws(() => convertEncryptedV3Copy(source, key), error => error instanceof V3CopyError && error.code === code);
};

test("safe v3 copies preserve original encrypted bytes, UTF-8 bytes and every legacy field", () => {
  const raw = fixture(), { key, payload, source, copy } = conversion(raw), v4 = open(copy, key);
  assert.equal(JSON.parse(copy).v, 4); assert.equal(v4.v, 4);
  assert.equal(v4.updatedAt, raw.updatedAt);
  assert.deepEqual(v4.settings, raw.settings); assert.deepEqual(v4.accounts, raw.accounts);
  assert.deepEqual(v4.months[0].flows, raw.months[0].flows);
  assert.equal(v4.fees[0].id, raw.fees[0].id);
  assert.equal(v4.fees[0].amount, "80.00"); assert.equal(v4.fees[0].fx, "");
  assert.equal(v4.legacyV3Copy.schema, V3_COPY_SCHEMA);
  assert.deepEqual(Buffer.from(v4.legacyV3Copy.sourceEnvelopeBase64, "base64"), source);
  assert.deepEqual(Buffer.from(v4.legacyV3Copy.sourcePayloadBase64, "base64"), payload);
  assert.deepEqual(JSON.parse(Buffer.from(v4.legacyV3Copy.sourcePayloadBase64, "base64")), raw);
  assert.deepEqual(normalizeEconomicInputs(v4), normalizeEconomicInputs(raw));
  assert.equal(own(v4.months[0].flows[0], "src"), false, "missing optional src is not invented");
  assert.equal(own(v4.fees[0], "type"), false); assert.equal(own(v4.fees[0], "cat"), false);
  assert.equal(own(raw.fees[0], "type"), true, "input object is not mutated");
});
const own = (object, key) => Object.hasOwn(object, key);

test("repeated conversion has stable private economic content and IDs, but fresh encryption nonces", () => {
  const { key, source, copy } = conversion(fixture());
  const again = convertEncryptedV3Copy(source, key);
  assert.notDeepEqual(copy, again); assert.deepEqual(open(copy, key), open(again, key));
});

test("explicitly empty flows and payments remain empty, never reconstructed from AUM", () => {
  const raw = fixture(); raw.months = []; raw.fees = [];
  const { copy, key } = conversion(raw), v4 = open(copy, key);
  assert.deepEqual(v4.months, []); assert.deepEqual(v4.fees, []);
});

test("blank payment FX uses the same original map as v3, while explicit FX remains authoritative", () => {
  const raw = fixture();
  raw.fees.push({ id: "synthetic-payment-3", type: "pay", date: "2026-08-13", amount: "40", ccy: "HKD", fx: "0.15", note: "" });
  const { key, copy } = conversion(raw), v4 = open(copy, key);
  // Historical v3 balance(): explicit nonblank fx, else settings.fx[ccy] || 1.
  const oldPaid = raw.fees.reduce((sum, f) => sum + Number(f.amount)
    * ((f.fx !== null && f.fx !== "" && Number.isFinite(parseFloat(f.fx))) ? parseFloat(f.fx) : raw.settings.fx[f.ccy] || 1), 0);
  const newPaid = normalizeEconomicInputs(v4).fees.reduce((sum, f) => sum + f.amount * f.fx, 0);
  assert.equal(oldPaid, 28.25); assert.equal(newPaid, oldPaid);
  assert.equal(v4.fees[0].fx, ""); assert.equal(v4.fees[2].fx, "0.15");
});

test("required fields cannot be defaulted from the v4 seed", async t => {
  const cases = [
    [r => delete r.fees, "LEDGER_FIELDS_UNSUPPORTED"],
    [r => delete r.months, "LEDGER_FIELDS_UNSUPPORTED"],
    [r => delete r.updatedAt, "LEDGER_FIELDS_UNSUPPORTED"],
    [r => delete r.settings.fx, "SETTINGS_FIELDS_UNSUPPORTED"],
    [r => delete r.settings.fx.HKD, "FX_MAP_INCOMPLETE"],
    [r => delete r.accounts[0].opening, "ACCOUNT_FIELDS_UNSUPPORTED"],
    [r => delete r.months[0].flows, "MONTH_FIELDS_UNSUPPORTED"],
    [r => delete r.months[0].manualClose, "MONTH_FIELDS_UNSUPPORTED"],
    [r => delete r.months[0].flows[0].id, "FLOW_FIELDS_UNSUPPORTED"],
    [r => delete r.fees[0].fx, "FEE_FIELDS_UNSUPPORTED"]
  ];
  for (const [mutate, code] of cases) await t.test(code, () => { const raw = fixture(); mutate(raw); rejects(raw, code); });
});

test("legacy semantics are never silently discarded, including zero or empty-looking rows", async t => {
  const cases = [
    [r => { r.months[0].locked = true; }, "LEGACY_LOCK_REQUIRES_REVIEW"],
    [r => { r.months[0].lockedAt = "2026-08-17 01:41"; }, "LEGACY_LOCK_REQUIRES_REVIEW"],
    [r => { r.months[0].snap = {}; }, "LEGACY_LOCK_REQUIRES_REVIEW"],
    [r => { r.months[0].manualClose = { schwab: "" }; }, "LEGACY_MANUAL_CLOSE_REQUIRES_REVIEW"],
    [r => { r.months[0].manualClose = { schwab: 0 }; }, "LEGACY_MANUAL_CLOSE_REQUIRES_REVIEW"],
    [r => { r.fees[0].type = "exp"; }, "LEGACY_EXPENSE_OR_TYPE_REQUIRES_REVIEW"],
    [r => { r.fees[0].type = "exp"; r.fees[0].amount = 0; }, "LEGACY_EXPENSE_OR_TYPE_REQUIRES_REVIEW"],
    [r => { r.settings.openingAt = "2026-08-01"; }, "OPENING_DATE_REQUIRES_REVIEW"],
    [r => { r.months.unshift({ ym: "2026-09", locked: false, lockedAt: null, snap: null, manualClose: {}, flows: [] }); }, "MONTH_ORDER_REQUIRES_REVIEW"],
    [r => { r.fees[0].date = "2026-07-31"; }, "PAYMENT_DATE_REQUIRES_REVIEW"]
  ];
  for (const [mutate, code] of cases) await t.test(code, () => { const raw = fixture(); mutate(raw); rejects(raw, code); });
});

test("invalid identities, dates, values and unknown fields fail with no private text", async t => {
  const cases = [
    [r => { r.accounts[1].id = "webull"; }, "ACCOUNT_SET_INVALID"],
    [r => { r.accounts.forEach(a => { a.opening = 0; }); }, "BLANK_LEDGER_REJECTED"],
    [r => { r.accounts[0].opening = ""; }, "OPENING_AMOUNT_INVALID"],
    [r => { r.months.push(structuredClone(r.months[0])); }, "DUPLICATE_MONTH"],
    [r => { r.months[0].flows[1].id = r.months[0].flows[0].id; }, "DUPLICATE_FLOW_ID"],
    [r => { r.months[0].flows[0].src = r.months[0].flows[1].src; }, "DUPLICATE_FLOW_SOURCE"],
    [r => { r.months[0].flows[0].id = " "; }, "FLOW_ID_INVALID"],
    [r => { r.months[0].flows[0].amount = "12junk"; }, "FLOW_AMOUNT_INVALID"],
    [r => { r.months[0].flows[0].date = "2026-09-01"; }, "FLOW_DATE_REQUIRES_REVIEW"],
    [r => { r.months[0].flows[0].date = "2026-02-30"; }, "FLOW_DATE_INVALID"],
    [r => { r.fees[1].id = r.fees[0].id; }, "DUPLICATE_PAYMENT_ID"],
    [r => { r.fees[0].fx = 0; }, "PAYMENT_FX_INVALID"],
    [r => { r.fees[0].ccy = "ZZZ"; }, "PAYMENT_CURRENCY_INVALID"],
    [r => { r.fees[0].amount = null; }, "PAYMENT_AMOUNT_INVALID"],
    [r => { r.settings.mgmt = 101; }, "CURRENT_ECONOMIC_SCHEMA_REJECTED"],
    [r => { r.settings.carry = "1.00001"; }, "CURRENT_ECONOMIC_SCHEMA_REJECTED"],
    [r => { r.SYNTHETIC_PRIVATE_UNKNOWN = "SYNTHETIC SECRET VALUE"; }, "LEDGER_FIELDS_UNSUPPORTED"]
  ];
  for (const [mutate, code] of cases) await t.test(code, () => { const raw = fixture(); mutate(raw); rejects(raw, code); });
});

test("authenticated input must be unambiguous v3 economic JSON, not daily or malformed data", () => {
  const key = crypto.randomBytes(32);
  const duplicate = Buffer.from(JSON.stringify(fixture()).replace('"v":3', '"v":3,"\\u0076":3'));
  assert.throws(() => convertEncryptedV3Copy(seal(duplicate, key), key), /INPUT_DUPLICATE_JSON_KEY/);
  assert.throws(() => convertEncryptedV3Copy(seal(Buffer.from('{"SYNTHETIC_SECRET"'), key), key), /INPUT_JSON_INVALID/);
  assert.throws(() => convertEncryptedV3Copy(seal(Buffer.from([0xff]), key), key), /INPUT_JSON_INVALID/);
  assert.throws(() => convertEncryptedV3Copy(seal(bytes({ daily: [] }), key), key), /LEDGER_FIELDS_UNSUPPORTED/);
  assert.throws(() => convertEncryptedV3Copy(seal(bytes(fixture()), key, 4), key), /ENVELOPE_VERSION_UNSUPPORTED/);
  const source = seal(bytes(fixture()), key);
  assert.throws(() => convertEncryptedV3Copy(source, crypto.randomBytes(32)), /SOURCE_AUTHENTICATION_FAILED/);
  assert.throws(() => convertEncryptedV3Copy(source, Buffer.alloc(16)), /KEY_INVALID/);
  const tampered = JSON.parse(source); const cipher = Buffer.from(tampered.data, "base64"); cipher[15] ^= 1;
  tampered.data = cipher.toString("base64");
  assert.throws(() => convertEncryptedV3Copy(bytes(tampered), key), /SOURCE_AUTHENTICATION_FAILED/);
});

test("copies exceeding the current private snapshot consumer limit are refused", () => {
  const raw = fixture(); raw.settings.who = "x".repeat(1_500_000);
  const key = crypto.randomBytes(32), source = seal(bytes(raw), key);
  assert.throws(() => convertEncryptedV3Copy(source, key), /COPY_EXCEEDS_CONSUMER_LIMIT/);
});

test("private provenance does not become part of a calculation receipt", () => {
  const raw = fixture(); raw.months = []; raw.fees = [];
  const { copy, key } = conversion(raw), v4 = open(copy, key);
  const data = { updatedAt: "2026-08-02T00:00:00Z", daily: [
    { d: "2026-08-01", schwab: 60000, webull: 40000 },
    { d: "2026-08-02", schwab: 60100, webull: 40000 }
  ], flowsAuto: [], flowsUnresolved: [], status: { asOf: "2026-08-02", provisional: false, calibrated: false, unresolvedCount: 0 } };
  const receipt = buildFeeCalculationReceipt({ data, economicInput: v4 });
  const json = JSON.stringify(receipt);
  assert.doesNotMatch(json, /legacyV3Copy|sourceEnvelopeBase64|sourcePayloadBase64|SYNTHETIC OWNER|SYNTHETIC WEBULL/);
});

const cliFixture = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-econ-v3-copy-synthetic-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = crypto.randomBytes(32), source = seal(bytes(fixture()), key);
  const input = path.join(dir, "source.encrypted.json"), output = path.join(dir, "copy.encrypted.json");
  fs.writeFileSync(input, source, { mode: 0o600 });
  const env = { ...process.env, GITHUB_ACTIONS: "", FEE_DATA_KEY: key.toString("base64url"), FEE_ECON_V3_FILE: input, FEE_ECON_COPY_FILE: output };
  const run = (over = {}, args = []) => spawnSync(process.execPath, [script, ...args], { env: { ...env, ...over }, encoding: "utf8" });
  return { dir, key, source, input, output, run };
};

test("CLI writes encrypted 0600 copy only, preserves source, and does not log private material", t => {
  const f = cliFixture(t), result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ENCRYPTED_COPY_CREATED; SOURCE_UNCHANGED; AUTHORITY_NOT_ATTESTED/);
  assert.equal(result.stderr, ""); assert.deepEqual(fs.readFileSync(f.input), f.source);
  assert.equal(fs.statSync(f.output).mode & 0o777, 0o600);
  assert.equal(open(fs.readFileSync(f.output), f.key).v, 4);
  assert.doesNotMatch(result.stdout, /SYNTHETIC|100000|40000|60000|source\.encrypted|copy\.encrypted/);
  assert.ok(!result.stdout.includes(f.key.toString("base64url")));
  assert.ok(!result.stdout.includes(f.source.toString()));
});

test("CLI accepts existing standard base64 key without replacing it", t => {
  const f = cliFixture(t), result = f.run({ FEE_DATA_KEY: f.key.toString("base64") });
  assert.equal(result.status, 0, result.stderr); assert.equal(open(fs.readFileSync(f.output), f.key).v, 4);
});

test("CLI refuses Actions before inspecting secrets/paths, and refuses credential arguments", t => {
  const f = cliFixture(t);
  const actions = f.run({ GITHUB_ACTIONS: "true", FEE_DATA_KEY: "SYNTHETIC_BAD_KEY", FEE_ECON_V3_FILE: "missing" });
  assert.equal(actions.status, 1); assert.match(actions.stderr, /ACTIONS_REFUSED/);
  const argument = f.run({}, ["--key=SYNTHETIC_ARGUMENT_SECRET"]);
  assert.equal(argument.status, 1); assert.match(argument.stderr, /ARGUMENTS_REFUSED_USE_ENV/);
  assert.doesNotMatch(argument.stderr, /SYNTHETIC_ARGUMENT_SECRET/); assert.ok(!fs.existsSync(f.output));
});

test("CLI refuses source overwrite, existing destination, and repository/symlink destinations", t => {
  const f = cliFixture(t);
  assert.match(f.run({ FEE_ECON_COPY_FILE: f.input }).stderr, /SOURCE_OVERWRITE_REFUSED/);
  fs.writeFileSync(f.output, "synthetic existing encrypted destination", { mode: 0o600 });
  const before = fs.readFileSync(f.output);
  assert.equal(f.run().status, 1); assert.deepEqual(fs.readFileSync(f.output), before);
  assert.match(f.run({ FEE_ECON_COPY_FILE: path.join(root, "must-not-exist.private-copy.json") }).stderr, /PRIVATE_PATH_INSIDE_REPOSITORY/);
  const link = path.join(f.dir, "repository-link"); fs.symlinkSync(root, link, "dir");
  assert.match(f.run({ FEE_ECON_COPY_FILE: path.join(link, "must-not-exist.private-copy.json") }).stderr, /PRIVATE_PATH_INSIDE_REPOSITORY/);
  assert.match(f.run({ FEE_ECON_V3_FILE: script }).stderr, /PRIVATE_PATH_INSIDE_REPOSITORY/);
  const fileLink = path.join(f.dir, "source-symlink.encrypted.json"); fs.symlinkSync(f.input, fileLink);
  assert.equal(f.run({ FEE_ECON_COPY_FILE: fileLink }).status, 1);
  assert.deepEqual(fs.readFileSync(f.input), f.source);
  assert.ok(!fs.existsSync(path.join(root, "must-not-exist.private-copy.json")));
});
