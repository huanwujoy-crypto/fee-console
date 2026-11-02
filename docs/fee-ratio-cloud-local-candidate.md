# Manual ratio operation in the existing cloud producer

The manual ratio jobs reuse `fee-cloud-producer.yml`, its main-only WIF provider,
existing service account, Environment and serial concurrency group. No new
schedule, server, identity, provider, Google secret or service-account key is
introduced. Fee schedules/calculations/budgets/recovery/Nov3 once controls remain
unchanged. Every fee job, including always-run cleanup, is excluded when either
ratio input is present. The budget reader recognizes the two exact ratio job names
as non-fee-source work; unknown names still fail closed. A fixed ratio run title
excludes ratio failures from fee diagnosis. Ratio never creates a fee candidate
or triggers fee promotion.

## Shared configuration boundary

The owner personally adds **the exact existing manager token** as
`FEE_RATIO_MANAGER_TOKEN` in the existing `fee-cloud-producer` GitHub Environment's
official secret form. A same-scope replacement token is not the same cryptographic
recipient/signing identity. Never extract browser credentials, read credential
files, migrate from Google Secret Manager or include secrets in chat, workflow
inputs, source or logs. Existing `FEE_DATA_KEY` and `FEE_ECON_GIST_ID` are reused.
Only the ratio job maps the new token into its process. The Environment currently
restricts main but has no required reviewer or native per-job secret allowlist:
other admitted jobs could reference it through future protected code. The owner
accepted this shared boundary, not platform-level job isolation.

Only these bucket-level grants are added to the existing producer service account
on `family-portfolio-gateway-fee-ratio-private`:

- `feeRatioInputConsumer`: objects.get/delete, limited to `inputs/`.
- `feeRatioClaimRecorder`: objects.get/create, limited to `claims/`.

No claim deletion/reset, bucket listing, input upload or project-wide storage
access is granted. Earlier unused ratio pool/provider resources stay unbound;
they are neither used nor deleted. The bucket enforces public access prevention
and uniform access. Only inputs have a one-day delete lifecycle. Lifecycle is
asynchronous and is not an exact 24-hour erasure guarantee.

## Operations and private input transfer

After exact-head approval and protected merge, first run only **verify-current**
against the accepted V7 body digest: authenticated owner, recipient and full
snapshot; no Storage authentication, input read, claim, PATCH, Sharesight request,
ledger decoding or fee publication. This is not a fee run or natural-cycle proof.

Manual inputs are `ratio_main` (exact current reviewed main) and `ratio_plan`
(closed JSON). All fee/source-check inputs remain default. Only the existing
owner, main branch and first attempt are admitted. Public preflight validates
admission and live main; the protected job repeats that check before credentials
are used. Plans/hashes constrain execution but do not provide user consent.
Do not dispatch a manual ratio operation during the original Nov3 fee window.

A verify plan contains `mode: "verify-current"`, `previousBodySha256`, and
`bundleId`, `original`, `input`, `library` all null. A later separately approved
publish plan uses `mode: "publish"` and two `{name,generation,sha256}` references:
`inputs/<64-hex-bundle>/original.json` and `input.json`. `library` is the approved
private source `{fileId,version}`. No arbitrary URL, destination or secret is input.

The consuming executor materializes only the approved private Library inputs
through Library's supported flow, then uploads the exact two projections using
the owner's existing authorized official Cloud Storage session. Verify complete
byte digests and object generations before dispatch. Do not use public GitHub
artifacts/links or new uploader credentials. The cloud runner cannot upload inputs
and has no assumed Library credentials. Original projection associations retain
the official workbook provenance. This transport does not create new evidence or
authorize future uploads.

The existing source/model/proof/crypto code recomputes associations and validates
real dates, freshness, recipient and previous body. Complete bytes are hash- and
generation-pinned. Identical source is a no-op. A generation-zero claim binds
previous body plus both source digests; changing run/main/generation/Library
version cannot reset it. Unknown claim outcome stops without retry. Claims
contain no financial payload or credentials and are never deleted by this job.

Only `fee-console-ratio-snapshot.json` can be PATCHed, at most once. An atomic,
fsynced safe intent precedes PATCH. Fresh revision/recipient/snapshot bytes must
match immediately before writing. Gist has no atomic cross-writer compare-and-swap:
retain the single-writer rule, including the browser. A failed/unknown PATCH gets
one authenticated exact readback, never a resend. Save the safe result before print.

Requests go only to fixed GitHub API, validated immutable raw-file URLs and the
one Storage bucket. No redirects or credentials sent to the raw host. Responses
are size-bounded with a 60-second limit; the job has a 10-minute cap. Plaintext is
only in short-lived memory, not artifacts. JavaScript strings cannot be guaranteed
erased; no debug/dump mode is enabled. Only the closed safe receipt is retained
for seven days. An owned claim permits deletion of exactly the two pinned input
generations. Unknown/unowned claims cannot delete another run's inputs. Cleanup
failure remains explicit; lifecycle is fallback. Cancellation/platform failure
can delay cleanup, so do not claim exact deletion in those cases.

Fee report, health, Jenny, recipient, fund and economic ledger are not written.
For release, pause producer/promotion, prove the original Nov3 opportunity is
unconsumed, rebind that SAME opportunity to final main and restore exact waiting.
Never add an opportunity, reset a claim or enable the retired benchmark.

Synthetic tests cover the actual runtime plus original publisher: full authentication,
truncated reads, pinning, create-only claim, single write/readback/cleanup, secret
canaries, final CLI rejection, receipt failures and unchanged fee budget counting.
Real cloud acceptance remains pending owner secret entry and protected release.
