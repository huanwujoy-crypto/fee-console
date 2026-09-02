import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { effectiveFlows, periodReturns } from "./fee-engine.mjs";
import {
  buildFeeCalculationReceipt,
  canonicalJson,
  normalizeEconomicInputs,
  semanticHash,
  validateFeeCalculationReceipt,
  validateFeeCalculationReceiptWithEcon
} from "./fee-receipt-core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const reportCli = path.join(root, "scripts", "fee-receipt-report.mjs");
const receiptUiMigrationActive = html.includes("/* fee-receipt-consumer:start */");

const dates = (from, to) => {
  const out = [];
  for (let date = from; date <= to; date = new Date(Date.parse(date + "T00:00:00Z") + 86400000).toISOString().slice(0, 10)) {
    out.push(date);
  }
  return out;
};

const near = (actual, expected, tolerance, label) => assert.ok(
  Math.abs(actual - expected) <= tolerance,
  `${label}: got ${actual}, expected ${expected} ±${tolerance}`
);

const FOP = 24000;
const opening = 100000;
const fopFlow = (over = {}) => {
  const businessKey = over.businessKey || "synthetic:fop-1";
  const id = over.id || crypto.createHash("sha256")
    .update(`external_asset_transfer ${businessKey}`)
    .digest("hex")
    .slice(0, 16);
  return {
    id,
    date: "2026-08-20",
    acct: "webull",
    amount: FOP,
    desc: "BRK/B 780 verified in-kind transfer",
    reason: `verified external asset transfer ${businessKey}`,
    effective: true,
    businessKey,
    ...over
  };
};

const fixture = ({ flowsAuto = [fopFlow()], econOver = {}, dataOver = {} } = {}) => {
  const daily = dates("2026-08-01", "2026-08-24").map(date => {
    let total = opening;
    if (date >= "2026-08-20") total += FOP;
    if (date === "2026-08-24") total += 4750;
    return { d: date, schwab: total * 0.6, webull: total * 0.4 };
  });
  const economicInput = {
    v: 4,
    settings: { start: "2026-08-01", mgmt: 2, carry: 20, who: "PRIVATE PERSON" },
    accounts: [
      { id: "schwab", name: "PRIVATE SCHWAB", opening: 60000 },
      { id: "webull", name: "PRIVATE WEBULL", opening: 40000 }
    ],
    months: [],
    fees: [{ id: "private-payment", date: "2026-08-24", amount: 999, ccy: "USD", note: "PRIVATE PAYMENT" }],
    ...econOver
  };
  const data = {
    updatedAt: "2026-08-24T12:00:00Z",
    daily,
    flowsAuto,
    flowsUnresolved: [],
    status: { asOf: "2026-08-24", provisional: false, calibrated: false, unresolvedCount: 0 },
    ...dataOver
  };
  return { data, economicInput };
};

const encryptedEnvelopeFile = ({ payload, version, key, dir, name }) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const target = path.join(dir, name);
  fs.writeFileSync(target, JSON.stringify({
    enc: true,
    v: version,
    data: Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString("base64")
  }));
  return target;
};

const encryptedFiles = (payload, economicInput) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-receipt-report-test-"));
  const key = crypto.randomBytes(32);
  const target = encryptedEnvelopeFile({ payload, version: 3, key, dir, name: "data.json" });
  const econTarget = encryptedEnvelopeFile({ payload: economicInput, version: 4, key, dir, name: "fee-console-db.json" });
  return { target, econTarget, key: key.toString("base64url") };
};

const extractedPagePeriodReturns = (() => {
  if (receiptUiMigrationActive) return null;
  const start = html.indexOf("/* returns:start");
  const end = html.indexOf("/* returns:end */");
  assert.ok(start >= 0 && end > start);
  return new Function(`${html.slice(start, end)}\nreturn periodReturns;`)();
})();

