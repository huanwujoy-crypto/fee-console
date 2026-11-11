# Manager refresh publication (default-inactive)

Status: code and synthetic tests only. Nothing here is deployed, enabled, or
evidence that any fee or ratio report was produced or published. No resource,
IAM binding, credential, schedule, workflow trigger or producer guard is
created or changed by this repository change.

## What the manager sees

Ordinary users: the `↻ 刷新` button is unchanged (`manualRefresh`).
Managers (`isMgr()`): the button opens a chooser — 管理费 / 比例管理 / 全选 —
with a real-data-date per kind, plus `仅重新读取（不发布）` that runs the
original refresh. In this release `MANAGER_REFRESH_INTAKE` is `null` and
`MR_RATIO_READY` is `false`: publishing is disabled with a visible reason and
nothing is simulated. A sent request is remembered before the network call,
so a reload or lost reply never resends it.

## Guarantees (scripts/fee-manager-refresh.mjs)

- Unique success: `fee-manager-refresh-v1/<kind>/<real data date>/published`
  is created once, only after (1) the protected chain's own bytes on main and
  Pages match, and (2) those bytes are the provenance of THIS attempt's
  producer run, its single signed candidate and its promotion commit. A later
  main that merely covers the same date is not this success.
- Every execution first wins an atomic create-only `attempt-<n>` claim. Lost
  races, unknown create results and unresolved earlier attempts stop before
  any side effect. Unknown outcomes are never retried; only evidence-based
  reconcile closes them (`published`, or `failed` when the run has ended, main
  lacks the date and no producer/validate/promote run or candidate is pending).
- Definite pre-publication failure (refused dispatch, cancel before start,
  run ended unpublished) is retryable, at most 5 attempts per kind/date.
- A date already on main by any other path is refused, not re-published.
- Fee and ratio keep their own real data dates. Ratio runs only inside the
  same batch after that batch's fee is verified published (select-all, or an
  explicit `resume-ratio` of that batch). Ratio-only never binds to another
  batch's fee. Ratio failure never restarts fee.
- Ratio collector contract (`collect({dataAsOf,requestId,signal})`):
  `blocked` with `RATIO_COLLECTOR_NOT_CONFIGURED` (default),
  `BLOCKED_UNSUPPORTED_EXPOSURE` or `NEEDS_SOURCE_EXPORT`; `failed`; or
  `success` with `COLLECTED_NOT_PUBLISHED`, three sources
  (`classification`/`exposure`/`performance`) each with its own `reportDate`
  ≤ `dataAsOf`, `exports` of `{role, sha256}`, and `manifestSha256` (a safety
  digest of metadata, not source authentication). Collection is an external
  read plus local writes, never publication. No ratio publisher is wired:
  a collected result stops at `RATIO_PUBLISHER_NOT_CONFIGURED`.

## Proposed server shape (scripts/fee-manager-refresh-server.mjs)

Isolated from the existing fee clock: its own bucket, its own job, no use of
`fee-clock-launch`, its overrides, or its 90-day bucket.

1. Browser writes `fee-manager-refresh-request.json` into the existing ledger
   Gist with the manager's existing Gist write ability (activation-stage page
   change, not in this release), then POSTs `{requestId, gistVersion}` to the
   intake. No token leaves the browser; the browser holds no Actions token.
2. Intake (public Cloud Run service, CORS exactly `https://huanwujoy-crypto.github.io`;
   CORS is not authentication) reads the ONE configured Gist anonymously and
   requires: owner id 283054367, private, the given version is the latest
   revision and was committed by the owner within 10 minutes, request schema
   exact, `requestId` match, `createdAt` fresh. The caller cannot name a Gist
   or URL. It writes `queue/<requestId>` create-only and starts the fixed Job
   with **no overrides**. Replies carry only fixed codes, states and dates.
3. Job (fixed image digest, fixed args, no overrides) re-verifies each queued
   request independently, then runs the coordinator: claim, dispatch the
   existing producer with exactly the existing reviewed completed-sync inputs
   (`run_reviewed_once`, `report_kind=daily`, `report_target`,
   `manual_sync_completed_for`, `confirmed_main`) and `return_run_details`,
   wait, verify, record. 204 without a run id is `START_UNKNOWN` (never resent).
   The producer keeps every existing actor, main, source and publication gate;
   the dispatch actor is the credential's owner, so no guard is relaxed.

The status GET may start another Job execution (no overrides) to reconcile.

