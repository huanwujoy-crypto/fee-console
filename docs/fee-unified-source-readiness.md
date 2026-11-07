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
   plan for that purpose. This code neither obtains keys nor decrypts data.
3. `readCurrentContext` must freshly check the current sources and all bound code,
   base, economic, benchmark and policy versions before preparation, after
   validation and before report consumption. It must not return the old expected
   context. No source ETag or stable cross-request revision guarantee has been
   established, so unchanged remote sources still require actual evidence.

These adapters are supplied by reviewed integration code, never request JSON.
The tests use explicit synthetic authentication substitutes. Passing them does
not establish a working production authentication or conversation transport.

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
