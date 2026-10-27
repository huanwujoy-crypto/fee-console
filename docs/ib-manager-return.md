# Independent IB manager returns

IB is a separate manager. It never joins the managed Schwab + Webull
composite, opening capital, fee basis, investor shares or cash-flow ledger.
The frozen offline contract remains supported. The optional normal-report reader
uses only existing Sharesight client access. No new credential, grant, Secret,
scheduler, broker synchronization or financial write is added.

`scripts/ib-manager-return.mjs` accepts a private
`fee-console.ib-manager-return-input.v1` object with exactly these keys:
`schema`, `currency: USD`, `timezone: America/New_York`, `flowTiming: eod`,
`flowsComplete: true`, `correctionsConfirmed: true`, `sourceSha256`, and
`periodReturnsInput`. The latter carries the existing engine's exact inputs:
`points: [{d,tot}]`, `openT`, `from`, `to`, `days`, `flowByDate`,
`rate: 0`, `cr: 0`, `cumBefore: 0`, `hwmBefore: 0`.

Every calendar day's full-account USD EOD valuation is required, with an
independently proved opening valuation. Signed external cash and securities
flows use their confirmed source business dates and EOD USD valuation. Trade
cash, income and FX translation are not external capital. Corrections must be
audited in the private source before input; the producer never infers missing
flows or revises Sharesight. True confirmations are necessary but do not by
themselves prove the source complete: retain the original private audit.

The producer calls `fee-engine.mjs:periodReturns` once per calendar month,
rounds each gross TWR to ppm, then chains those rounded monthly outputs exactly
as the existing fee receipt does. It does not calculate IB fees. Only dates,
returns, source commitments and receipt integrity metadata enter the separate
`ibManagerReturnReceipt`; raw NAV, positions, flow values and identifiers do not.
The receipt remains inside the existing encrypted data payload. It is not an
independent signature; the trusted writer, authenticated encryption and protected
publication are the trust boundary.

The independent `ibManagerDrawdownReceipt` adds a complete daily path without
changing the monthly-return v1 contract. It contains dated, unrounded gross TWR
factors, the previous-day opening anchor, and commitments to the matching return
receipt and source input. The producer uses the exact `grossTwrDailyFactor`
helper called by `periodReturns`; no raw NAV, flow value or account ID is included.
Daily factors must reproduce every original monthly ppm result. Missing dates,
invalid factors, broken commitments or unequal fee periods fail closed.

The UI applies the existing drawdown episode function to this path, including
the opening anchor, peak/trough dates, decline days and recovery days. The path
is clipped to the same independently verified benchmark end as the other rows.
Cash withdrawals and in-kind transfers are external flows, never a mechanical
drawdown. Old monthly-only receipts remain valid for returns but cannot invent
a daily path or a maximum drawdown. The new attachment candidate adds both IB
receipts and preserves every other field and the original ciphertext.

Broker-to-Sharesight synchronization is separate from fee-report source reads.
The independent adapter never joins the managed account allowlist or reuses a
one-time run. The user's manual synchronization is not assumed complete, and
confirmed frozen history cannot be relabelled as a later target date.

## Optional normal-report read (disabled until protected activation)

`ib-manager-source.mjs` resolves exactly one USD `IB-HK` portfolio visible to the
existing runtime client. Its access to IB has **not** been established by offline
tests or the separately signed-in browser. Missing/ambiguous access fails closed;
there is no credential discovery, fallback identity or permission expansion.
Only authentication plus fixed portfolio, dated performance, holdings, cash and
trade GET routes are allowed. Responses, sizes and waits are bounded. Both full
reads must agree. Raw identifiers and responses never enter public diagnostics.

`IB_MANAGER_READ_ENABLED=true` and `IB_MANAGER_BASELINE_SHA256` are nonsecret
configuration names, not created or enabled by this code change. The latter is
the canonical USD-cent business-input hash produced by `ibBaselineBusinessHash`
from the already confirmed private history. This commitment is not an assertion
of extra valuation precision. The commitment normalizes cents;
executable source inputs must already be canonical cents so subcent differences
cannot hide behind a matching hash and change the engine's return. Frozen v1
inputs and receipts remain unchanged.
The approved baseline window is
2026-08-01 through 2026-10-23, with the preceding EOD opening. No real NAV, flow,
return or private baseline hash is embedded in the public source. A native first read
must reproduce that entire baseline. It does **not** silently apply historical
corrections to Sharesight or shift automatic event dates. If manually synchronized
source history still differs from the audit, `BASELINE_MISMATCH`/`DATE_ALIGNMENT`
remains pending and the discrepancy needs review, not a new JSON Secret.

