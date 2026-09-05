# XUAN-IB runtime contract v1

This contract adds observability and bounded read parallelism. It does not
change any investment formula, account set, fallback, publication gate, or
financial permission.

## 1. Required run stages

Record these stages with RFC 3339 start/end instants and a recomputed
`durationMs`:

1. `bootstrap` — read the repository contracts, registry, mapping, and previous
   verified report state.
2. `ib-read` — read account summary, balances, positions, orders, and trades.
3. `sharesight-read` — read every `requiredEachReport` portfolio from the
   registry.
4. `validate` — confirm account scope, source dates, identities, reconciliation,
   and approved fallback eligibility.
5. `derive` — calculate metrics from validated inputs.
6. `narrative` — prepare the three-line summary, true anomalies, and genuine
   decision items only.
7. `render` — build the self-contained candidate HTML.
8. `guard` — run the trusted handover guard.
9. `candidate-prep` — perform final candidate checks before commit/push.

Stages may overlap when work is genuinely parallel. A failed sibling read must
not cancel or erase the other results. The candidate manifest ends at
`candidate-prep`; GitHub Validate, Promote, and Pages timings remain authoritative
in GitHub Actions.

## 2. Bounded parallel read plan

- IB wave 1: account summary and balances in parallel.
- IB wave 2: positions, orders, and trades in parallel after the account scope
  is confirmed. Retry only the failed endpoint, with the existing bounded
  retry/backoff rule.
- Sharesight: use the fixed portfolio IDs in the registry. Read the seven
  family portfolios in batches of at most three (`3 + 3 + 1`), and the two
  AI-only auxiliary portfolios in a separate batch of two. Do not rediscover
  or silently widen scope.
- Treat each batch as all-settled: record every endpoint separately even when
  one endpoint fails.

These are read operations only. No parallel or sequential path may call a
financial mutation tool.

The earlier duration audit's shorthand “7 Sharesight portfolios” counted only
the family aggregation set. A complete current report actually reads **7 family
portfolios plus 2 AI-only auxiliary portfolios, for 9 required Sharesight
reads**; the excluded
NOAH-EB-5 entry is pinned only to prevent scope drift and is not read or summed.

## 3. Cache and hash boundary

Cash-first planning follows `claude/xuan-ib-cash-first-plan-v1.md` and its
deterministic renderer. Use actual report inputs, not a copied historical
repair snapshot. The single user-requested source-blob-bound formula/display
repair specified there does not fetch data, fabricate stage times or prove a
new AM/PM run. It preserves original source values and data times while
explicitly recalculating only the cash-planning scenario.

Classification explanation is no longer free-form narrative. For ordinary
four-bucket reports, render the exact trusted section with
`node scripts/xuan-ib-classification-disclosure.mjs`. This is an explicitly
dated, limited-scope historical audit statement; it is not a cached claim that
current holdings were read. The handover guard requires it and rejects coverage
reasoning outside it. Current full-family classification requires independently
verified seven-portfolio scope, cash identities, complete paginated holdings
and value reconciliation, then a reviewed update of the interim disclosure.
Do not infer gaps from the size of holdingOverrides or from a mapping-file hash.

Before normalizing classification inputs, read
`claude/xuan-ib-classification-authority-review-2026-08-31.md` and
`claude/xuan-ib-cash-identities-v1.json`. Ordinary asset classification (§0-A)
is separate from AI pressure tiers (§0-C). The user explicitly approved MRVL
standard T1 on 2026-08-31. Read `claude/xuan-ib-mrvl-t1-approval-2026-08-31.md`
and `claude/xuan-ib-ai-tier-overrides-v1.json`; verify identity and current USD
market value, then calculate its low/mid/high contribution as 60%/80%/100%.
Do not carry the historical temporary exclusion forward or request duplicate
approval. The original decision and receipt remain immutable history.
The approval document permits a single exact-source-blob risk recalculation
without fresh reads, clearly dated to the original snapshot; it is not fresh
AM/PM evidence and gives no stale-date or publication exception. Ordinary
reports still use live reads and the current report's own source amounts.

