# Offline ratio complete-original assembler

Default disabled. Fabricated-input tests only. Nothing here authenticates a
provider observation, grants Library identity to an assembled original,
authorizes a snapshot or publishes anything.

## Provenance

`adapter/`, `docs/` and the original `tests/` come unchanged from the
2026-11-12 handover archive `ratio-offline-allocation-candidate-20261112.zip`
(SHA-256 `ea132b90b432b29c2b00ddd710387657165f494cf63ddc8b5001ce562031e79f`,
all 37 manifest entries verified), with exactly one edit:

- `adapter/projection_contract.py`: the fixed Node path is
  `/usr/local/bin/node` instead of the previous executor-specific path. It is
  still a single hard-coded absolute path, never taken from a request, and
  the bridge still runs with an empty environment and hash-pinned modules.
  The 114 handover tests pass under Node 22.23.4 and 24.22.1.

The four modules under `adapter/projection_reference/` are byte-identical to
the repository's `scripts/fee-ratio-*.mjs` consumers;
`scripts/fee-ratio-offline-connection.test.mjs` fails if they ever diverge.

## Added for the connection

- `cli.py` — process boundary. No arguments: `DISABLED`, no stdin read, no
  file IO. `--enabled`: reads one `ratio-offline-workbook-batch.v1` request
  from stdin, runs `prepare_offline_performance`, and prints the assembled
  original's exact bytes (base64) and SHA-256 with every readiness flag false.
- `tests/test_cli.py` — boundary checks.
- `tests/connection_helper.py` — test support only; runs the real `cli.main`
  under the same substitutions as the assembler's own tests.
- `../fee-ratio-offline-connector.mjs` — fixed interpreter
  (`/usr/bin/python3 -I -B cli.py --enabled`, empty environment) → the
  existing `prepareCollectedRatioInput`. A refusal never reaches the intake.

## Tests

```
cd scripts/fee-ratio-offline && PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -m unittest discover -s tests
node --test scripts/fee-ratio-offline-connection.test.mjs
```

## Known limits

- The assembler's own fixture gives the IB-HK label a hedge-fund position;
  the existing snapshot book model refuses that (stock classes, 主题投资 or
  防御资产 only). The connection test records this and uses a batch whose
  IB-HK label holds stock-class positions.
- Real workbooks, real identity attributes, provider-observation
  authentication, Library identity for the assembled original, and every
  production step remain unverified and unauthorized.
