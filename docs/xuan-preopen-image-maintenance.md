# Fixed report-image maintenance proposal

This candidate provides a GitHub-hosted Docker build and a fixed Cloud Run image
update without Cloud Shell, local gcloud/docker or service-account JSON. It does
not restore financial reporting by itself or repair the existing IB authorization
or unresolved synchronization evidence. It includes no source-model change,
partial Sharesight page, financial read, ledger write, report generation or
publication. The daily pipeline wiring, source identity, immutable start marker
and protected publisher retain their current code and contracts. Updating the job
image affects which approved code a future existing daily execution runs. There is no new schedule.

## Source approval and execution gates

This is sensitive maintenance. Review the complete signed final head, use the
existing `/approve-xuan-ib-maintenance <head>` OWNER gate and required checks, then
merge through the existing protected PR process. A verified signature alone is
not approval. Runtime preflight requires the exact owner-authored verified source
head, an OWNER comment matching that head on its merged PR, the fixed repository
and immutable owner IDs, main and an owner-triggered manual event. The live main
must equal that PR's merge commit. The merge tree must equal the approved source
tree. This accommodates a GitHub merge/squash commit without relabeling it as the
approved signed source; a concurrent main update stops maintenance. Rebase/review
instead of silently building a different source.

No new GitHub environment, reviewer or approval comment format is introduced.
The existing exact-head OWNER gate, protected main, immutable owner actor and
manual dispatch are the authorization boundary. The owner enables
`XUAN_PREOPEN_IMAGE_MAINTENANCE_ENABLED=true` only as part of the specifically
approved one-time infrastructure setup; that value is not approval by itself.
The input is only the approved 40-hex head and merged PR number: no
job, region, image, registry, command, source endpoint or permission override.
Both GitHub-hosted leaf jobs explicitly select Node24 using the official
`actions/setup-node` v6.0.0 commit
`2028fbc5c25fe9cf00d9f06a71cc4710d4507903`, with package-manager cache disabled.
This does not assume the runner's default Node version. The initial check runs
code from the trusted dispatch commit before any cloud identity. Only after verifying equal trees is the exact approved head checked
out. Source approval and clean checkout are rechecked before build/deploy and
again immediately before the sole Cloud Run mutation.

## Build and source-to-digest binding

The one manual entry calls fully qualified fixed build and deploy reusable
workflows at `@main`; their
GitHub-signed `job_workflow_ref` claims differ. Each provider binds its exact
callee as well as the exact caller workflow and requires
`job_workflow_sha == sha == workflow_sha`. Relative `./` calls guarantee the
caller's commit, but official documentation does not specify the claim's ref
suffix for that syntax; this candidate therefore uses the documented qualified
branch form. A callee resolved from another commit after main moves is rejected,
including when the caller/source preflight was previously valid. The builder cannot exchange its
OIDC token through the deployer provider merely by choosing its audience.

