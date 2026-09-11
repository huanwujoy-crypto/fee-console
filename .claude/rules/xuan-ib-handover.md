# XUAN-IB handover runtime rule

The explicit owner renewal of 2026-09-11 extends only the existing bounded
account association to fixed AM/PM. Read the current September 7 section in
`claude/xuan-ib-account-association-v1.md`; it supersedes older adhoc-only
association restrictions, not source completeness, publication gates, manual
consent or weekly-minimal trial limits. Use the actual edition on a fresh
pre-read receipt; the current October 10 expiry remains exclusive and may not
be automatically rolled forward.
Older explanation-only and cash-plan no-read permissions below do not override
the current association publication gate; see its ordinary-correction section.
Do not create fresh receipts for old data merely to publish a correction.

This rule applies only to scheduled, Run now, recovery, manual, and ad-hoc
XUAN-IB reports. It does not authorize a fee-console `data.json` write.

Before reading financial data or generating a report, read and obey:

- `CLAUDE.md`
- `claude/xuan-ib-report-schedule-HKT-v1.md`
- `claude/nightly-handover-spec-ADDENDUM-v916.md`
- `claude/xuan-ib-runtime-contract-v1.md`
- `claude/xuan-ib-portfolio-registry.json`
- `claude/four-bucket-mapping.json`
- `claude/xuan-ib-cash-first-plan-v1.md`
- `claude/xuan-ib-mrvl-t1-approval-2026-08-31.md`
- `claude/xuan-ib-ai-tier-overrides-v1.json`
- `claude/xuan-ib-venue-identity-v1.json`
- `claude/xuan-ib-auto-classification-v1.json`
- `claude/xuan-ib-be-t1-approval-2026-09-11.md`
- `claude/xuan-ib-ai-risk-tiers-v1.json`

Use only read operations against Interactive Brokers and Sharesight. Never
place, modify, or cancel an order; never initiate a transfer; never create,
update, or delete financial records. Repository writes remain limited to the
trusted single-file candidate process in `CLAUDE.md`.

Read `claude/xuan-ib-weekly-ss-snapshot-v1.md` for the owner-confirmed weekly
Sharesight/four-bucket cadence. Five IB endpoints remain live per report.
The explicit adhoc `assemble-weekly` trial no longer requires nine same-run
Sharesight reads; it allows only dated metadata and unavailable dependent metrics
until durable values are activated. It does not widen account association to
AM/PM or activate a Routine. Historical/full-live mode still requires all live
IB endpoints and required Sharesight portfolios; a cache cannot replace those
legacy reads. Independent
reads may run in bounded parallel batches, and every result must be recorded
individually even when a sibling read fails.

Exception: an explicitly requested explanation-only correction follows the
strict no-new-data contract in CLAUDE.md. It retains the prior edition, date,
as-of, amounts, calculations and receipts, states that no new data was read,
and does not prove an AM/PM run. Do not fetch data or fabricate a run manifest
merely to correct the classification explanation.

The separately approved source-blob-bound cash-plan repair in
`claude/xuan-ib-cash-first-plan-v1.md` may recalculate only planning values from
the trusted prior snapshot, without fresh reads. It must preserve raw financial
inputs, dates/as-of and receipts, explicitly disclose the recalculation, and
must not count as a fresh AM/PM run. Do not expand this into a general cache
substitute for normal reports or overwrite a later report with the old repair.

## Identity and presence integrity (2026-09-11)

Resolve cross-source instrument identity only through
`scripts/xuan-ib-venue-identity.mjs` and its reviewed registry
`claude/xuan-ib-venue-identity-v1.json`, and pass that resolver to the
daily-change builder and merge. Each entry is scoped to one instrument and bound
to the identifier each raw payload already carries. Never declare two venues
synonyms, and never take a venue from another custodian's portfolio because it
lists the same ticker — that is not evidence about this account's instrument. A
cross-venue pairing no reviewed entry records is named and refused; adding one is
a separately reviewed maintenance change, never part of a report run.

A daily-change reading of exactly zero publishes only when an independent
same-run reading of the same completed session corroborates it, and the row names
the corroborating method. When two readings disagree, withhold the row and
disclose it by name as contradicted; do not average, prefer or arbitrate. Give
every unmeasured row its enumerated reason and declare the holdings coverage.

AM may use the per-row fallback `am-session-pnl-v1` only for a row the
single-day window never returned, and only with all of its evidence: session
D−1, the venue's session provably finished, `observedAtHkt` on report date D,
`mark × quantity` reconciled against the payload's own market value, and no
trade or corporate action on that position in the same window. It never
overrides a window reading. PM is unchanged: no fallback, its own method, its
own instant rule. Do not relax PM to match AM.

A first-seen position that no `WU` or `DELEG` rule covers must not simply drop
out of the AI-pressure numerator while remaining in the denominator. Use
`classifyFirstSeenPosition` in `scripts/xuan-ib-auto-classification.mjs` with
`claude/xuan-ib-auto-classification-v1.json`: verified identity, no existing
owner rule, unambiguously ordinary stock, standard T1 under the `AUTO`
namespace as this period's effective classification. Non-stock and unknown or
ambiguous asset types are fail-visible — named, disclosed with an enumerated
reason and excluded. This creates no `awaiting_user` item, mints no `WU` or
`DELEG` receipt, changes no coefficient or account scope, and reaches no
financial write. Never word an AUTO classification 临时, 待确认 or 待裁决.
BE / Bloom Energy is a `DELEG` rule (`DELEG-20260911-BE-T1`), not an AUTO record.

