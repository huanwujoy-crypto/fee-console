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

## Proposed server shape (scripts/fee-manager-refresh-server.mjs, -entry.mjs)

Isolated from the existing fee clock: its own buckets, its own job, no use of
`fee-clock-launch`, of `runWithOverrides`, or of the 90-day clock bucket.

Buckets (bucket-level IAM only; no IAM conditions, because an objects.list
`prefix` is not an IAM resource restriction):

| bucket | intake SA | job SA |
|---|---|---|
| `…-fee-refresh-queue` (`queue/`, `wake/`) | objectCreator | objectViewer |
| `…-fee-refresh-ledger` (claims, attempts, `published`, `processed`) — **no lifecycle rule** | none | objectCreator + objectViewer |
| `…-fee-refresh-status` (redacted projections) | objectViewer | objectCreator |

1. Browser writes `fee-manager-refresh-request.json` into the existing ledger
   Gist with the manager's existing Gist write ability (activation-stage page
   change, not in this release), then POSTs `{requestId, gistVersion}`.
   No token leaves the browser; the browser holds no Actions token.
2. Intake (CORS exactly `https://huanwujoy-crypto.github.io`; CORS is not
   authentication) makes **one** anonymous read of the ONE configured Gist and
   requires owner 283054367, private, the given version is the latest
   revision committed by the owner within 10 minutes of the real time, exact
   request schema, matching `requestId`, fresh `createdAt`, data date inside
   the promotion window (≤ 4 HKT days old). Rate limit (403/429) is
   `VERIFY_UNAVAILABLE`, never success. It writes `queue/<requestId>`
   create-only. Only a newly created entry may wake the job, and at most once
   per minute (create-only `wake/<UTC minute>`); duplicates never wake. GET
   reads only the latest status projection; it has no side effect.
3. Job (fixed image digest, fixed args, no overrides, mode `disabled` by
   default) re-verifies each queued request against the **real current time**
   (never `queuedAt`), marks it `processed/` create-only before any side
   effect, then runs the coordinator: claim, dispatch the existing producer
   with exactly the existing reviewed completed-sync inputs and
   `return_run_details`, wait, verify, record, project status. Stale, forged
   or invalid entries are recorded once and never executed. 204 without a run
   id, 403/429 and 5xx are `START_UNKNOWN` (never resent). The dispatch pins
   `X-GitHub-Api-Version: 2026-03-10` and accepts a run only when
   `workflow_run_id`, `run_url` and `html_url` all name this repository's run,
   matching the reviewed clock dispatcher (`cloud/fee-clock/runtime.py`
   `_dispatch`). Any other 200 body is unknown. Deliberate difference: the
   clock treats 403 as a definite failure; here 403 may be a secondary rate
   limit, so it stays unknown and is never resent.

A queued request whose wake was lost stays `queued`; once it is older than 10
minutes the next execution records `REQUEST_STALE` and nothing runs, so the
manager confirms again. In-flight attempts are reconciled only by the job.

### Provenance (run → candidate → promotion)

Implemented without changing the producer, from evidence GitHub records:
producer run (dispatched, attempt 1, owner actor, main, success) → its single
`Produce daily <date>` job and successful `Create a signed owner candidate`
step → the trusted command group: the exact `run:` script of that step,
read from `.github/workflows/fee-cloud-producer.yml` at the run's own head
commit → the job log (server-side Actions read) must contain exactly one
`##[group]Run <first script line>` group whose ANSI-echoed command lines
equal that script line for line, and exactly one `candidate <sha>` line in
the whole log, after that group's `##[endgroup]`, before the next group,
timestamped within the step's own `started_at`..`completed_at` (±1 s for
second precision) → that commit is signed, owner-authored,
committer owner/web-flow, sole parent = run head, subject `daily <date>`,
pointed to by exactly one `codex/fee-daily-<yyyymmdd>-xxxxxx` branch → main
contains that very commit (promotion fast-forwards). Any missing, duplicate
or ambiguous link is blocked (`PROVENANCE_UNBOUND`), never success.

The real shape was confirmed read-only on job 129766463139 (run
42797516508, Produce daily 2026-11-09): header `##[group]Run set -euo
pipefail`, ANSI-wrapped `node scripts/fee-cloud-commit.mjs` echo, then
`candidate <sha>` four seconds later. The test fixture keeps those three
observed lines; its other echo/shell/env lines are reconstructed from the
standard format and must be confirmed against the real log in acceptance.

