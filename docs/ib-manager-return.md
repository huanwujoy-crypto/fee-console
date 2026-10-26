# Independent IB manager returns

IB is a separate, frozen history. It never joins the managed Schwab + Webull
composite, opening capital, fee basis, investor shares or cash-flow ledger.
No source API, credential store, scheduler or financial write is added.

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
that subsequent dates are not automatically connected. Normal daily runs do
not refresh IB; a later composite date suppresses stale IB comparisons.

## Local verification

Run `node --test scripts/ib-manager-return.test.mjs`. All fixtures, keys and
files in this suite are synthetic. The complete UI contract can be tested
locally with the existing absolute `FEE_LEDGER_TEST_INDEX` override; CI must
use its own checkout. Producer/tests are a separate protected support change;
the final UI change remains index-only under the existing UI guard.
