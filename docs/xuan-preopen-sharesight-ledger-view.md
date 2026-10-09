# Proposed recovery: 開市前行動版（部分）

This is one explicit branch of the existing `xuan-preopen-report` job and the
existing protected publication pipeline. It is a sensitive downgrade requiring
specific OWNER approval of the complete final head and the operational commands.
No production action has been performed by this patch.

## What the partial report establishes

The report makes one fixed, read-only request to the existing Gateway:
`GET /v1/performance`, portfolio `IB-HK`, the previous completed NYSE date for
both `start_date` and `end_date`, grouping `83569`, `include_sales=false`.
It verifies the existing read-only Sharesight envelope, portfolio ID, USD,
classification group and returned date with the established parser.
The page retains the owner's name: “XUAN · 开市前行动版（部分）”. It states:
“Sharesight 当前记录的估值；可能未包含待同步交易；同步完成、IB 现金及交易覆盖未核实”.

Only grouped valuation and classification are displayed. Synchronization,
cash, trade coverage, live orders, buying power, holdings detail, returns and
action capabilities remain false. No cash amounts, zero-order claim, budget,
projected allocation or specific purchase plan is emitted. Cash reconciliation
remains pending. A discrepancy, however small, is not rounded, tolerated,
balanced or copied from an unrelated observation into this run.

The report's private receipt proves only that this Sharesight report was read
and saved: `sourceReadStatus=complete`, `syncCompletion=unverified`,
`status=partial`, mode `private_sharesight_ledger_view`. It is not a sync-completion
receipt or evidence that all broker events reached Sharesight. Existing successful
sync HTTP executions and source leases do not establish that missing evidence.
The sync layer remains the only ledger, reconciliation and history writer.
This change neither calls it nor creates a replacement.

## Explicit selection and unchanged identity boundaries

A fresh current-main lookup obtains the existing active account association and
`claude/xuan-ib-preopen-report-profile-v1.json`. The proposed profile is explicitly
`sharesight-ledger-view-v1`; changing its value to `normal` selects the original
full-report path. Missing, unknown or noncanonical profile fails closed. The
choice occurs before touching the IB store or refreshing OAuth. There is no
catch-all fallback after a broker failure and no artifact-selected profile.

The profile blob, current association and previous published source SHA are
checked again after the read and before candidate mutations. Dedicated public
schema10 is partial and binds the normalized allocation, source hash, read times,
profile and association into its existing evidence hash. The private receipt
also binds the saved source and exact HTML bytes. Delivery, publisher and trusted
guard require deterministic HTML and the same evidence; no new signing layer is
introduced. The existing five-minute read bound and thirty-minute publication
bound remain. The display calls capture time a read time, not upstream as-of.

The normal source module/model, cash and order calculations remain unchanged.
Schemas5/7/8 retain their contracts. The new publication kind
`sharesight-ledger-view` never counts as complete and cannot replace a same-day
complete report, verified broker readback, intraday update or priority report.
Higher evidence wins selection even if the partial commit is newer. A current
complete report may replace a partial report through the usual guarded pipeline.

Current account association expiry remains effective. It is not extended by this
patch; its current expiry is 2026-10-10 21:30 HKT. The next natural trading-day
run after expiry requires the owner's separate renewal.

## Same pipeline, today's controlled readback

The normal daily entry still creates `delivery/today/start.json` before financial
reads, then delivers HTML and receipt last. An existing start marker blocks
another daily run. Today's failed marker is neither removed nor overwritten.

The sole controlled private entry is the same image/job with exactly
`daily.mjs --ledger-readback`; it accepts no date, portfolio, endpoint, prefix,
credential, policy or publication argument. It requires the existing report-job
execution name. Today's eligible date and source date come from the unchanged
reviewed calendar. It reads the approved profile, performs one fixed Sharesight
GET, and creates raw source evidence under a generated `report-check/` prefix.
Only final HTML and a partial receipt are additionally created under
`delivery/today/ledger-view-<evidenceSha256>/`, each with `ifGenerationMatch=0`.
It never touches the original daily marker, HTML or receipt.