const extractedPageEffectiveFlows = receiptUiMigrationActive ? null : (months, flowsAuto) => {
  const start = html.indexOf("/* flow-dedupe:start");
  const end = html.indexOf("/* flow-dedupe:end */");
  assert.ok(start >= 0 && end > start);
  const factory = new Function("DB", "DAILY", "num", `${html.slice(start, end)}\nreturn effectiveFlows;`);
  return factory({ months }, { flowsAuto }, value => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  })();
};

test("the pure engine stays in parity with the current page for valid fee inputs", t => {
  if (!extractedPagePeriodReturns) {
    t.skip("the migrated phone consumes receipts and no longer contains the legacy formula");
    return;
  }
  const { data } = fixture();
  const points = data.daily.map(point => ({ d: point.d, tot: point.schwab + point.webull }));
  const input = {
    points,
    openT: opening,
    from: "2026-08-01",
    to: "2026-08-24",
    days: 24,
    flowByDate: { "2026-08-20": FOP },
    rate: 0.02,
    cr: 0.20,
    cumBefore: 0,
    hwmBefore: 0,
    bench: [],
    bPrev: {},
    bVal: {},
    bHas: {}
  };
  const page = extractedPagePeriodReturns(structuredClone(input));
  const core = periodReturns(structuredClone(input));
  for (const key of ["closeT", "flowT", "den", "pnl", "mgmt", "carry", "fees", "rG", "rD"]) {
    near(core[key], page[key], 1e-9, key);
  }
});

test("the pure flow engine stays in parity with page de-duplication", t => {
  if (!extractedPageEffectiveFlows) {
    t.skip("the migrated phone consumes receipts and no longer owns flow de-duplication");
    return;
  }
  const auto = fopFlow();
  const duplicate = { ...auto, id: "rehash", desc: "same FOP rewritten", reason: auto.reason };
  const manual = { id: "manual", src: "", date: auto.date, acct: auto.acct, amount: auto.amount, note: "BRK/B 780" };
  const months = [{ ym: "2026-08", flows: [manual] }];
  assert.deepEqual(
    effectiveFlows({ months, flowsAuto: [auto, duplicate] }),
    extractedPageEffectiveFlows(months, [auto, duplicate])
  );
});

test("the trusted receipt uses daily EOD pre-flow NAV, not an endpoint average", () => {
  const { data, economicInput } = fixture();
  const receipt = buildFeeCalculationReceipt({ data, economicInput });
  const august = receipt.periods[0];
  const dailyBasis = opening * 20 + (opening + FOP) * 3 + (opening + FOP + 4750);
  const endpointFee = ((opening + opening + FOP + 4750) / 2) * 0.02 * 24 / 365;
  assert.equal(august.feeBaseSumCents, Math.round(dailyBasis * 100));
  assert.equal(august.averageFeeBaseCents, Math.round((dailyBasis / 24) * 100));
  assert.equal(august.managementFeeCents, Math.round((dailyBasis * 0.02 / 365) * 100));
  assert.notEqual(august.managementFeeCents, Math.round(endpointFee * 100));
  assert.equal(august.feeBasisDayCount, 24);
  assert.equal(august.calendarDayCount, 24);
});

test("one FOP produces the intended P&L and Carry; omission changes it and duplicate identity is refused", () => {
  const once = buildFeeCalculationReceipt(fixture());
  const omitted = buildFeeCalculationReceipt(fixture({ flowsAuto: [] }));
  assert.equal(once.effectiveFlowCount, 1);
  assert.equal(once.effectiveFlowNetCents, FOP * 100);
  assert.equal(once.periods[0].grossPnlCents, 4750 * 100);
  assert.equal(once.periods[0].carryCents, 950 * 100);
  assert.equal(omitted.periods[0].grossPnlCents, (4750 + FOP) * 100);
  assert.equal(omitted.periods[0].carryCents - once.periods[0].carryCents, FOP * 0.20 * 100);
  assert.throws(() => buildFeeCalculationReceipt(fixture({ flowsAuto: [
    fopFlow(),
    fopFlow()
  ] })), /automatic flow id is duplicated/);
});

