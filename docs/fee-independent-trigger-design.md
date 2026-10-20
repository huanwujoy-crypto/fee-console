# External fee producer trigger — design awaiting authorization

## Current evidence and limits

On 2026-10-02 HKT the active producer in publish mode had no scheduled runs by
12:22 despite the 11:30, 11:40, 11:55 and 12:20 slots. GitHub exposed no queued
run and no matching active incident. This proves a missing observable run, not
whether an internal timer event was delayed, lost, or otherwise suppressed.
The approved manual run 36964518048 failed style preflight and created no
candidate. Starting the producer does not solve missing reviewed classifications.

The existing supervisor observes completed runs only. The promotion watchdog
can reject a missing daily receipt after 13:15 HKT, but shares GitHub scheduling.
A benchmark workflow_run wake-up would diversify event paths inside GitHub;
it is not an independent platform trigger.

## Proposed independent trigger

Use Google Cloud Scheduler (Asia/Hong_Kong, `47,17 11-17 * * 2-6`) to invoke a
private Cloud Run relay. This timer is independent of GitHub cron and the Mac;
execution and protected publishing still depend on GitHub availability.
No 100% timing or successful-publication guarantee is implied.

The relay may only read this repository's public benchmark cache, producer runs,
main/public health and encrypted data hashes, and POST this fixed endpoint:
`/repos/huanwujoy-crypto/fee-console/actions/workflows/fee-cloud-producer.yml/dispatches`
with `{"ref":"main"}`. It must not accept caller-controlled repository, ref,
URL, token, workflow, target date, or financial payload. Its identity must have
no Sharesight, fee-economic-source, fee encryption-key, deploy-key or Gist access.
It does not calculate or publish data. The original workflow_dispatch OIDC path
and all existing source/classification/receipt/candidate/promotion gates apply.

The tested pure decision policy is `scripts/fee-trigger-decision.mjs`. A collector
must verify the expected completed NY session from a trusted trading calendar
and the paired benchmark cache; an old cache must never certify today's target.
For tomorrow 2026-10-03 HKT the expected completed session is 2026-10-02.

## Duplicate prevention and failure handling

1. Verify the session and fetch current health, main/public hashes and producer
   runs. Report published only if today's HKT receipt, expected target, all source
   dates and both hashes agree. A green workflow alone is insufficient.
2. If any producer is active, or a successful producer awaits public verification,
   do not dispatch. Monitor the release or report the publication gap.
3. Acquire a durable compare-and-swap lease in a dedicated state bucket. Re-read
   GitHub state under the lease before dispatch. Atomically store attempt time
   before POST; store only timestamps, run IDs, fixed outcome codes and hashes.
4. POST once. On ambiguous network outcome, retain the attempt and discover runs
   rather than retrying POST. A 45-minute cooldown bounds attempts across retries,
   overlapping Cloud Run instances and service deployments. GitHub's existing
   producer concurrency group remains a second safeguard.
5. Follow producer, candidate validation, promotion and Pages; read public health
   with cache bypass and compare hashes. Missing classifications must remain
   blocked, with a reviewed-classification repair request rather than guessed styles.

## Permissions requiring parent/owner approval before activation

- Enable/use Cloud Scheduler and Cloud Run APIs if not already enabled.
- Dedicated Scheduler identity: run.invoker on this relay only.
- Dedicated relay identity: accessor on one newly scoped dispatch credential only,
  plus compare-and-swap object access on its dedicated state bucket only. No
  reuse or export of existing fee or financial credentials.
- GitHub fine-grained credential or App: this repository only, Actions write
  (dispatch/read workflow runs), with no Contents write or financial-system access.
- Secret Manager resource, relay service, state bucket, scheduler job and pinned
  image deployment are not yet created or activated.
- Any .github workflow edit still needs the existing OWNER approval for exact
  PR head. This design changes none of those workflows.

## Required acceptance and tomorrow's proof

First test dry-run against known missing, active, failed, delayed-promotion and
published states. Demonstrate lease contention and uncertain POST recovery with
a harmless stub endpoint. After explicit production authorization, perform one
controlled real dispatch, observe every publishing gate and verify public source
dates/hashes. Record a rollback: pause the dedicated scheduler job; revoke the
dispatch identity/credential independently without altering published data.

On 2026-10-03 inspect the original GitHub schedule and external relay separately;
verify an actual producer attempt, all gates, expected target/source dates 10-02,
today's public checkedAt and matching data hashes. If a gate fails, report that
specific blocker promptly. Neither this draft nor synthetic tests establish that
tomorrow's real sources or publication have succeeded.