Unverified link: the job-log endpoint redirects to a pre-signed storage URL.
The client follows one redirect only to `productionresultssa<N>.blob.core.windows.net`
or `results-receiver.actions.githubusercontent.com`, with no credential. The
real live host is not verified here; any other host blocks provenance.

Fallback if logs prove unavailable (protected-producer change, separately
reviewed, NOT made here): `scripts/fee-cloud-commit.mjs` adds the commit body
`Fee-Producer-Run: ${GITHUB_RUN_ID}` and `scripts/fee-cloud-producer.mjs:174`
accepts exactly that body after `daily <date>`.

### GitHub API budget per button flow

| actor | reads | identity |
|---|---|---|
| intake | 1 Gist read per new request | anonymous (60/h per egress IP) |
| job, admission | 1 Gist read + main ref + 2 file reads | job credential, public reads |
| job, per 60 s poll (≤15) | main ref ×2, run status; file reads only when main changes (per-sha cache); Pages 2 (not API) | job credential |
| job, end of run | provenance ≈ 9; pipelineIdle 1–4 | job credential |

Roughly ≤ 80 authenticated reads per flow against 5,000/h, using the job's
existing credential for public resources only (no added permission). The
intake never holds it. Any rate-limited read is an unknown, never success.

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

| # | Action |
|---|--------|
| 1 | Create buckets `family-portfolio-gateway-fee-refresh-queue`, `-ledger`, `-status` (asia-east2, uniform access, public access prevention). Ledger: **no lifecycle**. Queue/status: lifecycle optional (losing them only makes a request stale). |
| 2 | Create SA `fee-refresh-intake@family-portfolio-gateway.iam.gserviceaccount.com`: `roles/storage.objectCreator` on the queue bucket; `roles/storage.objectViewer` on the status bucket. Nothing on the ledger. |
| 3 | Grant SA 2 the start-only permission on job `fee-refresh-launch` only. First check `gcloud iam roles describe roles/run.invoker`: if it lists `run.jobs.runWithOverrides`, do not use it; create a custom role with only `run.jobs.run` (+ `run.executions.get` not needed). |
| 4 | Create SA `fee-refresh-launch@…`: objectViewer on queue; objectCreator + objectViewer on ledger; objectCreator on status. |
| 5 | Credential for SA 4 (owner choice): (a) `roles/secretmanager.secretAccessor` on existing `fee-clock-github-actions`, making a second identity use that repository-wide Actions-write token; or (b, recommended) the owner enters a new fine-grained token (this repository; Actions read/write; nothing else) as a new secret readable only by SA 4. Job logs need Actions read, which this token has. |
| 6 | Create job `fee-refresh-launch`: verified image digest, command `node scripts/fee-manager-refresh-entry.mjs job`, maxRetries 0, parallelism 1, task timeout 20 min, SA 4, secret mounted at `/secrets/github/token`, env `FEE_REFRESH_MODE=acceptance` first, `FEE_REFRESH_GIST_ID`, three bucket names. |
| 7 | Create service `fee-refresh-intake`: command `… entry.mjs serve`, SA 2, public invoker (`--allow-unauthenticated`), max instances 1, no secret, no ledger env. |
| 8 | Separate security-policy PR adding the exact intake origin to `security/allowed-origins.txt`. |
| 9 | Activation-stage `index.html` PR: request-file Gist write (a new reviewed `ghApi` PATCH allowance for exactly that file) and the `MANAGER_REFRESH_INTAKE` client. Cannot be finished before 7–8 give a real origin. |
| 10 | After acceptance, change only `FEE_REFRESH_MODE` to `launch`, with separate approval. |

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
2. Deployed acceptance (after approval): `FEE_REFRESH_MODE=acceptance` with
   `-acceptance` buckets (enforced by `readConfig`). The publisher refuses
   before any dispatch, so identity, origin, queue, wake limit, claim,
   duplicate, concurrent, stale and status paths run with zero producer runs.
   Also read one recent completed producer run's job log through the job to
   confirm the log redirect host. Verify with `gcloud run jobs executions
   list` and that `fee-cloud-producer.yml` has no new run.
3. Only then a separately approved first real fee date in `launch` mode.

Still not implemented: the activation-stage page client (item 9), container
image build/digest, and any deployment.

## Shared test files changed for the UI page pin (test-only)

Registered the page hash `5da8b0566a04bfa72ac3b8215139f067b9ce34233ecd9aea6c3d0ceb73d22769`
(build 4.9.54, UI branch head) by appending, never replacing, existing entries:

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
