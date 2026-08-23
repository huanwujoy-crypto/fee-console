/**
 * Regression tests for the UI flow de-duplication block in index.html.
 *
 * A single business event can reach effectiveFlows() twice: once as a manager
 * confirmation stored in the private Gist (DB.months[].flows) and once as a
 * back-end verified record in data.json (DAILY.flowsAuto). Confirmations
 * written by v4.4+ carry `src` and de-duplicate by id; older confirmations
 * have no `src` and can only be matched on evidence.
 *
 * 2026-08-22 incident: the 2026-08-20 BRK/B in-kind transfer (+387,550.80 into
 * Webull) was counted twice, turning a +23,082.17 month-to-date gross gain into
 * -364,468.63. These tests pin the fix and the cases it must NOT collapse.
 *
 * The block is extracted from index.html so the page stays a single file.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

const START = "/* flow-dedupe:start";
const END = "/* flow-dedupe:end */";
const from = html.indexOf(START);
const to = html.indexOf(END);
assert.ok(from >= 0 && to > from, "index.html must carry the flow-dedupe block");
assert.equal(html.indexOf(START, from + 1), -1, "the flow-dedupe block must appear once");
const block = html.slice(from, to);

// Same helper the page uses, so the extracted block behaves identically.
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const effectiveFlows = (months, flowsAuto) =>
  new Function("DB", "DAILY", "num", `${block}\nreturn effectiveFlows();`)(
    { months }, { flowsAuto }, num
  );
const sum = flows => Number(flows.reduce((s, f) => s + num(f.amount), 0).toFixed(2));
const month = (ym, flows) => [{ ym, flows }];

const TRANSFER = 387550.80;
const AUTO_BRKB = {
  id: "6f1c9a2b7d4e8503",
  date: "2026-08-20",
  acct: "webull",
  amount: TRANSFER,
  desc: "verified external asset transfer BRK/B 780 from IB-HK (FOP; notification 2026-08-21 HKT)",
  reason: "verified external asset transfer ib-hk-webull-brkb-20260820-780-v1",
  effective: true
};
const legacyBrkb = (over = {}) => ({
  id: "man-1", src: "", date: "2026-08-20", acct: "webull", amount: TRANSFER,
  note: "BRK/B 780 股自 IB-HK 实物转入", ...over
});

test("legacy confirmation without src absorbs the matching verified auto flow", () => {
  const flows = effectiveFlows(month("2026-08", [legacyBrkb()]), [AUTO_BRKB]);
  assert.equal(flows.length, 1);
  assert.equal(sum(flows), TRANSFER);
  assert.equal(flows[0].id, "man-1");
});

test("legacy confirmation with an empty note still matches on date, account and amount", () => {
  const flows = effectiveFlows(month("2026-08", [legacyBrkb({ note: "" })]), [AUTO_BRKB]);
  assert.equal(flows.length, 1);
  assert.equal(sum(flows), TRANSFER);
});

test("the existing src link keeps de-duplicating", () => {
  const linked = legacyBrkb({ id: "man-2", src: AUTO_BRKB.id, note: "" });
  const flows = effectiveFlows(month("2026-08", [linked]), [AUTO_BRKB]);
  assert.equal(flows.length, 1);
  assert.equal(flows[0].id, "man-2");
});

test("a verified auto flow with no confirmation at all still counts once", () => {
  const flows = effectiveFlows([], [AUTO_BRKB]);
  assert.equal(flows.length, 1);
  assert.equal(sum(flows), TRANSFER);
  assert.equal(flows[0].automatic, true);
});

test("month-to-date gross gain is right once the event is counted once", () => {
  const closing = 1105447.13;   // Schwab-HK 599,842.58 + Webull 505,604.55 (2026-08-21)
  const opening = 694814.16;    // 2026-07-31 starting basis
  const once = effectiveFlows(month("2026-08", [legacyBrkb()]), [AUTO_BRKB]);
  assert.equal(Number((closing - opening - sum(once)).toFixed(2)), 23082.17);
  // What the double count produced before the fix, kept as the failure signature.
  assert.equal(Number((closing - opening - TRANSFER * 2).toFixed(2)), -364468.63);
});

test("two genuine same-day, same-account transfers of equal size stay two", () => {
  const manualA = { id: "m-a", src: "", date: "2026-08-20", acct: "schwab", amount: 10000, note: "wire ref 1001" };
  const manualB = { id: "m-b", src: "", date: "2026-08-20", acct: "schwab", amount: 10000, note: "wire ref 1002" };
  const autoA = { id: "auto-a", date: "2026-08-20", acct: "schwab", amount: 10000, desc: "external transfer wire ref 1001", effective: true };
  const autoB = { id: "auto-b", date: "2026-08-20", acct: "schwab", amount: 10000, desc: "external transfer wire ref 1002", effective: true };
  const flows = effectiveFlows(month("2026-08", [manualA, manualB]), [autoA, autoB]);
  assert.equal(flows.length, 2);
  assert.equal(sum(flows), 20000);
});

