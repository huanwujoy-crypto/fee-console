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

### Reusable source adapter and current limitation

Use `scripts/xuan-ib-source-adapter.mjs` for supported raw response shells,
native position fields and whole-response hashes with actual read completion
times. Capture `rawFingerprint` immediately on receipt; modified raw bytes must
not pass against that original hash. These checks detect accidental drift,
not fabricated connector evidence: callers remain responsible for actual tool
provenance and timing. Raw receipts stay private. Native values are not silently converted to
USD; missing daily change is never zero. This helper is **not a complete
financial derivation adapter** and cannot certify transcribed source data.

`buildSourceEvidence` requires the approved account ID to be present in the
actual IB account-summary response, and rejects conflicting endpoint IDs.
The connector observed in the first pilot omitted this field. It therefore
cannot pass this path until authoritative, source-bound account identity is
available. Matching Sharesight positions/NAV or copying the approved account
constant is not account proof. Do not bypass this failure by hand-building a
confirmed envelope. No new scope-inference policy is approved by this change.

Use existing audited calculation modules only. The first pilot's transcribed
AI coefficients, whole-book four-class membership, theme denominator and
heuristic account binding are NOT production rules. Unsupported AI/theme or
classification aggregates must be unavailable or explicitly dated historical
values; incomplete cash-plan inputs produce schema 2 `unavailable`. Only
supported independently verified modules may use current-value language.

### Concise mobile display

- KPI note target: at most 80 characters; move derivation detail into report
  notes. Prefer 1–3 numbered conclusions, each at most 80 characters, rather
  than dense paragraphs. Additional lines are collapsed, not deleted.
- New risk/allocation/events/rotation cards should provide `brief` with exactly
  `state` (`normal|attention|unverified|unavailable`), `takeaway` (at most 60
  characters) and `action` (`observe|owner-review|verify`). No buy/sell action
  is available. State must follow source-backed rules, not a guess from prose.
  Unverified means evidence awaits checking; unavailable means the source was
  not obtained. All figures in a table share its explicit card timestamp unless
  individual timestamps are supplied. At most five rows show initially.
  Original explanations remain folded. Legacy long prose is folded without
  inventing a conclusion or a normal-state badge. A collapsed five-point guide
  explains timestamps, tabs, decisions, ABC and report generation.
- `rotation` may add `orders` alongside its usual card fields; then `columns`
  and `rows` must be empty. Each order contains exactly `symbol, side` (`buy`
  or `sell`), `quantity, limitPrice, marketPrice, currency, marketAsOfHkt,
  ageDays, status, cancelReview`. Missing market price/date are both null;
  unknown age is null. Limit and market prices must be in the same currency.
  `cancelReview` is an existing reviewed classification, never inferred by
  this display helper. It does not cancel an order.
- The renderer groups buys then sells and sorts each group by unrounded
  absolute percentage price distance. Ties retain input order; missing quotes
  come last. Price distance is not probability of execution. Prices and
  percentages stay whole; raw status/age appear under the order symbol.
- The todo count remains the number of pending decisions; amber on the same
  badge indicates an additional progress warning, not an added decision.
  Existing accessible warning text and detailed progress explanation remain.

1. At actual Routine entry, before reading contracts, initialize a new private
   timing journal: `node scripts/xuan-ib-run-clock.mjs init /tmp/RUN.clock.jsonl`.
   This is not the scheduler's queued time; record scheduling delay separately.
2. Use `start FILE STAGE` / `finish FILE STAGE` around the six upstream stages:
   bootstrap, ib-read, sharesight-read, validate, derive, narrative. Journal
   writes have **one writer**; start independent stages sequentially, execute
   their source calls in parallel, then record their completions individually.
   Do not concurrently append from child processes. Never type stage times.
   Inside bootstrap, **before any financial read**, run
   `node scripts/xuan-ib-git-identity-preflight.mjs effective`.
   A mismatch finishes bootstrap `failed/GIT_IDENTITY_INVALID` and stops.
   This reads Git's effective author/committer, including environment overrides;
   it does not repair identity or prove future GitHub signature/login approval.
   Never manufacture an identity to make the check pass.
3. Save the validated public view and private source-evidence envelope outside
   the repo. The latter has only `schemaVersion:1, edition, dataDate,
   previousSourceSha, sources`; `sources` is the existing run-manifest source
   schema. It requires every expected endpoint and portfolio, explicit status,
   asOf, retries, hash and bounded failure code. Do not invent successful reads
   or hashes for operations that did not occur.
4. Keep `narrative` **active** while drafting and checking the view:

   `node scripts/xuan-ib-report-prepare.mjs preflight-view /tmp/RUN.view.json`

   This is a strict, read-only draft check, not rendering or preparation. If
   only a summary/observation/note exceeds its text limit, shorten that text
   locally, preserving facts and required disclosures, then check again (at
   most three draft checks). Do not truncate blindly, change financial fields,
   rewrite evidence, restart the journal or refetch sources for a prose error.
   Keep the original failing view as a private immutable baseline. For a retry
   use `node scripts/xuan-ib-report-prepare.mjs preflight-text-retry
   /tmp/RUN.baseline.json /tmp/RUN.view.json`; it permits only shorter narrative
   strings whose original length exceeded that field's limit, with unchanged
   list lengths and exact equality of all other fields. Already-compliant text
   cannot be opportunistically rewritten in the same retry.
   Do not use the initial preflight command to bypass this comparison.
   On first-pass success finish narrative `ok`; after local correction finish
   it `degraded` with error code `NARRATIVE_REDUCED`. All elapsed drafting and
   correction time remains inside the same stage. Retain failed draft-check
   results in the private run transcript. Other schema/source/privacy errors,
   or exhausted checks, finish `failed` and stop. An already-failed journal
   stays immutable and cannot be reopened. Then, with trusted main helpers and
   matched `latest.html/latest.meta.json`:

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
   Immediately before committing, repeat the `effective` identity check. After
   the commit and before push, run `node scripts/xuan-ib-git-identity-preflight.mjs
   commit FULL_SHA` against the actual immutable commit. The unchanged Promote
   workflow still independently requires GitHub verified signature and both
   author/committer logins. Local success does not replace those gates.
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
