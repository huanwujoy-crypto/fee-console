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

## Fee calculation receipt

Management fee, Carry and fee-adjusted performance have one authoritative
calculation path. Before publishing any of those values:

1. Read the encrypted `fee-console-db.json` Gist twice and require the same remote
   revision/ETag plus byte-identical encrypted v4 content. Keep the verified
   snapshot in a temporary file outside the repository and expose only its
   absolute path through `FEE_ECON_FILE`. The scripts' two local file reads do not
   replace this remote-stability check.
2. Run `scripts/daily.mjs` with the existing `FEE_DATA_KEY`. The writer must build
   `feeCalculationReceipt` from the candidate daily data and the transient private
   snapshot before its no-op decision.
3. Run `scripts/fee-receipt-report.mjs` against that same still-current private
   snapshot and quote only its validated receipt output. Delete the temporary
   encrypted snapshot when the run finishes.

Never calculate these values independently in the Scheduled task. In particular:

- never use a start/end or endpoint average as the management-fee base;
- never use Modified Dietz as the management-fee base;
- never apply a manual denominator override;
- never calculate Carry from a flow that has not passed the immutable-identity
  de-duplication contract.

If an external flow is unresolved, the encrypted private snapshot is unavailable,
the receipt is missing, or any receipt validation fails, fail closed. Raw read-only
AUM/source status may still be reported, but management fee, Carry, paid/due and
fee-adjusted return must say `calculation receipt pending` and contain no estimated
figure. Never place `FEE_DATA_KEY`, the private Gist id, full input hashes, or
decrypted economic input in GitHub Actions, repository files, command arguments,
notifications, Pages metadata, task output, release tags or logs. v1 does not make
benchmark calculations part of the receipt; describe them as public-ledger values.