## Live facts reported by the coordinator (read-only, 2026-11-11 HKT)

Recorded as reported; this repository did not observe them itself.

- `fee-clock-launch` exists in `family-portfolio-gateway` / `asia-east2`,
  image `…/fee-clock@sha256:f57c9d0e46a0812c6d424649bbedc9ead9e1e8b46e5799861a949c6db0deb99f`,
  args `launch`, `FEE_CLOCK_ENABLED=true`, maxRetries 0, timeout 120 s,
  service account `fee-clock-launch@…`.
- Execution `fee-clock-launch-kss8b` 2026-11-11 09:00:13 HKT logged
  `FEE_CLOCK_LIST_INCOMPLETE` and exited 1 with no retry. In repository
  source scheduled `launch` calls `inspect_runs` both before `store.claim`
  (`cloud/fee-clock/clock.py:241`, claim at line 278) and again after it
  (line 285); `complete_list` (line 113) or `runtime.py:33` can raise
  `LIST_INCOMPLETE` at either point. The log therefore does **not** show
  whether the target intent was written. The existing claim state is
  unverified: never clear, reset, overwrite or retry it.
- Artifact Registry tags this digest `clock-probe-68bd0a1-20261110-0915`
  (built 2026-11-10 17:13:55 HKT). The tag is a source hint only, not image
  provenance; build attestation could not be read (API disabled, not enabled).
- `family-portfolio-gateway-fee-clock` deletes every object older than 90
  days; launch SA has objectCreator+objectViewer, check SA objectViewer.
  It therefore cannot hold a permanent success limit and is not used here.
- No `fee-refresh`/intake Cloud Run service exists.
- Whether the live image contains `launch-confirmed` is **blocked**: no
  verified digest-to-source provenance exists (tag hint `68bd0a1` only). This design does not need
  it (it does not use `fee-clock-launch`).

## Read-only checks for the coordinator (no writes, no secret values)

```
gcloud run jobs describe fee-clock-launch --project=family-portfolio-gateway --region=asia-east2 --format=yaml
gcloud run jobs get-iam-policy fee-clock-launch --project=family-portfolio-gateway --region=asia-east2
gcloud run services list --project=family-portfolio-gateway --region=asia-east2
gcloud artifacts docker images describe asia-east2-docker.pkg.dev/family-portfolio-gateway/cloud-run-source-deploy/fee-clock@sha256:f57c9d0e46a0812c6d424649bbedc9ead9e1e8b46e5799861a949c6db0deb99f --show-provenance --format=json
gcloud builds list --project=family-portfolio-gateway --region=asia-east2 --filter="results.images.digest=sha256:f57c9d0e46a0812c6d424649bbedc9ead9e1e8b46e5799861a949c6db0deb99f" --format="value(id,source,substitutions)"
gcloud storage buckets describe gs://family-portfolio-gateway-fee-clock --format="yaml(lifecycle_config,retention_policy,iam_configuration)"
gcloud storage buckets get-iam-policy gs://family-portfolio-gateway-fee-clock
gcloud storage ls gs://family-portfolio-gateway-fee-clock/v1/intent/
gcloud secrets describe fee-clock-github-actions --project=family-portfolio-gateway
gcloud secrets get-iam-policy fee-clock-github-actions --project=family-portfolio-gateway
gcloud iam service-accounts list --project=family-portfolio-gateway --filter="email~fee-"
gcloud projects get-iam-policy family-portfolio-gateway --flatten="bindings[].members" --filter="bindings.members~fee-clock" --format="table(bindings.role,bindings.members)"
gcloud iam roles describe roles/run.invoker --format="value(includedPermissions)"
gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="fee-clock-launch" AND labels."run.googleapis.com/execution_name"="fee-clock-launch-kss8b"' --project=family-portfolio-gateway --limit=50 --format=json
```

`gcloud secrets describe` returns metadata only; never run `versions access`.
The `ls …/v1/intent/` line shows whether an intent object exists; list names
only, do not `cat`, and never delete, overwrite or retry based on it.

## Exact permission and deployment actions still requiring approval

None is performed by this change. Each is a separate owner decision.

