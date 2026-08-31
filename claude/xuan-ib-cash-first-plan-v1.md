# Cash-first allocation planning (user confirmed 2026-08-31)

Existing cash is the primary funding source. Sale timing is uncertain, so
existing holdings are a secondary source only after proceeds become available.
This is report-only planning, never financial execution authority.

## Current approval: three directions, USSC reference 10% (2026-08-31)

The user approved the joint Claude/Codex recommendation to replenish EXUS,
EIMI and a smaller USSC amount together. Allocate 10% of the cash-planning
budget to USSC, then recalculate the remaining two directions as described
below. This supersedes the earlier “USSC only after sale proceeds” rule for
this reference scenario. It is NOT a 10% portfolio weight, permanent strategic
target, trade instruction, or a promise of superior returns. Cash availability
must still be verified. Future sale proceeds remain secondary and require a
new snapshot/recalculation, never an assumed funding source.

## Unchanged scope and targets

All inputs are verified USD/base-currency values. The four-class denominator
is equity-only (not NAV and not the four-bucket family denominator). Existing
US-base / technology / non-US developed / emerging-market reference targets
remain 45% / 20% / 23% / 12%. USSC remains a subset of US-base, not a fifth
class. The 45% reference is not a newly imposed hard cap. The older USSC 14%
structural reference has an unverified denominator: do not use it to derive
the cash allocation or silently turn it into an equity-weight target.

## Deterministic model and display

Use `scripts/xuan-ib-cash-plan.mjs`, not hand-calculated narrative. Supply
schemaVersion=2, status=snapshot, currency=USD, denominator=equity-only,
sourceAsOfHkt, equityTotal, developed, emerging, usBase, ussc, ibCash, noahCash,
reserve and usscBudgetShare=0.10. Reconcile USSC within US-base exactly once.
All amounts must derive from the same reconciled report snapshot. Preserve
input provenance and the actual data time. Never copy the historical repair's
numbers into a new report. If required source data is unverified, render only
`{"schemaVersion":2,"status":"unavailable"}`; keep other report fields.
Historical schemaVersion=1 remains supported for immutable audit fixtures,
not normal new reports. A trusted version-2 report cannot be downgraded to
version 1, including after an explicit unavailable fallback. The inert
transport marker remains `xuan-ib-cash-plan-v1`; the input schema is version 2.

Planning budget=max(0,IB cash+NOAH-HK cash-reserve). Do not include unexecuted
sales, defensive securities, margin or unconfirmed transfers. If budget is
positive, set z=roundToCents(0.10*budget) for USSC. Then solve the nonnegative
two-class system x_i=max(0,p_i*(T+z+sum(x))-V_i), using the active set for
developed/emerging. The extra z must enter the denominator before solving;
do NOT just take 90% of the old EXUS/EIMI amounts. Scale the resulting full
two-class allocations by (budget-z)/fullNeed when cash is insufficient,
round one allocation to cents and give the residual cent balance to the
other. All three amounts must sum exactly to the budget. This is a disclosed
planning scenario, not a newly discovered v9.6 rule. Static gaps use the old
denominator and are not cash-buy amounts; the old 107.50% is not a buy-only
funding ratio. If remaining cash (budget-z) exceeds the two-class need, both classes have no gap,
or scaling would buy an already overweight class that remains overweight,
show unavailable/policy review and retain funds; this approval does not
invent spending rules for those cases. Zero budget produces no allocations.
Display current and post-scenario weights, remaining cash-buy need, and the original
data time. US-base post-weight is (usBase+z)/(T+actualSpend); USSC post-weight
is (ussc+z)/(T+actualSpend). Continuing EXUS/EIMI cash buys enlarges the
denominator again: solve the residual need rather than showing static gaps.
Do not claim all four classes reach their targets, or that 10% still fits
the 45% reference when a smaller executable budget is substituted. Recompute
the entire scenario with the newly verified budget; do not reuse old amounts.

Render the module's exact kpi, detail and template once each. Put the KPI in
the original cash-gap card, the detail first in Configuration, and the inert
input comment in the report (canonical base64url JSON; no extra HTML template).
Put overweight observations in closed details.
Use code-first short labels: EXUS｜非美发达, EIMI｜新兴市场, and
USSC｜美国小盘价值. Show all three cash-planning amounts; USSC's budget share
is explicitly 10%, distinct from portfolio weight. Remove conflicting old
statements that USSC cannot use this cash pool or must wait for sale proceeds.
Weights and 23% / 12% targets describe the entire developed (EXUS + VCN) and
emerging (EIMI + INDA) classes, not either individual ETF.
Keep the small overview card concise: codes and amounts, a short
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

## Approved three-direction migration (2026-08-31; current)

The previous two sections are historical source-bound migrations only. The
current approval uses:
`node scripts/xuan-ib-cash-plan-correction.mjs --three-way INPUT.html`
with trusted source 23fb2c54630314fada37135869eb519c61d0e0b5 and HTML blob
e5e34415c896e900bb30a3b03c32942b89133231 only. It retains every verified raw
input, adding US-base 2,006,230 and its USSC subset 15,216 from that exact
source's holding rows, then updates only planning outputs, the canonical
input and narrowly conflicting funding/explanation text. The raw holdings,
cash balances, financial source tables, classification evidence, decisions,
receipts, edition/date and data time are unchanged. It visibly discloses
that this is a policy-scenario recalculation, NOT newly fetched market data.

For this snapshot the planning ceiling is 584,291.33; USSC 58,429.13;
EXUS 417,141.04; EIMI 108,721.16 USD. Recomputed US-base weight is 44.60%,
developed 18.84%, emerging 11.36%, and USSC 1.59% of the equity denominator.
Further cash-only developed/emerging replenishment needs 341,794.41 USD.
These amounts are acceptance fixtures, never fresh report input defaults.

Use the unchanged ordinary single-file Claude candidate, date window,
validation, promotion and Pages path. No direct latest/meta write, new AM/PM
success evidence, records-update exception or financial execution. If the
trusted publication has advanced, stop instead of overwriting the new report.