test("one confirmation cannot swallow two distinct verified flows", () => {
  const autoB = { ...AUTO_BRKB, id: "second-auto" };
  const flows = effectiveFlows(month("2026-08", [legacyBrkb({ note: "" })]), [AUTO_BRKB, autoB]);
  assert.equal(flows.length, 2);
  assert.equal(sum(flows), Number((TRANSFER * 2).toFixed(2)));
});

test("contradicting instrument evidence on the same day is not merged", () => {
  const manual = legacyBrkb({ note: "AAPL 100 股自券商转入" });
  const auto = { ...AUTO_BRKB, desc: "verified external asset transfer BRK/B 780 from IB-HK" };
  const flows = effectiveFlows(month("2026-08", [manual]), [auto]);
  assert.equal(flows.length, 2);
});

test("a legacy wrong account still merges on same-day instrument and quantity evidence", () => {
  const manual = legacyBrkb({ acct: "schwab" });
  const flows = effectiveFlows(month("2026-08", [manual]), [AUTO_BRKB]);
  assert.equal(flows.length, 1);
  assert.equal(sum(flows), TRANSFER);
  assert.equal(flows[0].id, "man-1");
});

test("different accounts without matching instrument and quantity stay separate", () => {
  const manual = legacyBrkb({ acct: "schwab", note: "external cash transfer" });
  const flows = effectiveFlows(month("2026-08", [manual]), [AUTO_BRKB]);
  assert.equal(flows.length, 2);
});

test("a rehashed verified auto record counts once", () => {
  const rehashed = {
    ...AUTO_BRKB,
    id: "rehashed-auto",
    desc: "verified BRK/B 780 transfer from IB-HK into Webull"
  };
  const flows = effectiveFlows([], [AUTO_BRKB, rehashed]);
  assert.equal(flows.length, 1);
  assert.equal(sum(flows), TRANSFER);
});

test("a rehashed verified auto record on the adjacent notification day counts once", () => {
  const notificationDay = {
    ...AUTO_BRKB,
    id: "notification-day-auto",
    date: "2026-08-21",
    desc: "BRK/B 780 shares received from IB-HK"
  };
  const flows = effectiveFlows([], [AUTO_BRKB, notificationDay]);
  assert.equal(flows.length, 1);
  assert.equal(sum(flows), TRANSFER);
});

test("verified auto records with different references remain separate", () => {
  const autoA = { ...AUTO_BRKB, id: "wire-a", amount: 10000, desc: "external wire reference 1001" };
  const autoB = { ...AUTO_BRKB, id: "wire-b", amount: 10000, desc: "external wire reference 1002" };
  const flows = effectiveFlows([], [autoA, autoB]);
  assert.equal(flows.length, 2);
  assert.equal(sum(flows), 20000);
});

test("verified auto records with different instruments remain separate", () => {
  const brkb = { ...AUTO_BRKB, id: "asset-brkb", amount: 10000, desc: "BRK/B 20" };
  const aapl = { ...AUTO_BRKB, id: "asset-aapl", amount: 10000, desc: "AAPL 20" };
  const flows = effectiveFlows([], [brkb, aapl]);
  assert.equal(flows.length, 2);
  assert.equal(sum(flows), 20000);
});

test("a different amount beyond the cent tolerance is never merged", () => {
  const flows = effectiveFlows(month("2026-08", [legacyBrkb({ amount: TRANSFER + 0.02 })]), [AUTO_BRKB]);
  assert.equal(flows.length, 2);
});

test("a sub-cent rounding difference is still the same event", () => {
  const flows = effectiveFlows(month("2026-08", [legacyBrkb({ amount: TRANSFER + 0.004 })]), [AUTO_BRKB]);
  assert.equal(flows.length, 1);
});

test("dates two days apart are never merged", () => {
  const flows = effectiveFlows(month("2026-08", [legacyBrkb({ date: "2026-08-18" })]), [AUTO_BRKB]);
  assert.equal(flows.length, 2);
});

test("an adjacent-day confirmation merges only on shared evidence", () => {
  const withEvidence = effectiveFlows(month("2026-08", [legacyBrkb({ date: "2026-08-21" })]), [AUTO_BRKB]);
  assert.equal(withEvidence.length, 1, "notification-date booking of the same transfer");
  const withoutEvidence = effectiveFlows(
    month("2026-08", [legacyBrkb({ date: "2026-08-21", note: "" })]), [AUTO_BRKB]
  );
  assert.equal(withoutEvidence.length, 2, "no evidence across days stays two events");
});

