# XUAN-IB handover publication contract

Read `claude/xuan-ib-current-runbook.md` first for the 2026-09-08 current
AM/PM route and precedence over historical pilot/cadence text. It is a concise
index, not permission to relax the linked source, receipt or publication gates.
Merging this file does not update or verify the actual Claude Routines.

## Explicit scheduled account association scope (owner renewed 2026-09-11)

Read `claude/xuan-ib-account-association-v1.md` first. Its September 7 section
supersedes the older adhoc-only scope restrictions below for fixed AM and PM
after exact-head maintenance approval and merge. Use current trusted-main policy
and a new pre-read run-bound receipt for the actual edition. Do not reuse failed
run journals, change raw account identity, extend the October 10 expiry or
reenable retired manual reports. Financial reads and publication remain guarded.
This does not widen weekly-minimal/adhoc-only collection or manual-consent paths.
The same section also governs ordinary explanation/cash-plan/ETF-pane corrections:
old no-read correction permissions do not exempt them from current association
verification. Never mint a fresh receipt over old financial evidence. Only the
guard's strictly verified historical exceptions remain exempt.

## Owner routine closure and concise notes (2026-09-06)

Read `claude/xuan-ib-routine-closeout-20260906.md` first. Routine, evidence-supported
classification under existing coefficients is delegated: implement and verify,
notify once, then archive. Codex is the single accountable owner. Historical
rule records are not recurring user tasks. Preserve all source/receipt history;
never mark missing calculations completed or treat this as trading authority.

Apply a delegated tier only through `calculateDelegatedTier` in
`scripts/xuan-ib-delegated-tier.mjs`, the single supported reader of the locked
`claude/xuan-ib-classification-delegation-v1.json`. Identity must match every
field the approved rule records, and only whitelisted coefficients may be
applied: a new tier or coefficient triple is a separate owner decision, not a
delegated one. Approved rules are AAOI standard T1 and Webull VST / Vistra Corp,
NYSE, standard T1 (`DELEG-20260910-VST-T1`); both keep one stable `notifyId` per
rule, which is an identity to record delivery against, not delivery itself.
Anything the reader refuses is a Codex-owned technical exception for the
technical record — never a new `awaiting_user` item, never a guess, never zero.
Changing that policy file, its reader or its tests needs a separately reviewed
maintenance PR under the publication lock.

## Identity and presence integrity (2026-09-11 AM findings)

The 2026-09-11 early edition surfaced four defects in one run. The repairs below
are measurement and disclosure only: they add no financial permission, no new
coefficient, no account scope and no trading authority, and none of them is
evidence that any AM or PM run succeeded.

