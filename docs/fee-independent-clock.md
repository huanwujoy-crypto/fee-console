# Fee independent cloud clock — proposed, offline only

This candidate adds a small independent clock to start the existing fee producer
at 10:00 HKT, then check actual job start at 10:05. It does not guarantee that
GitHub provides a runner at exactly 10:00 or that publication finishes then.
Dedicated resource/bootstrap scope was approved by the human on 2026-10-14.
Final signed-code OWNER approval, verified release image, owner-only GitHub token
entry and explicit activation approval remain independent gates. Operational
resource status belongs in the private task journal, not this source document.
This image defaults off and never authorizes deployment or enablement itself.

The local branch starts from reviewed main
`3db217fae28e14a752e26449ddcd4d29d7365889`; the frozen 14-file morning candidate
is a separate worktree and remains untouched. New `cloud/` and `docs/` paths
are sensitive under the existing approval policy. This work does not change
that policy or qualify an unsigned local commit for protected production use.

## Why this is the smallest useful change

The original producer cron is correct and the workflow was observed active.
On 2026-10-14 at 11:38 HKT all 61 producer runs were completed, with no new
run that day. Several natural first runs had arrived hours late. A supervisor
triggered only by a completed run cannot see a producer that never started;
the existing 13:15 watchdog also relies on GitHub scheduling. This candidate
moves only the start clock and its first-start check outside that dependency.

Two Cloud Run Jobs use one minimal image. Two Cloud Scheduler jobs call the
fixed Run Jobs API through OAuth at `0 10 * * 2-6` and `5 10 * * 2-6`, with
`Asia/Hong_Kong`. Both use one task, parallelism one, zero task retries, and a
120-second timeout. Scheduler retries are explicitly zero, including
`maxRetryDuration=0s`. No 10:10 launch or 10:15 check is included.

The target is always `huanwujoy-crypto/fee-console`,
`.github/workflows/fee-cloud-producer.yml`, `main`, with the sole input
`apply_style_proposal=false`. The image has no financial source code or
credentials. The original preflight, concurrency, stable source reads, cash and
style gates, writer, Validate, Promote, Pages and later GitHub slots are preserved.
The existing contents-write publication credential is neither reused nor expanded.

## Idempotency and observation

The clock calculates the original producer's latest completed NY weekday at the
16:15 boundary, using actual `America/New_York` timezone rules. It retains the
existing holiday contract: a holiday target remains pending in the producer
until real source/benchmark evidence passes. It never substitutes an older close
or adds a holiday carry point.

Launch first reads complete same-HKT-day workflow runs and complete status-filtered
unfinished lists, including previous-day occupied runs. Missing, malformed or
truncated metadata blocks dispatch. An existing schedule/manual request is reused;
an earlier unfinished run blocks launch rather than adding another queued request.

Before the sole POST, launch atomically creates an immutable intent in the new
dedicated metadata-only bucket using `ifGenerationMatch=0`, keyed by target date.
A conflict does not resend. The intent survives a crash, timeout, unknown HTTP
result or failure to write the result receipt. A second pre-POST run check narrows
the natural-cron race, and the slot/target are checked again before POST. There
is no automatic retry, lease expiry, deletion or takeover path in the program.
Manual investigation is required after an unknown result; it must not erase an
intent merely to retry. Bucket lifecycle expiration at 90 days cannot make an
old target dispatchable because the runtime accepts only the current 10:00 slot.

The immutable intent guarantees at most one attempt by this cloud clock for a
target while retained. Scheduler delivery is at least once. A GitHub natural run
can still race after the final GET; existing concurrency and publication preflight
handle that race. This is not an exactly-once promise across GitHub and Google.

Check-start never dispatches and receives no GitHub secret. It reads the actual
`produce` job's `started_at`; a workflow timestamp, queue, environment wait,
missing job or skipped job cannot prove start. It distinguishes not requested,
dispatch not observed, requested but not started, and failed after actual start.
A `started` receipt is start evidence only, with `publicationVerified=false`.
SourceDates, candidate validation, promotion and public byte readback remain the
existing publication acceptance criteria.

