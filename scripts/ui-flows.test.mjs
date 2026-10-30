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
  assert.ok(["de3ac592f57c314bf94092d99fa43f9e7c0f273b50a1261b66df1c2d8211dc0d","abc5541ad27f63f9ff21de91e5645160a46e1d9ea4aa67759961cfa96cdabc34"].includes(digest),
    "asset allocation tests require an exact reviewed old or new page");
  assert.equal(page.split(assetStart).length,2);
  assert.equal(page.split(assetEnd).length,2);
  const actual=page.split(assetStart)[1].split(assetEnd)[0];
  assert.equal(actual,reviewedAssetBlock,"live new block must equal the reviewed fixture");
  return actual;
}
const assetBlock=assetBlockForReviewedStage(html);
test("asset allocation staged fixture rejects unreviewed page bytes",()=>{
  assert.throws(()=>assetBlockForReviewedStage(html+"\n"));
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
  }else assert.ok(["de3ac592f57c314bf94092d99fa43f9e7c0f273b50a1261b66df1c2d8211dc0d","abc5541ad27f63f9ff21de91e5645160a46e1d9ea4aa67759961cfa96cdabc34"].includes(pageSha(html)));
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
