# Current XUAN-IB AM/PM runbook — 2026-09-08

This is the entrypoint for the existing fixed, **full-live** AM/PM route. It
resolves historical wording; it does not grant new permissions or loosen the
linked contracts. Maintenance merge, actual Routine configuration/read-back,
and a real timed publication are three separate acceptance gates.

## 1. One edition, one accountable owner

- AM: Tuesday–Saturday 08:00 `Asia/Hong_Kong`. PM: Monday–Friday 09:30
  `America/New_York`, including a clearly labelled short closed-market report
  on full holidays. Report dates are HKT; preserve each source valuation date.
- Before starting another attempt, check the original Routine/run and trusted
  publication. Do not duplicate an already-running same-date, same-edition job.
  A completed slot requires the correct ordinary AM/PM source, run-bound receipt
  and source times, successful Validate/Promote/Pages, and exact public HTML/meta
  pairing with trusted `main`. A date label, outer “Completed”, local file,
  `prepared-not-published`, historical preview or **records-update** is not that
  proof. If public proof is unavailable, report “unverified”, not success.
- Keep one journal writer and preserve failed attempts. A new attempt cannot
  claim old reads under a fresh receipt. No global lease/idempotency service is
  activated by this document or by the source-plan helper. Repeated checking
  must not start extra runs or send repeated completion notices.

Timing and DST limitations: [report schedule](xuan-ib-report-schedule-HKT-v1.md).
Target: actual entry to exact public read-back **≤20 minutes**; record schedule
delay and planned-start-to-public elapsed separately. Retries do not reset the
overall measurement. A late valid report can publish; no missing time is zero.
The pure `summarizeRunObservation` helper in
[`scripts/xuan-ib-run-observation.mjs`](../scripts/xuan-ib-run-observation.mjs)
can summarize separately recorded timestamps and public-readback evidence IDs.
Its `observation-only` output is not a receipt or independent byte verification;
missing starts or evidence must remain `not-recorded`. It never edits journals.

## 2. Bootstrap and account scope before any financial read

Initialize a fresh private journal at real entry; read the current trusted-main
contracts, registry/rules and paired previous `latest.html/latest.meta.json`.
Perform the existing effective Git identity preflight. Keep raw evidence and
journals in private locations outside Git; never publish credentials or account IDs.

Follow the **September 11 renewed scheduled scope** in
[account association](xuan-ib-account-association-v1.md): fresh main policy fetch,
actual-edition pre-read check, new same-run receipt before either source stage.
The current owner-attested period runs from **2026-09-12 21:30 HKT** through
**2026-10-10 21:30 HKT, exclusive**. Stop on expiry, revocation, changed/conflicting
account or connector scope. Do not automatically renew it, invent native account IDs, reuse
manual-consent proof, change permissions or bypass a safety refusal. Refresh an
aged policy *read* as specified; that never extends its validity.

## 3. Plan 5 IB + 9 Sharesight reads; then execute real tools

With the reviewed helper available in trusted main, print the deterministic
intent for the actual edition (replace `am` with `pm` only for that PM run):

```sh
node scripts/xuan-ib-source-plan.mjs --protocol full-live --edition am
```

The result is **`planned-not-authorized` / `runtimeEvidence: not-checked`**.
It validates intended keys/inputs, not permission, API execution, response
completeness, source timing or successful capture; it installs no hook and
does not create a journal, receipt or candidate.

- Follow its exact tool names/inputs and registry IDs: IB summary/balances
  (`2`), then confirmed-scope positions/orders/trades (`3`); Sharesight family
  batches `3+3+1`, then the two AI-only auxiliary portfolios. Use all-settled
  handling, recording each outcome without erasing a successful sibling.
- Sharesight is **`sharesight_get_performance` with `portfolio` as the numeric
  ID string**, not a name lookup, `portfolio_id`, or a substituted holdings list.
  Preserve and validate the complete native response, matching portfolio/report
  identity. A valid plan or parseable JSON is not complete valuation evidence.
- Use existing native tool results and the supported capture/source adapter;
  preserve exact same-run provenance and actual start/finish records. Do not
  retype financial JSON, substitute an old tool result or activate the disabled
  hook bridge. Missing output/unsupported wrappers require diagnosis, not a
  fabricated successful capture. Only supported bounded failed-endpoint retries
  are allowed; failed journals/artifacts remain immutable.

Stage/batching rules: [runtime contract](xuan-ib-runtime-contract-v1.md).
Capture/prepare interfaces and their stricter readiness limits:
[compact report contract](xuan-ib-compact-report-v1.md). Its historical
`minimal-prepare`, `assemble-weekly` and adhoc-only trial paths are **not the
fixed AM/PM route**. This runbook does not authorize a fallback the selected
adapter/preparer cannot actually validate.

## 4. Derive, render, preserve history

Use supported validated source normalization and existing calculation modules
to build the full view/source evidence; the presentation renderer is not a
financial calculation or provenance oracle. Keep source dates, currencies and
same-scope denominators. Missing daily changes are unavailable, not zero.
Use only the documented eligible positions fallback, with its dated disclosure;
never weaken preparation/guard checks to meet the time target.

Keep EXUS/EIMI/USSC specific cash-plan amounts visible, but never equate pooled
planning cash with immediate broker buying power. Retain the original ETF
policy and approved A/B/C summary with its true baseline/cutoff; do not rebuild
ABC history on the report critical path. AI risk tiers, ETF comparison and the
fee console's growth/value classification are **separate systems**, not
interchangeable mappings or calculations. Routine supported classification
follows existing delegated rules: verify, calculate, publish/read back, notify
once per rule revision; leave only genuine owner actions in To do.

Read the relevant [cash plan](xuan-ib-cash-first-plan-v1.md),
[routine closure](xuan-ib-routine-closeout-20260906.md),
[classification delegation](xuan-ib-classification-delegation-v1.json) and
[ETF summary rules](xuan-ib-etf-trend-v2.md); preserve all original decision IDs
and immutable receipt history. Use the compact contract's full-view preflight
and `xuan-ib-report-prepare.mjs` path; prose-only correction stays within its
bounded preflight retry, not a new financial run or edited generated HTML.

## 5. Publish and prove delivery

Follow [the publication contract](../CLAUDE.md): one `claude/...-xxxxxx` branch,
one non-merge `handover YYYY-MM-DD` commit changing only `xuan-ib/index.html`,
current-pair/identity checks and unchanged guard. Never directly edit latest
HTML/meta, source tags, rules, receipts or protected publication code in a run.
Wait for Validate → Promote → Pages, then compare public bytes/sourceSha/htmlBlob
against the candidate and trusted-main pair. Log real deployment/read-back
times. Report generation, release, public verification and phone layout
acceptance remain distinct; “已同步” alone is not fresh-source evidence.

## 6. Remain off; verify real rollout separately

Four-bucket configuration/extra reads are [retired](xuan-ib-four-bucket-retirement-20260906.md).
Manual report generation and its Routine/Shortcut remain off; Flex setup remains
paused. Keep stock four-class cash planning, ordinary source requirements, order
reminders and original records. No trading, order modification/cancellation,
transfers, broker/Sharesight writes, permission expansion or new scheduler.

After controlled maintenance release, update **only the original AM/PM Routine
instructions** and read them back, preserving schedule/status/model and other
settings unless separately authorized. This file's presence or merge does not
prove those changes, a saved Next run, connector readiness, hook activation or
20-minute delivery. Record one actual AM and PM publication observation
separately before claiming the optimized fixed workflow is operational.
