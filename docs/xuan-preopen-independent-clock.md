# XUAN preopen: independent clock and start alarm

Status: proposed; no cloud resources, credentials, schedules or approval rules
are created or changed by merging these files. Activation is a separate gate.

## Why

On 2026-10-05 the active GitHub schedule (13:00 and 13:10 HKT) had no run by
15:37 HKT. The two previous schedule events arrived at 19:26 and 18:56 HKT.
There is no evidence of a financial-source failure that morning. A separately
authorized manual run `37279576916` restored the public report at 15:47:58 HKT:
report date 2026-10-05, completed-source date 2026-10-02. This incident does not
prove why GitHub delayed or omitted a particular event.

GitHub explicitly documents possible schedule delays and dropped queued jobs.
A second cron on the same provider is not an independent clock:
https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule

## Minimal path (no financial changes)

Cloud Scheduler -> fixed Cloud Run trigger -> GitHub workflow_dispatch ->
existing `XUAN preopen cloud producer` -> existing private source job -> existing
signed candidate, Validate, Promote, Pages and public-byte read-back.

The trigger knows only one repository, one workflow and `main`. It cannot select
financial endpoints, override producer inputs, read broker data, or publish a
report. It uses the existing reviewed market calendar. Weekends/joint market
closures do not dispatch; unreviewed years stop rather than assume weekdays.
Its start check does not replace the existing workflow/publication failure checks.

## Proposed fixed resources

Project `family-portfolio-gateway`, region `asia-east2`:

| Resource | Scope |
| --- | --- |
| Cloud Run job `xuan-preopen-clock` | `trigger.mjs launch`, 1 task, parallelism 1, max retries 0, timeout 120s |
| Cloud Run job `xuan-preopen-start-watch` | `trigger.mjs check-start`, same image/limits |
| Runtime identity `xuan-preopen-clock` | Secret accessor on only `xuan-preopen-trigger-github`; no project-wide role |
| Scheduler identity `xuan-preopen-clock-invoker` | Run invoker on only those two jobs; no overrides or financial-job access |
| Secret `xuan-preopen-trigger-github` | New fee-console-only fine-grained GitHub Actions read/write credential |
| Scheduler `xuan-preopen-clock` | `0,10 13 * * 1-5`, time zone `Asia/Hong_Kong` |
| Scheduler `xuan-preopen-start-watch` | `5,15 13 * * 1-5`, same time zone |

The GitHub credential must not have Contents write, Issues write, Administration,
additional repositories or transaction permissions. Do not reuse/copy
`FEE_CLOUD_GITHUB_TOKEN`, OWNER publication signing tokens, or financial credentials
to this identity. The user creates/enters a new credential through trusted UI;
do not put tokens in chat, repository, command history, logs or approval comments.
Use the shortest practical expiry and create an expiry alert before cutover.
GitHub's Actions write permission is repository-wide, not workflow-specific. A
stolen token could operate other Actions in this repository; fixed endpoint checks
limit this program, not a stolen credential. OWNER must accept that residual scope
before creating it. No credential has been created by this proposal.

Build with `cloud/xuan-preopen/trigger-build.yaml`, reviewed commit as `_RELEASE`.
Record the immutable resulting image digest and pin both jobs to that digest.
The image copies only trigger/calendar/bounded-read helpers and runs as non-root.

Scheduler HTTP POST targets are the two exact Cloud Run v2 `jobs:run` URLs,
with an empty JSON body, OAuth (not OIDC) and cloud-platform scope. Google APIs
require OAuth for these endpoints. Configure no automatic Scheduler retries:
the explicit second launch/check supplies the bounded fallback. Scheduler delivery
is at-least-once; this is not an exactly-once guarantee:
https://docs.cloud.google.com/scheduler/docs/overview
https://docs.cloud.google.com/scheduler/docs/http-target-auth

## Idempotence and alarms

Launches are accepted only between 13:00 and 13:20 HKT. Query today's full HKT
day of workflow runs, restricted to `main`. If one was already requested (including
queued or completed), do not request another. Incomplete/malformed run lists,
credential/network failures and unknown POST outcomes fail closed, without retry.
Rare concurrent clock deliveries can still request two workflow runs; existing
GitHub concurrency serializes them, and the existing immutable daily start record
prevents a second set of financial reads. Do not change/delete that record to retry.

At 13:05/13:15, a queued/requested run is not a start proof: require an in-progress
or completed run with valid actual start metadata. Otherwise exit non-zero with:
`{"event":"PREOPEN_CLOCK_ALERT","code":"PREOPEN_TRIGGER_NOT_STARTED"}`.
Other failures have similarly bounded non-financial codes. No balances, holdings,
orders, source records or credentials enter clock logs.

Create one Cloud Monitoring log-based alert matching `PREOPEN_CLOCK_ALERT` on
only these two job names, immediate notification and one incident per 30 minutes.
Use an already verified OWNER notification channel; never guess a recipient.
Test the start-check alert with mocked data locally and a separate amount-free
cloud test log. Do not cancel/duplicate a real production run to test an alarm.
Also alert on Scheduler invocation failures and token expiry: a failed target
invocation may produce no job log. Read back the notification destination and
confirm real test delivery, not only policy creation.

## Authorization, activation and rollback gates

1. Keep the code PR Draft with `/require-specific-owner-approval`. OWNER must
   personally comment `/approve-xuan-ib-maintenance <exact head SHA>`. Do not post
   that comment on the owner's behalf; changing the head invalidates it.
2. After approved checks/merge, obtain explicit authorization for the fixed new
   credential, secret, two least-privilege identities, jobs and schedules above.
   Existing report/publication authority is not authority to expand cloud access.
3. Create both schedules PAUSED. Build and record digest, read back job arguments,
   retries, timeouts, scoped IAM and secret-access scope, target OAuth and HKT times.
   Confirm neither job can read financial secrets or execute the financial job.
4. Run amount-free local/mock checks and verify alarm delivery. Do not create an
   additional same-day financial run for acceptance. Arrange the first controlled
   live trigger at the next eligible 13:00 slot, with public/data-date checks.
5. Unpause only after the preceding checks. Leave the existing GitHub cron as a
   temporary fallback until an actual independent-clock -> producer -> protected
   publication -> public-fixed-page receipt is verified. Its daily start guard
   prevents duplicate financial reads; do not claim separate cron is a guarantee.
6. Record scheduled, dispatched, actual producer start, source/HTML completion,
   promotion/Pages and first public-visible times; require total <=20 minutes.
   Timer setup is not evidence of on-time production. On alert/failure retain the
   last verified public report; do not lower freshness/data-integrity gates.
7. Rollback: pause only these two new schedules, retain secret/audit resources for
   investigation, leave existing pipeline/cron and other apps untouched. Any later
   removal of old cron requires separately reviewed approval.

This change does not renew account association (currently expires 2026-10-10),
change market calendars, report mathematics, layouts, data dates or public access.
Calendar/association/token expiry must be reported distinctly from clock failures.