test("non-effective auto records never reach the calculation", () => {
  const pending = { ...AUTO_BRKB, id: "pending", effective: false };
  const flows = effectiveFlows([], [pending]);
  assert.equal(flows.length, 0);
});

test("unrelated confirmations in the same month are untouched", () => {
  const other = { id: "m-x", src: "", date: "2026-08-05", acct: "schwab", amount: 2500, note: "现金转入" };
  const flows = effectiveFlows(month("2026-08", [other, legacyBrkb()]), [AUTO_BRKB]);
  assert.equal(flows.length, 2);
  assert.equal(sum(flows), Number((TRANSFER + 2500).toFixed(2)));
});

/* ---------------------------------------------------------------------------
 * 2026-08-22 hardening: identifying a flow by its event means the account field
 * is no longer part of the key, so the pairing runs in two rounds (same account
 * first, then across accounts) and the cross-account round demands positive
 * evidence. These 20 cases pin that contract from both sides: what must still
 * collapse, and what must never collapse.
 * ------------------------------------------------------------------------- */

const autoAt = over => ({ ...AUTO_BRKB, ...over });

test("a legacy wrong account still merges on same-day instrument and quantity evidence", () => {
  const flows = effectiveFlows(month("2026-08", [legacyBrkb({ acct: "schwab" })]), [AUTO_BRKB]);
  assert.equal(flows.length, 1);
  assert.equal(sum(flows), TRANSFER);
});

test("crossing accounts without any evidence never merges, even on the same day", () => {
  const manual = legacyBrkb({ acct: "schwab", note: "现金转入" });
  const flows = effectiveFlows(month("2026-08", [manual]), [autoAt({ desc: "external cash transfer" })]);
  assert.equal(flows.length, 2);
  assert.equal(sum(flows), Number((TRANSFER * 2).toFixed(2)));
});

test("crossing accounts merges on a shared quantity alone", () => {
  const manual = legacyBrkb({ acct: "schwab", note: "实物转入 780" });
  const flows = effectiveFlows(month("2026-08", [manual]), [autoAt({ desc: "verified transfer 780 units" })]);
  assert.equal(flows.length, 1);
});

test("crossing accounts merges on a shared instrument alone", () => {
  const manual = legacyBrkb({ acct: "schwab", note: "BRKB 实物转入" });
  const flows = effectiveFlows(month("2026-08", [manual]), [autoAt({ desc: "verified transfer BRKB in kind" })]);
  assert.equal(flows.length, 1);
});

test("a shared instrument with a contradicting quantity is a conflict, not a match", () => {
  const manual = legacyBrkb({ acct: "schwab", note: "BRK/B 500 股自 IB-HK 实物转入" });
  const flows = effectiveFlows(month("2026-08", [manual]), [AUTO_BRKB]);
  assert.equal(flows.length, 2);
});

test("crossing accounts on the adjacent day still merges when the evidence matches", () => {
  const manual = legacyBrkb({ acct: "schwab", date: "2026-08-21" });
  const flows = effectiveFlows(month("2026-08", [manual]), [AUTO_BRKB]);
  assert.equal(flows.length, 1);
});

test("crossing accounts on the adjacent day without evidence stays two", () => {
  const manual = legacyBrkb({ acct: "schwab", date: "2026-08-21", note: "" });
  const flows = effectiveFlows(month("2026-08", [manual]), [AUTO_BRKB]);
  assert.equal(flows.length, 2);
});

test("the same-account candidate is consumed before the cross-account one", () => {
  const right = legacyBrkb({ id: "m-right", acct: "webull" });
  const wrong = legacyBrkb({ id: "m-wrong", acct: "schwab" });
  const flows = effectiveFlows(month("2026-08", [wrong, right]), [AUTO_BRKB]);
  assert.equal(flows.length, 2, "one auto can only retire one confirmation");
  assert.deepEqual(flows.map(f => f.id).sort(), ["m-right", "m-wrong"]);
});

test("the same business event rehashed into two auto records counts once", () => {
  const rehashed = autoAt({ id: "rehashed-same-event" });
  const flows = effectiveFlows([], [AUTO_BRKB, rehashed]);
  assert.equal(flows.length, 1);
  assert.equal(sum(flows), TRANSFER);
});

