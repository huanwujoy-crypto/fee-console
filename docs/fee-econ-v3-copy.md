# Private economic v3 recovery: strict copy only

`scripts/fee-econ-v3-copy.mjs` is a recovery tool for the economic-ledger schema
written by historical `9d9bc98:index.html` (v3.4). It is not the UI's permissive
`migrate()`, is not called by the daily writer, and never updates the source Gist.
An encrypted daily-data v3 envelope is **not** an economic v3 ledger.

## Authority and acceptance gates

A successful conversion proves authenticated decryption and structural
compatibility only. It does **not** prove source freshness, the correct private
Gist identity, absence of other actors' changes, business-event identity, or an
authoritative fee amount. The source must independently pass those audit gates.
The user's statement about their own manual edits must not be generalized into
a statement that no automated or previously authorized edit ever occurred.

Only a strict safe subset is accepted:

- All historical required fields must exist; unknown fields fail closed. No
  missing opening balance, flow, payment, FX rate, date, label or ID is seeded.
- The managed accounts remain exactly `schwab` and `webull`; the original account
  order, stable IDs, numeric representations, timestamps and notes are copied.
  A blank all-zero opening ledger is refused, not treated as an established base.
- Each month must be chronological, with `locked:false`, `lockedAt:null`,
  `snap:null` and an empty `manualClose` object. A nonempty legacy feature requires
  a separate reviewed migration, even if its contents look like zero or blanks.
- Every fee record must explicitly be `type:"pay"`. Every `exp` record is refused,
  including a zero-valued or unfinished one. It is never filtered or changed into
  a payment. Pre-start payments, invalid/zero amounts, invalid currency/FX,
  duplicate IDs/sources and duplicate JSON keys are refused.
- The prior-day `openingAt` must match `start`; rates must also pass the current
  receipt normalizer. A blank **present** payment `fx:""` is preserved and uses the
  existing required currency map in both versions. It is not a missing-field
  default. A nonblank positive explicit FX remains authoritative.

The converted v4 copy retains exact original encrypted-envelope bytes and exact
decrypted UTF-8 payload bytes in `legacyV3Copy`, **inside the encrypted copy only**.
Thus inactive legacy month fields and payment `type`/`cat` are accounted for,
not lost. Provenance is not part of `normalizeEconomicInputs` and must never be
added to the public receipt, logs, comments, artifacts or notification output.
The tool upgrades input format; it does not claim historical and current fee
algorithms produce identical amounts.

## Private use

Use only the existing authorized private environment and its existing
`FEE_DATA_KEY`. Do not extract a key from a browser, create a new key or expose it
in a command argument. The command takes **no arguments**. Its required environment
variables are:

- `FEE_DATA_KEY`: existing 32-byte key, base64/base64url encoded.
- `FEE_ECON_V3_FILE`: absolute path to the verified encrypted v3 source snapshot.
- `FEE_ECON_COPY_FILE`: absolute path to a new encrypted-copy destination.

Both files must be outside the repository. The source is read twice and checked
again after conversion; remote revision/byte stability remains the caller's
separate responsibility. The output is exclusively created with mode `0600`,
read back and size-checked for the current private snapshot consumer. Existing
destinations and source overwrite are refused. Decryption occurs in memory;
no plaintext file is written. GitHub Actions execution is refused before the key
or file paths are inspected. Console output contains only a static success marker
or a static rejection code: no amounts, hashes, Gist IDs, paths or ciphertext.

The in-memory API is `convertEncryptedV3Copy(sourceBytes, key)`; it returns only
encrypted v4 bytes. Repeated conversion preserves identical economic/provenance
content but deliberately uses a fresh AES-GCM nonce. Do not compare encrypted
copies for deterministic equality; freeze one verified copy for the receipt
writer and reader. No caller should print or publish the returned bytes.

After independent source authority checks, pass that frozen copy as
`FEE_ECON_FILE` to the existing writer and receipt reporter. Generate and validate
the receipt, prove a repeat-run no-op, use the existing protected publication path,
and verify the phone separately. Conversion success is not publication or phone
acceptance. Replacing the source Gist requires separate explicit authorization.

## Regression tests

`scripts/fee-econ-v3-copy.test.mjs` uses synthetic fixtures only. It covers byte
preservation, identical normalized economic inputs, stable IDs, FX parity,
all missing/unsupported legacy fields, invalid/duplicate identities, authenticated
envelope failures, provenance non-leakage into receipts, output size, private
file mode, no overwrite, repository/symlink rejection, sanitized output and the
Actions guard. Never add a real financial snapshot as a test fixture.
