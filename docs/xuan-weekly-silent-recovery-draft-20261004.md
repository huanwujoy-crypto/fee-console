# XUAN silent recovery and explicit manual repair — 2026-10-04

Draft review based directly on main 6aa1ab363676ac7e4b6ff4d73a9210d2541edaee. No deployment, scheduler/IAM modification, source capture, financial API call or notification was performed for this draft. The exact final signed PR head needs specific OWNER approval.

## Execution modes and regression boundary

The image uses fixed ENTRYPOINT `python cloud/xuan-weekly/recovery.py` and CMD `--mode=scheduled`. The existing Scheduler sends `{}` to the same Run v2 job endpoint and therefore inherits scheduled mode without an override permission. Its current binding is `roles/run.invoker` for xuan-weekly-trigger@family-portfolio-gateway.iam.gserviceaccount.com. This role does not grant runWithOverrides; the schedule does not need to pass mode explicitly.

Bare `gcloud run jobs execute` now invokes scheduled control. Outside Sunday 10:00–10:45 HKT it logs `outside_recovery_window`, `reportRun:false`, `manualModeRequiredForApprovedRepair:true`, and does not produce a report. This behavior is an explicit reviewed change, not a successful manual refresh. Approved repair/release runs remain available through explicit **manual** mode. Never treat the scheduled-mode exit code as evidence of a manual report.

After verifying the real human approval for the exact deployed change, use one execution override with:

```
gcloud run jobs execute xuan-weekly-report   --project=family-portfolio-gateway --region=asia-east2   --args='--mode=manual,--request-id=<new canonical UUID>,--expected-public-sha256=<verified current public SHA256>,--approval-reference=https://github.com/huanwujoy-crypto/fee-console/pull/<PR>#issuecomment-<real OWNER comment>'
```

This is an example only; it was not executed. The expected SHA must match both current public bytes and metadata, with validated private/public receipts. Only a genuinely absent public object may use explicit `absent`. A canonical unique request UUID has an immutable create-only request receipt; replay cannot rerun sources. Public state is checked again after the claim. No arbitrary cutoff, account, source URL, credential or bypass argument is accepted. The normal source/date/schema/identity/archive/publication guards are unchanged. Manual mode never automatically retries failed requests.

The approval URL is an audit reference, **not runtime proof of human OWNER consent**. The operator must verify exact-head approval through the existing protected workflow before execution. Existing Cloud Run IAM limits which actor can supply overrides. Read-only Run v2 `testIamPermissions` returned HTTP200 with `run.jobs.run` and `run.jobs.runWithOverrides` for the current authorized CLI identity; no job was executed. No new IAM is required for that identity. Do not grant overrides to the Scheduler service account. Do not override task count, max retries or the existing 600-second task timeout.

## Exact schedule and bounded automatic behavior

Proposed expression for the **existing** xuan-weekly-sunday Scheduler: `0,15,30,45 10 * * 0`, timezone `Asia/Hong_Kong`. Exactly four dispatches per Sunday: 10:00 normal, 10:15/10:30 health/reason-gated recovery, 10:45 final health only. Current expression remains `0 10 * * 0` and ENABLED. Existing endpoint, OAuth service account, body `{}`, 60-second attempt deadline and Scheduler retry settings are unchanged. Cloud Run maxRetries stays zero. At most one normal full source run plus one extra full automatic recovery per week; four scheduler invocations do not mean four full captures.

All modes first validate their own gates. Fresh current-week public HTML is checked against private latest HTML, metadata, exact permitted footer transformation, immutable success receipt and publication receipt. Healthy checks read no financial source. A completed same-week archive with validated object/date/hash can be republished without sources. Authentication, permission, TLS, schema, identity or calculation errors never select automatic full recovery. Only classified transient network failures in the approved source stages qualify. A successful archive takes precedence over a downstream publication failure and permits archive-only recovery.

## Lease atomicity, timeout and concurrency

Before any full source run or archive publication, acquire shared immutable minute-slot reservations for the current minute through the next 20 minutes. Each uses Storage `if_generation_match=0`; acquisition is ascending. Any overlapping manual/normal/recovery attempts share a slot, so only one can acquire all slots and proceed. A loser stops before sources or publication. Partial reservations may temporarily block another attempt but cannot create overlapping fetches. No overwrite/delete permission on control objects is needed.

Each claim records an expiresAt 20 minutes later. Later attempts reserve fresh slots after expiry; old reservations and counters are never deleted or reused. The existing 600-second task timeout is shorter than the lease. A normal timeout with a safe terminal transient receipt waits through the lease (usually 10:15 waits, 10:30 performs the bounded recovery). Crash/OOM or missing safe failure receipt does not become a transient failure just because time passed. The weekly recovery.json counter never resets on lease expiry. 10:45 never starts another full run. Storage errors/permissions stop, without renewal or IAM repair.

