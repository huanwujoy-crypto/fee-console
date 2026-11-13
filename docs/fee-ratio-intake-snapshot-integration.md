# Collected JSON to independent snapshot: synthetic integration

The integration test calls the existing `prepareCollectedRatioInput` and
`stageIndependentRatioSnapshot` directly. It puts the intake's returned
`originalBytes` and `inputBytes` into the existing browser-evidence plan and
checks their returned SHA-256 pins. The real evidence reader, process-local
proof, source validators, model builder, snapshot verifier and encryption run.
No runtime module or production configuration changes are needed for this path.

The complete synthetic `sharesight-private-performance-v1` JSON uses the
current consumer contract. This does not implement or certify a ten-workbook
converter, actual workbook completeness, source observations or an inception
evidence collector. Embedded Library references and source claims are invented
test data, not records of a provider download.

The successful output has `authentication: null`, `publicationReady: false`
and no manager authentication. Only the existing three candidate files are
written to the in-memory filesystem; the input and plan bytes stay unchanged.
The public recipient is sufficient to stage; a synthetic private key is used
only in the test to open the resulting envelope and inspect its contents.
The classification, Exposure and performance dates remain distinct, including
Exposure's original date. No requested fee date is substituted.

The rejection cases cover changed original/input bytes and pins, repinned
altered content, Library identity/version mismatch, recipient/account scope,
expired/future capture, unavailable identity reading, and private-file guards.
Write-time original/input/identity changes fail and clean up only the newly
created candidate files. Existing candidate output is never overwritten.
The production scope rejects the invented fixture accounts; the positive
fixture uses the same explicit synthetic scope substitution as existing tests.

## Run

```sh
node --test scripts/fee-ratio-intake-snapshot-integration.test.mjs
```

All filesystem operations made by these consumers are replaced within each
test by a closed in-memory OS using `node:test` mocks, as supported by existing
repository tests. Existing directory/owner/mode/symlink/hardlink/`.git` and byte
checks are executed, not removed. Fetch and subprocess entry points throw if
called. This avoids attempting real private evidence IO under this executor's
declared `/workspace` and `/tmp` writable roots, whose `.git` ancestors do not
satisfy the current evidence-workspace contract. It says nothing about other
paths on the host. No actual Library identity/xattr, download, financial data,
credential, browser, Gist, publisher or production job is accessed.

This proves code composition with synthetic OS observations, not real IO,
provider authentication, manager consent, runtime isolation or publication
readiness. Real original bytes/identity/source evidence, a compliant private
workspace and recipient still need their own authorized acceptance. The
refresh collector/publisher configuration and its date-policy blocker are
unchanged. Linux identity candidate files are not imported or required here.

Before protected integration, the new test and this document need sensitive
path registration and the test needs an appropriate existing CI run entry.
Those shared files are deliberately unchanged by this work. This is targeted
implementation validation, not the deferred independent review of both work
streams, a production approval or a remote merge candidate.