**Instrument-scoped venue identity.** IB described one holding as `HODLUSD` on
`EBS` while the portfolio source reported the same instrument as `HODL` on
`EURONEXT`. A venue-scoped key is still correct — the same ticker on two
exchanges is two instruments — so the two spellings are joined only through a
reviewed, instrument-scoped entry in `claude/xuan-ib-venue-identity-v1.json`,
bound to the strong identifier each raw payload already carries (the IB contract
id and the portfolio source's `instrument.id`). `scripts/xuan-ib-venue-identity.mjs`
is the single supported reader. Never declare two venues synonyms: a blanket
alias would silently merge every future instrument listed on both. Never infer a
venue from another custodian's portfolio; that book is not evidence about this
account's instrument, and a run-local script must not reintroduce it. An
unreviewed cross-venue pairing stays fail-closed and is disclosed by name.
A new equivalence is a separately reviewed maintenance change under the
publication lock, never something a report candidate adds.

**Three-valued daily-change presence.** A reading of exactly zero is still not
publishable on its own, because it cannot be told apart from a price a source
carried forward for a session it never loaded. It publishes as `0.00%` only when
an independent same-run reading of the same completed session agrees with it,
and the published row names the corroborating method. When the two readings
disagree the row is withheld and disclosed by name as contradicted; nothing is
averaged, preferred or arbitrated. Every unmeasured row carries an enumerated
machine-readable reason, and the holdings section declares measured and total
coverage, so a dropped row is arithmetic rather than a matter of trust. The
trusted guard enforces both.

**AM per-row fallback `am-session-pnl-v1`.** A position can be live in the
broker's book before the portfolio source has synced it into the single-day
window, which is a gap in one row of one source. AM may fill exactly such a row
from the completed-session reading of the positions payload it already holds.
This is a distinct method, not PM's `session-pnl-v1` renamed: PM's method,
rules and timestamp labelling are unchanged and PM has no fallback at all. All
of the following must be proven before this method publishes a row: the
intended session is the completed session one day before the Hong Kong data
date; the venue's session for that date is provably finished; the reading's
`observedAtHkt` falls on the report date; `mark × quantity` reproduces the
payload's own `market_value`; and no trade or corporate action in the same
window touched the position. The portfolio source's own nonzero window reading
is still what publishes whenever it exists.

**Structural AI-tier coverage, and the new-position `AUTO` policy.** A position
appeared with no approved rule and was dropped from the AI-pressure numerator
while staying in the denominator, which understates the reported risk. The guard
no longer names particular tickers: any instrument the risk pane shows as
carrying no approved tier, or as excluded from the numerator, fails unless the
page carries a machine-readable `WU`, `DELEG` or `AUTO` record for it, and an
excluded instrument must name an enumerated reason. BE / Bloom Energy is
recorded as delegated standard T1 (`DELEG-20260911-BE-T1`) with the approval
record `claude/xuan-ib-be-t1-approval-2026-09-11.md`.

`claude/xuan-ib-auto-classification-v1.json`, read only through
`scripts/xuan-ib-auto-classification.mjs`, covers the general case. It applies
only to a first-ever-seen position whose source identity is verified, which no
`WU`- or `DELEG`-namespaced rule already covers, and whose asset type is
unambiguously ordinary stock; ETF, fund, bond, cash, commodity and every other
known non-stock type are excluded explicitly, and an unknown or ambiguous type
is fail-visible, named and disclosed with its reason. Such a position takes the
most conservative approved tier, standard T1, as this period's effective
classification in its own `AUTO` namespace with its own policy revision id and
one stable `notifyId` per identity and revision, notified once and closed only
after a verified public read-back. It is a real classification, not a
placeholder: never describe it as 临时, 待确认 or 待裁决. It never creates an
`awaiting_user` item, never mints a `WU` or `DELEG` receipt, never adopts a
coefficient, never widens account scope and never touches any order, transfer or
financial write. `calculateDelegatedTier` is unchanged and still refuses an
instrument it has no approved rule for; the automatic policy is a separate
module and is never reachable through it. Changing either policy file, its
reader or its tests needs a separately reviewed maintenance PR under the
publication lock.

**Identity-keyed risk universe, and a calculated numerator.** Two further
defects of the same run were structural rather than textual, and both are closed
here. They take effect only once the owner posts the exact-head-SHA approval
comment on the pull request that introduces them and it merges.

The AI-pressure universe is keyed on `(portfolioId, holdingId)` and never on a
ticker. It spans three accounts — IB-HK, Schwab-HK and Webull — so one company
is legitimately held in more than one of them: `GOOG` at IB-HK and `GOOG` at
Webull are two positions with two market values and two contributions, and
`BRK.B` at IB-HK and `BRK/B` at Schwab-HK are one company spelled two ways by
two custodians. A symbol-keyed universe refused the first case and merged the
second. `instrumentId` is bound into every record and checked independently, so
one instrument cannot appear twice inside one account.

That universe is declared by the risk pane itself as `data-ai-risk-universe-v1`
with one `data-ai-risk-constituent` identity marker per constituent, and it is
reconciled against the manifest by the gate. It is **not** the holdings table's
`data-holdings-universe-v1`, which stays exactly as it is: one custodian's book,
its own count, its own check. Reconciling the risk manifest against the holdings
count checked the wrong arithmetic — it would have passed a report that dropped
every Schwab and Webull constituent and failed a correct one.

§0-C coefficients are read from `claude/xuan-ib-ai-risk-tiers-v1.json` through
`scripts/xuan-ib-ai-risk-registry.mjs`, its single supported reader, under the
`REG` namespace. That file is a mechanical transcription of already-published,
already-approved values — the three standard ladders from the owner-reviewed
§0-C table, and every per-instrument assignment, ETF look-through percentage and
named exception from the published report — with its record in
`claude/xuan-ib-ai-risk-tiers-approval-2026-09-11.md`. It changes no
coefficient and invents none. A new tier, ladder or exception remains a separate
owner decision, and changing that file, its reader or its tests needs a
separately reviewed maintenance PR under the publication lock.

The published number is then computed, not typed. `scripts/xuan-ib-ai-pressure.mjs`
is pure: it takes identities, source-bound market values and a source-bound
three-account cash-inclusive denominator from its caller, applies the ladder the
approved rule or the registry already records, and returns every contribution,
the scenario totals and the ratios. It fetches nothing. `renderReport` generates
the §0-C section from that result and refuses a candidate that also supplies its
own AI-pressure card: there is no longer any input on the assembly path that
accepts a ready-made numerator or ratio. The headline AI-pressure KPI is derived
from the same computation and a hand-authored one is refused — it sits outside
the risk pane, so an independently written tile could disagree with the table
beneath it indefinitely. The gate recomputes the numerator from
the page's own per-constituent contributions and fails a displayed total, ratio,
coefficient or contribution that does not follow from them, as well as a
classified constituent that contributes no row at all.

Where the approved material genuinely defines no low or high case — an ETF
look-through is a single composition percentage, not a scenario ladder — that
scenario total is published as unavailable and named. It is never filled in with
the mid case and never with zero.

**Wired coverage, not available coverage.** These readers are reached from the
actual assembly path, not merely importable. `scripts/xuan-ib-ai-tier-coverage.mjs`
resolves every risk constituent of a run — an exact `WU` or `DELEG` rule first,
then the automatic policy, then an enumerated exclusion — and
`prepareReport` calls it and publishes the result as the inert
`xuan-ib-ai-tier-records-v1` manifest beside the holdings table's own
`data-holding-symbol` / `data-holdings-universe-v1` markers. An ordinary AM or
PM report dated `2026-09-11` or later may not show holdings without it. The
guard's blocking check reconciles that manifest against the table's own declared
universe, so a constituent that is missing, invented or double-counted fails as
arithmetic; the older prose scan is kept only as a regression backstop and is no
longer what makes the rule work. Instrument identity resolves through the strong
identifier each payload publishes — the IB `contract_id`, the portfolio source's
`instrument.id` — and falls back to the venue+code key only when no such
identifier exists or the registry does not record it. Notification stays
"once" against the previous trusted page's own published records and a verified
public read-back, never against a list a caller supplied; it creates no
`awaiting_user` item and remains a Codex-owned technical mechanism.

## Owner retirement override (2026-09-06)

Read `claude/xuan-ib-four-bucket-retirement-20260906.md` first. The owner has
cancelled four-bucket configuration management after continued integration
obstacles. Stop its extra collection/sidecar generation and target-gap prompts;
preserve stock four-class cash planning, other source requirements and immutable
historical financial/decision records. Earlier four-bucket cadence and activation
requirements below are historical and do not override this retirement.

## Owner mobile and classification update (2026-09-06)

Read `claude/xuan-ib-mobile-followup-20260906.md` before preparing reports.
It supersedes the old rotation-trigger requirement: retain order reminders
only. It also records delegated evidence-supported classification and the
explicit AAOI T1 approval, without changing trading or publication authority.

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
The guard requires exact group titles/counts, exact visible status labels for
newly resolved or edited cards, and an otherwise unchanged recommendation body.
An existing card with unchanged status may retain legacy wording only when its
complete raw HTML is byte-identical to the trusted previous card. Group
placement and full-page immutable-content checks still apply. Do not change
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

## Scheduled-only reports and AM display (owner requested 2026-09-06)

The owner retired the manual `生成临时报告` feature. Do not fire, restart or
re-enable its Routine, use its Shortcut, or initiate another adhoc trial under
older approval. Keep AM and PM schedules and decision-response recording.
Existing historical adhoc reports remain readable; their integrity, receipts
and scheduling semantics must not be rewritten or purged.

Use the shared compact renderer for AM display as well as PM: concise numbered
summaries, risk/status labels, buy/sell grouping with nearest-price sorting,
folded details and the short guide. This is display support, NOT an extension
of the adhoc-only account-association or weekly-minimal collection pilot.
AM still needs its own existing complete source evidence and normal protected
publication. A historical Saturday layout preview keeps its original dates,
must be explicitly labeled as a preview, and is not a fresh run or a replacement
for the newer trusted latest pair.

The owner subsequently requested publishing that historical display for phone
acceptance. See `claude/xuan-ib-historical-layout-20260906.md`: the isolated
source-bound archive is now permitted through reviewed maintenance, with a
navigation link only. It is still not a new run or a replacement latest pair.

## Weekly Sharesight cadence (owner confirmed 2026-09-06)

Read `claude/xuan-ib-weekly-ss-snapshot-v1.md`. The approved target is five live
IB endpoints per report, with the nine covered Sharesight portfolios and their
four-bucket derivation refreshed together Monday HKT. Preserve native valuation
dates and the last good dated snapshot; weekly data never prove IB identity or
replace current IB positions. This supersedes every-report Sharesight cadence,
not registry scope, classification rules, account approval or publication gates.

Rollout is staged: `assemble-weekly` now supports the explicitly requested
adhoc minimal trial without nine live Sharesight calls. Missing weekly metadata
does not block healthy live IB. Only metadata is accepted; weekly financial
values/durable storage and scheduled AM/PM activation remain incomplete. Keep
dependent metrics unavailable, not zero. Historical/full-live reports retain
their old protocol. Do not infer that this release activates a Routine or widens
the adhoc-only association policy. No new financial trial is implied by tests.

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
fixed order `概览 / 风险 / 配置 / 待办 / ETF`; the existing todo radio and pane
remain `s4` / `p4`, ETF remains `s5` / `p5`, and the pane DOM order is
`p1 / p2 / p3 / p4 / p5`. Do not copy or edit `policy.html`, the
policy JSON, renderer, approval record, or tests in a candidate; the single-file
`xuan-ib/index.html` candidate contract remains unchanged. The first production
rollout is complete: every ordinary fresh report must include the canonical
section in `p5`. Use the trusted `scripts/xuan-ib-etf-pane.mjs` migration for a
legacy ordinary report; it is deterministic, idempotent, and must not be used
on a records-update. A records-update may only preserve the previous page's
policy state byte for byte and in place: inherit legacy `p3` or current `p5`
when present, or keep it absent on a legacy page. Never bootstrap or move the
section through a records-update. Any optional A/B/C block in a report candidate
follows the canonical policy section inside `p5`; it never replaces it.
The separately reviewed indicative-v2 loader enhancement may show the validated
owner-approved open comparison first and fold the original policy/history locally. This is
presentation of an already verified document, not a change to the candidate,
latest HTML, its blob, financial values or receipts. Follow
`claude/xuan-ib-etf-trend-v2.md`. A validated `xuan-etf-open-summary-v3` inert
template at the end of the ETF pane can supply the same approved open allowlist
through the ordinary candidate/promotion path. The loader reads it only from
the already paired and verified report. Only when the template is absent may
it load the approved legacy `etf-trend.json`; an invalid template is not a
reason to silently serve the older file. Never publish the original result,
source records or keys. Once present, preserve the summary and its fixed
baseline on later reports; receipt-only updates must preserve it byte for byte.

Keep policy-v2 distinct from the existing operational-v1 cash-plan contract.
The static page may describe approved targets, reserve logic, staged funding,
benchmark definitions, and unresolved inputs, but it must not silently relabel
operational-v1 values as policy-v2, invent current financial values, or imply
that a plan has been executed. All page actions are navigation or local display
controls only. Never add order, transfer, financial-write, or broker-action
controls.

## Hong Kong report dates and New York PM schedule

Read and follow `claude/xuan-ib-report-schedule-HKT-v1.md` before producing any
XUAN-IB report. Dates and phone labels use `Asia/Hong_Kong`; PM follows
`America/New_York` so daylight saving changes are resolved by the named timezone:

- PM / 睡前版: Monday-Friday at 09:30 New York, at the normal US equity opening
  (21:30 HKT in daylight time; 22:30 HKT in standard time).
- Retain a short PM report at that same New York time on full market holidays;
  label it closed-market, not post-opening. Early closes do not change the start.
- AM / 早间版: Tuesday-Saturday at 08:00 HKT.
- Ad hoc / 临时版: retired 2026-09-06; retain historical parsing only.

The measured 日涨跌 column is bound to the edition, and the builder and the
publication gate enforce it: AM publishes the completed session one day before
its Hong Kong data date, PM publishes an intraday reading of the session running
on that date, labelled with the minute it was taken, and the retired ad-hoc
edition publishes no measured column. A PM reading and the following AM close
reading of one instrument legitimately differ and are never reconciled. See
`claude/xuan-ib-runtime-contract-v1.md` for the per-row evidence each requires.

Every successful edition uses the same candidate, validation, promotion, Pages,
and fixed-mobile-link path above. An ad-hoc edition may become the newest phone
page, but it never proves that a required AM or PM edition ran. PM targets a
verified public-page readback within twenty minutes of the actual run start;
record scheduler delay separately. Planned delivery is 09:50 New York, with the
existing read-only watcher at 09:55; those slots are not evidence of an actual
runtime or a guaranteed service level. Never skip sources or weaken Validate,
Promote, Pages, or readback to meet the target. Use the shared pure module
`scripts/xuan-ib-report-schedule.mjs` for delivery-slot calculations. A timezone
configuration is not activated until the real Routine's saved next run is
verified; repository code alone does not reschedule Claude.
The opening-time/twenty-minute cutover date is `2026-09-06` HKT. Dates before
`2026-09-04` retain 20:55 HKT start / 21:25 due; September 4–5 retain 09:35
New York start / 09:45 due. Never reclassify historical evidence. Code release,
saved Routine schedule and actual timed publication are separate acceptance
gates. Do not widen the adhoc-only account-association pilot to PM implicitly.

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
historically dated seven-portfolio coverage audit disclosure, not a new holdings
feed or a synchronized current valuation. Its two 2026-08-31 read windows are
explicit; the earlier three-portfolio/cash-identity question is historical.
Do not copy classification reasoning from the previous report. Detailed
classification coverage, Semi Liquid and override/portfolio-rule counts belong
only in this canonical section; use a short dated fallback reference elsewhere.
The trusted handover guard enforces this contract for both Validate and Promote.

The interim disclosure preserves the approved 2026-08-24 four-bucket fallback.
Seven-portfolio holdings completeness, cash identity, pagination and value
reconciliation must be independently checked before a reviewed maintenance
update may replace it with complete-current-audit evidence. Historical
seven-portfolio coverage, a partial audit or a mapping-file read alone is not
that evidence. The unresolved
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
