# Inactive daily action delivery candidate

The current producer invokes the legacy report job and promotes an anonymous
summary. It does not update `xuan-ib/action.enc.json`. A successful one-off
private recovery is not evidence that the clocks can deliver to the phone.

This candidate adds `cloud/xuan-preopen/action_daily.mjs`: a bounded composition
of the existing report generator, independent source/model admission, private
CAS/pinned GET, and encrypted-report handoff. Importing it does nothing. It has
no CLI, scheduler, credential discovery, browser automation, source reader,
broker synchronization, GitHub writer, auto-merge or default encryption provider.
Existing workflows remain off/unchanged except for an offline test invocation.
Production activation is **not** completed by merging this candidate.

## Source contract

`prepareDailyActionInput({snapshots, ordersCapture}, {now})` accepts captured
browser wrappers in the existing `SHARESIGHT_REFERENCE_DATE_BASIS` format.
Snapshots are keyed by `sharesight.ibGroupedPerformance`,
`sharesight.schwabPerformance` and `sharesight.webullPerformance`. All three
are required and bound to the existing registered portfolio identities. A
fourth concentration account, unknown key, duplicate/mislabelled identity,
unreconciled row sum or unbound classification fails before any write.

Each observation preserves its actual capture/read time, displayed valuation
date, row values and unknown native cash/price dates. Reads must be on the
report's Hong Kong day; valuation dates can differ and be up to seven calendar
days earlier. Prior verified classification supplies instrument/category
identity only; it never supplies replacement prices, quantities or balances.
The previously approved premise that manual broker-to-Sharesight sync is
complete remains a disclosed premise, not an independent reconciliation claim.

`sharesight.noahPerformance` is optional and must be supplied explicitly. Its
existing cash-reference treatment is preserved if present, including the
isolated detail/total difference. If absent, it is recorded as **not called**;
the NOAH cash and dependent combined budget stay unknown. It never enters the
three-account concentration denominator. This is not a change to pool NOAH's
cash into the three brokers, nor permission to read another portfolio.

`ordersCapture` accepts only one `ib.orders` observation from the existing
cloud/Mac read-only MCP capture contract. Holdings, cash and executed records
are not re-read from IB. Omission means unknown coverage, not zero orders.
Hash, account-evidence and timestamp checks run before staging. Existing
remaining-quantity/limit-price, coverage and 30-minute checks are reused by the
model and independent publisher admission; the final commit gate also checks
the orders deadline. Stale supplied orders do not fund a current net budget.
No source call or OAuth refresh is performed by this module.

## Inactive runtime boundary

`createDailyActionPipeline(capabilities).run({runId, approvedHead, input})`
requires all of these separately approved capabilities, with no fallback:

1. `admitRun` verifies the actual exact approved code head, run ID, date, input
   hash and allowed operation scope. Its returned record is a consistency
   binding, **not** an authorization proof supplied by a caller.
2. `claimDaily` atomically creates the durable `action-day/YYYY-MM-DD` claim.
   A second 13:10 attempt, another process or an uncertain claim stops. The
   in-process guard is acquired before the first await. `checkpoint` durably
   records each evidence-write, CAS and encryption attempt before it starts.
3. `savePrivateCreateOnly` stages only the seven fixed evidence names under a
   fresh report-check UUID plus the two normal date-specific delivery objects.
   There are at most nine writes and 32 MiB. Real storage generations/hashes
   are required. The delivery copy keeps concentration pinned to the original
   source-evidence prefix. A failed/uncertain object is not automatically
   overwritten, re-uploaded or resumed.
4. Existing protected storage/context providers independently reread immutable
   sources and reconstruct the actual report. `prepareCommit` retains the
   exact checkout, current IAM/audience and canary gates. The original private
   target and CAS policy remain unchanged. No bypass token or asserted
   `approved=true` can replace these providers.