The controller shares a 570-second deadline with the existing runner, reserving calculation/publication time. The cloud timeout remains the final bound. Raw financial source reads remain exclusively in the existing runner when a gated full attempt is selected. Controller reads only fixed latest objects, generated control objects, safe receipts and finished HTML, not private financial raw envelopes.

## Read-only identity and permission evidence

2026-10-04 read-only bucket/job inspection, sanitized in [permission evidence](xuan-weekly-runtime-permission-evidence-20261004.json):

| Identity/resource | Existing permission and scope |
| --- | --- |
| xuan-weekly-reader@family-portfolio-gateway.iam.gserviceaccount.com | Existing runtime identity; unchanged |
| family-portfolio-gateway-xuan-weekly-private | Runtime objectCreator and objectViewer; objectUser only when resource.name equals projects/_/buckets/family-portfolio-gateway-xuan-weekly-private/objects/weekly/latest.html |
| family-portfolio-gateway-xuan-weekly-public | Runtime objectUser only when resource.name equals projects/_/buckets/family-portfolio-gateway-xuan-weekly-public/objects/weekly/latest.html; public objectViewer unchanged |
| xuan-weekly-trigger@family-portfolio-gateway.iam.gserviceaccount.com on existing job | roles/run.invoker; existing Scheduler `{}` request needs no overrides |
| Current authorized CLI execution identity (redacted) | Run v2 testIamPermissions verified run.jobs.run and run.jobs.runWithOverrides; no credentials inspected or printed |

All new immutable request, lease, weekly-counter and health objects are within the private bucket already authorized for object creation/read. Private/public latest writes remain their existing exact conditional objects. No new bucket, job, Scheduler, identity, secret, persistent credential or role is introduced. The code does not self-grant permissions.

## Full regression and sensitive diff inventory

Run `node --test --test-concurrency=2 scripts/*.test.mjs cloud/xuan-preopen/*.test.mjs` plus Python discovery in cloud/xuan-weekly. The final frozen PR records results. Existing 16 skips cover retired legacy page/operational prepare tests; no new skips. All recovery tests use synthetic stores/runners and no production financial request. Cases include explicit manual outside-window execution, invalid/mismatched/replayed manual request, public state change, no default window bypass, generation-zero conflict, shared manual/automatic reservations, real two-thread races, timeout/lease expiry, immutable weekly counter, permanent/auth/schema failures, archive-only publication and private/public receipt conflicts.

Every changed path is sensitive and requires `/require-specific-owner-approval`:

| Paths | Direct and indirect effects |
| --- | --- |
| cloud/xuan-weekly/recovery.py | New source-run decision logic, explicit manual mode, private control/lease reads and immutable writes, guarded archive republishing, public/private consistency verification; no notification adapter |
| cloud/xuan-weekly/test_recovery.py | Synthetic concurrency, authorization-input, timeout, source-retry and publication-boundary regression cases |
| cloud/xuan-weekly/weekly_job.py | Optional externally selected immutable prefix/stamp and shared deadline; existing direct run API, financial source identity/schema/date checks and generation-guarded publication remain |
| cloud/xuan-weekly/weekly.Dockerfile | Fixed controller ENTRYPOINT and explicit scheduled default; manual override contract changes |
| docs/xuan-weekly-runtime-permission-evidence-20261004.json | Sanitized existing roles/conditions, unchanged Scheduler and read-only execution permission result |
| docs/xuan-weekly-silent-recovery-draft-20261004.md | Runtime/approval/schedule/manual execution instructions |

No email channel, subscription, testing notification, owner approval comment, IAM repair or credential renewal is created. Safe outcomes remain in fixed logs/private health receipts only. Runtime failures are not silently represented as successful publication.

## Remaining release scope

After exact-head OWNER approval, protected merge and required checks: build/deploy the reviewed controller image to the existing job, preserve task count1/maxRetries0/timeout600/runtime identity and all existing source/publication configuration; then separately apply the reviewed existing-Scheduler cron expression. No deployment or Scheduler change is implied by opening this draft. Before merge, recheck main and exact head; any rebase/new commit invalidates head consent.

Limitations: legacy attempts without controller markers are not automatically reconstructed; unknown crash/OOM cannot self-classify as transient; conflicting private/public receipts fail closed; manual consent remains an operator/protected-workflow responsibility. This draft and its tests do not prove a deployed automatic recovery.

Sensitive registry maintenance: security/approval-tiers.json adds only this PR’s new paths to sensitiveFiles, because the complete tracked-file registry test requires explicit coverage. The 22 ordinary paths, classifier, protected prefixes and approval requirements are unchanged. This registry edit itself requires exact-head OWNER review; it grants no new ordinary authorization.
