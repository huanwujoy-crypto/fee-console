# Ten-workbook and inception boundary: implemented local stage

This extends the allocation-only candidate. It is not the full formal performance
assembler. It does not run the current cloud repository's JS projection,
authenticate provider observations, collect remote data, or publish anything.

## Default-disabled IO API

`prepare_offline_workbook_batch(request, enabled=False)` returns `DISABLED`
without reading sources. The explicit local mode accepts exactly:

```
{
  "schema": "ratio-offline-workbook-batch.v1",
  "targetDate": "YYYY-MM-DD",
  "allStartDate": "YYYY-MM-DD",
  "bindings": {
    "allocation": {"classification": "source spec", "exposure": "source spec", "capture": "source spec"},
    "assetclass": {"all": "source spec", "oneYear": "source spec", "capture": "source spec"},
    "strategy": {"all": "source spec", "oneYear": "source spec", "capture": "source spec"},
    "top5": {"all": "source spec", "oneYear": "source spec", "capture": "source spec"},
    "stock": {"all": "source spec", "oneYear": "source spec", "capture": "source spec"}
  },
  "inception": {"document": "source spec", "sources": ["source spec"]}
}
```

Every source specification is exactly `path`, `sha256`, `libraryFileId`,
`libraryVersion`. This request is a new local API, not an implementation claim
for the differently shaped historical `ratio-ten-workbook-bindings.v1`.

All files require genuine stable descriptor/identity/hash verification before
decoding and byte/identity rechecking afterward. The 15 workbook/capture bindings,
inception document and its source bindings must have unique IDs. Inputs are
bounded to 128 MiB in aggregate; no source identity is created or repaired.

## Implemented checks

- Reuses the fixed-scope allocation conversion and preserves Exposure's actual
  source date. The separate formal date-policy blocker remains.
- Validates four complete two-period capture records, their exact 13 fields,
  accounts, range, group, USD, include-closed, included-cash setting, original
  nanosecond string and observation sequence. Report freshness is <=36 hours,
  and source date age is <=4 Hong Kong calendar days. Materialization time never
  replaces original capture time.
- Decodes assetclass and strategy native aggregate reports, combined or
  uncombined Top5 reports and native stock subtotals. Combined/grouping completeness, explicit
  dates, closed-member evidence, native Totals and source coordinates are checked.
- Binds exact member sets and unchanged source cells across the four groups in
  each period. Exact XML decimals are used for numeric comparisons. This version
  deliberately refuses cross-capture differences instead of introducing any
  historical tolerance or asserting their cause.
- Checks native strategy labels and the existing four-category stock membership.
  Requires exactly one stock subtotal group with the complete derived members.
- Requires all-period coverage of one-year and current allocation members.
- Binds the inception document's exact source IDs/version/hash to separately read
  source bytes. Its v2 declarations must cover precisely the required members.
  Inception dates before the all-period query window are refused.

## Exact inception-v2 consumer contract

The pure validator is `validate_inception(evidence, accounts=..., as_of=...,
classification_positions=..., required_members=..., now=...)`. Its explicit clock
belongs to a pure structural validator. The IO entry has no clock/verifier/scope
override and uses the actual clock.

Root keys are exactly `schema`, `capturedAt`, `includeClosed`, `sources`,
`sourceCaptures`, `members`. Schema is `fee-console.ratio-inception-source.v2`,
includeClosed is boolean true. Root capturedAt is the latest per-source capture.

- Source reference: exactly `libraryFileId`, nonnegative safe-integer `version`,
  lowercase 64-hex `sha256`, nonempty `locator`.
- Source capture: exactly `libraryFileId`, canonical UTC millisecond `capturedAt`,
  and `sourceKind` of `verified-historical-archive` or
  `browser-first-recorded-buy`. Each referenced source has exactly one nonfuture
  capture and is used by a member. Old archive captures are preserved, not given
  a fabricated new timestamp or an invented 36-hour archive expiry.
- Member: exactly `account`, `market`, `securityCode`, `startDate`, `dateKind`,
  `sourceFileId`, `sourceLocator`, plus `browserEvidence` only for browser members.
  Unknown dates, duplicate/conflicting identities, missing or extra required
  members, unknown accounts, and invalid source-kind associations fail.
- Archived holdings use `holding-inception`; cash may use `cash-opening-balance`
  or `cash-first-transaction`. Start dates must be real dates no later than as-of.
- Browser evidence: exactly `view`, `complete`, `records`, `currentQuantity`.
  View is `All trades & adjustments`, complete is true, and records has exactly
  one record with keys `type`, `status`, `date`, `quantity`. It must be a confirmed
  positive Buy whose date equals startDate and quantity equals currentQuantity.
  That quantity must match exactly one current classification position. Browser
  dates cannot exceed as-of or the source capture's Hong Kong day. Cash cannot
  use this browser proof.

These rules derive from the existing pure aggregate consumer and its source-core
quantity check, not from the historical private archive/browser supplement code.
Exact no-extra member coverage is an intentionally stricter local requirement.

## What successful staging does NOT prove

The return state is `OFFLINE_WORKBOOK_BATCH_BOUND_CANDIDATE`. It contains an
allocation candidate, separate native report groups, the unchanged inception
declarations and a deidentified inception check receipt. It deliberately does
not label this object `sharesight-private-performance-v1` or manufacture an
authenticated full model.

`sourceOriginVerified`, `fullPerformanceReady`, `publicationReady`, and
`productionEnabled` remain false. Actual file identity/hash checks establish
which bytes were supplied, not whether the provider page was completely observed
or the captured control assertions are genuine. Inception source bytes are bound
but their provider-specific raw observation schemas are not parsed into new
evidence by this stage. No source kind is upgraded to authenticated by copying a
declaration.

Remaining trust/integration blockers are provider-observation authentication,
current cloud source/model compatibility, refresh date policy, independent full
review and separately authorized activation. The staging API intentionally does
not assemble a complete original itself. The later ASSEMBLY.md stage now supplies
combined-Top5 target association and final native performance assembly for the
strict supported local path.

The contract allows a future implementation to add supported cases explicitly;
it does not authorize new data collection, broader identity permissions,
historical exception reuse, or weakening a failed check.

## Later assembly stage

The source-set API still returns separate staged groups. The new
`prepare_offline_performance` API described in ASSEMBLY.md now consumes them and
closes the combined-Top5 and final-assembly code gaps for a strict supported path.
It does not remove the provider-authentication, current-cloud or date-policy
blockers. All authority and publication flags remain false.