test("receipt generation is deterministic across ordering and ignores private names and notes", () => {
  const { data, economicInput } = fixture();
  const first = buildFeeCalculationReceipt({ data, economicInput });
  const reordered = {
    fees: [{ id: "private-payment", date: "2026-08-24", note: "CHANGED PAYMENT", amount: 999, ccy: "USD" }],
    months: [...economicInput.months].reverse(),
    accounts: [...economicInput.accounts].reverse().map(account => ({
      opening: account.opening,
      name: "CHANGED PRIVATE NAME",
      id: account.id
    })),
    settings: { who: "ANOTHER PERSON", carry: 20, mgmt: 2, start: "2026-08-01" },
    v: 4
  };
  const second = buildFeeCalculationReceipt({ data: { ...data, daily: [...data.daily].reverse() }, economicInput: reordered });
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(first.receiptId, second.receiptId);
});

test("every economic input change changes the receipt commitment", () => {
  const { data, economicInput } = fixture();
  const first = buildFeeCalculationReceipt({ data, economicInput });
  const changed = structuredClone(economicInput);
  changed.settings.mgmt = 2.01;
  const second = buildFeeCalculationReceipt({ data, economicInput: changed });
  assert.notEqual(first.econInputsHash, second.econInputsHash);
  assert.notEqual(first.receiptId, second.receiptId);
});

test("payment amount and FX change paid and due, while payment note does not", () => {
  const { data, economicInput } = fixture();
  const first = buildFeeCalculationReceipt({ data, economicInput });
  assert.equal(first.balance.paidCents, 99900);
  assert.equal(first.balance.dueCents, first.balance.accruedCents - 99900);

  const changed = structuredClone(economicInput);
  changed.fees[0] = { ...changed.fees[0], amount: 1000, ccy: "HKD", fx: 0.1282 };
  const second = buildFeeCalculationReceipt({ data, economicInput: changed });
  assert.equal(second.balance.paidCents, 12820);
  assert.notEqual(first.paymentInputsHash, second.paymentInputsHash);
  assert.notEqual(first.receiptId, second.receiptId);

  const noteOnly = structuredClone(economicInput);
  noteOnly.fees[0].note = "ANOTHER PRIVATE NOTE";
  const third = buildFeeCalculationReceipt({ data, economicInput: noteOnly });
  assert.equal(third.balance.paidCents, first.balance.paidCents);
  assert.equal(third.receiptId, first.receiptId);

  const withPreStartPayment = structuredClone(economicInput);
  withPreStartPayment.fees.push({
    id: "before-fee-start", date: "2026-07-31", amount: 500, ccy: "USD"
  });
  const fourth = buildFeeCalculationReceipt({ data, economicInput: withPreStartPayment });
  assert.equal(fourth.balance.paidCents, first.balance.paidCents);
  assert.equal(fourth.balance.dueCents, first.balance.dueCents);
  assert.equal(fourth.paymentInputsHash, first.paymentInputsHash);
});

test("the receipt contains derived results and commitments, never raw private records", () => {
  const { data, economicInput } = fixture({
    econOver: {
      months: [{ ym: "2026-08", flows: [{
        id: "PRIVATE-ID", src: "PRIVATE-SOURCE", date: "2026-08-25",
        acct: "schwab", amount: 100, note: "PRIVATE-NOTE-MARKER"
      }]}]
    }
  });
  const receipt = buildFeeCalculationReceipt({ data, economicInput });
  const text = JSON.stringify(receipt);
  for (const marker of ["PRIVATE-ID", "PRIVATE-SOURCE", "PRIVATE-NOTE-MARKER", "PRIVATE PERSON", "PRIVATE PAYMENT"]) {
    assert.equal(text.includes(marker), false, marker);
  }
  assert.match(receipt.econInputsHash, /^[a-f0-9]{64}$/);
  assert.match(receipt.dataInputsHash, /^[a-f0-9]{64}$/);
});

