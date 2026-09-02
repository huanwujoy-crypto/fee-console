# Fee calculation receipt · design and runbook

## Purpose

The phone page and the Claude daily AUM task previously calculated management fee
and Carry independently. That made a stale endpoint-average formula and an omitted
in-kind transfer capable of producing a second, internally plausible answer.

`feeCalculationReceipt` removes that second source of truth for management fee,
Carry, amount paid/due and portfolio-return outputs. A trusted writer reads the
public daily ledger and the private economic ledger once, calculates once, and
stores only a deterministic encrypted receipt. The phone page and Scheduled task
become consumers of those outputs. Benchmark returns may continue to be derived
from the public benchmark ledger until a later receipt schema explicitly covers
them; they are outside v1.

## Data flow

1. Read-only Sharesight data produces a candidate daily point and verified flow set.
2. The current encrypted v4 private Gist snapshot is copied to a temporary path
   outside the repository. The caller proves remote stability with two consecutive
   reads of the same Gist revision/ETag and byte-identical encrypted content. The
   local double-read performed by the scripts protects against a file changing
   during use; it is not, by itself, proof that the remote Gist was stable.
3. `daily.mjs` decrypts both sources in memory, validates them, and calls the pure
   fee engine with an explicit `asOf` date.
4. The writer stores the receipt inside the existing encrypted v3 `data.json`
   payload. It does not copy the private ledger.
5. `fee-receipt-report.mjs` and, in the separate UI phase, `index.html` validate and
   consume that receipt. They do not recalculate it.

## Receipt contents

The receipt includes:

- schema and engine version;
- explicit start and `asOf` dates;
- public- and private-input SHA-256 commitments;
- an effective-flow digest, count and net amount;
- one period row per month with day counts, daily fee-base sum, management fee,
  Carry, gross P&L, High-water mark and return outputs;
- cumulative derived totals, amount accrued/paid/due and provisional status;
- a deterministic receipt id over all preceding fields.

It deliberately excludes private account names, raw opening records, flow ids and
notes, payment ids/notes, owner identity and the raw FX table. Payment date,
currency, amount and the applicable USD FX rate are committed because they affect
the amount paid; payments before the fee start date or after `asOf` are outside the
statement and do not reduce its balance. Only the aggregate paid/due results are
exposed to consumers. The enclosing AES-GCM payload supplies confidentiality and
integrity; the hashes are change detectors, not an independent signature. Full
input commitments must never be copied into notifications, ordinary reports,
Pages metadata or release tags;
consumer-facing output may show only a shortened receipt id.

## Safe invocation

The trusted Routine supplies the existing key through `FEE_DATA_KEY` and the
absolute temporary encrypted snapshot path through `FEE_ECON_FILE`, then invokes
the ordinary daily writer. The same still-current private snapshot is required by
the reporter for independent private-input validation. No secret belongs in a
command argument.

After a successful write, the Routine reads the result through:

```text
node scripts/fee-receipt-report.mjs --file=data.json --format=json
```

The report consumer exits without figures if the receipt is missing, stale,
tampered with, inconsistent with the latest private snapshot, or from an
unsupported engine. It refuses to run in GitHub Actions before reading files or
secrets. Malformed receipt structures return a closed validation result rather
than throwing a stack trace. A repeated run with identical inputs must leave
`data.json` byte-for-byte unchanged.

If any flow remains unresolved, the writer may still preserve the validated raw
AUM point, but it removes any stale receipt and emits no replacement. Consumers
must then show `calculation receipt pending` and must not display fee, Carry,
amount-due or fee-adjusted-return figures.

## Deployment gates

1. Scripts/docs/tests PR: add the writer and read-only consumer without changing
   `index.html`.
2. Produce and independently validate the first receipt using a controlled private
   snapshot.
3. Change the Scheduled task to consume only the receipt.
4. Separate `index.html`-only PR: make the phone page verify the receipt schema,
   latest public ledger and the private-input commitment before displaying receipt
   results; fail closed on any mismatch and never fall back to local fee formulas.
5. After production proof, make receipt generation mandatory for the Routine.

Financial systems remain read-only throughout. This mechanism has no order,
transfer, payment or broker-write capability.