5. Only `published-verified` with an independent fixed-generation GET reaches
   encryption. Those exact display bytes and the fixed-readback receipt are
   passed to an explicitly approved `encryptFixed` implementation of the
   existing `packagePublishedAction`. Private readback failure, CAS conflict,
   no-op or unknown write stops; it never consumes a second CAS automatically.
6. The result is `ciphertext-review-required`, containing only the encrypted
   file candidate for `xuan-ib/action.enc.json`. No branch, merge or Pages run
   is created. After the ordinary exact-head protected publication process,
   `verifyDailyActionDelivery` checks successful deployment metadata against
   the approved ciphertext head and byte-for-byte public ciphertext hash at
   the fixed URL. This pure check requires authentic controller-provided
   deployment/readback evidence; it cannot authenticate arbitrary JSON.

Runtime adapters for the new durable claim, write journal and approved
encryption provider are intentionally **not installed or provisioned** here.
The existing cloud job/SDK must not be assumed to implement this interface.
No opaque callback is presented as a verified production identity or browser
connection. The head checker must bind this module as a protected source.

## Encryption and publication boundary

The existing HKDF/AES-GCM format and fee application's key/storage are unchanged.
No actual key is read, copied, created or used in this candidate. Synthetic tests
bind `encryptFixed` directly to the existing codec with a dummy key and decrypt
only synthetic reports. Merely parsing a returned envelope cannot prove its
plaintext binding; the separately reviewed encryption provider is a trusted
boundary. Real acceptance must verify that provider and user-side unlock.

A public ciphertext copy can be downloaded by anyone and decrypted by holders
of the fee master. The original seven IAM identities protect only the private
report. HKDF separates purpose but does not isolate either application from a
leaked master or same-origin script compromise. Automatic key use, persistent
access or moving a key into a new environment requires its own concrete scope;
this PR grants none. The user-click browser conversion remains available.

Current policy requires OWNER approval of each ciphertext head. Consequently
this handoff still pauses for review; unattended daily public delivery cannot
be promised without a separately reviewed publication delegation. Do not
silently reuse an old OWNER comment, run nonce, recovery registry or CAS budget.

## One activation proposal to settle before real execution

- Freeze this code head against the then-current main; complete normal
  sensitive OWNER approval and required checks. Do not conflate draft CI or
  local tests with permission to merge or operate.
- Decide the supplied/read source scope: three Sharesight portfolios after
  manual sync; NOAH only if explicitly included; one IB orders observation.
  Choose the supported read-only adapter and separately bound refresh limits.
- Review the actual runtime binding for head admission, daily durable claim,
  private evidence and existing seven-reader boundary. Name any image/job
  change and build count after inspecting the chosen runtime; no zero-build
  promise is made. No broker-sync schedule is to be started.
- Choose a supported encryption environment and precise key-use grant, or
  keep user-click conversion. Approve public ciphertext exposure and decide
  whether each ciphertext remains an OWNER-reviewed PR. There is no implied
  permission for a new Secret, identity, IAM role or persistent key access.
- Approve a priced, bounded acceptance run: fresh run ID, sources/refreshes,
  at most nine report evidence writes/32 MiB (orders-provider receipts must be
  budgeted separately), one private CAS, one ciphertext candidate and exact
  public readback. Reconcile uncertain outcomes before any separately approved
  recovery; do not reset the daily claim.
- Only after actual source completeness, protected private readback and phone
  unlock are demonstrated, approve the specific daily schedule. Historical
  13:00/13:10 HKT clocks are not enabled by this change. Weekly remains paused.

Offline tests exercise actual generation, independent admission/reconstruction,
single CAS, independent pinned GET, real synthetic encryption/decryption and
public-byte verification, plus missing accounts/NOAH/orders, stale orders,
claim duplication, denial, interruptions and old public bytes. They prove code
compatibility with injected synthetic storage, not current live source access,
cloud credentials, budget, key availability, deployed Pages or unattended
phone delivery. Financial numbers, fees, accounting and production ciphertext
are not changed by preparation of this candidate.