test("public and private receipt validation both fail closed on changed inputs", () => {
  const { data, economicInput } = fixture();
  const receipt = buildFeeCalculationReceipt({ data, economicInput });
  assert.deepEqual(validateFeeCalculationReceipt(receipt, data), { ok: true, errors: [] });
  assert.deepEqual(validateFeeCalculationReceiptWithEcon(receipt, data, economicInput), { ok: true, errors: [] });

  const changedData = structuredClone(data);
  changedData.daily.at(-1).webull += 1;
  assert.equal(validateFeeCalculationReceipt(receipt, changedData).ok, false);

  const changedEcon = structuredClone(economicInput);
  changedEcon.settings.carry = 19;
  assert.equal(validateFeeCalculationReceiptWithEcon(receipt, data, changedEcon).ok, false);
});

test("tampering, incomplete days and a negative pre-flow fee base are rejected", () => {
  const { data, economicInput } = fixture();
  const receipt = buildFeeCalculationReceipt({ data, economicInput });
  const tampered = structuredClone(receipt);
  tampered.totals.managementFeeCents += 1;
  assert.equal(validateFeeCalculationReceipt(tampered, data).ok, false);

  const missing = structuredClone(data);
  missing.daily.splice(10, 1);
  assert.throws(() => buildFeeCalculationReceipt({ data: missing, economicInput }), /缺少每日估值|计费点数/);

  const negative = structuredClone(data);
  negative.daily.find(point => point.d === "2026-08-20").schwab = 0;
  negative.daily.find(point => point.d === "2026-08-20").webull = 1;
  assert.throws(() => buildFeeCalculationReceipt({ data: negative, economicInput }), /管理费基数无效/);
});

test("canonical hashes are domain-separated and stable across object-key order", () => {
  assert.equal(semanticHash("x", { a: 1, b: 2 }), semanticHash("x", { b: 2, a: 1 }));
  assert.notEqual(semanticHash("x", { a: 1 }), semanticHash("y", { a: 1 }));
  assert.deepEqual(normalizeEconomicInputs({
    settings: { carry: 20, start: "2026-08-01", mgmt: 2 },
    accounts: [{ opening: 1, id: "webull" }, { id: "schwab", opening: 2 }],
    months: []
  }).accounts.map(account => account.id), ["schwab", "webull"]);
});

test("the read-only report consumer emits only a public-and-private validated receipt", () => {
  const { data, economicInput } = fixture();
  const payload = { ...data, feeCalculationReceipt: buildFeeCalculationReceipt({ data, economicInput }) };
  const encrypted = encryptedFiles(payload, economicInput);
  const valid = spawnSync(process.execPath, [reportCli, `--file=${encrypted.target}`], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_ACTIONS: "",
      FEE_DATA_KEY: encrypted.key,
      FEE_ECON_FILE: encrypted.econTarget
    }
  });
  assert.equal(valid.status, 0, valid.stderr);
  const parsed = JSON.parse(valid.stdout);
  assert.equal(parsed.receiptId, payload.feeCalculationReceipt.receiptId);
  assert.equal(parsed.currentPeriod.carryCents, 95000);
  assert.equal(JSON.stringify(parsed).includes("PRIVATE"), false);

  const stalePayload = structuredClone(payload);
  stalePayload.daily.at(-1).webull += 1;
  const staleEncrypted = encryptedFiles(stalePayload, economicInput);
  const stale = spawnSync(process.execPath, [reportCli, `--file=${staleEncrypted.target}`], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_ACTIONS: "",
      FEE_DATA_KEY: staleEncrypted.key,
      FEE_ECON_FILE: staleEncrypted.econTarget
    }
  });
  assert.notEqual(stale.status, 0);
  assert.equal(stale.stdout, "");
  assert.match(stale.stderr, /no fee figures emitted/);
});

