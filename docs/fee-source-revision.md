# Historical source revisions and shared validation

Status: local integration candidate; not approved for production execution.
The historical algorithm below remains separate from admission. The proposed
integration uses the existing protected producer, authenticated published
artifacts and original writer; it does not edit the economic book, change a
schedule or reset any claim/consumption record. Code approval and an actual
one-time recovery authorization remain separate prerequisites.

## Read-only historical revision diagnosis

The local `ib-source-revision-20261106-diagnostic-v1` candidate is a separate
diagnostic admission, not a new production recovery permission. Its release
must be the signed, protected squash successor of
`4f98318c73d1727d323febdcc72b7d5fbfb77f01`, with the exact approved head/tree,
owner comment and complete fifteen-file manifest below. The new main cannot
reuse the older `sync-v2` release binding. A diagnostic capability is not
accepted by the report producer or publication path.

The complete candidate consists of:

- `.github/workflows/fee-cloud-producer.yml`
- `.github/workflows/scripts-check.yml`
- `docs/fee-source-revision.md`
- `scripts/fee-cloud-producer.mjs`
- `scripts/fee-report-producer.mjs`
- `scripts/fee-report-producer.test.mjs`
- `scripts/fee-source-revision-diagnostic.mjs`
- `scripts/fee-source-revision-diagnostic.test.mjs`
- `scripts/fee-source-revision-runtime.mjs`
- `scripts/fee-sync-revision-artifacts.mjs`
- `scripts/fee-sync-revision-artifacts.test.mjs`
- `scripts/fee-sync-revision-github.mjs`
- `scripts/fee-sync-revision-github.test.mjs`
- `scripts/ib-manager-source.test.mjs`
- `security/approval-tiers.json`

The existing `ib_diagnostic_once` and `ib_diagnostic_main` dispatch fields select
only the independent `IB diagnostic 2026-11-06` job. Its title, first-attempt
restriction, workflow concurrency, environment and read permissions are retained.
The period, normal producer, once-claim/finalizer, source-acceptance and ratio jobs
remain excluded. No cron, claim, consumption record or supervisor setting is
changed. A malformed or mixed request stops before financial access.

The dedicated CLI is `scripts/fee-source-revision-diagnostic.mjs` with
`--expected-main=<approved-main>`; `--check-plan` performs the public gate before
WIF or financial credentials. The execution phase uses only the existing
`FEE_REPORT_ACTIONS_TOKEN`, existing Sharesight pair, `FEE_DATA_KEY`,
`FEE_ECON_GIST_ID` and the baseline binding. The Gist locator is supplied only
to the execution phase. No publisher, ratio-manager or economic-write token is
provided, and no credential is discovered or exported.

The diagnostic authenticates the unchanged published data/health pair, original
November 4 and 5 artifacts and producer evidence, and the economic version. It
then exercises the original bounded Jenny historical-source preparation through
November 6 and its current-context checks. No ordinary three-account source
capture, benchmark refresh, daily writer, signed candidate, promotion, ratio
update or production reservation is called. Any in-memory revision candidate
remains private and is discarded; it is never handed to a writer or emitted.

Only fixed stage, role and allowlisted reason codes leave the process. Raw
exceptions, URLs, account values, source payloads and credentials do not appear
in logs or uploaded artifacts. Temporary encrypted economic inputs and private
runtime material are cleaned on success and failure; a cleanup error remains
a failure. Existing signatures, original-producer log binding, source checks,
month locks, expiry and change detection are not relaxed to obtain a result.

This is local preparation only. Upload, exact-version approval and required
checks do not themselves authorize a real diagnostic. Its bounded private reads
require the applicable explicit execution approval; failure stops without a
retry. First-attempt and workflow serialization checks are not a persistent
limit across separately created dispatches: the operator must submit only the
one authorized dispatch and resolve an uncertain result before any further action.
A successful diagnostic proves only its stated checks, not a generated
or published fee report or an updated ratio snapshot. A later production attempt
requires its own reviewed version, authorization and unchanged safety gates.

## Economic-source reason mapping (`diagnostic-v2`)

