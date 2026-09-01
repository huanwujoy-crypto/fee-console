# XUAN-IB handover runtime rule

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

Use only read operations against Interactive Brokers and Sharesight. Never
place, modify, or cancel an order; never initiate a transfer; never create,
update, or delete financial records. Repository writes remain limited to the
trusted single-file candidate process in `CLAUDE.md`.

Every new financial report must read the live IB endpoints and the registry's required
Sharesight portfolios. A cache must never replace those live reads. Independent
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
unique `.pane.p3` configuration pane. Do not copy or edit the standalone page,
its JSON, approval record, renderer, or tests in a candidate: the candidate
contract remains one commit changing only `xuan-ib/index.html`. A first ordinary
report may add the canonical section. A records-update may only inherit an
existing section byte for byte. Never replace the loader, latest report,
metadata, or promotion evidence with the policy page. Any policy-page contract
or rendered output change belongs in a separately approved maintenance PR.

Do not conflate policy-v2 with the operational-v1 cash plan. Preserve their
labels and purposes, show missing inputs as unresolved rather than zero, and do
not infer execution from an approved plan. The page is read-only: it must not
place, modify, or cancel orders; initiate transfers; or write to financial
systems.