test("linked confirmations must match their source and flow identities must be unique", () => {
  const sourceId = fopFlow().id;
  const linked = fixture({ econOver: {
    months: [{ ym: "2026-08", flows: [{
      id: "confirmed-fop", src: sourceId, date: "2026-08-20",
      acct: "webull", amount: FOP, note: "BRK/B 780"
    }]}]
  } });
  assert.equal(buildFeeCalculationReceipt(linked).effectiveFlowCount, 1);

  const canonicalizedSource = structuredClone(linked);
  canonicalizedSource.data.flowsAuto[0].id = ` ${sourceId} `;
  const canonicalizedReceipt = buildFeeCalculationReceipt(canonicalizedSource);
  assert.equal(canonicalizedReceipt.effectiveFlowCount, 1);
  assert.equal(canonicalizedReceipt.effectiveFlowNetCents, FOP * 100);
  assert.equal(canonicalizedReceipt.periods[0].grossPnlCents, 4750 * 100);

  for (const patch of [
    { date: "2026-08-19" },
    { acct: "schwab" },
    { amount: FOP - 1 },
    { amount: FOP + 0.01 }
  ]) {
    const mismatch = structuredClone(linked);
    Object.assign(mismatch.economicInput.months[0].flows[0], patch);
    assert.throws(() => buildFeeCalculationReceipt(mismatch), /src disagrees/);
  }

  const duplicateSrc = structuredClone(linked);
  duplicateSrc.economicInput.months[0].flows.push({
    ...duplicateSrc.economicInput.months[0].flows[0], id: "another-confirmation"
  });
  assert.throws(() => buildFeeCalculationReceipt(duplicateSrc), /confirmed flow src is duplicated/);

  const duplicateId = structuredClone(linked);
  duplicateId.economicInput.months[0].flows.push({
    ...duplicateId.economicInput.months[0].flows[0], src: ""
  });
  assert.throws(() => buildFeeCalculationReceipt(duplicateId), /confirmed flow id is duplicated/);
});

test("blank numerics, impossible calendar dates, and unresolved flows fail closed", () => {
  const base = fixture();
  const blankRate = structuredClone(base);
  blankRate.economicInput.settings.mgmt = "";
  assert.throws(() => buildFeeCalculationReceipt(blankRate), /finite number/);

  const blankFlow = fixture({ econOver: {
    months: [{ ym: "2026-08", flows: [{
      id: "manual", src: "", date: "2026-08-10", acct: "schwab", amount: "", note: ""
    }]}]
  } });
  assert.throws(() => buildFeeCalculationReceipt(blankFlow), /finite number/);

  const invalidDate = structuredClone(base);
  invalidDate.data.daily.at(-1).d = "2026-02-30";
  assert.throws(() => buildFeeCalculationReceipt(invalidDate), /invalid date|cannot determine/);

  const unresolved = structuredClone(base);
  unresolved.data.flowsUnresolved = [{ id: "needs-review" }];
  unresolved.data.status = { ...unresolved.data.status, provisional: true, unresolvedCount: 1 };
  assert.throws(() => buildFeeCalculationReceipt(unresolved), /unresolved flows/);
});