Status: diagnostic improvement only. The recorded `ECONOMIC_SOURCE` failure came
from two catch sites that discarded the underlying reason; the mapping below
makes a future failure distinguishable. It does not identify the historical
root cause, which remains unknown, and it does not relax any acceptance,
rejection or retry policy: every path that was refused before remains refused.
Lower-level source codes are unchanged; the diagnostic wrappers add the fixed
reason details below. No path gains an extra read, retry or fallback.

`ib-source-revision-20261106-diagnostic-v2` is a second read-only diagnostic
admission with the same purpose, title, dispatch fields, CLI and credentials as
`diagnostic-v1`. Its release must be the signed, protected squash successor of
`22174f04cae8ac18a071930f491598b327e315c5`, with this exact thirteen-file
manifest (all `modified`): `docs/fee-source-revision.md`,
`scripts/fee-economic-source.mjs`, `scripts/fee-economic-source.test.mjs`,
`scripts/fee-report-producer.mjs`, `scripts/fee-report-producer.test.mjs`,
`scripts/fee-source-revision-diagnostic.mjs`,
`scripts/fee-source-revision-diagnostic.test.mjs`,
`scripts/fee-source-revision-runtime.mjs`,
`scripts/fee-source-revision-runtime.test.mjs`,
`scripts/fee-sync-revision-artifacts.mjs`,
`scripts/fee-sync-revision-artifacts.test.mjs`, `scripts/ib-manager-source.mjs`
and `scripts/ib-manager-source.test.mjs`. A `diagnostic-v1`, `sync-v2` or
`sync-v3` release cannot be relabelled as `diagnostic-v2`, and a `diagnostic-v2`
capability is still refused by the report producer, writer and publication path.

Provenance is identity-only. Each module keeps a private `WeakMap` from the
exact error object it threw to one literal from a frozen allowlist; a lookup
never reads `code`, `message`, `cause`, prototypes or proxy traps, and a
caller-constructed error (even a genuine `SourceFetchError`) has no provenance
and reports `UNKNOWN`. The public error shape (`code`, `message`, no `cause`)
and `sourceFailureCode` are unchanged.

| Site | Public code | Reason suffix (finite literals) |
| --- | --- | --- |
| `fetchEconomicSnapshot` acquisition in the CLI `readPrivate` stage | `FEE_REVISION_DIAGNOSTIC_ECON_INITIAL_<reason>` | ordinary source code without `SOURCE_` (`AUTH`, `FORBIDDEN`, `HTTP`, `REDIRECT`, `NETWORK`, `TIMEOUT`, `RESPONSE`, `OPTIONS`, `LOCATOR`, ...); `PAIR_{REVISION,BYTES,ETAG,MULTIPLE}` when the two acquisition reads disagree; `LOCAL_{DIRECTORY,FILE,MODE,BYTES,IO}` for private-storage integrity |
| artifact `readVerifiedArtifacts` first economic recheck | `..._ARTIFACT_ECON_FIRST_<reason>` | as above, plus `FROZEN_{REVISION,BYTES,ETAG,MULTIPLE}` when the current source differs from the pinned acquisition, `CHANGED` for refused recheck options or unstable optional recipient/fund metadata, `CLOSED`, `UNKNOWN` |
| artifact `checkCurrent` economic recheck | `..._ARTIFACT_ECON_RECHECK_<reason>` | same set |
| ciphertext read / version binding | `..._ARTIFACT_ECON_BYTES_<reason>`, `..._ARTIFACT_ECON_BINDING_<reason>` | same set |
| captured Sharesight recheck in `verifyCandidate` | `..._ARTIFACT_SOURCE_RECHECK_<stage>` | `STATE`, `LOCAL_TRANSPORT`, `LOCAL_SCOPE`, `AUTH_RESPONSE`, `RECORD_CHANGED`, `CAPTURE_CHANGED`, `{AUTH,READ}_{CONFIG,HTTP,TYPE,SIZE,BODY,JSON,ABORTED,TIMEOUT,NETWORK,REFUSED}`, `UNKNOWN` |
| two-attempt Sharesight capture in `prepareCandidate` | `..._ARTIFACT_SOURCE_CAPTURE_<site>` | `FINGERPRINT` (normalized business re-read differs), `RECORDS` (raw GET batches differ beyond the shared lexical rule; when classified, `RECORDS_<route>_<kind>` with route `PORT`/`HOLD`/`PERF`/`CASH`/`TRADE`/`TXN`/`PAYOUT`/`OTHER` and kind `SET`/`DUP`/`RAW`/`LEX`/`VAL`, fixed literals only), `TRANSPORT` (local fetch/credential identity changed); an unclassified reader failure keeps its original source code |
| original-producer log download | `..._ARTIFACT_GITHUB_<role>_LOG_<reason>` | existing bounded GitHub read reasons |