For the single registered UBS cash proxy, call `resolveCashIdentity` from
`scripts/xuan-ib-cash-identity.mjs` before the classification audit. Supply
explicit source IDs, normalized full name, record type, USD currency, unit
price and received/not-pending status; never fabricate fields to pass it.
Only `resolved` supplies `isCash: true`. An `unresolved` result is a review
blocker for that row, not permission to classify it as a non-cash security.
Preserve the source holding/security type: the registry proves economic cash
identity, not a native cash account, a current balance or transfer availability.
Native cash accounts require their own source evidence and are not proxy rows.

Preserve absent labels as `sourceLabels: []` and explicit `assetClass:
"Unlabelled"`; do not manufacture a liquidity label. Existing verified
portfolio-wide rules may cover such a row. If no approved rule covers it,
retain unknown. Coverage evidence assembled at different read times proves
rule coverage only, not a new same-run family valuation. Before replacing the
dated fallback, a normal run must independently read all seven family
portfolios, reconcile holdings plus cash and pass reviewed publication checks.

Derive every GOOG/GOOGL figure in the summary, risk table and accepted-item
fact paragraph from the same current report inputs. Do not copy an old item
paragraph and label its old amounts as newly recomputed. Historical receipt
wording remains immutable; current facts and progress must distinguish it.

Explicit explanation-only corrections follow CLAUDE.md, not the live-read
stages: no financial refresh, no fabricated stage times, preserve original
edition/date/as-of/values/receipts, and no new AM/PM success evidence.

Every run still performs the live IB and required Sharesight reads. A cache may
never replace them and may never cache an error.

Hash reuse is allowed only for:

- parsing unchanged versioned repository methods/mappings; and
- a derived result whose complete normalized live inputs, source `asOf` values,
  account/portfolio identities, and method bundle all produce the same SHA-256
  fingerprint as the prior verified result.

A changed source value, source date, portfolio/account identity, method hash,
fallback state, or missing input invalidates the cache. Cached output always
retains the prior verified provenance. Do not describe a cache hit as a new
financial read.

## 4. Run manifest

Validate the manifest with `scripts/xuan-ib-run-manifest.mjs`. It contains only
run timing, source health, provenance hashes, and bounded error codes. It must
not contain amounts, positions, securities, raw connector responses, free-form
errors, credentials, URLs, email addresses, tokens, cookies, or authorization
headers.

The optional Phase-0 transport is a single HTML comment:

`<!-- xuan-ib-run-manifest:v1:BASE64URL_CANONICAL_JSON -->`

Phase 0 does not change `handover-guard.mjs`; therefore the manifest remains
non-gating until the Routine has produced several successful shadow samples.
The helper itself must still validate the manifest before encoding it.

## 5. Degradation and fail-closed boundary

- Every expected endpoint/portfolio must have an explicit `ok`, `fallback`,
  `unavailable`, or `failed` state; absence is not success.
- If positions alone fails, the approved fresh Sharesight IB-HK fallback may be
  used and disclosed. If it is stale or unavailable, position-dependent fields
  are unavailable or retain an explicitly dated trusted value; never use zero.
- One other source failure is a visible field-level degradation when the
  account scope is still confirmed. Multiple critical IB failures or an
  unconfirmed account scope block publication.
- Existing candidate, guard, Validate, Promote, Pages, and online read-back
  failures remain globally fail closed.

## 6. Phase-0 acceptance

For at least two successful reports, retain the manifest in the Claude project
archive and compare its measured critical path with GitHub workflow timestamps.
Only after those samples should the manifest become a mandatory guard input or
the deterministic renderer replace the legacy authoring path.

## 7. Opt-in compact authoring pilot

The maintenance helpers in `claude/xuan-ib-compact-report-v1.md` make an
explicitly requested PM/ad-hoc pilot available. They do not activate a Routine,
replace the default authoring path, change AM, or satisfy the acceptance above.
The pilot supplies strict public view input, deterministic presentation and an
immediately appended timing journal; it still uses existing read-only tools,
normalization, financial calculations and publication checks. Its initial
source-availability rules are deliberately stricter than the general fallback
policy: do not silently relax them to fit a deadline. Read the pilot contract
before using its prepare command. Do not fabricate missing source evidence,
stage timing, an owner approval or a successful public read-back.
