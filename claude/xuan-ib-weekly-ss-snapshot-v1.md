# Weekly Sharesight snapshot — maintenance contract v1 (owner-approved 2026-09-06)

Status: **partial / integration incomplete.** This document + the pure helper
modules (`scripts/xuan-ib-weekly-snapshot.mjs`,
`scripts/xuan-ib-weekly-report-readiness.mjs`) and cadence config
(`claude/xuan-ib-source-cadence-v1.json`) define the mechanism and evidence
schema. Wiring into the existing capture → adapter → manifest → prepare →
renderer path (so a report no longer performs all-9 live Sharesight reads) is
**not yet done** and is explicitly required before this mode is usable. Do not
treat this branch as release-ready. It changes no routine and reads no financial
data.

## What changes

- **IB stays live every report** (5 endpoints). The IB positions fallback and
  its freshness are unchanged. The IB-HK (936247) weekly snapshot is **never** a
  live-positions fallback.
- The **nine covered Sharesight portfolios** are captured **once per
  Asia/Hong_Kong week**. Monday HKT is the **capture / week key**, not a
  valuation date.
- Each portfolio preserves its **native Sharesight `end_date`** as
  `valuationDate` (may be a Friday or an older private-NAV date). The system
  never forces or rewrites a valuation date to Monday.
- Reuse within the week carries **both** the original read time and the native
  valuation date. **Reuse never advances any stored date.**

## Degradation, staleness, and rollover

- A missing / invalid / partial Monday snapshot degrades only SS-dependent
  metrics; a healthy **IB-live report still publishes**. Never zero, never
  invent, never claim a cached read is live.
- A failed Monday refresh **keeps the last good snapshot**, surfaced as an
  explicitly dated **`stale`** result (previous week). Week rollover never
  erases previously good values and never promotes their dates. The UI must
  show current-week `weekly-current` distinctly from an explicitly dated
  `weekly-stale` / historical display.
- Snapshot resolution status is one of: `current`, `stale`, or `unavailable`
  (reasons include `DURABLE_CACHE_NOT_ACTIVATED`, `SNAPSHOT_MISSING`,
  `SNAPSHOT_INCOMPLETE`, and structural rejections).

## Durable storage — explicitly NOT activated

No safe durable private Sharesight store exists yet. This mode ships with the
durable cache **unconfigured**: with no store, `resolveWeeklySnapshot` returns
`unavailable / DURABLE_CACHE_NOT_ACTIVATED` and every non-Monday report takes
the degraded SS path. No raw Sharesight holdings in the repo or on Pages; no
fee-Gist reuse; no fabricated persistence. Activating a durable private store is
a separate, reviewed change.

## Integrity boundary

Fingerprints are drift/shape checks only — **a fingerprint alone is not a proof
of source authenticity**. Raw-vs-fingerprint re-verification requires the raw
bytes, which live only in a (deferred) durable private store, never in the repo.

## Four-bucket alignment

Because four-bucket derivation consumes Sharesight holdings, its SS-derived
portion is dated to the snapshot's **native valuation date(s)** (distinct from
the historical 2026-08-24 dated fallback — do not relabel that fallback as a new
successful Monday snapshot). **Four-bucket mapping validation remains
mandatory**; weekly cadence does **not** resolve the existing classification
audit gap.

## Preserved

Excluded scope (1021747 never read), stable decisions and receipts, association
scope, and all publication gates are unchanged. Historical reports keep the old
every-report protocol; the weekly behavior is a new explicit mode. The prior
failed financial-trial journal and its private artifacts remain immutable.

## Scope key

Do not repurpose `requiredEachReport` (it remains the registry scope key used by
capture/adapter/manifest). Cadence is a separate dimension in
`claude/xuan-ib-source-cadence-v1.json`.