Contract `ib-source-revision-20261106-diagnostic-v5` is a separate, not yet
granted read-only diagnostic for the same 2026-11-06 target. It is pinned to the
real main `b72cd68` (parent `e30015d`, unchanged `index.html` blob) and to the
exact file manifest of its own release; it is not the consumed v4 admission and
does nothing until owner approval, merge and an owner-started run.

Contract `ib-source-revision-20261106-diagnostic-v6` is the same kind of
read-only diagnostic for the record-order release: same target, pinned to the
real main `05731b0` (parent `b72cd68`, unchanged `index.html` blob) and to its
own release file manifest. It is not the consumed v5 admission.

Contract `ib-source-revision-20261106-diagnostic-v7` is the same kind of
read-only diagnostic for the catalog-member/evidence release, pinned to the
real main `4d569f5` (parent `05731b0`, unchanged `index.html` blob) and to its
own release file manifest. It is not the consumed v6 admission.

From that release the diagnostic result may carry `sourceEvidence`, re-validated
literal by literal: `capture` (every route of both acquired rounds, or `PASSED`)
and `currentness` (`NOT_REACHED` when the run stopped earlier; otherwise the
groups found, with `currentnessCoverage` `FIRST_CHANGED_RECORD` or
`ALL_RECORDS`, the coverage the original flow had). Each route class maps to
fixed groups only: `ALLOWED_UNCONSUMED_CATALOG` (the one non-blocking marker:
the exact catalog members this chain does not consume differed) and the
blocking `ROUTE_SET`, `DUP_ROUTE`, `RAW`, `LEX`, `ROWSET`, `MEMBER_SET`,
`STRUCTURE`, `ID`, `INSTRUMENT`, `PORTFOLIO`, `QUANTITY`, `AMOUNT`, `CURRENCY`,
`DATE`, `STATE`, `TEXT`, `KIND`, `ARRAY`, `TYPE`, `UNKNOWN`. A verified run
always carries it, so a pass still shows whether the exception was used. No
value, id, field name, count or position is ever included. `UNKNOWN` names no
field: it can show that an unlisted member differed, not which one or why.

"Once" is an execution-procedure limit, not a code guarantee. The admission
binds the exact main, parent, file manifest, owner approval comment, owner
actor, `workflow_dispatch` event and `run_attempt == 1` of the current run; it
does not prove that no other run on the same main happened, and no Actions
run-history listing, lock, store or permission is added for that. One single
executor, a new specific approval and exactly one dispatch are required; if a
result is unclear, read that run's own receipt instead of dispatching again.

`..._ARTIFACT_` is `FEE_REPORT_SOURCE_REVISION_ARTIFACT_` after the runtime
wrapper, and `IB_REVISION_ARTIFACT_` on the artifact capability itself. The
former `ECONOMIC_SOURCE` and generic `SOURCE_CHANGED` artifact codes are
replaced by these stage-qualified codes; the `IB_SOURCE_UNSTABLE`/`STATE`
errors raised by the reader are unchanged. Every suffix is composed only from
the literals above; no response, URL, locator, credential, timestamp, account
value or exception text can enter a code, a log line or an uploaded artifact.

A reason answers "where and why this one run was refused". It is not a repair:
a `PAIR_*`/`FROZEN_*` reason still requires inspecting the economic source
history by the existing manual process, a `LOCAL_*` reason the runner's private
storage, and a transport reason the credential or GitHub status, each outside
the diagnostic. Reproducing the historical failure needs a run under the same
conditions, which this candidate does not perform.

## IB v3 response-envelope evidence (`envelope-evidence-v1`)

