# XUAN-IB runtime contract v1

This contract adds observability and bounded read parallelism. It does not
change any investment formula, account set, fallback, publication gate, or
financial permission.

2026-09-06 superseding cadence decision: after direct-read testing, the owner
approved direct Sharesight reads and deterministic classification for each
AM/PM report, rather than adding a weekly cache. Five IB endpoints remain
direct. Use `xuan-ib-four-bucket-v1.md` section 4 for the full-view producer's
source-bound sidecar and canonical display. This is a reviewed integration
change, not proof that a Routine has been activated or published successfully.
The old `assemble-weekly` metadata-only trial remains an explicit legacy mode;
its dependent amounts stay unavailable. Do not silently select it for the
new full report path. No temporary-report button is restored.

## 1. Required run stages

Record these stages with RFC 3339 start/end instants and a recomputed
`durationMs`:

1. `bootstrap` — read the repository contracts, registry, mapping, and previous
   verified report state.
2. `ib-read` — read account summary, balances, positions, orders, and trades.
3. `sharesight-read` — read every `requiredEachReport` portfolio from the
   registry in legacy mode. In explicit weekly mode, the legacy-named slot is
   only a metadata lookup: `degraded`, `cacheHit:false`, journal error code
   `SHARESIGHT_WEEKLY_MODE`, and no live Sharesight receipts. Never mark it `ok`
   merely because cached metadata parsed successfully.
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

Classification explanation is no longer free-form narrative. Full reports
with a source-bound computed four-bucket sidecar use the deterministic
snapshot-based disclosure and guard described in `xuan-ib-four-bucket-v1.md`.
For legacy reports without that new transport, render the exact trusted section with
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

Populate each holding row's daily change only through
`buildDailyChangeColumn` in `scripts/xuan-ib-daily-change.mjs`, then merge it
with `applyDailyChangeColumn`. A report must not leave every row `未取得`
while the inputs are present, must never substitute zero, unrealized P&L, a
period return or a hand-typed quote, and must never assemble the column row by
row outside that module: every publish or suppress decision belongs to it, so
a guard cannot be bypassed by the order in which rows are masked.

Two measurement sources feed it, both normalized in
`scripts/xuan-ib-source-adapter.mjs`:

- `normalizeDailyChangeWindow` — a single-session performance window from the
  portfolio source, which carries its own session date and reports the price
  move and any currency move separately. Request it with
  `start_date === end_date ===` the reported session date, taken from the
  session being reported and never from the Hong Kong clock: that source
  evaluates dates in `America/New_York` and refuses a future start with HTTP
  422, so an 08:00 HKT run on HKT date D must request D−1.
- `measurePositionSessionChange` — the session profit and loss inside the same
  positions payload, where `base = marketValueNative - dailyPnlNative` is the
  identical share count at the close that P&L is measured from, inside one
  currency and therefore free of any FX assumption.

Which source an edition uses is recorded here once measured, not assumed. AM
reports a completed session and uses the window. **The PM source is still
open**: it must not be written as settled until the read-only intraday probes
have measured whether the window source updates during a session, how late it
runs and whether every venue behaves alike. Do not record in this contract
that the window source has no intraday value before that evidence exists.

Every row must carry its own proof, and the following are enforced in code:

- **Session proof is per row.** Pass `venuesComplete` with the venues whose
  session for that date is provably finished. The upstream book rolls its
  session per instrument and per venue — measured 2026-09-10, US rows had
  rolled while a Toronto and a London row had not — so one report-wide flag
  cannot cover a portfolio spanning several exchanges. Never infer it from the
  edition or from a fixed clock offset: the PM trigger currently fires at a
  fixed UTC time, so from 2026-11-02 it starts an hour before the New York
  open and any edition-derived assumption would be wrong from that date.
- **Identity is venue-scoped and alias-normalized.** `BRK B`, `BRK/B` and
  `BRK.B` are one instrument; the same ticker on two exchanges is two. A row
  whose identity does not resolve, or that collides with another inside one
  venue, is unavailable rather than merged. `traded` and `corporateActions`
  are venue-scoped too, and an event whose identity cannot be resolved is
  counted, never silently dropped.
- **Exactly zero is never published.** It cannot be told apart from a price the
  source carried forward for a session it has not loaded, and that ambiguity is
  per row: a portfolio-wide check misses the case where only some venues are
  stale, and a traded row masked first would defeat it entirely. Losing a
  genuinely flat row is the safe direction.
- **Corporate actions suppress the row.** An unadjusted 2-for-1 split reads as
  about −50% and sits inside any plausible magnitude bound, so the magnitude
  guard is an outlier trap and never a corporate-action detector. Supply the
  session's splits, consolidations, symbol changes and similar events.
- **A row that traded in the window is unavailable**, because a share count
  that moved mixes trade effects into either measurement.

Degradation is per row, not per column: one malformed row is marked and
counted while the rest of the column publishes. The window-shape guards
(single-day, non-annualised) are different — they invalidate the whole
measurement, so the column becomes unavailable while the rest of the report
still publishes.

Label each measured row with its own session date, never with the moment the
run happened to read it: an AM column carries a completed session's move and
must not be described as an 08:00 reading. State which method produced the
column in the holdings note, and disclose the specific reason a row is missing
— a fill in the window, a corporate action, an unresolved identity, an
unproven session, or a value indistinguishable from a carried-forward price —
instead of the generic missing-quote line. Neither method is an
exchange-verified quote, so keep each source's own date and any delayed label.

A published row carrying a change must name its method and session date; the
publication gate enforces this as soon as the measured column is in use. The
same PM intraday reading and the following AM close reading of one instrument
legitimately differ, so both must be labelled with what they measure rather
than reconciled into one number.

Derive every GOOG/GOOGL figure in the summary, risk table and accepted-item
fact paragraph from the same current report inputs. Do not copy an old item
paragraph and label its old amounts as newly recomputed. Historical receipt
wording remains immutable; current facts and progress must distinguish it.

Explicit explanation-only corrections follow CLAUDE.md, not the live-read
stages: no financial refresh, no fabricated stage times, preserve original
edition/date/as-of/values/receipts, and no new AM/PM success evidence.

Legacy full-live runs still perform the live IB and required Sharesight reads.
A cache may never replace them or cache an error. The separately explicit
weekly mode is the approved cadence exception; a missing or invalid snapshot
removes dependent metrics rather than blocking five healthy IB reads. It never
turns a prior failed/full-live journal into a successful new run.

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

The separate seven-day owner-attested proposal is implemented **inactive** in
`claude/xuan-ib-account-association-v1.md`. It does not activate any report or
change AM/PM. When separately activated, its minimal policy receipt is gating
at trusted Validate/Promote; the older optional full manifest above remains a
different, non-gating history format. Do not confuse their assurance levels.

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

The separately OWNER-confirmed 2026-09-05 manual-consent alternative is limited
to one expressly requested ad-hoc compact run, with a fresh official IBKR UI
observation, exact account equality, a 20-minute window, journal and prior-SHA
binding and a private single-use controller store. Follow the complete compact
contract; do not apply it to AM/PM or turn its human observation into a native
API account_id. The existing optional manifest may validate historical manual
proof only with explicit matching edition/run/prior-SHA context. That is not
live issuance or publication permission. All financial sources, fallback rules,
receipt continuity and trusted publication gates remain unchanged.
