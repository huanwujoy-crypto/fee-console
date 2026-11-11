# Manager refresh publication (default-inactive)

Status: code and synthetic tests only. Nothing here is deployed, enabled, or
evidence that any fee or ratio report was produced or published. No resource,
IAM binding, credential, schedule, workflow trigger or producer guard is
created or changed by this repository change.

## What the manager sees

Ordinary users: the `↻ 刷新` button is unchanged (`manualRefresh`).
Managers (`isMgr()`): the button opens a chooser — 管理费 / 比例管理 / 全选 —
with a real-data-date per kind, plus `仅重新读取（不发布）` that runs the
original refresh. In this release `MR_INTAKE_ORIGIN` is `null` (so `MANAGER_REFRESH_CLIENT` is not constructed) and
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
   Gist with the manager's existing Gist write ability (implemented in the
   UI PR as one reviewed `ghApi` allowance for exactly that file, read back
   for content and owner; inactive while `MR_INTAKE_ORIGIN` is `null`), then POSTs `{requestId, gistVersion}`.
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
   default) walks the whole queue (paginated). Idempotency comes from the
   job-only ledger, not from a flag set before the work: `done/<id>` is
   written only after the final projection is stored and skips a request
   for good; an existing batch is resumed (attempts reconciled from evidence
   only; a batch that claimed nothing starts only on a fresh re-proof,
   otherwise it is recorded `REQUEST_STALE`); a request without a batch is
   either stale (recorded without a Gist read and without using the
   per-execution work budget) or re-verified against the **real current
   time** (never `queuedAt`). A final outcome reached before any claim is
   stored create-only in the ledger (`batch/<id>/fee-blocked`), so status
   never falls back to waiting, and a final projection is never overwritten.
   Concurrency guarantees between executions:
   - **Ending vs dispatching**: each batch has one create-only gate,
     `batch/<id>/fee-gate`, holding either `{mode:'blocked'}` (ended: stale,
     already published elsewhere, lost race, …) or `{mode:'dispatch'}`. A
     claim may POST only after winning `dispatch`; if `blocked` won first, the
     claim is closed `RECONCILED_NOT_STARTED` without a POST.
   - **Temporarily unavailable is not stale**: 403/408/429/5xx on the owner
     proof is `VERIFY_UNAVAILABLE`; that execution writes nothing for the
     request and leaves it for the next wake. Only real elapsed time or an
     explicit stale proof ends it, and only through the gate.
   - **Final states never go back**: the final projection is written once to
     `status/<id>/final`; the intake GET always prefers it, so a slower
     execution's later non-final projection cannot make it look waiting.
   - **Lost run id stays frozen**: before the POST, a create-only
     `attempt-<n>-dispatching` record (mode `dispatch`) is won; the POST is
     sent only after winning it. The only accepted request->run association
     today is the dispatch response's own `workflow_run_id` (with matching
     `run_url`/`html_url`). Without it the attempt stays unknown and blocks
     the date: no time-window lookup, no adoption of a same-owner same-date
     run (its genuine run->candidate->main/Pages chain proves that run
     produced a result, not that this request did), and no "nothing found,
     so not started" verdict. It is released only by a verifiable
     association or by proof the dispatching executor can never send again
     (`executorTerminated`, not implemented: needs the executor identity in
     the record and read access to Cloud Run execution state) together with
     an idle pipeline and an unpublished date. Otherwise manual investigation.
     A claim that never wrote its dispatch record is voided after 2 minutes
     by winning that same key with `mode:'void'`, so a slow claimant can no
     longer POST.
   - **"Definitely not published" needs a fresh quiescent readback**: a
     failure verdict (`RUN_ENDED_UNPUBLISHED`, or `RECONCILED_NOT_STARTED`
     after proven executor termination) is never stitched from an earlier
     readback and a later idle state. It requires, in order: pipeline idle →
     a fresh readback showing the date not published on main A → pipeline
     idle again → main still A and still without the date. Any change returns
     no verdict for that round. Once idle holds (no unfinished fee run and no
     unincorporated candidate for the date) and this attempt's run has ended,
     nothing remains that could promote the date afterwards.
   - **Verifiable attempt id (not implemented, protected change)**: the
     minimal change that would make lost run ids recoverable is a new
     `workflow_dispatch` input on `fee-cloud-producer.yml` (e.g.
     `refresh_attempt`, a fixed-format id) echoed in its `run-name`, so the
     run's `display_title` carries the exact attempt id; the job would then
     associate only a run whose title equals it. This touches the protected
     producer and needs its own review; until then lost run ids stay frozen.
   It then runs the coordinator: claim, dispatch the existing producer
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

