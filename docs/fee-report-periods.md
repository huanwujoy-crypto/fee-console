# Fee report periods

This candidate changes publication cadence, not the economic contract. It is
inactive until signed review, exact-head OWNER approval and protected merge.
The existing stop-daily gate remains active on main during preparation.
Scheduled activation additionally requires the non-secret repository variable
`FEE_REPORT_PERIODS_ENABLED=true`. It is not created or enabled by this PR.
Leave it absent/false until the separately reviewed historical preview, source
checks and protected publication read-back pass. Manual dispatch retains its
explicit default-false `run_reviewed_once` gate and does not enable a schedule.

## Dates and source coverage

- Weekly: Saturday is available for manual synchronization; the first attempt
  is Sunday 00:00 Asia/Hong_Kong. The accounting cutoff is Friday and the stock
  price cutoff is that week's last reviewed NYSE session. A Friday holiday does
  not turn Thursday's quote into a Friday quote.
- Monthly: D is the month's last reviewed NYSE session. D+1 is available for
  synchronization; the first attempt is D+2 at HKT midnight, never earlier than
  the next natural month. The accounting cutoff is the month's last calendar
  day, independently of the last price day. If that day has not ended in New
  York, the public gate waits. It does not weaken the existing health clock.
- The public calendar/publication gate has HKT 00:00, 01:00, 08:00 and 13:00
  slots. It enters no financial environment when no period is due, a candidate
  is pending, the accounting day is incomplete, or that exact coverage is already
  published. This is not four financial reports per day.
- Weekly and monthly plans with the same accounting and price cutoffs combine
  into one report. An additional natural accounting day with the same stock
  quote is a different cutoff and keeps its genuine fee day.
- Unsupported calendar years, missing same-session SPY/QQQ quotes, source gaps,
  unstable reads and expired recovery/promotion windows fail closed. Calendar
  dates match the existing reviewed NYSE calendar for every supported day.

## Daily calculations, final month and presentation

`fee-report-producer.mjs` captures the whole bounded calendar-date range twice
before writing. Every date uses actual dated Sharesight valuation, native cash,
transactions and existing flow/income rules. Closed-session benchmark prices
carry only with positive reviewed-calendar evidence and never repeat dividends.
Account NAV is never interpolated from a Friday or a current holdings screen.

One frozen revision of the existing encrypted economic source is used throughout.
The original `daily.mjs` remains the sole writer. It rebuilds each daily point,
TWR chain, natural-day fee basis, high-water and receipt in a private temporary
candidate. There is no intermediate public report. Source changes or any failed
daily step discard the entire candidate. Original data and the economic book
remain untouched.

Final monthly reports lock their completed fee periods, semantic daily values,
automatic flow identities and applicable economic inputs inside authenticated
encrypted data. A later change fails with `FEE_REPORT_LOCKED_MONTH_CHANGED`;
it is not silently overwritten or corrected. Fee payment records remain
independent of those accrual locks. Corrections require separate review.

Report metadata is inside the encrypted payload, bound to the validated fee
receipt: weekly/monthly/combined type, report period, price cutoff, accounting
cutoff, generation time, next scheduled period and non-real-time status. Missing
or mismatched metadata is displayed as pending. Existing weekly coverage may
remain valid between reports; new candidate promotion still uses the unchanged
fresh-health and target-age checks.

The investor calculation and economic event history stay daily. Chart and table
presentation select inception, Fridays, calendar month ends and latest proved
date. Change between snapshots subtracts all intervening subscriptions and share
transfers. It does not compare a weekly difference with just one day's cash flow.

## Account and evidence boundaries

Schwab-HK + Webull remain the fee composite. Jenny's IB is an independent gross
TWR and drawdown assessment only. It never changes fee principal, management
rates, Carry, payment amounts, investor shares or original benchmarks.

Manual synchronization completion is per account and per captured period. A
stable Sharesight response does not prove that an externally reported migration
has been recorded. Until later IB source coverage is attested, normal IB handoff
is held at the existing audited baseline cutoff with
`IB_SOURCE_COVERAGE_UNVERIFIED`. Original composite production can continue.
Post-cutoff transfers cannot enter an earlier historical report. Payout date,
settlement date and actual cash-credit date remain distinct under existing income
date evidence; no sync or duplicate payout write is performed by this candidate.

The previously confirmed private IB historical correction remains valid. The
strict native source may still differ from it or lack linked noncash evidence.
Code tests do not establish a matching real baseline, provision an environment
variable or privately attach that history. No new JSON Secret, private storage
channel, browser import, credential, source write or seed workflow is introduced.
Real independent values may replace pending only after a valid source/return/
drawdown bundle is actually encrypted, protected, published and unlocked for
read-back. See `ib-manager-return.md` for the remaining evidence-carriage boundary.

## One reviewed historical preview

The normal path can prepare an explicitly selected weekly or month-end target:

```
node scripts/fee-report-producer.mjs --mode=preflight --report-kind=weekly --report-target=YYYY-MM-DD
```

This preflight reads only public main publication evidence. A production dispatch
requires `run_reviewed_once=true`, an agreed kind and accounting target, the final
protected source code and the existing trusted environment. Do not reuse an old
request or execute it during code preparation. No key is passed in arguments.
An encrypted ledger already ahead of the requested historical cutoff is refused;
current holdings are never used to roll it backwards or impersonate history.
The original signed two-file candidate and trusted promotion remain mandatory.
