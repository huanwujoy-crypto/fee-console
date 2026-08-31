# Cash-first allocation planning (user confirmed 2026-08-31)

Existing cash is the primary funding source. Sale timing is uncertain, so
existing holdings are a secondary source only after proceeds become available.
This is report-only planning, never financial execution authority.

## Unchanged scope and targets

All inputs are verified USD/base-currency values. The four-class denominator
is equity-only (not NAV and not the four-bucket family denominator). Existing
non-US developed / emerging-market targets remain 23% / 12%; existing EXUS /
EIMI directions remain references, not new orders. No risk threshold changes.

## Deterministic model and display

Use `scripts/xuan-ib-cash-plan.mjs`, not hand-calculated narrative. Supply
schemaVersion=1, status=snapshot, currency=USD, denominator=equity-only,
sourceAsOfHkt, equityTotal, developed, emerging, ibCash, noahCash, reserve.
All amounts must derive from the same reconciled report snapshot. Preserve
input provenance and the actual data time. Never copy the historical repair's
numbers into a new report. If required source data is unverified, render only
`{"schemaVersion":1,"status":"unavailable"}`; keep other report fields.

For each funded class i, solve x_i=max(0,p_i*(T+sum(x))-V_i), using the nonnegative
active set. With both classes below target, total new cash required is
sum(p_i*T-V_i)/(1-sum(p_i)). Static gaps use the old denominator and are not
cash-buy amounts. Do not call the old 107.50% coverage a buy-only funding ratio.

Planning budget=max(0,IB cash+NOAH-HK cash-reserve). Do not include unexecuted
sales, defensive securities, margin or unconfirmed transfers. If budget is
below the full two-class need, scale both full allocations by one common
budget/fullNeed ratio. This is a disclosed planning scenario, not a newly
discovered v9.6 rule. If budget exceeds the need, retain the surplus.
If scaling a full plan would buy an already overweight class while it remains
overweight, render unavailable and seek a separate policy review rather than
silently inventing a new priority rule.
Display current and post-scenario weights, remaining cash-buy need, and the original
data time. Do not claim the other two equity classes also reach their targets.

Render the module's exact kpi, detail and template once each. Put the KPI in
the original cash-gap card, the detail first in Configuration, and the inert
input comment in the report (canonical base64url JSON; no extra HTML template).
Put overweight observations in closed details.
Use code-first short labels: EXUS｜非美发达, EIMI｜新兴市场, and
USSC｜美国小盘价值. The first two remain the only cash-funded directions.
Show USSC alongside them as “待回款后重算”, funded secondarily by available
proceeds from the existing US-base replacement policy, not this cash budget.
Do not add a USSC amount, buy target, denominator or trading instruction.
Weights and 23% / 12% targets describe the entire developed (EXUS + VCN) and
emerging (EIMI + INDA) classes, not either individual ETF.
Keep the small overview card concise: codes and amounts, USSC status, a short
remaining-need line, and “详见「配置」”. Short Chinese names and category/funding
explanations belong in Configuration; detailed methodology stays folded.
The trusted guard checks rendered amounts against the input comment. It is
not a substitute for source reconciliation. After initial rollout, later
reports cannot remove the plan silently; unavailable is an explicit fallback.
Fully verified receipt-only records-updates may preserve the previous body.

## Cash availability is not an assumption

The combined cash pool is a planning ceiling, NOT IB immediate buying power.
Show actual executable budget as “待核实” unless independently verified after
reserve location, settlement, currency, transfers and existing orders. Do not
invent a 226,322.41 IB usable figure by assuming all reserve is held at IB.
Pending-cancel orders are not cancelled; don't release their cash or subtract
nominal order values twice when broker availability may already reflect them.
After actual fills/transfers/price changes, refresh positions and recompute.
No share quantities, limit prices, trades, order changes or transfers result.

## One approved snapshot repair

The current 2026-08-31 source a585bf13a2eb5d2a32f5f074edc91f41749dca3a,
HTML blob 4987cbb9e1c10a3a5562247784d9fc8a7e575a17, contains the proven static-gap
mislabel. `scripts/xuan-ib-cash-plan-correction.mjs` repairs only that exact
blob. It recomputes planning values but preserves raw holdings/cash, edition,
dates/as-of, all source tables, classification disclosure, decision cards and
receipt bytes. It must never overwrite a later report.

This user-requested formula/display repair is an ordinary single-file Claude
publication candidate, not a new data fetch or records-update. Keep the prior
edition/date/as-of and visibly disclose snapshot recalculation. It supplies no
new AM/PM success evidence and gets no stale-date exception. Normal reports
still require the established live reads. Validation/promotion/Pages and all
permission boundaries stay unchanged.

## Approved ticker-first presentation update (2026-08-31)

The user approved code-first labels and visible secondary USSC funding, with
all cash allocations unchanged. Run
`node scripts/xuan-ib-cash-plan-correction.mjs --ticker-first INPUT.html`
only on the trusted source 12922932bcc89af59c363855f12e86aa48c2c390, HTML blob
2091098e98933e121b9fbdbbfd63771287d9e11c. The helper changes only the two
canonical cash-plan display blocks and one notice inside report explanations.
It reads the existing canonical inputs, preserving their exact bytes, all
amounts/calculation results, source times, edition/date and complete receipts.
This display-only update requires no financial reads, is not a records-update
or a new AM/PM report, and uses the unchanged ordinary single-file Claude
candidate, date window, validation, promotion and Pages publication path.
If the trusted source has advanced, stop; never overwrite it with this snapshot.
Regular reports must use the new renderer with their own verified fresh inputs.
