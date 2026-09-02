import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { buildFeeCalculationReceipt, semanticHash } from "./fee-receipt-core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(here, "..", "index.html");
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
    balance: receipt.balance
  });

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
    balance: valid.balance
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
    balance: null
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
  assert.equal(typeof sandbox.monthHistoryYearFromEvent, "function",
    "the guarded history block must expose globalThis.monthHistoryYearFromEvent");
  assert.equal(sandbox.monthHistoryYearFromEvent({ target: { id: "monthHistoryYear", value: "2024" } }), "2024");
  assert.equal(sandbox.monthHistoryYearFromEvent({ target: { id: "other", value: "2024" } }), null);

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
  const defaults = { latestOpen: true, historyOpen: false, monthOpen: false, trendOpen: false };
  for (const count of [1, 36, 120]) {
    const rows = monthRows(count, "2026-08");
    const model = plain(sandbox.monthHistoryViewModel({
      rows, publicAsOf: "2026-08-31", selectedYear: "2024", isManager: false
    }));
    assert.equal(model.allCount, count);
    assert.deepEqual(model.latest, rows.at(-1));
    assert.equal(model.historyCount, Math.max(0, count - 1));
    assert.deepEqual(model.recent12, rows.slice(-12));
    assert.deepEqual(model.defaults, defaults);
    assert.deepEqual(model.years, [...new Set(rows.map(row => row.ym.slice(0, 4)))].sort().reverse());
    if (count === 1) {
      assert.equal(model.selectedYear, "2026");
      assert.deepEqual(model.history, []);
    } else {
      assert.equal(model.selectedYear, "2024");
      assert.ok(model.history.every(row => row.ym.startsWith("2024-")));
      assert.deepEqual(model.history, rows.slice(0, -1).filter(row => row.ym.startsWith("2024-")).reverse());
    }
    const manager = plain(sandbox.monthHistoryViewModel({
      rows, publicAsOf: "2026-08-31", selectedYear: model.selectedYear, isManager: true
    }));
    assert.deepEqual(manager, model, "read-only users and managers must have the same history navigation");
  }

  const futureRows = monthRows(3, "2026-09");
  assert.throws(
    () => sandbox.monthHistoryViewModel({
      rows: futureRows, publicAsOf: "2026-08-31", selectedYear: null, isManager: false
    }),
    /publicAsOf/,
    "a row after the verified public as-of date must fail closed, not be hidden"
  );
  const crossYearRows = monthRows(3, "2027-01");
  const crossYear = plain(sandbox.monthHistoryViewModel({
    rows: crossYearRows, publicAsOf: "2027-01-31", selectedYear: null, isManager: false
  }));
  assert.equal(crossYear.selectedYear, "2027",
    "the default history year must match the verified public as-of year");
  assert.equal(crossYear.latest.ym, "2027-01");
  assert.throws(
    () => sandbox.monthHistoryViewModel({ rows: futureRows, publicAsOf: "not-a-date" }),
    /publicAsOf/,
    "an invalid public as-of date must fail closed"
  );
  const incompleteRows = monthRows(3, "2026-07");
  assert.throws(
    () => sandbox.monthHistoryViewModel({
      rows: incompleteRows, publicAsOf: "2026-08-31", selectedYear: null, isManager: false
    }),
    /publicAsOf/,
    "history ending before the verified public as-of month must fail closed, not show stale history"
  );

  const changeHandler = html.indexOf('document.body.addEventListener("change"');
  assert.ok(changeHandler >= 0, "the page must retain its delegated change handler");
  const historyChange = html.indexOf("monthHistoryYearFromEvent(e)", changeHandler);
  const managerGate = html.indexOf("if(!isMgr())return", changeHandler);
  assert.ok(historyChange > changeHandler && managerGate > historyChange,
    "the read-only month-history year selector must be handled before the manager-only gate");
});
