import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createFundInvestorCore } from "./fund-investor-core.mjs";

const core = createFundInvestorCore();
test("activated browser uses the exact reviewed fund factory", () => {
  const html=fs.readFileSync(new URL("../index.html",import.meta.url),"utf8");
  const start="/* fund-investor-core:start */",end="/* fund-investor-core:end */";
  if(!html.includes(start)){assert.ok(!html.includes('id="p-investors"'));return;}
  assert.equal(html.split(start).length,2);assert.equal(html.split(end).length,2);
  const embedded=html.split(start)[1].split(end)[0].trim();
  if(!embedded.includes('const EVENT_KEYS =')){
    // During the support-only PR, accept precisely the reviewed pre-event UI.
    // The subsequent index-only PR must embed the new factory exactly.
    assert.equal(createHash("sha256").update(embedded).digest("hex"),"4714a07b1c7fccd974253d91814d63d8e98707ee652dd8e3e6ac6974a57b89fc");
    return;
  }
  if(!embedded.includes('const CORRECTION_KEYS =')){
    // Support-only PR: preserve the exact published pre-correction factory.
    assert.equal(createHash("sha256").update(embedded).digest("hex"),"b53dd552718319f220fc0ba57a7055a3fd5eb0de7781910d226848fa0705c92a");
    return;
  }
  assert.equal(embedded,createFundInvestorCore.toString()+"\nconst fundInvestorCore=createFundInvestorCore();");
});
const fixture = () => ({
  profile: { schema: "fee-console.fund-profile.v1", manager: "Example Manager", fundName: "Example Fund",
    inceptionDate: "2024-02-28", inceptionNoticeDate: "2024-03-01", currency: "USD", initialShares: 1_000_000,
    investors: [{ id: "A", name: "Example Alpha", shares: 900_000 }, { id: "B", name: "Example Beta", shares: 100_000 }] },
  data: { daily: [
    { d: "2024-02-27", schwab: 40, webull: 10, cash: 3 },
    { d: "2024-02-28", schwab: 60, webull: 40, cash: 20 },
    { d: "2024-02-29", schwab: 61, webull: 40.01, cash: 20 },
    { d: "2024-03-01", schwab: 66, webull: 44, cash: 22 }
  ] },
  feeView: { state: "verified", start: "2024-02-27", asOf: "2024-03-01", status: { provisional: false },
    benchmarkInputs: { openingCents: 5_000, flows: [{ date: "2024-02-28", amountCents: 5_000 }] } }
});
const assertPending = input => {
  const actual = core.calculate(input);
  assert.equal(actual.status, "pending"); assert.equal(actual.current, null);
  assert.equal(actual.initial, null); assert.equal(actual.lastProved, null); assert.deepEqual(actual.points, []);
  return actual;
};

test("post-flow inception total includes account cash once, with fixed 90/10 shares", () => {
  const actual = core.calculate(fixture());
  assert.equal(actual.status, "ready"); assert.equal(actual.initial.totalCents, 10_000);
  assert.equal(actual.initial.unitValue, 0.0001); assert.equal(actual.initial.returnRate, 0);
  assert.equal(actual.current.totalCents, 11_000); assert.equal(actual.current.grossPnlCents, 1_000);
  assert.deepEqual(actual.initial.investors.map(x => x.valueCents), [9_000, 1_000]);
  assert.deepEqual(actual.current.investors.map(x => [x.shares, x.valueCents, x.pnlCents]), [[900_000, 9_900, 900], [100_000, 1_100, 100]]);
  assert.ok(Math.abs(actual.current.returnRate - 0.1) < 1e-12);
  assert.equal(actual.points.length, 3); assert.equal(actual.current.date, "2024-03-01");
});

test("allocated cents and PnL reconcile on every day, including awkward pennies", () => {
  const actual = core.calculate(fixture());
  assert.deepEqual(actual.points[1].investors.map(x => x.valueCents), [9_091, 1_010]);
  for (const point of actual.points) {
    assert.equal(point.investors.reduce((sum, x) => sum + x.valueCents, 0), point.totalCents);
    assert.equal(point.investors.reduce((sum, x) => sum + x.pnlCents, 0), point.grossPnlCents);
    assert.equal(point.investors[0].returnRate, point.investors[1].returnRate);
  }
});

test("pre-inception benchmark-only and unrelated account-less rows are ignored for valuation", () => {
  const input = fixture(), expected = core.calculate(input);
  input.data.daily[0] = { d: "2024-02-27", spy: 400, qqq: 300 };
  input.data.daily.unshift({ d: "2024-01-31" }, { d: "2024-02-01", schwab: "unrelated invalid value" });
  assert.deepEqual(core.calculate(input), expected);
  input.data.daily[0].d = "2024-01-32"; assertPending(input);
  input.data.daily[0].d = "2024-02-01"; assertPending(input);
});

