# Compact PM / ad-hoc pilot — v1

## Scope and activation

Maintenance implementation, reviewed with Claude Fable 5.1 / Max on 2026-09-05.
This is a **pilot authoring path**, not a new data source, financial formula,
permission, publication gate or proof of ten-minute delivery. AM remains on its
existing full-report path. Do not silently enable this pilot for scheduled PM
until one real ad-hoc end-to-end run has passed review; then separately observe
the next scheduled PM. A manual sample does not prove scheduled delivery.

The user permits simpler reporting. Remove repeated narrative and historical
timeline copying from the PM critical path, not required evidence. Preserve:

- 5 read-only IB endpoints, original confirmed-scope 2+3 waves;
- all 9 required Sharesight portfolios, concurrency at most 3;
- current risk inputs, approved thresholds, source times and field fallbacks;
- the trusted prior HTML/meta pair, every decision/status and receipt;
- canonical cash-plan, policy and classification helpers; the existing open
  ABC summary is copied byte-for-byte with its real original valuation dates;
- unchanged guard → Validate → Promote → Pages → exact public read-back.

Do not dispatch a background agent and then end the owning Routine. One owner
waits for its source calls, guards, candidate and final publication observation.
Bounded independent source calls may run concurrently. Do not rebuild the full
classification audit, CALL ledger, ABC history or deep research in the PM path.
Those are separate maintenance/AM work, with original dates still disclosed.

## Input contract

`scripts/xuan-ib-report-view.mjs` is a deterministic **presentation** renderer.
It does not authenticate to a broker, derive/verify every financial calculation,
or prove that caller-supplied numbers were genuinely fetched. Existing source
normalization/calculation and reconciliation are still mandatory. Never claim
that a presentation schema replaces them.

The public view is a strict JSON object; no arbitrary HTML, attributes, scripts,
URLs, credentials, raw responses or account numbers. Numeric source fields use
finite numbers or `null`; null is never substituted with zero. Every KPI/card
and holdings block has an explicit `asOfHkt` (date or dated HKT read window).
Current-run `asOfHkt` must include the report date and times.

Top-level keys, all required:

| Key | Shape / bound |
| --- | --- |
| schemaVersion / edition / dataDate | `1`, `pm` or `adhoc`, HKT YYYY-MM-DD |
| asOfHkt / marketContext | dated HKT read window; ≤120 characters of market status |
| alerts / summary | up to 3 alerts `{level: warning|error, text}`; exactly 3 summary lines, each ≤150 characters |
| kpis | exactly 3 `{label,value,format:usd|percent|number,asOfHkt,note}`; cash-plan is added as fourth |
| holdings | `{status:ok|fallback|unavailable,asOfHkt,authoritativeValueUsd,note,rows}` |
| risk / allocation | 1–8 cards each |
| rotation / events | one card each; unqueried calendar must say unqueried, not “no events” |
| decisions | every previous decision, plus genuine new issues only |
| observations / notes | ≤5 short observations; exactly 3 concise report-explanation points |
| cashPlan | approved schemaVersion 2 input for the existing cash-plan helper |

Cards contain `{title,asOfHkt,lines,columns,rows}`. No HTML is accepted in these
fields; characters are escaped. Use cards for the existing calculation results,
not invented metrics. Risk, portfolio totals and concentration figures must
reconcile to the same normalized source snapshot used elsewhere in the report.

Each holdings row contains `{symbol,market,quantity,price,priceCurrency,
marketValueUsd,changePct,changeAsOfHkt,quoteStatus}`. A missing daily change is
`null / null / unavailable`; it is not zero. A quote from an earlier HKT date is
shown as an old value under “涨跌数据待核验”, not as a fresh ≥1% move. Daily-change
source time is separate from holdings valuation time. No quote query means
“未取得/未查询”, not “no change”. Do not infer daily change from profit, costs or
the difference between two report NAVs. A bounded optional quote stage may be
off in the first pilot; do not relabel historical quotes to fill it.

Existing decisions accept only `{decisionId,asOfHkt,fact,isNew:false}`. The
renderer inherits the original visible title/options/recommendation and the
complete machine history. Fresh facts are shown separately; old monetary
figures are explicitly historical. Do not rewrite an old recommendation while
retaining its ID. New unresolved issues additionally require `title`, at least
two `options` and `recommendation`, with `isNew:true`; they can only enter as
`awaiting_user`. This command cannot accept opinions or create receipts.

## One owner, reproducible preparation

1. At actual Routine entry, before reading contracts, initialize a new private
   timing journal: `node scripts/xuan-ib-run-clock.mjs init /tmp/RUN.clock.jsonl`.
   This is not the scheduler's queued time; record scheduling delay separately.
