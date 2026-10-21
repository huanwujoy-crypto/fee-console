# Sharesight book action report

The action report assumes broker-to-Sharesight synchronization is complete at
owner direction. This is a calculation assumption, never independent broker
reconciliation evidence. Holdings/classification/concentration are IB-HK;
book cash is IB-HK plus NOAH-HK. CALL remains 50% of the current owner record.
Open orders remain a separate IB source. No ledger, fee, reader, identity,
schedule, OAuth, or permission change is introduced.

The private model displays the pre-order book estimate independently of the
net estimate. Complete order coverage and supported currency matching are
required for the existing remaining-quantity BUY reserve and net planning.
Unknown orders/currencies are not zero; SELL proceeds are not anticipated.
Cash is a book USD-equivalent, potentially including non-USD cash, cash
substitutes, or historical conversions, not executable USD buying power.

Direct concentration covers all IB-HK holding rows and uses whole-portfolio
book value including cash as denominator. It is separate from the existing
four-class stock denominator; it does not expand into other brokers or ETF
issuer look-through. Unsupported rows/totals disable concentration only.

## Already captured browser input

`composePrivateActionPreview` accepts an injected `snapshotReader` and the
original earliest `captureStartedAt`. Supplying that reader bypasses its
legacy API reader entirely. The adapter performs no browser/network reads.
The controller supplies each fixed portfolio's authenticated browser observation
as `raw: {mode: 'read_only', source: SHARESIGHT_BROWSER_SOURCE, observation,
classification}`. `observation` contains portfolio alias, selected valuation
and original retrieval dates, USD reporting total, positions (instrument,
price/currency, quantity, displayed USD value, holding path, nullable price
metadata), and cash (cash-account path, native currency/balance, USD value).
Current supported table observations have `priceDate: null`; a selected report
date is not a per-instrument price update time. Use displayed values, never
quantity times rounded table prices, for portfolio arithmetic.

The optional classification is an existing saved IB-HK Sharesight grouped
snapshot. Its raw hash, scope and date are checked. Only classification labels
and identity are reused, on exact holding ID, symbol, market and currency;
new positions are not guessed. The original classification date is displayed.
Its balances, quantities and prices are never substituted for browser values.
Without a matching class, direct concentration/cash can still be available.
Browser origins and original observation times remain explicit. No API or
completed-sync provenance is fabricated.

Existing four immutable source objects, source/model reproduction, canonical
HTML, exact-head approval, live protected-source comparison, five-minute capture
and thirty-minute candidate age checks, private audience and one-attempt CAS
remain in force. Ready book reports can be admitted without an executable-budget
claim; legacy reports retain their existing validation. The adapter stays inside the existing source module and trusted archive; this
change does not build or run an image.

This source change does not activate a browser automation, daily schedule,
financial source call, or publication. A captured browser input still needs its
normal protected source receipt and a current IB order result or explicit
missing-order outcome before a newly authorized publication attempt.
