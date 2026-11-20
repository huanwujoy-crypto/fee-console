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
import { createHash } from "node:crypto";
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
  const autoA = { id: "auto-a", date: "2026-08-20", acct: "schwab", amount: 10000, desc: "external transfer wire ref 1001", reason: "verified external asset transfer wire-1001", effective: true };
  const autoB = { id: "auto-b", date: "2026-08-20", acct: "schwab", amount: 10000, desc: "external transfer wire ref 1002", reason: "verified external asset transfer wire-1002", effective: true };
  const flows = effectiveFlows(month("2026-08", [manualA, manualB]), [autoA, autoB]);
  assert.equal(flows.length, 2);
  assert.equal(sum(flows), 20000);
});

test("one confirmation cannot swallow two distinct verified flows", () => {
  const autoB = { ...AUTO_BRKB, id: "second-auto", reason: "verified external asset transfer ib-hk-webull-brkb-20260820-780-second" };
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
  const autoA = { ...AUTO_BRKB, id: "wire-a", amount: 10000, desc: "external wire reference 1001", reason: "verified external asset transfer wire-1001" };
  const autoB = { ...AUTO_BRKB, id: "wire-b", amount: 10000, desc: "external wire reference 1002", reason: "verified external asset transfer wire-1002" };
  const flows = effectiveFlows([], [autoA, autoB]);
  assert.equal(flows.length, 2);
  assert.equal(sum(flows), 20000);
});

