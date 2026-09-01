# XUAN-IB handover publication contract

Any complete XUAN-IB handover produced from this repository—scheduled, Run now,
manual, recovery, or ad hoc—must enter the same trusted publication path.

1. Create a branch named `claude/<descriptive-name>-<six-lowercase-alphanumeric>`.
2. Base it on `main` or a current ancestor of `main`.
3. Create exactly one non-merge commit that changes only `xuan-ib/index.html`.
4. Use the commit subject `handover YYYY-MM-DD`, matching the page data date.
5. Preserve the self-contained page marker and pass
   `node scripts/handover-guard.mjs xuan-ib/index.html YYYY-MM-DD`.
6. Push the candidate branch and report its branch, SHA, and guard result.
7. Do not claim that the phone page is updated until trusted promotion and Pages
   deployment have completed. Never edit `xuan-ib/latest.html` or
   `xuan-ib/latest.meta.json` directly.

## Decision and receipt continuity

Before producing any candidate, read the paired, trusted
`xuan-ib/latest.meta.json` and `xuan-ib/latest.html` from `main`. AM, PM, ad hoc,
manual, recovery, and records-only candidates must carry forward every existing
decision and every receipt from that trusted page. Existing receipt objects are
append-only and immutable: the complete old receipt array must remain the exact
ordered prefix of the new array. Stable decision IDs must not be deleted,
recreated, or silently reset. A new receipt may reference only a decision that
already existed as `awaiting_user` in the trusted previous page; do not create a
decision and receipt together. Because v1 has no reject action, do not change
`awaiting_user` directly to `rejected`. A candidate may otherwise add decisions,
append receipts, or apply an allowed decision-state transition, but it must
never make the phone page forget previously published management responses.

A candidate that only records a decision response is a `records-update`, not an
ad-hoc report. It must preserve the prior edition label, data date, as-of times,
financial values, and calculation text, and it must not be counted as evidence
that an AM or PM run succeeded. Do not relabel it as `临时版` or fetch financial
data merely to record the response.

Classify that candidate with exactly one inert marker placed immediately after
the existing publication marker, without adding whitespace:
`<!-- xuan-ib-handover:v1 --><!-- xuan-ib-records-update:v1 -->`.
The marker is fail-closed: a records-update must append at least one receipt for
a decision that existed as `awaiting_user` in the trusted previous page, and
must preserve the trusted previous `interaction` mode exactly. Apart from the
inert template, matching `data-decision-status`, pending badge/aria count, and
the guarded display migration below, the prior HTML must remain
byte-semantically identical. An accepted/modified card may move from
`待决定事项` to `已决定 / 待落实` only inside the two unique
`xuan-ib-decision-group:v1:{awaiting_user|resolved}:{start|end}` marker pairs.
The guard requires exact group titles/counts, exact visible status labels, and
an otherwise unchanged card, including its recommendation body. Do not change
edition/date/as-of/amount/calculation text, unrelated cards, or add a new
decision in a records-update. The
commit subject remains `handover <trusted previous dataDate>` even when that
date is older than today/yesterday; this stale-date exception applies only to a
guard-verified records-update.

Decision-state rollout is staged. While the trusted previous page has no
`xuan-ib-decision-state-v1` template, legacy candidates without one remain
compatible. The first structural bootstrap must publish a strictly valid
template with `interaction: "disabled"` and an empty `receipts` array; it must
not invent historical receipts.
Once a trusted published page contains the template, every later report must
inherit it and its complete history. Flip it to `interaction: "enabled"` only
after the real Routine and Shortcut have been exercised against the bootstrap.
A later, separately reviewed maintenance change may make the template globally
mandatory after production evidence exists; do not combine that tightening with
the first bootstrap.

The trusted promotion workflow anchors each published source commit under the
immutable `xuan-ib-published/` tag namespace. Do not create, move, or delete
those tags from a handover-producing session.

Financial systems are read-only for this workflow. Never place, modify, or cancel
orders, and never initiate transfers or write to IB, Sharesight, or another
financial account.