test("malformed private ledgers and public status types fail closed", () => {
  const base = fixture();

  for (const economicInput of [
    { ...base.economicInput, months: {} },
    { ...base.economicInput, months: [{ ym: "2026-08", flows: {} }] },
    { ...base.economicInput, fees: {} },
    { ...base.economicInput, settings: { ...base.economicInput.settings, fx: [] } }
  ]) {
    assert.throws(
      () => buildFeeCalculationReceipt({ data: base.data, economicInput }),
      /must be an (?:array|object)/
    );
  }

  for (const field of ["daily", "flowsAuto", "flowsUnresolved"]) {
    const data = { ...base.data, [field]: {} };
    assert.throws(
      () => buildFeeCalculationReceipt({ data, economicInput: base.economicInput }),
      new RegExp(`${field} must be an array`)
    );
  }

  for (const invalidMember of [null, false, 0, "", []]) {
    const data = {
      ...base.data,
      flowsUnresolved: [invalidMember],
      status: { ...base.data.status, unresolvedCount: 0 }
    };
    assert.throws(
      () => buildFeeCalculationReceipt({ data, economicInput: base.economicInput }),
      /unresolved flow #1 must be an object/
    );
    const receipt = buildFeeCalculationReceipt(base);
    assert.equal(validateFeeCalculationReceipt(receipt, data).ok, false);
    assert.equal(validateFeeCalculationReceiptWithEcon(receipt, data, base.economicInput).ok, false);
  }

  for (const status of [
    { ...base.data.status, provisional: "true" },
    { ...base.data.status, calibrated: 0 },
    { ...base.data.status, unresolvedCount: "0" }
  ]) {
    assert.throws(
      () => buildFeeCalculationReceipt({
        data: { ...base.data, status }, economicInput: base.economicInput
      }),
      /status\.(?:provisional|calibrated|unresolvedCount)/
    );
  }
});

test("a receipt is stale as soon as a newer daily valuation exists", () => {
  const { data, economicInput } = fixture();
  const receipt = buildFeeCalculationReceipt({ data, economicInput });
  const newer = structuredClone(data);
  newer.daily.push({ d: "2026-08-25", schwab: 78000, webull: 52000 });
  newer.status = { ...newer.status, asOf: "2026-08-25" };
  assert.equal(validateFeeCalculationReceipt(receipt, newer).ok, false);
  assert.throws(
    () => buildFeeCalculationReceipt({ data: newer, economicInput, asOf: "2026-08-24" }),
    /latest daily valuation/
  );
});

test("strict validation rejects unknown fields and broken cent identities even if re-signed", () => {
  const { data, economicInput } = fixture();
  const original = buildFeeCalculationReceipt({ data, economicInput });
  const resign = candidate => {
    const copy = structuredClone(candidate);
    delete copy.receiptId;
    return { ...copy, receiptId: semanticHash("calculation-receipt", copy) };
  };

  const extra = structuredClone(original);
  extra.periods[0].privateNote = "must never pass through";
  assert.equal(validateFeeCalculationReceipt(resign(extra), data).ok, false);

  const missing = structuredClone(original);
  delete missing.balance.paidCents;
  assert.equal(validateFeeCalculationReceipt(resign(missing), data).ok, false);

  const broken = structuredClone(original);
  broken.periods[0].totalFeeCents += 1;
  broken.totals.totalFeeCents += 1;
  broken.totals.netPnlCents -= 1;
  broken.balance.accruedCents += 1;
  broken.balance.dueCents += 1;
  assert.equal(validateFeeCalculationReceipt(resign(broken), data).ok, false);

  const malformedPeriod = structuredClone(original);
  malformedPeriod.periods[0] = null;
  assert.doesNotThrow(() => validateFeeCalculationReceipt(malformedPeriod, data));
  assert.equal(validateFeeCalculationReceipt(malformedPeriod, data).ok, false);

  assert.doesNotThrow(() => validateFeeCalculationReceipt(resign({ ...original, start: "2026-02-30" }), data));
});

