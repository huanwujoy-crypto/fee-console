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

### Owner-approved minimal first trial (2026-09-05)

For the separately activated **adhoc** first trial only, the owner approved a
narrower useful display: current direct IB NAV, book cash, holdings and orders;
immutable historic decisions/receipts and the original dated ABC comparison.
Unsupported risk, four-bucket/classification and replenishment calculations
are explicitly unavailable. Do not label book cash as spendable cash or deduct
an unverified CALL reserve. This overrides the full derived-display scope above
for this trial only, not the 5 IB / 9 Sharesight evidence requirements, account
association approval, publication checks or existing AM/PM schedules.

`xuan-ib-minimal-report.mjs` creates the view deterministically, rather than
asking the author to transcribe numbers or compose a full report. It requires
USD account-summary currency and the single `balances` row with
`currency: BASE`, taking that row's actual `stock_market_value`. Summary does
not supply this field; do not create it there. The BASE aggregate is not the
separate USD component row. Never sum BASE and per-currency rows, infer FX
direction, or substitute gross exposure or NAV minus cash. The stock-value
KPI uses the balances read time; the holdings note keeps that time separately
from the position-row read time. Native position labels
stay verbatim and are not represented as verified tickers/venues. Foreign
currency rows retain native price/currency/quantity with USD value null; no
assumed FX direction or fabricated reconciliation tolerance. Unknown daily
change, order-price distance, market calendar and trigger classification must
remain unknown. Current trades are counted, not called newly executed trades.

The verified native nonempty LIMIT-order shape uses string prices/quantities,
uppercase BUY/SELL and observed NEW/REPLACED status, with instrument information
only in free-text descriptions. Render complete primary/secondary descriptions
and original prices/total/filled/remaining quantities in a generic card table,
buys then sells, retaining source order within each side. Do not populate the
structured `rotation.orders` schema with invented symbol/currency/cancelReview.
Label each limit as currency-unavailable; do not compute price distance, order
age or cancellation advice. Order IDs/times are validated privately, not
published. Unsupported shapes/enums, numeric strings, inconsistent quantities
or overlong untruncated descriptions stop explicitly. Missing/duplicate BASE
or an unverified base currency likewise stops. Offline examples are not live
source acceptance.

### Capture and single-command preparation

Use a fresh existing **0700 directory outside every Git ancestor**, with 0600
files. A private temporary directory in the cloud is suitable for this one
run's evidence; it does not replace the persistent manual-consent store. Never
reopen an old journal or use old diagnostic reads as a new trial's source.

1. Initialize the real journal at entry and complete bootstrap/identity check
   as below. For the recurring pilot, run the freshly fetched main association
   `check` after bootstrap and before either financial-read stage, writing its
   receipt to the new directory's `association.json`. Policy must already be
   active through its separate approved release; this helper cannot activate it.
2. One owner starts the source stages and records their finishes. For each real
   connector call, run the following `begin` immediately before the call and
   `finish` after the complete native JSON response is available privately:

   ```text
   node scripts/xuan-ib-source-capture.mjs begin PRIVATE_DIR SOURCEKEY --journal JOURNAL
   node scripts/xuan-ib-source-capture.mjs finish PRIVATE_DIR SOURCEKEY RAW_JSON_FILE --journal JOURNAL
   ```

   Keys are `ib.accountSummary`, `ib.balances`, `ib.positions`, `ib.orders`,
   `ib.trades`, or `sharesight.PORTFOLIO_ID` for the nine required registry IDs.
   Sharesight uses its existing performance `result.data.report` shell, not a
   substituted holdings response. Preserve original native JSON: do not type
   selected values back into a synthetic response. Unknown transport wrappers,
   missing private result files or unavailable export capability stop this
   path; the capture command does not itself call or extract connector tools.
   Preserve original tool transcripts as provenance. Capture hashes/timestamps
   are local integrity records, not independent proof the tool actually ran.
