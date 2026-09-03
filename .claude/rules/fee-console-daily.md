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
   revision/ETag plus byte-identical encrypted v4 content. The only v3 exception
   is the explicit copy-only `fee-console.legacy-empty-expense.v1` policy in
   `docs/fee-econ-v3-copy.md`: read that runbook and the receipt runbook first,
   validate the original source identity independently, and make a new encrypted
   v4 computation copy without changing the original Gist. Keep the verified
   snapshot in a temporary file outside the repository and expose only its
   absolute path through `FEE_ECON_FILE`. The scripts' two local file reads do not
   replace this remote-stability check.
   In legacy mode, retain the original encrypted snapshot as `FEE_ECON_V3_FILE`
   for both tools. They re-authenticate preserved source bytes, strict projection
   and fee partition; source-file checks are still not remote freshness proof.
   Re-read the authorized Gist on every run and again before publication. Do not
   turn a previous manual attachment into a permanent economic source.
2. Run `scripts/daily.mjs` with the existing `FEE_DATA_KEY`. The writer must build
   `feeCalculationReceipt` from the candidate daily data and the transient private
   snapshot before its no-op decision.
3. Run `scripts/fee-receipt-report.mjs` against that same still-current private
   snapshot and quote only its validated receipt output. Delete the temporary
   encrypted snapshot when the run finishes.

Native v4 receipts remain v1. The approved legacy copy requires receipt v2 with
the exact policy ID and commitments to exact original envelope and payload bytes,
even with zero legacy rows. Do not substitute canonical/migrated JSON. Full
source records stay only in encrypted provenance; source bindings stay only in
encrypted receipts. Deploy both approved scripts and index-only consumer before
real v2 acceptance. Unknown receipt versions fail closed. On the phone a missing,
changed or unsupported raw v3 source must hide fees; the original v3 stays
read-only. A writer run without economic input removes a legacy v2 receipt even
when public AUM is unchanged. Never infer no real expenses/payments from an empty
legacy row or from a snapshot containing no payment records.

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
decrypted economic input in GitHub Actions, plaintext repository content, command
arguments, notifications, Pages metadata, task output, release tags or logs.
The sole existing storage exception for receipt hashes is **inside the AES-GCM
ciphertext** of `data.json`, whose outer JSON has only `enc`, `v`, and `data`.
No input hash or legacy binding may appear as a plaintext outer field. The full
private ledger/provenance is never copied into `data.json`, even encrypted.
v1 does not make
benchmark calculations part of the receipt; describe them as public-ledger values.