test("cent totals and multi-month High-water mark chains are internally complete", () => {
  const daily = dates("2026-08-01", "2026-09-02").map((date, index) => {
    let total = 100000 + index * 100;
    if (date >= "2026-08-20") total += 24000;
    if (date >= "2026-09-01") total += 1000;
    const schwab = Math.round(total * 60) / 100;
    return { d: date, schwab, webull: total - schwab };
  });
  const economicInput = {
    v: 4,
    settings: { start: "2026-08-01", mgmt: 2, carry: 20, fx: { USD: 1 } },
    accounts: [{ id: "schwab", opening: 60000 }, { id: "webull", opening: 40000 }],
    months: [],
    fees: [{ id: "paid-1", date: "2026-08-31", amount: 100, ccy: "USD" }]
  };
  const data = {
    daily,
    flowsAuto: [
      fopFlow(),
      fopFlow({ date: "2026-09-01", amount: 1000, businessKey: "synthetic:fop-2" })
    ],
    flowsUnresolved: [],
    status: { asOf: "2026-09-02", provisional: false, calibrated: true, unresolvedCount: 0 }
  };
  const receipt = buildFeeCalculationReceipt({ data, economicInput });
  assert.equal(receipt.periods.length, 2);
  assert.equal(receipt.totals.spanDays, 33);
  assert.equal(receipt.effectiveFlowCount, 2);
  assert.equal(receipt.effectiveFlowNetCents, 2500000);
  assert.equal(receipt.periods[1].openingCents, receipt.periods[0].closingCents);
  for (const period of receipt.periods) {
    assert.equal(period.totalFeeCents, period.managementFeeCents + period.carryCents);
  }
  assert.equal(receipt.totals.totalFeeCents,
    receipt.totals.managementFeeCents + receipt.totals.carryCents);
  assert.equal(receipt.totals.netPnlCents,
    receipt.totals.grossPnlCents - receipt.totals.totalFeeCents);
  assert.equal(receipt.balance.dueCents,
    receipt.balance.accruedCents - receipt.balance.paidCents);
  assert.deepEqual(validateFeeCalculationReceiptWithEcon(receipt, data, economicInput), { ok: true, errors: [] });
});

test("the report refuses GitHub Actions, missing private proof, and changed private inputs", () => {
  const { data, economicInput } = fixture();
  const payload = { ...data, feeCalculationReceipt: buildFeeCalculationReceipt({ data, economicInput }) };
  const encrypted = encryptedFiles(payload, economicInput);

  const actions = spawnSync(process.execPath, [reportCli, `--file=${encrypted.target}`], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_ACTIONS: "true" }
  });
  assert.notEqual(actions.status, 0);
  assert.equal(actions.stdout, "");
  assert.match(actions.stderr, /refused in GitHub Actions/);

  const noPrivate = spawnSync(process.execPath, [reportCli, `--file=${encrypted.target}`], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_ACTIONS: "", FEE_DATA_KEY: encrypted.key, FEE_ECON_FILE: "" }
  });
  assert.notEqual(noPrivate.status, 0);
  assert.equal(noPrivate.stdout, "");

  const changedEcon = structuredClone(economicInput);
  changedEcon.settings.mgmt = 2.01;
  const key = Buffer.from(encrypted.key, "base64url");
  encryptedEnvelopeFile({
    payload: changedEcon, version: 4, key, dir: path.dirname(encrypted.econTarget), name: path.basename(encrypted.econTarget)
  });
  const changed = spawnSync(process.execPath, [reportCli, `--file=${encrypted.target}`], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_ACTIONS: "", FEE_DATA_KEY: encrypted.key, FEE_ECON_FILE: encrypted.econTarget }
  });
  assert.notEqual(changed.status, 0);
  assert.equal(changed.stdout, "");
  assert.match(changed.stderr, /no fee figures emitted/);

  const malformedPayload = structuredClone(payload);
  malformedPayload.feeCalculationReceipt.periods[0] = null;
  const malformedEncrypted = encryptedFiles(malformedPayload, economicInput);
  const malformed = spawnSync(process.execPath, [reportCli, `--file=${malformedEncrypted.target}`], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_ACTIONS: "",
      FEE_DATA_KEY: malformedEncrypted.key,
      FEE_ECON_FILE: malformedEncrypted.econTarget
    }
  });
  assert.notEqual(malformed.status, 0);
  assert.equal(malformed.stdout, "");
  assert.match(malformed.stderr, /no fee figures emitted/);
  assert.doesNotMatch(malformed.stderr, /TypeError|\n\s+at\s/);
});