test("any later flow freezes history before the earliest event, even a net-zero pair", () => {
  const input = fixture();
  input.feeView.benchmarkInputs.flows.push({ date: "2024-03-01", amountCents: 10 },
    { date: "2024-02-29", amountCents: -100 }, { date: "2024-02-29", amountCents: 100 });
  const actual = core.calculate(input);
  assert.equal(actual.status, "partial"); assert.equal(actual.flowGateDate, "2024-02-29");
  assert.equal(actual.current, null); assert.equal(actual.lastProved.date, "2024-02-28");
  assert.equal(actual.points.length, 1); assert.match(actual.reason, /2024-02-29/);
});

test("a later zero-cent event also requires ownership review", () => {
  const input = fixture(); input.feeView.benchmarkInputs.flows.push({ date: "2024-03-01", amountCents: 0 });
  const actual = core.calculate(input);
  assert.equal(actual.status, "partial"); assert.equal(actual.lastProved.date, "2024-02-29");
});

const subscriptionFixture = () => {
  const input = fixture();
  input.profile.subscriptions = [{ id: "sub-20240301-B", date: "2024-03-01", investorId: "B",
    grossCents: 5_002, feeCents: 2, netCents: 5_000, priceDate: "2024-02-29",
    priceTotalCents: 10_101, issuedShares: 495_000, sourceRef: "sharesight:56568337" }];
  input.data.daily[3].webull += 50;
  input.data.flowsAuto = [{ date: "2024-03-01", acct: "webull", amount: 50 }];
  input.feeView.benchmarkInputs.flows.push({ date: "2024-03-01", amountCents: 5_000 });
  return input;
};

test("matched subscription issues new shares without rewriting initial holdings or counting capital as profit", () => {
  const input = subscriptionFixture(), before = structuredClone(input), actual = core.calculate(input);
  assert.equal(actual.status, "ready");
  assert.equal(actual.current.totalCents, 16_000);
  assert.equal(actual.current.grossPnlCents, 1_000);
  assert.equal(actual.current.returnRate, null);
  assert.equal(actual.initial.investors[1].shares, 100_000);
  assert.equal(actual.current.investors[1].shares, 595_000);
  assert.equal(actual.current.investors[0].shares, 900_000);
  assert.equal(actual.current.subscription.netCents, 5_000);
  assert.equal(actual.current.investors.reduce((sum, x) => sum + x.valueCents, 0), 16_000);
  assert.equal(actual.current.investors.reduce((sum, x) => sum + x.pnlCents, 0), 1_000);
  assert.deepEqual(input, before);
});

test("an append-only attribution correction changes only the recipient of issued shares", () => {
  const input = subscriptionFixture(), original = structuredClone(input.profile.subscriptions[0]);
  input.profile.subscriptionCorrections = [{ id: "corr-20240302-A", subscriptionId: original.id,
    fromInvestorId: "B", toInvestorId: "A", reason: "Manager corrected the original investor attribution",
    correctedAt: "2024-03-02T00:00:00.000Z" }];
  const result = core.calculate(input);
  assert.equal(result.status, "ready");
  assert.equal(result.current.investors[0].shares, 1_395_000);
  assert.equal(result.current.investors[1].shares, 100_000);
  assert.equal(result.current.subscription.investorId, "A");
  assert.equal(result.current.totalCents, 16_000);
  assert.deepEqual(input.profile.subscriptions[0], original);
});

test("correction rejects unknown, duplicate, mismatched, and economic-changing records", () => {
  const valid = () => { const p = subscriptionFixture().profile; p.subscriptionCorrections = [{
    id: "corr-20240302-A", subscriptionId: p.subscriptions[0].id, fromInvestorId: "B", toInvestorId: "A",
    reason: "Original recipient was recorded incorrectly", correctedAt: "2024-03-02T00:00:00.000Z" }]; return p; };
  for (const mutate of [
    p => { p.subscriptionCorrections[0].subscriptionId = "missing-event"; },
    p => { p.subscriptionCorrections[0].fromInvestorId = "A"; },
    p => { p.subscriptionCorrections[0].toInvestorId = "B"; },
    p => { p.subscriptionCorrections[0].correctedAt = "2024-02-29T00:00:00.000Z"; },
    p => { p.subscriptionCorrections.push({ ...p.subscriptionCorrections[0], id: "another-correction" }); },
    p => { p.subscriptionCorrections[0].netCents = 100; },
    p => { p.subscriptionCorrections[0] = null; }
  ]) { const p = valid(); mutate(p); assert.equal(core.validateProfile(p).ok, false); }
});

