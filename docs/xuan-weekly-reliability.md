# Weekly reliability repair — 2026-10-04

## Observed incident and recovery (HKT)

- Scheduler `xuan-weekly-sunday` is enabled: `0 10 * * 0`, `Asia/Hong_Kong`.
- Original execution `xuan-weekly-report-txczm`: created 10:00:03;
  failure receipt 10:01:38, `ib_network_error`, elapsed 83.89 seconds;
  execution failed at 10:01:41. The former code did not retain the network subtype.
  A timeout, DNS, TLS or connection diagnosis cannot be reconstructed from that code.
- Authorized recovery `xuan-weekly-report-xb5gx`: started 14:02:41;
  complete archive/publication receipt 14:03:09, elapsed 24.91 seconds;
  execution succeeded 14:03:11. Risk and ABC dates both 2026-10-02, quote lag zero.
- Public final HTML SHA-256:
  `2a8c0783972fcf61d705577fd427df1ac78ab49e0ce383a21f232849126be4bb`.
  Original mobile entry and 390px layout passed live read-back. This fix does
  not replace that report or fetch fresh financial inputs for testing.

## Candidate behavior

- Fixed IB, gateway and public quote GETs get at most three attempts, with
  two/four-second backoff inside their deadlines. IB retains its 150-second
  budget and statement reference; gateway requests have a 90-second total
  budget and quote requests 50 seconds. Gateway/quotes share a source-network
  cutoff at run start plus 360 seconds, reserving time in the unchanged
  600-second job. No whole-job retry, scheduler or provider change.
- Retry only selected timeout/connection errors, temporary DNS, and HTTP
  408/429/500/502/503/504. Auth, redirect, TLS/certificate, permanent DNS,
  unexpected errors, malformed XML/JSON and source/account/financial checks
  fail immediately. Server exception strings, URL queries, response bodies,
  headers and calculator stderr never enter failure diagnostics.
- Existing generation compare-and-swap and data-date/older-run refusal remain.
  A duplicate with the same run time, dates and HTML hash returns
  `already_current`; same-run different content fails closed. Archive paths
  remain immutable and unique; no locks or extra IAM are introduced.
- Failure records emit `severity=ERROR`, `event=xuan_weekly_failed`, stage,
  fixed code and allowlisted network subtype/attempts before archiving.
  Archive failure emits its own safe error and the job still exits nonzero.
  Both errors are visible in the existing Cloud Run logging channel.
- The amount-free health checker uses only anonymous HEAD on the existing
  public object. From Sunday 10:15 HKT it requires a run from the due Sunday,
  valid source dates and hash metadata. It detects missing triggers, runtime
  failures or stale publication without falsely identifying their cause.
  The manual-only workflow uses existing GitHub Actions failure status and
  summary. No automatic monitoring schedule or external destination is added.

## Remaining deployment and notification gates

This is a protected cloud/source/publication candidate. Obtain exact-head OWNER
approval, all required checks and protected merge before rebuilding the existing
weekly Docker image and updating only this job's image. Retain its identity,
secrets, environment, single task, zero whole-job retries, 600-second limit,
Scheduler, bucket policies and publication guards. A production rerun is not
part of synthetic regression tests; validate the next authorized execution.

Notification delivery is not proven. Monitoring alpha is absent in the existing
CLI, and the alternative read-only Cloud Asset inspection returned
`SERVICE_DISABLED`; no component/API was installed or enabled. Existing policy
and channel settings must be confirmed by an authorized operator before claiming
automated alerts. GitHub's actual notification delivery depends on existing
user subscriptions. The manual checker alone provides no automatic wake-up.
Any new cadence or destination requires separate approval.