Contract `ib-source-revision-20261106-envelope-evidence-v1` is a separate
read-only evidence entry, not a diagnostic, recovery or production admission
and not a repair. It is pinned to the real main `08bb15e` (parent `4d569f5`,
unchanged `index.html` blob) and to its own exact ten-file manifest: the
modified `.github/workflows/fee-cloud-producer.yml`,
`.github/workflows/scripts-check.yml`, `docs/fee-source-revision.md`,
`scripts/fee-ratio-cloud-runtime.mjs`, `scripts/fee-report-producer.mjs`,
`scripts/fee-report-producer.test.mjs`,
`scripts/fee-source-revision-diagnostic.mjs` and `security/approval-tiers.json`,
and the added `scripts/ib-v3-envelope-evidence.mjs` and its test. Its purpose is
`read-only-envelope-evidence`: the diagnostic, recovery and period-budget paths
refuse it, and its admission is never one of theirs.

The dispatch fields `ib_envelope_once` and `ib_envelope_main` select only the
`ib-envelope-evidence` job, under the reserved read-only title
`IB diagnostic 2026-11-06`, so the period budget and the supervisor keep
treating it as no production. Every other job excludes those fields, and every
existing exhaustive dispatch-input check accepts them only while off and blank.
`--check-plan` verifies the signed release, exact manifest and tree, the owner's
exact-head approval comment and the current owner run before WIF. The run step
receives only the existing Sharesight OAuth pair and `FEE_REPORT_ACTIONS_TOKEN`;
`FEE_DATA_KEY`, the economic locator, publication or storage tokens are never
given, and the WIF credential-file paths are blanked for that step. That does
not narrow the existing `fee-cloud-producer` service account: its IAM scope is
unchanged and is not claimed to be smaller.

Two sequential rounds, each exactly: OAuth token; `GET /api/v2/portfolios.json`
(only to resolve the single USD `IB-HK` id; never classified or emitted);
the undated holdings catalog `?consolidated=false`; dated performance for
2026-11-04, 2026-11-05 and 2026-11-06, one day each, with the reader's own
query; trades `start_date=2026-11-05&end_date=2026-11-06`. That is the reader's
own v3 order and query for checkpoint 2026-11-04 to target 2026-11-06; 14
requests at most, no retry, redirect, pagination or route expansion, one
deadline. The two rounds' bodies stay in memory only. The identity must be the
same in both rounds. Any refusal stops the run with a fixed code and step.

Each route is compared between its two rounds in a strict JSON tree that keeps
member order, duplicates and number spelling. Output is fixed literals only:
per route `bytes`, `structure`, `arrayKeying` (`ID`/`POSITION`) and preset
categories (`ROOT`, `ROOT_API_TRANSACTION`, `..._ID`, `..._TIMESTAMP`,
`..._OTHER`, `ROOT_LINKS`, `ROOT_LINKS_SELF`, `ROOT_LINKS_OTHER`, `ROOT_PAGING`,
`ROOT_OTHER`, `BODY`, `BODY_ROWSET`, `BODY_API_TRANSACTION`, `BODY_LINKS`,
`BODY_CATALOG_UNCONSUMED` and the `BODY_*` field groups ending in `BODY_OTHER`),
each with JSON types and changes (`VALUE`, `TYPE`, `ADDED`, `REMOVED`, `ORDER`,
`MEMBER_ORDER`, `DUPLICATE_MEMBER`). No value, id, key name, count, position,
URL, hash or exception text is emitted. A `*_OTHER` category says that an
unlisted member changed, not which one; that boundary is deliberate. The entry
changes no stability rule and authorizes no exception: any later allowance is a
separately reviewed change for explicit key paths only.

"Once" is procedural here as well. The admission binds the exact main, approval
comment, owner actor, event and `run_attempt == 1`; it cannot see another
dispatch on the same main, and no run-history query, lock or store is added.

## One complete recovery batch

The integration is limited to extending the current published source through
the next target date. Same-cutoff historical repair is rejected by this runtime;
ordinary production and previous recovery scopes retain their existing rules.

The legacy v1 recovery gate and its complete attempt/reservation evidence remain
unchanged. The new `ib-source-revision-20261106-sync-v2` admission uses the
owner-approved single-cycle model instead: it verifies the signed release,
exact approved PR tree and owner comment, fixed main, the one current execution
and the current encrypted publication/health hashes. It does not enumerate the
complete Actions history, invent empty attempts or clear old consumption records.
The v2 release is limited to the exact reviewed file manifest and direct signed
successor of `50392c2fb5ec3b1b26e5515cdb0feebb48823d2d`; other versions need their
own review. Contracts with the same target cannot substitute for one another.

