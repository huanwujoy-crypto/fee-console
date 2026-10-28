import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createFundInvestorCore } from "./fund-investor-core.mjs";
import { reviewedUiStage, reviewedNextUiRegion } from "./fee-receipt-ui-contract.test.mjs";

const core = createFundInvestorCore();
test('independent Astra EOD scenario: symmetric noncash flow, unchanged cost and one seven-source subscription',async()=>{
 const {grossTwrDailyFactor,periodReturns}=await import('./fee-engine.mjs');
 assert.ok(Math.abs(grossTwrDailyFactor(200,-1100,1200)-1-1/12)<1e-12);
 assert.equal(grossTwrDailyFactor(2100,1100,1000)-1,0);
 assert.ok(Math.abs(grossTwrDailyFactor(2300,0,2200)-1-1/22)<1e-12);
 assert.ok(Math.abs(grossTwrDailyFactor(2122,0,2100)-1-22/2100)<1e-12);
 assert.ok(Math.abs(grossTwrDailyFactor(2322,0,2300)-1-22/2300)<1e-12);
 assert.ok(Math.abs(grossTwrDailyFactor(2100,800,1000)-1-.3)<1e-12);
 const r=periodReturns({points:[{d:'2026-10-27',tot:2100},{d:'2026-10-28',tot:2122}],openT:1000,from:'2026-10-27',to:'2026-10-28',days:2,flowByDate:{'2026-10-27':1100},rate:.01,cr:.2,cumBefore:0,hwmBefore:0});
 assert.equal(r.pnl,22);assert.equal(r.feeBaseSum,3122);assert.ok(Math.abs(r.mgmt-3122*.01/365)<1e-12);assert.ok(Math.abs(r.carry-4.4)<1e-12);
 assert.equal(-1100+1100,0,'AllTogether transfer is internal, no second family subscription');
});
test("reviewed next fund factory exactly matches source; the frozen prior factory remains a separate contract", () => {
  const html=fs.readFileSync(process.env.FEE_LEDGER_TEST_INDEX || new URL("../index.html",import.meta.url),"utf8");
  const stage=reviewedUiStage(html),start="/* fund-investor-core:start */",end="/* fund-investor-core:end */";
  assert.equal(html.split(start).length,2);assert.equal(html.split(end).length,2);
  const embedded=html.split(start)[1].split(end)[0].trim();
  const expected=createFundInvestorCore.toString()+"\nconst fundInvestorCore=createFundInvestorCore();";
  assert.equal(reviewedNextUiRegion("fund-investor-core").trim(),expected,
    "the next UI parity assertion always executes, including in support-only staging");
  if(stage==="prior")assert.notEqual(embedded,expected,"known old UI must not be described as the new factory");
  else assert.equal(embedded,expected);
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

const feeTransferFixture = () => {
  const input = fixture();
  input.profile.shareTransfers = [{
    id: "transfer-20240301-B-A", date: "2024-03-01", fromInvestorId: "B", toInvestorId: "A",
    paymentId: "payment-20240301-A", feeAmountCents: 2_500, compensationCents: 250,
    priceDate: "2024-02-29", priceTotalCents: 10_101, outstandingShares: 1_000_000,
    transferredShares: 24_750, reason: "A paid the fee outside the fund; B transfers its proportional compensation"
  }];
  input.payments = [{ id: "payment-20240301-A", date: "2024-03-01", amount: 25, ccy: "USD", fx: 1,
    note: "Paid outside the fund by A" }];
  return input;
};

test("off-fund fee payment transfers only the sender's proportional whole shares and preserves total shares", () => {
  const input = feeTransferFixture(), before = structuredClone(input), actual = core.calculate(input);
  assert.equal(actual.status, "ready");
  assert.deepEqual(core.registeredShares(input.profile), [924_750, 75_250]);
  assert.deepEqual(actual.current.investors.map(row => row.shares), [924_750, 75_250]);
  assert.equal(actual.current.investors.reduce((sum, row) => sum + row.shares, 0), 1_000_000);
  assert.equal(actual.current.shareTransfer.transferredShares, 24_750);
  assert.equal(actual.current.shareTransfer.basisCents, 250);
  assert.equal(actual.current.investors.reduce((sum, row) => sum + row.pnlCents, 0), actual.current.grossPnlCents);
  assert.deepEqual(input, before);
});

test("a registered next-day transfer changes the profile ratio but waits for that day's verified valuation", () => {
  const input = feeTransferFixture(); input.profile.shareTransfers[0].date = "2024-03-02";
  input.payments[0].date = "2024-03-02";
  const actual = core.calculate(input);
  assert.equal(actual.status, "ready");
  assert.deepEqual(actual.current.investors.map(row => row.shares), [900_000, 100_000]);
  assert.deepEqual(core.registeredShares(input.profile), [924_750, 75_250]);
});

test("fee compensation rejects missing payment, wrong math, duplicates and rewritten economics", () => {
  const valid = () => feeTransferFixture();
  for (const mutate of [
    x => { x.payments = []; },
    x => { x.payments[0].amount = 24.99; },
    x => { x.payments[0].ccy = "HKD"; }
  ]) { const input = valid(); mutate(input); const actual = core.calculate(input); assert.equal(actual.status, "partial"); assert.equal(actual.flowGateDate, "2024-03-01"); }
  for (const mutate of [
    p => { p.shareTransfers[0].compensationCents++; },
    p => { p.shareTransfers[0].transferredShares++; },
    p => { p.shareTransfers[0].outstandingShares++; },
    p => { p.shareTransfers[0].fromInvestorId = "A"; },
    p => { p.shareTransfers[0].toInvestorId = "B"; },
    p => { p.shareTransfers[0].extra = true; },
    p => { p.shareTransfers.push({ ...p.shareTransfers[0], id: "transfer-duplicate-event" }); }
  ]) { const input = valid(); mutate(input.profile); assert.equal(core.validateProfile(input.profile).ok, false); assertPending(input); }
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

const priceCorrectionFixture=()=>{
 const input=fixture();input.profile.investors=[{id:'A',name:'Example Alpha',shares:600},{id:'B',name:'Example Beta',shares:400}];input.profile.initialShares=1000;
 input.data.daily[2]={d:'2024-02-29',schwab:90,webull:91};
 input.profile.shareTransfers=[{id:'transfer-price-synthetic',date:'2024-03-01',fromInvestorId:'B',toInvestorId:'A',paymentId:'payment-price-synthetic',feeAmountCents:2500,compensationCents:1000,priceDate:'2024-02-29',priceTotalCents:18000,outstandingShares:1000,transferredShares:56,reason:'synthetic off-fund compensation'}];
 input.payments=[{id:'payment-price-synthetic',date:'2024-03-01',amount:25,ccy:'USD'}];return input;
};
const priceCorrection=()=>({id:'correction-price-synthetic',transferId:'transfer-price-synthetic',originalPriceDate:'2024-02-29',originalPriceTotalCents:18000,originalTransferredShares:56,priceDate:'2024-02-29',priceTotalCents:18100,transferredShares:55,correctedAt:'2024-03-02T08:00:00.000Z',reason:'synthetic same-day valuation replacement; retain original record',sourceDataSha256:'a'.repeat(64),authorizationRef:'synthetic owner approval of one-share pricing correction'});
test('append-only price correction restores exact-point valuation with original records and all prior points intact',()=>{
 const input=priceCorrectionFixture(),old=structuredClone(input),before=core.calculate(input);assert.equal(before.status,'partial');input.profile.shareTransferPriceCorrections=[priceCorrection()];const actual=core.calculate(input);
 assert.equal(actual.status,'ready');assert.deepEqual(actual.current.investors.map(i=>i.shares),[655,345]);assert.deepEqual(core.registeredShares(input.profile),[655,345]);assert.equal(actual.current.investors.reduce((s,i)=>s+i.shares,0),1000);
 assert.deepEqual(input.profile.shareTransfers,old.profile.shareTransfers);assert.deepEqual(input.payments,old.payments);assert.deepEqual(input.data,old.data);assert.deepEqual(input.feeView,old.feeView);assert.deepEqual(actual.points.slice(0,-1),before.points);
 assert.equal(actual.current.investors.reduce((s,i)=>s+i.valueCents,0),actual.current.totalCents);
});
test('pricing correction binds one original transfer, approved evidence and exact integer arithmetic',()=>{
 for(const mutate of [c=>c.transferId='missing-transfer',c=>c.originalPriceTotalCents++,c=>c.originalTransferredShares++,c=>c.originalPriceDate='2024-02-28',c=>c.priceDate='2024-02-28',c=>c.transferredShares++,c=>c.authorizationRef='',c=>c.sourceDataSha256='bad',c=>c.correctedAt='2024-02-28T08:00:00.000Z',c=>c.feeAmountCents=2500]){
 const input=priceCorrectionFixture(),c=priceCorrection();mutate(c);input.profile.shareTransferPriceCorrections=[c];assert.equal(core.validateProfile(input.profile).ok,false);assert.equal(core.calculate(input).status,'pending');
 }
 const input=priceCorrectionFixture();input.profile.shareTransferPriceCorrections=[priceCorrection(),{...priceCorrection(),id:'second-correction-synthetic'}];assert.equal(core.validateProfile(input.profile).ok,false);
});
test('corrected math cannot bypass a mismatched valuation point, missing payment or unverified fee receipt',()=>{
 for(const mutate of [x=>x.data.daily[2].webull++,x=>x.payments=[],x=>x.feeView.state='pending']){
 const input=priceCorrectionFixture();input.profile.shareTransferPriceCorrections=[priceCorrection()];mutate(input);assert.notEqual(core.calculate(input).status,'ready');
 }
});

// Local finite in-kind design regression; synthetic data only.
{
const core=createFundInvestorCore();
function fixture(){
 const dates=['2026-10-25','2026-10-26','2026-10-27','2026-10-28'],amounts=[10,20,30,40,50,60,70];
 const flows=amounts.map((amount,i)=>{const sourceTradeId=200+i,tradeId=300+i,holdingId=400+i,businessKey=`sharesight:${sourceTradeId}->${tradeId};holding:${holdingId}`;return {id:'fixture-'+i,date:dates[2],acct:'webull',amount,effective:true,sourceTradeId,tradeId,holdingId,businessKey,reason:'verified external asset transfer '+businessKey};});
 const profile={schema:'fee-console.fund-profile.v1',manager:'Synthetic Manager',fundName:'Synthetic Fund',inceptionDate:dates[0],inceptionNoticeDate:dates[0],currency:'USD',initialShares:1000000,investors:[{id:'A',name:'Synthetic Existing A',shares:900000},{id:'B',name:'Synthetic Existing B',shares:100000}],subscriptions:[{id:'sub-in-kind-20261027',date:dates[2],investorId:'B',grossCents:28000,feeCents:0,netCents:28000,priceDate:dates[2],priceTotalCents:110000,issuedShares:254545,sourceRef:'sharesight:synthetic-group-seven',inKindClose:{sourceKeys:flows.map(f=>f.businessKey)}}]};
 return {profile,data:{daily:dates.map((d,i)=>({d,schwab:500,webull:[500,550,880,880][i]})),flowsAuto:flows},feeView:{state:'verified',start:dates[0],asOf:dates[3],status:{provisional:false},benchmarkInputs:{openingCents:100000,flows:flows.map(f=>({date:f.date,amountCents:Math.round(f.amount*100)}))}}};
}
test('seven verified noncash events issue one closing subscription only to the existing investor ID',()=>{const f=fixture(),r=core.calculate(f);assert.equal(r.status,'ready');assert.equal(r.current.subscription,null);assert.deepEqual(r.current.investors.map(i=>i.shares),[900000,354545]);assert.equal(r.current.grossPnlCents,10000);assert.equal(r.points[2].subscription.netCents,28000);assert.equal(r.points[2].unitValue>0,true);assert.equal(f.profile.investors[0].shares,900000);});
test('Astra same-value independent cash cannot replace one of seven in-kind receipt events',async()=>{
 const {buildFeeCalculationReceipt}=await import('./fee-receipt-core.mjs');
 const {computeFeeStatement}=await import('./fee-engine.mjs');
 const f=fixture(),date='2026-10-27';
 for(const flow of f.data.flowsAuto)flow.id=createHash('sha256').update('external_asset_transfer '+flow.businessKey).digest('hex').slice(0,16);
 for(const point of f.data.daily)if(point.d>=date)point.webull+=10;
 f.data.flowsUnresolved=[];f.data.status={asOf:'2026-10-28',provisional:false,calibrated:false,unresolvedCount:0};
 const economicInput={v:4,settings:{start:'2026-10-25',mgmt:0,carry:20},accounts:[{id:'schwab',opening:500},{id:'webull',opening:500}],months:[{ym:'2026-10',flows:[{id:'synthetic-independent-cash',date,acct:'webull',amount:10,note:''}]}],fees:[]};
 const receipt=buildFeeCalculationReceipt({data:f.data,economicInput});
 assert.equal(receipt.effectiveFlowCount,8);assert.equal(receipt.effectiveFlowNetCents,29000);
 assert.equal(receipt.totals.grossPnlCents,10000);assert.equal(receipt.totals.carryCents,2000);
 f.feeView.benchmarkInputs.flows=computeFeeStatement({daily:f.data.daily,flowsAuto:f.data.flowsAuto,econ:economicInput,asOf:'2026-10-28'}).flows.map(flow=>({date:flow.date,amountCents:Math.round(flow.amount*100)}));
 f.profile.subscriptions[0].priceTotalCents=111000;f.profile.subscriptions[0].issuedShares=252252;
 const result=core.calculate(f);assert.equal(result.status,'partial');assert.equal(result.flowGateDate,date);assert.equal(result.current,null);
});
test('closing pre-contribution price preserves existing-holder same-day gain and adds no cash',()=>{const f=fixture(),r=core.calculate(f);assert.equal(r.points[1].investors[0].valueCents,94500);assert.ok(Math.abs(r.points[2].investors[0].valueCents-99000)<=1);assert.equal(r.points[2].investors.reduce((n,i)=>n+i.valueCents,0),138000);assert.equal(r.current.investors.reduce((n,i)=>n+i.pnlCents,0),10000);assert.equal('cashTransactions' in f.data,false);});
test('manager display name, unknown ID and copied approval-shaped fields cannot stand in for investor identity',()=>{for(const change of [f=>f.profile.subscriptions[0].investorId='ManagerDisplay',f=>f.profile.subscriptions[0].inKindClose.approved=true,f=>f.profile.subscriptions[0].feeCents=1]){const f=fixture();change(f);assert.notEqual(core.calculate(f).status,'ready');}});
test('missing, extra, unresolved, ordinary Buy or wrong-identity source candidates stop at the contribution date',()=>{for(const change of [f=>f.data.flowsAuto.pop(),f=>f.data.flowsAuto.push({...f.data.flowsAuto[0],id:'extra'}),f=>{f.data.flowsUnresolved=[f.data.flowsAuto.pop()];},f=>f.data.flowsAuto[0].effective=false,f=>f.data.flowsAuto[0].reason='noncash transfer comment',f=>f.data.flowsAuto[0].tradeId++,f=>f.data.flowsAuto[0].acct='schwab']){const f=fixture();change(f);const r=core.calculate(f);assert.equal(r.status,'partial');assert.equal(r.flowGateDate,'2026-10-27');assert.equal(r.current,null);}});
test('cost basis, prior-day price and rounded/netted flow mismatch cannot issue closing shares',()=>{for(const change of [f=>f.profile.subscriptions[0].priceTotalCents=105000,f=>f.profile.subscriptions[0].priceDate='2026-10-26',f=>f.feeView.benchmarkInputs.flows[0].amountCents++,f=>f.profile.subscriptions[0].issuedShares++,f=>f.data.flowsAuto[0].amount++,f=>f.profile.subscriptions[0].netCents--]){const f=fixture();change(f);assert.notEqual(core.calculate(f).status,'ready');}});
test('source keys cannot be duplicated or reused as a second contribution',()=>{const f=fixture();f.profile.subscriptions[0].inKindClose.sourceKeys[1]=f.profile.subscriptions[0].inKindClose.sourceKeys[0];assert.equal(core.validateProfile(f.profile).ok,false);const g=fixture();g.profile.subscriptions.push({...g.profile.subscriptions[0],id:'sub-next-day-duplicate',date:'2026-10-28',priceDate:'2026-10-28',sourceRef:'sharesight:synthetic-duplicate'});assert.equal(core.validateProfile(g.profile).ok,false);});
}