| # | Action | Scope |
|---|--------|-------|
| 1 | Create bucket `family-portfolio-gateway-fee-refresh` (asia-east2, uniform access, public access prevention, **no lifecycle rule**, no delete grant to any runtime) | permanent per-date success/claim ledger |
| 2 | Create SA `fee-refresh-intake@…`; grant `roles/storage.objectCreator` + `roles/storage.objectViewer` on bucket 1 only (IAM condition `resource.name.startsWith("projects/_/buckets/family-portfolio-gateway-fee-refresh/objects/fee-manager-refresh-v1/")`) | queue + status read |
| 3 | Grant SA 2 `roles/run.invoker` on job `fee-refresh-launch` only — **after** confirming with the `roles/run.invoker` describe above that it lacks `run.jobs.runWithOverrides`; if it includes it, stop and use a custom role with only `run.jobs.run` | start fixed job, no overrides |
| 4 | Create SA `fee-refresh-launch@…`; grant objectCreator + objectViewer on bucket 1 only | ledger |
| 5 | Credential for producer dispatch: either (a) grant SA 4 `roles/secretmanager.secretAccessor` on existing `fee-clock-github-actions` (second identity using a repository-wide Actions-write token), or (b) owner enters a new fine-grained token (this repository, Actions write only) as a new secret accessible to SA 4 only. (b) keeps the clock credential isolated | owner choice |
| 6 | Create job `fee-refresh-launch`: verified image digest, args `refresh-job`, maxRetries 0, parallelism 1, timeout 20 min, SA 4, secret mounted as a file; env `FEE_REFRESH_GIST_ID`, `FEE_REFRESH_BUCKET` | fixed execution |
| 7 | Create service `fee-refresh-intake`: SA 2, `--allow-unauthenticated` (public invoker), max instances 1, request body ≤ 512 B, env as above, no secret | public entry |
| 8 | Separate security-policy PR adding the exact intake origin to `security/allowed-origins.txt` | page may call it |
| 9 | Activation-stage `index.html` PR: request-file Gist write (new reviewed `ghApi` PATCH allowance for exactly that file) and `MANAGER_REFRESH_INTAKE` client | page |

Residual risks for review: the intake is public (rate limiting and Gist-API
quota exhaustion can deny service but cannot publish); anonymous Gist reads
are rate-limited per egress IP (a failed read is a refusal, never success);
whoever controls the owner's Gist write token can request publication — the
same authority that already edits the ledger; an Actions-write token is
repository-wide (GitHub cannot narrow it to one workflow).

## Security review dependencies

- Exact-head OWNER approval of the support PR (new files under `scripts/`
  and `docs/`, `scripts-check.yml`, shared UI test pins) and, separately, of
  the index-only UI PR (merge after support).
- Review of `verifyOwnerRequest` as the identity proof, and of the
  provenance chain (run → single candidate → promotion bytes).
- Activation additionally needs the deployment code (container entry
  points for `handleIntake` and `runRefreshJob`), image build and digest
  verification, and items 1–9 above.

## Acceptance without real production

1. Synthetic: `node --test scripts/fee-manager-refresh*.test.mjs`.
2. Deployed acceptance mode (after approval): job env
   `FEE_REFRESH_MODE=acceptance` uses the prefix `acceptance/` and a
   publisher that refuses before dispatch (`PUBLISHER_REFUSED`) — exercises
   identity, origin, queue, claim, duplicate, concurrent and status paths
   with zero producer runs. Verify with `gcloud run jobs executions list` and
   that `fee-cloud-producer.yml` has no new run.
3. Only then a separately approved first real fee date.

Not implemented yet: the container entry points, acceptance-mode switch,
and the activation-stage page client (items 6, 7, 9 and step 2).

## Shared test files changed for the UI page pin (test-only)

Registered the new page hash `32b6c1f901ad3e76fee36aee36d16e99a39d439b12a903791b6665bf546b1d31`
(build 4.9.54) by appending, never replacing, existing entries:

- `scripts/fixtures/fee-ratio-aggregate-returns-ui.json` — `nextSha256` →
  new page; `supportSha256` → previous main page `8a5a9671…685d`;
  `supportRegionCount` 88 → 92 (all existing regions); 7 appended regions (99 total) named
  `manager-refresh-chooser`.
- `scripts/fee-ratio-aggregate-ui-fixture.mjs` — the fixture file hash only.
- `scripts/fee-receipt-ui-contract.test.mjs` — `MANAGER_REFRESH_CHOOSER_UI_SHA256`
  added to the reviewed-stage list.
- `scripts/ui-flows.test.mjs` (2 lists), `scripts/fee-gift-registry-status.test.mjs`
  (1 list) — new hash appended.
- `scripts/ib-manager-return.test.mjs` — build list extended to 4.9.54.
