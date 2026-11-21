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
  assert.deepEqual(targets, [["setFeeCard", "付款"], ["setLedgerCard", "账本"], ["setShareCard", "共享"], ["fundProfileAdminCard", "基金"], ["fundDocsCard", "文件"], ["setRulesCard", "费率"], ["setFlowsCard", "出入金"], ["setDataCard", "数据"]]);
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

// holding-dividers:v1 — owner request 2026-11-20: tell products and lots apart in the holdings list.
// Three levels, each lighter than the one above: platform (solid, already there), product (dashed), lot (dotted).
test("the holdings list separates platforms, products and lots with three distinct rules", () => {
  assert.match(html, /\.ratio-distribution-account\{padding:6px 0;border-top:1px solid var\(--grid\)\}/);
  assert.match(html, /\.ratio-fund-holding\+\.ratio-fund-holding\{border-top:1px dashed var\(--grid\);margin-top:2px;padding-top:6px\}/);
  assert.match(html, /\.ratio-holding-lots li\+li\{border-top:1px dotted var\(--grid\);margin-top:3px;padding-top:5px\}/);
});

// fee-in-settings:v1 — owner request 2026-11-20: the payments tab is gone; its card opens the Settings page.
test("payments live in Settings with the same controls, and no payments tab or pane remains", () => {
  assert.equal(html.includes('id="p-fee"'), false);
  assert.equal(html.includes('data-p="p-fee"'), false);
  const tabs = html.slice(html.indexOf('<nav class="tabs" id="tabs"'), html.indexOf("</nav>", html.indexOf('<nav class="tabs" id="tabs"')));
  assert.deepEqual([...tabs.matchAll(/<button data-p="([\w-]+)"/g)].map(m => m[1]).filter(p => p !== "p-ratio"), ["p-home", "p-investors", "p-set"]);
  const section = html.slice(html.indexOf('<section class="pane" id="p-set">'), html.indexOf("</section>", html.indexOf('<section class="pane" id="p-set">')));
  const card = section.slice(section.indexOf('<div class="card" id="setFeeCard">'), section.indexOf('<div class="card" id="setLedgerCard">'));
  for (const id of ["feeProgress", "tblFee", "btnAddFee", "btnAddFeeDue"]) {
    assert.equal(html.split('id="' + id + '"').length, 2, id);
    assert.ok(card.includes('id="' + id + '"'), id + " is inside the payments card");
  }
  // A reader who is not the manager is still moved off the Settings page.
  assert.match(html, /if\(!isMgr\(\)&&\["p-set"\]\.some\(/);
});

// evergreen-desk:v1 — owner request 2026-11-20: a working page for the evergreen funds with an owner-set status.
const evergreenBlock = html.slice(html.indexOf("/* evergreen-desk:v1:start */"), html.indexOf("/* evergreen-desk:v1:end */"));
async function evergreenBox(saved) {
  const vm = await import("node:vm");
  const memory = new Map(saved ? [["feeConsole.evergreen.labels.v1", JSON.stringify(saved)]] : []);
  const box = { store: { getItem: k => memory.get(k) ?? null, setItem: (k, v) => { memory.set(k, v); } }, todayStr: () => "2026-11-20" };
  vm.createContext(box);
  vm.runInContext(evergreenBlock + ";globalThis.t={evergreenLabelClean,evergreenDeskModel,evergreenDeskView,evergreenLabels,evergreenLabelSet,EVERGREEN_STATES};", box);
  return { t: box.t, memory };
}
const evergreenRows = [
  { key: "P|Fund <A>", name: "Fund <A>", platform: "P", strategy: "S1", amount: "USD 100.00", lots: 3, figuresHtml: '<ul class="evergreen-lots"><li>x</li></ul>' },
  { key: "P|Fund B", name: "Fund B", platform: "P", strategy: "S2", amount: "USD 99.00", lots: 1, figuresHtml: "" },
  { key: "Q|Fund C", name: "Fund C", platform: "Q", strategy: "S1", amount: "USD 98.00", lots: 1, figuresHtml: '<span class="ratio-holding-yield">y</span>' },
];
test("the evergreen page has its own tab on the verified allocation pane and is display only", () => {
  assert.ok(evergreenBlock.length > 1000, "index.html carries the evergreen-desk block");
  const tabs = html.slice(html.indexOf('<nav class="tabs" id="tabs"'), html.indexOf("</nav>", html.indexOf('<nav class="tabs" id="tabs"')));
  assert.match(tabs, /<button data-p="p-ratio" class="mgr" id="evergreenTab" data-view="evergreen" hidden>常青<\/button>\n  <button data-p="p-ratio" class="mgr" id="ratioTab" hidden>资产配置<\/button>/);
  // The new tab is shown and hidden by the same permission as the allocation tab, never by the manager flag alone.
  assert.match(html, /const evergreen=document\.getElementById\('evergreenTab'\);if\(evergreen\)\{evergreen\.hidden=!allowed;evergreen\.style\.display=allowed\?'':'none';\}\n  document\.querySelectorAll\('#tabs button\.mgr'\)\.forEach\(b=>\{if\(b!==tab&&b!==evergreen\)b\.style\.display=isMgr\(\)\?'':'none';\}\);/);
  assert.match(html, /if\(b\.dataset\.p==="p-ratio"&&\(!ratioAuthorized\(\)\|\|b\.classList\.contains\("on"\)\)\)return;if\(b\.dataset\.p==="p-ratio"&&typeof setRatioView==='function'\)setRatioView\(b\.dataset\.view\);/);
  // One view at a time, by style only: the report stays in the page and nothing is fetched or decrypted again for it.
  assert.match(html, /#p-ratio\[data-view="evergreen"\] \.ratio-report>\*:not\(\.evergreen-desk\),[^{]*#p-ratio:not\(\[data-view="evergreen"\]\) \.evergreen-desk\{display:none\}/);
  // It rereads printed text and never computes, fetches or decrypts.
  assert.doesNotMatch(evergreenBlock, /toFixed|Math\.|valueCents|totalCents|parseFloat|Number\(|fetch\(|ghApi|ratioCore|deriveManager|crypto/);
  assert.match(html, /function styleRatioReport\(root\)\{\n  try\{renderEvergreenDesk\(root\);\}catch\{\}\n/);
});
test("evergreen labels are cleaned, counted and shown without touching any amount", async () => {
  const { t } = await evergreenBox();
  assert.deepEqual(JSON.parse(JSON.stringify(t.evergreenLabelClean({ state: "sell-now", note: "x".repeat(200), reviewBy: "soon", updatedAt: "2026-11-20", extra: 1 }))),
    { state: "", note: "x".repeat(120), reviewBy: "", updatedAt: "2026-11-20", decided: "" });
  assert.deepEqual(JSON.parse(JSON.stringify(t.evergreenLabelClean(null))), { state: "", note: "", reviewBy: "", updatedAt: "", decided: "" });
  const labels = { "P|Fund <A>": { state: "watch", note: "wait <b>", reviewBy: "2026-11-01", updatedAt: "2026-10-01" }, "Q|Fund C": { state: "hold", reviewBy: "2026-12-31" } };
  const model = t.evergreenDeskModel(evergreenRows, labels, "2026-11-20");
  assert.deepEqual(JSON.parse(JSON.stringify(model.counts)), { all: 3, none: 1, pending: 0, hold: 1, watch: 1, prepare: 0, redeeming: 0 });
  assert.equal(model.platforms, 2); assert.equal(model.overdue, 1);
  assert.deepEqual(model.funds.map(x => [x.stateName, x.overdue]), [["观察", true], ["未标记", false], ["持有", false]]);
  const view = t.evergreenDeskView(model, "all", new Set(["P|Fund B"]));
  assert.match(view, /3 只基金 · 2 个平台 · 1 只已过复核日/);
  // Only states in use get a filter chip; names and notes are escaped; figures come through as the report printed them.
  assert.deepEqual([...view.matchAll(/data-evergreen-filter="(\w+)" aria-pressed="(\w+)">([^<]+)</g)].map(m => m.slice(1)), [["all", "true", "全部 3"], ["none", "false", "未标记 1"], ["hold", "false", "持有 1"], ["watch", "false", "观察 1"]]);
  assert.ok(view.includes("<strong>Fund &lt;A&gt;</strong>")); assert.ok(view.includes('value="wait &lt;b&gt;"')); assert.equal(view.includes("<b>"), false);
  assert.ok(view.includes('<ul class="evergreen-lots"><li>x</li></ul>')); assert.ok(view.includes('<span class="ratio-holding-yield">y</span>'));
  assert.ok(view.includes("此快照未包含这只基金的收益率。")); assert.ok(view.includes("P · S1 · 3 笔"));
  assert.match(view, /<details class="evergreen-fund" data-evergreen-key="P\|Fund B" open>/);
  assert.equal((view.match(/<details class="evergreen-fund"/g) || []).length, 3);
  assert.ok(view.includes('data-state="watch">观察 · 待复核<')); assert.ok(view.includes("本页不提供买卖或赎回建议"));
  for (const amount of ["USD 100.00", "USD 99.00", "USD 98.00"]) assert.ok(view.includes(amount));
  // A filter narrows the list; an empty snapshot says so.
  const watch = t.evergreenDeskView(model, "watch", new Set());
  assert.equal((watch.match(/<details class="evergreen-fund"/g) || []).length, 1); assert.ok(watch.includes("Fund &lt;A&gt;"));
  assert.ok(t.evergreenDeskView(model, "prepare", new Set()).includes("这个状态下没有基金。"));
  assert.ok(t.evergreenDeskView(t.evergreenDeskModel([], {}, "2026-11-20"), "all", new Set()).includes("此快照未包含常青基金的持仓明细。"));
});
test("an evergreen label is saved on this device only, dated, and survives a damaged store", async () => {
  const { t, memory } = await evergreenBox();
  assert.equal(t.evergreenLabelSet("P|Fund B", { state: "prepare" }), true);
  assert.equal(t.evergreenLabelSet("P|Fund B", { note: "see Q4 report" }), true);
  assert.deepEqual(JSON.parse(memory.get("feeConsole.evergreen.labels.v1")), { "P|Fund B": { state: "prepare", note: "see Q4 report", reviewBy: "", updatedAt: "2026-11-20", decided: "" } });
  assert.equal(memory.size, 1);
  const damaged = await evergreenBox(); damaged.memory.set("feeConsole.evergreen.labels.v1", "{not json");
  assert.deepEqual(JSON.parse(JSON.stringify(damaged.t.evergreenLabels())), {});
  const list = await evergreenBox([1, 2]); assert.deepEqual(JSON.parse(JSON.stringify(list.t.evergreenLabels())), {});
  // The label never leaves the device: the block has no draft, ledger or publish call.
  assert.doesNotMatch(evergreenBlock, /changeDraft|EDIT\.|saveLedger|publish|gist/i);
});

// evergreen-calendar:v1 — owner request 2026-11-20, second step: terms per fund, a redemption calendar per purchase lot,
// a liquidity ladder, and a terms pack to carry terms and labels between people and devices.
const calendarBlock = html.slice(html.indexOf("/* evergreen-calendar:v1:start */"), html.indexOf("/* evergreen-calendar:v1:end */"));
const profileBlock = html.slice(html.indexOf("/* evergreen-profile:v1:start */"), html.indexOf("/* evergreen-profile:v1:end */"));
async function calendarBox(saved = {}) {
  const vm = await import("node:vm");
  const memory = new Map(Object.entries(saved).map(([k, v]) => [k, JSON.stringify(v)]));
  const box = { store: { getItem: k => memory.get(k) ?? null, setItem: (k, v) => { memory.set(k, v); }, removeItem: k => { memory.delete(k); } }, todayStr: () => "2026-11-20", URL };
  vm.createContext(box);
  vm.runInContext(profileBlock + "\n" + calendarBlock + "\n" + evergreenBlock + ";globalThis.c={evergreenProfileClean,evergreenReadingClean,evergreenProfiles,evergreenReading,evergreenProfileView,evergreenReadingView,evergreenUrl,evergreenPackApply,evergreenTermsClean,evergreenTerms,evergreenAddMonths,evergreenAddDays,evergreenDaysBetween,evergreenDealingDay,evergreenLotPlan,evergreenCents,evergreenUsd,evergreenQuarter,evergreenWeek,evergreenPending,evergreenAssessmentView,evergreenTermsView,evergreenPackBuild,evergreenPackRead,evergreenPackView};", box);
  return { c: box.c, memory };
}
const plain = v => JSON.parse(JSON.stringify(v));
test("evergreen terms keep only well-formed values and calendar arithmetic is exact", async () => {
  const { c } = await calendarBox();
  assert.deepEqual(plain(c.evergreenTermsClean({ frequency: "weekly", noticeDays: 45.5, lockupMonths: -1, softLockMonths: 24, earlyFeePct: 5, gatePct: 101, mgmtPct: "1.25", source: "  Prospectus  ", asOf: "2026-5-20", note: "x".repeat(400), secret: 1 })),
    { softLockMonths: 24, earlyFeePct: 5, source: "Prospectus", note: "x".repeat(300) });
  assert.deepEqual(plain(c.evergreenTermsClean([1])), {}); assert.deepEqual(plain(c.evergreenTermsClean(null)), {});
  assert.equal(c.evergreenAddMonths("2024-08-31", 6), "2025-02-28"); assert.equal(c.evergreenAddMonths("2024-01-31", 1), "2024-02-29");
  assert.equal(c.evergreenAddMonths("2026-10-28", 12), "2027-10-28"); assert.equal(c.evergreenAddMonths("2026-02-30", 1), "");
  assert.equal(c.evergreenAddDays("2026-12-31", 45), "2027-02-14"); assert.equal(c.evergreenAddDays("2027-03-31", -90), "2026-12-31");
  assert.equal(c.evergreenDaysBetween("2026-11-20", "2026-12-31"), 41); assert.equal(c.evergreenDaysBetween("x", "2026-12-31"), null);
  for (const [from, frequency, want] of [["2026-11-20", "monthly", "2026-11-30"], ["2026-11-30", "monthly", "2026-11-30"], ["2026-12-01", "monthly", "2026-12-31"], ["2027-02-01", "monthly", "2027-02-28"],
    ["2026-11-20", "quarterly", "2026-12-31"], ["2027-01-01", "quarterly", "2027-03-31"], ["2027-03-31", "quarterly", "2027-03-31"],
    ["2026-11-20", "semiannual", "2026-12-31"], ["2027-01-01", "semiannual", "2027-06-30"], ["2027-01-01", "annual", "2027-12-31"]])
    assert.equal(c.evergreenDealingDay(from, frequency), want, from + " " + frequency);
  assert.equal(c.evergreenDealingDay("2026-11-20", "weekly"), "");
  assert.equal(c.evergreenCents("USD 702,583.16"), 70258316); assert.equal(c.evergreenCents("USD 0.05"), 5); assert.equal(c.evergreenCents("USD 100"), null);
  assert.equal(c.evergreenCents("EUR 100.00"), null); assert.equal(c.evergreenCents("USD 1,23.45"), null); assert.equal(c.evergreenCents(""), null);
  assert.equal(c.evergreenUsd(70258316), "USD 702,583"); assert.equal(c.evergreenUsd(19900), "USD 199"); assert.equal(c.evergreenQuarter("2027-05-15"), "2027 Q2");
});
test("each purchase lot gets its own lock, fee and deadline", async () => {
  const { c } = await calendarBox(), today = "2026-11-20";
  const quarterly = { frequency: "quarterly", noticeDays: 45, lockupMonths: 0, softLockMonths: 24, earlyFeePct: 5, settlementDays: 30 };
  // Bought long ago: free. The first quarter-end at least 45 days away is 2027-03-31.
  assert.deepEqual(plain(c.evergreenLotPlan("2024-08-31", quarterly, today)), { status: "free", hardUnlock: "2024-08-31", softEnd: "2026-08-31", dealing: "2027-03-31", notice: "2027-02-14", cash: "2027-04-30", daysToNotice: 86, freeDealing: "2027-03-31", freeNotice: "2027-02-14", freeCash: "2027-04-30" });
  // Bought this year: redeemable with the early fee; the first fee-free dealing day is after the 24 months.
  const young = c.evergreenLotPlan("2026-05-27", quarterly, today);
  assert.equal(young.status, "fee"); assert.equal(young.dealing, "2027-03-31"); assert.equal(young.softEnd, "2028-05-27"); assert.equal(young.freeDealing, "2028-06-30"); assert.equal(young.freeNotice, "2028-05-16");
  // A hard lock-up: nothing before the lock ends, and the notice is counted back from that dealing day.
  const locked = c.evergreenLotPlan("2026-10-28", { frequency: "monthly", noticeDays: 10, lockupMonths: 12, settlementDays: 20 }, today);
  assert.equal(locked.status, "locked"); assert.equal(locked.hardUnlock, "2027-10-28"); assert.equal(locked.dealing, "2027-10-31"); assert.equal(locked.notice, "2027-10-21"); assert.equal(locked.cash, "2027-11-20");
  // A soft lock without a fee percentage is not called a fee.
  assert.equal(c.evergreenLotPlan("2026-05-27", { ...quarterly, earlyFeePct: undefined }, today).status, "free");
  // Missing pieces are named, never guessed.
  assert.equal(c.evergreenLotPlan("2024-08-31", { frequency: "quarterly" }, today).status, "no-terms");
  assert.equal(c.evergreenLotPlan("2024-08-31", null, today).status, "no-terms");
  assert.equal(c.evergreenLotPlan("", quarterly, today).status, "no-date"); assert.equal(c.evergreenLotPlan("2024-13-01", quarterly, today).status, "no-date");
  // The deadline can be today, never in the past.
  const edge = c.evergreenLotPlan("2020-01-01", { frequency: "quarterly", noticeDays: 41 }, today);
  assert.equal(edge.dealing, "2026-12-31"); assert.equal(edge.notice, "2026-11-20"); assert.equal(edge.daysToNotice, 0);
});
const calendarRows = [
  { key: "P|A", name: "A <x>", platform: "P", strategy: "S", amount: "USD 100.00", lotList: [{ amount: "USD 60.00", date: "2024-08-31" }, { amount: "USD 30.00", date: "2026-05-27" }, { amount: "USD 10.00", date: "2026-10-01" }] },
  { key: "P|B", name: "B", platform: "P", strategy: "S", amount: "USD 99.00", lotList: [{ amount: "USD 99.00", date: "2024-04-02" }] },
  { key: "P|C", name: "C", platform: "P", strategy: "S", amount: "USD 98.00", lotList: [{ amount: "USD 98.00", date: "2026-10-28" }] },
  { key: "P|D", name: "D", platform: "P", strategy: "S", amount: "USD 96.00", lotList: [{ amount: "USD 96.00", date: "2023-01-10" }] },
  { key: "P|E", name: "E", platform: "P", strategy: "S", amount: "USD 50.00", lotList: [{ amount: "USD 50.00", date: "" }] },
];
const calendarTerms = {
  "P|A": { frequency: "quarterly", noticeDays: 45, softLockMonths: 24, earlyFeePct: 5, gatePct: 5, settlementDays: 30, mgmtPct: 1.25, perfPct: 12.5, hurdlePct: 5, source: "Prospectus <b>", asOf: "2026-05-20" },
  "P|B": { frequency: "quarterly", noticeDays: 90, settlementDays: 45 },
  "P|C": { frequency: "monthly", noticeDays: 10, lockupMonths: 12, settlementDays: 20 },
  "P|E": { frequency: "quarterly", noticeDays: 45 },
};
// pending-week:v1 (owner request 2026-11-21): the calendar card is gone; a fund is pending when a lot can be filed
// this week without an early-redemption fee, until the owner chooses a status for that deadline.
test("the week being planned runs Monday to Sunday and becomes next week at the weekend", async () => {
  const { c } = await calendarBox();
  assert.deepEqual(plain(c.evergreenWeek("2026-11-18")), { monday: "2026-11-16", friday: "2026-11-20", from: "2026-11-18", to: "2026-11-22" });
  assert.deepEqual(plain(c.evergreenWeek("2026-11-16")), { monday: "2026-11-16", friday: "2026-11-20", from: "2026-11-16", to: "2026-11-22" });
  assert.deepEqual(plain(c.evergreenWeek("2026-11-21")), { monday: "2026-11-23", friday: "2026-11-27", from: "2026-11-23", to: "2026-11-29" });
  assert.deepEqual(plain(c.evergreenWeek("2026-11-22")), { monday: "2026-11-23", friday: "2026-11-27", from: "2026-11-23", to: "2026-11-29" });
  assert.equal(c.evergreenWeek("soon"), null);
});
test("a fund is pending only for lots that can be filed this week without an early-redemption fee", async () => {
  const { c } = await calendarBox();
  // B: quarterly, 90 days' notice, no fee period. Its deadline for 2027-03-31 is 2026-12-31, a Thursday.
  assert.deepEqual(plain(c.evergreenPending(calendarRows[1], calendarTerms["P|B"], "2026-12-28")), { notice: "2026-12-31", dealing: "2027-03-31", cash: "2027-05-15", lots: 1, amounts: ["USD 99.00"], skipped: 0 });
  assert.equal(c.evergreenPending(calendarRows[1], calendarTerms["P|B"], "2026-12-20"), null, "the week before, nothing is due");
  assert.deepEqual(plain(c.evergreenPending(calendarRows[1], calendarTerms["P|B"], "2026-12-26")).notice, "2026-12-31", "on Saturday the coming week counts");
  // A: 45 days' notice for 2027-03-31 falls on 2027-02-14, a Sunday of the week of 02-08. Only the lot past its
  // 24-month fee period counts; the two newer lots are left out and counted as skipped.
  assert.deepEqual(plain(c.evergreenPending(calendarRows[0], calendarTerms["P|A"], "2027-02-09")), { notice: "2027-02-14", dealing: "2027-03-31", cash: "2027-04-30", lots: 1, amounts: ["USD 60.00"], skipped: 2 });
  // A fund whose every lot is inside the fee period, one with no terms and one with no purchase date are never pending.
  assert.equal(c.evergreenPending({ lotList: [{ amount: "USD 30.00", date: "2026-05-27" }] }, calendarTerms["P|A"], "2027-02-09"), null);
  assert.equal(c.evergreenPending(calendarRows[3], undefined, "2026-12-28"), null); assert.equal(c.evergreenPending(calendarRows[4], calendarTerms["P|E"], "2027-02-09"), null);
  // The desk lists pending funds first, counts them, and drops one once a status is chosen for that deadline.
  const { t: d } = await evergreenBox(), week = plain(c.evergreenWeek("2026-12-28")), due = { "P|B": plain(c.evergreenPending(calendarRows[1], calendarTerms["P|B"], "2026-12-28")) };
  const model = d.evergreenDeskModel(calendarRows, {}, "2026-12-28", week, due);
  assert.equal(model.funds[0].key, "P|B"); assert.equal(model.counts.pending, 1);
  const view = d.evergreenDeskView(model, "pending", new Set(["P|B"]));
  for (const text of ['data-evergreen-filter="pending" aria-pressed="true">待处理 1</button>', '<span class="evergreen-pill" data-state="pending">待处理</span>', 'data-evergreen-due="2026-12-31"', "12-28 至 01-01 这一周：<strong>1 只待处理</strong>",
    "<strong>本周可申请赎回</strong><p>通知截止 <b>2026-12-31</b> → 赎回日 2027-03-31 → 约 2027-05-15 到账</p><p>1 笔：USD 99.00</p>", "选定任一状态后，这只基金本期不再列为待处理"]) assert.ok(view.includes(text), text);
  assert.equal((view.match(/class="evergreen-fund"/g) || []).length, 1);
  const decided = d.evergreenDeskModel(calendarRows, { "P|B": { state: "hold", decided: "2026-12-31" } }, "2026-12-28", week, due);
  assert.equal(decided.counts.pending, 0); assert.ok(d.evergreenDeskView(decided, "all", new Set()).includes("这一周：没有待处理的基金"));
  assert.equal(d.evergreenDeskModel(calendarRows, { "P|B": { state: "hold", decided: "2026-09-30" } }, "2026-12-28", week, due).counts.pending, 1, "a choice made for an earlier deadline does not cover this one");
  // Choosing a status records the deadline it answers; clearing it brings the fund back.
  assert.ok(html.includes("...(pressed?{decided:''}:dueFor?{decided:dueFor}:{})"));
  assert.doesNotMatch(html, /evergreenCalendarModel|evergreenCalendarView|<h2>赎回日历<\/h2>|_evergreenLaterOpen/);
  assert.ok(html.includes("for(const row of rows){const p=evergreenPending(row,terms[row.key],today);if(p)due[row.key]=p;}"));
});
test("a fund's sheet shows its terms, each lot's status and the source, escaped", async () => {
  const { c } = await calendarBox(), view = c.evergreenTermsView(calendarRows[0], calendarTerms["P|A"], "2026-11-20");
  for (const text of ["<dt>赎回频率</dt><dd>每季度</dd>", "<dt>通知期</dt><dd>提前 45 天</dd>", "<dt>提前赎回费</dt><dd>买入后 24 个月内 5%</dd>", "<dt>每期赎回上限</dt><dd>基金净值的 5%</dd>",
    "<dt>到账</dt><dd>赎回日后约 30 天</dd>", "<dt>管理费</dt><dd>1.25%</dd>", "<dt>业绩报酬</dt><dd>12.5%（门槛 5%）</dd>", "出处：Prospectus &lt;b&gt; · 截至 2026-05-20",
    '<strong data-status="free">可赎回</strong>', '<strong data-status="fee">可赎回，2028-05-27 前有提前赎回费</strong>', "免费用最早 2028-06-30（通知截止 2028-05-16）", "USD 60.00 · 买入 2024-08-31"])
    assert.ok(view.includes(text), text);
  assert.ok(view.includes("<dt>锁定期</dt><dd>-</dd>"), "field-frame:v1: a term that was not given is a dash"); assert.ok(view.includes("<dt>服务费</dt><dd>-</dd>"));
  assert.equal(view.includes("<b>"), false);
  assert.ok(c.evergreenTermsView(calendarRows[2], calendarTerms["P|C"], "2026-11-20").includes('<strong data-status="locked">锁定至 2027-10-28</strong>'));
  assert.ok(c.evergreenTermsView(calendarRows[4], calendarTerms["P|E"], "2026-11-20").includes("缺少买入日期"));
  { const none = c.evergreenTermsView(calendarRows[3], undefined, "2026-11-20"); assert.equal((none.match(/<dd>-<\/dd>/g) || []).length, 10); assert.ok(none.includes("条款不足，无法推算")); }
});
test("the terms pack carries names, dates, terms and labels but no amount, and is read back strictly", async () => {
  const { c } = await calendarBox();
  const pack = c.evergreenPackBuild(calendarRows, calendarTerms, { "P|B": { state: "watch", note: "n", reviewBy: "2027-01-01", updatedAt: "2026-11-20" } }, "2026-11-20"), text = JSON.stringify(pack);
  assert.equal(pack.schema, "fee-console.evergreen-pack.v1"); assert.equal(pack.funds.length, 5);
  assert.deepEqual(plain(pack.funds[0]), { key: "P|A", name: "A <x>", platform: "P", strategy: "S", purchases: ["2024-08-31", "2026-05-27", "2026-10-01"], terms: calendarTerms["P|A"], label: { state: "", note: "", reviewBy: "", updatedAt: "", decided: "" } });
  assert.deepEqual(plain(pack.funds[3].terms), {}); assert.deepEqual(plain(pack.funds[4].purchases), []);
  assert.equal(/USD|\d+\.\d{2}"/.test(JSON.stringify(pack.funds.map(x => ({ ...x, terms: {} })))), false, "no printed amount leaves in the pack");
  const read = c.evergreenPackRead(text);
  assert.equal(read.ok, true); assert.equal(read.funds, 5); assert.deepEqual(plain(read.terms), calendarTerms);
  assert.deepEqual(plain(read.labels), { "P|B": { state: "watch", note: "n", reviewBy: "2027-01-01", updatedAt: "2026-11-20", decided: "" } });
  // Edited values are cleaned on the way in; unknown keys are dropped.
  const edited = c.evergreenPackRead(JSON.stringify({ schema: "fee-console.evergreen-pack.v1", funds: [{ key: "P|D", terms: { frequency: "annual", noticeDays: 95, earlyFeePct: 500, password: "x" }, label: { state: "sell" } }] }));
  assert.deepEqual(plain(edited.terms), { "P|D": { frequency: "annual", noticeDays: 95 } }); assert.deepEqual(plain(edited.labels), {});
  for (const bad of ["", "{", "[]", '{"schema":"other","funds":[]}', '{"schema":"fee-console.evergreen-pack.v1"}', '{"schema":"fee-console.evergreen-pack.v1","funds":[{"terms":{}}]}', '{"schema":"fee-console.evergreen-pack.v1","funds":[null]}'])
    assert.equal(c.evergreenPackRead(bad).ok, false, bad);
  const view = c.evergreenPackView(true, "已导入 <1>");
  assert.match(view, /<details class="evergreen-pack" open>/); assert.ok(view.includes("不含金额")); assert.ok(view.includes("已导入 &lt;1&gt;"));
  assert.ok(view.includes('data-evergreen-pack="export"')); assert.ok(view.includes('data-evergreen-pack="import"'));
});
test("terms stay on the device, and the overview carries no evergreen line (owner request 2026-11-20)", async () => {
  const { c, memory } = await calendarBox({ "feeConsole.evergreen.terms.v1": { "P|A": { frequency: "quarterly", noticeDays: 45, junk: 1 }, "P|Z": { junk: 1 }, "P|Y": "x" } });
  assert.deepEqual(plain(c.evergreenTerms()), { "P|A": { frequency: "quarterly", noticeDays: 45 } });
  memory.set("feeConsole.evergreen.terms.v1", "{broken"); assert.deepEqual(plain(c.evergreenTerms()), {});
  // The evergreen page keeps its deadlines to itself: no saved date, no line and no jump on the overview.
  assert.doesNotMatch(html, /EVERGREEN_BRIEF_KEY|evergreenBriefSave|feeConsole\.evergreen\.brief|data-jump="evergreenTab"|jump:"evergreenTab"/);
  { const vm = await import("node:vm"), box = {}; vm.createContext(box);
    vm.runInContext("const esc=v=>String(v??'');const usd=(v,d)=>'USD '+Number(v).toFixed(d);" + html.slice(html.indexOf("/* day-brief:start */"), html.indexOf("/* day-brief:end */")) + ";globalThis.I=dayBriefItems;", box);
    assert.deepEqual(plain(box.I({ evergreen: { notice: "2026-12-31", days: 41 } })), []); }
  // Nothing here reaches the ledger, a draft, a publication or the network.
  assert.doesNotMatch(calendarBlock, /changeDraft|EDIT\.|saveLedger|publish|gist|fetch\(|ghApi|ratioCore|deriveManager/i);
  // The desk feeds the calendar the printed lot amounts and first-purchase dates.
  assert.match(html, /const lotList=lots\?Array\.from\(lots\.querySelectorAll\('li'\)\)\.map\(x=>\(\{amount:x\.querySelector\('\.ratio-holding-lot-amount'\)\?\.textContent\|\|'',date:since\(x\)\}\)\):\[\{amount,date:since\(single\)\}\];/);
});
// dealing-offset:v1 — real terms 2026-11-20: two funds deal on a month-end other than the quarter's last one.
test("a dealing day can sit a whole number of months before or after the period end", async () => {
  const { c } = await calendarBox();
  // The month before each quarter-end: February, May, August, November.
  for (const [from, want] of [["2026-11-20", "2026-11-30"], ["2026-12-01", "2027-02-28"], ["2027-02-28", "2027-02-28"], ["2027-03-01", "2027-05-31"], ["2028-01-15", "2028-02-29"]])
    assert.equal(c.evergreenDealingDay(from, "quarterly", -1), want, from);
  // Two months before, i.e. the first month of each quarter: January, April, July, October.
  for (const [from, want] of [["2026-11-20", "2027-01-31"], ["2027-01-31", "2027-01-31"], ["2027-02-01", "2027-04-30"], ["2026-10-31", "2026-10-31"]])
    assert.equal(c.evergreenDealingDay(from, "quarterly", -2), want, from);
  assert.equal(c.evergreenDealingDay("2026-11-20", "quarterly", 1), "2027-01-31"); assert.equal(c.evergreenDealingDay("2026-11-20", "annual", -1), "2026-11-30");
  // No offset, or a malformed one, is the plain period end as before.
  for (const offset of [undefined, 0, 1.5, "x", null]) assert.equal(c.evergreenDealingDay("2026-11-20", "quarterly", offset), "2026-12-31");
  assert.deepEqual(plain(c.evergreenTermsClean({ frequency: "quarterly", dealingOffsetMonths: -1 })), { frequency: "quarterly", dealingOffsetMonths: -1 });
  for (const bad of [0, 12, -12, 0.5, "1"]) assert.deepEqual(plain(c.evergreenTermsClean({ dealingOffsetMonths: bad })), {});
  // The lot plan and the sheet follow it: notice counted back from the moved dealing day.
  const terms = { frequency: "quarterly", noticeDays: 14, dealingOffsetMonths: -1, softLockMonths: 12, earlyFeePct: 2, settlementDays: 10 };
  const plan = c.evergreenLotPlan("2024-04-01", terms, "2026-11-20");
  assert.equal(plan.dealing, "2027-02-28"); assert.equal(plan.notice, "2027-02-14"); assert.equal(plan.cash, "2027-03-10"); assert.equal(plan.status, "free");
  assert.equal(c.evergreenLotPlan("2024-04-01", terms, "2026-11-10").dealing, "2026-11-30");
  const view = c.evergreenTermsView({ lotList: [{ amount: "USD 1.00", date: "2024-04-01" }] }, terms, "2026-11-20");
  assert.ok(view.includes("<dt>赎回日</dt><dd>期末前 1 个月的月底</dd>")); assert.ok(view.includes("通知截止 2027-02-14 → 赎回日 2027-02-28"));
  assert.ok(c.evergreenTermsView({ lotList: [] }, { frequency: "quarterly" }, "2026-11-20").includes("<dt>赎回日</dt><dd>-</dd>"));
});
test("fields on the evergreen page are 16px so an iPhone does not enlarge the page when one is tapped", () => {
  assert.match(html, /\.evergreen-sheet input\{font-size:16px\}\.evergreen-pack-text\{width:100%;margin-top:8px;font:16px\/1\.4 ui-monospace,Menlo,monospace;/);
});

// pack-auto-import:v1 — owner's real use 2026-11-20: a pasted pack waited for a second tap and was lost twice.
test("a pasted valid terms pack is imported at once; anything else waits for the button", async () => {
  assert.match(html, /document\.addEventListener\('input',event=>\{\n  const area=event\.target\?\.closest\?\.\('\[data-evergreen-pack-text\]'\);if\(!area\)return;\n  const text=area\.value;if\(!evergreenPackRead\(text\)\.ok\)return;\n  _evergreenPackOpen=true;_evergreenPackMessage=evergreenPackApply\(text\);renderEvergreenDesk\(document\.getElementById\('ratioContent'\)\);\n\}\);/);
  const { c } = await calendarBox();
  // The same strict reader decides: a half-typed or foreign text is not a pack, so nothing is imported for it.
  for (const partial of ["{", '{"schema":"fee-console.evergreen-pack.v1","funds":[', "hello", '{"schema":"other","funds":[]}']) assert.equal(c.evergreenPackRead(partial).ok, false);
  assert.equal(c.evergreenPackRead('{"schema":"fee-console.evergreen-pack.v1","funds":[{"key":"P|A","terms":{"frequency":"quarterly","noticeDays":30}}]}').ok, true);
  const view = c.evergreenPackView(true, "");
  assert.ok(view.includes("粘贴进有效的条款包会自动导入，不用再点按钮")); assert.ok(view.includes('placeholder="把填好的条款包文本粘贴在这里，会自动导入"'));
  assert.ok(view.includes('data-evergreen-pack="import"'), "the button stays for text typed by hand");
});

// evergreen-profile:v1 — owner request 2026-11-20, third step: what each fund is, dated updates, the owner's own
// document links, and a reading list. Everything arrives in the pack and is cleaned on the way in.
const profileFund = {
  key: "P|A",
  profile: { asOf: "2026-04-30", source: "Fact Sheet <b>", summary: "投资全球<私募>股权。", size: "US$6.9bn", junk: 1, manager: "Manager <M>", inception: "2024-01", returnYtd: 4.2, return1y: "9", returnSi: 5000000,
    strategy: [{ name: "Buyout", pct: 62.5 }, { name: "Secondaries", pct: 6 }, { name: "", pct: 5 }, { name: "No pct" }, { name: "Bad", pct: 250 }],
    sector: "x", region: [{ name: "North America", pct: 74 }], holdings: Array.from({ length: 14 }, (_, i) => ({ name: "H" + i, pct: i })) },
  links: [{ title: "Prospectus", url: "https://drive.google.com/file/d/abc/view" }, { title: "Script", url: "javascript:alert(1)" }, { title: "Plain", url: "http://example.com/a" },
    { title: "Quote", url: 'https://example.com/"onclick="x' }, { title: "", url: "https://example.com/ok" }, { title: "Local", url: "https://localhost/x" }],
  assessment: { date: "2026-11-21", sections: [{ title: "流动性", text: "上季赎回申请<全额>兑付。" }, { title: "", text: "x" }, { title: "No text" }], sources: ["季报 <p3>", "", 5] },
  updates: [{ date: "2026-03-01", text: "old" }, { date: "2026-09-30", text: "赎回申请超过上限，按比例兑付。", source: "季报 <p3>" }, { date: "soon", text: "x" }, { date: "2026-06-01", text: "" },
    { date: "2026-05-01", text: "mid" }, { date: "2026-01-01", text: "oldest" }],
};
test("a fund's profile keeps only well-formed values and shows one fixed frame of fields, dashes where empty", async () => {
  const { c } = await calendarBox(), clean = plain(c.evergreenProfileClean(profileFund));
  assert.deepEqual(Object.keys(clean), ["source", "summary", "size", "manager", "inception", "asOf", "returnYtd", "strategy", "region", "holdings", "updates", "assessment"]);
  assert.deepEqual(clean.assessment, { date: "2026-11-21", sections: [{ title: "流动性", text: "上季赎回申请<全额>兑付。" }], sources: ["季报 <p3>"] });
  assert.equal(c.evergreenProfileClean({ assessment: { date: "soon", sections: [{ title: "a", text: "b" }] } }).assessment, undefined);
  assert.deepEqual(clean.strategy, [{ name: "Buyout", pct: 62.5 }, { name: "Secondaries", pct: 6 }, { name: "No pct" }, { name: "Bad" }]);
  assert.equal(clean.holdings.length, 10);
  assert.deepEqual(clean.updates.map(u => u.date), ["2026-09-30", "2026-05-01", "2026-03-01"]);
  for (const bad of ["javascript:alert(1)", "http://example.com", "https://localhost/x", "https://example.com/a b", 'https://example.com/"', "https://example.com/<x>", "//example.com", "", null, 5, "https://" + "a".repeat(600) + ".com"])
    assert.equal(c.evergreenUrl(bad), "", String(bad).slice(0, 30));
  assert.equal(c.evergreenUrl("https://www.reuters.com/commentary/breakingviews/x-2026-09-23/"), "https://www.reuters.com/commentary/breakingviews/x-2026-09-23/");
  assert.deepEqual(plain(c.evergreenProfileClean({})), {}); assert.deepEqual(plain(c.evergreenProfileClean(null)), {}); assert.deepEqual(plain(c.evergreenProfileClean({ profile: [1] })), {});
  const view = c.evergreenProfileView(c.evergreenProfileClean(profileFund));
  for (const text of ["<h3>基金概况</h3>", '<p class="evergreen-summary">投资全球&lt;私募&gt;股权。</p>', "<dt>管理人</dt><dd>Manager &lt;M&gt;</dd>", "<dt>成立时间</dt><dd>2024-01</dd>", "<dt>基金规模</dt><dd>US$6.9bn</dd>",
    "<dt>持仓数量</dt><dd>-</dd>", "<dt>杠杆</dt><dd>-</dd>", "<dt>今年以来</dt><dd>4.2%</dd>", "<dt>近一年</dt><dd>-</dd>", "<dt>成立以来年化</dt><dd>-</dd>", "<h4>策略分布</h4>", '<i style="width:62.5%"></i></span><b>62.5%</b>', "<li><span>No pct</span></li>",
    '<h4>行业分布</h4><p class="evergreen-meta">-</p>', "<h4>地区分布</h4>", "<h4>主要持仓</h4>", "资料截至 2026-04-30 · Fact Sheet &lt;b&gt;", "<h3>最新动态</h3>", "<b>2026-09-30</b><span>赎回申请超过上限，按比例兑付。</span><small>季报 &lt;p3&gt;</small>"])
    assert.ok(view.includes(text), text);
  assert.equal(view.includes("javascript:"), false); assert.equal(view.includes("<p3>"), false);
  // field-frame:v1 (owner request 2026-11-21): a fund with nothing filled shows the same frame, all dashes, and filed documents are not linked.
  const empty = c.evergreenProfileView(undefined);
  assert.equal(empty, c.evergreenProfileView({})); assert.equal((empty.match(/<dd>-<\/dd>/g) || []).length, 8); assert.equal((empty.match(/<p class="evergreen-meta">-<\/p>/g) || []).length, 5);
  assert.ok(empty.includes('<p class="evergreen-summary">-</p>')); assert.equal(view.includes("<h3>文件</h3>"), false); assert.equal(view.includes("<a "), false);
  for (const label of ["管理人", "成立时间", "基金规模", "持仓数量", "杠杆", "今年以来", "近一年", "成立以来年化", "策略分布", "行业分布", "地区分布", "主要持仓", "最新动态"]) assert.ok(empty.includes(label), label);
  // The assessment for a pending fund: dated, escaped, with its sources, and it says it is not a recommendation.
  const report = c.evergreenAssessmentView(c.evergreenProfileClean(profileFund));
  for (const text of ['<details class="evergreen-assessment" open><summary>评估报告 · 2026-11-21</summary>', "<h4>流动性</h4><p>上季赎回申请&lt;全额&gt;兑付。</p>", "<h4>依据</h4><ul><li>季报 &lt;p3&gt;</li></ul>", "不是买卖或赎回建议"]) assert.ok(report.includes(text), text);
  assert.equal(c.evergreenAssessmentView({}), ""); assert.equal(c.evergreenAssessmentView(undefined), "");
});
test("the reading list is cleaned, newest first, and says it is about the product type, not a holding", async () => {
  const { c } = await calendarBox();
  const list = plain(c.evergreenReadingClean([
    { title: "Old piece", source: "FT", date: "2026-03-01", url: "https://www.ft.com/content/x", takeaway: "t", tags: ["估值", "赎回限额", "x".repeat(20), "a", "b"] },
    { title: "Buyout barons' forever funds", source: "Reuters Breakingviews", date: "2026-09-23", url: "https://www.reuters.com/commentary/breakingviews/y/", takeaway: "<要点>" },
    { title: "No link", url: "ftp://x" }, { title: "", url: "https://example.com/a" }, null]));
  assert.deepEqual(list.map(x => x.title), ["Buyout barons' forever funds", "Old piece"]);
  assert.deepEqual(list[1].tags, ["估值", "赎回限额", "x".repeat(12), "a"]); assert.deepEqual(list[0].tags, []);
  const view = c.evergreenReadingView(list);
  assert.ok(view.includes("<h2>阅读清单</h2>")); assert.ok(view.includes("不针对你的任何一只持仓"));
  assert.ok(view.includes('<a href="https://www.reuters.com/commentary/breakingviews/y/" target="_blank" rel="noopener noreferrer">Buyout barons&#39; forever funds</a><small>Reuters Breakingviews · 2026-09-23</small><p>&lt;要点&gt;</p>'));
  assert.ok(view.includes('<span class="evergreen-tags"><i>估值</i><i>赎回限额</i>'));
  assert.equal(c.evergreenReadingView([]), ""); assert.deepEqual(plain(c.evergreenReadingClean("x")), []);
});
test("one pack may carry terms, profiles, labels and the reading list, and the page says which arrived", async () => {
  const { c, memory } = await calendarBox();
  const text = JSON.stringify({ schema: "fee-console.evergreen-pack.v1", funds: [profileFund, { key: "P|B", terms: { frequency: "quarterly", noticeDays: 30 } }, { key: "P|C", label: { state: "redeeming", note: "等回款" } }],
    reading: [{ title: "T", url: "https://example.com/t", date: "2026-09-23" }] });
  const read = c.evergreenPackRead(text);
  assert.equal(read.ok, true); assert.deepEqual(Object.keys(plain(read.profiles)), ["P|A"]); assert.deepEqual(Object.keys(plain(read.terms)), ["P|B"]); assert.deepEqual(Object.keys(plain(read.labels)), ["P|C"]); assert.equal(read.reading.length, 1);
  assert.equal(c.evergreenPackApply(text), "已导入 0 只基金的条款、1 只基金的资料、1 只基金的状态、阅读清单 1 篇；另有 1 只的名称与当前持仓对不上，已保存但不会显示。");
  assert.deepEqual(Object.keys(plain(c.evergreenProfiles())), ["P|A"]); assert.equal(c.evergreenReading().length, 1);
  assert.equal(JSON.parse(memory.get("feeConsole.evergreen.profile.v1"))["P|A"].links, undefined); assert.equal(c.evergreenProfiles()["P|A"].assessment.date, "2026-11-21");
  // A labels-only pack no longer claims to have imported terms, and an empty one says so.
  assert.equal(c.evergreenPackApply(JSON.stringify({ schema: "fee-console.evergreen-pack.v1", funds: [{ key: "P|C", label: { state: "hold" } }] })), "已导入 1 只基金的状态。");
  assert.equal(c.evergreenPackApply(JSON.stringify({ schema: "fee-console.evergreen-pack.v1", funds: [{ key: "P|C" }] })), "文本里没有可导入的内容。");
  // A later pack for one fund leaves the others and the reading list as they were.
  c.evergreenPackApply(JSON.stringify({ schema: "fee-console.evergreen-pack.v1", funds: [{ key: "P|Z", profile: { summary: "z" } }] }));
  assert.deepEqual(Object.keys(plain(c.evergreenProfiles())).sort(), ["P|A", "P|Z"]); assert.equal(c.evergreenReading().length, 1);
  // The export carries profiles and the reading list back out, still without any amount.
  const out = c.evergreenPackBuild([{ key: "P|A", name: "A", platform: "P", strategy: "S", amount: "USD 123.45", lotList: [] }], {}, {}, "2026-11-20", c.evergreenProfiles(), c.evergreenReading());
  assert.equal(out.funds[0].profile.size, "US$6.9bn"); assert.equal(out.funds[0].links, undefined); assert.equal(out.funds[0].assessment.sections.length, 1); assert.equal(out.funds[0].profile.assessment, undefined); assert.equal(out.funds[0].updates.length, 3); assert.equal(out.reading.length, 1);
  assert.equal(JSON.stringify(out).includes("123.45"), false);
  // Damaged storage reads as empty.
  memory.set("feeConsole.evergreen.profile.v1", "[1]"); memory.set("feeConsole.evergreen.reading.v1", "{broken");
  assert.deepEqual(plain(c.evergreenProfiles()), {}); assert.deepEqual(plain(c.evergreenReading()), []);
});
test("profiles and the reading list stay on the device, are shown in the sheet and page, and fetch nothing", () => {
  assert.ok(profileBlock.length > 1000);
  assert.doesNotMatch(profileBlock, /changeDraft|EDIT\.|saveLedger|writeRemote|ghRead|fetch\(|ghApi|ratioCore|deriveManager|XMLHttpRequest|innerHTML/i);
  assert.match(html, /\+\(x\.termsHtml\|\|'<p class="evergreen-meta">尚未录入条款。在页面底部“条款包”里导入后显示。<\/p>'\)\+\(x\.profileHtml\|\|''\)/);
  assert.match(html, /fund\.profileHtml=evergreenProfileView\(profiles\[fund\.key\]\);/);
  assert.match(html, /evergreenDeskView\(model,_evergreenFilter,_evergreenOpen\)\+evergreenReadingView\(evergreenReading\(\)\)\+evergreenRemoteView\(evergreenStored\(EVERGREEN_REMOTE_KEY,\{\}\)\)\+evergreenPackView\(/);
  // Every link the block writes opens in a new tab without handing the page to it.
  assert.equal((profileBlock.match(/<a href=/g) || []).length, 1); assert.equal((profileBlock.match(/target="_blank" rel="noopener noreferrer"/g) || []).length, 1);
  assert.match(html, /fund\.assessmentHtml=evergreenAssessmentView\(profiles\[fund\.key\]\);/); assert.ok(html.includes("+(x.pending?due(x.pending):'')+(x.assessmentHtml||'')"));
});

// evergreen-remote:v1 (owner request 2026-11-21): fund facts sealed on the owner's computer are opened by the device's
// own key, cleaned by the pack reader and merged; nobody else can read them and they never carry a status label.
test("a sealed evergreen pack opens only with the device key, merges field by field and never sets a label", async () => {
  const vm = await import("node:vm"), subtle = globalThis.crypto.subtle;
  // What the owner's computer does before storing the file: an ephemeral X25519 key, HKDF-SHA256 and AES-256-GCM,
  // bound to the recipient and the time. It needs only the public recipient record.
  const sealEvergreenPack = async (text, r, generatedAt) => {
    const b64 = b => Buffer.from(b).toString("base64url"), eph = await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
    const peer = await subtle.importKey("raw", Buffer.from(r.publicKey, "base64url"), { name: "X25519" }, false, []);
    const shared = await subtle.deriveBits({ name: "X25519", public: peer }, eph.privateKey, 256), salt = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
    const info = new TextEncoder().encode(["fee-console/evergreen-pack/v1", r.scopeId, r.recipientId, generatedAt].join("|"));
    const key = await subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info }, await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]), { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    return JSON.stringify({ schema: "fee-console.evergreen-sealed.v1", algorithm: "X25519-HKDF-SHA256-AES256GCM", scopeId: r.scopeId, recipientId: r.recipientId, generatedAt, ephemeralPublicKey: b64(await subtle.exportKey("raw", eph.publicKey)),
      salt: b64(salt), iv: b64(iv), ciphertext: b64(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: info }, key, new TextEncoder().encode(text))) });
  };
  const pair = await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]), other = await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  const recipient = { schema: "r", algorithm: "X25519-HKDF-SHA256-AES256GCM", scopeId: "a".repeat(64), recipientId: "b".repeat(64), publicKey: Buffer.from(await subtle.exportKey("raw", pair.publicKey)).toString("base64url") };
  const pack = JSON.stringify({ schema: "fee-console.evergreen-pack.v1", funds: [{ key: "P|A", profile: { manager: "新管理人" }, terms: { noticeDays: 30 } }] });
  const sealed = await sealEvergreenPack(pack, recipient, "2026-11-22T02:00:00.000Z");
  assert.equal(sealed.includes("新管理人"), false); assert.equal(sealed.includes("P|A"), false);
  const memory = new Map([["feeConsole.evergreen.profile.v1", JSON.stringify({ "P|A": { summary: "原有简介", manager: "旧" } })], ["feeConsole.evergreen.terms.v1", JSON.stringify({ "P|A": { frequency: "quarterly", noticeDays: 45 } })],
    ["feeConsole.evergreen.labels.v1", JSON.stringify({ "P|A": { state: "watch" } })]]);
  const box = { URL, TextEncoder, TextDecoder, Uint8Array, crypto: globalThis.crypto, store: { getItem: k => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v), removeItem: k => memory.delete(k) } }; vm.createContext(box);
  const remoteBlock = html.slice(html.indexOf("/* evergreen-remote:v1:start */"), html.indexOf("/* evergreen-remote:v1:end */"));
  vm.runInContext('const todayStr=()=>"2026-11-22";' + profileBlock + "\n" + calendarBlock + "\n" + evergreenBlock + "\n" + remoteBlock + ";globalThis.r={evergreenRemoteOpen,evergreenRemoteTake,evergreenRemoteView,evergreenPackApply};", box);
  const opened = await box.r.evergreenRemoteOpen(sealed, pair.privateKey, recipient);
  assert.equal(opened.text, pack); assert.equal(opened.generatedAt, "2026-11-22T02:00:00.000Z");
  // Another key, another recipient, a changed time or a flipped byte all refuse.
  await assert.rejects(box.r.evergreenRemoteOpen(sealed, other.privateKey, recipient));
  await assert.rejects(box.r.evergreenRemoteOpen(sealed, pair.privateKey, { ...recipient, recipientId: "c".repeat(64) }));
  await assert.rejects(box.r.evergreenRemoteOpen(sealed.replace("02:00:00", "03:00:00"), pair.privateKey, recipient));
  await assert.rejects(box.r.evergreenRemoteOpen(JSON.stringify({ ...JSON.parse(sealed), extra: 1 }), pair.privateKey, recipient)); await assert.rejects(box.r.evergreenRemoteOpen("{}", pair.privateKey, recipient));
  // Taking it merges into what the fund already has, leaves the owner's label alone, and happens once.
  assert.equal(await box.r.evergreenRemoteTake({ content: sealed }, pair.privateKey, recipient), true);
  assert.deepEqual(JSON.parse(memory.get("feeConsole.evergreen.profile.v1"))["P|A"], { summary: "原有简介", manager: "新管理人" });
  assert.deepEqual(JSON.parse(memory.get("feeConsole.evergreen.terms.v1"))["P|A"], { frequency: "quarterly", noticeDays: 30 });
  assert.deepEqual(JSON.parse(memory.get("feeConsole.evergreen.labels.v1")), { "P|A": { state: "watch" } });
  assert.deepEqual(JSON.parse(memory.get("feeConsole.evergreen.remote.v1")), { generatedAt: "2026-11-22T02:00:00.000Z" });
  assert.equal(await box.r.evergreenRemoteTake({ content: sealed }, pair.privateKey, recipient), false, "the same pack is not taken twice");
  assert.equal(await box.r.evergreenRemoteTake({ content: await sealEvergreenPack(pack, recipient, "2026-11-21T02:00:00.000Z") }, pair.privateKey, recipient), false, "an older pack is ignored");
  for (const bad of [null, { truncated: true, content: sealed }, { content: 5 }, { content: "{broken" }]) assert.equal(await box.r.evergreenRemoteTake(bad, pair.privateKey, recipient), false);
  assert.ok(box.r.evergreenRemoteView({ generatedAt: "2026-11-22T02:00:00.000Z" }).includes("基金资料自动更新于 2026-11-22")); assert.equal(box.r.evergreenRemoteView({}), ""); assert.equal(box.r.evergreenRemoteView({ generatedAt: "<b>" }), "");
  // A sealed pack that carries a label anyway has it dropped.
  assert.equal(await box.r.evergreenRemoteTake({ content: await sealEvergreenPack(JSON.stringify({ schema: "fee-console.evergreen-pack.v1", funds: [{ key: "P|A", profile: { leverage: "无" }, label: { state: "redeeming" } }] }), recipient, "2026-11-23T02:00:00.000Z") }, pair.privateKey, recipient), true);
  assert.deepEqual(JSON.parse(memory.get("feeConsole.evergreen.labels.v1")), { "P|A": { state: "watch" } });
  // A pasted pack merges the same way, and may still carry labels.
  assert.equal(box.r.evergreenPackApply(JSON.stringify({ schema: "fee-console.evergreen-pack.v1", funds: [{ key: "P|A", profile: { size: "$1B" }, label: { state: "hold" } }] })), "已导入 1 只基金的资料、1 只基金的状态。");
  assert.deepEqual(JSON.parse(memory.get("feeConsole.evergreen.profile.v1"))["P|A"], { summary: "原有简介", size: "$1B", manager: "新管理人", leverage: "无" });
  // The block only reads: it writes nothing remote and is reached from the snapshot read without being awaited.
  assert.doesNotMatch(remoteBlock, /atob|fetch\(|ghApi|PATCH|XMLHttpRequest|innerHTML|saveLedger|EDIT\./);
  assert.ok(html.includes("try{evergreenRemoteTake(gist.files[EVERGREEN_REMOTE_FILE],manager.privateKey,manager.recipient).catch(()=>{});}catch{}"));
});