3. After both source stages finish successfully, assemble exact 5+9 receipts:

   ```text
   node scripts/xuan-ib-source-capture.mjs assemble PRIVATE_DIR --journal JOURNAL --previous-source-sha SHA --data-date YYYY-MM-DD
   node scripts/xuan-ib-minimal-prepare.mjs PRIVATE_DIR --journal JOURNAL
   ```

   Assemble creates immutable `input.json`. Prepare validates the original
   `association.json` against freshly fetched main policy, checks local prior
   HTML/meta/registry/rules against that pinned main, and records real validate,
   derive and deterministic narrative stages. It writes `view.json` and
   `sources.json`, then invokes the unchanged render/guard preparation path to
   create `candidate.html`. No supplied production clock or policy override.
   Existing outputs, failed/partial journals, missing sources or changed main
   baselines stop; preserve evidence rather than editing it to retry.
4. The result remains `prepared-not-published`. Follow the existing single-file
   candidate, exact guard/Validate/Promote and public read-back steps below.
   Keep every raw/capture/view/source/journal file out of Git. The first capture
   implementation requires direct success from all sources; it does not invent
   retries or fake a fallback. Existing separately supported source fallback
   rules are unchanged, but are not automatically implemented in this builder.

This sequence removes manual envelope/view drafting; it does **not** remove
14 actual source reads, their private output handling, account checks or CI
latency. Measure one real end-to-end run before claiming a ten-minute result.

### Disabled-by-default hook bridge

The one separately authorized public-only experiment on 2026-09-05 verified
that a mid-session `PostToolUse` hook in the current Claude web runtime captured
the actual `whats_new` result. It was a **JSON string**, not the parsed object.
The temporary hook was removed, the original settings preserved, and the
temporary session mode restored to Auto. This establishes one public response
path only: it does not verify the five financial IB or nine Sharesight hook
wrappers, large-output completeness, future session permissions or runtime.
Large Sharesight tool results previously auto-saved by the harness likewise
do not prove the hook receives every large response completely.

`scripts/xuan-ib-hook-response.mjs` strictly accepts either a native object or
one JSON-string layer, validates the existing source shell, and uses the
repository's `fingerprint` for both the original `tool_response` value and its
decoded raw value. These are canonical **value fingerprints**, not wire-byte
hashes or independent provenance. For native objects the two hashes may be
equal; for strings, whitespace/escapes remain significant in the transport
hash. Duplicate keys, non-finite values (including JSON exponent overflow),
excessive nesting/size, malformed JSON, errors and unknown wrappers stop.
Parsing detects broken JSON, not every upstream partial/paginated response.
Do not peel an unknown content wrapper or infer completeness from valid syntax.

`scripts/xuan-ib-source-hook.mjs` mechanically connects an approved runtime hook
to the existing begin/finish/assemble helpers. **This code does not install a
hook, grant permission, activate policy, call an endpoint or publish anything.**
Before a separately approved real run, obtain the current runtime session ID
from an actual supported runtime event. Never substitute the cloud URL/session
ID, an invented identifier or a value assumed to survive an environment restart.

1. Keep the existing bootstrap, account-association and source-stage gates.
   In the same owning runtime, immediately **before dispatch** arm each source
   using a private 0600 binding file with exactly `toolName`,
   `runtimeSessionId`, `toolInput`:

   ```text
   node scripts/xuan-ib-source-hook.mjs arm PRIVATE_DIR SOURCEKEY BINDING_JSON --journal JOURNAL
   ```

   Arm runs the original `begin` helper once and records a random nonce,
   five-minute expiry, exact tool/input hash, run and begin-journal binding.
   Do not run the separate source-capture `begin` for the same key. Arming can
   be batched just before a bounded group of real calls; intervals then include
   dispatch/queue overhead and are not exact per-API latency. Never arm after
   dispatch or claim an older call that was already in flight.
2. A separately approved temporary hook may invoke `capture PRIVATE_DIR
   SOURCEKEY NONCE` with its real event on stdin, matching only the exact tool.
   Use the same command for `PostToolUseFailure`; a failure consumes the arm
   and cannot become an OK receipt. Several portfolio-specific handlers may
   share the performance matcher; unrelated tool/input pairs are ignored.
   The hook prints no stdout, changes no tool response/permission, and stores
   only private response/binding evidence, never full inputs, transcript paths,
   environment or raw failure diagnostics. Runtime ID and tool-use ID are not
   broker account proof. Preserve normal tool permissions; a hook failure does
   not retroactively cancel a completed read.