## Static index-ETF policy page

`xuan-ib/policy.html` is the deterministic, static, read-only presentation of
the separately approved index-ETF policy in
`claude/xuan-ib-policy-v2.json`. Its approval record is
`claude/xuan-ib-policy-v2-approval-2026-09-01.md`, and
`scripts/xuan-ib-policy-page.mjs` is the only trusted renderer for the page.

This policy page is not a handover report, report candidate, scheduled-run
result, financial-data snapshot, or evidence that an AM, PM, recovery, manual,
or ad-hoc report succeeded. It must not be substituted for
`xuan-ib/index.html`, `xuan-ib/latest.html`, or `xuan-ib/latest.meta.json`, and
it must never be changed in a single-file handover candidate. Changes to the
policy JSON, approval record, renderer, tests, or rendered page require a
separately reviewed maintenance PR and exact-SHA owner approval under the
publication lock.

The only permitted handover integration is the byte-identical output of
`renderPolicySection(policy)`, placed as the first visible module inside the
unique independent `.pane.p5` ETF pane. The five visible labels remain in the
fixed order `概览 / 风险 / 配置 / ETF / 待办`; the existing todo radio and pane
remain `s4` / `p4`. Do not copy or edit `policy.html`, the
policy JSON, renderer, approval record, or tests in a candidate; the single-file
`xuan-ib/index.html` candidate contract remains unchanged. The first production
rollout is complete: every ordinary fresh report must include the canonical
section in `p5`. Use the trusted `scripts/xuan-ib-etf-pane.mjs` migration for a
legacy ordinary report; it is deterministic, idempotent, and must not be used
on a records-update. A records-update may only preserve the previous page's
policy state byte for byte and in place: inherit legacy `p3` or current `p5`
when present, or keep it absent on a legacy page. Never bootstrap or move the
section through a records-update. Any optional A/B/C runtime block follows the
canonical policy section inside `p5`; it never precedes or replaces it.

Keep policy-v2 distinct from the existing operational-v1 cash-plan contract.
The static page may describe approved targets, reserve logic, staged funding,
benchmark definitions, and unresolved inputs, but it must not silently relabel
operational-v1 values as policy-v2, invent current financial values, or imply
that a plan has been executed. All page actions are navigation or local display
controls only. Never add order, transfer, financial-write, or broker-action
controls.

## Hong Kong report schedule

Read and follow `claude/xuan-ib-report-schedule-HKT-v1.md` before producing any
XUAN-IB report. `Asia/Hong_Kong` is the only scheduling clock:

- PM / 睡前版: Monday-Friday at 20:55 HKT.
- AM / 早间版: Tuesday-Saturday at 08:00 HKT.
- Ad hoc / 临时版: only when manually requested; it may run at any time.

Every successful edition uses the same candidate, validation, promotion, Pages,
and fixed-mobile-link path above. An ad-hoc edition may become the newest phone
page, but it never proves that a required AM or PM edition ran. US daylight
saving time and market holidays change the report's market-status wording and
data-as-of disclosure, never the Hong Kong delivery schedule.

## Implementation progress after a recorded decision

### Cash-first allocation planning

Follow `claude/xuan-ib-cash-first-plan-v1.md`. The user confirmed existing cash
as the primary source; sales are secondary only after proceeds are available.
Use the deterministic cash-plan renderer with verified USD equity-only inputs.
Never treat static allocation gaps as cash-buy amounts, assume pending sales
are cash, or describe the cross-platform cash pool as IB immediate buying power.
The approved source-blob-bound snapshot correction in that document is a narrow
formula/display repair, not a financial refresh: preserve raw source data,
edition/date/as-of and all receipts, disclose recalculation, use the ordinary
single-file candidate path, and never count it as new AM/PM success evidence.
Only this requested repair may omit fresh reads; normal reports may not.

### Required deterministic classification disclosure

