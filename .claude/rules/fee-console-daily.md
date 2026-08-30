# Fee-console daily AUM contract

This rule applies only to fee-console daily AUM runs. It does not apply to
XUAN-IB handover publication. XUAN-IB runs instead follow
`.claude/rules/xuan-ib-handover.md`; never combine the two write contracts.

Before any scheduled, Run now, recovery, or manual fee-console daily AUM run
computes values or writes `data.json`, it must read and obey:

- `docs/daily-data-contract.md`
- `claude/fee-style-mapping.json`

Do not guess growth/value classifications from a ticker or company name. Use
the versioned `(portfolioId, holdingId)` mapping and fail closed on unknown or
duplicate holdings.

Do not publish the first Sharesight response. Read the same dated source until
two consecutive results are stable, record the completed read time and source
fingerprint, then run the same-date replacement and trusted publication path
defined by the data contract. If the source is still changing, stop without
writing.

Financial systems remain read-only. Never place, modify, or cancel orders, and
never initiate transfers or write to IB, Sharesight, or another financial
account.