3. An exclusive claim allows one result per source. Bounded valid-JSON unknown
   wrappers are saved privately before rejection, with a separate static reason
   code, so diagnosis need not repeat the read. Invalid/oversized event input
   is rejected without persisting the full event. Failures/partial writes are
   never repaired, overwritten or re-armed in the same run. Review evidence and
   start a genuinely new run if authorized; do not manufacture success.
4. One owner waits for all expected receipts, then closes source stages serially.
   Hooks must not append the journal (its writer is not multi-process locked).
   For hook-created results use the dedicated assembler below. The generic
   assembler also enforces the same proof whenever a hook begin record or
   artifact exists; deleting hook artifacts cannot turn these into ordinary
   captures or bypass reconciliation:

   ```text
   node scripts/xuan-ib-source-hook.mjs assemble PRIVATE_DIR --journal JOURNAL --previous-source-sha SHA --data-date YYYY-MM-DD
   node scripts/xuan-ib-minimal-prepare.mjs PRIVATE_DIR --journal JOURNAL
   ```

   It reconciles all fourteen arms, claims, original response values, decoded
   files and final receipt hashes; mixed runtimes, reused tool-use IDs, rejected
   or missing artifacts fail before `input.json`. The existing assembler then
   independently checks source/run/journal/times. Keep every artifact outside
   Git. Uninstall only the exact temporary configuration after the run and
   verify original permission mode/settings; never overwrite concurrent edits.

Runtime tool definitions were loaded and reviewed on 2026-09-05 without any
financial read. The bridge permits the following **minimal** input variants:

| Source | Exact tool name | Input |
| --- | --- | --- |
| IB summary | `mcp__Interactive_Brokers__get_account_summary` | `{}` |
| IB balances | `mcp__Interactive_Brokers__get_account_balances` | `{}` |
| IB positions | `mcp__Interactive_Brokers__get_account_positions` | `{}` |
| IB orders | `mcp__Interactive_Brokers__get_account_orders` | `{}` |
| IB trades | `mcp__Interactive_Brokers__get_account_trades` | `{}` or `period: TODAY` (UTC day, not since prior report) |
| Nine registry portfolios | `mcp__Family_Portfolio_Sharesight__sharesight_get_performance` | `portfolio: ID-as-string`; optional null/valid dates, default `investment_type` grouping and false `include_sales` |

The SS key is **portfolio**, not portfolio_id; the returned portfolio and
report IDs must both match the registered source. Names/aliases are not used
in this first bridge. Definitions confirm input syntax, not response shells,
dates or pagination completeness. Defaults must match exactly what is armed;
omitted fields and explicitly supplied defaults have different input hashes.

