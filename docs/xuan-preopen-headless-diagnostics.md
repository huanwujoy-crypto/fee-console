# XUAN preopen automatic failure diagnosis

Production already uses the fixed `xuan-preopen-cloud-producer.yml` pipeline,
short-lived WIF identity and Cloud Run job; it does not require an open temporary
Cloud Shell. This candidate adds a read-only diagnostic step after the existing
full-delivery step fails, inside that same production run. It adds no producer,
schedule, manual diagnosis dispatch, credential, Cloud Logging access or IAM
permission. It does not change the clock or start-watch code/images.

The explicit partial Sharesight recovery does not certify a verified sync
snapshot: it labels sync completion unverified. The intended future source
architecture uses the sync layer as the sole daily
ledger/reconciliation writer; reports consume its verified snapshots. Sharesight
is preferred for positions, classifications and returns, and direct IB reads
supplement only uncovered orders or real-time buying power. Actual Flex fields,
source dates and account truth require separate source evidence. This candidate
adds no report-layer sync, historical rebuild or duplicate fallback pipeline.

This is a sensitive workflow/cloud/documentation change. Its new paths are
registered only as sensitive; existing OWNER and protected-check requirements
remain in place. Preparing and testing this candidate authorizes no dispatch,
re-run, deployment, publication or schedule change.

## Same-run failure hook

Only `failure() && steps.delivery.outcome == 'failure'` enables the diagnostic
step. Earlier test/auth failures, limited-readback failures, successful or skipped
full delivery do not enable it. A successful diagnosis never cancels the original
job failure or enables candidate publication/public verification. The existing
main, shadow/publish mode, environment, WIF provider, delivery service account,
concurrency group and `cancel-in-progress: false` remain unchanged. Diagnosis
creates no workflow event for the clock to misclassify and needs no clock image
update.

After approved merge, the next already scheduled production run uses this hook
if its full-delivery step fails. Do not dispatch or re-run a producer merely to
obtain a diagnosis: those actions can run financial sources. Earlier runs,
including today's prior failed run, are not diagnosed retrospectively by this
candidate. No operational run or live-cloud verification was performed here.

## Fixed reads and safe results

The CLI accepts only `--today`. It derives today's HKT date from the trusted
runner clock, before reading the Google token. Date arguments and alternative
modes are rejected. No workflow input or environment date can override it.
Diagnosis makes at most three GET requests, with no retry or polling:

1. `delivery/<today>/start.json` (maximum 4 KiB).
2. `delivery/<today>/receipt.json` (maximum 64 KiB).
3. Only when the receipt is missing and a start marker strictly matches today's
   date, timestamp and fixed job execution naming rule: that exact
   `xuan-preopen-report` execution (maximum 8 KiB).

Execution GET uses a partial-response field mask for `name`, `completionTime`,
`taskCount`, `succeededCount`, `failedCount`, `cancelledCount`, `retriedCount`.
It excludes configuration, environment and condition messages. Completion time
must be a real UTC instant, at or after the validated start and no later than the
runner clock, including fractional-second precision. Every request has a
15-second timeout and rejects redirects. A 404 is missing/unknown evidence;
401/403 is an access failure, never a substitute identity or fallback. Two
missing objects do not prove the producer never started: marker writing might
have failed, so the result is `unknown` / `evidence-missing`.

The implementation uses only existing `storage.objects.get` on private delivery
objects and `run.executions.get` on the fixed job. The existing delivery identity
also has job-run capability, but diagnosis never exercises it. No request runs a
job, lists objects/executions, reads HTML, `report-check/`, secrets, raw sources or
logs. No financial context is loaded. The diagnostic step receives only the
short-lived Google token, never the publication GitHub token.

Output contains only a constructed event, validated date, fixed status,
allowlisted code and fixed diagnostic. Execution names, arbitrary error messages,
amounts and token values are not emitted. A ready receipt means only that a
completion receipt is present: report contents and public publication are not
verified. Missing completion receipts remain distinct from success, including
when Cloud Run succeeded.

Structured failed v1/v2 receipts require the fixed failure-envelope keys, date,
fixed execution and `publication=none`. V1 may expose only
`IB_REAUTHORIZE_REQUIRED` or `DAILY_REPORT_FAILED`; other codes produce the fixed
`FAILURE_RECEIPT_PRESENT` code. The legacy `IB_REAUTHORIZE_REQUIRED` code combines
refresh and MCP 401/403 failures. Its name does not establish a reauthorization
remedy; the diagnostic remains `root-cause-unknown`. V2 nested diagnostic fields
are ignored until their producer contract is separately verified. This candidate does not depend on the
structured failure-receipt producer change (PR #361). Existing images that fail
without writing a receipt may reveal execution failure, but the root cause can
still be unknown. Adding Cloud Logging/IAM is outside this candidate.

## Offline validation

`node --test cloud/xuan-preopen/diagnose.test.mjs` exercises real diagnostic
transport with recording mock fetches, today's HKT date, strict start/completion
time validation, byte bounds, safe v1/v2 summaries, canary privacy, CLI rejection
and the actual workflow failure-hook condition. The existing cloud/publication
suite includes this test through its wildcard. Synthetic fixtures and a network
deny preload are used; tests request no cloud identity, call no live cloud
endpoint, read no environment credential or session storage, and dispatch/deploy
or approve no task.