### Page ↔ intake response contract

- POST `/v1/requests` → `202 {requestId, state: queued|duplicate|unknown}`,
  or a rejection `{requestId?, state:'rejected', code}` (400/403/503) which
  guarantees that this call queued nothing.
- GET `/v1/requests/<id>` → the job's final projection; else its latest
  non-final projection; else `{state:'queued'}` (received, no projection
  yet) or `{state:'not-received'}` (no queue entry).
- The page clears a pending request only with proof it was not queued and
  not started: a failure before any POST; a rejection of the first POST; or
  `not-received` more than 12 minutes after the last POST (a late POST is
  refused as stale, and a queued stale request is never executed by the
  job). Or on the job's own final projection. A rejected re-delivery,
  `queued`, a missing projection or a non-final state keeps it pending and
  never reports the original as not executed. Re-delivery (same id and Gist
  version only) happens only within 9 minutes of the last POST.

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

## Minimal-privilege deployment (nothing here is done; each step needs the named approval)

| # | Step | Scope / permission | Approval |
|---|------|--------------------|----------|
| 0 | Read-only checks above (`roles/run.invoker` contents, job-log redirect host, real log group shape) | read only | coordinator |
| 1 | Merge support PR, then UI PR (exact head) | code only, default off | owner, exact-head OWNER |
| 2 | Create buckets `family-portfolio-gateway-fee-refresh-{queue,ledger,status}` (+ `-acceptance` copies for step 9), asia-east2, uniform access, public access prevention; ledger: **no lifecycle**, no runtime delete grant | storage | owner (new resources) |
| 3 | SA `fee-refresh-intake@`: objectCreator + objectViewer on queue (read lets GET tell `queued` from `not-received`), objectViewer on status; nothing on ledger | bucket-level IAM | owner (IAM) |
| 4 | Intake start permission on job `fee-refresh-launch` only: `run.jobs.run` without `run.jobs.runWithOverrides` (custom role if `roles/run.invoker` includes overrides) | job-level IAM | owner (IAM) |
| 5 | SA `fee-refresh-launch@`: objectViewer on queue; objectCreator+objectViewer on ledger; objectCreator on status | bucket-level IAM | owner (IAM) |
| 6 | Job credential: owner enters a new fine-grained token (this repository; Actions read/write only) as a secret readable only by SA 5. Alternative: reuse `fee-clock-github-actions` (second identity on a repository-wide Actions-write token) | secret | owner (credential; owner enters it personally) |
| 7 | Deploy job `fee-refresh-launch` (verified image digest, `node scripts/fee-manager-refresh-entry.mjs job`, maxRetries 0, timeout 20 min, `FEE_REFRESH_MODE=acceptance`, `-acceptance` buckets) | deploy | owner (deploy) |
| 8 | Deploy service `fee-refresh-intake` (`… serve`, public invoker, max instances 1, no secret, no ledger env, acceptance buckets) | deploy | owner (deploy) |
| 9 | Isolated acceptance (below) | — | coordinator; owner observes |
| 10 | Security-policy PR adding the exact intake origin to `security/allowed-origins.txt`, and an index-only PR setting `MR_INTAKE_ORIGIN` to that literal | page now calls the service | owner, exact-head OWNER |
| 11 | Switch job and service to production buckets, then `FEE_REFRESH_MODE=launch` | enables real dispatch | owner, separately, for a named first date |

