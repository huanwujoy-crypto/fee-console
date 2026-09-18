# Fee-console daily AUM contract

This rule applies only to fee-console daily AUM runs. It does not apply to
XUAN-IB handover publication. XUAN-IB runs instead follow
`.claude/rules/xuan-ib-handover.md`; never combine the two write contracts.

Before any scheduled, Run now, recovery, or manual fee-console daily AUM run
computes values or writes `data.json`, it must read and obey:

- `docs/daily-data-contract.md`
- `claude/fee-style-mapping.json`
- `docs/fee-style-registry.md`
- `docs/fee-economic-source.md`

Use the reviewed static mapping plus the encrypted append-only classification
registry, bound to `(portfolioId, holdingId, ticker)`. Every new producer run
must prepare `FEE_STYLE_INPUT_FILE`, run `--style-preflight`, resolve missing
rows with evidence and independent Codex/Claude review under Wu's delegated
classification authority, then run the actual writer without manual style
totals. Follow the registry runbook for post-publication one-time notification.
Do not guess from a ticker/name, default unknown positions to growth, or silently
reuse an old split. Codex owns unresolved technical exceptions; do not create
another per-stock user decision. Financial execution remains out of scope.

Do not publish the first Sharesight response. Read the same dated source until
two consecutive results are stable, record the completed read time and source
fingerprint, then run the same-date replacement and trusted publication path
defined by the data contract. If the source is still changing, stop without
writing.

Every run must finish through the amount-free health-receipt contract in
`docs/daily-data-contract.md` section 6.1. After style preflight, the writer and
the calculation-receipt read-back all succeed against the same still-current
private snapshot, use `scripts/fee-data-health.mjs create-success` to bind the
actual account source dates, actual benchmark source date and final encrypted
`data.json` bytes. Commit `data.json` plus `fee-data-health.json` for `updated`;
commit only `fee-data-health.json` for a verified `no-op`. On failure, emit only
an allowlisted fixed code with `create-failure`; never promote it. Do not make
an empty commit, invent a source date, or place amounts or raw errors in the
health receipt. The independent GitHub watchdog, not the Routine itself, owns
detection of a Routine that never started.

Read SPY/QQQ only from the validated `market-data-cache` row and pass that row's
actual date as `--src-bench`; never label the cache's last row with the target
date. A same-date completed close is persisted as `bstate=session`. If the cache
has not reached the target date, do not pass the older price bundle unless an
independent controlled market-status source explicitly proves that exact target
date was closed; only then pass the unchanged prior-session pair with
`--bench-state=closed`. Otherwise omit the benchmark arguments, publish the
independently verified portfolio AUM, and leave the benchmark pending. A later
price date never retroactively proves an earlier closure. Retry the same target
date after the cache advances, using the normal same-date replacement path.
Never fill the gap from IBKR, an intraday quote, `adjclose`, a hand-copied price,
weekday arithmetic, or an inferred market-holiday calendar.

If the cache's newest row is older than the target date when the run starts,
do not give up on that row yet. Dispatch the `Refresh public benchmark closes`
workflow (`.github/workflows/benchmark-cache.yml`, `workflow_dispatch` on
`main`) once through the GitHub Actions tool, wait for that run to complete,
and re-read the `market-data-cache` branch before deciding. The workflow keeps
every identity, close and dividend validation; the dispatch only moves its
timing, because GitHub delivers the scheduled slots late or not at all. If the
tool or the dispatch is unavailable, or the refreshed cache is still behind,
continue exactly as above: omit the benchmark arguments and leave the benchmark
pending. Never fetch Yahoo or any other price source from the run itself.

Take `--spyd` / `--qqqd` only from the same cache row's `div` field, which the
cache records on the ex-date after its own adjusted-close cross-check. A row
that carries `div` must be passed with that dividend; a row without `div`
passes no dividend argument. Never look a dividend up elsewhere, never type
one in, and never drop one because the row's price alone looks complete.

Financial systems remain read-only. Never place, modify, or cancel orders, and
never initiate transfers or write to IB, Sharesight, or another financial
account.