The builder uses only short-lived OIDC and the new, dedicated
`asia-east2-docker.pkg.dev/family-portfolio-gateway/xuan-preopen-maintenance`
repository. It cannot push to the shared `cloud-run-source-deploy` repository,
Gateway or sync images. A fixed Linux/amd64 `Maintenance.Dockerfile` retains the
normal `daily.mjs` entry, the existing runtime files and source logic. The official
Node24 Linux/amd64 base is pinned by digest, not resolved from a mutable tag:
`sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd`.
The official [Docker Hub tag metadata](https://hub.docker.com/v2/repositories/library/node/tags/24-bookworm-slim)
was read at 2026-10-09T09:46:09.516191Z; it identifies this Linux/amd64 image under Node24
bookworm-slim. A future base update requires a new reviewed source head. It runs
every cloud/night-action test except the two phone-page integration tests that
require historical HTML; the full repository suite still runs those tests.
The build context is a temporary directory containing only the fixed Docker COPY
closure, selected from the approved HEAD's tracked Git blob list and checked
against each exact Git blob hash and file mode. Ignored/untracked files are not
copied; symlinks (including parent directories) and special files reject; `.git`, `data.json`, historical pages,
host credentials and the temporary Docker login are excluded from that context.
Both Docker build and the Dockerfile test RUN use `--network=none`. Pulling the
pinned official base and pushing/verifying the dedicated registry remain the
only build network paths; source tests cannot reach a financial endpoint.

The image is labeled with the exact approved head, its full Git tree, approval
PR and protected merge commit. These are source bindings under the existing
approval model, not a new signature or completion receipt. Docker pushes an
immutable head tag; its digest is then read by fixed registry manifest/config
GETs. Both byte digests, the source labels, Linux/amd64 and the normal entry point
must match before that digest crosses to the deployer. The deployer independently
rechecks the same pushed bytes using its own read-only registry permission. No
mutable tag is deployed. An overwritten/colliding immutable tag is a failure,
not a reason to switch tags, registries or identities.

## Fixed REST deployment, readback and rollback evidence

Only `projects/family-portfolio-gateway/locations/asia-east2/jobs/xuan-preopen-report`
is read or updated. The source service account is exactly
`xuan-preopen-source@family-portfolio-gateway.iam.gserviceaccount.com`. The job
must have one container/task, parallelism one, retries zero, the normal default
entry/empty arguments and an immutable report-image digest. A ready, reconciled
generation and etag are required. ProtoJSON may omit the ordinary `reconciling`
boolean when false; absent/false are accepted, but null/string/number reject.
`maxRetries` is a presence-bearing oneof with default three when unset; it must
remain explicitly zero and is never inferred from an absent field. The existing image's full immutable URI is
recorded before mutation as the rollback target; configuration is represented in
logs only by a hash. Environment values and secret references remain in memory
and are never logged or uploaded as an artifact.

Cloud Run v2 `jobs.patch` has no `updateMask` parameter. The implementation copies
the original writable job configuration and complete execution template, changes
only its sole container image and sends the etag with `allowMissing=false`.
It never includes `startExecutionToken` or `runExecutionToken`. There is no create,
delete, `:run`, run override, execution or operations API route. It polls only the
same job, at most forty times, requiring a newer successful reconciled generation
and exact configuration equality except for the image. A delayed GET may return
the original ready generation/image; only the exact original configuration and
etag may wait within that same bound, never count as success. A change under the
old generation fails immediately; an old snapshot through the limit times out. Etag conflict, permission
failure, unexpected configuration, failed reconciliation or timeout stops without
retrying the mutation, starting a job or automatically rolling back.

The rollback digest is evidence, not automatic rollback authorization. If a
deployment fails, the owner can decide whether to restore that exact immutable
image with the same fixed-job/etag/config-preservation safeguards. This candidate
does not add an arbitrary-image rollback input. Deployment changes which reviewed
code a later existing daily run uses; it does not execute the image or remove
today's failed start marker. No successful build/deployment or true Cloud Run GET
JSON-shape acceptance is claimed by offline tests. Strict live preflight remains
an activation check.

## Exact proposed IAM and one-time setup

`security/xuan-preopen-maintenance-iam.json` specifies the proposed resources and
bindings. None is assumed created or granted. After explicit owner approval,
the owner creates the dedicated regional Docker repository with immutable tags,
two service accounts, two OIDC providers and four custom roles, then applies only
the listed resource bindings and verifies them. The workflow cannot perform this
bootstrap or modify IAM. Do not use the default compute Editor or grant a new
shared-registry Writer. The existing delivery identity retains only its existing
job-run/execution-get grant and receives no deployment privilege.

| Identity | Binding resource | Exact permissions |
| --- | --- | --- |
| `xuan-preopen-image-builder` | Dedicated regional repository | `artifactregistry.repositories.uploadArtifacts`, `artifactregistry.repositories.downloadArtifacts` |
| `xuan-preopen-image-deployer` | Dedicated regional repository | `artifactregistry.repositories.downloadArtifacts` |
| `xuan-preopen-image-deployer` | Fixed report job only | `run.jobs.get`, `run.jobs.update` |
| `xuan-preopen-image-deployer` | Fixed source service account only | `iam.serviceAccounts.actAs` |
| Each provider's dedicated principal set | Its corresponding builder/deployer service account only | Existing `roles/iam.workloadIdentityUser`: `iam.serviceAccounts.getAccessToken`, `iam.serviceAccounts.getOpenIdToken` |

Providers reuse the existing pool without changing the old providers. Each maps
its own constant namespace value `attribute.xuan_preopen_image_identity` to
`builder-v1` or `deployer-v1`; the corresponding SA binds only that principal set.
It does not bind the pool's generic repository attribute or `principalSet/*`.
Check that no existing provider maps this new attribute. Each provider restricts
repo ID `1334738755`, owner ID `283054367`, exact repository, main, owner actor ID,
`workflow_dispatch`, this exact caller `workflow_ref`, its distinct reusable `job_workflow_ref` and
the callee/caller/event SHA equality and its own fixed audience. `google.subject=assertion.sub` remains mapped, without assuming the legacy subject
string: newly created repositories can use GitHub's immutable subject format.
A cloud IAM administrator who changes a
provider/mapping can still change that trust boundary; the namespace is not a
substitute for protecting IAM administration. No Token Creator grant, key or
source-SA impersonation is added.

The existing same-project Cloud Run service agent already inherits its service
agent role. Verify that its current download permission covers the new repository;
do not blindly add another Reader. The owner needs existing infrastructure/IAM
administration rights for bootstrap, including repository create/setIamPolicy,
service-account create/setIamPolicy, custom-role create and provider create in
the existing pool, plus fixed-job setIamPolicy. Those powers are not delegated
to either workflow identity. Use existing owner administration; missing rights
are blockers, not automatic grants or a reason to weaken constraints.

IAM cannot express “only change the image field” for `run.jobs.update`, nor can
`actAs` prevent approved code from using the source identity's existing runtime
rights on a later scheduled execution. The safeguards are exact approved source,
owner-only manual dispatch, dedicated image scope, fixed configuration checks and
readback. A compromised approved workflow/deployer is a remaining code-deployment
risk. No financial source permission is added to either maintenance identity.

## Financial recovery remains a separate, evidence-driven change

Existing Sharesight performance fields can support recorded holdings quantity,
report price/value/currency, classification and eight period-return fields. The
observed report covers one market date and is not an annualized or broker-NAV
statement. Its two cash-account rows are recorded values; they do not establish
settled, available, frozen cash or buying power.

The inspected Flex statement covers the same ending date, five native currencies
and a base summary, ending cash/settled cash and FX-to-USD information. It has no
trade, position, open-order or NAV section. Interest/dividend/tax cash activity
does not prove trade coverage. Cash mapping items remain pending, and a small
cash discrepancy has no same-round destination receipt; it remains pending.

A useful future BASIC report should show verified holdings, period returns and
classification gaps; explicit hypothetical purchase-price/share scenarios must
account for the resulting denominator and cash need. Native-currency ending and
settled balances and their difference need faithful source semantics. These are
scenarios, never executable order instructions. Order commitments, CALL
commitments, current available/cross-account funds, transaction matching and a
cash destination receipt at the same cutoff remain unverified. Resolve those
source/semantic gaps and review the resulting report contract before a later
approved source-image release. A private archive object is known, but the report
source identity has no confirmed archive-consumer access. Its storage permission,
immutable source selection and same-cutoff ledger evidence would need separate
source-wiring review; this maintenance IAM does not grant archive access. This maintenance candidate neither hides them
behind a four-weight partial page nor fabricates sync completion.

Official [setup-node v6.0.0 release](https://github.com/actions/setup-node/releases/tag/v6.0.0) supplies the pinned action commit.

Official workflow-claim references:
[Reusable call syntax and same-commit semantics](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows),
[OIDC claim definitions](https://docs.github.com/en/actions/reference/security/oidc),
[Reusable workflow OIDC ref examples](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows).
No real token or online workflow has been requested to validate those claims.

Official API/permission references:
[Cloud Run job PATCH](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs/patch),
[ProtoJSON presence rules](https://protobuf.dev/programming-guides/json/#presence-and-default-values),
[Cloud Run TaskTemplate](https://docs.cloud.google.com/run/docs/reference/rest/v2/TaskTemplate),
[Job resource and reconciliation](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs),
[Cloud Run permissions](https://docs.cloud.google.com/run/docs/reference/iam/roles),
[Artifact Registry permissions](https://docs.cloud.google.com/iam/docs/roles-permissions/artifactregistry),
[GitHub signature verification](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification).