No schedule is added: the job runs only when the intake starts it (no
overrides). Ratio remains disabled (`MR_RATIO_READY=false`, no collector or
publisher wired).

## Isolated acceptance (no fee production)

In acceptance mode the publisher refuses before any dispatch (enforced by
code; buckets must end in `-acceptance`, enforced by `readConfig`).

1. Temporarily point a non-production copy of the page (not the published
   site) at the acceptance intake, or call it with a synthetic request whose
   file the owner writes into the ledger Gist.
2. Check: wrong origin → 403; stale or edited Gist → `REQUEST_STALE` /
   `IDENTITY_UNVERIFIED`; duplicate POST → `duplicate`, no extra job start;
   two quick requests → at most one job start per minute; status GET has no
   side effect; final status stays final.
3. Check the full path ends with `PUBLISHER_REFUSED` and that
   `fee-cloud-producer.yml` shows no new run.
4. Through the job (server side only), read one recent completed producer
   run's job log: confirm the redirect host is in `LOG_HOSTS` and that the
   `Create a signed owner candidate` group matches the workflow script.
5. Record results; only then consider step 10–11.

## When the outcome is unknown: freeze and reconcile

What is implemented:

- Every unknown (claim write unknown, dispatch reply without a verifiable
  run id, start error, readback unavailable) leaves the attempt **in flight**.
  The date is frozen: no new claim, no dispatch, no success, no failure.
  The page keeps the request pending and shows that the result is not yet
  confirmable; it never resends a new request.
- Each later job execution re-observes only from evidence: with the
  attempt's own run id it records `published` (readback + provenance) or,
  after a quiescent bracket, `RUN_ENDED_UNPUBLISHED` (retryable).
- A claim that never wrote its dispatch record is voided after 2 minutes
  (it can then never POST) and closed `RECONCILED_NOT_STARTED`.

What is NOT implemented (no automatic recovery):

- A dispatch whose run id was lost stays frozen indefinitely. There is no
  time-window adoption and no "nothing found" verdict. `executorTerminated`
  is only a hook; it needs the executor identity in the record and Cloud Run
  execution read access, neither of which exists.
- Manual reconciliation, by the coordinator with owner approval: read the
  producer runs and candidates for the date; if a run is proven to be this
  attempt's (e.g. by its exact dispatch time and the job's own logs), record
  that through a separately reviewed operation; otherwise leave the date
  frozen or have the owner decide. Never delete or overwrite ledger objects.
- The protected change that would make lost run ids recoverable
  automatically (attempt id in `run-name`) is described above, not made.

## Security review dependencies

- Exact-head OWNER approval of the support PR and the UI PR.
- Review of `verifyOwnerRequest` (identity), the batch gate, the dispatch
  record/void arbitration, the quiescent failure bracket and the provenance
  chain (run → job → trusted command group → candidate → promotion).
- Review of the new `ghApi` allowance `reviewedRefreshRequest` (one file,
  exact body, verified owner, no draft) and its effect: each request adds a
  revision to the ledger Gist.

## Shared test files changed for the UI page pin (test-only)

Registered the page hash `04173d4bb38b236d8c09e6ce51d26daf9c0f0c324db7aab23a8b782c1a44b836`
(build 4.9.54, UI branch head) by appending, never replacing, existing entries:

- `scripts/fixtures/fee-ratio-aggregate-returns-ui.json` — `nextSha256` →
  new page; `supportSha256` → previous main page `8a5a9671…685d`;
  `supportRegionCount` 88 → 92 (all existing regions); 9 appended regions named
  `manager-refresh-chooser`.
- `scripts/fee-ratio-aggregate-ui-fixture.mjs` — the fixture file hash only.
- `scripts/fee-receipt-ui-contract.test.mjs` — `MANAGER_REFRESH_CHOOSER_UI_SHA256`
  added to the reviewed-stage list.
- `scripts/ui-flows.test.mjs` (2 lists), `scripts/fee-gift-registry-status.test.mjs`
  (1 list) — new hash appended.
- `scripts/ib-manager-return.test.mjs` — build list extended to 4.9.54.
