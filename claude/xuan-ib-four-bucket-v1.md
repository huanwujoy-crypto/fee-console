# Four-bucket gross aggregation — technical contract v1 (2026-09-06)

Status: **pure modules and synthetic tests only.** Nothing here reads a
financial system, publishes a value, activates a Routine, or changes the
trusted classification disclosure. Release of fresh calculated buckets still
requires the separately reviewed integration listed in §4, exact-SHA owner
approval, and a read-only Gateway shape verification (§5).

## 1. Modules

`scripts/xuan-ib-four-bucket.mjs` (tests: `scripts/xuan-ib-four-bucket.test.mjs`)

| Function | Purpose |
|---|---|
| `normalizeSharesightReport(raw, {registry, portfolioId, readStartedAt, readCompletedAt, listing})` | One captured read-only performance response → exact micro-unit rows. Fails closed on non-USD report currency, portfolio identity mismatch or non-family scope, duplicate holding or cash-account rows, unrecognized source liquidity labels, any pagination signal, a listing cross-check mismatch, an unreconciled report value, or a cutoff later than the read. |
| `aggregateFourBucket({reports, registry, mapping, cashIdentities, pendingRedemption, now})` | Seven family reports → gross buckets. Cash identity only through the reviewed registry; classification only through the trusted audit; any unresolved row stops the whole snapshot. |
| `validateFourBucketSnapshot`, `assertFourBucketAdvances` | Structural, arithmetic and fingerprint validation; a newer snapshot must be read later and never moves the report cutoff backwards. |
| `resolveFourBucket({compute, previous, now})` | Ordinary per-report resolution: `fresh`, or `fallback` to the validated previous snapshot with explicit `ageDays` and its original dates, or `unavailable`. Never zero, never re-dated. |
| `renderFourBucketTemplate`, `parseFourBucketTemplate` | Inert `<template id="xuan-ib-four-bucket-v1">` transport with strict canonical JSON parsing. |
| `deriveFourBucket({reads, previous, pendingRedemption, now})` | Convenience for the per-report path using the trusted repository inputs. |

## 2. Dates are three different things

- `reportCutoff` is the Sharesight report `end_date` per portfolio, plus the
  earliest and latest across the family scope.
- `readWindow` is the actual read start and completion time.
- Underlying NAV dates are **not** supplied by a performance report. The
  snapshot counts rows with and without a `navDate` and never dates a private
  fund by the report cutoff.

## 3. Rules that never relax

- Amounts are exact micro-units (1e-6 USD) from the JSON number's fixed text;
  sums are integer-exact; percentages are computed from unrounded totals.
- Native cash accounts are cash. A holding is cash only when the reviewed
  cash-identity registry resolves it exactly (id, name, USD, unit price 1,
  not pending redemption). A `Cash` label on an unregistered holding is not
  cash and, without an approved rule, fails the snapshot.
- **Cash-proxy normalization contract** (`CASH_PROXY_NORMALIZATION`, recorded
  in every snapshot): a performance response carries no `isCash` or
  `pendingRedemption` booleans and none are read from it. `isCash` comes only
  from the registry, never from a security type or label, so a registered
  proxy represented as ordinary shares still resolves. The resolver's explicit
  `pendingRedemption=false` is derived solely from the explicit evidence input
  (no item names the proxy); an item naming a proxy is a conflict. Ordinary
  rows get `pendingRedemption` only when evidence names them, otherwise the
  field is absent, not false. Gross bucket availability is independent of the
  evergreen-net evidence.
- Approved source liquidity labels are exactly `Highly Liquid`, `Semi Liquid`,
  `Illiquid`, `Cash`, read from the holding's Sharesight labels. Two approved
  labels on one row is ambiguous and fails. A row with no approved label keeps
  its raw labels and an explicit marker (`missing` or `unrecognized`); it is
  never given an invented label. Precedence is the trusted audit's: cash
  identity, then an approved holding override, then an approved portfolio-wide
  rule, then the default label rule. So a marked row inside a portfolio with a
  rule such as `all` or `all_non_cash` classifies by that rule, a source label
  never overrides an approved rule, and a marked row with no rule, or an
  unmapped `Semi Liquid` row, stays unresolved and fails the snapshot. The
  snapshot reports `coverage.labels` counts.
- **Completeness contract.** The open-positions performance report
  (`include_sales=false`, not consolidated, not combined) is the authoritative
  current-position snapshot. Per portfolio the normalizer requires: no
  pagination signal in the captured response; the self-link report parameters
  as above; every valued performance row present in an independent
  `sharesight_get_holdings` listing; holdings plus cash reconciled to the
  report value within one cent per row plus one cent; and, when present, the
  report's own group sub-totals reconciled to the same value. Listing-only
  identities are recorded as **unvalued membership diagnostics**
  (`listingOnlyHoldingIds`, `coverage.listingOnlyIdentities`). They are never
  inferred closed, never valued, never classified, and no per-row trade or
  sales read is added to routine generation. Sharesight's listing is every
  historical holding and carries no open/closed state; `valid_position` is not
  an open-position indicator.