## Exact proposed resources and continuing permissions

Machine-readable API payloads, fixed names and bindings are in
`cloud/fee-clock/deployment-plan.json`. Proposed project is
`family-portfolio-gateway`, region `asia-east2`:

- Jobs: `fee-clock-launch`, `fee-clock-check-start`; image release by verified digest.
- Scheduler: `fee-clock-launch-1000`, `fee-clock-check-start-1005`.
- Dedicated identities: `fee-clock-launch`, `fee-clock-check`, `fee-clock-scheduler`.
- Bucket: `family-portfolio-gateway-fee-clock`, Standard, same region,
  uniform access, public access prevention, metadata only, 90-day lifecycle.
- Secret: `fee-clock-github-actions`, one active version with automatic replication;
  launch mounts pinned version 1 at `/secrets/github/token`.
- Launch identity: secretAccessor on this secret only; objectCreator and
  objectViewer on this bucket only. It cannot replace/delete existing objects.
- Check identity: objectViewer on this bucket only; no secret access or GitHub write.
- Scheduler identity: run.invoker on these two named Jobs only; no override payload.
- Two proposed log alert policies: clock Job errors and Scheduler target failures.
  They are disabled and have no channel until an existing authorized destination
  is live-verified and specifically approved. No subscription/channel is created.

The new GitHub fine-grained credential would select only this repository and
Actions write, with implicit Metadata read, and no Contents/Administration grant.
GitHub cannot restrict this Actions permission to one workflow or ref. Fixed code
limits normal use; a stolen token can operate other Actions in the repository.
That residual risk and this new persistent grant require specific human approval.
The owner must enter the credential through the secure product interface, never
chat, source files, shell arguments, logs, or an agent-read token command.

No project-wide runtime Editor/Owner, tokenCreator, new financial data access or
existing financial identity reuse is proposed. Deployer permissions are distinct:
live-check the current operator's create/update/get/actAs rights and organization
constraints before selecting any missing administrative grant. Do not silently
grant broad roles just to make deployment succeed. Also verify the existing
Scheduler service agent, Run service agent and image repository access; none is
assumed configured from the proposed XUAN documentation.

## Existing authorized deployment path

The original installed Google Cloud SDK 575.0.1 with the existing Python 3.12
runtime and configured CLI identity successfully read live resource and IAM
metadata in the fixed project on 2026-10-14. The initial default-auth probe
failed because ADC was absent and the SDK was not on that shell PATH; it was
not expired authorization. No login, new ADC, identity switch or scope expansion
was needed. Existing XUAN clock resources and the image repository were observed
in asia-east2; their credentials, identities and schedules are not reused or
changed. The specific Fee runtime grants are separate approved additions.

Also verify the original repository variable `FEE_CLOUD_MODE=publish` through
its authorized metadata surface. This clock does not read or change that variable;
missing/shadow mode must not be presented as working daily publication.

## Alarm coverage and remaining limits

The check-start Job exits nonzero with a sanitized code for missing actual start.
The Job policy covers these errors as well as Cloud Run startup errors; the separate
Scheduler policy covers OAuth/IAM, API, DNS, deadline and other target-delivery
failures for both slots. A 2xx Run Jobs API acknowledgment proves an execution
request, not successful Job execution, so both policies are necessary.

Before enabling, verify the proposed filters against real safe Job and Scheduler
failure metadata and test delivery to the approved existing channel. Empty
`notificationChannels` is a deployment blocker, not working notification delivery.
The existing owner-approved email channel is the sole destination. Only one
explicitly approved simulation notification is allowed before final enablement;
its address and operational channel ID stay outside public source files. Log delivery/Monitoring
itself can be delayed; simultaneous Scheduler and monitoring outages, disabled
APIs or intentional pauses without a delivery error are not fully detected by
these two policies. Do not claim a complete independent absence monitor or SLA.
Inspect pause/API-disable audit logs as part of operational acceptance; adding a
scheduled absence monitor would require a separate concrete approved change.

## Cost estimate, approval and activation

