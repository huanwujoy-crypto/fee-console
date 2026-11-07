# Shared synchronization and report preparation

This change is a local integration candidate. It does not enable a producer,
add a trigger, authorize another report, revise an accepted report, or connect
the synchronization conversation to a persistent production transport.

## One source, separate date meanings

Sharesight remains the account-data authority. Capture the complete official
responses with their actual GET paths, query dates and original UTF-8 JSON.
Do not reconstruct raw JSON from parsed numbers. The source projection compares
every holding quantity, each native cash currency and linked events rather than
only portfolio totals. It preserves trade dates, payout dates and cash timestamps
individually. A timestamp prefix is not proof of its business date. Original
source validators still resolve the applicable date and linkage for each event.

A completion message, HTTP success, two stable reads, a matching NAV, an empty
task queue or an AI opinion cannot establish that all three accounts completed
synchronization. Unresolved synchronization items must stop preparation. Claude
may review non-sensitive code and synthetic examples; its prose is not an
executable acceptance receipt.

## Capturing and reusing the original validators

Both source readers provide `readStableWithEvidence` with their original stable
read arguments. This is an explicit source read, under the same existing source
authorization; constructing or consuming a captured result never starts it
implicitly. The returned original object contains the original validated input
and two complete, separately bound GET capture batches. Authentication requests,
headers and token responses do not enter the capture. The evidence is private
and stays in memory. It must not appear in public logs, PRs or external-model
prompts.

`verifyCapturedRead` recognizes only the original frozen object from that reader
instance. `consumeCapturedRead` also checks the original business parameters and
configuration, including the IB baseline/checkpoint and the two-account source
mode. A serialized copy or different read context is refused. This local memory
capability is independent of the persisted production claim and run budget.

`projectCapturedSharesightAccount` calls the original reader's capture verifier,
then matches exact source routes, query windows and account identities. It does
not fabricate a missing payout pointer or turn a historical anchor into a target
snapshot. The projection hash binds the selected raw responses; the separate
full capture hash binds all source evidence, including catalogs, earlier daily
points and indirectly linked payouts.
The validated-input hash also binds the original reader's actual calculation
result. Raw GET bytes alone do not bind benchmark values or normalization policy
inputs. Both hashes must match the authenticated synchronization receipt and the
fresh current-context calculation.

`prepareIbManagerReportInput` is the original IB preparation logic with explicit
dependencies and no filesystem or credential discovery. The existing private
file wrapper calls this same function. Its history, coverage, source, return and
drawdown checks, pending errors and private-file protections remain in place.

## Synchronization-cycle handoff

The reviewed coordinator can call `createCapturedSyncCycle(...).prepare(...)`
after obtaining the authorized original captures. The coordinator validates the
real report plan and readiness, builds the three source projections, and invokes
`createUnifiedSourceReadiness`. Its final original-validator step consumes the
already checked captures and uses the same IB preparation function. It does not
read the account again. A successful result contains only a private closure
`consumeForReport()`, which returns the same frozen prepared inputs while the
version and expiry checks still pass. It is not a public success flag, report,
publication receipt or execution permission. A failed cycle is not retried.

This initial coordinator is deliberately restricted to one ordinary trading-day
report and one final IB capture. It rejects multi-day recovery, bootstrap and
month-end plans instead of silently reusing a single day's input for them. The
original producer's full period and month-end paths remain unchanged; this
coordinator must not replace them until their complete input ranges are wired
and separately verified. Historical recovery remains a separate reviewed path.

Three mandatory adapters remain the trusted boundary:

1. `verifySynchronization` must authenticate the actual final synchronization
   receipt for this cycle, with complete status and no unresolved items for all
   three accounts. It must bind the actual source projections and full capture
   hashes and validated-input hashes. It cannot manufacture completion from the
   proposed input itself.
2. `verifyPublishedBase` must associate the already authorized decrypted payload
   with the bound original encrypted data/health and accepted history. An echoed
   request hash is not authentication. The same adapter must verify the selected
   benchmark against the bound authentic benchmark artifact and confirm the
   applicable source/policy configuration; it receives the benchmark, target and
   plan for that purpose. The readiness core never obtains keys or decrypts data;
   the published-base adapter below requires its authorized runtime to supply
   an existing in-memory key and authentic economic-source capability.
3. `readCurrentContext` must freshly check the current sources and all bound code,
   base, economic, benchmark and policy versions before preparation, after
   validation and before report consumption. It must not return the old expected
   context. No source ETag or stable cross-request revision guarantee has been
   established, so unchanged remote sources still require actual evidence.

These adapters are supplied by reviewed integration code, never request JSON.
The tests use explicit synthetic authentication substitutes. Passing them does
not establish a working production authentication or conversation transport.