Before admission and on every active-context check, a same-target candidate
blocks a new cycle unless its commit is proven to be an ancestor of fixed main.
Changed-parent, old, unsigned or uncertain candidates are not treated as absent.
Malformed or unavailable evidence stops the cycle. A squash-published residual
branch without ancestry proof also remains blocked until it is resolved through
the protected process. The existing publisher still validates its signed
candidate, source receipts, unchanged main and fresh health before promotion.

After exact-head approval and all required checks, this batch must use the
protected squash merge: one signed direct successor of the pinned main, whose
tree exactly equals the approved head. A two-parent merge, changed base or
additional commit is deliberately not an executable recovery release.

The artifact adapter authenticates the current and earlier original encrypted
data/health pairs, successful original producer logs and their incorporation
into protected main. A candidate SHA or a self-reported success flag alone is
insufficient. Both payloads still pass the original receipt, IB, owner-baseline
and month-lock checks. Existing legacy-source guards remain mandatory; an
embedded copy cannot stand in for a required independent original.

The runtime then binds the original source bytes, economic revision, actual
recovery admission and one bounded IB read to the historical revision
algorithm. Only its instance-bound candidate may enter the private writer
handoff. The handoff retains the superseded and accepted-anchor evidence and
the revision provenance inside encrypted report data. The writer validates the
previous IB bundle and replacement before applying it; fees, original dates,
cash/position checks and month locks are not relaxed. Only the final period
step may consume the handoff. Main, source bytes, economic version and admission
are rechecked before exposing a candidate for the existing protected publisher.

## Bank-wire compatibility and separately bound recovery candidate

The proposed `ib-source-revision-20261106-sync-v3` uses the same single-cycle
model and revision-plan v2 schema. Its only eligible release is the signed,
owner-approved squash successor of
`b218f264c53e914d6469ec9f43824f48ccb7af18` (whose parent is
`4f98318c73d1727d323febdcc72b7d5fbfb77f01`), with the exact ten-file manifest in
`fee-report-producer.mjs` and the unchanged UI blob. The actual merged SHA,
approved head/tree, target and current execution must be read and bound at run
time; none can be filled with a synthetic success claim. Old v1/v2 admissions,
diagnostic scope and consumption records retain their original bindings.

The shared Jenny reader recognizes one bounded synchronization memo grammar for
an unlinked, positive, native USD bank-wire deposit. Two broker-account strings,
two dates and both amounts must agree exactly with each other and the verified
source business date and native-currency cents. Invalid dates, extra content,
control characters, mismatched amount/account, linked trades/payouts, foreign
identifiers and repeated wire keys remain rejected. A note claiming this wire
format but failing its strict grammar is rejected even if it contains a legacy
external-flow keyword. No cash tolerance, date translation, balancing entry or
Sharesight change is introduced.

This is a recorded-memo compatibility rule, not independent verification of a
bank statement or broker wire. The portfolio/cash identity gates still establish
account scope. The same reader is used for normal validation, synchronization
capture and historical revision; frozen evidence preserves its original bytes.
The available saved input reproduces the old memo rejection, but it does not
prove that the failed cloud run used byte-identical input or that no later
validation will fail.

This local candidate neither runs a report nor grants execution. Public code
upload and its exact signed version require the existing protected review. A
subsequent explicitly authorized cycle must recheck the current publication,
pending candidates, authentic historical originals, stable three-account source
and economic version. It uses the existing protected identity and publisher.
Report and historical-revision evidence are encrypted for the original public
repository; anyone can retain the ciphertext and it cannot be reliably recalled.
Plaintext, keys and temporary source files are not public outputs and must be
cleaned up. Failure stops; uncertain dispatch/publication results are checked
before another cycle. No old run, diagnostic capability or consumption record is
reset or reused. No workflow, IAM, secret, schedule, retry setting or cloud image
change is part of this batch.

## Single-cycle operation and authorization