test("verified auto records with different instruments remain separate", () => {
  const brkb = { ...AUTO_BRKB, id: "asset-brkb", amount: 10000, desc: "BRK/B 20", reason: "verified external asset transfer ib-webull-brkb-20" };
  const aapl = { ...AUTO_BRKB, id: "asset-aapl", amount: 10000, desc: "AAPL 20", reason: "verified external asset transfer ib-webull-aapl-20" };
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
 * evidence. Same `reason` (it embeds the stable externalRef) is one event;
 * a different `reason` is two, whatever the descriptions happen to say.
 * ------------------------------------------------------------------------- */

const autoAt = over => ({ ...AUTO_BRKB, ...over });

test("a wrong-account legacy confirmation still nets to a single transfer", () => {
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
  const rehashed = autoAt({ id: "rehashed-same-event" });   // 同一 reason = 同一业务事件
  const flows = effectiveFlows([], [AUTO_BRKB, rehashed]);
  assert.equal(flows.length, 1);
  assert.equal(sum(flows), TRANSFER);
});

test("two auto records with contradicting evidence are two events", () => {
  const other = autoAt({ id: "auto-aapl", desc: "verified external asset transfer AAPL 100 from IB-HK", reason: "verified external asset transfer ib-hk-webull-aapl-20260820-100" });
  const flows = effectiveFlows([], [AUTO_BRKB, other]);
  assert.equal(flows.length, 2);
});

test("auto-to-auto collapsing does not swallow a genuine third event", () => {
  const rehashed = autoAt({ id: "rehashed" });               // 同一 reason = 同一业务事件
  const genuine = autoAt({ id: "genuine-second", acct: "schwab", desc: "verified external asset transfer AAPL 100", reason: "verified external asset transfer ib-schwab-aapl-20260820-100" });
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
    { id: "auto-wire", date: "2026-08-12", acct: "webull", amount: 7500, desc: "verified inbound wire 7500", reason: "verified external asset transfer wire-20260812-7500", effective: true },
    { id: "auto-pending", date: "2026-08-13", acct: "webull", amount: 999, desc: "not verified", effective: false }
  ];
  const flows = effectiveFlows(month("2026-08", manuals), autos);
  assert.equal(flows.length, 3, "BRK/B once, the 2,500 cash-in, and the 7,500 wire");
  assert.equal(sum(flows), Number((TRANSFER + 2500 + 7500).toFixed(2)));
});

/* ---------------------------------------------------------------------------
 * 2026-08-23: the residual double count. `effectiveFlows` used to drop an auto
 * record the moment a confirmation absorbed it, so a second copy of the SAME
 * business event had nothing left to compare against and was counted again —
 * the shape of the 2026-08-20 incident, one layer deeper.
 *
 * Identity now comes from `reason`, which carries the stable externalRef
 * (scripts/daily-core.mjs classifyFlow builds it for every effective record).
 * `id` is a hash over date|acct|amount|foreignIdentifier|desc, so the same
 * event re-hashed after a description change gives two ids and one reason,
 * while two different transfers always give two reasons. These cases pin that,
 * and pin that records with no reason keep the pre-existing behaviour exactly.
 * ------------------------------------------------------------------------- */

const REF = "ib-hk-webull-brkb-20260820-780-v1";
const withReason = (over = {}) => ({ ...AUTO_BRKB, reason: `verified external asset transfer ${REF}`, ...over });
const noReason = (over = {}) => {
  const rec = { ...AUTO_BRKB, ...over };
  delete rec.reason;
  return rec;
};

test("a confirmation plus two copies of one event counts the event once", () => {
  const copy = withReason({ id: "rehash-b", desc: "BRK/B 780 received from IB-HK" });
  const flows = effectiveFlows(month("2026-08", [legacyBrkb()]), [withReason(), copy]);
  assert.equal(flows.length, 1, "the confirmation absorbs the event; the copy is not a second one");
  assert.equal(sum(flows), TRANSFER);
});

test("an src-linked confirmation plus two copies of one event counts the event once", () => {
  const linked = legacyBrkb({ id: "man-src", src: AUTO_BRKB.id, note: "" });
  const copy = withReason({ id: "rehash-c", desc: "BRK/B 780 received from IB-HK" });
  const flows = effectiveFlows(month("2026-08", [linked]), [withReason(), copy]);
  assert.equal(flows.length, 1);
  assert.equal(sum(flows), TRANSFER);
});

test("three copies of one event still count once", () => {
  const flows = effectiveFlows([], [
    withReason({ id: "c1" }),
    withReason({ id: "c2", desc: "BRK/B 780 in kind" }),
    withReason({ id: "c3", date: "2026-08-21", desc: "BRK/B 780 received" })
  ]);
  assert.equal(flows.length, 1);
  assert.equal(sum(flows), TRANSFER);
});

test("two references stay two events even when the descriptions are identical", () => {
  const a = withReason({ id: "ref-a", amount: 10000, reason: "verified external asset transfer wire-A" });
  const b = withReason({ id: "ref-b", amount: 10000, reason: "verified external asset transfer wire-B" });
  const flows = effectiveFlows([], [a, b]);
  assert.equal(flows.length, 2, "identical descriptions must not merge two different references");
  assert.equal(sum(flows), 20000);
});

test("a confirmation cannot hide a second reference behind an identical description", () => {
  const a = withReason({ id: "ref-a", amount: 10000, reason: "verified external asset transfer wire-A" });
  const b = withReason({ id: "ref-b", amount: 10000, reason: "verified external asset transfer wire-B" });
  const manual = { id: "man-w", src: "", date: "2026-08-20", acct: "webull", amount: 10000, note: "" };
  const flows = effectiveFlows(month("2026-08", [manual]), [a, b]);
  assert.equal(flows.length, 2);
  assert.equal(sum(flows), 20000);
});

test("two references in two accounts stay two events", () => {
  const a = withReason({ id: "acct-a", acct: "schwab", amount: 10000, reason: "verified external asset transfer ref-S" });
  const b = withReason({ id: "acct-b", acct: "webull", amount: 10000, reason: "verified external asset transfer ref-W" });
  const flows = effectiveFlows([], [a, b]);
  assert.equal(flows.length, 2);
  assert.equal(sum(flows), 20000);
});

test("a pending copy of an effective event never adds a second count", () => {
  const pending = withReason({ id: "pending-copy", effective: false });
  assert.equal(effectiveFlows([], [withReason(), pending]).length, 1);
  assert.equal(effectiveFlows([], [pending, withReason()]).length, 1);
  assert.equal(effectiveFlows([], [pending]).length, 0);
});

test("records with no reason keep the previous behaviour when a confirmation covers one", () => {
  const manual = { id: "man-n", src: "", date: "2026-08-20", acct: "webull", amount: 10000, note: "" };
  const a = noReason({ id: "nr-a", amount: 10000, desc: "" });
  const b = noReason({ id: "nr-b", amount: 10000, desc: "" });
  const flows = effectiveFlows(month("2026-08", [manual]), [a, b]);
  assert.equal(flows.length, 2, "the confirmation retires one; the other is still its own event");
  assert.equal(sum(flows), 20000);
});

test("records with no reason still collapse against what was already kept", () => {
  const a = noReason({ id: "nr-a", amount: 10000, desc: "" });
  const b = noReason({ id: "nr-b", amount: 10000, desc: "" });
  const flows = effectiveFlows([], [a, b]);
  assert.equal(flows.length, 1, "unchanged from before the reason key existed");
});

test("an empty reason string is treated as no reason at all", () => {
  const a = withReason({ id: "blank-a", amount: 10000, reason: "   ", desc: "wire 1001" });
  const b = withReason({ id: "blank-b", amount: 10000, reason: "", desc: "wire 1002" });
  const flows = effectiveFlows([], [a, b]);
  assert.equal(flows.length, 2, "distinct descriptions still separate them under the fallback");
});

test("the surviving flow carries its reason forward", () => {
  const flows = effectiveFlows([], [withReason()]);
  assert.equal(flows.length, 1);
  assert.equal(flows[0].reason, `verified external asset transfer ${REF}`);
});

test("a mixed month with copies, references and a confirmation stays whole", () => {
  const manual = legacyBrkb({ id: "m-brkb" });
  const autos = [
    withReason({ id: "brkb-1" }),
    withReason({ id: "brkb-2", desc: "BRK/B 780 received from IB-HK" }),
    withReason({ id: "wire-1", date: "2026-08-12", amount: 7500, desc: "inbound wire", reason: "verified external asset transfer wire-0812" }),
    withReason({ id: "wire-2", date: "2026-08-12", amount: 7500, desc: "inbound wire", reason: "verified external asset transfer wire-0812-second" }),
    withReason({ id: "later", date: "2026-08-13", amount: 999, effective: false, reason: "verified external asset transfer pending" })
  ];
  const flows = effectiveFlows(month("2026-08", [manual]), autos);
  assert.equal(flows.length, 3, "BRK/B once, and the two same-day wires separately");
  assert.equal(sum(flows), Number((TRANSFER + 7500 + 7500).toFixed(2)));
});


// Source asset-type allocation is display metadata. Exercise the exact page
// region with synthetic values, independently of the fee/flow engines above.
const assetStart = "/* asset-allocation-view:start */";
const assetEnd = "/* asset-allocation-view:end */";
// Exact reviewed new block runs in both deployment stages. The old page
// remains pinned as the old contract; it is never claimed to render this UI.
const reviewedAssetBlock = "\n// Reporting only. Never reinterpret the legacy `stock` total as ordinary shares\n// or feed this projection into NAV, returns, cash flows or fee calculations.\nfunction assetAllocationProjection(lp){\n  if(!lp||!Object.hasOwn(lp,\"assetAllocation\"))return {state:\"legacy\"};\n  const value=lp.assetAllocation,keys=[\"equity\",\"etf\",\"bond\",\"cash\",\"gold\",\"other\",\"unclassified\"];\n  const expected=[\"schemaVersion\",\"mode\",...keys].sort().join(\",\");\n  if(!value||typeof value!==\"object\"||Array.isArray(value)\n    ||Object.keys(value).sort().join(\",\")!==expected||value.schemaVersion!==1||value.mode!==\"sharesight-asset-type-v1\"\n    ||!Number.isFinite(lp.stock)||lp.stock<0||keys.some(k=>!Number.isFinite(value[k])||value[k]<0)\n    ||Math.abs(keys.reduce((sum,k)=>sum+value[k],0)-lp.stock)>1)return {state:\"unavailable\"};\n  return {state:\"ready\",value};\n}\nfunction assetMixView(lp,nav){\n  if(!lp||(lp.cash==null&&lp.stock==null&&lp.other==null))return \"\";\n  const mixV={cash:num(lp.cash),stock:num(lp.stock),other:num(lp.other)};\n  const mixSum=mixV.cash+mixV.stock+mixV.other,allocation=assetAllocationProjection(lp);\n  const cell=(label,value)=>`<div><div class=\"k\">${label}</div><div class=\"v\">${usd(value,0)}<span class=\"p\">${nav>0?(value/nav*100).toFixed(0)+\"%\":\"—\"}</span></div></div>`;\n  let cells,note=\"\";\n  if(allocation.state===\"ready\"){\n    const a=allocation.value;\n    cells=cell(\"现金及其它\",mixV.cash+mixV.other+a.cash)+cell(\"股票\",a.equity);\n    for(const [key,label] of [[\"etf\",\"ETF\"],[\"bond\",\"债券\"],[\"gold\",\"黄金\"],[\"other\",\"其他证券\"],[\"unclassified\",\"待分类证券\"]])\n      if(a[key]>0)cells+=cell(label,a[key]);\n    if(a.unclassified>0)note=\"待分类证券已计入总资产；仅证券类型待确认，不改变资金流或费用计算口径。\";\n  }else if(allocation.state===\"unavailable\"){\n    // Never fall back to stale growth/value fields when new metadata is invalid.\n    cells=cell(\"现金及其它\",mixV.cash+mixV.other)+cell(\"证券（分类待核实）\",mixV.stock);\n    note=\"证券类型拆分暂不可用；不替代总资产与费用回执核验。\";\n  }else{\n    const growth=lp.growth,value=lp.value,gold=lp.gold==null?0:Number(lp.gold);\n    const ready=growth!=null&&value!=null&&Number.isFinite(Number(growth))&&Number.isFinite(Number(value))\n      &&Number(growth)>=0&&Number(value)>=0&&Number.isFinite(gold)&&gold>=0\n      &&Math.abs(Number(growth)+Number(value)+gold-mixV.stock)<=1;\n    cells=cell(\"现金及其它\",mixV.cash+mixV.other)+(ready?cell(\"历史成长/价值合计\",Number(growth)+Number(value))+(gold>0?cell(\"黄金\",gold):\"\"):cell(\"证券（未拆分）\",mixV.stock));\n    note=ready?\"历史分类原样保留；成长/价值合计不等同于按 Sharesight 类型确认的个股。\":\"尚无经核实的证券类型拆分\";\n  }\n  return `<div class=\"mix two\">${cells}</div>${note?`<div class=\"note\">${note}</div>`:\"\"}${Math.abs(mixSum-nav)>1?`<div class=\"note\">拆分合计 ${usd(mixSum,0)}，与总资产相差 ${usd(mixSum-nav,0)}</div>`:\"\"}`;\n}\n";
const pageSha = page => createHash("sha256").update(page).digest("hex");
function assetBlockForReviewedStage(page) {
  const digest=pageSha(page);
  if(digest==="eada672f9928fcb20dc4ab5b98a6b000a8a73dc5ce66edfbddfba0663b722c3c"){
    assert.equal(page.includes(assetStart),false);
    assert.equal(page.includes(assetEnd),false);
    return reviewedAssetBlock;
  }
  // Owner decision 2026-11-17: no per-page hash list. The block boundaries asserted below are the check.
  assert.equal(page.split(assetStart).length,2);
  assert.equal(page.split(assetEnd).length,2);
  const actual=page.split(assetStart)[1].split(assetEnd)[0];
  assert.equal(actual,reviewedAssetBlock,"live new block must equal the reviewed fixture");
  return actual;
}
const assetBlock=assetBlockForReviewedStage(html);
test("asset allocation staged fixture rejects unreviewed page bytes",()=>{
  assert.equal(pageSha(reviewedAssetBlock),"282a469dbb8fdc3a9c748ce2c8303b629f992078d5fce8decac498fb609f95ea");
});
const { assetAllocationProjection, assetMixView } = new Function("num", "usd",
  `${assetBlock}\nreturn {assetAllocationProjection,assetMixView};`)(num, value => `$${value}`);
const assetPoint = overrides => ({
  d:"2026-10-29", cash:10, other:5, stock:100,
  assetAllocation:{schemaVersion:1,mode:"sharesight-asset-type-v1",
    equity:40,etf:20,bond:10,cash:5,gold:10,other:10,unclassified:5}, ...overrides
});

test("asset-type view renders ordinary shares as stocks, never all securities", () => {
  const point=assetPoint(), before=JSON.stringify(point);
  const view=assetMixView(point,115);
  assert.match(view,/股票<\/div><div class="v">\$40/);
  assert.match(view,/ETF<\/div><div class="v">\$20/);
  assert.match(view,/债券<\/div><div class="v">\$10/);
  assert.match(view,/黄金<\/div><div class="v">\$10/);
  assert.match(view,/其他证券<\/div><div class="v">\$10/);
  assert.match(view,/待分类证券<\/div><div class="v">\$5/);
  assert.match(view,/现金及其它<\/div><div class="v">\$20/);
  assert.doesNotMatch(view,/成长股|价值股|股票<\/div><div class="v">\$100/);
  assert.equal(JSON.stringify(point),before,"rendering must not mutate daily data");
});

test("asset-type projection takes precedence over stale legacy styles", () => {
  const point=assetPoint({growth:100,value:0,gold:999});
  assert.equal(assetAllocationProjection(point).state,"ready");
  const view=assetMixView(point,115);
  assert.doesNotMatch(view,/历史成长|\$999|\$100/);
  assert.match(view,/股票<\/div><div class="v">\$40/);
});

test("legacy styles remain read-only merged history, not source-verified stocks", () => {
  const point={cash:10,other:5,stock:100,growth:60,value:30,gold:10};
  const before=JSON.stringify(point),view=assetMixView(point,115);
  assert.equal(assetAllocationProjection(point).state,"legacy");
  assert.match(view,/历史成长\/价值合计<\/div><div class="v">\$90/);
  assert.match(view,/黄金<\/div><div class="v">\$10/);
  assert.doesNotMatch(view,/股票<\/div>/);
  assert.equal(JSON.stringify(point),before);
});

test("missing source types retain the complete unclassified value and NAV denominator", () => {
  const point=assetPoint();
  for(const key of ["equity","etf","bond","cash","gold","other"])point.assetAllocation[key]=0;
  point.assetAllocation.unclassified=100;
  const view=assetMixView(point,115);
  assert.match(view,/股票<\/div><div class="v">\$0/);
  assert.match(view,/待分类证券<\/div><div class="v">\$100<span class="p">87%/);
  assert.match(view,/已计入总资产/);
});

test("malformed new allocation is disclosed, never coerced or replaced by legacy fields", () => {
  const invalid=[null,[],{}, {...assetPoint().assetAllocation,mode:"other"},
    {...assetPoint().assetAllocation,schemaVersion:2},
    {...assetPoint().assetAllocation,extra:0}];
  for(const bad of ["40","",null,NaN,Infinity,-1])invalid.push({...assetPoint().assetAllocation,equity:bad});
  invalid.push({...assetPoint().assetAllocation,equity:42});
  for(const allocation of invalid){
    const point=assetPoint({assetAllocation:allocation,growth:100,value:0});
    assert.equal(assetAllocationProjection(point).state,"unavailable");
    const view=assetMixView(point,115);
    assert.match(view,/证券（分类待核实）<\/div><div class="v">\$100/);
    assert.match(view,/证券类型拆分暂不可用/);
    assert.doesNotMatch(view,/历史成长|股票<\/div>/);
  }
  const point=assetPoint({stock:"100"});
  assert.equal(assetAllocationProjection(point).state,"unavailable");
});

test("asset-allocation UI respects the existing one-dollar total tolerance", () => {
  const point=assetPoint();point.assetAllocation.equity=41;
  assert.equal(assetAllocationProjection(point).state,"ready");
  point.assetAllocation.equity=41.01;
  assert.equal(assetAllocationProjection(point).state,"unavailable");
});

const reviewedHealthBlock="function health(feeView,st){\n  if(feeView.state===\"loading\")return {hold:true,holdReasons:[],loading:true};\n  const hold=[];\n  if(feeView.state!==\"verified\")hold.push(feeView.message);\n  const unresolved=(DAILY.flowsUnresolved||[]).length;\n  const lp=st.lastPt;\n  if(!lp)hold.push(\"尚无每日数据\");\n  else{\n    const age=Math.round((Date.parse(todayStr()+\"T00:00:00Z\")-Date.parse(lp.d+\"T00:00:00Z\"))/86400000);\n    if(age>10)hold.push(\"每日数据已停更 \"+age+\" 天（最新 \"+lp.d+\"）\");\n    const ms=num(lp.cash)+num(lp.stock)+num(lp.other);\n    if(ms>0&&Math.abs(ms-st.nav)>st.nav*0.02)hold.push(\"资产拆分与账户总额相差过大\");\n    // Asset types are report metadata, not an additional payable-fee gate.\n    // Keep the legacy validation for old points only; malformed new metadata\n    // is disclosed in the allocation card without hiding verified fee inputs.\n    if(!Object.hasOwn(lp,\"assetAllocation\")){\n      const styleFields=[lp.growth,lp.value].filter(v=>v!=null&&v!==\"\");\n      const gold=lp.gold==null?0:Number(lp.gold);\n      if(!Number.isFinite(gold)||gold<0||(lp.gold!=null&&styleFields.length!==2))hold.push(\"黄金分类金额无效或证券分类不完整\");\n      if(styleFields.length===1)hold.push(\"历史成长 / 价值拆分只有一项，暂按证券未拆分显示\");\n      else if(styleFields.length===2&&Math.abs(num(lp.growth)+num(lp.value)+gold-num(lp.stock))>1)\n        hold.push(\"历史成长 + 价值 + 黄金与证券总额不一致，暂按证券未拆分显示\");\n    }\n  }\n  if(unresolved>0)hold.push(unresolved+\" 笔资金变动尚未判定内部交易或外部出入金\");\n  return {hold:hold.length>0,holdReasons:hold};}\n";
const actualHealthBlock=html.slice(html.indexOf("function health(feeView,st){"),html.indexOf("/* ============ 渲染 ============ */"));
const oldPageStage=pageSha(html)==="eada672f9928fcb20dc4ab5b98a6b000a8a73dc5ce66edfbddfba0663b722c3c";
if(!oldPageStage)assert.equal(actualHealthBlock,reviewedHealthBlock);
const healthBlock=oldPageStage?reviewedHealthBlock:actualHealthBlock;
test("old page remains explicitly legacy during support-only deployment",()=>{
  if(oldPageStage){
    const oldHealth=new Function("DAILY","num","todayStr",`${actualHealthBlock}\nreturn health(arguments[3],arguments[4]);`);
    assert.equal(oldHealth({flowsUnresolved:[]},num,()=>"2026-10-29",{state:"verified"},{lastPt:assetPoint({growth:100}),nav:115}).hold,true);
  }else assert.equal(actualHealthBlock,reviewedHealthBlock);
});
const uiHealth=(point,{verified=true,unresolved=[]}={})=>new Function("DAILY","num","todayStr",
  `${healthBlock}\nreturn health(arguments[3],arguments[4]);`)({flowsUnresolved:unresolved},num,()=>"2026-10-29",
    {state:verified?"verified":"unavailable",message:"receipt unverified"},{lastPt:point,nav:115});

test("new type metadata does not reintroduce growth/value fee holds", () => {
  assert.equal(uiHealth(assetPoint({growth:100})).hold,false);
  assert.equal(uiHealth(assetPoint({assetAllocation:null,growth:100})).hold,false);
  assert.equal(uiHealth(assetPoint(),{verified:false}).hold,true,"receipt gate remains");
  assert.equal(uiHealth(assetPoint(),{unresolved:[{}]}).hold,true,"external flow gate remains");
  assert.equal(uiHealth(assetPoint({stock:200})).hold,true,"NAV consistency gate remains");
  assert.equal(uiHealth({d:"2026-10-29",cash:10,other:5,stock:100,growth:100}).hold,true,"legacy behavior remains");
});

test("overview jump chips point at existing sections and never touch the address fragment", () => {
  const nav = html.match(/<nav class="home-jump"[^>]*>([\s\S]*?)<\/nav>/);
  assert.ok(nav, "the overview has its jump row");
  const targets = [...nav[1].matchAll(/<button type="button" data-jump="([\w-]+)"(?: aria-current="true")?>([^<]+)<\/button>/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(targets, [["kpis", "总览"], ["returnsCard", "收益"], ["trendDetails", "走势"], ["monthsBox", "月度"], ["balBox", "应付"]]);
  // The returns card is written by both the verified and the pending branch of one template.
  for (const [id] of targets) assert.equal(html.split(`id="${id}"`).length, id === "returnsCard" ? 3 : 2, id);
  assert.match(html, /<button data-p="p-home" class="on">管理人<\/button>/);
  assert.match(html, /id="ratioTab" hidden>资产配置<\/button>/);
  // The lit chip follows the scroll position; it reads layout only and never navigates.
  const spy = html.slice(html.indexOf("function syncJumpChips(){"), html.indexOf("/* ratio-presentation:v1:end */"));
  assert.match(spy, /aria-current/);
  // The risk card sits below the returns card, so its chip is added after 收益 and the spy picks by position, not chip order.
  assert.match(spy, /top<=line&&top>=best/);
  // The risk card offers one gain preset beside the loss presets.
  assert.match(html, /\[-10,-20,-30,-50,10,0\]\.map\(v=>`<button type="button" data-risk-shock="\$\{v\}">\$\{v===0\?"复位":\(v>0\?"\+":""\)\+v\+"%"\}/);
  assert.match(html, /chip\.textContent="风险";jump\.querySelector\('\[data-jump="trendDetails"\]'\)\?\.before\(chip\)/);
  assert.doesNotMatch(spy, /location|history\.|\.hash/);
  // Changing tab starts the new tab at its top instead of at the previous tab's scroll position.
  assert.match(html, /s\.id===b\.dataset\.p\)\);globalThis\.scrollTo\?\.\(0,0\);renderRatioManagement\(\);/);
  // The access key travels in the fragment, so the chips scroll by script instead of linking to "#section".
  assert.doesNotMatch(nav[1], /href=/);
  const start = html.indexOf("// Overview: a chip scrolls to its section."), end = html.indexOf("/* ratio-presentation:v1:end */", start);
  assert.ok(start > 0 && end > start);
  const handler = html.slice(start, end);
  assert.match(handler, /scrollIntoView\(/);
  assert.doesNotMatch(handler, /location|history\.|\.hash/);
  assert.match(html, /<details class="trend" id="trendDetails" open>/);
});

// note-tidy:v1 — the asset-allocation notes are reworded on display only.
const noteTidySource = html.slice(html.indexOf("const RATIO_NOTE_RULES=["), html.indexOf("/* ratio-presentation:v1:end */"));
const { simplifyRatioNoteText, tidyRatioNotes } = new Function(`${noteTidySource}\nreturn {simplifyRatioNoteText,tidyRatioNotes};`)();

test("known note sentences are reworded and keep their own figures and dates", () => {
  assert.equal(simplifyRatioNoteText("组合参考目标：35%（占总资产）；各策略的参考目标未设置。"), "本类参考目标：占总资产 35%。");
  assert.equal(simplifyRatioNoteText("按 Sharesight 原始持仓名称首字段分类。上方百分比分母仅为常青基金市值，不叠加穿透。"), "按 Sharesight 持仓名称的第一段分类；百分比是占常青基金市值的比例。");
  assert.equal(simplifyRatioNoteText("本类合计 USD 1,540.25 · 占比合计100.00%。明细按账户及市值降序列出，同分类、同账户、年月后完整名称相同的持仓合并合计；不同账户和不同份额名称分别列出。"), "本类合计 USD 1,540.25；同一账户里同名的持仓合并显示。");
  assert.equal(simplifyRatioNoteText("黄金（GLD）：USD 12.50；已计入所属分类，不另加总。"), "黄金（GLD）：USD 12.50，已计入所属分类。");
  assert.equal(simplifyRatioNoteText("Sharesight IB-HK 账面现金：USD 6.00"), "IB-HK 现金：USD 6.00");
  assert.equal(simplifyRatioNoteText("账面现金池：USD 12.00"), "现金合计：USD 12.00");
  assert.equal(simplifyRatioNoteText("生成 2026-11-10T10:00:00.000Z · 管理费账务截至 2026-11-09，两者日期不同"), "生成于 2026-11-10 10:00（UTC） · 管理费账务截至 2026-11-09，两者日期不同");
  assert.equal(simplifyRatioNoteText("比例管理 · 周报 · 报告目标 2026-11-10 · 非实时"), "资产配置 · 周报 · 报告目标 2026-11-10 · 非实时");
  assert.equal(simplifyRatioNoteText("总资产收益含 2 项程序取值模拟基准；资产配置已排除它们，口径不同。"), "总资产的收益率含 2 项只作对照的模拟基准；市值和占比已不含它们。");
  assert.equal(simplifyRatioNoteText("API 响应接收 2026-11-10T09:00:00.000Z。报表总额与逐行合计相差 0.03 USD，按逐行合计列示。"), "报表总额与逐行相加相差 0.03 USD，本页按逐行相加。");
  assert.equal(simplifyRatioNoteText("现金类资产：BIL USD 10.00 · SGOV USD 5.00；不默认出售。"), "现金类资产：BIL USD 10.00 · SGOV USD 5.00。");
});

test("repeated or empty note sentences are left out, and a warning is never hidden", () => {
  for (const dropped of [
    "EXUS · EIMI · USSC：补仓金额未计算。USSC 的10%仅为原补仓预算参考，不是持仓目标。",
    "成交后投影未计算；没有完整订单证据时，内部风控保持未知。",
    "现金类资产：本次完整分类来源未见非零项；不默认出售。",
    "API 响应接收 2026-11-10T09:00:00.000Z。报表总额与逐行合计相差 0.00 USD，按逐行合计列示。",
    "2026-11-10 持仓与现金取自同一份Sharesight API分类报表；不含ETF穿透。",
    "预算／资本承诺未核实，未生成可执行补仓金额。",
    "按Sharesight现有记录显示；不新增或重复任何转仓和认购。",
    "持仓估值 2026-11-10；读取 2026-11-10T09:00:00.000Z；时间依据 Sharesight API 响应接收时间。",
  ]) assert.equal(simplifyRatioNoteText(dropped), "", dropped);
  // The warnings that can follow the boilerplate survive it.
  assert.equal(simplifyRatioNoteText("预算／资本承诺未核实，未生成可执行补仓金额。完整来源尚未通过本机核验。来源转仓尚未核销，保留原账面持仓。"), "完整来源尚未通过本机核验。来源转仓尚未核销，保留原账面持仓。");
  // Anything not on the list is shown exactly as published.
  for (const kept of [
    "来源：Sharesight 官方 API（合并视图 All Together 分类报表） · 资产分类截至 2026-11-10。原始全量证据尚未接入本机核验，仅供私密预览，不能作为正式发布来源。",
    "A new warning nobody has listed yet.",
    "总资产收益含 2 项程序取值模拟基准；此历史快照的资产总额保留原口径。",
  ]) assert.equal(simplifyRatioNoteText(kept), null, kept);
});

test("tidying the report rewrites listed lines, keeps unknown ones and marks an annualised value", () => {
  class N {
    constructor(tag, cls = "", text = "") { this.tagName = tag; this.className = cls; this.children = []; this.parentNode = null; this.own = text; this.attrs = {}; }
    get classList() { const n = this; return { contains: c => n.className.split(" ").includes(c), add: c => { n.className = (n.className + " " + c).trim(); } }; }
    get textContent() { return this.children.length ? this.children.map(c => c.textContent).join("") : this.own; }
    set textContent(v) { for (const c of this.children) c.parentNode = null; this.children = []; this.own = String(v); }
    append(...nodes) { for (const n of nodes) { n.parentNode = this; this.children.push(n); } return this; }
    remove() { const p = this.parentNode; if (p) p.children = p.children.filter(c => c !== this); this.parentNode = null; }
    setAttribute(k, v) { this.attrs[k] = v; }
    is(token) { return token.startsWith(".") ? this.classList.contains(token.slice(1)) : this.tagName === token.toUpperCase(); }
    all() { return this.children.flatMap(c => [c, ...c.all()]); }
    querySelectorAll(selector) {
      const tokens = selector.split(" ");
      return this.all().filter(n => { if (!n.is(tokens.at(-1))) return false; let up = n.parentNode; for (const t of tokens.slice(0, -1).reverse()) { while (up && up !== this && !up.is(t)) up = up.parentNode; if (!up || up === this) return false; up = up.parentNode; } return true; });
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }
  const line = text => new N("P").append(new N("SPAN", "ratio-note-number", "4.1"), new N("SPAN", "ratio-note-text", text));
  const fold = (title, ...lines) => new N("DETAILS", "ratio-explanation").append(new N("SUMMARY", "", title), ...lines);
  const cash = fold("说明 4 · 现金与补仓参考说明", line("Sharesight IB-HK 账面现金：USD 6.00"), line("成交后投影未计算；没有完整订单证据时，内部风控保持未知。"), line("A new warning nobody has listed yet."));
  const emptied = fold("说明 3 · 覆盖范围、残余与缺项", line("没有完整订单来源，不生成成交后投影或可执行预算；不恢复券商／Flex／邮件读取。"));
  const badge = new N("SMALL", "", "年化"), other = new N("SMALL", "", "未满一年");
  const returns = new N("SPAN", "ratio-return-compact-line").append(new N("STRONG", "", "8.25%"), badge, other);
  const evergreen = new N("SECTION", "ratio-fund-distribution").append(new N("H2", "", "常青基金"), new N("SPAN", "ratio-distribution-name", "二级"), new N("SECTION", "ratio-distribution-category").append(new N("H3", "", "二级 · 12.50%")));
  const hedge = new N("SECTION", "ratio-fund-distribution").append(new N("H2", "", "对冲基金"), new N("SPAN", "ratio-distribution-name", "二级"));
  const report = new N("DIV", "ratio-report").append(returns, evergreen, hedge, emptied, cash);
  tidyRatioNotes(report);
  assert.deepEqual(cash.children.map(c => c.textContent), ["现金", "•IB-HK 现金：USD 6.00", "•A new warning nobody has listed yet."]);
  assert.equal(emptied.parentNode, null, "a fold left with no lines is removed");
  assert.equal(badge.textContent, "*"); assert.equal(badge.attrs.title, "年化收益率"); assert.equal(other.textContent, "未满一年");
  assert.equal(returns.children[0].textContent, "8.25%", "the value itself is untouched");
  assert.equal(evergreen.children[1].textContent, "私募二级 Secondary"); assert.equal(evergreen.children[2].children[0].textContent, "私募二级 Secondary · 12.50%");
  assert.equal(hedge.children[1].textContent, "二级", "only the evergreen module is renamed");
});

test("a history that lies within one year names that year on the first chip", () => {
  const returnWindows = new Function(`${html.slice(html.indexOf("function returnWindows(st){"), html.indexOf("/* compact-comparison-tables:end */"))}\nreturn returnWindows;`)();
  const months = list => ({ rows: list.map(ym => ({ ym })) });
  assert.deepEqual(returnWindows(months(["2026-07", "2026-08", "2026-09", "2026-10", "2026-11"])).map(w => w.label), ["全部（今年）", "近3个月", "本月"]);
  assert.deepEqual(returnWindows(months(["2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04"])).map(w => w.label), ["全部", "今年", "近3个月", "本月"]);
  assert.match(html, /\.return-windows button\[aria-selected="true"\]\{background:var\(--chip\);border-color:var\(--series-1\)/);
});

// settings-jump:v1 — the settings page has its own chip row; chips of sections that are not on the page are dropped.
test("the settings page jump row names existing cards and hides chips of absent sections", () => {
  const section = html.slice(html.indexOf('<section class="pane" id="p-set">'), html.indexOf("</section>", html.indexOf('<section class="pane" id="p-set">')));
  const nav = section.match(/^<section class="pane" id="p-set">\n  <nav class="home-jump" aria-label="设置页快速跳转" data-jump-auto>([\s\S]*?)<\/nav>/);
  assert.ok(nav, "the settings page opens with its jump row");
  const targets = [...nav[1].matchAll(/<button type="button" data-jump="([\w-]+)"(?: aria-current="true")?>([^<]+)<\/button>/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(targets, [["setLedgerCard", "账本"], ["setShareCard", "共享"], ["fundProfileAdminCard", "基金"], ["fundDocsCard", "文件"], ["setRulesCard", "费率"], ["setFlowsCard", "出入金"], ["setDataCard", "数据"]]);
  // Every target is exactly one card of this page, in the same order as the chips.
  let at = 0;
  for (const [id] of targets) {
    assert.equal(html.split('id="' + id + '"').length, 2, id);
    const found = section.indexOf('<div class="card" id="' + id + '"', at);
    assert.ok(found > at, id + " is a card of the settings page, after the previous one"); at = found;
  }
  assert.doesNotMatch(nav[1], /href=/);
  assert.match(html, /#p-home>\.card,#p-set>\.card,\.ratio-report>section\.card\{scroll-margin-top:/);
  const spy = html.slice(html.indexOf("function syncJumpChips(){"), html.indexOf("/* ratio-presentation:v1:end */"));
  assert.match(spy, /if\(bar\.hasAttribute\('data-jump-auto'\)\)for\(const chip of every\)\{const hide=!shown\(chip\);if\(chip\.hidden!==hide\)chip\.hidden=hide;\}/);
  assert.match(spy, /const chips=every\.filter\(chip=>!chip\.hidden\);if\(!chips\.length\)continue;/);
  // Switching tab refreshes the row at once instead of waiting for the first scroll.
  assert.match(html, /globalThis\.scrollTo\?\.\(0,0\);renderRatioManagement\(\);try\{syncJumpChips\(\);\}catch\{\}\}\);/);
});

// alloc-target:v1 — the allocation overview draws the reference targets as a second bar from the text already shown.
test("the allocation overview pairs the current bar with a reference-target bar without recalculating", () => {
  const style = html.slice(html.indexOf("function styleRatioReport("), html.indexOf("/* ratio-presentation:v1:end */"));
  const block = style.slice(style.indexOf("// alloc-target:v1"), style.indexOf("// stock-bars:v1"));
  assert.ok(block.length > 200, "the target bar is built inside the reviewed presentation layer");
  // Targets are read from the printed "current／target" text of each row, and a row without a usable target drops the whole bar.
  assert.match(block, /querySelector\('\.ratio-overview-weights'\)\?\.textContent\|\|''\)\.split\('／'\)\[1\]\)\)/);
  assert.match(block, /targets\.every\(n=>Number\.isFinite\(n\)&&n>=0\)&&targets\.some\(n=>n>0\)/);
  assert.match(block, /now\.textContent='当前';aim\.textContent='参考目标';/);
  assert.match(block, /segment\.setAttribute\('style','flex:'\+targets\[i\]\+' 0 0'\)/);
  // It only adds elements beside the table; no amount, share, ranking or source value is written.
  assert.doesNotMatch(block, /toFixed|Math\.|valueCents|totalCents|innerHTML/);
  // Owner feedback 2026-11-19: one class must look the same colour in both bars, so the target bar is not faded.
  assert.match(html, /\.ratio-alloc-target\{margin-bottom:10px\}/);assert.doesNotMatch(html, /\.ratio-alloc-target\{[^}]*opacity/);
});

// stock-bars:v1 — the four stock classes get the same pair of bars, read from their table's printed "current／target" column.
test("the stock-class table gets the same current and reference-target bars without recalculating", () => {
  const style = html.slice(html.indexOf("function styleRatioReport("), html.indexOf("/* ratio-presentation:v1:end */"));
  const block = style.slice(style.indexOf("// stock-bars:v1"), style.indexOf("const noteNumbers="));
  assert.ok(block.length > 200);
  assert.match(block, /report\.querySelector\('\.ratio-stock-table'\)/);
  assert.match(block, /String\(row\.cells\[2\]\?\.textContent\|\|''\)\.split\('／'\)\.map\(part=>Number\.parseFloat\(part\)\)/);
  // Every row must carry both numbers, and both bars need something to show; otherwise the table is left as it was.
  assert.match(block, /stockPairs\.every\(pair=>pair\.length===2&&pair\.every\(n=>Number\.isFinite\(n\)&&n>=0\)\)&&stockPairs\.some\(pair=>pair\[0\]>0\)&&stockPairs\.some\(pair=>pair\[1\]>0\)/);
  assert.match(block, /draw\(0,'当前',''\);draw\(1,'参考目标',' ratio-alloc-target'\);/);
  assert.doesNotMatch(block, /toFixed|Math\.|valueCents|totalCents|innerHTML/);
});

// units-hint:v1 — the hint under the six-class title is shortened on display so it does not wrap to a stray last line.
test("the six-class hint is shortened on display only, and only when it is the known sentence", () => {
  const tidy = html.slice(html.indexOf("function tidyRatioNotes("), html.indexOf("/* ratio-presentation:v1:end */"));
  assert.match(tidy, /for\(const hint of Array\.from\(report\.querySelectorAll\('\.ratio-overview-units'\)\)\)if\(hint\.textContent==='分类下方为当前占比／参考目标；市值下方括号为目标差额。'\)hint\.textContent='小字为当前／目标占比，括号为目标差额。';/);
  // The renderer keeps publishing its own sentence; only the presentation layer rewords it.
  assert.equal(html.split("分类下方为当前占比／参考目标；市值下方括号为目标差额。").length, 3);
  assert.match(html, /<p class="ratio-overview-units">分类下方为当前占比／参考目标；市值下方括号为目标差额。<\/p>/);
});

// lots-layout:v1 — owner feedback 2026-11-20 on the real page: the "N 笔" row sat under a tall gap, and the
// first-purchase date wrapped on some lots and not on others.
test("a fund's lots open close under its name and every lot puts its first-purchase date on its own line", () => {
  assert.match(html, /#p-ratio \.ratio-holding-lots\{margin-top:-4px\}#p-ratio \.ratio-holding-lots summary\{cursor:pointer;color:var\(--ink-2\);min-height:28px\}/);
  assert.match(html, /\.ratio-holding-lots \.ratio-holding-yield\{flex:1 0 100%\}\.ratio-holding-lots \.ratio-holding-yield-since\{flex-basis:100%\}/);
  // A fund held in one lot keeps its single flowing line.
  assert.doesNotMatch(html, /\.ratio-fund-holding>\.ratio-holding-yield \.ratio-holding-yield-since\{flex-basis/);
});