Resolve the whole constituent universe through
`buildAiTierCoverage` in `scripts/xuan-ib-ai-tier-coverage.mjs` and pass the
result to `prepareReport` as `riskConstituents` (CLI: `--risk-constituents`),
together with the source-bound three-account cash-inclusive denominator as
`riskDenominator` (CLI: `--risk-denominator`). Every constituent carries its
`custodian` alongside `portfolioId`, `holdingId` and `instrumentId`: the risk
universe is keyed on `(portfolioId, holdingId)`, never on a ticker, because one
company is legitimately held under more than one custodian and two custodians
legitimately spell one company differently.

An ordinary AM or PM report dated `2026-09-11` or later that shows holdings
must carry the resulting `xuan-ib-ai-tier-records-v1` manifest and the risk
pane's own `data-ai-risk-universe-v1` declaration; the gate reconciles the two
by identity rather than against prose, so every constituent is classified with a
`WU`, `DELEG`, `REG` or `AUTO` record id or excluded with an enumerated reason.
That declaration is the risk pane's own and is never the holdings table's
`data-holdings-universe-v1`, which covers one custodian's book and keeps its own
separate check.

Take §0-C coefficients only from `claude/xuan-ib-ai-risk-tiers-v1.json` through
`scripts/xuan-ib-ai-risk-registry.mjs`, and compute the numerator, the scenario
totals and the ratio only with `computeAiPressure` in
`scripts/xuan-ib-ai-pressure.mjs`. Never retype a coefficient, a contribution, a
numerator or a ratio into a report, an assembly script, a card or a KPI tile:
the renderer derives the whole section and the headline KPI, refuses a
hand-supplied AI-pressure card or KPI, and the gate recomputes the total from
the page's own per-constituent contributions and reconciles the tile against it.
Where the approved material defines no low or high case, publish that scenario
as unavailable and named — never the mid case repeated, never zero. Resolve cross-source
identity by the strong identifier each payload publishes (`contract_id`,
`instrument.id`) and use the venue+code key only when none exists. Decide
"notify once" with `decideAutoNotification` against the previous trusted page's
published records and a verified public read-back; never close a notification
without one, and never turn it into an owner item.

Classification prose must come from the trusted deterministic disclosure
module, not the previous latest.html. Run the canonical renderer and preserve
its exact section; keep coverage reasoning only there. A mapping-file read or
override count is not a holdings-completeness audit.

The user-approved MRVL standard T1 rule and its single exact-source-blob
risk recalculation exception are defined in the MRVL approval document above.
That exception recalculates risk only from the identified prior snapshot,
preserves data times and original receipts, discloses approximate low/high
results and never counts as a fresh AM/PM run. It does not relax publication
gates or allow a stale report to replace a newer report.

Before the candidate is prepared, validate a run manifest with
`scripts/xuan-ib-run-manifest.mjs`. Do not place raw connector errors, holdings,
amounts, credentials, URLs, tokens, cookies, or authorization material in that
manifest. Use only the allowlisted status and error-code fields in the runtime
contract.

Source failures remain field-level degradations when an approved dated fallback
exists. A single positions failure must follow the approved Sharesight IB-HK
fallback instead of stopping the whole report. Multiple critical source
failures, an unconfirmed account scope, or a failed publication gate remain
fail closed. Never fill a missing value with zero or a guess.

## Static policy-page isolation

The approved index-ETF policy is rendered separately at
`xuan-ib/policy.html` from `claude/xuan-ib-policy-v2.json` by
`scripts/xuan-ib-policy-page.mjs`. Read its approval record in
`claude/xuan-ib-policy-v2-approval-2026-09-01.md` before quoting policy-v2.

The policy page is static planning material, not a live financial read, report
candidate, scheduled-run result, or publication-success signal. The only
permitted handover integration is the byte-identical output of
`renderPolicySection(policy)`, placed as the first visible module inside the
unique independent `.pane.p5` ETF pane. Keep the visible navigation order
`概览 / 风险 / 配置 / 待办 / ETF`, while preserving todo as `s4` / `p4`,
ETF as `s5` / `p5`, and pane DOM order as `p1 / p2 / p3 / p4 / p5`.
Do not copy or edit the standalone page,
its JSON, approval record, renderer, or tests in a candidate: the candidate
contract remains one commit changing only `xuan-ib/index.html`. The first
production rollout is complete, so every ordinary fresh report must include the
canonical section in `p5`. Use trusted `scripts/xuan-ib-etf-pane.mjs` only to
migrate a legacy ordinary report; the helper is deterministic and refuses
records-updates. A records-update may only preserve the previous page's policy
state byte for byte and in its inherited `p3` or `p5`: inherit it when present,
or keep it absent on a legacy page. Never bootstrap or move the section through
a records-update. An A/B/C runtime card, when present, follows the canonical
section in `p5`. Never replace
the loader, latest report,
metadata, or promotion evidence with the policy page. Any policy-page contract
or rendered output change belongs in a separately approved maintenance PR.

Do not conflate policy-v2 with the operational-v1 cash plan. Preserve their
labels and purposes, show missing inputs as unresolved rather than zero, and do
not infer execution from an approved plan. The page is read-only: it must not
place, modify, or cancel orders; initiate transfers; or write to financial
systems.