As of 2026-10-14 the official Hong Kong Jobs regional table is CPU
US$0.0000216/vCPU-second and memory US$0.0000024/GiB-second. Jobs have a one-minute
minimum. At 23 eligible days/month, two executions/day, one vCPU and 512 MiB:

| Item | One-minute executions | Two-minute executions |
| --- | ---: | ---: |
| Cloud Run Jobs, 46/month | $0.062928 | $0.125856 |
| Two Scheduler jobs | $0.20 | $0.20 |
| One active secret version | $0.06 | $0.06 |
| 23 secret accesses | $0.000069 | $0.000069 |
| Base estimate | $0.322997 | $0.385925 |

No free allowances are deducted. This excludes builds, image storage, GCS
storage/operations, egress, log ingestion/storage, any applicable Monitoring
ingestion/query charges and tax. It is not a spending cap. Paused Scheduler jobs
remain billable. Verify billing region/rates and any paid notification delivery
before approval. A four-execution variant is not configured in this candidate.

Official sources: [Cloud Run pricing](https://cloud.google.com/run/pricing),
[Scheduler pricing](https://cloud.google.com/scheduler/pricing),
[Secret Manager pricing](https://cloud.google.com/secret-manager/pricing),
[Observability pricing](https://cloud.google.com/products/observability/pricing),
[OAuth Run Jobs scheduling](https://docs.cloud.google.com/run/docs/execute/jobs-on-schedule),
[GCS preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions),
[GitHub dispatch permission](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event).

The human approved the dedicated resource/IAM/notification scope and an
incremental USD5/month authorization ceiling on 2026-10-14. That is not a
platform spend cap. Budget API enablement and a shared-project budget were not
approved and are not part of deployment. This scope approval does not replace
final code approval or permit activation.

The final approval package must bind the complete sensitive diff and signed head,
verified runtime/base image and final image digest, new identities and exact IAM,
new repository Actions-write credential and its residual scope, bucket/secret,
the two precise slots, approved alert destination/policies, region and fees.
This local unsigned head is preparation only. Follow the existing specific OWNER
gate; never post an OWNER comment for the human.

After approval, in a functioning authorized deployment environment:

1. Re-read protected main, resource/IAM metadata, APIs, billing and notification
   channel. Rebuild/review if the candidate base changed.
2. Verify the pinned official Python base digest. Build with only
   `cloud/fee-clock` as context; Docker COPY includes just `clock.py` and
   `runtime.py`. No repository financial files enter the image. Freeze the
   resulting image digest and exact reviewed source.
3. Create the approved bucket, three identities, one secret and scoped grants;
   owner enters the new credential securely. Deploy both Jobs disabled. Deploy
   the two alert policies disabled with the verified channel reference.
4. Create the two Scheduler resources while Jobs remain disabled and immediately
   pause them. Scheduler REST `state` is output-only, so do not pretend a
   `state=PAUSED` create payload is an atomic disabled deployment.
5. Verify exact payloads, IAM, job args, secret version, zero retries and OAuth;
   perform the specifically approved cloud-only acceptance and safe alarm delivery
   checks. Never use arbitrary repo/workflow/ref or style input for a smoke test.
6. Only with specific activation approval set both Jobs enabled, enable tested
   alert policies and resume exactly the two Scheduler slots. Preserve GitHub
   fallback and all original financial/publication gates.
7. At the next natural 10:00 slot record Scheduler delivery, Run execution,
   workflow_dispatch ID and actual produce job start; at 10:05 verify start evidence.
   Continue through sourceDates, Validate/Promote/Pages and public bytes. A manual
   acceptance run is not proof of a natural scheduled run.

Rollback is to pause the two new Scheduler resources and disable both new Jobs.
Keep immutable intents/results for investigation. Do not change the financial
pipeline, erase an uncertain intent, revoke unrelated permissions or remove
resources as an unapproved destructive shortcut.

Offline validation command:
`python3 -m unittest discover -s cloud/fee-clock -p 'test_*.py' -v`.
Tests inject only synthetic HTTP/metadata/credential strings; no live production
or financial route is invoked by the test suite.
