import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { buildFeeCalculationReceipt, semanticHash } from "./fee-receipt-core.mjs";
import { createLegacyPolicy } from "./fee-legacy-policy.mjs";
import { convertEncryptedV3Copy } from "./fee-econ-v3-copy.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// Share the ledger suite's local-only, read-only cross-worktree preview.
const htmlPath = process.env.FEE_LEDGER_TEST_INDEX || path.join(here, "..", "index.html");
if (process.env.GITHUB_ACTIONS === "true" && process.env.FEE_LEDGER_TEST_INDEX)
  throw new Error("external UI preview is local-only");
assert.ok(path.isAbsolute(htmlPath), "the optional synthetic UI preview path must be absolute");
const START = "/* fee-receipt-consumer:start */";
const END = "/* fee-receipt-consumer:end */";
const HISTORY_START = "/* month-history-view:start */";
const HISTORY_END = "/* month-history-view:end */";
const RENDER_START = "/* fee-receipt-render:start */";
const RENDER_END = "/* fee-receipt-render:end */";
const RENDER_CALL = "/* fee-receipt-render-call */";

const fixture = () => {
  const businessKey = "sharesight:source-1->target-1;holding:holding-1";
  const flowId = crypto.createHash("sha256")
    .update(`external_asset_transfer ${businessKey}`)
    .digest("hex")
    .slice(0, 16);
  const data = {
    daily: [
      { d: "2026-08-01", schwab: 60_000, webull: 40_000 },
      { d: "2026-08-02", schwab: 74_000, webull: 50_500 },
      { d: "2026-08-03", schwab: 74_300, webull: 50_700 }
    ],
    flowsAuto: [{
      id: flowId,
      date: "2026-08-02",
      acct: "webull",
      amount: 24_000,
      desc: "external asset transfer",
      reason: `verified external asset transfer ${businessKey}`,
      effective: true,
      businessKey
    }],
    flowsUnresolved: [],
    status: { asOf: "2026-08-03", provisional: false, calibrated: true, unresolvedCount: 0 }
  };
  const economicInput = {
    v: 4,
    settings: { start: "2026-08-01", mgmt: 2, carry: 20, fx: { USD: 1, HKD: 0.1282 } },
    accounts: [
      { id: "schwab", opening: 60_000 },
      { id: "webull", opening: 40_000 }
    ],
    months: [{ ym: "2026-08", flows: [{
      id: "confirmed-fop",
      src: flowId,
      date: "2026-08-02",
      acct: "webull",
      amount: 24_000,
      note: "BRK/B 780"
    }] }],
    fees: [{ id: "paid-1", date: "2026-08-03", amount: 780, ccy: "HKD", note: "August" }]
  };
  const receipt = buildFeeCalculationReceipt({ data, economicInput });
  return { data, economicInput, receipt };
};

const plain = value => JSON.parse(JSON.stringify(value));
const resign = receipt => {
  const body = structuredClone(receipt);
  delete body.receiptId;
  return { ...body, receiptId: semanticHash("calculation-receipt", body) };
};