The existing `private_limited_readback_prefix` workflow input then selects that
computed delivery prefix. It performs exactly two object GETs; it cannot run a
job or fetch sources on that branch. Dedicated receipt/schema/prefix, source and
HTML hashes, current profile, association and freshness are checked before the
existing signed one-file candidate. The same Validate → Promote → Pages and
public byte readback remain mandatory. No new workflow input, event, schedule,
concurrency group, producer, clock image or persistent credential is created.
The same-run safe failure diagnostic hook is included independently.

## Build and operational approval boundary

Reuse the existing Cloud Build service, source bucket, build identity, Artifact
Registry repository, Cloud Run job and its existing source service account.
The observed current report-job image digest is
`sha256:3d677ad594c14f1b148924137aa16c6a7502891800041c5c3360df4cf8ead542`.
This is a rollback reference, not the proposed release digest.
`daily-build.yaml` builds only `Daily.Dockerfile` as `xuan-preopen-report` in the
existing `cloud-run-source-deploy` repository. Deploy the resulting immutable
`@sha256` digest, never a mutable tag. The image includes the profile/dependency
files; runtime authority still comes from fresh protected main.

Existing bucket readback confirms `xuan-preopen-source` has Storage Object
Creator and `xuan-preopen-delivery` has object GET only, conditioned on the exact
`delivery/` prefix in this private bucket; this covers the new nested final
artifacts. No bucket list/public grant is added. The existing worker loaded the
Gateway secret before its broker failure, so this source read reuses that grant.
The delivery identity retains existing job run/execution GET. No new permission
is requested by the code. Actual grants, source
service-account identity, task count1, retries0, arguments and current job image
must be read back before approved execution. Do not presume a missing permission
or grant it automatically. The delivery identity is not given run overrides.
The controlled argument requires the owner's existing operator identity.

There is currently no usable local gcloud/docker. Do not retry the rejected
Cloud Shell authorization. The owner may use the already available Cloud Build
and Cloud Run interfaces after approving the exact final head and concrete
operation set: build the reviewed source, update only this report job to the new
immutable digest, perform one controlled private readback, read back its fixed
artifact prefix, submit through the existing protected pipeline and verify the
public bytes. The source build/registry/job identities are reused; the Gateway
and sync deployments, IAM, secrets, clock/start-watch and schedules are untouched.

Command forms for that approved operator, not instructions already executed:

```text
gcloud builds submit --project=family-portfolio-gateway --config=cloud/xuan-preopen/daily-build.yaml --substitutions=_RELEASE=ledger-view-<FINAL_HEAD>
gcloud run jobs update xuan-preopen-report --project=family-portfolio-gateway --region=asia-east2 --image=<existing-registry-report-image>@sha256:<NEW_IMMUTABLE_DIGEST>
gcloud run jobs execute xuan-preopen-report --project=family-portfolio-gateway --region=asia-east2 --args=--ledger-readback --wait
```

The first operational approval covers the complete signed final head, the fixed
existing resources and this one build/deploy/controlled-readback/protected-publish
operation set. Its release digest and artifact prefix do not exist before those
approved operations. Only the build artifact produced from that approved head may
supply the immutable digest; verify its source binding and digest before updating
the job. Only the single approved execution's computed today's ledger-view prefix
may supply the readback input; verify its receipt, exact HTML hash, current profile
and association before protected publication. These results do not authorize a
second execution, another source, broader permissions or different resources.
No live operational approval or working local build submission client is claimed.
Do not execute, retry, publish or renew association merely because this code merges.
No successful build, cloud run, deployment or publication is claimed by offline
tests. Full repository tests and a separate image file-context test run without
network; neither substitutes for the approved live readback.