Bootstrap reads at most 101 calendar points (opening included); subsequent reads
use the authenticated private checkpoint and at most nine calendar points. A gap
above that limit stops the IB path. Stored historical inputs remain frozen;
each incremental opening NAV and portfolio identity must still agree. Older
source revisions require an explicit re-audit; the daily read is not a full
historical recertification. Current holdings, target cash, every cash delta and
ledger balance chain must reconcile. Linked trade/income cash is internal;
unambiguous deposits/withdrawals with explicit owner/external-capital descriptions
are external. An unlinked deposit type alone is insufficient. Unknown automatic movements,
non-USD movements, unsupported assets/currencies and new unverified in-kind
transfers stop IB rather than inventing returns or flow valuations. Future holding-quantity changes must match dated cash-settled buys/sells; an
unsupported split or unrecorded security transfer also stops the IB path. Source timestamp and New York business date must agree; no guessed one-day adjustment.
These conservative limitations can leave pending even with valid source access.

`ib-manager-report.mjs` creates a bounded 0600 request in the existing private
runtime directory. `daily.mjs --ib-manager-input` is a **normal writer** option,
not the offline attachment mode. After original fee calculation it adds the v2
return receipt, bound daily drawdown receipt and authenticated-encrypted source
checkpoint. All original fee fields are preserved. Failures retain the prior
checkpoint for retry but set a pending source status; the browser suppresses
old values even for the same target date. A v2 receipt requires the matching
verified source status. IB-only updates count as changes; identical verified
inputs remain a byte no-op. The old `--ib-return-only` Actions refusal remains.

The existing scheduled producer, Environment `fee-cloud-producer`, encryption,
Validate → Promote → Pages and exact-head OWNER protections remain in force.
When enabled, already-published fee health alone cannot certify IB. The local
future-period candidate adds one bounded same-period recheck, described below;
it does not run an unlimited daily retry or expose IB status in public health.
No schedule, Actions permission or Secret mapping is added. Neither workflow
dispatch nor immediate production is part of offline preparation. Activation
requires reviewed protected code, confirmed completion of manual synchronization,
the baseline digest configuration and the next original scheduled report.
Existing client access must suffice; if it does not, stop and report it.

Success needs real source reconciliation, matching private receipts, new encrypted
candidate validation, protected publication and an unlocked same-period UI check.
Synthetic tests do not establish any of those live acceptance conditions.
In particular, cash-ledger evidence alone cannot value a noncash transfer.
The independent noncash contract below can use a source-native historical event
only when its quantity, dated mark, zero settlement and complete audited business
commitment agree. It cannot fix an obsolete source business date by itself.
Unreconstructable history deliberately remains pending; no current-holdings guess
or new private bootstrap channel is introduced.

## Noncash evidence and bounded historical correction

`ib-manager-noncash.mjs` is pure source-evidence math. During the confirmed
baseline only, the normal reader may propose a confirmed zero-price, zero-value,
zero-brokerage sale with an exact dated holding-quantity decrease. Portfolio,
holding and instrument identities must agree; other same-day trades or nonzero
linked cash settlement refuse the proof. A strictly positive same-day remaining
position supplies its USD unit mark only when exact decimal quantity and market
value determine an unambiguous USD-cent price. A zero remaining position is not
a price quote; neither yesterday's price nor today's holdings may substitute.

The resulting `fee-console.ib-manager-noncash-proof.v1` is explicitly
`audited-baseline-source-native`. It is not a signature or an authorization.
The entire reconstructed historical business input must still equal the existing
audited baseline commitment before any receipt can be built. A zero-price sale
or transfer comment alone never authorizes a flow. Future transfers remain outside
that historical authority; the candidate below defines a separate typed proof.
Source proofs and separate cash
flows reconcile exactly to the engine's combined external-flow inputs; duplicate
trade proofs are refused. Raw identifiers/quantities remain inside the existing
authenticated encrypted checkpoint, not public source or browser receipts.

The separate `buildIbNoncashCorrectionCandidate` pure helper implements the
already established mathematical convention without embedding private dates,
quantity or price: remove transferred quantity times each historical daily mark
from the confirmed effective date up to, but excluding, the source-recorded date;
add one EOD external outflow at the effective date and none at the recorded date.
Every window date and mark is required. The helper refuses an already-counted
recorded-day flow. It returns an **unattached private-audit candidate**, never a
receipt. No normal reader, CLI, browser import or producer calls it. Its result
is not accepted as a native-source proof.

Attaching a private date correction needs separately reviewed authenticated
evidence carriage. Existing owner confirmation need not be repeated, but its
dates/amounts cannot be published as code, inferred by searching hashes, or
placed in a new JSON Secret. A future encrypted baseline delivery would require
its own explicit workflow approval; none is added or executed here.