test("two auto records with contradicting evidence are two events", () => {
  const other = autoAt({ id: "auto-aapl", desc: "verified external asset transfer AAPL 100 from IB-HK" });
  const flows = effectiveFlows([], [AUTO_BRKB, other]);
  assert.equal(flows.length, 2);
});

test("auto-to-auto collapsing does not swallow a genuine third event", () => {
  const rehashed = autoAt({ id: "rehashed" });
  const genuine = autoAt({ id: "genuine-second", acct: "schwab", desc: "verified external asset transfer AAPL 100" });
  const flows = effectiveFlows([], [AUTO_BRKB, rehashed, genuine]);
  assert.equal(flows.length, 2);
  assert.equal(sum(flows), Number((TRANSFER * 2).toFixed(2)));
});

test("an explicit src link wins even when the account disagrees", () => {
  const linked = legacyBrkb({ id: "m-src", src: AUTO_BRKB.id, acct: "schwab", note: "" });
  const flows = effectiveFlows(month("2026-08", [linked]), [AUTO_BRKB]);
  assert.equal(flows.length, 1);
  assert.equal(flows[0].id, "m-src");
});

test("an explicit src link wins even when the amount disagrees", () => {
  const linked = legacyBrkb({ id: "m-src2", src: AUTO_BRKB.id, amount: TRANSFER - 1000 });
  const flows = effectiveFlows(month("2026-08", [linked]), [AUTO_BRKB]);
  assert.equal(flows.length, 1);
  assert.equal(sum(flows), Number((TRANSFER - 1000).toFixed(2)));
});

test("a src pointing at a record that is not in the feed still counts once", () => {
  const orphan = legacyBrkb({ id: "m-orphan", src: "no-such-auto-id" });
  const flows = effectiveFlows(month("2026-08", [orphan]), []);
  assert.equal(flows.length, 1);
  assert.equal(sum(flows), TRANSFER);
});

test("the cent tolerance is exclusive at its boundary", () => {
  const inside = effectiveFlows(month("2026-08", [legacyBrkb({ amount: TRANSFER + 0.004 })]), [AUTO_BRKB]);
  const outside = effectiveFlows(month("2026-08", [legacyBrkb({ amount: TRANSFER + 0.006 })]), [AUTO_BRKB]);
  assert.equal(inside.length, 1);
  assert.equal(outside.length, 2);
});

test("outbound flows de-duplicate the same way inbound ones do", () => {
  const manual = { id: "m-out", src: "", date: "2026-08-20", acct: "webull", amount: -50000, note: "提现 50000" };
  const auto = { id: "a-out", date: "2026-08-20", acct: "webull", amount: -50000, desc: "verified outbound wire 50000", effective: true };
  const flows = effectiveFlows(month("2026-08", [manual]), [auto]);
  assert.equal(flows.length, 1);
  assert.equal(sum(flows), -50000);
});

test("an inflow and an outflow of the same size are never the same event", () => {
  const manual = { id: "m-in", src: "", date: "2026-08-20", acct: "webull", amount: 50000, note: "入金" };
  const auto = { id: "a-out", date: "2026-08-20", acct: "webull", amount: -50000, desc: "outbound", effective: true };
  const flows = effectiveFlows(month("2026-08", [manual]), [auto]);
  assert.equal(flows.length, 2);
  assert.equal(sum(flows), 0);
});

test("a malformed date never merges and never throws", () => {
  const manual = legacyBrkb({ date: "not-a-date" });
  const flows = effectiveFlows(month("2026-08", [manual]), [AUTO_BRKB]);
  assert.equal(flows.length, 2);
});

test("stop-word-only notes on the same account still merge", () => {
  const manual = legacyBrkb({ note: "cash transfer" });
  const flows = effectiveFlows(month("2026-08", [manual]), [autoAt({ desc: "external transfer" })]);
  assert.equal(flows.length, 1);
});

test("a month of mixed events keeps every distinct one exactly once", () => {
  const manuals = [
    legacyBrkb({ id: "m-brkb", acct: "schwab" }),
    { id: "m-cash", src: "", date: "2026-08-05", acct: "schwab", amount: 2500, note: "现金转入" }
  ];
  const autos = [
    AUTO_BRKB,
    { id: "auto-wire", date: "2026-08-12", acct: "webull", amount: 7500, desc: "verified inbound wire 7500", effective: true },
    { id: "auto-pending", date: "2026-08-13", acct: "webull", amount: 999, desc: "not verified", effective: false }
  ];
  const flows = effectiveFlows(month("2026-08", manuals), autos);
  assert.equal(flows.length, 3, "BRK/B once, the 2,500 cash-in, and the 7,500 wire");
  assert.equal(sum(flows), Number((TRANSFER + 2500 + 7500).toFixed(2)));
});
