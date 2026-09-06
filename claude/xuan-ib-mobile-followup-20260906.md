# Owner changes, 2026-09-06

## Display

Keep >=1% daily-change groups; sort each by descending USD market value (null
last, stable ties). Move market value second, preserving currencies and source
dates. Native Usage Guide belongs at the old manual-report button location;
the manual report remains retired. 常青基金 is a display alias for evergreen,
not a bucket ID or mapping change.

Retire rotation-trigger analysis: do not collect extra inputs or evaluate
lag/valuation/momentum conditions for this feature. The compatibility `rotation`
input is now an order-reminder container only. Preserve existing orders, limits,
ages and sourced reminder flags; never infer a new cancellation from ordering.
Reminders are not recommendations or execution instructions. Old signed report
bytes remain immutable; the trusted loader can suppress the retired feature in
its verified display while retaining the source report unchanged.

### Mobile order reading (owner follow-up)

Use distinct 买单 and 卖单 sections, with explicit direction labels as well as
different colors. The verified loader renders existing order tables as narrow
screen cards: quantity, limit, signed distance, 已挂天数 and source status.
Each side remains sorted by absolute distance, nearest first, stable ties and
unavailable quotes last. Do not infer order age, missing quotes or cancellation
flags. Preserve quantity/price precision, currency when supplied, source dates,
and the original signed report/decision receipts. This display migration does
not create a new report, execute an order, or change report-generation cadence.

### Mobile allocation reading (owner follow-up)

Keep specific EXUS/EIMI/USSC cash amounts and sourced current/after/reference
percentages visible in compact cards. USSC's 10% is a cash-budget share, never
a permanent portfolio target. Show portfolio names and exact USD values as
compact rows; move full IB NAV/source differences and other remarks to the
configuration report notes. No recomputation or assumed funding settlement.

Move only the non-actionable, unverified immediate-buying-power row into the
execution-before-use notes. Keep the planning-only label visible. Reading this
report does not itself require owner action; actual order execution still needs
available-balance, pending-order and transfer-settlement checks. Missing planning
amounts or other actionable warnings must remain visible. Hide the cancelled
feature/history entry from the current interface without deleting source records.

## Classification authority

The owner explicitly approves Webull AAOI standard T1, low/mid/high 60/80/100%,
and delegates similar evidence-supported tier assignments under existing
coefficients. Read `xuan-ib-classification-delegation-v1.json`. This is separate
from the immutable earlier MRVL policy file. Live Sharesight identity read on
2026-09-06 matched the exact portfolio, holding and instrument identity in the
policy. Holdings listing proves identity, NOT current value or quantities.

For a new ordinary classification: verify portfolio+holding+instrument identity,
record business/source evidence, assign only an existing supported tier,
calculate with the applicable dated USD value and SAME-scope denominator, and
emit one stable classification notification per policy revision. Do not add a
routine classification to awaiting_user. If evidence is insufficient, retain
an explicit data-quality exception and do not guess. Methodology/coefficient
changes, trades, cancellations, transfers, financial-account writes and wider
account scope are not delegated. Archive past decisions/receipts without rewriting
their history. AAOI's existing pending decision needs a normal receipt bound to
the current trusted report; this file alone does not manufacture that receipt.

## ETF and weekly readiness

The 2026-09-01 baseline already exists in the approved open schema3 summary,
complete through 2026-09-03. Show that chart/table; do not claim newer daily
calculations. The historical archive reads the approved summary from its same
pinned promoted commit at build time, without runtime fetch or private inputs.

A Monday cadence is not proof of fresh four-bucket values. The existing weekly
pilot has metadata only; durable financial snapshot production and scheduled
consumption still need operational evidence. Historical 08-31 classification
coverage passed for 95 rows; do not relabel that as an unresolved mapping gap.
New snapshots still require current identity, values and coverage verification.
Keep old snapshot date and unavailable metrics honest until those gates pass.