- **Residual limitation, stated plainly.** A listing-only identity may be a
  sold-out holding or a holding the report excluded (for example limited
  pricing data under `include_limited=false`). Sharesight's own report value
  excludes it too, so reconciliation cannot distinguish the two cases. The
  snapshot therefore surfaces the count and ids as a diagnostic; deciding
  whether one hides an open unpriced position is a separate, non-routine
  check that this module does not perform or guess.
- Evergreen **net** exists only with explicit dated evidence
  (`{schemaVersion:1, evidenceDate, evidenceRef, items:[{portfolioId, holdingId, amountUsd}]}`)
  bound to evergreen-classified rows; gross buckets and `highly_liquid` are
  unchanged by it, matching `pendingRedemptionRule.doNot`.
- Fingerprints detect drift; they are not proof of source authenticity.

## 4. Minimal trusted disclosure and guard integration (not in this change)

To publish fresh calculated buckets, a separately reviewed maintenance PR must:

1. **Prepare path.** In full-live mode, after `buildSourceEvidence`, call
   `deriveFourBucket` with the run's captured performance responses, the
   matching listing reads, the previous page's parsed template as `previous`,
   and explicit pending-redemption evidence or `null`. Embed
   `renderFourBucketTemplate(result.snapshot)` in the report. Allocation card
   values must come from that snapshot only, dated by `reportCutoff` and
   `readWindow`, with `fallback` shown as an explicitly dated last-good value.
   Minimal and weekly modes keep four-bucket metrics unavailable.
2. **Disclosure v2.** Add a deterministic `renderClassificationDisclosure`
   variant whose fourth sentence is generated from the snapshot: read windows,
   report cutoff range, row counts, cash proxy count, reconciliation status,
   and net status. The historical 2026-08-31 audit sentences stay verbatim.
3. **Guard.** Parse the template exactly once with `parseFourBucketTemplate`,
   require the v2 section byte-exact when the template is present, keep v1
   byte-exact when it is absent, and reject a page that shows current
   four-bucket figures without a valid template. Widen
   `unsupportedCurrentClassification` only for the generated v2 sentence.
   A records-update must preserve the template byte for byte.
4. **Cross-checks.** Reject a template whose `scope.portfolioIds` differ from
   the registry family set, whose `reportCutoff.latest` predates the previous
   published snapshot, or whose `readWindow` is not inside the run journal.
5. **Tests and CI.** Add guard and prepare cases to the blocking groups.

## 5. Verified source shape (read-only, 2026-09-06)

One authorized read-only Gateway check against a family portfolio confirmed
the shape the alias table now encodes, with no amounts recorded here:

- holding id is the row `id`; instrument identity is nested under
  `instrument` with `id`, `code`, `market_code`, `name`, `currency_code`;
- the audit name is `instrument.code | market_code instrument.name`, the
  exact form stored in the reviewed cash-identity registry;
- the liquidity label is `labels[].name` (`Semi Liquid`, `Highly Liquid`);
  `group_name` is the investment type and is not a liquidity label;
- unit price is `instrument_price`; there is no NAV date field;
- `links.self` echoes `include_sales`, `include_limited`, `consolidated`,
  `report_combined`; `links.self` and `api_transaction` are not pagination;
- the listing carried one identity absent from the open-positions report; a
  second read with `include_sales=true` showed it with zero quantity and zero
  value, confirming that listing-only identities are historical membership
  and must not be treated as open positions;
- a later read of the same portfolio, after its cash had been migrated to a
  native Sharesight cash account, showed the `cash_accounts` row shape:
  `id`, `key`, `name`, `source`, `value`, `currency` as an object with
  `code`, and a `portfolio` reference; the legacy proxy holding had left the
  open-positions report and remained only as a listing identity;
- the report's `sub_totals` cover holdings only, while `value` includes cash
  accounts; the normalizer checks both identities.

**Native cash migration rule.** A registered legacy cash proxy is not
required to remain live: once a native cash account supplies the cash, the
proxy simply stops appearing in the open-positions report and its registry
entry stays as a historical identity. A portfolio that values both a resolved
proxy and a native cash account in the same snapshot fails closed
(`CASH_REPRESENTATION_AMBIGUOUS`), because that cannot be distinguished from
double counting without a reviewed registry change.

Adjust `SHARESIGHT_FIELDS` in one place if another portfolio differs, then
re-run the tests.