A confirmed synchronization entry validates the real owner dispatch, exact main,
closed accounting/source day and source range. It reads only its known current
run, not an Actions run collection or an attempt count. Before private access it
rechecks main, publication hashes and pending candidates. Ordinary schedules and
legacy recovery scopes retain their prior history rules; cron is unchanged.

One explicit dispatch starts one cycle through the existing workflow concurrency
group. Already-published targets exit. Failure stops, with existing claims and
records preserved. After diagnosis and a fix, the operator may approve a new
explicit dispatch for a new cycle. The first cloud confirmation's immutable
intent is never deleted or reused. Unknown POST, publication or candidate results
must be resolved before a new dispatch; elapsed time is not evidence of failure.

Concurrency serializes executions but does not itself reject two explicitly
queued requests after a clean failure with no candidate. The operator must send
one request and resolve its outcome before approving the next one. This change
adds no persistent lock, database, permission, automatic retry or account write.
It removes a complete-history dependency, not authentication or source checks.

The code diff and final signed version still require protected review. An actual
cycle requires its own applicable execution authorization, source evidence and
historical original reads. Local tests and code approval do not establish that a
report was generated or published. Fee publication and authenticated readback
must succeed before the separately authorized ratio update proceeds.

## Synchronization completion is a separate missing input

The existing manual synchronization combines Native, browser and MCP actions.
Its HTTP audit, a cash-only check, a chat summary or a successful writer task
does not prove a complete three-account synchronization. The final evidence
must come from actual tool results covering holdings, every cash currency,
trades/funds events, unresolved tasks, pagination and post-write readback for
the same cycle and cutoff.

The current producer can perform the original deterministic validation without
such a receipt. Skipping that work requires a real, trusted receipt and the
exact frozen inputs validated by it; neither has been inferred from an agent's
`complete` flag. Historical source fingerprints and limited closing snapshots
cannot reconstruct a full earlier acceptance digest. The newly proposed
all-history digest rule is stronger than the original producer's bounded checks;
it is not a reason to invent evidence or rebuild a full-history audit system.
A separate finalizer revision should bind the authentic published base, the
original validators' explicit historical scope and actual current-cycle
completion evidence. It must retain their cash, position, date, late-change and
duplicate guards, and must not claim to have checked history outside that scope.
This recovery batch does not silently change the synchronization schema.

For the present external synchronization tools, no authorized transport into
Actions has yet been verified. Existing cash-result/state objects have narrower
account and business scopes. Reusing an existing private bucket would still
require approval for the specific cycle/object purpose, uploader identity,
create-only/no-overwrite access, producer read/cleanup access, generation and
SHA binding, expiry and cleanup. No such permission or storage change is made
by this batch. Today's bounded fee recovery can proceed independently after
its own approval and checks; it does not certify that synchronization receipt
automation is enabled.

## Historical revision candidate

`createIbSourceRevisionPreparer` accepts three dependencies bound by reviewed
coordinator code: `verifyAcceptedArtifacts`, `readStable`, and `checkCurrent`.
They must never be selected or implemented by request JSON. A clock can be
injected for synthetic tests. `prepare({currentPayload, anchorPayload, plan})`
returns a private candidate, not a revised full fee report.

Let U be a genuine previously published complete checkpoint, P the current
published source cutoff and T the proposed target. The candidate requires
U < P <= T and at most nine calendar days including U. U cannot be manufactured
by truncating current history, copying only NAV, editing a balance or resetting
the owner-confirmed baseline.

The legacy exact `fee-console.ib-source-revision-plan.v1` contains:

- `anchorDate`, `targetDate`, `baselineSha256` and both source-state IDs;
- `currentArtifact` and `anchorArtifact`, each containing raw encrypted-data
  SHA-256, health-file SHA-256, producer run ID and candidate commit SHA;
- `bindings`: reviewed main, economic revision, consumption-record hash,
  current data/health hashes and current source-state ID;
- `expiresAt` as an exact UTC timestamp. It is a reviewed limit, not a grant of
  read, decryption, execution-budget or publication authority.

