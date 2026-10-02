# Owner-authorized promotional gift management-fee exemption

The encrypted payload may hold `managementExemptionRegistry` and daily
`managementExemptions`. Private enrollment binds the owner instruction, exact
account/portfolio/holding/ticker, first-held date, prospective effective date and
verified initial gift acquisition trade IDs. Actual identifiers and enrollment
files must never enter this repository or PR text.

The rule applies only to promotional gift shares in the enrolled Webull holding.
Other accounts and other holdings of the same ticker retain ordinary fees.
Account NAV, cash/stock/style splits, holdings and historical daily values remain
intact. Only the daily management-fee base changes:

`daily NAV - same-day external flow - verified exempt gift market value`.

Gross profit, gross TWR, Dietz denominator, carry/high-water formula, investor
ownership and recorded payments do not change. Net results change only by the
management fee. Pre-enrollment receipt bytes remain compatible with engine
`fee-v4.6.1`; enrolled receipts use `fee-v4.6.2`. Old-engine receipts cannot bind
exemption inputs. The phone consumes the committed writer receipt and applies
the same registry, daily bounds and input-hash validation.

## Gift evidence and mixed acquisitions

The fixed GET-only reader double-reads complete Webull trade history through the
target date. Pagination fails closed. Confirmed opening/buy/sell history for the
exact enrolled holding must reconcile to its target-day quantity. Initial gift
IDs require zero unit price and gift evidence. Subsequent monthly awards require
the same enrolled identity and the strict source annotation `Webull HK monthly
promotional gifted ...`, matching ticker, quantity and first-of-month award/trade
date, confirmed BUY, zero price, zero consideration and zero brokerage. Generic
gift comments cannot automatically extend the rule. Evidence flags are
attestations from the controlled reader, not a new broker authentication method.

Paid or unproved acquisitions remain chargeable. Sales consume exempt shares
first, conservatively preventing paid lots from inheriting an exemption without
broker lot-selection proof. Exempt value is remaining verified gift quantity
divided by total holding quantity, times target-day market value, rounded to
cents. Closed holdings have an explicit zero exemption. Unknown corporate
actions or unreconciled quantities block output pending source review.

## Private enrollment and deployment

Supply `FEE_MANAGEMENT_INPUT_FILE` as an absolute path outside the repository in
a mode-0700 directory, with a mode-0600 file. Source keys are `schemaVersion`,
`date`, `holdings`, `trades`, `historyComplete` and optional `proposals`. All
identifiers stay private. Style preflight also validates exemption inputs
without writing. The writer rechecks source bytes before no-op or atomic output.
Activated registries require complete current inputs on every normal run;
missing evidence cannot silently restore charges or reuse stale values. Weekend
carry copies the previous verified exemption with the other daily values.

The effective date is an explicit enrollment input, not a date inferred from
the day this repair runs or the next unpublished target. Review the complete
gift acquisition/sale history against the published fee window before selecting
it. A zero gift position throughout that window proves zero prior management
fee impact; it needs no historical settlement adjustment. If any earlier fee
day contained gift shares, historical valuation and the owner's treatment of
that charge must be reviewed before activation. The first-held date and policy
scope remain audit evidence. Never silently alter settled fees, payments or
refunds. After the encrypted enrollment candidate passes ordinary
promotion gates, the cloud reader reuses its private registry with fresh source
evidence; there is no public ticker exemption list or new credential/permission.

Unresolved/unconfirmed-flow and economic-source gates still apply. Passing gift
preflight or an AUM write is not a passing fee receipt or publication claim.