The [official hooks reference](https://code.claude.com/docs/en/hooks) defines
PostToolUse/Failure event fields. Real financial transport acceptance, approved
activation, full timed publication and phone read-back remain separate gates.
Keep the pilot inactive until those prerequisites are met. Do not retype raw
financial values, turn fixtures into evidence, force output-cap spills, or route
around a classifier/security refusal. Synthetic success is not live readiness.

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

### Reusable source adapter and account scope

Use `scripts/xuan-ib-source-adapter.mjs` for supported raw response shells,
native position fields and whole-response hashes with actual read completion
times. Capture `rawFingerprint` immediately on receipt; modified raw bytes must
not pass against that original hash. These checks detect accidental drift,
not fabricated connector evidence: callers remain responsible for actual tool
provenance and timing. Raw receipts stay private. Native values are not silently converted to
USD; missing daily change is never zero. This helper is **not a complete
financial derivation adapter** and cannot certify transcribed source data.

The normal `buildSourceEvidence` path requires the approved account ID in the
actual IB account-summary response, and rejects conflicting endpoint IDs.
The connector observed in the first pilot omitted that field. The OWNER
confirmed the following narrow manual-consent alternative on 2026-09-05;
activation still requires this maintenance PR's exact-head OWNER approval.
Matching Sharesight positions/NAV, currency or copying the approved account
constant is not account proof. Never edit raw responses or hand-build a
confirmed envelope to bypass the adapter.

#### One manually requested ad-hoc run only

The separate owner-approved implementation described in
`claude/xuan-ib-account-association-v1.md` introduces an **inactive** recurring
alternative. It does not extend or reuse the one-shot proof below. Initial
activation requires fresh observation and separate exact-head approval. While
that policy selects a recurring ad-hoc pilot, follow its pre-read check and
publication receipt requirements instead of silently choosing this manual path.

- No AM or scheduled PM use, no lasting connector authorization and no trading.
  A fresh manual request and fresh observation are required for any later run;
  this approval is not standing permission to issue additional proofs.
- Start the actual private run journal before the fresh observation. In the
  same authenticated IBKR UI session, inspect the complete approved account,
  exactly one Manage Third-Party Consents row for Anthropic and that account,
  Claude enabled, and other AI platforms disabled. Do not infer Active status,
  a grant ID or precise consent expiry from a relative consent date. Do not
  revoke or reconnect. If any fact is absent or ambiguous, stop.
- `issueManualConsent({observation,journalPath,previousSourceSha,storePath})`
  is a private controller call after `bootstrap=ok` and before **any** financial
  reads. First validate the full journal with `showRunJournal`; no stage may
  remain active, no other stage may have started, and no source binding may
  exist. Observation keys are exactly
  `accountId, provider, consentRowObserved, singleConsentRow, claudeEnabled,
  otherAiDisabled, humanAttested, attester, observedAt`. The provider is
  `Anthropic`, attester is `owner-approved-operator`, five observation booleans
  are true, and observedAt is the actual canonical UTC observation time.
  The helper validates exact account equality privately; the source raw stays
  unchanged. The old policy-discussion observation must never be reused.
- The proof names the SHA-256 of the journal's original serialized init event
  as its `runId`, the trusted previous publication SHA and `edition:adhoc`.
  `issuedAt` is captured by the helper, not typed in a production call. It
  expires exactly 20 minutes after observedAt. The upper bound is exclusive.
  All five IB read intervals must be inside both this window and the same
  journal's IB-read interval. The adapter preserves each real readStartedAt
  and complete-raw fingerprint. It validates the journal and proof; even a
  nested `account_id` or `accountId` contradiction rejects the manual path.
  A present null/empty/wrong summary ID is never treated as absence.
- Pass `{manualConsentProof, journalPath}` as the adapter's third argument
  only when the actual summary lacks its own account_id. Native-ID runs use
  the original path without these manual options. The resulting IB envelope
  explicitly says `accountScopeBasis:manual-consent-once-v1`; it must not be
  described as an API identity attestation.
- Keep a **single designated persistent controller store file** in a private
  0700 directory outside every repository, files 0600. `storePath` is a file,
  not a directory. Issue reserves the observation fingerprint once; prepare
  consumes it under an exclusive file lock and binds the entire source-evidence
  fingerprint in the private receipt **before rendering**. A later failure
  burns that attempt. No resetting, deleting, copying or changing stores to
  retry, no new run journal around old reads. An existing lock after a crash
  means stop and inspect, not automatically remove it.
- For manual evidence add `--manual-consent-store /PRIVATE/consents.jsonl` to
  the existing prepare command. A missing store/journal, replay, wrong run or
  previous SHA, non-adhoc edition, expired proof or conflicting read window
  stops preparation. Do not pass test clock overrides in a real run. Prepare
  checks expiry again after guard and injects only one fixed short sentence
  into folded report notes. Do not publish private observation/store files.
- Store replay protection is procedural, not cryptographic: a trusted operator
  controls the filesystem and the observation truth. An ephemeral cloud
  container alone is **not** a durable cross-run store. Do not transfer this
  workflow to a fresh container and claim continuity without the same private
  controller. Current Claude-connection correspondence and revoke/reconnect
  inside the window are human-attested and cannot be detected from these
  tools. If either is suspected, abandon the run. The 20-minute bound and
  previous-publication binding do not make these machine-verifiable facts.

Proof validation accepts only fixed enums, hashes and timestamps. The existing
optional manifest comment is public, not encrypted; do not add raw account
consent rows, provider text, URLs, contact data, paths or credentials. Keep the
proof and raw observation in the private archive for this pilot; publish only
the fixed explanation. Historical manifest validation is not permission to
reuse expired evidence for a new candidate.

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