Cash business-day and FX conventions remain separate source requirements. Match
automatic cash to authoritative linked trade/payout business dates and native
currency evidence; never apply a blanket day shift. Preserve the private audit's
existing valuation-precision/FX-approximation limitations in any eventual seeded
baseline. A business-input hash match does not upgrade valuation precision.
The present strict cash reader can still refuse such historical inconsistencies
or unsupported non-USD movements. Noncash support therefore does not establish
real-source coverage, source grant, full bootstrap or deployment readiness.

## Explicit offline preparation

After reviewing the complete code and private input, the existing trusted
operator may run the daily writer with only `--ib-return-only`, an absolute
`--file` pointing to the existing encrypted v3 daily payload, and an absolute
`--ib-return-input` pointing to the private input. This defaults to a dry run.
It uses the already provisioned `FEE_DATA_KEY` environment; never supply a key
as an argument or retrieve one for an agent. No financial data is printed.

Actual candidate preparation additionally requires `--execute` and an absolute
`--ib-return-output` naming a new file outside the checkout. The original daily
file is never overwritten. Inputs are double-read; private input must be a
regular non-symlink file outside the checkout with mode 0600. GitHub Actions is
refused. The writer validates the original composite receipt, requires identical
start/asOf, preserves all other payload fields, encrypts and verifies a new
0600 candidate. Existing fee calculation inputs and receipt remain unchanged.

Preparing ciphertext does not publish it. Before the existing protected data
publication path is used, the operator must validate this exact new ciphertext
against the same current private economic source with the existing fee reporter,
verify IB against its private audit, retain the frozen candidate hash, and
recheck main/source stability. No publication gate is weakened or replaced.

The browser copies the reviewed receipt-consumer factory verbatim and consumes
only an integrity-valid receipt whose start/asOf and every monthly boundary
match the verified composite receipt. Zero and negative returns are valid.
Absent, malformed, tampered, future/stale or mismatched data shows pending with
no percentage. A validated history labels its own asOf and explicitly states
that subsequent dates are not automatically connected. A verified v2 source
labels its own date and source verification. A later composite date or failed
current source suppresses stale IB comparisons.

## Local verification

### Future-period local candidate — not activated

No financial read, Keychain use, variable write, dispatch or source write is
performed for these fixtures. The original frozen receipt and all historical
correction precision remain unchanged. `buildIbOwnerBaseline` reconstructs both
original return/drawdown receipts, requiring exact equality before adding the
owner-confirmed input to `ibManagerBaselineState`. A digest is integrity, not
human approval. The historical exception is never called native Sharesight data.

The reviewed `finalize-ratio` candidate carries optional
`ibBootstrap:{baseline,coverage}` through the existing private files and encrypted
payload. The sole writer refuses replacement of an existing native checkpoint.
No new JSON Secret, persistent private channel or independent ledger is added.
See `docs/fee-ratio-management.md` for actual route and its unactivated safeguards.

Coverage-v1 remains a finite legacy contract. New coverage-v2 includes a bounded
Sharesight source audit, dates, exact noncash events and any dated source quotes.
The first source-v3 read must cover its exact through date; the audit is retained
without rewriting it. Once verified, later native checkpoints append daily
history, validating opening NAV AND positions/cash against stored snapshots.
Each read is double-captured and reconciles dated performance, cash and trades.
At most eight missing calendar days plus opening are accepted at one time.
An unsupported/ambiguous source, old prefix change or unknown transfer fails IB
only. No blind removal of the old date cutoff or weekly blanket flow assertion.

Native typed TRANSFER_OUT must show exact quantity reduction with zero cash
settlement. A zero-value SELL needs the separately reviewed Sharesight audit
match; comments alone are insufficient. Full disposal needs an actual dated
Sharesight instrument mark, including a validated audit quote if applicable;
missing historical rows/quotes cannot be filled from current holdings, guessed
prices or broker/Flex/mail. A provider label/hash alone does not prove provenance.
Real source currency/date/full-outflow/absence contracts remain unverified.

The weekly/monthly optional reread is bounded: at most two producer runs from the
fixed plan schedule, at most twelve hours after checkedAt, original 36-hour and
four-day windows, and no earlier pending candidate. Overlapping runs consume the
budget conservatively; metadata uncertainty suppresses retry. A reread preserves
all fee, benchmark, month-lock and publication metadata, except the sole writer’s
updatedAt timestamp and explicit IB fields. Refreshed health does not reset count.

Before activation: exact signed support/UI approval; real existing-client scope
and complete Sharesight transfer/quote/date acceptance; reviewed private bootstrap
and manager recipient; genuine fresh producer health/code identity; protected
cipher promotion and normal manager/investor read-back. No real execution or
switch change is authorized by a source schema or synthetic test.

Run `node --test scripts/ib-manager-return.test.mjs scripts/ib-manager-source.test.mjs scripts/ib-manager-noncash.test.mjs`.
All inputs and keys in these tests are synthetic. UI stays index-only; local
UI overlay testing never changes production or its protection policy.
