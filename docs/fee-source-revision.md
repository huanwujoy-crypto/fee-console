# Historical source revisions and shared validation

Status: local integration candidate; not approved for production execution.
The historical algorithm below remains separate from admission. The proposed
integration uses the existing protected producer, authenticated published
artifacts and original writer; it does not edit the economic book, change a
schedule or reset any claim/consumption record. Code approval and an actual
one-time recovery authorization remain separate prerequisites.

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