test("unmatched, duplicated, or mispriced subscription evidence freezes before capital arrival", () => {
  for (const mutate of [
    x => { x.profile.subscriptions[0].issuedShares++; },
    x => { x.profile.subscriptions[0].priceTotalCents++; },
    x => { x.feeView.benchmarkInputs.flows.pop(); },
    x => { x.feeView.benchmarkInputs.flows.at(-1).amountCents++; },
    x => { x.data.flowsAuto[0].amount++; },
    x => { x.data.flowsAuto.push({ date: "2024-03-01", acct: "webull", amount: 50 }); },
    x => { x.data.flowsUnresolved = [{ date: "2024-03-01", acct: "unknown", amount: 50 }]; }
  ]) {
    const input = subscriptionFixture(); mutate(input);
    const actual = core.calculate(input);
    assert.equal(actual.status, "partial");
    assert.equal(actual.flowGateDate, "2024-03-01");
    assert.equal(actual.current, null);
    assert.equal(actual.lastProved.date, "2024-02-29");
  }
});

test("subscription schema rejects duplicate source, arithmetic mismatch and unknown investor", () => {
  for (const mutate of [
    p => { p.subscriptions[0].investorId = "C"; },
    p => { p.subscriptions[0].netCents++; },
    p => { p.subscriptions[0].feeCents = -1; },
    p => { p.subscriptions[0].priceDate = p.subscriptions[0].date; },
    p => { p.subscriptions[0].extra = true; },
    p => { p.subscriptions.push({ ...p.subscriptions[0], id: "other-event" }); }
  ]) {
    const input = subscriptionFixture(); mutate(input.profile);
    assert.equal(core.validateProfile(input.profile).ok, false);
    assertPending(input);
  }
});

test("unconfirmed automatic deposit omitted from receipt still blocks fixed-share valuation", () => {
  const input = fixture();
  input.data.flowsAuto = [{ date: "2024-02-29", acct: "webull", amount: 25, effective: false }];
  input.data.daily[2].webull += 25; input.data.daily[3].webull += 25;
  const actual = core.calculate(input);
  assert.equal(actual.status, "partial"); assert.equal(actual.flowGateDate, "2024-02-29");
  assert.equal(actual.current, null); assert.equal(actual.lastProved.date, "2024-02-28");
  assert.equal(actual.lastProved.grossPnlCents, 0);
});

test("unmapped source events and offsetting candidates gate at the earliest individual date", () => {
  const input = fixture();
  input.data.flowsUnresolved = [{ date: "2024-03-01", acct: "unknown", amount: 100 }];
  let actual = core.calculate(input);
  assert.equal(actual.status, "partial"); assert.equal(actual.lastProved.date, "2024-02-29");
  input.data.flowsAuto = [{ date: "2024-02-29", amount: -30, effective: false }, { date: "2024-02-29", amount: 30, effective: false }];
  actual = core.calculate(input);
  assert.equal(actual.status, "partial"); assert.equal(actual.flowGateDate, "2024-02-29");
  assert.equal(actual.lastProved.date, "2024-02-28"); assert.equal(actual.current, null);
});

test("source candidate arrays require valid objects and dates; malformed evidence hides all history", () => {
  for (const field of ["flowsAuto", "flowsUnresolved"]) {
    for (const malformed of [null, {}, [null], [{}], [{ date: "2024-02-30" }], [{ date: 20240229 }]]) {
      const input = fixture(); input.data[field] = malformed; assertPending(input);
    }
    const input = fixture(), expected = core.calculate(input);
    input.data[field] = [{ date: "2024-02-27" }, { date: "2024-02-28" }, { date: "2024-03-02" }];
    assert.deepEqual(core.calculate(input), expected);
  }
});

test("unverified, missing or delayed receipts never produce valuations", () => {
  const input = fixture(); input.feeView.state = "pending"; assertPending(input);
  delete input.feeView; assertPending(input); assertPending(); assertPending(null); assertPending([]);
  const delayed = fixture(); delayed.feeView.asOf = "2024-02-29"; assertPending(delayed);
  for (const mutate of [x => { x.feeView.asOf = "2024-02-30"; }, x => { x.feeView.start = "invalid"; },
    x => { x.feeView.start = "2024-03-02"; }, x => { x.feeView.benchmarkInputs.flows = {}; }]) {
    const malformed = fixture(); mutate(malformed); assertPending(malformed);
  }
});

