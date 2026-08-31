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

The user confirmed GOOG/GOOGL three-account observation (IB, Schwab, Webull)
on 2026-08-31. Apply the two-view contract in the progress document on the next
normal report: three-account observation plus the existing IB execution view.
Keep existing direct-holding numerators, cash-inclusive denominators and all
thresholds; do not infer a new trading trigger, ETF look-through or transfer.
Do not ask for this same scope confirmation again. A recorded rule is not proof
that a new financial report has been generated or verified.
