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

Use only read operations against Interactive Brokers and Sharesight. Never
place, modify, or cancel an order; never initiate a transfer; never create,
update, or delete financial records. Repository writes remain limited to the
trusted single-file candidate process in `CLAUDE.md`.

Every run must read the live IB endpoints and the registry's required
Sharesight portfolios. A cache must never replace those live reads. Independent
reads may run in bounded parallel batches, and every result must be recorded
individually even when a sibling read fails.

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