## Fee calculation receipt

Management fee, Carry and fee-adjusted performance have one authoritative
calculation path. Before publishing any of those values:

1. Use `scripts/fee-economic-source.mjs` and the existing private environment's
   exact `FEE_ECON_GIST_ID` plus the approved dedicated 30-day fine-grained PAT in
   `FEE_ECON_GITHUB_TOKEN` on every run. Configure that PAT only in the authorized
   fee environment with no added permissions or Gists write access; do not treat
   a shared Environment as a per-Routine secret vault. Use only the helper's
   fixed-origin authenticated GET. Never fall back to generic GitHub variables,
   `gh`, OAuth, cookies or anonymous access. Missing/malformed PAT or HTTP 401/403
   stops the run; do not expose the credential/locator, increase permissions,
   transfer the decryption key or bypass a network refusal. The helper requires the original owner, secret
   Gist visibility, exact named file, and two identical remote reads of the
   revision, ETag and encrypted bytes. A missing configuration or failed acquisition
   stops this run before the writer; never omit the economic input and continue.
   Native v4 supplies `FEE_ECON_FILE`. After an explicitly reviewed manager
   migration, fetch the current native v4 file from the same Gist; the archived
   encrypted v3 backup is audit evidence, not `FEE_ECON_V3_FILE` and not a
   second economic input. Confirm the v4 source and the backup were read back
   before the first run after migration. The only still-active v3 exception is the explicit
   copy-only `fee-console.legacy-empty-expense.v1` policy in
   `docs/fee-econ-v3-copy.md`: read that runbook and the receipt runbook first,
   validate original-source identity independently, and make a new encrypted v4
   computation copy without changing that run's v3 source. Keep the verified
   snapshots temporary and outside the repository. The scripts' two local file
   reads do not replace the remote-stability check.
   In legacy mode, retain the original encrypted snapshot as `FEE_ECON_V3_FILE`
   for both tools. They re-authenticate preserved source bytes, strict projection
   and fee partition; source-file checks are still not remote freshness proof.
   Do not turn a previous manual attachment into a permanent economic source.
2. Run `scripts/daily.mjs` with the existing `FEE_DATA_KEY`. The writer must build
   `feeCalculationReceipt` from the candidate daily data and the transient private
   snapshot before its no-op decision.
3. Run `scripts/fee-receipt-report.mjs` against that same still-current private
   snapshot and quote only its validated receipt output. Immediately before
   protected publication, await the source snapshot's `checkCurrent()`; changed
   or unavailable original bytes/version stop publication. In `finally`, call
   its `cleanup()` and safely remove the separate computation copy on success
   or failure. Report source-helper failures only through fixed error codes.

Native v4 receipts remain v1. The approved legacy copy requires receipt v2 with
the exact policy ID and commitments to exact original envelope and payload bytes,
even with zero legacy rows. Do not substitute canonical/migrated JSON. Full
source records stay only in encrypted provenance; source bindings stay only in
encrypted receipts. Deploy both approved scripts and index-only consumer before
real v2 acceptance. Unknown receipt versions fail closed. On the phone a missing,
changed or unsupported raw v3 source must hide fees; the original v3 stays
read-only. With an existing legacy v2 receipt, a writer run without economic
input stops without changing `data.json`; acquisition failure is not permission
to erase that receipt or publish an apparently fresh fee result. Never infer no
real expenses/payments from an empty legacy row or absent payment records.

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
figure. Never place `FEE_DATA_KEY`, `FEE_ECON_GITHUB_TOKEN`, the private Gist id, full input hashes, or
decrypted economic input in GitHub Actions, plaintext repository content, command
arguments, notifications, Pages metadata, task output, release tags or logs.
The sole existing storage exception for receipt hashes is **inside the AES-GCM
ciphertext** of `data.json`, whose outer JSON has only `enc`, `v`, and `data`.
No input hash or legacy binding may appear as a plaintext outer field. The full
private ledger/provenance is never copied into `data.json`, even encrypted.
v1 does not make
benchmark calculations part of the receipt; describe them as public-ledger values.
