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
  assert.match(tabs, /<button data-p="p-ratio" class="mgr" id="evergreenTab" data-view="evergreen" hidden>基金<\/button>\n  <button data-p="p-ratio" class="mgr" id="ratioTab" hidden>资产配置<\/button>/);
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
  assert.deepEqual(JSON.parse(JSON.stringify(t.evergreenLabelClean({ state: "sell-now", note: "x".repeat(400), reviewBy: "soon", updatedAt: "2026-11-20", extra: 1 }))),
    { state: "", note: "x".repeat(300), reviewBy: "", updatedAt: "2026-11-20", decided: "" });
  assert.deepEqual(JSON.parse(JSON.stringify(t.evergreenLabelClean(null))), { state: "", note: "", reviewBy: "", updatedAt: "", decided: "" });
  const labels = { "P|Fund <A>": { state: "watch", note: "wait <b>", reviewBy: "2026-11-01", updatedAt: "2026-10-01" }, "Q|Fund C": { state: "hold", reviewBy: "2026-12-31" } };
  const model = t.evergreenDeskModel(evergreenRows, labels, "2026-11-20");
  assert.deepEqual(JSON.parse(JSON.stringify(model.counts)), { all: 3, none: 1, pending: 0, hold: 1, watch: 1, prepare: 0, partial: 0, redeeming: 0 });
  // Owner request 2026-11-24: 部分赎回 joins the states, and the review date is gone: a stored one marks nothing.
  assert.deepEqual(plain(t.EVERGREEN_STATES), [["hold", "持有"], ["watch", "观察"], ["prepare", "准备赎回"], ["partial", "部分赎回"], ["redeeming", "赎回中"]]);
  assert.equal(model.platforms, 2); assert.equal("overdue" in model, false);
  assert.deepEqual(model.funds.map(x => [x.stateName, "overdue" in x]), [["观察", false], ["未标记", false], ["持有", false]]);
  const view = t.evergreenDeskView(model, "all", new Set(["P|Fund B"]));
  assert.match(view, /3 只基金 · 2 个平台<\/p>/); assert.equal(/复核/.test(view), false); assert.equal(view.includes("data-evergreen-review"), false);
  // Only states in use get a filter chip; names and notes are escaped; figures come through as the report printed them.
  assert.deepEqual([...view.matchAll(/data-evergreen-filter="(\w+)" aria-pressed="(\w+)">([^<]+)</g)].map(m => m.slice(1)), [["all", "true", "全部 3"], ["none", "false", "未标记 1"], ["hold", "false", "持有 1"], ["watch", "false", "观察 1"]]);
  assert.ok(view.includes("<strong>Fund &lt;A&gt;</strong>")); assert.equal(view.includes("<b>"), false);
  // The note is a full-width box of up to 300 characters.
  assert.ok(view.includes('<textarea class="evergreen-note" data-evergreen-note maxlength="300" rows="2" placeholder="例如：等下一份季报">wait &lt;b&gt;</textarea>'));
  // fund-tabs:v1 — a sheet shows one tab at a time; the first is 状态, and 评估 appears only for a fund that has one.
  const tabsOf = v => [...v.matchAll(/data-evergreen-tab="(\w+)" aria-pressed="(\w+)">([^<]+)</g)].slice(0, 6).map(m => m.slice(1).join(" "));
  assert.deepEqual(tabsOf(view), ["status true 状态", "position false 持仓", "terms false 条款", "profile false 概况", "mix false 分布", "news false 动态"]);
  assert.equal((view.match(/data-evergreen-panel="status"/g) || []).length, 3); assert.equal(view.includes('<ul class="evergreen-lots">'), false);
  const position = t.evergreenDeskView(model, "all", new Set(), "all", "position");
  assert.equal((position.match(/data-evergreen-panel="position"/g) || []).length, 3); assert.equal(position.includes("data-evergreen-state"), false);
  assert.ok(position.includes('<ul class="evergreen-lots"><li>x</li></ul>')); assert.ok(position.includes('<span class="ratio-holding-yield">y</span>'));
  assert.ok(position.includes("此快照未包含这只基金的收益率。")); assert.ok(view.includes("P · S1 · 3 笔"));
  assert.ok(t.evergreenDeskView(model, "all", new Set(), "all", "terms").includes("尚未录入条款。在页面底部“条款包”里导入后显示。"));
  assert.equal(tabsOf(t.evergreenDeskView(model, "all", new Set(), "all", "assessment"))[0], "status true 状态", "a tab the fund lacks falls back to 状态");
  model.funds[0].assessmentHtml = "<i>report</i>";
  const assessed = t.evergreenDeskView(model, "all", new Set(), "all", "assessment");
  assert.ok(assessed.includes('data-evergreen-tab="assessment" aria-pressed="true">评估<')); assert.ok(assessed.includes('data-evergreen-panel="assessment"><i>report</i>'));
  delete model.funds[0].assessmentHtml;
  assert.ok(t.evergreenDeskView(model, "all", new Set(), "all", "status", "<aside>cash</aside>").includes("<aside>cash</aside><div class=\"evergreen-filter\" role=\"group\" aria-label=\"按状态筛选\">"));
  assert.match(html, /if\(tabButton\)\{_evergreenTab=tabButton\.getAttribute\('data-evergreen-tab'\);/);
  assert.match(view, /<details class="evergreen-fund" data-evergreen-key="P\|Fund B" open>/);
  assert.equal((view.match(/<details class="evergreen-fund"/g) || []).length, 3);
  assert.ok(view.includes('data-state="watch">观察<')); assert.ok(view.includes("本页不提供买卖或赎回建议"));
  for (const amount of ["USD 100.00", "USD 99.00", "USD 98.00"]) assert.ok(view.includes(amount));
  // A filter narrows the list; an empty snapshot says so.
  const watch = t.evergreenDeskView(model, "watch", new Set());
  assert.equal((watch.match(/<details class="evergreen-fund"/g) || []).length, 1); assert.ok(watch.includes("Fund &lt;A&gt;"));
  assert.ok(t.evergreenDeskView(model, "prepare", new Set()).includes("这个状态下没有基金。"));
  assert.ok(t.evergreenDeskView(t.evergreenDeskModel([], {}, "2026-11-20"), "all", new Set()).includes("此快照未包含常青基金或对冲基金的持仓明细。"));
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
  vm.runInContext(profileBlock + "\n" + calendarBlock + "\n" + evergreenBlock + ";globalThis.c={evergreenBySize,evergreenProfileClean,evergreenReadingClean,evergreenProfiles,evergreenReading,evergreenProfileParts,evergreenProfileView,evergreenReadingView,evergreenUrl,evergreenPackApply,evergreenTermsClean,evergreenTerms,evergreenAddMonths,evergreenAddDays,evergreenDaysBetween,evergreenDealingDay,evergreenLotPlan,evergreenCents,evergreenUsd,evergreenQuarter,evergreenWeek,evergreenPending,evergreenShares,evergreenAssessmentView,evergreenTermsView,evergreenPackBuild,evergreenPackRead,evergreenPackView};", box);
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
  // manager-peers:v1 — a fund's manager beside comparable managers: named columns, labelled rows, folded until tapped.
  {const peers = { columns: ["Alpha", "Beta <b>", "Gamma"], own: "Alpha", asOf: "2026-11-25", note: "三家同类。", source: "synthetic", junk: 1, rows: [{ label: "总部", values: ["甲地", "乙地", "丙地", "多余"] }, { label: "规模", values: ["1", "", 7] }, { label: "", values: ["x", "y", "z"] }, { label: "空行", values: ["", "", ""] }] };
    const got = plain(c.evergreenProfileClean({ profile: { peers } }));
    assert.deepEqual(got, { peers: { columns: ["Alpha", "Beta <b>", "Gamma"], rows: [{ label: "总部", values: ["甲地", "乙地", "丙地"] }, { label: "规模", values: ["1", "", ""] }], note: "三家同类。", source: "synthetic", own: "Alpha", asOf: "2026-11-25" } });
    for (const bad of [{ columns: ["only"], rows: peers.rows }, { columns: ["a", ""], rows: peers.rows }, { columns: ["a", "b"], rows: [] }, [1], "x"]) assert.deepEqual(plain(c.evergreenProfileClean({ profile: { peers: bad } })), {});
    assert.equal(c.evergreenProfileClean({ profile: { peers: { ...peers, asOf: "soon" } } }).peers.asOf, undefined);
    const parts = c.evergreenProfileParts(c.evergreenProfileClean({ profile: { summary: "s", peers } }));
    assert.ok(parts.peers.startsWith('<details class="evergreen-peers"><summary>管理人对比 · Alpha／Beta &lt;b&gt;／Gamma</summary><p class="evergreen-summary">三家同类。</p><table><thead><tr><th></th><th data-own="true">Alpha</th><th>Beta &lt;b&gt;</th><th>Gamma</th></tr></thead>'));
    assert.ok(parts.peers.includes('<tr><th>规模</th><td data-own="true">1</td><td>-</td><td>-</td></tr>')); assert.ok(parts.peers.endsWith('<p class="evergreen-meta">整理于 2026-11-25 · synthetic</p></details>'));
    assert.equal(c.evergreenProfileParts(c.evergreenProfileClean({ profile: { summary: "s" } })).peers, ""); assert.ok(c.evergreenProfileView(c.evergreenProfileClean({ profile: { summary: "s", peers } })).includes('</dl><details class="evergreen-peers">'));
    assert.match(html, /profile:x=>\(x\.profile\?\.summary\|\|'<p class="evergreen-meta">-<\/p>'\)\+\(x\.profile\?\.peers\|\|''\)\+\(x\.profile\?\.meta\|\|''\),/);}
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
  assert.ok(html.includes("profile:x=>(x.profile?.summary||'<p class=\"evergreen-meta\">-</p>')+(x.profile?.peers||'')+(x.profile?.meta||''),"));
  assert.match(html, /fund\.profile=evergreenProfileParts\(profiles\[fund\.key\],fund\.own,fund\.kind\);/);
  assert.match(html, /evergreenDeskView\(model,_evergreenFilter,_evergreenOpen,_evergreenKind,_evergreenTab,''\)\+evergreenReadingView\(evergreenReading\(\)\)\+evergreenRemoteView\(evergreenStored\(EVERGREEN_REMOTE_KEY,\{\}\)\)\+\(typeof evergreenSyncView==='function'\?evergreenSyncView\(evergreenSyncStamps\(\),_evergreenSyncNote\):''\)\+evergreenPackView\(/);
  // Every link the block writes opens in a new tab without handing the page to it.
  assert.equal((profileBlock.match(/<a href=/g) || []).length, 1); assert.equal((profileBlock.match(/target="_blank" rel="noopener noreferrer"/g) || []).length, 1);
  assert.match(html, /fund\.assessmentHtml=evergreenAssessmentView\(profiles\[fund\.key\]\);/); assert.ok(html.includes("assessment:x=>x.assessmentHtml||''};"));
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

// own-figures:v1 (owner request 2026-11-21): the page works out each fund's share of the evergreen total from the
// printed amounts, and where a fund has published no return the owner's own Sharesight figure stands in, marked.
test("each fund shows its share of the evergreen total, and the owner's own return fills an unpublished one", async () => {
  const { c } = await calendarBox(), { t: d } = await evergreenBox();
  const rows = [{ key: "P|A", amount: "USD 600.00" }, { key: "P|B", amount: "USD 300.00" }, { key: "P|C", amount: "USD 100.00" }];
  assert.deepEqual(plain(c.evergreenShares(rows)), { "P|A": "60.0%", "P|B": "30.0%", "P|C": "10.0%" });
  assert.deepEqual(plain(c.evergreenShares([{ key: "P|A", amount: "USD 1.00" }, { key: "P|B", amount: "USD 2.00" }])), { "P|A": "33.3%", "P|B": "66.7%" });
  // One unreadable amount, no rows or a zero total: no share at all rather than a wrong one.
  assert.deepEqual(plain(c.evergreenShares([...rows, { key: "P|D", amount: "未取得" }])), {}); assert.deepEqual(plain(c.evergreenShares([])), {}); assert.deepEqual(plain(c.evergreenShares([{ key: "P|A", amount: "USD 0.00" }])), {});
  const model = d.evergreenDeskModel([{ key: "P|A", name: "A", platform: "P", strategy: "S", amount: "USD 600.00", lots: 1, lotList: [] }], {}, "2026-11-21");
  model.funds[0].share = "60.0%";
  const view = d.evergreenDeskView(model, "all", new Set(["P|A"]));
  assert.ok(view.includes("<small>P · S · 占常青 60.0%</small>")); assert.ok(d.evergreenDeskView(model, "all", new Set(["P|A"]), "all", "position").includes("<span>P · S · 占常青合计 60.0%</span><span>USD 600.00</span>"));
  model.funds[0].share = ""; assert.equal(d.evergreenDeskView(model, "all", new Set()).includes("占常青"), false);
  // The frame: a published return wins; otherwise the owner's own figure, marked as theirs; otherwise a dash.
  const own = { all: { value: "8.19%", note: "年化" }, year: { value: "7.94%", note: "" } };
  const filled = c.evergreenProfileView({}, own);
  assert.ok(filled.includes("<dt>近一年</dt><dd>7.94%（你的）</dd>")); assert.ok(filled.includes("<dt>成立以来年化</dt><dd>8.19%（你的，自买入，年化）</dd>")); assert.ok(filled.includes("<dt>今年以来</dt><dd>-</dd>"));
  const published = c.evergreenProfileView({ return1y: 18.2, returnSi: 17.1 }, own);
  assert.ok(published.includes("<dt>近一年</dt><dd>18.2%</dd>")); assert.ok(published.includes("<dt>成立以来年化</dt><dd>17.1%</dd>")); assert.equal(published.includes("你的）"), false);
  const young = c.evergreenProfileView({}, { all: { value: "4.91%", note: "未满一年" }, year: null });
  assert.ok(young.includes("<dt>成立以来年化</dt><dd>4.91%（你的，自买入，未满一年）</dd>")); assert.ok(young.includes("<dt>近一年</dt><dd>-</dd>"));
  assert.ok(c.evergreenProfileView({}, null).includes("<dt>成立以来年化</dt><dd>-</dd>"), "several lots have no single figure");
  assert.ok(filled.includes("标“你的”的来自 Sharesight，按你自己的买入计算"));
  // The desk reads the two printed figures of a single-lot fund as text and passes them on; nothing is recalculated.
  assert.ok(html.includes("own:lots?null:{all:figure(0),year:figure(1)}")); assert.ok(html.includes("fund.share=shares[fund.key]||'';"));
});

// fund-desk:v1 (owner request 2026-11-21): hedge funds join the evergreen funds on one page, renamed 基金.
test("hedge funds share the page with evergreen funds: one switch, counts and shares within each class", async () => {
  const { c } = await calendarBox(), { t: d } = await evergreenBox();
  const rows = [
    { key: "P|E1", kind: "evergreen", name: "E1", platform: "P", strategy: "私募股权", amount: "USD 600.00", lots: 1, lotList: [] },
    { key: "P|E2", kind: "evergreen", name: "E2", platform: "Q", strategy: "基础设施", amount: "USD 400.00", lots: 1, lotList: [] },
    { key: "P|H1", kind: "hedge", name: "H1", platform: "P", strategy: "多策略", amount: "USD 250.00", lots: 1, lotList: [] },
    { key: "P|H2", kind: "hedge", name: "H2", platform: "P", strategy: "宏观", amount: "USD 750.00", lots: 1, lotList: [] }];
  // A share is of the fund's own class, and one class with an unreadable amount does not blank the other.
  assert.deepEqual(plain(c.evergreenShares(rows)), { "P|E1": "60.0%", "P|E2": "40.0%", "P|H1": "25.0%", "P|H2": "75.0%" });
  assert.deepEqual(plain(c.evergreenShares([...rows, { key: "P|H3", kind: "hedge", amount: "未取得" }])), { "P|E1": "60.0%", "P|E2": "40.0%" });
  const shares = c.evergreenShares(rows), model = d.evergreenDeskModel(rows, { "P|H1": { state: "watch" } }, "2026-11-21");
  // fund-order:v1 — the largest holding first; equal and unreadable amounts keep the report's order, unreadable last; pending funds are still lifted to the top.
  { const row = (key, amount) => ({ key, name: key, platform: "P", strategy: "S", amount, lots: 1, lotList: [] });
    const list = [row("a", "USD 600.00"), row("x", ""), row("b", "USD 1,200,000.50"), row("c", "USD 9,000.00"), row("d", "USD 9,000.00")];
    const sized = c.evergreenBySize(list), keys = l => l.map(x => x.key).join(",");
    assert.equal(keys(sized), "b,c,d,a,x"); assert.equal(keys(list), "a,x,b,c,d"); assert.equal(keys(c.evergreenBySize(null)), "");
    assert.equal(keys(d.evergreenDeskModel(sized, {}, "2026-11-21").funds), "b,c,d,a,x");
    assert.equal(keys(d.evergreenDeskModel(sized, {}, "2026-11-21", null, { a: { notice: "2026-11-27" } }).funds), "a,b,c,d,x");
    assert.ok(html.includes("const rows=evergreenBySize(evergreenRows(report)),today=todayStr()")); }
  for (const fund of model.funds) fund.share = shares[fund.key];
  const kinds = view => [...view.matchAll(/data-evergreen-kind="(\w+)" aria-pressed="(\w+)">([^<]+)</g)].map(m => m.slice(1));
  const chips = view => [...view.matchAll(/data-evergreen-filter="(\w+)" aria-pressed="\w+">([^<]+)</g)].map(m => m[2]);
  const all = d.evergreenDeskView(model, "all", new Set(), "all");
  assert.ok(all.includes("<h2>基金管理</h2>")); assert.ok(all.includes("4 只基金 · 2 个平台"));
  assert.deepEqual(kinds(all), [["all", "true", "全部 4"], ["evergreen", "false", "常青 2"], ["hedge", "false", "对冲 2"]]);
  assert.deepEqual(chips(all), ["全部 4", "未标记 3", "观察 1"]);
  assert.ok(all.includes("<small>P · 常青 · 私募股权 · 占常青 60.0%</small>")); assert.ok(all.includes("<small>P · 对冲 · 宏观 · 占对冲 75.0%</small>"));
  // The hedge view counts and lists hedge funds only, and drops the class word from each row.
  const hedge = d.evergreenDeskView(model, "all", new Set(["P|H2"]), "hedge");
  assert.deepEqual(kinds(hedge).map(k => k[1]), ["false", "false", "true"]); assert.deepEqual(chips(hedge), ["全部 2", "未标记 1", "观察 1"]);
  assert.ok(hedge.includes("2 只基金 · 1 个平台")); assert.equal((hedge.match(/class="evergreen-fund"/g) || []).length, 2); assert.equal(hedge.includes("E1"), false);
  assert.ok(hedge.includes("<small>P · 宏观 · 占对冲 75.0%</small>")); assert.ok(d.evergreenDeskView(model, "all", new Set(["P|H2"]), "hedge", "position").includes("<span>P · 宏观 · 占对冲合计 75.0%</span>"));
  // With one class only there is no switch, and an unknown class word falls back to everything.
  const only = d.evergreenDeskView(d.evergreenDeskModel(rows.slice(0, 2), {}, "2026-11-21"), "all", new Set(), "hedge");
  assert.deepEqual(kinds(only), []); assert.equal((only.match(/class="evergreen-fund"/g) || []).length, 2);
  assert.deepEqual(kinds(d.evergreenDeskView(model, "all", new Set(), "<x>")).map(k => k[1]), ["true", "false", "false"]);
  // A hedge fund's frame carries four more rows; an evergreen fund's does not.
  const frame = c.evergreenProfileView(c.evergreenProfileClean({ profile: { netExposure: "净多 35%", grossExposure: "180%", volatility: "6.2%", maxDrawdown: "-8.4% <x>", junk: 1 } }), null, "hedge");
  for (const text of ["<dt>净敞口</dt><dd>净多 35%</dd>", "<dt>总敞口</dt><dd>180%</dd>", "<dt>年化波动</dt><dd>6.2%</dd>", "<dt>最大回撤</dt><dd>-8.4% &lt;x&gt;</dd>"]) assert.ok(frame.includes(text), text);
  assert.equal((c.evergreenProfileView(undefined, null, "hedge").match(/<dd>-<\/dd>/g) || []).length, 12); assert.equal(c.evergreenProfileView(undefined, null, "evergreen").includes("净敞口"), false);
  // The page reads both printed sections, switching class resets the status filter, and the pack says which class a fund is.
  assert.ok(html.includes("kind=title.startsWith('常青基金')?'evergreen':title.startsWith('对冲基金')?'hedge':'';"));
  assert.ok(html.includes("if(kindButton){_evergreenKind=kindButton.getAttribute('data-evergreen-kind');_evergreenFilter='all';again();return;}"));
  assert.equal(c.evergreenPackBuild(rows, {}, {}, "2026-11-21").funds[2].kind, "hedge");
});

test("the verified manager lands on 资产配置 once, and only the manager sees the name 资产管理", () => {
  // The markup carries no name, so no role is painted the other's name before the script starts.
  assert.match(html, /<title>投资管理费<\/title>/); assert.match(html, /<h1 id="appTitle">&nbsp;<\/h1>/);
  assert.ok(html.includes('try{const appTitle=document.getElementById("appTitle");if(appTitle)appTitle.textContent=isMgr()?"\\u00a0":"投资管理费";}catch(_){}'));
  // The name follows verification, not the mere presence of a token, and is left alone while the check runs.
  assert.ok(html.includes('{const settling=isMgr()&&!ratioAuthorized()&&(!_navigationReady||source.state==="loading"),appName=ratioAuthorized()?"资产管理":"投资管理费",appTitle=document.getElementById("appTitle");if(!settling){if(appTitle)appTitle.textContent=appName;'));
  // A print job borrows the document title; the name never overwrites it.
  assert.ok(html.includes('if(document.title==="资产管理"||document.title==="投资管理费")document.title=appName;}}'));
  // The report card is hidden until the source is verified, so a first open or a refresh never shows it as pending.
  assert.ok(html.includes('if(source.state==="verified")renderReportPublication(reportView);else{const reportBox=document.getElementById("reportPublicationBox");if(reportBox)reportBox.hidden=true;}'));
  // The landing waits for the same authorisation as the tab itself, happens once, and yields to any tab press.
  assert.ok(html.includes('let _managerLanding=true;\n'));assert.ok(html.includes('const keep=loading||away;return allowed?null:onRatio&&keep?view:keep?held:null;}\n// ratio-renew:v1'));
  // ratio-renew:v1 — shortly before the ten-minute lock the page runs the ordinary full read again, so an open manager view is re-verified instead of cleared.
  {const delay=new Function(html.match(/function ratioRenewDelay\([^\n]+/)[0]+';return ratioRenewDelay')();
    assert.equal(delay(1000,1000,600000),570000);assert.equal(delay(1000,301000,600000),270000);
    assert.equal(delay(1000,599000,600000),60000);assert.equal(delay(1000,9999999,600000),60000);   // never more often than once a minute
    assert.equal(delay(undefined,1000,600000),null);
    assert.ok(html.includes('if(document.visibilityState!=="visible"||!ratioAuthorized()||!document.getElementById("p-ratio").classList.contains("on")||EDIT.draft||EDIT.pending||_ledgerBusy||_manualRefreshing)return;'));
    assert.ok(html.includes('Promise.resolve(requestAutomaticPull()).then('));
    const kick=html.indexOf('if(!allowed){clearRatioManagement();notice.textContent='),plan=html.indexOf('  scheduleRatioRenewal();\n  if(!pane.classList.contains("on"))');assert.ok(kick>0&&plan>kick);   // only an authorised manager is renewed
  }
  assert.ok(html.includes('if(allowed&&_managerLanding){_managerLanding=false;if(document.getElementById("p-home").classList.contains("on")){setRatioView("all");'));
  assert.ok(html.includes('const b=e.target.closest("button[data-p]");if(!b)return;_managerLanding=false;_ratioReturn=null;_ratioAway=false;'));
  // refresh-return:v1 — a refresh that moves the manager off the pane brings them back to the same view once it verifies.
  {const note=new Function(html.match(/function ratioReturnNote\([^\n]+/)[0]+';return ratioReturnNote')();
    assert.equal(note(false,true,true,'evergreen',null),'evergreen');assert.equal(note(false,true,true,'all',null),'all');
    assert.equal(note(false,false,true,'all','evergreen'),'evergreen');   // already moved to 投资人, still reading
    assert.equal(note(false,false,false,'all','evergreen'),null);          // the read failed
    assert.equal(note(false,true,false,'all',null),null);                  // lost access without a read under way
    assert.equal(note(true,true,false,'all','evergreen'),null);
    // away-return:v1 — leaving the page withdraws access with no read under way; the note is kept until the read on return begins.
    assert.equal(note(false,true,false,'evergreen',null,true),'evergreen');assert.equal(note(false,false,false,'all','evergreen',true),'evergreen');
    assert.equal(note(false,false,false,'all',null,true),null);            // was not on the pane when leaving
    assert.equal(note(true,true,false,'all','evergreen',true),null);
    assert.ok(html.includes('{const loading=isMgr()&&_receiptSource.state==="loading";if(loading)_ratioAway=false;_ratioReturn=ratioReturnNote(allowed,pane.classList.contains("on"),loading,_ratioView,_ratioReturn,_ratioAway);}'));
    assert.ok(html.includes('else{_ratioAway=isMgr();invalidateReceiptSource();lockLedger("已离开页面，编辑锁定；草稿保留");}'));
    assert.ok(html.includes('window.addEventListener("pagehide",()=>{_ratioAway=isMgr();invalidateReceiptSource();lockLedger();});'));
    assert.ok(html.includes('if(allowed&&_ratioReturn){const view=_ratioReturn,back=view==="evergreen"?document.getElementById("evergreenTab"):tab;_ratioReturn=null;if(document.getElementById("p-investors").classList.contains("on")){setRatioView(view);'));
    const at=html.indexOf('if(allowed&&_ratioReturn){'),set=html.indexOf('_ratioReturn=ratioReturnNote(allowed,'),kick=html.indexOf('if(!allowed){clearRatioManagement();notice.textContent=');assert.ok(at>0&&at<set&&set<kick);}
  // landing-wait:v1 — until access is settled the page shows only the waiting line: every pane follows it as a sibling and is hidden while it is visible.
  assert.ok(html.includes('#navigationStatus:not([hidden])~section.pane{display:none}'));
  assert.ok(html.includes('<p id="navigationStatus" class="hint" role="status">取数中，请稍候…</p>'));
  {const at=html.indexOf('<p id="navigationStatus"'),panes=[...html.matchAll(/\n<section class="pane[^"]*" id="(p-[a-z]+)"/g)];
    assert.deepEqual(panes.map(m=>m[1]).sort(),['p-home','p-investors','p-ratio','p-set']);assert.ok(at>0&&panes.every(m=>m.index>at));
    assert.ok(html.includes('tabs.hidden=pending;tabs.classList.remove(\'hidden\');if(status)status.hidden=!pending;'));}
  assert.match(html, /<button data-p="p-home" class="on">管理人<\/button>/);
});

// evergreen-redeem:v1 (owner request 2026-11-24): the owner's filed redemption requests, and from them a forecast of
// when the cash arrives. Requests and amounts stay on the device.
const redeemBlock = html.slice(html.indexOf("/* evergreen-redeem:v1:start */"), html.indexOf("/* evergreen-redeem:v1:end */"));
async function redeemBox(saved = {}) {
  const vm = await import("node:vm");
  const memory = new Map(Object.entries(saved).map(([k, v]) => [k, JSON.stringify(v)]));
  const box = { store: { getItem: k => memory.get(k) ?? null, setItem: (k, v) => { memory.set(k, v); } }, todayStr: () => "2026-11-24", URL };
  vm.createContext(box);
  vm.runInContext(profileBlock + "\n" + calendarBlock + "\n" + redeemBlock + "\n" + evergreenBlock + ";globalThis.r={evergreenRedeemClean,evergreenRedeems,evergreenWorkday,evergreenRedeemPlan,evergreenCashModel,evergreenCashBy,evergreenCashText,evergreenCashView,evergreenRedeemView,evergreenRedeemSave,evergreenRedeemEdit,evergreenRedeemWindow,evergreenApplyDue,evergreenDeskModel,evergreenDeskView,evergreenPackBuild,evergreenLabels,evergreenTerms};", box);
  return { r: box.r, memory };
}
test("a redemption request keeps only well-formed values and stays outside the terms pack", async () => {
  const { r, memory } = await redeemBox();
  assert.ok(redeemBlock.length > 3000); assert.ok(html.indexOf("/* evergreen-calendar:v1:end */") < html.indexOf("/* evergreen-redeem:v1:start */") && html.indexOf("/* evergreen-redeem:v1:end */") < html.indexOf("/* evergreen-desk:v1:start */"));
  assert.doesNotMatch(redeemBlock, /changeDraft|EDIT\.|saveLedger|writeRemote|ghRead|fetch\(|ghApi|ratioCore|deriveManager|XMLHttpRequest|innerHTML|gist/i);
  assert.deepEqual(plain(r.evergreenRedeemClean({ id: "a1", requested: "2026-11-10", dealing: "2026-02-30", cashBy: "soon", tailBy: "2027-04-30", receivedOn: "", cents: 12345, acceptedPct: 100, tailPct: 60, extra: 1 })), { id: "a1", requested: "2026-11-10", tailBy: "2027-04-30", cents: 12345 });
  assert.deepEqual(plain(r.evergreenRedeemClean({ id: "A 1", cents: -5, acceptedPct: 62.5, tailPct: 10 })), { acceptedPct: 62.5, tailPct: 10 });
  assert.deepEqual(plain(r.evergreenRedeemClean([1])), {}); assert.deepEqual(plain(r.evergreenRedeemClean(null)), {});
  assert.equal(r.evergreenRedeemSave("P|A", [{ id: "a1", requested: "2026-11-10", cents: 500000 }, { id: "bad" }]), true);
  assert.deepEqual(plain(r.evergreenRedeems()), { "P|A": [{ id: "a1", requested: "2026-11-10", cents: 500000 }, { id: "bad" }] }, "a request whose date nobody has confirmed is still a request");
  assert.deepEqual(plain(r.evergreenRedeemClean({ id: "s1", shares: 77, estCents: 10000000, note: "  订单待处理  ", received: true, hold: "yes" })), { id: "s1", shares: 77, estCents: 10000000, note: "订单待处理", received: true });
  assert.deepEqual(plain(r.evergreenRedeemClean({ id: "s2", shares: -1, estCents: 1.5, note: 7, received: 1, hold: true })), { id: "s2", hold: true });
  assert.equal(r.evergreenRedeemSave("P|A", []), true); assert.deepEqual(plain(r.evergreenRedeems()), {}); assert.equal(memory.get("feeConsole.evergreen.redeem.v1"), "{}");
  memory.set("feeConsole.evergreen.redeem.v1", "{not json"); assert.deepEqual(plain(r.evergreenRedeems()), {});
  memory.set("feeConsole.evergreen.redeem.v1", "[1]"); assert.deepEqual(plain(r.evergreenRedeems()), {});
  // The form's edits: an empty or malformed entry clears the field; an amount is kept in whole cents.
  const rec = { id: "a1", requested: "2026-11-10", cents: 500000 };
  assert.deepEqual(plain(r.evergreenRedeemEdit(rec, "cents", "1234.567")), { id: "a1", requested: "2026-11-10", cents: 123457 });
  assert.deepEqual(plain(r.evergreenRedeemEdit(rec, "cents", "")), { id: "a1", requested: "2026-11-10" }); assert.deepEqual(plain(r.evergreenRedeemEdit(rec, "cents", "abc")), { id: "a1", requested: "2026-11-10" });
  assert.deepEqual(plain(r.evergreenRedeemEdit(rec, "acceptedPct", "60")), { id: "a1", requested: "2026-11-10", cents: 500000, acceptedPct: 60 });
  assert.deepEqual(plain(r.evergreenRedeemEdit(rec, "cashBy", "2027-02-03")), { id: "a1", requested: "2026-11-10", cashBy: "2027-02-03", cents: 500000 });
  assert.equal(r.evergreenRedeemEdit(rec, "requested", "").requested, undefined);
  // simple-form:v1 — the one amount box: the amount applied for, unless the request is in shares or already an estimate.
  assert.deepEqual(plain(r.evergreenRedeemEdit({ id: "a1" }, "amount", "1234.567")), { id: "a1", cents: 123457 }); assert.deepEqual(plain(r.evergreenRedeemEdit(rec, "amount", "")), { id: "a1", requested: "2026-11-10" });
  assert.deepEqual(plain(r.evergreenRedeemEdit({ id: "a1", shares: 7 }, "amount", "900")), { id: "a1", shares: 7, estCents: 90000 }); assert.deepEqual(plain(r.evergreenRedeemEdit({ id: "a1", estCents: 5 }, "amount", "900")), { id: "a1", estCents: 90000 });
  assert.deepEqual(plain(r.evergreenRedeemEdit({ id: "a1", shares: 7, cents: 100 }, "amount", "900")), { id: "a1", shares: 7, cents: 90000 }); assert.deepEqual(plain(r.evergreenRedeemEdit({ id: "a1", shares: 7, estCents: 5 }, "amount", "abc")), { id: "a1", shares: 7 });
  assert.deepEqual(plain(r.evergreenRedeemEdit(rec, "est", "1")), { id: "a1", requested: "2026-11-10", estCents: 500000 }); assert.deepEqual(plain(r.evergreenRedeemEdit({ id: "a1", estCents: 500000 }, "est", "")), { id: "a1", cents: 500000 });
  assert.deepEqual(plain(r.evergreenRedeemEdit({ id: "a1" }, "est", "1")), { id: "a1" }); assert.deepEqual(plain(r.evergreenRedeemEdit({ id: "a1", dealing: "2026-11-25", hold: true }, "dealing", "")), { id: "a1", hold: true });
  assert.deepEqual(plain(r.evergreenRedeemEdit({ id: "a1" }, "shares", "60.468")), { id: "a1", shares: 60.468 }); assert.deepEqual(plain(r.evergreenRedeemEdit({ id: "a1" }, "estCents", "11185.77")), { id: "a1", estCents: 1118577 });
  assert.deepEqual(plain(r.evergreenRedeemEdit({ id: "a1" }, "note", " 订单 1 ")), { id: "a1", note: "订单 1" }); assert.deepEqual(plain(r.evergreenRedeemEdit({ id: "a1" }, "hold", "1")), { id: "a1", hold: true }); assert.deepEqual(plain(r.evergreenRedeemEdit({ id: "a1", hold: true, received: true }, "hold", "")), { id: "a1", received: true });
  assert.match(html, /input\.type==='checkbox'\?\(input\.checked\?'1':''\):input\.value\);/);
  // The pack the owner hands to others never carries a request or an amount.
  memory.set("feeConsole.evergreen.redeem.v1", JSON.stringify({ "P|A": [rec] }));
  const pack = JSON.stringify(r.evergreenPackBuild([{ key: "P|A", name: "A", platform: "P", strategy: "S", amount: "USD 9.00", lotList: [] }], {}, {}, "2026-11-24", {}, []));
  assert.equal(/cents|500000|redeem|requested/.test(pack), false);
});
test("a fund marked 准备赎回 carries a plan: timed at the earliest fee-free dealing day, counted, and always shown as a plan", async () => {
  // redeem-plan:v1 — synthetic figures only.
  const { r } = await redeemBox(), today = "2026-11-24", q = { frequency: "quarterly", noticeDays: 28, softLockMonths: 24, earlyFeePct: 5 };
  const lots = [{ amount: "USD 6,000.00", date: "2025-02-10" }, { amount: "USD 4,000.00", date: "2026-01-15" }];
  const plan = (rec, terms, more) => plain(r.evergreenRedeemPlan({ id: "a", ...rec }, terms, 1000000, "evergreen", today, more));
  // Oldest purchase is fee-free from 10 Feb 2027: the first quarter end after that. No settlement term, so the usual 45 days.
  const p = plan({ estCents: 500000 }, q, { planned: true, lots });
  assert.equal(p.dealing, "2027-03-31"); assert.equal(p.noticeBy, "2027-03-03"); assert.equal(p.stage, "plan"); assert.equal(p.planned, true); assert.equal(p.dealingBasis, "terms");
  assert.deepEqual(p.tranches.map(t => [t.label, t.cents, t.date, t.basis, t.planned, t.est]), [["首笔", 500000, "2027-05-17", "typical", true, true]]);
  // No purchase dates: the next dealing day reachable with notice from today.
  assert.equal(plan({}, q, { planned: true }).dealing, "2026-12-31");
  // An entered dealing day wins and it is still a plan; no cycle in the terms leaves the date open rather than guessed.
  const set = plan({ dealing: "2027-06-30", cents: 250000 }, q, { planned: true, lots }); assert.equal(set.dealing, "2027-06-30"); assert.equal(set.stage, "plan"); assert.equal(set.tranches[0].planned, true); assert.equal(set.noticeBy, "2027-06-02");
  const open = plan({ cents: 250000 }, {}, { planned: true, lots }); assert.equal(open.dealing, ""); assert.equal(open.stage, "plan"); assert.equal(open.tranches[0].date, "");
  // Once a filing date is recorded, or without the 准备赎回 mark, nothing is treated as a plan.
  const filed = plan({ requested: "2026-11-10" }, q, { planned: true, lots }); assert.equal(filed.planned, undefined); assert.equal(filed.stage, "waiting"); assert.equal(filed.tranches[0].planned, undefined);
  const plainOne = plan({ estCents: 500000 }, q, undefined); assert.equal(plainOne.dealing, ""); assert.equal(plainOne.stage, "filed"); assert.equal(plan({ hold: true }, q, { planned: true, lots }).stage, "hold");
  // The forecast counts it and says so.
  const fund = state => ({ key: "P|A", name: "A", kind: "evergreen", amount: "USD 10,000.00", label: { state }, lotList: lots });
  const m = r.evergreenCashModel([fund("prepare")], { "P|A": [{ id: "a", estCents: 500000 }] }, { "P|A": q }, today);
  assert.equal(m.planned, 1); assert.equal(m.total, 500000); assert.equal(m.items[0].date, "2027-05-17"); assert.equal(m.items[0].planned, true); assert.equal(m.undated.length, 0);
  assert.equal(r.evergreenCashModel([fund("partial")], { "P|A": [{ id: "a", estCents: 500000 }] }, { "P|A": q }, today).planned, 0);
  const card = r.evergreenCashView(m, today, "", { open: true }); assert.ok(card.includes("计划，尚未申请")); assert.ok(card.includes("1 笔为计划（尚未申请，已计入合计）"));
  assert.ok(r.evergreenCashText(m, today).includes("A 首笔（计划，尚未申请）"));
  // The form: offered for 准备赎回, adds a plan without a filing date, and labels the steps accordingly.
  const empty = r.evergreenRedeemView(fund("prepare"), [], q, today); assert.ok(empty.includes('data-evergreen-redeem-add="plan">登记一笔计划赎回</button>')); assert.ok(empty.includes("尚未申请的计划"));
  const view = r.evergreenRedeemView(fund("prepare"), [{ id: "a", estCents: 500000 }], q, today);
  assert.ok(view.includes("计划 · 约 27-05-17 到账")); assert.ok(view.includes(">计划中</span>")); assert.ok(view.includes("<small>最迟申请</small><b>27-03-03</b>")); assert.equal(view.includes("<small>申请</small>"), false); assert.ok(view.includes(" · 计划</small>"));
  assert.ok(html.includes("list.push(add.getAttribute('data-evergreen-redeem-add')==='plan'?{id}:{id,requested:todayStr()});"));
});
test("a request's dealing day and payments follow what the platform said, else the terms, else a usual figure, and say which", async () => {
  const { r } = await redeemBox(), q = { frequency: "quarterly", noticeDays: 45, settlementDays: 30 }, plan = (rec, terms, cents, kind, today = "2026-11-24") => plain(r.evergreenRedeemPlan({ id: "a", ...rec }, terms, cents, kind, today));
  assert.equal(r.evergreenWorkday("2027-01-30"), "2027-02-01"); assert.equal(r.evergreenWorkday("2027-01-31"), "2027-02-01"); assert.equal(r.evergreenWorkday("2027-01-29"), "2027-01-29"); assert.equal(r.evergreenWorkday("x"), "");
  // Filed 10 November with 45 days' notice: the 31 December dealing day; 30 days later is a Saturday, so the Monday.
  assert.deepEqual(plan({ requested: "2026-11-10" }, q, 1000000), { dealing: "2026-12-31", dealingBasis: "terms", noticeBy: "2026-11-16", total: 1000000, est: false, stage: "waiting",
    tranches: [{ label: "首笔", cents: 1000000, date: "2027-02-01", early: "2027-02-01", late: "2027-02-16", basis: "terms" }] });
  // Filed after that deadline: the next quarter.
  const next = plan({ requested: "2026-11-20" }, q, 1000000); assert.deepEqual([next.dealing, next.noticeBy, next.tranches[0].date], ["2027-03-31", "2027-02-14", "2027-04-30"]);
  // Scaled back to 60% with a tenth of that held back: three payments that add up to the request, the unconfirmed part one period on.
  const cut = plan({ requested: "2026-11-10", cents: 500000, acceptedPct: 60, tailPct: 10 }, q, 1000000, "evergreen", "2027-01-05");
  assert.equal(cut.stage, "priced"); assert.equal(cut.total, 500000);
  assert.deepEqual(cut.tranches.map(t => [t.label, t.cents, t.date, t.late, t.basis]), [["首笔", 270000, "2027-02-01", "2027-02-16", "terms"], ["尾款", 30000, "2027-04-30", "2027-06-29", "audit"], ["顺延部分", 200000, "2027-04-30", "2027-06-14", "rollover"]]);
  assert.equal(cut.tranches.reduce((a, t) => a + t.cents, 0), 500000);
  assert.deepEqual(plan({ requested: "2026-11-10", tailPct: 10, tailBy: "2027-03-06" }, q, 1000).tranches[1], { label: "尾款", cents: 100, date: "2027-03-08", early: "2027-03-08", late: "2027-03-13", basis: "platform" });
  // No settlement term: a usual number of days (45 evergreen, 30 hedge) with a wide range, marked as an estimate; an unreadable holding has no amount.
  assert.deepEqual(plan({ requested: "2026-11-10" }, { frequency: "quarterly", noticeDays: 45 }, null).tranches, [{ label: "首笔", cents: null, date: "2027-02-15", early: "2027-01-25", late: "2027-04-01", basis: "typical" }]);
  assert.deepEqual(plan({ requested: "2026-11-10" }, { frequency: "monthly", noticeDays: 30 }, 1000, "hedge").tranches, [{ label: "首笔", cents: 1000, date: "2027-02-01", early: "2027-01-15", late: "2027-03-18", basis: "typical" }]);
  // No terms at all and nothing from the platform: no date is invented.
  assert.deepEqual(plan({ requested: "2026-11-10" }, undefined, 1000), { dealing: "", dealingBasis: "", noticeBy: "", total: 1000, est: false, stage: "filed", tranches: [{ label: "首笔", cents: 1000, date: "", early: "", late: "", basis: "unknown" }] });
  assert.deepEqual(plan({ requested: "2026-11-10", acceptedPct: 50 }, undefined, 1000).tranches.map(t => [t.label, t.cents, t.basis]), [["首笔", 500, "unknown"], ["顺延部分", 500, "unknown"]]);
  // What the platform said wins over the terms; a received payment is marked; one past its latest date asks for a check.
  const told = plan({ requested: "2026-11-10", dealing: "2026-12-31", cashBy: "2027-02-03", receivedOn: "2027-02-04" }, q, 1000, "evergreen", "2027-03-01");
  assert.deepEqual([told.dealingBasis, told.noticeBy, told.stage], ["entered", "", "received"]); assert.deepEqual(told.tranches, [{ label: "首笔", cents: 1000, date: "2027-02-03", early: "2027-02-03", late: "2027-02-08", basis: "platform", received: "2027-02-04" }]);
  assert.equal(plan({ requested: "2026-11-10" }, q, 1000, "evergreen", "2027-02-17").stage, "late"); assert.equal(plan({ requested: "2026-11-10" }, q, 1000, "evergreen", "2027-02-16").stage, "priced");
  // redeem-facts:v1 — a request in shares takes its reference estimate, marked as one, and never the holding's value; with no estimate it has no amount.
  assert.deepEqual(plan({ shares: 77, estCents: 10000000, dealing: "2026-11-30", cashBy: "2026-12-14" }, q, 99999999), { dealing: "2026-11-30", dealingBasis: "entered", noticeBy: "", total: 10000000, est: true, stage: "waiting",
    tranches: [{ label: "首笔", cents: 10000000, date: "2026-12-14", early: "2026-12-14", late: "2026-12-19", basis: "platform", est: true }] }, "no request date is needed when the platform gave the dates");
  assert.equal(plan({ shares: 52.711 }, q, 99999999).total, null); assert.equal(plan({ requested: "2026-11-10", cents: 500, estCents: 900 }, q, 99999999).total, 500); assert.equal(plan({ requested: "2026-11-10", cents: 500, estCents: 900 }, q, 1).est, false);
  // No request date and no dealing day: nothing is derived.
  assert.deepEqual(plan({ cents: 25000000 }, q, 1).tranches, [{ label: "首笔", cents: 25000000, date: "", early: "", late: "", basis: "unknown" }]); assert.equal(plan({ cents: 25000000 }, q, 1).stage, "filed");
  // Reported as received with no booking date: marked received, and no date is made up for it.
  const got = plan({ shares: 7.757, estCents: 1118577, received: true }, undefined, 1); assert.equal(got.stage, "received"); assert.deepEqual(got.tranches, [{ label: "首笔", cents: 1118577, date: "", early: "", late: "", basis: "unknown", est: true, received: "日期待核" }]);
  // On hold: kept, with no payment at all.
  assert.deepEqual(plan({ shares: 52.711, hold: true, requested: "2026-11-10" }, q, 1), { dealing: "2026-12-31", dealingBasis: "terms", noticeBy: "", total: null, est: false, stage: "hold", tranches: [] });
  assert.doesNotMatch(redeemBlock, /建议赎回|应当赎回|应该赎回/);
});
test("the arrival forecast lists what is still to come by date, totals by month, and answers how much by a given day", async () => {
  const { r } = await redeemBox(), q = { frequency: "quarterly", noticeDays: 45, settlementDays: 30 }, today = "2026-11-24";
  const fund = (key, state, amount, extra = {}) => ({ key, name: key.split("|")[1], platform: "P", kind: "evergreen", amount, label: { state }, lotList: [], ...extra });
  const funds = [fund("P|A <x>", "redeeming", "USD 10,000.00"), fund("P|B", "partial", "USD 5,000.00"), fund("P|C", "redeeming", "USD 1.00"), fund("P|D", "prepare", "USD 800.00", { lotList: [{ amount: "USD 300.00", date: "2020-01-15" }, { amount: "USD 500.00", date: "2026-10-01" }] }),
    fund("P|E", "redeeming", "未取得"), fund("P|F", "hold", "USD 7.00"), fund("P|G", "redeeming", "USD 9.00")];
  const redeems = { "P|A <x>": [{ id: "a", requested: "2026-11-10" }], "P|B": [{ id: "b", requested: "2026-11-20", cents: 200000 }, { id: "c", requested: "2026-08-01", cents: 100000, cashBy: "2026-11-02", receivedOn: "2026-11-03" }],
    "P|E": [{ id: "e", requested: "2026-11-10" }], "P|G": [{ id: "g", requested: "2026-06-01", cashBy: "2026-11-02" }] };
  const terms = { "P|A <x>": q, "P|B": q, "P|D": { ...q, softLockMonths: 12, earlyFeePct: 2 } }, model = plain(r.evergreenCashModel(funds, redeems, terms, today));
  assert.deepEqual(model.items.map(x => [x.date, x.name, x.cents, x.basis, x.overdue]), [["2026-11-02", "G", 900, "platform", true], ["2027-02-01", "A <x>", 1000000, "terms", false], ["2027-04-30", "B", 200000, "terms", false]], "a received payment is left out");
  assert.deepEqual(model.undated.map(x => [x.name, x.cents, x.basis]), [["E", null, "unknown"]]); assert.deepEqual(model.missing, ["C"]);
  // 准备赎回: only the lots past their fee period, as a what-if that no total includes.
  assert.deepEqual(model.whatIf, [{ name: "D", notice: "2027-02-14", dealing: "2027-03-31", cash: "2027-04-30", settled: true, lots: 1, cents: 30000 }]);
  assert.deepEqual(model.months, [{ ym: "2026-11", cents: 900, count: 1, blank: 0, running: 900 }, { ym: "2027-02", cents: 1000000, count: 1, blank: 0, running: 1000900 }, { ym: "2027-04", cents: 200000, count: 1, blank: 0, running: 1200900 }]);
  assert.equal(model.total, 1200900); assert.equal(model.blank, 1);
  // By a day: expected counts a payment by its expected date, the cautious figure by its latest.
  assert.deepEqual(plain(r.evergreenCashBy(model, "2027-02-10")), { by: "2027-02-10", expected: 1000900, safe: 900, later: 2 });
  assert.deepEqual(plain(r.evergreenCashBy(model, "2027-06-30")), { by: "2027-06-30", expected: 1200900, safe: 1200900, later: 1 }); assert.equal(r.evergreenCashBy(model, ""), null);
  // compact-desk:v1 — closed until tapped, with the total and the next payment in its one line; inside, one tab at a time.
  const closed = r.evergreenCashView(model, today, "");
  assert.ok(closed.startsWith('<details class="evergreen-cash"><summary>赎回到账预测 · 3 笔 · USD 12,009<small>下一笔 02-01</small></summary>'), "the overdue payment is not the next one");
  assert.ok(closed.includes("<strong>还没登记：</strong>C</p>"));
  const tabsOf = v => [...v.matchAll(/data-evergreen-cash-tab="(\w+)" aria-pressed="(\w+)">([^<]+)</g)].map(m => m.slice(1).join(" "));
  assert.deepEqual(tabsOf(closed), ["cash true 回款 4", "whatif false 如果申请 1", "by false 截至某日"]); assert.ok(closed.includes('data-evergreen-cash-panel="cash"')); assert.equal(closed.includes("data-evergreen-cash-by"), false);
  // 回款: the months, each folded over its own payments; only the month that was opened is open.
  assert.ok(closed.includes('<div class="evergreen-within" role="group" aria-label="累计到账（USD）"><p>累计到账（USD）</p><span><small>30 天内</small><b>9</b></span><span><small>90 天内</small><b>10,009</b></span><span><small>180 天内</small><b>12,009</b></span></div>')); assert.ok(html.includes('.evergreen-within{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));')); assert.equal((closed.match(/<details class="evergreen-month"/g) || []).length, 4); assert.equal(closed.includes('class="evergreen-month" data-evergreen-month="2027-02" open'), false);
  const view = r.evergreenCashView(model, today, "", { open: true, tab: "cash", month: "2027-02" });
  assert.ok(view.startsWith('<details class="evergreen-cash" open>')); assert.ok(view.includes('<details class="evergreen-month" data-evergreen-month="2027-02" open><summary><span class="evergreen-ladder-quarter">2027-02</span>')); assert.equal((view.match(/evergreen-month" data-evergreen-month="[^"]+" open/g) || []).length, 1);
  assert.ok(view.includes('<span class="evergreen-ladder-amount">USD 10,000<small>累计 USD 10,009</small></span></summary><ul class="evergreen-cash-list"><li data-basis="terms"><span class="evergreen-cash-date">02-01</span><span class="evergreen-cash-what"><strong>A &lt;x&gt; · 首笔</strong><small>按条款 · 最晚 02-16</small>'));
  assert.equal(view.includes("<x>"), false); assert.ok(view.includes('<li data-basis="platform" data-overdue="true">')); assert.ok(view.includes("<b>已过最晚日期，请核对</b>"));
  assert.ok(view.includes('data-evergreen-month="undated"><summary><span class="evergreen-ladder-quarter">日期待定</span><span></span><span class="evergreen-ladder-amount">1 笔</span>')); assert.ok(view.includes('<span class="evergreen-cash-date">待定</span>')); assert.ok(view.includes("金额未填")); assert.ok(view.includes("1 笔金额未知。"));
  assert.ok(view.includes("data-evergreen-cash-copy>复制到账计划</button>"));
  const byTab = r.evergreenCashView(model, today, "2027-02-10", { open: true, tab: "by" });
  assert.deepEqual(tabsOf(byTab).map(t => t.split(" ")[1]), ["false", "false", "true"]); assert.equal(byTab.includes("evergreen-month"), false);
  assert.ok(byTab.includes('data-evergreen-cash-by type="date" value="2027-02-10"')); assert.ok(byTab.includes("到 2027-02-10：预计 <b>USD 10,009</b>，保守 <b>USD 9</b>（每笔都按最晚日期）；之后还有 2 笔"));
  assert.ok(r.evergreenCashView(model, today, "", { tab: "by" }).includes("选一个日期：预计按每笔的预计到账日算，保守按最晚日期算。"));
  const ifTab = r.evergreenCashView(model, today, "", { tab: "whatif" });
  assert.ok(ifTab.includes("通知截止 02-14 → 赎回日 2027-03-31 · 1 笔已过费用期")); assert.ok(ifTab.includes("不计入合计。")); assert.equal(tabsOf(r.evergreenCashView(model, today, "", { tab: "nope" }))[0], "cash true 回款 4", "an unknown tab falls back to the first");
  assert.ok(view.includes("方向性估计，以平台通知为准。"));
  assert.equal(r.evergreenCashView(plain(r.evergreenCashModel([fund("P|F", "hold", "USD 7.00")], {}, {}, today)), today, ""), "", "nothing filed and nothing marked: no card");
  assert.deepEqual(model.held, []); assert.equal(model.est, 0);
  // redeem-facts:v1 — an estimate is counted and marked; a payment reported received leaves the forecast; a request on hold is listed apart and never totalled.
  const real = plain(r.evergreenCashModel([fund("P|S", "partial", "USD 9,999.00"), fund("P|O <o>", "partial", "USD 9,999.00")], { "P|S": [{ id: "s1", shares: 77, estCents: 10000000, dealing: "2026-11-30", cashBy: "2026-12-14" }],
    "P|O <o>": [{ id: "o1", shares: 7.757, estCents: 1118577, received: true }, { id: "o2", shares: 52.711, hold: true, note: "需重提 <b>" }] }, {}, today));
  assert.deepEqual(real.items.map(x => [x.name, x.cents, x.est, x.date]), [["S", 10000000, true, "2026-12-14"]]); assert.deepEqual(real.undated, []); assert.deepEqual(real.held, [{ name: "O <o>", cents: null, est: false, note: "需重提 <b>" }]); assert.equal(real.total, 10000000); assert.equal(real.est, 1);
  const realView = r.evergreenCashView(real, today, "", { open: true, month: "2026-12" }), heldView = r.evergreenCashView(real, today, "", { tab: "held" });
  assert.ok(realView.includes("1 笔为参考估算。")); assert.ok(realView.includes('USD 100,000<small>估</small>')); assert.ok(realView.includes('data-evergreen-cash-tab="held" aria-pressed="false">待处理 1<'));
  assert.ok(heldView.includes('data-evergreen-cash-panel="held"')); assert.ok(heldView.includes("<strong>O &lt;o&gt;</strong><small>需重提 &lt;b&gt;</small>")); assert.ok(heldView.includes("未排期，不计入合计。")); assert.equal(heldView.includes("<b>"), false, "a note is escaped");
  assert.ok(r.evergreenCashText(real, today).endsWith("合计 USD 100,000（其中 1 笔为参考估算）\n待处理（未排期，不计入合计）：O <o> 金额未填"));
  const onlyHeld = plain(r.evergreenCashModel([fund("P|O", "partial", "USD 1.00")], { "P|O": [{ id: "o2", hold: true }] }, {}, today)), heldOnly = r.evergreenCashView(onlyHeld, today, "");
  assert.ok(heldOnly.startsWith('<details class="evergreen-cash"><summary>赎回到账预测 · 1 笔待处理</summary>')); assert.ok(heldOnly.includes('data-evergreen-cash-panel="held"')); assert.equal(heldOnly.includes("data-evergreen-cash-tab"), false, "one tab needs no switch");
  const text = r.evergreenCashText(model, today);
  assert.ok(text.startsWith("赎回到账计划（2026-11-24 整理，方向性估计，以平台通知为准）\n2026-11-02 G 首笔 USD 9（最早 2026-11-02，最晚 2026-11-07，平台通知）\n")); assert.ok(text.endsWith("日期待定 E 首笔 金额未填\n合计 USD 12,009（另有 1 笔金额未知）"));
});
test("a plan can carry the platform's booking window: the page reminds from its first day and never files or relabels by itself", async () => {
  // redeem-window:v1 — synthetic figures only.
  const { r } = await redeemBox(), q = { frequency: "quarterly", noticeDays: 28 }, win = (rec, today, by) => plain(r.evergreenRedeemWindow(rec, today, by));
  assert.deepEqual(plain(r.evergreenRedeemClean({ id: "a", openFrom: "2026-12-04", applyBy: "2026-12-16" })), { id: "a", openFrom: "2026-12-04", applyBy: "2026-12-16" });
  assert.deepEqual(plain(r.evergreenRedeemClean({ id: "a", openFrom: "2026-02-30", applyBy: 7 })), { id: "a" });
  const rec = { id: "a", openFrom: "2026-12-04", applyBy: "2026-12-16" };
  assert.deepEqual(win(rec, "2026-11-25"), { from: "2026-12-04", by: "2026-12-16", state: "before", wait: 9 });
  assert.deepEqual(win(rec, "2026-12-04"), { from: "2026-12-04", by: "2026-12-16", state: "open", left: 12 });
  assert.deepEqual(win(rec, "2026-12-13"), { from: "2026-12-04", by: "2026-12-16", state: "last", left: 3 });
  assert.deepEqual(win(rec, "2026-12-16"), { from: "2026-12-04", by: "2026-12-16", state: "last", left: 0 });
  assert.deepEqual(win(rec, "2026-12-17"), { from: "2026-12-04", by: "2026-12-16", state: "missed" });
  // Only an entered date makes a window; the last day falls back to the terms' notice deadline; a start alone has no end.
  assert.equal(win({ id: "a" }, "2026-12-04", "2026-12-20"), null);
  assert.deepEqual(win({ id: "a", openFrom: "2026-12-04" }, "2026-12-05", "2026-12-20"), { from: "2026-12-04", by: "2026-12-20", state: "open", left: 15 });
  assert.deepEqual(win({ id: "a", openFrom: "2026-12-04" }, "2026-12-05", ""), { from: "2026-12-04", by: "", state: "open" });
  // Filed, on hold or already paid: nothing left to remind about.
  for (const more of [{ requested: "2026-12-05" }, { hold: true }, { received: true }, { receivedOn: "2027-01-05" }]) assert.equal(win({ ...rec, ...more }, "2026-12-06"), null);
  const plan = (record, today) => plain(r.evergreenRedeemPlan(record, q, 1000000, "evergreen", today, { planned: true }));
  assert.equal(plan({ id: "a" }, "2026-12-06").window, undefined); assert.equal(plan(rec, "2026-12-06").window.state, "open"); assert.equal(plan({ ...rec, requested: "2026-12-05" }, "2026-12-06").window, undefined);
  const fund = state => ({ key: "P|A", name: "A", kind: "evergreen", amount: "USD 10,000.00", label: { state } });
  // Before the window: one quiet line and no button.
  const before = r.evergreenRedeemView(fund("prepare"), [rec], q, "2026-11-25");
  assert.ok(before.includes('<p class="evergreen-meta" data-window="before">12-04 起可申请，截止 12-16 · 还有 9 天。</p>')); assert.equal(before.includes("data-evergreen-redeem-filed"), false); assert.ok(before.includes(">计划中</span>"));
  assert.ok(before.includes("<small>可申请</small><b>26-12-04</b>")); assert.ok(before.includes("<small>最迟申请</small><b>26-12-16</b>"));
  // Open: the request opens itself, says how long is left and offers the tap, which asks once more and names the status.
  const open = r.evergreenRedeemView(fund("prepare"), [rec], q, "2026-12-06");
  assert.ok(open.includes('data-redeem-id="a" open>')); assert.ok(open.includes('data-state="pending">可申请</span>'));
  assert.ok(open.includes('<div class="evergreen-due evergreen-window" data-window="open"><strong>申请窗口已开</strong><p>截止 <b>2026-12-16</b> · 还剩 10 天</p>')); assert.ok(open.includes("data-evergreen-redeem-filed>我已提交</button>")); assert.ok(open.includes("本页不会替你提交，也不会自己改状态"));
  assert.ok(r.evergreenRedeemView(fund("prepare"), [rec], q, "2026-12-06", { filed: "a" }).includes("data-evergreen-redeem-filed>再点一次确认：申请日记为今天，状态改为“赎回中”</button>"));
  assert.ok(r.evergreenRedeemView(fund("prepare"), [{ ...rec, shares: 7 }], q, "2026-12-06", { filed: "a" }).includes("状态改为“部分赎回”</button>"));
  assert.ok(r.evergreenRedeemView(fund("prepare"), [rec], q, "2026-12-16").includes('data-window="last"><strong>申请窗口已开</strong><p>截止 <b>2026-12-16</b> · 今天截止</p>'));
  const missed = r.evergreenRedeemView(fund("prepare"), [rec], q, "2026-12-17"); assert.ok(missed.includes('data-window="missed"><strong>申请截止日已过</strong>')); assert.ok(missed.includes('data-state="pending">已过截止</span>')); assert.ok(missed.includes("data-evergreen-redeem-filed>我已提交</button>"));
  // The two dates are asked for only while nothing is filed.
  assert.ok(open.includes('<span>可申请起</span><input data-evergreen-redeem="openFrom" type="date" value="2026-12-04">')); assert.ok(open.includes('<span>申请截止</span><input data-evergreen-redeem="applyBy" type="date" value="2026-12-16">'));
  const filed = r.evergreenRedeemView(fund("redeeming"), [{ ...rec, requested: "2026-12-06" }], q, "2026-12-06"); assert.equal(/openFrom|applyBy|evergreen-window|data-window/.test(filed), false);
  assert.deepEqual(plain(r.evergreenRedeemEdit(rec, "requested", "2026-12-06")), { id: "a", requested: "2026-12-06", openFrom: "2026-12-04", applyBy: "2026-12-16" }); assert.deepEqual(plain(r.evergreenRedeemEdit(rec, "applyBy", "")), { id: "a", openFrom: "2026-12-04" });
  // The fund list: a fund whose window is open counts as 待处理 and says 可申请; one still waiting does not.
  assert.equal(r.evergreenApplyDue([rec], q, 1000000, "evergreen", "2026-11-25", { planned: true }), null);
  assert.deepEqual(plain(r.evergreenApplyDue([{ id: "b", openFrom: "2026-12-01", applyBy: "2026-12-20" }, rec], q, 1000000, "evergreen", "2026-12-06", { planned: true })), { from: "2026-12-04", by: "2026-12-16", state: "open", left: 10 });
  const row = { key: "P|A", name: "A", platform: "P", strategy: "S", amount: "USD 9.00", lots: 1, kind: "evergreen" }, model = r.evergreenDeskModel([row, { ...row, key: "P|B", name: "B" }], { "P|A": { state: "prepare" }, "P|B": { state: "hold" } }, "2026-12-06");
  model.funds[0].apply = { from: "2026-12-04", by: "2026-12-16", state: "open", left: 10 };
  const desk = r.evergreenDeskView(model, "pending", new Set(), "all", "status", "");
  assert.ok(desk.includes('data-evergreen-filter="pending" aria-pressed="true">待处理 1</button>')); assert.ok(desk.includes('<span class="evergreen-pill" data-state="pending">可申请</span>')); assert.equal(desk.includes('data-evergreen-key="P|B"'), false);
  // Wiring: the tap asks twice, records today as the filing date and sets the status the owner was shown; nothing else writes a status.
  assert.match(html, /if\(_evergreenRedeemFiled!==id\)\{_evergreenRedeemFiled=id;again\(key\);return;\}/);
  assert.match(html, /list\[at\]=evergreenRedeemEdit\(list\[at\],'requested',todayStr\(\)\);\n\s*if\(!evergreenRedeemSave\(key,list\)\|\|!evergreenLabelSet\(key,\{state:part\?'partial':'redeeming'\}\)\)/);
  assert.equal((redeemBlock.match(/evergreenLabelSet\(/g) || []).length, 1, "only the owner's tap sets a status from this block");
  assert.match(html, /fund\.apply=evergreenApplyDue\(redeems\[fund\.key\],terms\[fund\.key\],evergreenCents\(fund\.amount\),fund\.kind,today,\{planned:fund\.label\?\.state==='prepare',lots:fund\.lotList\}\);/);
});
test("a fund marked 赎回中 or 部分赎回 gets the request form in its 状态 tab, with the steps and each payment", async () => {
  const { r } = await redeemBox(), q = { frequency: "quarterly", noticeDays: 45, settlementDays: 30 }, today = "2026-11-24";
  const fund = state => ({ key: "P|A", name: "A", kind: "evergreen", amount: "USD 10,000.00", label: { state } });
  assert.equal(r.evergreenRedeemView(fund("hold"), [], q, today), ""); assert.equal(r.evergreenRedeemView(fund("watch"), undefined, q, today), "");
  for (const state of ["redeeming", "partial"]) { const empty = r.evergreenRedeemView(fund(state), [], q, today); assert.ok(empty.startsWith("<h3>赎回登记</h3>")); assert.ok(empty.includes('data-evergreen-redeem-add="filed">登记一笔赎回申请</button>')); assert.equal(empty.includes("evergreen-redeem-fields"), false); }
  const view = r.evergreenRedeemView(fund("hold"), [{ id: "a1", requested: "2026-11-10", cents: 250000, tailPct: 10 }], q, today);
  // compact-desk:v1 — a request is one line until tapped: what, roughly when, and where it stands. Its fields wait under 修改.
  assert.ok(view.includes('<details class="evergreen-redeem" data-redeem-id="a1"><summary class="evergreen-redeem-head"><span class="evergreen-fund-main"><strong>第 1 笔 · USD 2,500</strong><small>约 27-02-01 到账</small></span><span class="evergreen-pill" data-state="redeeming">等赎回日</span></summary>'), "a request is still shown after the state is changed, closed");
  assert.ok(view.includes("<details class=\"evergreen-redeem-edit\" data-evergreen-redeem-edit><summary>修改</summary>"));
  const opened = r.evergreenRedeemView(fund("hold"), [{ id: "a1", requested: "2026-11-10" }], q, today, { open: new Set(["a1"]), edit: "", ask: "" }); assert.ok(opened.includes('data-redeem-id="a1" open>')); assert.equal(opened.includes("data-evergreen-redeem-edit open"), false);
  const editing = r.evergreenRedeemView(fund("hold"), [{ id: "a1", requested: "2026-11-10" }], q, today, { open: new Set(), edit: "a1", ask: "a1" }); assert.ok(editing.includes('data-redeem-id="a1" open>')); assert.ok(editing.includes("data-evergreen-redeem-edit open>")); assert.ok(editing.includes("data-evergreen-redeem-del>再点一次确认删除</button>"));
  assert.deepEqual([...view.matchAll(/<li( data-done="true")?><small>([^<]+)<\/small><b>([^<]+)<\/b><\/li>/g)].map(m => [m[2], m[3], Boolean(m[1])]), [["申请", "26-11-10", true], ["通知截止", "26-11-16", true], ["赎回日", "26-12-31", false], ["预计到账", "27-02-01", false]]);
  assert.deepEqual([...view.matchAll(/data-evergreen-redeem="(\w+)" type="(\w+)" value="([^"]*)"/g)].map(m => m.slice(1)), [["shares", "number", ""], ["amount", "number", "2500"], ["requested", "date", "2026-11-10"], ["dealing", "date", ""], ["cashBy", "date", ""], ["acceptedPct", "number", ""], ["tailPct", "number", "10"], ["tailBy", "date", ""], ["receivedOn", "date", ""]]);
  assert.ok(view.includes("<strong>尾款</strong><small>审计后，估 · 最晚 06-29</small>")); assert.ok(view.includes("data-evergreen-redeem-del>删除这笔</button>")); assert.ok(view.includes("加密同步到你的其它管理人设备。"));
  const whole = r.evergreenRedeemView(fund("redeeming"), [{ id: "a1", requested: "2026-11-10" }], undefined, today);
  assert.ok(whole.includes("<strong>第 1 笔 · 全部</strong><small>到账日待定</small>")); assert.ok(whole.includes('data-state="redeeming">日期待定</span>')); assert.ok(whole.includes('placeholder="全部"')); assert.ok(whole.includes("<b>待定</b>"));
  const facts = r.evergreenRedeemView(fund("partial"), [{ id: "s1", shares: 77, estCents: 10000000, dealing: "2026-11-30", cashBy: "2026-12-14", note: "订单 <待处理>" }, { id: "s2", shares: 52.711, hold: true }, { id: "s3", shares: 7.757, estCents: 1118577, received: true }], q, today);
  assert.ok(facts.includes("<strong>第 1 笔 · 77 份（约 USD 100,000）</strong><small>约 26-12-14 到账</small>")); assert.ok(facts.includes('<p class="evergreen-meta">订单 &lt;待处理&gt;</p>')); assert.ok(facts.includes('<small>申请</small><b>待定</b>'));
  assert.ok(facts.includes('USD 100,000<small>估</small>')); assert.ok(facts.includes('<strong>第 2 笔 · 52.711 份</strong></span><span class="evergreen-pill" data-state="watch">待处理</span>'), "on hold: no arrival line");
  assert.ok(facts.includes('<span class="evergreen-cash-date">已到账</span><span class="evergreen-cash-what"><strong>首笔</strong><small>日期待核</small>')); assert.ok(facts.includes('data-evergreen-redeem="hold" type="checkbox" checked>暂不排期（需重提或待核实）')); assert.ok(facts.includes('data-evergreen-redeem="received" type="checkbox" checked>首笔已到账，日期待核'));
  assert.equal((facts.match(/type="checkbox" checked/g) || []).length, 4);
  // simple-form:v1 — one amount box and an estimate tick instead of four boxes; each date on its own line, with 清除 only
  // beside a date that is filled; what a platform confirmation supplies is folded and says how much of it is filled.
  assert.equal(/data-evergreen-redeem="(cents|estCents)"/.test(view + facts), false);
  assert.ok(view.includes('金额 USD（留空＝全部）<input data-evergreen-redeem="amount" type="number" value="2500"')); assert.ok(view.includes('data-evergreen-redeem="est" type="checkbox">金额是估算值'));
  assert.ok(facts.includes('金额 USD（估算）<input data-evergreen-redeem="amount" type="number" value="100000"')); assert.ok(facts.includes('data-evergreen-redeem="est" type="checkbox" checked>金额是估算值'));
  assert.equal(whole.includes('data-evergreen-redeem="est"'), false, "no amount, no estimate tick");
  assert.ok(view.includes('<div class="evergreen-day"><label><span>申请日</span><input data-evergreen-redeem="requested" type="date" value="2026-11-10"></label><button class="btn" type="button" data-evergreen-redeem-clear="requested" aria-label="清除申请日">清除</button></div>'));
  assert.ok(view.includes('<div class="evergreen-day"><label><span>赎回日</span><input data-evergreen-redeem="dealing" type="date" value=""></label></div>'), "an empty date has nothing to clear");
  assert.deepEqual([...facts.matchAll(/data-evergreen-redeem-clear="(\w+)"/g)].map(m => m[1]), ["dealing", "cashBy"]);
  assert.ok(view.includes('<details class="evergreen-redeem-more" data-evergreen-redeem-more><summary>平台确认后再填 · 已填 1 项</summary>')); assert.ok(whole.includes("data-evergreen-redeem-more><summary>平台确认后再填</summary>"));
  assert.ok(r.evergreenRedeemView(fund("hold"), [{ id: "a1" }], q, today, { open: new Set(), edit: "a1", ask: "", more: "a1" }).includes("data-evergreen-redeem-more open>"));
  assert.match(html, /clear=event\.target\?\.closest\?\.\('\[data-evergreen-redeem-clear\]'\)/); assert.match(html, /list\[at\]=evergreenRedeemEdit\(list\[at\],clear\.getAttribute\('data-evergreen-redeem-clear'\),''\);/);
  assert.match(html, /else if\(has\('evergreen-redeem-more'\)\)\{[^\n]*_evergreenRedeemMore=id;/); assert.match(html, /\.evergreen-day input\{-webkit-appearance:none;appearance:none;display:block;width:100%;min-width:0;max-width:100%;/); assert.ok(facts.includes('data-evergreen-redeem="note" type="text" maxlength="300" value="订单 &lt;待处理&gt;"'));
  assert.equal(r.evergreenRedeemView(fund("redeeming"), Array.from({ length: 6 }, (_, i) => ({ id: "x" + i, requested: "2026-11-10" })), q, today).includes("data-evergreen-redeem-add"), false, "six requests a fund at most");
  // Wiring: the desk hands each fund its form and puts the forecast above the list; fields are 16px so an iPhone does not zoom.
  assert.match(html, /fund\.redeemHtml=evergreenRedeemView\(fund,redeems\[fund\.key\],terms\[fund\.key\],today,\{open:_evergreenRedeemOpen,edit:_evergreenRedeemEdit,ask:_evergreenRedeemAsk,more:_evergreenRedeemMore,filed:_evergreenRedeemFiled\}\);/);
  assert.match(html, /const cashHtml=evergreenCashView\(evergreenCashModel\(model\.funds,redeems,terms,today\),today,_evergreenCashBy,\{open:true,tab:_evergreenCashTab,month:_evergreenCashMonth\}\);/);
  // cash-section:v1 — the forecast is its own section beside the fund list; one is shown at a time and the fund list no longer carries the card.
  {const view=new Function(html.match(/const EVERGREEN_SECTIONS=[^\n]+\nfunction evergreenSectionView[\s\S]*?\n}\n/)[0]+';return evergreenSectionView')();
    const funds=view('funds','<details class="evergreen-cash" open></details>'),cash=view('cash','<details class="evergreen-cash" open></details>'),empty=view('cash',''),odd=view('zzz','x');
    assert.equal(funds.section,'funds');assert.equal(odd.section,'funds');assert.equal(cash.section,'cash');
    assert.ok(funds.html.includes('data-evergreen-section="funds" aria-pressed="true">基金管理</button>'));assert.ok(funds.html.includes('data-evergreen-section="cash" aria-pressed="false">赎回到账预测</button>'));
    assert.ok(!funds.html.includes('evergreen-cash"'));assert.ok(cash.html.includes('<details class="evergreen-cash" open>'));assert.ok(cash.html.includes('aria-pressed="true">赎回到账预测'));
    assert.ok(empty.html.includes('还没有赎回登记'));
    assert.ok(html.includes("const head=evergreenSectionView(_evergreenSection,cashHtml);desk.setAttribute('data-evergreen-part',head.section);\n  if(head.section==='cash'){desk.innerHTML=head.html;_evergreenRows=rows;return;}"));
    assert.ok(html.includes("if(part){_evergreenSection=part.getAttribute('data-evergreen-section');again();return;}"));
    assert.ok(html.includes('.evergreen-desk>.evergreen-section+h2{display:none}'));
    // The card must not carry the attribute the buttons are found by, or every tap inside it would switch section.
    assert.ok(!html.includes("setAttribute('data-evergreen-section'"));}
  assert.match(html, /if\(has\('evergreen-cash'\)\)_evergreenCashOpen=el\.open;/); assert.match(html, /if\(cashTab\)\{_evergreenCashTab=cashTab\.getAttribute\('data-evergreen-cash-tab'\);_evergreenCashOpen=true;again\(''\);return;\}/);
  assert.match(html, /\.evergreen-cash input,\.evergreen-redeem input\{font-size:16px\}/); assert.match(html, /\.evergreen-note\{[^}]*width:100%[^}]*font-size:16px/);
});

// evergreen-sync:v1 (owner request 2026-11-24): the owner's marks and redemption requests follow the owner between
// manager devices: sealed to the manager's key, stored as one file in the private store, merged mark by mark.
const remoteBlockForSync = html.slice(html.indexOf("/* evergreen-remote:v1:start */"), html.indexOf("/* evergreen-remote:v1:end */"));
const syncBlock = html.slice(html.indexOf("/* evergreen-sync:v1:start */"), html.indexOf("/* evergreen-sync:v1:end */"));
async function syncBox(saved = {}) {
  const vm = await import("node:vm");
  const memory = new Map(Object.entries(saved).map(([k, v]) => [k, JSON.stringify(v)]));
  const box = { URL, TextEncoder, TextDecoder, Uint8Array, crypto: globalThis.crypto, store: { getItem: k => memory.get(k) ?? null, setItem: (k, v) => { memory.set(k, v); } }, todayStr: () => "2026-11-24" };
  vm.createContext(box);
  vm.runInContext(profileBlock + "\n" + calendarBlock + "\n" + redeemBlock + "\n" + evergreenBlock + "\n" + remoteBlockForSync + "\n" + syncBlock
    + ";globalThis.s={evergreenSyncStamps,evergreenSyncDoc,evergreenSyncClean,evergreenSyncMerge,evergreenSyncText,evergreenSyncLocal,evergreenSyncApply,evergreenSyncTouch,evergreenSyncQuiet,evergreenNotesSeal,evergreenNotesText,evergreenRemoteOpen,evergreenRemoteBytes,evergreenSyncRead,evergreenSyncTake,evergreenSyncView,evergreenLabelSet,evergreenRedeemSave,evergreenLabels,evergreenRedeems,EVERGREEN_NOTES_KIND};", box);
  return { s: box.s, memory };
}
test("the owner's marks are sealed to the manager's key: only that key opens them, and never as a terms pack", async () => {
  const { s } = await syncBox(), subtle = globalThis.crypto.subtle;
  assert.ok(syncBlock.length > 3000); assert.doesNotMatch(syncBlock, /fetch\(|XMLHttpRequest|innerHTML|saveLedger|changeDraft|writeRemoteFundBundle|GH_FILE\b/);
  const pair = await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]), other = await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  const recipient = { schema: "r", algorithm: "X25519-HKDF-SHA256-AES256GCM", scopeId: "a".repeat(64), recipientId: "b".repeat(64), publicKey: Buffer.from(await subtle.exportKey("raw", pair.publicKey)).toString("base64url") };
  for (const bytes of [[], [0], [255, 254], [1, 2, 3], [250, 251, 252, 253, 254, 255, 0]]) assert.equal(s.evergreenNotesText(Uint8Array.from(bytes)), Buffer.from(bytes).toString("base64url"));
  const text = JSON.stringify({ schema: "fee-console.evergreen-notes.v1", labels: { "P|基金甲": { state: "redeeming", note: "等回款" } }, redeems: { "P|基金甲": { items: [{ id: "a1", requested: "2026-11-10", cents: 12345600 }], gone: {} } } });
  const sealed = await s.evergreenNotesSeal(text, recipient, "2026-11-24T03:00:00.000Z"), envelope = JSON.parse(sealed);
  assert.deepEqual(Object.keys(envelope).sort(), ["algorithm", "ciphertext", "ephemeralPublicKey", "generatedAt", "iv", "recipientId", "salt", "schema", "scopeId"]);
  assert.equal(envelope.schema, "fee-console.evergreen-notes-sealed.v1"); for (const secret of ["基金甲", "等回款", "12345600", "redeeming", "requested"]) assert.equal(sealed.includes(secret), false);
  assert.notEqual(sealed, await s.evergreenNotesSeal(text, recipient, "2026-11-24T03:00:00.000Z"), "a fresh key, salt and nonce every time");
  assert.equal((await s.evergreenRemoteOpen(sealed, pair.privateKey, recipient, globalThis.crypto, s.EVERGREEN_NOTES_KIND)).text, text);
  await assert.rejects(s.evergreenRemoteOpen(sealed, other.privateKey, recipient, globalThis.crypto, s.EVERGREEN_NOTES_KIND), "another key");
  await assert.rejects(s.evergreenRemoteOpen(sealed, pair.privateKey, recipient), "the pack reader refuses a notes file");
  await assert.rejects(s.evergreenRemoteOpen(sealed, pair.privateKey, { ...recipient, recipientId: "c".repeat(64) }, globalThis.crypto, s.EVERGREEN_NOTES_KIND));
  await assert.rejects(s.evergreenRemoteOpen(JSON.stringify({ ...envelope, generatedAt: "2026-11-24T03:00:01.000Z" }), pair.privateKey, recipient, globalThis.crypto, s.EVERGREEN_NOTES_KIND), "the time is bound");
  for (const bad of [[text, { ...recipient, publicKey: "x" }, "2026-11-24T03:00:00.000Z"], [text, { ...recipient, scopeId: "z" }, "2026-11-24T03:00:00.000Z"], [text, recipient, "2026-11-24"], ["", recipient, "2026-11-24T03:00:00.000Z"]]) await assert.rejects(s.evergreenNotesSeal(...bad));
  // A stored file this device cannot open counts as empty rather than as an error.
  assert.deepEqual(plain(await s.evergreenSyncRead({ content: sealed }, pair.privateKey, recipient)), { schema: "fee-console.evergreen-notes.v1", labels: { "P|基金甲": { state: "redeeming", note: "等回款", reviewBy: "", updatedAt: "", decided: "", at: 0 } }, redeems: { "P|基金甲": { items: [{ id: "a1", requested: "2026-11-10", cents: 12345600, at: 0 }], gone: {} } } });
  assert.equal(await s.evergreenSyncRead({ content: sealed }, other.privateKey, recipient), null); assert.equal(await s.evergreenSyncRead({ content: sealed, truncated: true }, pair.privateKey, recipient), null); assert.equal(await s.evergreenSyncRead(undefined, pair.privateKey, recipient), null);
});
test("every change is timed; two devices merge mark by mark, the later change wins and a deleted request stays deleted", async () => {
  const { s, memory } = await syncBox({ "feeConsole.evergreen.labels.v1": { "P|Old": { state: "watch", note: "before sync" } } });
  assert.deepEqual(plain(s.evergreenSyncStamps()), { labels: {}, redeems: {}, gone: {}, dirty: false, syncedAt: "" });
  // Marks made before syncing existed travel too, with no time.
  assert.deepEqual(plain(s.evergreenSyncLocal().labels), { "P|Old": { state: "watch", note: "before sync", reviewBy: "", updatedAt: "", decided: "", at: 0 } });
  s.evergreenSyncTouch({ labels: ["P|A"] }, 1000);
  assert.equal(s.evergreenRedeemSave("P|A", [{ id: "a1", requested: "2026-11-10" }, { id: "a2", requested: "2026-11-12", cents: 500 }]), true);
  const first = plain(s.evergreenSyncStamps()); assert.equal(first.dirty, true); assert.equal(first.labels["P|A"], 1000); assert.deepEqual(Object.keys(first.redeems["P|A"]), ["a1", "a2"]);
  s.evergreenSyncTouch({ redeem: { key: "P|A", before: [{ id: "a1", requested: "2026-11-10" }, { id: "a2", requested: "2026-11-12", cents: 500 }], after: [{ id: "a1", requested: "2026-11-10" }] } }, 5000);
  const second = plain(s.evergreenSyncStamps()); assert.deepEqual(second.gone, { "P|A": { a2: 5000 } }); assert.equal(second.redeems["P|A"].a1, first.redeems["P|A"].a1, "an unchanged request keeps its time"); assert.equal("a2" in second.redeems["P|A"], false);
  assert.equal(s.evergreenLabelSet("P|B", { state: "hold" }), true); assert.ok(s.evergreenSyncStamps().labels["P|B"] > 5000);
  // Cleaning a stored document.
  assert.equal(s.evergreenSyncClean({ schema: "other" }), null); assert.equal(s.evergreenSyncClean(null), null);
  assert.deepEqual(plain(s.evergreenSyncClean({ schema: "fee-console.evergreen-notes.v1", labels: { "P|A": { state: "nope", note: 5, at: -1 }, "": { state: "hold" } }, redeems: { "P|A": { items: [{ id: "ok", requested: "2026-11-10", at: 7, extra: 1 }, { id: "BAD", requested: "2026-11-10" }, { requested: "2026-11-10" }], gone: { ok2: 9, "BAD ID": 9, zero: 0 } }, "P|E": { items: [], gone: {} } }, extra: 1 })),
    { schema: "fee-console.evergreen-notes.v1", labels: { "P|A": { state: "", note: "", reviewBy: "", updatedAt: "", decided: "", at: 0 } }, redeems: { "P|A": { items: [{ id: "ok", requested: "2026-11-10", at: 7 }], gone: { ok2: 9 } } } });
  const label = (state, at, note = "") => ({ state, note, reviewBy: "", updatedAt: "", decided: "", at }), doc = (labels, redeems = {}) => ({ schema: "fee-console.evergreen-notes.v1", labels, redeems });
  const rec = (id, at, cents) => ({ id, requested: "2026-11-10", ...(cents ? { cents } : {}), at });
  const mine = doc({ "P|A": label("hold", 10), "P|B": label("watch", 30), "P|C": label("", 0), "P|D": label("hold", 5) }, { "P|A": { items: [rec("x", 10, 100), rec("y", 20)], gone: {} }, "P|B": { items: [rec("k", 3)], gone: {} } });
  const theirs = doc({ "P|A": label("redeeming", 20), "P|B": label("hold", 10), "P|C": label("partial", 0), "P|E": label("prepare", 1) }, { "P|A": { items: [rec("x", 15, 999), rec("z", 5)], gone: { y: 25 } }, "P|B": { items: [], gone: { k: 3 } } });
  const merged = plain(s.evergreenSyncMerge(mine, theirs));
  assert.deepEqual(Object.fromEntries(Object.entries(merged.labels).map(([k, l]) => [k, l.state + "@" + l.at])), { "P|A": "redeeming@20", "P|B": "watch@30", "P|C": "partial@0", "P|D": "hold@5", "P|E": "prepare@1" });
  assert.deepEqual(merged.redeems["P|A"], { items: [rec("x", 15, 999), rec("z", 5)], gone: { y: 25 } }, "the later edit of x wins and y, deleted after its last change, stays deleted");
  assert.deepEqual(merged.redeems["P|B"], { items: [], gone: { k: 3 } }, "a deletion at the same time as the last change wins");
  // Whichever device merges, the result is the same, so two devices settle instead of overwriting each other for ever.
  assert.equal(s.evergreenSyncText(s.evergreenSyncMerge(theirs, mine)), s.evergreenSyncText(merged)); assert.equal(s.evergreenSyncText(s.evergreenSyncMerge(merged, theirs)), s.evergreenSyncText(merged)); assert.equal(s.evergreenSyncText(s.evergreenSyncMerge(merged, mine)), s.evergreenSyncText(merged));
  const tie = [doc({ "P|T": label("hold", 0, "a") }, { "P|T": { items: [rec("t", 0, 1)], gone: {} } }), doc({ "P|T": label("watch", 0, "b") }, { "P|T": { items: [rec("t", 0, 2)], gone: {} } })];
  assert.equal(s.evergreenSyncText(s.evergreenSyncMerge(tie[0], tie[1])), s.evergreenSyncText(s.evergreenSyncMerge(tie[1], tie[0])));
  // A request edited after it was deleted elsewhere comes back; key order never makes two documents differ.
  assert.deepEqual(plain(s.evergreenSyncMerge(doc({}, { "P|A": { items: [rec("y", 30)], gone: {} } }), theirs)).redeems["P|A"].items.map(r => r.id), ["x", "y", "z"]);
  assert.equal(s.evergreenSyncText({ b: 1, a: { d: 1, c: [2, 1] } }), '{"a":{"c":[2,1],"d":1},"b":1}');
  // Applying a merged document replaces what the device holds, times included.
  assert.equal(s.evergreenSyncApply(s.evergreenSyncMerge(mine, theirs), { dirty: false, syncedAt: "2026-11-24T03:00:00.000Z" }), true);
  assert.equal(JSON.parse(memory.get("feeConsole.evergreen.labels.v1"))["P|A"].state, "redeeming"); assert.equal("at" in JSON.parse(memory.get("feeConsole.evergreen.labels.v1"))["P|A"], false);
  assert.deepEqual(plain(s.evergreenRedeems()), { "P|A": [{ id: "x", requested: "2026-11-10", cents: 999 }, { id: "z", requested: "2026-11-10" }] });
  assert.deepEqual(plain(s.evergreenSyncStamps()), { labels: { "P|A": 20, "P|B": 30, "P|D": 5, "P|E": 1 }, redeems: { "P|A": { x: 15, z: 5 } }, gone: { "P|A": { y: 25 }, "P|B": { k: 3 } }, dirty: false, syncedAt: "2026-11-24T03:00:00.000Z" });
  assert.equal(s.evergreenSyncText(s.evergreenSyncLocal()), s.evergreenSyncText(merged), "what was applied reads back as the same document");
});
test("another device's changes arrive with the authenticated read, and this device's unsent ones are flagged", async () => {
  const subtle = globalThis.crypto.subtle, pair = await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  const recipient = { schema: "r", algorithm: "X25519-HKDF-SHA256-AES256GCM", scopeId: "a".repeat(64), recipientId: "b".repeat(64), publicKey: Buffer.from(await subtle.exportKey("raw", pair.publicKey)).toString("base64url") };
  const { s, memory } = await syncBox({ "feeConsole.evergreen.labels.v1": { "P|A": { state: "hold" } }, "feeConsole.evergreen.sync.v1": { labels: { "P|A": 10 } } });
  const remote = { schema: "fee-console.evergreen-notes.v1", labels: { "P|A": { state: "partial", note: "手机上改的", at: 99 } }, redeems: { "P|A": { items: [{ id: "m1", requested: "2026-11-20", cents: 30000, at: 99 }], gone: {} } } };
  const file = { content: await s.evergreenNotesSeal(JSON.stringify(remote), recipient, "2026-11-24T03:00:00.000Z") };
  assert.equal(await s.evergreenSyncTake(file, pair.privateKey, recipient), true);
  assert.equal(s.evergreenLabels()["P|A"].state, "partial"); assert.deepEqual(plain(s.evergreenRedeems()), { "P|A": [{ id: "m1", requested: "2026-11-20", cents: 30000 }] });
  let stamps = plain(s.evergreenSyncStamps()); assert.equal(stamps.dirty, false); assert.match(stamps.syncedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(await s.evergreenSyncTake(file, pair.privateKey, recipient), false, "nothing new the second time");
  // A change made here after that is newer than the store: kept, and flagged to be sent.
  assert.equal(s.evergreenLabelSet("P|A", { state: "redeeming" }), true); assert.equal(await s.evergreenSyncTake(file, pair.privateKey, recipient), false);
  assert.equal(s.evergreenLabels()["P|A"].state, "redeeming"); assert.equal(s.evergreenSyncStamps().dirty, true);
  // No file yet, or one this device cannot open: nothing is lost, and what the device holds is flagged to be sent.
  const fresh = await syncBox({ "feeConsole.evergreen.labels.v1": { "P|Z": { state: "watch" } } });
  assert.equal(await fresh.s.evergreenSyncTake(undefined, pair.privateKey, recipient), false); assert.equal(fresh.s.evergreenLabels()["P|Z"].state, "watch"); assert.equal(fresh.s.evergreenSyncStamps().dirty, true);
  assert.equal(await fresh.s.evergreenSyncTake({ content: "{broken" }, pair.privateKey, recipient), false); assert.equal(fresh.s.evergreenLabels()["P|Z"].state, "watch");
  const empty = await syncBox(); assert.equal(await empty.s.evergreenSyncTake(undefined, pair.privateKey, recipient), false); assert.equal(empty.s.evergreenSyncStamps().dirty, false, "an empty device has nothing to send");
  assert.ok(s.evergreenSyncView({ dirty: true, syncedAt: "" }, "稍后自动同步").includes('data-evergreen-sync="pending">状态、备注和赎回登记有改动待同步（稍后自动同步）'));
  assert.ok(s.evergreenSyncView({ dirty: false, syncedAt: "2026-11-24T03:00:00.000Z" }, "").includes("已同步到你的私有存储（2026-11-24 11:00 香港时间）；加密保存，只有管理人设备能打开。"));
  assert.ok(s.evergreenSyncView({ dirty: false, syncedAt: "" }, "").includes("会自动同步到你的私有存储"));
});
test("the sync writes one file through the reviewed gate, never around the daily automatic publication", async () => {
  const { s } = await syncBox(), at = (h, m) => new Date(Date.UTC(2026, 10, 24, h - 8, m));
  // Hong Kong 07:45–09:00 and 22:40–23:15 are quiet.
  for (const [h, m, quiet] of [[7, 44, false], [7, 45, true], [8, 0, true], [8, 59, true], [9, 0, false], [12, 0, false], [22, 39, false], [22, 40, true], [22, 56, true], [23, 14, true], [23, 15, false], [0, 0, false]]) assert.equal(s.evergreenSyncQuiet(at(h, m)), quiet, h + ":" + m);
  assert.match(syncBlock, /if\(!ratioAuthorized\(\)\|\|EDIT\.draft\|\|EDIT\.pending\|\|_ledgerBusy\|\|_ratioRecipientWrite\|\|_ratioSnapshotWrite\)return 'later';\n  if\(evergreenSyncQuiet\(new Date\(\)\)\)return 'quiet';/);
  assert.match(syncBlock, /if\(!await verifyRatioCapabilityNow\(\)\)throw Error\('EVERGREEN_SYNC_REFUSED'\);check\(\);\n    const gist=ratioSnapshotGist\(await ghApi\('\/gists\/'\+gid\)\);check\(\);/);
  assert.match(syncBlock, /if\(registered===null\|\|ratioCore\.canonical\(ratioSnapshotParse\(registered\)\)!==ratioCore\.canonical\(manager\.recipient\)\)throw Error\('EVERGREEN_SYNC_REFUSED'\);/);
  assert.equal((syncBlock.match(/ghApi\(/g) || []).length, 2, "one read and one write");
  assert.match(syncBlock, /await ghApi\('\/gists\/'\+gid,\{method:'PATCH',body:JSON\.stringify\(\{files:\{\[EVERGREEN_NOTES_FILE\]:\{content:raw\}\}\}\),reviewedEvergreenNotes:op\}\);\}finally\{if\(_evergreenNotesWrite===op\)_evergreenNotesWrite=null;\}/);
  assert.match(html, /try\{evergreenSyncTake\(gist\.files\[EVERGREEN_NOTES_FILE\],manager\.privateKey,manager\.recipient\)\.catch\(\(\)=>\{\}\);\}catch\{\}/);
  assert.match(html, /if\(typeof evergreenSyncTouch==='function'\)evergreenSyncTouch\(\{labels:\[key\]\}\);/); assert.match(html, /evergreenSyncTouch\(\{redeem:\{key,before,after:evergreenRedeems\(\)\[key\]\|\|\[\]\}\}\);/);
  assert.match(html, /const EVERGREEN_NOTES_FILE='fee-console-evergreen-notes\.json'/);
});
test('the fund-marks sync may PATCH only its own file with the exact sealed text it registered, as a verified manager with no ledger work open',async()=>{
  const vm=await import('node:vm'),unifiedUiSource=html,a=unifiedUiSource.indexOf('async function ghApi('),b=unifiedUiSource.indexOf('\n}',a)+2,raw='{"syntheticSealedNotes":true}',gid='0'.repeat(32),op={gid,token:'invented-token',epoch:1,raw};
  let calls=0,authorized=true;const values={gid,tok:'invented-token'},ctx={_ledgerBusy:false,_draftBlocked:false,EDIT:{},_fundRemoteWrite:null,_legacyMigrationPending:null,_ratioRecipientWrite:null,_ratioSnapshotWrite:null,_evergreenNotesWrite:op,_sourceEpoch:1,RATIO_RECIPIENT_FILE:'fee-console-ratio-recipient.json',RATIO_SNAPSHOT_FILE:'fee-console-ratio-snapshot.json',EVERGREEN_NOTES_FILE:'fee-console-evergreen-notes.json',ratioAuthorized:()=>authorized,managerDocumentsAuthorized:()=>true,cfg:k=>values[k]||'',K:{gid:'gid',tok:'tok'},Object,JSON,Error,String,Boolean,fetch:async(url,o)=>{calls++;assert.equal(url,'https://api.github.com/gists/'+gid);assert.equal(o.reviewedEvergreenNotes,undefined);assert.deepEqual(Object.keys(JSON.parse(o.body).files),['fee-console-evergreen-notes.json']);return {ok:true,status:200,json:async()=>({})};}};
  vm.createContext(ctx);vm.runInContext(unifiedUiSource.slice(a,b)+'\nthis.run=ghApi;',ctx);
  const body=JSON.stringify({files:{'fee-console-evergreen-notes.json':{content:raw}}}),file=name=>JSON.stringify({files:{[name]:{content:raw}}});
  await ctx.run('/gists/'+gid,{method:'PATCH',body,reviewedEvergreenNotes:op});assert.equal(calls,1);
  for(const opt of [{method:'PATCH',body},{method:'PATCH',body,reviewedEvergreenNotes:{...op}},{method:'PATCH',body:file('data.json'),reviewedEvergreenNotes:op},{method:'PATCH',body:file('fee-console-ratio-snapshot.json'),reviewedEvergreenNotes:op},{method:'PATCH',body:file('fee-console-evergreen-pack.json'),reviewedEvergreenNotes:op},
    {method:'PATCH',body:JSON.stringify({files:{'fee-console-evergreen-notes.json':{content:raw},'data.json':{content:raw}}}),reviewedEvergreenNotes:op},{method:'PATCH',body:JSON.stringify({files:{'fee-console-evergreen-notes.json':{content:raw+' '}}}),reviewedEvergreenNotes:op},{method:'PATCH',body,headers:{},reviewedEvergreenNotes:op},{method:'DELETE',body,reviewedEvergreenNotes:op},{method:'POST',body,reviewedEvergreenNotes:op},
    {method:'PATCH',body,reviewedRatioSnapshot:op},{method:'PATCH',body,reviewedFund:op}])await assert.rejects(ctx.run('/gists/'+gid,opt));
  await assert.rejects(ctx.run('/gists/'+'1'.repeat(32),{method:'PATCH',body,reviewedEvergreenNotes:op}));
  for(const change of [()=>{ctx.EDIT.draft={};},()=>{ctx.EDIT.pending={};},()=>{ctx._ledgerBusy=true;},()=>{authorized=false;},()=>{ctx._sourceEpoch=2;},()=>{values.tok='another-token';},()=>{ctx._evergreenNotesWrite=null;}]){
    ctx.EDIT={};ctx._ledgerBusy=false;authorized=true;ctx._sourceEpoch=1;values.tok='invented-token';ctx._evergreenNotesWrite=op;change();await assert.rejects(ctx.run('/gists/'+gid,{method:'PATCH',body,reviewedEvergreenNotes:op}));}
  assert.equal(calls,1);
});
test("two manager devices sharing one private store settle on the same marks, and nothing is written when it must not be", async () => {
  const vm = await import("node:vm"), subtle = globalThis.crypto.subtle, pair = await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  const recipient = { schema: "r", algorithm: "X25519-HKDF-SHA256-AES256GCM", scopeId: "a".repeat(64), recipientId: "b".repeat(64), publicKey: Buffer.from(await subtle.exportKey("raw", pair.publicKey)).toString("base64url") };
  const gist = { files: { "fee-console-ratio-recipient.json": { content: JSON.stringify(recipient) } } }, log = [];
  let hour = 12, clock = Date.UTC(2026, 10, 24, 4, 0, 0);
  class At extends Date { constructor(...a) { if (a.length) super(...a); else super(Date.UTC(2026, 10, 24, hour - 8, 0, 0)); } static now() { return clock += 1000; } }
  const device = async () => {
    const memory = new Map(), box = { URL, TextEncoder, TextDecoder, Uint8Array, crypto: globalThis.crypto, Date: At, store: { getItem: k => memory.get(k) ?? null, setItem: (k, v) => { memory.set(k, v); } }, todayStr: () => "2026-11-24",
      EDIT: {}, _ledgerBusy: false, _ratioRecipientWrite: null, _ratioSnapshotWrite: null, _sourceEpoch: 1, authorized: true, K: { gid: "gid", key: "key", tok: "tok" }, cfg: k => ({ gid: "0".repeat(32), key: "k", tok: "t" })[k],
      RATIO_RECIPIENT_FILE: "fee-console-ratio-recipient.json", ratioIdentity: () => "owner", verifyRatioCapabilityNow: async () => true, ratioSnapshotGist: g => g, ratioSnapshotFile: (g, n) => g.files?.[n]?.content ?? null, ratioSnapshotParse: JSON.parse,
      ratioCore: { deriveSnapshotManager: async () => ({ privateKey: pair.privateKey, recipient }), canonical: v => JSON.stringify(v) } };
    box.ratioAuthorized = () => box.authorized;
    box.ghApi = async (path, opt = {}) => { assert.equal(path, "/gists/" + "0".repeat(32)); log.push(opt.method || "GET");
      if (opt.method === "PATCH") { assert.equal(opt.reviewedEvergreenNotes, box.registered()); const files = JSON.parse(opt.body).files; assert.deepEqual(Object.keys(files), ["fee-console-evergreen-notes.json"]); gist.files["fee-console-evergreen-notes.json"] = { content: files["fee-console-evergreen-notes.json"].content }; return {}; }
      return JSON.parse(JSON.stringify(gist)); };
    vm.createContext(box);
    vm.runInContext(profileBlock + "\n" + calendarBlock + "\n" + redeemBlock + "\n" + evergreenBlock + "\n" + remoteBlockForSync + "\n" + syncBlock + ";globalThis.registered=()=>_evergreenNotesWrite;globalThis.d={evergreenSyncPush,evergreenSyncTake,evergreenLabelSet,evergreenRedeemSave,evergreenLabels,evergreenRedeems,evergreenSyncStamps,evergreenSyncLocal,evergreenSyncText};", box);
    return { box, d: box.d, take: () => box.d.evergreenSyncTake(gist.files["fee-console-evergreen-notes.json"], pair.privateKey, recipient) };
  };
  const phone = await device(), laptop = await device();
  // Nothing to say and nothing stored: a read, no write.
  assert.equal(await laptop.d.evergreenSyncPush(), "done"); assert.deepEqual(log, ["GET"]); assert.equal("fee-console-evergreen-notes.json" in gist.files, false);
  phone.d.evergreenLabelSet("P|A", { state: "partial", note: "先赎一半" }); phone.d.evergreenRedeemSave("P|A", [{ id: "p1", requested: "2026-11-10", cents: 5000000 }]);
  // Refused without touching the network: ledger work open, another write under way, not a verified manager, or the quiet hours.
  for (const [set, unset, want] of [[b => { b.EDIT.draft = {}; }, b => { b.EDIT = {}; }, "later"], [b => { b._ledgerBusy = true; }, b => { b._ledgerBusy = false; }, "later"], [b => { b._ratioSnapshotWrite = {}; }, b => { b._ratioSnapshotWrite = null; }, "later"], [b => { b.authorized = false; }, b => { b.authorized = true; }, "later"], [() => { hour = 8; }, () => { hour = 12; }, "quiet"], [() => { hour = 23; }, () => { hour = 12; }, "quiet"]]) {
    set(phone.box); assert.equal(await phone.d.evergreenSyncPush(), want); unset(phone.box); }
  assert.deepEqual(log, ["GET"]); assert.equal(phone.d.evergreenSyncStamps().dirty, true);
  assert.equal(await phone.d.evergreenSyncPush(), "done"); assert.deepEqual(log, ["GET", "GET", "PATCH"]); assert.equal(phone.d.evergreenSyncStamps().dirty, false); assert.equal(phone.box.registered(), null);
  const stored = gist.files["fee-console-evergreen-notes.json"].content; for (const secret of ["P|A", "先赎一半", "5000000", "partial"]) assert.equal(stored.includes(secret), false);
  assert.equal(await phone.d.evergreenSyncPush(), "done"); assert.deepEqual(log.slice(3), ["GET"], "already stored: no second write"); assert.equal(gist.files["fee-console-evergreen-notes.json"].content, stored);
  // The laptop opens the page: the phone's marks arrive. It then changes one thing and deletes nothing.
  assert.equal(await laptop.take(), true); assert.equal(laptop.d.evergreenLabels()["P|A"].note, "先赎一半"); assert.deepEqual(plain(laptop.d.evergreenRedeems()), { "P|A": [{ id: "p1", requested: "2026-11-10", cents: 5000000 }] }); assert.equal(laptop.d.evergreenSyncStamps().dirty, false);
  laptop.d.evergreenRedeemSave("P|A", [{ id: "p1", requested: "2026-11-10", cents: 5000000, cashBy: "2027-02-03" }]); laptop.d.evergreenLabelSet("P|B", { state: "watch" });
  // Meanwhile the phone adds a second request and changes its note; neither device has seen the other's change.
  phone.d.evergreenRedeemSave("P|A", [{ id: "p1", requested: "2026-11-10", cents: 5000000 }, { id: "p2", requested: "2026-11-20", cents: 100000 }]); phone.d.evergreenLabelSet("P|A", { note: "两笔" });
  assert.equal(await laptop.d.evergreenSyncPush(), "done"); assert.equal(await phone.d.evergreenSyncPush(), "done"); assert.equal(await laptop.take(), true);
  const want = { "P|A": [{ id: "p1", requested: "2026-11-10", cashBy: "2027-02-03", cents: 5000000 }, { id: "p2", requested: "2026-11-20", cents: 100000 }] };
  for (const x of [phone, laptop]) { assert.deepEqual(plain(x.d.evergreenRedeems()), want); assert.equal(x.d.evergreenLabels()["P|A"].note, "两笔"); assert.equal(x.d.evergreenLabels()["P|B"].state, "watch"); }
  assert.equal(phone.d.evergreenSyncText(phone.d.evergreenSyncLocal()), laptop.d.evergreenSyncText(laptop.d.evergreenSyncLocal()));
  // A deletion on one device removes the request on the other and does not come back.
  laptop.d.evergreenRedeemSave("P|A", [want["P|A"][0]]); assert.equal(await laptop.d.evergreenSyncPush(), "done"); assert.equal(await phone.take(), true); assert.deepEqual(plain(phone.d.evergreenRedeems()["P|A"].map(r => r.id)), ["p1"]);
  assert.equal(await phone.d.evergreenSyncPush(), "done"); assert.equal(await laptop.take(), false); assert.deepEqual(plain(laptop.d.evergreenRedeems()["P|A"].map(r => r.id)), ["p1"]);
  // A failed write leaves the marks on the device, still flagged.
  phone.d.evergreenLabelSet("P|C", { state: "hold" }); phone.box.ghApi = async () => { throw Error("offline"); };
  assert.equal(await phone.d.evergreenSyncPush(), "failed"); assert.equal(phone.d.evergreenLabels()["P|C"].state, "hold"); assert.equal(phone.d.evergreenSyncStamps().dirty, true); assert.equal(phone.box.registered(), null);
});