### Local adapter implementation and remaining authority

The adapter work preserves the original health-file bytes instead of hashing a
reserialized JSON object. Published-base verification must derive the data,
health and benchmark bindings from their actual fixed-commit bytes, decrypt only
inside the existing authorized process, and run the original fee and IB receipt
validators. It has no default transport or credential discovery. A caller must
not substitute an untrusted HTTP callback for the reviewed GitHub transport.

`createPublishedBaseVerifier` accepts only fixed-repository GET routes through
that explicit transport. It verifies the actual main commit's signed owner
identity and exact Git blob bytes. The benchmark cache retains its existing
fixed-ref and blob validation path; its existing Actions bot commits are not
misrepresented as owner-signed commits. Historical health is checked using its
original time, not relabeled as a new completion receipt. The historical base
must precede the target, stay within the existing bounded period and fit the
ordinary daily path. Missing trading days require the separate recovery path.

An authentic old base is not permission to capture new account inputs. The
original IB history and coverage preconditions must pass before any real capture;
their rejection must leave the source-read count at zero. A legacy-v2 embedded
copy still needs the independent original-source guard. Until that guard has an
authorized authentic input, this adapter refuses that case rather than treating
the embedded copy as its own proof. These boundaries are tested with synthetic
artifacts and do not establish compatibility with an uninspected live baseline.

The economic snapshot's version binding identifies the actual stable encrypted
bytes, revision and ETag at acquisition. It does not claim that the remote source
is still current. The original `checkCurrent` operation remains necessary; a
failed or changed source must not leave a reusable current-version capability.
Only the original module's private snapshot identity can release encrypted bytes
for an authorized in-memory validation. A similarly shaped object cannot do so.

Captured Sharesight source freshness is distinct from repeating business
reconciliation. A same-instance current check reads only the GET routes and query
parameters privately recorded during the original validated capture and compares
the complete original responses. It neither changes the captured date nor
recomputes the financial result or restores a consumed handle. Source changes or
failed verification invalidate reuse. A successful check only proves what was
observed during that bounded read; it is not a promise that an external platform
can never change after the check.

None of these helpers authenticates a three-account synchronization conclusion.
The existing IB daily comparison explicitly excludes historical-ledger
verification and does not cover the other two accounts. Its completion state
cannot be promoted into a full synchronization receipt. Likewise, a journal that
only tracks one writer's processed trades cannot establish all historical
changes made through another writer or the website.

Before activation, identify the actual synchronization executor revision,
generating identity, fixed private receipt location and existing read permission.
The final receipt must cover all three accounts and bind the same capture and
validated-input hashes. Historical evidence needs a genuine accepted boundary
and evidence covering all relevant historical changes. A continuous,
authenticated change record is one route; a complete official historical read
compared with an authentic, equivalently scoped accepted snapshot is another.
The latter can detect changes made through other writers without a new permanent
journal, but cannot reconstruct edits that were later undone. Existing reader
captures do not automatically prove complete historical or closed-position
coverage. Neither a missing journal nor a missing accepted snapshot is an empty
history. Two digests newly computed from today's data cannot manufacture a past
acceptance. A change affecting an accepted date pauses ordinary preparation for
the separate historical-review path. No local synthetic fixture, hash, text
assertion or new storage path supplies that missing authority.

## History and publication remain separate

Changed accepted historical semantic digests stop ordinary preparation. This
path never automatically rebases history or invokes the revision preparer. A
late genuine event retains its true source date and needs the separately reviewed
historical-revision path, with an unchanged accepted anchor and retained original
reports. Moving it to the synchronization date is not a repair.

The normal writer remains the only report writer. Before a real report it must
still enforce same-target atomic deduplication, existing run budgets and consumed
records, month-end accounting close, economic inputs and month locks. Publication
still requires source/calculation receipts, shared single-writer serialization
and authenticated readback. Fees must publish and pass readback before a later
ratio update; this candidate adds neither publication path.

The existing two-account `sharesight-reference` interpretation and its explicit
warnings are preserved. It is not silently changed into legacy cash-history
reconstruction. Native-currency synchronization matching does not waive unknown
flows, duplicates or original financial validation.

## Remaining production acceptance

After exact-version review and protected merge, the synchronization executor
and producer still need a reviewed, authenticated handoff using existing
permissions where sufficient. A new persistent credential or wider private
storage access must not be inferred from this implementation. Cross-process
callers cannot serialize the in-memory capability; they must verify the frozen
evidence again under their own trusted boundary.

Actual acceptance requires a real complete synchronization cycle, current-source
checks and one separately authorized production/publication attempt. The current
failed report is not retried by importing these modules, passing tests or merging
this candidate. Previous consumed attempts and artifacts remain unchanged.