test("legacy source binding has executable old/new consumer release interlocks", async () => {
  const html = fs.readFileSync(htmlPath, "utf8");
  const marker = "/* fee-legacy-policy:start */", endMarker = "/* fee-legacy-policy:end */";
  const hasLegacy = html.includes(marker);
  const { data, economicInput: native } = fixture();
  const raw = structuredClone(native);
  raw.v = 3;
  raw.updatedAt = "2026-08-03T12:00:00Z";
  raw.settings = { ...raw.settings, who: "SYNTHETIC", openingAt: "2026-07-31",
    fx: { ...raw.settings.fx, CNY: 0.14, EUR: 1.1, SGD: 0.75, GBP: 1.3, JPY: 0.0067 } };
  raw.accounts = raw.accounts.map(account => ({ ...account, name: "SYNTHETIC " + account.id }));
  raw.months = raw.months.map(month => ({ ...month, locked: false, lockedAt: null, snap: null, manualClose: {} }));
  raw.fees = raw.fees.map(fee => ({ ...fee, type: "pay", fx: "" }));
  raw.fees.push({ id: "LEGACY", type: "exp", date: "2026-08-03", amount: "", ccy: "USD", fx: "", note: "", deduct: true });
  const key = crypto.randomBytes(32);
  const payloadBytes = Buffer.from(JSON.stringify(raw));
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const sealed = Buffer.concat([iv, cipher.update(payloadBytes), cipher.final(), cipher.getAuthTag()]);
  const envelopeBytes = Buffer.from(JSON.stringify({ enc: true, v: 3, data: sealed.toString("base64") }));
  const copyEnvelope = JSON.parse(convertEncryptedV3Copy(envelopeBytes, key,
    { policyId: "fee-console.legacy-empty-expense.v1" }));
  const ct = Buffer.from(copyEnvelope.data, "base64"), decipher = crypto.createDecipheriv("aes-256-gcm", key, ct.subarray(0, 12));
  decipher.setAuthTag(ct.subarray(-16));
  const copy = JSON.parse(Buffer.concat([decipher.update(ct.subarray(12, -16)), decipher.final()]));
  const receipt = buildFeeCalculationReceipt({ data, economicInput: copy });
  const { legacyV3Copy, ...economicInput } = copy;
  const legacySource = { envelopeBytes, payloadBytes };
  const sandbox = { crypto: crypto.webcrypto, TextEncoder, TextDecoder, Uint8Array, structuredClone,
    console: { log() {}, warn() {}, error() {} } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  if (hasLegacy) {
    assert.equal(html.split(marker).length, 2);
    assert.equal(html.split(endMarker).length, 2);
    const factory = html.slice(html.indexOf(marker) + marker.length, html.indexOf(endMarker)).trim();
    assert.equal(factory, createLegacyPolicy.toString(), "mobile policy must be byte-identical to reviewed source factory");
    vm.runInContext(factory + "; globalThis.feeLegacyPolicy = createLegacyPolicy();", sandbox);
  }
  vm.runInContext(html.slice(html.indexOf(START) + START.length, html.indexOf(END)), sandbox);
  const closed = async input => assert.deepEqual(plain(await sandbox.feeReceiptUiModel(input)),
    { ok: false, reason: "calculation receipt pending" });
  const input = { receipt, data, economicInput, legacySource };
  if (!hasLegacy) {
    await closed(input);
    assert.equal(receipt.schema, "fee-console.calculation-receipt.v2");
    return; // Support PR first: actual deployed v1 code must reject this v2 receipt.
  }
  assert.equal((await sandbox.feeReceiptUiModel(input)).ok, true);
  await closed({ receipt, data, economicInput });
  await closed({ ...input, legacySource: null });
  for (const amount of [25, "25.00", 0, "0", " ", null]) {
    const changed = structuredClone(raw); changed.fees.at(-1).amount = amount;
    await closed({ ...input, legacySource: { envelopeBytes, payloadBytes: Buffer.from(JSON.stringify(changed)) } });
  }
  for (const mutation of [r => { delete r.fees; }, r => { r.fees = {}; },
    r => { delete r.fees.at(-1).deduct; }, r => { r.fees.at(-1).cat = ""; },
    r => { r.fees.at(-1).unexpected = ""; }]) {
    const changed = structuredClone(raw); mutation(changed);
    await closed({ ...input, legacySource: { envelopeBytes, payloadBytes: Buffer.from(JSON.stringify(changed)) } });
  }
  for (const name of ["envelopeBytes", "payloadBytes"]) {
    await closed({ ...input, legacySource: { ...legacySource, [name]: Buffer.concat([legacySource[name], Buffer.from(" ")]) } });
  }
  const malformed = structuredClone(receipt); malformed.legacySource.extra = true;
  await closed({ ...input, receipt: resign(malformed) });
  const wrongPolicy = structuredClone(receipt); wrongPolicy.legacySource.policyId = "unknown";
  await closed({ ...input, receipt: resign(wrongPolicy) });
  const downgraded = structuredClone(receipt); delete downgraded.legacySource;
  downgraded.schema = "fee-console.calculation-receipt.v1";
  await closed({ ...input, receipt: resign(downgraded) });
  const changedDB = structuredClone(economicInput); changedDB.settings.fx.JPY = 0.0068;
  await closed({ ...input, economicInput: changedDB });
  const nativeReceipt = buildFeeCalculationReceipt({ data, economicInput: native });
  assert.equal((await sandbox.feeReceiptUiModel({ receipt: nativeReceipt, data, economicInput: native })).ok, true);
});

test("the future index-only UI migration must satisfy the frozen receipt-consumer contract", async () => {
  const html = fs.readFileSync(htmlPath, "utf8");
  const contractFixture = fixture();
  assert.equal(contractFixture.receipt.effectiveFlowCount, 1,
    "the UI contract fixture must exercise a confirmed in-kind transfer");
  assert.ok(contractFixture.receipt.balance.paidCents > 0,
    "the UI contract fixture must exercise an FX-converted payment");
  const starts = html.split(START).length - 1;
  const ends = html.split(END).length - 1;
  const historyStarts = html.split(HISTORY_START).length - 1;
  const historyEnds = html.split(HISTORY_END).length - 1;
  const renderStarts = html.split(RENDER_START).length - 1;
  const renderEnds = html.split(RENDER_END).length - 1;

  // Stage 1 intentionally adds no UI code.  Once the separate index-only PR
  // introduces either marker, both markers and the executable contract below
  // become mandatory.
  if (starts === 0 && ends === 0) {
    assert.equal(html.includes("feeReceiptUiModel"), false,
      "the UI consumer cannot be introduced without its guarded contract markers");
    assert.equal(html.includes("feeCalculationReceipt"), false,
      "index.html cannot consume a receipt outside the guarded contract block");
    assert.equal(historyStarts, 0);
    assert.equal(historyEnds, 0);
    assert.equal(renderStarts, 0);
    assert.equal(renderEnds, 0);
    assert.equal(html.includes("monthHistoryViewModel"), false,
      "the history view model cannot be introduced without its guarded contract markers");
    return;
  }
  assert.equal(starts, 1, "there must be exactly one receipt-consumer start marker");
  assert.equal(ends, 1, "there must be exactly one receipt-consumer end marker");
  const from = html.indexOf(START) + START.length;
  const to = html.indexOf(END);
  assert.ok(to > from, "receipt-consumer markers are out of order");

  const sandbox = {
    crypto: crypto.webcrypto,
    TextEncoder,
    TextDecoder,
    structuredClone,
    console: { log() {}, warn() {}, error() {} }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(html.slice(from, to), sandbox, { filename: "index-fee-receipt-consumer.js" });
  assert.equal(typeof sandbox.feeReceiptUiModel, "function",
    "the guarded block must expose globalThis.feeReceiptUiModel");

  const { data, economicInput, receipt } = contractFixture;
  const valid = plain(await sandbox.feeReceiptUiModel({ receipt, data, economicInput }));
  assert.deepEqual(valid, {
    ok: true,
    reason: null,
    receiptId: receipt.receiptId,
    asOf: receipt.asOf,
    start: receipt.start,
    managementRatePpm: receipt.managementRatePpm,
    carryRatePpm: receipt.carryRatePpm,
    status: receipt.status,
    periods: receipt.periods,
    totals: receipt.totals,
    balance: receipt.balance,
    ...(html.includes("/* benchmark-account-view:start */") ? { benchmarkInputs: { openingCents: 10_000_000, flows: [{ date: "2026-08-02", amountCents: 2_400_000 }] } } : {})
  });

  const outOfRangeEconomicInput = structuredClone(economicInput);
  outOfRangeEconomicInput.months.push(
    { ym: "2026-07", flows: [{
      id: "confirmed-before-start",
      src: "outside-source-before",
      date: "2026-07-31",
      acct: "schwab",
      amount: 900_000,
      note: "outside the receipt window"
    }] },
    { ym: "2026-09", flows: [{
      id: "confirmed-after-as-of",
      src: "outside-source-after",
      date: "2026-09-01",
      acct: "webull",
      amount: 800_000,
      note: "outside the receipt window"
    }] }
  );
  const outOfRangeReceipt = buildFeeCalculationReceipt({
    data,
    economicInput: outOfRangeEconomicInput
  });
  assert.notEqual(outOfRangeReceipt.econInputsHash, receipt.econInputsHash,
    "out-of-range private records must remain committed by the receipt");
  for (const key of [
    "effectiveFlowsHash", "effectiveFlowCount", "effectiveFlowNetCents",
    "periods", "totals", "balance"
  ]) {
    assert.deepEqual(outOfRangeReceipt[key], receipt[key],
      `${key} must ignore confirmed private flows outside [start, asOf]`);
  }
  const outOfRangeValid = plain(await sandbox.feeReceiptUiModel({
    receipt: outOfRangeReceipt,
    data,
    economicInput: outOfRangeEconomicInput
  }));
  assert.equal(outOfRangeValid.ok, true,
    "the UI consumer must accept the core receipt when only out-of-range confirmed flows were added");
  assert.deepEqual(outOfRangeValid.periods, valid.periods);
  assert.deepEqual(outOfRangeValid.totals, valid.totals);
  assert.deepEqual(outOfRangeValid.balance, valid.balance);

  const assertClosed = async input => {
    const result = plain(await sandbox.feeReceiptUiModel(input));
    assert.deepEqual(result, { ok: false, reason: "calculation receipt pending" });
    assert.doesNotMatch(JSON.stringify(result), /Cents|Ppm|receiptId/,
      "a failed receipt must expose no stale financial result");
  };

  const staleData = structuredClone(data);
  staleData.daily.at(-1).webull += 1;
  await assertClosed({ receipt, data: staleData, economicInput });

  const changedEconomicInput = structuredClone(economicInput);
  changedEconomicInput.settings.mgmt = 2.01;
  await assertClosed({ receipt, data, economicInput: changedEconomicInput });

  const changedPayment = structuredClone(economicInput);
  changedPayment.fees[0].amount += 1;
  await assertClosed({ receipt, data, economicInput: changedPayment });

  const changedFx = structuredClone(economicInput);
  changedFx.settings.fx.HKD = 0.13;
  await assertClosed({ receipt, data, economicInput: changedFx });

  const changedFlow = structuredClone(economicInput);
  changedFlow.months[0].flows[0].amount += 0.01;
  await assertClosed({ receipt, data, economicInput: changedFlow });

  const unresolved = structuredClone(data);
  unresolved.flowsUnresolved = [{ id: "needs-review" }];
  unresolved.status = { ...unresolved.status, provisional: true, unresolvedCount: 1 };
  await assertClosed({ receipt, data: unresolved, economicInput });

  const newer = structuredClone(data);
  newer.daily.push({ d: "2026-08-04", schwab: 74_500, webull: 50_800 });
  newer.status = { ...newer.status, asOf: "2026-08-04" };
  await assertClosed({ receipt, data: newer, economicInput });

  const tampered = structuredClone(receipt);
  tampered.totals.managementFeeCents += 1;
  await assertClosed({ receipt: tampered, data, economicInput });

  const unknownPeriodField = structuredClone(receipt);
  unknownPeriodField.periods[0].privateNote = "must never reach the DOM";
  await assertClosed({ receipt: resign(unknownPeriodField), data, economicInput });

  const unknownStatusField = structuredClone(receipt);
  unknownStatusField.status.privateNote = "must never reach the DOM";
  await assertClosed({ receipt: resign(unknownStatusField), data, economicInput });

  for (const versionChange of [
    { schema: "fee-console.calculation-receipt.v2" },
    { engineVersion: "fee-v999" }
  ]) {
    await assertClosed({
      receipt: resign({ ...structuredClone(receipt), ...versionChange }),
      data,
      economicInput
    });
  }
  await assertClosed({ receipt: null, data, economicInput });

  assert.equal(renderStarts, 1, "there must be exactly one fee-receipt render start marker");
  assert.equal(renderEnds, 1, "there must be exactly one fee-receipt render end marker");
  const renderFrom = html.indexOf(RENDER_START) + RENDER_START.length;
  const renderTo = html.indexOf(RENDER_END);
  assert.ok(renderTo > renderFrom, "fee-receipt render markers are out of order");
  vm.runInContext(html.slice(renderFrom, renderTo), sandbox, { filename: "index-fee-receipt-render.js" });
  assert.equal(typeof sandbox.feeReceiptRenderProjection, "function",
    "the guarded render block must expose globalThis.feeReceiptRenderProjection");
  const projection = plain(sandbox.feeReceiptRenderProjection(valid));
  assert.deepEqual(projection, {
    state: "verified",
    message: null,
    receiptId: valid.receiptId,
    asOf: valid.asOf,
    start: valid.start,
    managementRatePpm: valid.managementRatePpm,
    carryRatePpm: valid.carryRatePpm,
    status: valid.status,
    periods: valid.periods,
    totals: valid.totals,
    balance: valid.balance,
    ...(html.includes("/* benchmark-account-view:start */") ? { benchmarkInputs: valid.benchmarkInputs } : {})
  });
  const pendingProjection = plain(sandbox.feeReceiptRenderProjection({
    ok: false, reason: "calculation receipt pending"
  }));
  assert.deepEqual(pendingProjection, {
    state: "pending",
    message: "计算回执待更新",
    receiptId: null,
    asOf: null,
    start: null,
    managementRatePpm: null,
    carryRatePpm: null,
    status: null,
    periods: [],
    totals: null,
    balance: null,
    ...(html.includes("/* benchmark-account-view:start */") ? { benchmarkInputs: null } : {})
  });
  assert.equal(Object.values(pendingProjection).some(value => typeof value === "number"), false,
    "the pending render projection must contain no stale financial number");

  assert.equal(html.split(RENDER_CALL).length - 1, 1,
    "the production render path must contain exactly one guarded receipt-render call");
  const renderFunction = html.indexOf("function render(");
  const nextFunction = html.indexOf("function ", renderFunction + 10);
  const renderCall = html.indexOf(RENDER_CALL);
  assert.ok(renderFunction >= 0 && renderCall > renderFunction && renderCall < nextFunction,
    "the guarded receipt-render call must be inside the production render function");
  const renderBody = html.slice(renderFunction, nextFunction);
  assert.match(renderBody,
    /const\s+feeView\s*=\s*feeReceiptRenderProjection\s*\(\s*await\s+feeReceiptUiModel\s*\(/,
    "the production render function must pass the validated adapter result directly into the safe projection");
  for (const consumer of [
    "renderKPIs", "renderChart1", "renderChart2", "renderChart3", "renderMonths", "renderBal", "renderFees"
  ]) {
    assert.match(renderBody, new RegExp(`${consumer}\\s*\\(\\s*feeView(?:\\s*[,)]|\\s*\\))`),
      `${consumer} must receive the validated receipt projection`);
  }
  assert.doesNotMatch(renderBody, /DB\.settings\.(?:start|mgmt|carry)|balance\s*\(|compute\s*\(/,
    "the production render function cannot bypass the receipt for economic settings or calculations");
  assert.equal(/function\s+(?:periodReturns|compute|balance)\s*\(/.test(html), false,
    "legacy browser-side fee, Carry, payment and return calculation paths must be removed");

  assert.equal(historyStarts, 1, "there must be exactly one month-history start marker");
  assert.equal(historyEnds, 1, "there must be exactly one month-history end marker");
  const historyFrom = html.indexOf(HISTORY_START) + HISTORY_START.length;
  const historyTo = html.indexOf(HISTORY_END);
  assert.ok(historyTo > historyFrom, "month-history markers are out of order");
  vm.runInContext(html.slice(historyFrom, historyTo), sandbox, { filename: "index-month-history-view.js" });
  assert.equal(typeof sandbox.monthHistoryViewModel, "function",
    "the guarded history block must expose globalThis.monthHistoryViewModel");
  const compactMonths = html.includes("/* month-selection-view:v1 */");
  if (compactMonths) {
  assert.equal(typeof sandbox.monthHistoryMonthFromEvent, "function",
    "the guarded history block must expose globalThis.monthHistoryMonthFromEvent");
  assert.equal(sandbox.monthHistoryMonthFromEvent({ target: { id: "monthHistoryMonth", value: "2024-09" } }), "2024-09");
  assert.equal(sandbox.monthHistoryMonthFromEvent({ target: { id: "other", value: "2024-09" } }), null);
  assert.equal(sandbox.monthHistoryMonthFromEvent({ target: { id: "monthHistoryMonth", value: "2024-13" } }), null);
  } else {
    assert.equal(typeof sandbox.monthHistoryYearFromEvent, "function");
    assert.equal(sandbox.monthHistoryYearFromEvent({ target: { id: "monthHistoryYear", value: "2024" } }), "2024");
    assert.equal(sandbox.monthHistoryYearFromEvent({ target: { id: "other", value: "2024" } }), null);
    assert.equal(html.includes("monthHistoryMonthFromEvent"), false, "partial month-selector rollout must not pass");
  }

  const monthRows = (count, endYm) => {
    const rows = [];
    let [year, month] = endYm.split("-").map(Number);
    for (let index = 0; index < count; index += 1) {
      rows.unshift({ ym: `${year}-${String(month).padStart(2, "0")}`, marker: count - index });
      month -= 1;
      if (month === 0) { month = 12; year -= 1; }
    }
    return rows;
  };
  const defaults = compactMonths ? { detailOpen: false, trendOpen: false } : { latestOpen: true, historyOpen: false, monthOpen: false, trendOpen: false };
  for (const count of [1, 36, 120]) {
    const rows = monthRows(count, "2026-08");
    const model = plain(sandbox.monthHistoryViewModel({
      rows, publicAsOf: "2026-08-31", selectedYm: "2024-09", selectedYear: "2024", isManager: false
    }));
    assert.equal(model.allCount, count);
    assert.deepEqual(model.latest, rows.at(-1));
    assert.deepEqual(model.recent12, rows.slice(-12));
    assert.deepEqual(model.defaults, defaults);
    if (compactMonths) {
    assert.deepEqual(model.months, [...rows].reverse(), "every historical month remains selectable across years");
    if (count === 1) {
      assert.equal(model.selectedYm, "2026-08");
      assert.deepEqual(model.selected, rows.at(-1));
    } else {
      assert.equal(model.selectedYm, "2024-09");
      assert.deepEqual(model.selected, rows.find(row => row.ym === "2024-09"));
    }
    } else {
      assert.equal(model.historyCount, Math.max(0, count - 1));
      assert.deepEqual(model.years, [...new Set(rows.map(row => row.ym.slice(0, 4)))].sort().reverse());
      assert.equal(model.selectedYear, count === 1 ? "2026" : "2024");
      assert.deepEqual(model.history, rows.slice(0, -1).filter(row => row.ym.startsWith(model.selectedYear + "-")).reverse());
    }
    const manager = plain(sandbox.monthHistoryViewModel({
      rows, publicAsOf: "2026-08-31", selectedYm: model.selectedYm, selectedYear: model.selectedYear, isManager: true
    }));
    assert.deepEqual(manager, model, "read-only users and managers must have the same history navigation");
  }

  const futureRows = monthRows(3, "2026-09");
  assert.throws(
    () => sandbox.monthHistoryViewModel({
      rows: futureRows, publicAsOf: "2026-08-31", selectedYm: null, isManager: false
    }),
    /publicAsOf/,
    "a row after the verified public as-of date must fail closed, not be hidden"
  );
  const crossYearRows = monthRows(3, "2027-01");
  const crossYear = plain(sandbox.monthHistoryViewModel({
    rows: crossYearRows, publicAsOf: "2027-01-31", selectedYm: null, isManager: false
  }));
  assert.equal(compactMonths ? crossYear.selectedYm : crossYear.selectedYear, compactMonths ? "2027-01" : "2027",
    "the default selection must be the latest verified data month");
  assert.equal(crossYear.latest.ym, "2027-01");
  assert.throws(
    () => sandbox.monthHistoryViewModel({ rows: futureRows, publicAsOf: "not-a-date" }),
    /publicAsOf/,
    "an invalid public as-of date must fail closed"
  );
  const incompleteRows = monthRows(3, "2026-07");
  assert.throws(
    () => sandbox.monthHistoryViewModel({
      rows: incompleteRows, publicAsOf: "2026-08-31", selectedYm: null, isManager: false
    }),
    /publicAsOf/,
    "history ending before the verified public as-of month must fail closed, not show stale history"
  );

  const changeHandler = html.indexOf('document.body.addEventListener("change"');
  assert.ok(changeHandler >= 0, "the page must retain its delegated change handler");
  if (compactMonths) assert.throws(() => sandbox.monthHistoryViewModel({ rows: [crossYearRows.at(-1), crossYearRows.at(-1)], publicAsOf: "2027-01-31" }), /publicAsOf/, "duplicate months cannot be hidden by a selector");
  const historyChange = html.indexOf(compactMonths ? "monthHistoryMonthFromEvent(e)" : "monthHistoryYearFromEvent(e)", changeHandler);
  const managerGate = html.indexOf("if(!isMgr())return", changeHandler);
  assert.ok(historyChange > changeHandler && managerGate > historyChange,
    "the read-only month selector must be handled before the manager-only gate");
});

test("passive-account balances use only receipt-verified dated flows and independent benchmark prices", async t => {
  const html = fs.readFileSync(htmlPath, "utf8");
  if (!html.includes("/* benchmark-account-view:start */")) {
    assert.equal(html.includes("benchmarkInputs"), false, "unmarked partial benchmark rollout cannot pass");
    return; // The separately reviewed test PR must also accept the current main UI.
  }
  let points = [];
  const context = vm.createContext({ crypto: crypto.webcrypto, TextEncoder, TextDecoder, structuredClone,
    num: x => Number.parseFloat(x) || 0, dailySorted: () => points });
  for (const [start, end] of [[START, END], [RENDER_START, RENDER_END]]) {
    vm.runInContext(html.slice(html.indexOf(start) + start.length, html.indexOf(end)), context);
  }
  vm.runInContext(html.slice(html.indexOf("const BENCH_ALL="), html.indexOf("function receiptState(")), context);
  const rowsOf = model => model.periods.map(p => ({ ym: p.ym, from: p.from, to: p.to, days: p.calendarDayCount }));
  const { data, economicInput, receipt } = fixture();
  data.daily.unshift({ d: "2026-07-31", schwab: 60_000, webull: 40_000, spy: 100, qqq: 100 });
  Object.assign(data.daily[1], { spy: 100, qqq: 100 });
  Object.assign(data.daily[2], { spy: 110, qqq: 105 });
  Object.assign(data.daily[3], { spy: 121, qqq: 110.25 });
  const valid = plain(await context.feeReceiptUiModel({ receipt, data, economicInput }));
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.benchmarkInputs, { openingCents: 10_000_000, flows: [{ date: "2026-08-02", amountCents: 2_400_000 }] },
    "confirmed and automatic representations of one FOP must produce one dated flow only");
  assert.doesNotMatch(JSON.stringify(valid.benchmarkInputs), /note|src|id|hash|acct|BRK|holding/i,
    "the display projection must not disclose private provenance or notes");
  const view = plain(context.feeReceiptRenderProjection(valid));

  await t.test("same opening, total-return pricing and EOD contributions, not month-net shortcuts", () => {
    points = data.daily;
    const result = plain(context.benchmarkView(view, rowsOf(view)));
    assert.ok(Math.abs(result.bench[0].val - 147_400) < 1e-7);
    assert.ok(Math.abs(result.bench[1].val - 135_450) < 1e-7);
    assert.ok(Math.abs(result.bench[0].twr - 0.21) < 1e-12);
    assert.notEqual(result.bench[0].val, 100_000 * 1.21 + 24_000);
  });
  await t.test("same-day dividends are reinvested before an EOD flow", () => {
    points = data.daily.map(p => ({ ...p }));
    points[2].spy = 108; points[2].spyd = 2; points[3].spy = 118.8;
    const result = plain(context.benchmarkView(view, rowsOf(view)));
    assert.ok(Math.abs(result.bench[0].val - 147_400) < 1e-7);
  });
  await t.test("cross-month inflow and withdrawal preserve the same daily path", () => {
    points = [
      { d: "2026-09-28", spy: 100, qqq: 100 }, { d: "2026-09-29", spy: 100, qqq: 100 },
      { d: "2026-09-30", spy: 110, qqq: 110 }, { d: "2026-10-01", spy: 121, qqq: 121 },
      { d: "2026-10-02", spy: 133.1, qqq: 133.1 }
    ];
    const result = context.benchmarkView({ state: "verified", start: "2026-09-29", asOf: "2026-10-02",
      benchmarkInputs: { openingCents: 10_000, flows: [{ date: "2026-09-30", amountCents: 5_000 }, { date: "2026-10-01", amountCents: -4_000 }] } },
    [{ ym: "2026-09", from: "2026-09-29", to: "2026-09-30", days: 2 }, { ym: "2026-10", from: "2026-10-01", to: "2026-10-02", days: 2 }]);
    for (const bench of result.bench) assert.ok(Math.abs(bench.val - 149.6) < 1e-10);
  });
  await t.test("over-withdrawal disables the affected balance without borrowing or hiding TWR", () => {
    points = [{ d: "2026-10-02", spy: 100, qqq: 100 }, { d: "2026-10-03", spy: 70, qqq: 100 }];
    const result = context.benchmarkView({ state: "verified", start: "2026-10-03", asOf: "2026-10-03",
      benchmarkInputs: { openingCents: 10_000, flows: [{ date: "2026-10-03", amountCents: -8_000 }] } },
    [{ ym: "2026-10", from: "2026-10-03", to: "2026-10-03", days: 1 }]);
    assert.equal(result.bench[0].val, null); assert.equal(result.bench[0].valueReason, "withdrawal-exceeds-value");
    assert.ok(Math.abs(result.bench[0].twr + .3) < 1e-12); assert.equal(result.bench[1].val, 20);
  });
  await t.test("missing or invalid quotes cannot create a passive-account balance", () => {
    for (const change of [p => { delete p[2].spy; }, p => { p[2].qqqd = "invalid"; }, p => { p[2].spyd = -1; }]) {
      points = data.daily.map(p => ({ ...p })); change(points);
      assert.equal(context.benchmarkView(view, rowsOf(view)).bench.length, 0);
    }
    points = data.daily.map(p => ({ ...p })); points[0].d = "2026-07-30";
    assert.deepEqual(plain(context.benchmarkView(view, rowsOf(view))), { bench: [], byMonth: {} },
      "an earlier baseline cannot masquerade as same-period TWR or monthly benchmark returns");
  });
  await t.test("prior/current prices and present dividends reject coercible non-numbers", () => {
    for (const invalid of ["100bad", "100", "", " ", null, true, false, [], [100], {}, undefined, Infinity, NaN]) {
      for (const [index, key] of [[0, "spy"], [2, "spy"], [2, "spyd"]]) {
        points = data.daily.map(p => ({ ...p })); points[index][key] = invalid;
        assert.equal(context.benchmarkView(view, rowsOf(view)).bench.length, 0,
          `reject ${String(invalid)} at ${index}/${key}, including a present undefined dividend`);
      }
    }
    points = data.daily.map(p => ({ ...p }));
    points[2].spyd = 0;
    assert.ok(context.benchmarkView(view, rowsOf(view)).bench.every(b => Number.isFinite(b.val)),
      "a numeric zero dividend and an omitted dividend remain valid");
  });
  await t.test("missing or malformed dated flows never turn into zero flows", () => {
    points = data.daily;
    for (const benchmarkInputs of [null, { openingCents: 10_000_000 },
      { openingCents: 10_000_000, flows: [{ date: "2026-08-02", amountCents: 1.5 }] },
      { openingCents: 10_000_000, flows: [{ date: "2026-09-02", amountCents: 100 }] }]) {
      const result = context.benchmarkView({ ...view, benchmarkInputs }, rowsOf(view));
      assert.ok(result.bench.every(b => b.val === null && Number.isFinite(b.twr)));
    }
  });
  await t.test("failed receipt or changed private flows expose neither old balance inputs nor stale balances", async () => {
    points = data.daily;
    const changed = structuredClone(economicInput); changed.months[0].flows[0].amount += 1;
    for (const input of [{ receipt: null, data, economicInput }, { receipt, data, economicInput: changed }]) {
      const rejected = await context.feeReceiptUiModel(input), pending = context.feeReceiptRenderProjection(rejected);
      assert.equal(rejected.ok, false); assert.equal(pending.benchmarkInputs, null);
      assert.deepEqual(plain(context.benchmarkView(pending, rowsOf(view))), { bench: [], byMonth: {} });
    }
  });
});