test("malformed flow evidence invalidates all history instead of choosing an unsafe cap", () => {
  for (const flow of [null, {}, { date: "2024-02-30", amountCents: 1 }, { date: "2024-02-29", amountCents: 1.5 },
    { date: "2024-02-29", amountCents: "100" }, { date: "2024-02-29", amountCents: Infinity },
    { date: "2024-02-26", amountCents: 1 }, { date: "2024-03-02", amountCents: 1 },
    { date: "2024-02-29", amountCents: 1, unrecognized: true }]) {
    const input = fixture(); input.feeView.benchmarkInputs.flows.push(flow); assertPending(input);
  }
  const input = fixture(); delete input.feeView.benchmarkInputs; assertPending(input);
});

test("inception must be covered exactly and every calendar date through asOf must exist", () => {
  for (const mutate of [x => { x.profile.inceptionDate = "2024-02-26"; },
    x => { x.profile.inceptionDate = "2024-03-02"; x.profile.inceptionNoticeDate = "2024-03-02"; },
    x => { x.data.daily.splice(1, 1); }, x => { x.data.daily.splice(2, 1); }, x => { x.data.daily.pop(); }]) {
    const input = fixture(); mutate(input); assertPending(input);
  }
  const input = fixture(); input.feeView.benchmarkInputs.flows.push({ date: "2024-02-29", amountCents: 1 });
  input.data.daily.splice(2, 1); assertPending(input);
});

test("daily bad dates, ordering, duplicates, missing accounts and invalid totals fail closed", () => {
  for (const mutate of [x => { x.data.daily[1].d = "2024-02-30"; },
    x => { x.data.daily.reverse(); }, x => { x.data.daily.splice(2, 0, { ...x.data.daily[1] }); },
    x => { delete x.data.daily[1].webull; }, x => { x.data.daily[1].schwab = null; },
    x => { x.data.daily[1].schwab = -1; }, x => { x.data.daily[1].schwab = Infinity; },
    x => { x.data.daily[1].schwab = NaN; }, x => { x.data.daily[1].schwab = "4 invalid"; },
    x => { x.data.daily[1].schwab = Number.MAX_SAFE_INTEGER; },
    x => { x.data.daily[1].schwab = 0; x.data.daily[1].webull = 0; }]) {
    const input = fixture(); mutate(input); assertPending(input);
  }
});

test("strict bounded profile schema validates all dates, ids and share totals", () => {
  assert.equal(core.validateProfile(fixture().profile).ok, true);
  for (const mutate of [p => { p.extra = true; }, p => { delete p.inceptionNoticeDate; }, p => { p.schema = "other"; },
    p => { p.currency = "HKD"; }, p => { p.manager = " "; }, p => { p.manager = "a".repeat(121); },
    p => { p.fundName = "bad\nname"; }, p => { p.inceptionDate = "2023-02-29"; },
    p => { p.inceptionNoticeDate = "2024-02-27"; }, p => { p.initialShares = 0; },
    p => { p.initialShares = Number.MAX_SAFE_INTEGER + 1; }, p => { p.investors[0].shares = 900_001; },
    p => { p.investors[1].shares = 0; }, p => { p.investors[1].id = "A"; },
    p => { p.investors[1].name = "a".repeat(81); }, p => { p.investors[0].extra = true; },
    p => { p.investors.push({ id: "C", name: "Third", shares: 1 }); }]) {
    const input = fixture(); mutate(input.profile); assert.equal(core.validateProfile(input.profile).ok, false); assertPending(input);
  }
});

test("provisional flags are retained without claiming historical calibration", () => {
  const input = fixture(); input.data.daily[2].prov = true;
  const actual = core.calculate(input);
  assert.equal(actual.provisional, true); assert.equal(actual.points[1].provisional, true);
  assert.equal(Object.hasOwn(actual, "calibrated"), false);
});

test("large safe share counts use exact allocation arithmetic and fees are not recomputed", () => {
  const input = fixture(); input.profile.initialShares = Number.MAX_SAFE_INTEGER;
  input.profile.investors[0].shares = Number.MAX_SAFE_INTEGER - 1; input.profile.investors[1].shares = 1;
  input.feeView.totals = { totalFeeCents: 999_999_999 };
  const actual = core.calculate(input);
  assert.equal(actual.status, "ready"); assert.equal(actual.current.totalCents, 11_000);
  assert.deepEqual(actual.current.investors.map(x => x.valueCents), [11_000, 0]);
  assert.ok(actual.current.investors.every(x => Number.isFinite(x.returnRate)));
});

test("calculation neither mutates nor leaks references to input data or profile", () => {
  const input = fixture(), before = structuredClone(input), actual = core.calculate(input);
  assert.deepEqual(input, before);
  actual.profile.investors[0].name = "Changed"; actual.points[0].investors[0].shares = 7;
  assert.deepEqual(input, before);
  const checked = core.validateProfile(input.profile); checked.profile.investors[0].shares = 7;
  assert.deepEqual(input, before);
});