For every ordinary report with four-bucket content, run
`node scripts/xuan-ib-classification-disclosure.mjs` and insert its exact HTML
section once inside the folded report explanation. This is a trusted,
historically dated three-portfolio audit disclosure, not a new holdings feed.
Do not copy classification reasoning from the previous report. Detailed
classification coverage, Semi Liquid and override/portfolio-rule counts belong
only in this canonical section; use a short dated fallback reference elsewhere.
The trusted handover guard enforces this contract for both Validate and Promote.

The interim disclosure preserves the approved 2026-08-24 four-bucket fallback.
Seven-portfolio holdings completeness, cash identity, pagination and value
reconciliation must be independently checked before a reviewed maintenance
update may replace it with complete-current-audit evidence. A three-portfolio
audit or a mapping-file read alone is not that evidence. The unresolved
classification work never by itself blocks unrelated successfully read report
fields. Do not change mapping rules merely to eliminate a warning.

### Explanation-only correction candidates

An explicitly requested explanation correction is an ordinary publication
candidate, not a new financial read and not a `records-update`. Preserve the
trusted previous edition, data date, all source/as-of times, all financial
amounts and calculations, complete decision state and receipt bytes. Add a
visible statement that only the classification explanation was corrected and
no financial data was fetched or recalculated. Use the canonical section above.
The correction does not count as AM/PM scheduled-run evidence, must satisfy the
ordinary today/yesterday candidate date window, and receives no stale-date
exception or new publication permission. If that date window has expired,
stop rather than relabeling old data as current.

This narrow correction exception supersedes the live-read requirement in
`.claude/rules/xuan-ib-handover.md` and the runtime contract only for this
explicitly requested explanation repair. Regular AM/PM/ad-hoc reports still
must perform their required live reads. Never invent a receipt to obtain the
records-update exception. A legacy receipt-only update can preserve the old
explanation only after all trusted-pair and immutable-body checks succeed.

Read `claude/xuan-ib-implementation-progress-v1.md` and the independent
`xuan-ib/implementation-progress.json` before presenting accepted decisions as
unimplemented. A receipt records an opinion, not execution. Preserve the receipt
history; distinguish verified interim measures from unresolved follow-up work.
The progress ledger is append-only and changes only through a separately
approved maintenance PR. Report candidates must not write it. Never infer a
classification gap as Semi Liquid count minus override count: portfolio-wide
rules also apply. Never silently change GOOG account scope or risk thresholds.

Use the sourced distinction in
`claude/xuan-ib-classification-authority-review-2026-08-31.md`: MRVL ordinary
asset classification is not its AI-pressure tier. The user explicitly approved
MRVL standard T1 (60% / 80% / 100%) on 2026-08-31; follow
`claude/xuan-ib-mrvl-t1-approval-2026-08-31.md` and the identity-bound rule in
`claude/xuan-ib-ai-tier-overrides-v1.json`. Do not ask for the same approval or
continue the historical temporary exclusion. Preserve its original receipt.
The approval document permits one exact-source-blob risk recalculation without
fresh reads; it retains the original edition/data time, clearly discloses the
snapshot update, does not prove a new AM/PM run, and keeps every publication gate.
Normal reports still require the live reads. The runtime contract also defines the
source-bound cash-identity resolver and treatment of genuinely absent labels.
Read it before asserting a classification gap or copying an old pending reason.

The user confirmed GOOG/GOOGL three-account observation (IB, Schwab, Webull)
on 2026-08-31. Apply the two-view contract in the progress document on the next
normal report: three-account observation plus the existing IB execution view.
Keep existing direct-holding numerators, cash-inclusive denominators and all
thresholds; do not infer a new trading trigger, ETF look-through or transfer.
Do not ask for this same scope confirmation again. A recorded rule is not proof
that a new financial report has been generated or verified.

Current GOOG facts in accepted-item cards must match the same report's risk
table, including unrounded numerator/denominator and data time. Do not copy old
amounts from an accepted decision and describe them as newly recomputed. This
does not authorize editing original decision receipts or risk thresholds.