The new `fee-console.ib-source-revision-plan.v2` replaces only the consumption
hash binding with `admissionModel: sync-cycle-v1` and `executionSha256`. The latter
binds the authenticated release (including exact owner comment), complete plan,
current run identity/attempt and encrypted publication/health hashes. Mixing v1
consumption fields with v2 execution fields is rejected. No private source
values or credentials are added to public metadata. The artifact adapter still
requires the known original successful producer runs and logs as historical
provenance; those bounded reads are distinct from a complete run-list query.

The current artifact and state must match their binding fields. Both stored
source states, return receipts and drawdown receipts are rebuilt using the
existing validators. Identity, owner baseline, coverage, all NAV and flows
through U, applicable normalization proofs and overlapping closing snapshots
must agree. Proofs that straddle U are rejected rather than discarded.

`verifyAcceptedArtifacts` must use authenticated evidence to verify both raw
published artifacts, their decoded payload association and the accepted history
link between them. Returning the expected hashes or a self-authored `verified`
flag does not prove any of these facts. The integration's real adapter must
also verify the original fee month-lock digests with the
existing `preserveReportMonthLocks` function and the corresponding economic
inputs; the local candidate checks lock shape/range and unchanged IB return
periods/factors, not the complete fee-lock digest by itself.

`checkCurrent` must freshly obtain the bound versions, before and after the
bounded source read. It must not echo values from the plan. A change refuses
the candidate. The unchanged `SharesightIbManagerReader.readStable` is called
once from U through T; it performs its original independent captures and full
anchor, native-currency, flow, duplicate, payout and position checks. No balance
tolerance, fabricated flow, date shift or unknown-flow exception is added.

The replacement bundle is rebuilt by `buildIbManagerReportBundle`. The envelope
retains the superseded bundle, accepted anchor, artifact references, target,
checked time and a content digest. `changedHistoricalDates` lists changes in
retained NAV, net external flow or overlapping closing snapshots; it is not an
audit of every raw transaction. A net-neutral provenance-only revision may be
conservatively refused as `NO_HISTORICAL_CHANGE`.

The result always has `publicationReady: false` and `executionAuthorized: false`.
It contains private source material and must never be logged, attached to a
public PR or passed to an external model. `oldArtifactsPreserved: true` describes
this module's non-mutating behavior; the caller still owns authenticated
archival retention. Only fixed allowlisted error codes may leave the private
boundary. Payload copying rejects accessors, proxies, custom prototypes, cycles
and oversized JSON. Expiry, clock monotonicity and request immutability are
checked again after the asynchronous candidate digest.

Same-cutoff repair (`T = P`) and extension (`T > P`) are explicitly different.
An extension cannot stamp old fee data with T. Any eventual full-report writer
must retain the existing fee/source/return/drawdown common-cutoff checks, fee
month locks, single-writer protection, budget, provenance and readback checks.
This minimal candidate refuses historical changes across a locked month.

An actual unchanged U, its archived original evidence, the trusted adapters,
bounded read authorization and a separately approved recovery/publication path
are still required. Unsupported early-valued cash that changes U remains a
refusal. This module does not reset or reuse a consumed recovery opportunity.

## Shared synchronization validator

`createSourceContractValidator` binds a trusted deterministic `validate` function,
its dependency hash, one execution ID, a clock and a bounded lifetime. Its
`validateInputs` method copies and freezes the input before awaiting validation.
Validation must complete and return exactly `true` before a capability exists.

The request binds the complete report plan, actual target/source dates, the
three required source roles, identity/evidence hashes, raw input hash, reviewed
code, current published data/health, IB baseline/checkpoint/coverage/anchor,
economic, benchmark and policy versions. The original report-plan, calendar,
scope and source completeness rules belong in the bound validator. Structural
checks here are not a substitute for those business rules.

`consumeValidatedInputs` accepts only the same factory's opaque WeakMap handle,
same execution and unchanged context. It returns the exact immutable input
seen by the validator; it does not re-execute that deterministic check. Handles
cannot be serialized, recreated from a success flag or reused by another
process. Capture-to-expiry defaults to five minutes and cannot exceed fifteen.
Expiry, clock rollback and any bound dependency change reject reuse. Repeated
consumption is a pure read, not another production or publication permission.

Runtime must retain independently obtained current-version comparisons,
source-change/freshness checks, real accounting and month-end readiness,
same-target atomic deduplication, consumed-operation history, shared publication
serialization, calculation/publication checks and authenticated readback.
The coordinator must stop the old execution when source changes are detected.
This capability does not prove that Sharesight stayed unchanged after capture;
no stable cross-request revision/ETag support has been established here.