2. Use `start FILE STAGE` / `finish FILE STAGE` around the six upstream stages:
   bootstrap, ib-read, sharesight-read, validate, derive, narrative. Journal
   writes have **one writer**; start independent stages sequentially, execute
   their source calls in parallel, then record their completions individually.
   Do not concurrently append from child processes. Never type stage times.
3. Save the validated public view and private source-evidence envelope outside
   the repo. The latter has only `schemaVersion:1, edition, dataDate,
   previousSourceSha, sources`; `sources` is the existing run-manifest source
   schema. It requires every expected endpoint and portfolio, explicit status,
   asOf, retries, hash and bounded failure code. Do not invent successful reads
   or hashes for operations that did not occur.
4. With trusted main contracts/helpers and matched `latest.html/latest.meta.json`:

   `node scripts/xuan-ib-report-prepare.mjs /tmp/RUN.view.json /tmp/RUN.sources.json /tmp/RUN.candidate.html --journal /tmp/RUN.clock.jsonl`

   This checks source scope/readiness, creates a complete escaped report, runs
   the **unchanged** trusted guard once and writes a new staging HTML only after
   success. The operational CLI requires `--journal`; omitting it is an error.
   It records real render/guard/preparation timing. Existing output is
   never overwritten. On failure, inspect the structured input; do not patch
   long generated HTML by hand. `prepared-not-published` is not publication.
5. Follow the existing single-file candidate contract: one `claude/...-xxxxxx`
   branch, one non-merge `handover YYYY-MM-DD` commit, only `xuan-ib/index.html`.
   Recheck trusted main/pair immediately before staging. Never commit the view,
   source envelope, journal or private source data. Stage validated candidate
   bytes; verify only that file changed; commit and push without in-run code
   maintenance. Bind its SHA once using `bind-source FILE SHA`.
6. Wait for actual Validate / Promote / Pages, then compare public sourceSha
   and htmlBlob to the candidate. `show FILE` gives private timing/manifest
   fields, not published-success status. Public readback/commit/deployment times
   are recorded separately against the same SHA. An unavailable public route
   means “not independently verified”, not completed.

This first helper does not implement connector authentication or automatic git
operations; Routine uses its already connected read-only tools and existing
publication path. It must not fabricate a success for missing capabilities.

## Failure and timing rules

- Unconfirmed account scope or multiple critical IB failures stop publication.
  Keep last verified report untouched. Compact v1 is stricter still: summary,
  balances, orders and trades must each be direct `ok`; all nine required
  Sharesight reads must be `ok`. Their source-read HKT dates must equal this
  report's date. A previous valuation date (private funds or T-1 holdings) is
  separately retained in the visible view; do not relabel it as a new valuation.
  Direct IB source evidence must carry an RFC 3339 read instant with offset.
- Positions alone can use fresh-read Sharesight IB-HK with its existing maximum
  one-completed-US-trading-day holdings lag; the actual holdings date is still
  disclosed. Compact preparation stops if neither source is usable. It cannot
  safely publish other single-field failures because v1 has no complete module
  dependency/availability map. This does not relax or replace the global legacy
  policy. The preparer adds a conspicuous source-bound fallback alert.
- Upstream bootstrap, Sharesight, validate and derive journal stages must be
  `ok`; IB must be `ok` for direct reads or `degraded / IB_POSITIONS_FALLBACK`
  for the approved fallback. Narrative permits `ok` or explicitly
  `degraded / NARRATIVE_REDUCED`. Failed, missing, running or contradictory
  stages stop preparation. Never turn a failed check into a completed stage.
- Target: candidate ready ≤420s from actual Routine start; reserve ~120s for
  existing CI/public readback plus 60s contingency. These are budgets, not
  timers that cancel correct work or promises of future latency.
- Budget breach is recorded, not hidden. A late but valid report may complete;
  a readback timeout says unverified and never changes/erases the latest report.
- Journal stage sums may overlap. Use total elapsed for runtime; the union of
  active stages is only covered work time, not a dependency-graph proof.
- First acceptance: real ad-hoc read → candidate → public exact pair within
  ten minutes, and unchanged history/financial boundaries. Second acceptance:
  observe actual scheduled PM separately. Local render tests and simulated
  timeouts do not count as either production timing sample.

## Review consensus

Claude Fable 5.1 / Max agreed after challenge to retain all 5 IB / 9 Sharesight
reads, original 2+3 scope validation, immutable historical decisions, existing
metadata and publication gates. Rejected suggestions: making auxiliary risk
portfolios optional, publishing despite multiple critical failures, moving
receipt source-of-truth or adding new metadata fields. Agreed to preserve
original opinion text, separate current facts, and log overruns honestly.
