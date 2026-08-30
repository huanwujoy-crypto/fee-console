# XUAN-IB pipeline consensus — Codex + Claude — 2026-08-30

## Decision

Codex and Claude agree to improve the report path in measured, reversible
phases. Accuracy, source freshness, read-only financial access, field-level
degradation, and the existing Candidate → Validate → Promote → Pages chain stay
ahead of speed.

## Phase 0 — implement now

1. Pin the approved source scope in
   `claude/xuan-ib-portfolio-registry.json`: seven family portfolios, two
   AI-pressure auxiliary portfolios, and the explicitly excluded portfolio.
2. Record a validated run manifest with per-stage start/end/duration, cache
   state, source `asOf`, bounded retry count, and allowlisted error codes.
3. Keep the manifest free of amounts, holdings, raw connector responses,
   credentials, URLs, email addresses, tokens, cookies, and authorization
   headers.
4. Run IB read-only calls in two all-settled waves (`2 + 3`) and Sharesight in
   bounded all-settled batches (`3 + 3 + 1`, then the two auxiliary portfolios).
   One failed call must not cancel or erase the other read results.
5. Continue live reads on every run. Hash reuse may accelerate only unchanged
   versioned methods or a derived result whose complete normalized inputs,
   identities, `asOf` values, fallback state, and method bundle are identical.
   Errors are never cached.

Phase 0 is shadow observability: the manifest is validated and archived, but it
does not yet become a mandatory publication-gate input. This prevents a new
telemetry format from blocking a recovery report.

## Phase 1 — measured parallelism

Apply the bounded parallel read plan in the Claude Routine and collect at least
two successful AM/PM/ad-hoc samples. Compare the critical path with GitHub
workflow timestamps. The previously suggested 5–8 minute range remains a
hypothesis, not an SLA, until these measurements exist. If connector rate limits
increase degradation, reduce concurrency rather than dropping a source.

## Phase 2 — deterministic renderer

Do not infer formulas from one historical HTML page. First import the missing
authoritative method material (v9.14/v9.15, section 0-A/0-C parameters, ETF
look-through weights, four-bucket/USSC rules, thresholds, and migration-cost
rules) into versioned structured specifications. Then:

- Claude produces only structured source facts, three-line narrative, true
  anomalies, and genuine decision items;
- a pure, tested renderer produces all amounts, tables, numbering, folds, and
  fixed wording; and
- run 3–5 shadow comparisons before making the renderer the sole writer.

## Decision interaction

First implement the receipt contract and a dedicated read-only Claude Routine.
The iPhone Shortcut may open the authenticated Claude App, but it must not put a
token, decision id, report hash, or user opinion in a URL or clipboard. A loader
button is added only after the Routine produces a machine-verifiable receipt
bound to the exact source commit and HTML blob. Recording a decision never
executes it and never authorizes a financial write.

## GitHub Actions conclusion

Keep the exact-head-SHA publication policy lock fail closed. Historical failures
remain audit evidence. Do not make draft checks artificially green: the same SHA
could otherwise have a short mergeable window while the ready-state check is
being registered. Reduce expected failure mail operationally by creating the
draft, immediately posting the exact-SHA owner comment, and only then marking it
ready.

## Non-negotiable boundaries

- no order placement, modification, or cancellation;
- no transfer or financial-record write;
- no zero-fill or undisclosed guess for a missing source;
- no cache in place of the five IB and required Sharesight live reads;
- no claim of phone delivery until the public fixed page and metadata read back
  the promoted artifact; and
- no tightening of a guard in the same change that first emits a new format.