The shared module is not yet wired to the synchronization conversation or the
producer. Its composition test uses the actual IB bundle reconstruction, with
synthetic scope for the other roles. It is not a successful three-account run.
A future coordinator can avoid duplicate deterministic validation of identical
frozen input in one execution. Cross-process synchronization and production
cannot trust a text message or serialized handle as a substitute.

## Verification and deployment boundary

Synthetic tests cover late income plus external capital, full-history return
and drawdown rebuilding, preserved old records, invalid/changed anchors,
missing/duplicate/unknown/misdated flows, source instability, lock boundaries,
stale base/ledger/consumption versions, asynchronous mutation/expiry, immutable
errors, hostile JSON and capability forgery. The original IB source and return
regressions run with unchanged public reference files.

Only these five new files form this candidate:

1. `scripts/ib-manager-source-revision.mjs`
2. `scripts/ib-manager-source-revision.test.mjs`
3. `scripts/fee-source-contract.mjs`
4. `scripts/fee-source-contract.test.mjs`
5. `docs/fee-source-revision.md`

Public upload, exact-head review, protected merge, private real-data preparation
and any eventual recovery run remain distinct actions under the repository's
approval rules. Passing synthetic tests or merging these utilities alone does
not establish a successful production repair or automatic start mechanism.

## Cash-site diagnostic binding (`diagnostic-v3`)

This is a local candidate until its exact signed head is approved and protected
checks and merge complete. It identifies a diagnostic information-loss defect,
not the financial cause of the recorded cash-reconciliation failure. The
previously approved diagnostic has finished; this code does not authorize a
second dispatch or reuse its run.

The new `ib-source-revision-20261106-diagnostic-v3` scope is read-only and accepts
only the signed, owner-approved, single-parent squash successor of
`f1d4454d25849e1908ba508f8c7f140389e425bb`, whose own parent is
`22174f04cae8ac18a071930f491598b327e315c5`. Its complete modified-file manifest is:

- `docs/fee-source-revision.md`
- `scripts/fee-report-producer.mjs`
- `scripts/fee-report-producer.test.mjs`
- `scripts/fee-source-revision-diagnostic.mjs`
- `scripts/fee-source-revision-diagnostic.test.mjs`
- `scripts/fee-source-revision-runtime.mjs`
- `scripts/fee-source-revision-runtime.test.mjs`
- `scripts/fee-sync-revision-artifacts.mjs`
- `scripts/fee-sync-revision-artifacts.test.mjs`
- `scripts/ib-manager-source-revision.mjs`
- `scripts/ib-manager-source-revision.test.mjs`

The existing reader records finite `cashSite` and `cashDateRole` values. Revision,
artifact and runtime wrappers now retain them through private WeakMaps. Only the
diagnostic result for an authentic runtime cash-reconciliation error adds these
two fields; unknown provenance produces no added location, while an unclassified
registered error uses `UNCLASSIFIED` / `NONE`. Neither field contains an actual
date, amount, account or exception text. The exported reader error constructor
can itself register a fixed site; identity provenance is not evidence that a
remote account was read. Real execution still uses the pinned native readers
and source verification. Ordinary error codes and production summaries remain
unchanged. Cleanup failure takes precedence and discards location details.

All prior release scopes and consumption records remain unchanged. The target
is still November 6, with source dates November 4–6 and the existing original
encrypted anchors. No workflow, credential, permission, scheduling, ledger or
publishing setting is changed. The diagnostic capability remains unusable by
the production writer. Existing deadlines, first-attempt checks, exact main /
owner-comment rechecks, complete source checks and temporary cleanup remain.

If separately approved after merge, use the existing workflow with only
`ib_diagnostic_once=true` and `ib_diagnostic_main=<exact merged main>`; other
inputs stay empty or false. Send one new dispatch, resolve an uncertain result
before any further action, and stop on failure without rerunning. There is no
persistent cross-dispatch one-shot lock; authorization and the execution audit
must enforce the single approved invocation. No financial plaintext is sent to
Claude or uploaded as an artifact.
