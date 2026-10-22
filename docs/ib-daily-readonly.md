# IB daily read-only comparison candidate

This candidate compares complete IB quantities and native-currency cash with the existing Sharesight portfolio. It never places orders, writes a ledger, balances cash artificially, or reads Flex/mail/trade details. A completed match or completed difference report finishes that trading day. The existing Hong Kong Tuesday–Saturday 12:15 route makes the first attempt; 12:30 may retry only an incomplete attempt. Unknown source execution outcomes cannot be replayed automatically.

## Reviewable source and private configuration

The five modules under `cloud/ib-daily/worker/schwab_sync` are a minimal overlay on the existing private Python worker. `baseline.json` pins the production image and two original file hashes; `integration.patch` contains the complete app/route changes. No private base source, account identifiers, actual holdings, balances, client identifiers, raw captures or credentials are published here. The bindings file is intentionally incomplete and stops before constructing clients. The four initial security mappings remain pending independent evidence; ticker inference does not satisfy that requirement. The private completed binding and final built image must be included in a later concrete execution approval.

A later approved build must verify the two base hashes, apply `integration.patch` with `git apply --unidiff-zero` only after both base hashes match, copy only the five modules and the reviewed private bindings into the original package, and validate the full image without credentials/network. It must preserve the original unrelated broker routes and configuration. This PR neither runs that build nor uploads the private configuration.

The source snapshot entry reuses the existing IB client and reads positions/balances once. It uses an independent fixed `ib-daily-snapshot` job, never the orders CLI. The worker reads its generation/hash-bound receipt and snapshot, then uses the existing fixed Sharesight client for portfolio identity, holdings and cash. Native provider timestamps and observation windows remain separate; missing source timestamps are not invented. Differences expose only safe counts in logs and keep details in the existing private state.

## Credential compatibility and minimum permissions

The shared IB credential store uses one generation-conditional lease before loading, refreshing or saving. Ordinary expired loading can be reclaimed; uncertain refresh/save cannot. Existing orders/tool limits and publication code are unchanged. Old same-credential consumers bypass this lock: they must remain excluded or receive a separately approved compatible common-client update before concurrent use. This requirement does not restart action-report production, combine its publication approval with IB, or authorize changes to its schedules.

The read-only IAM inspection found these direct grant differences; no permissions were granted or probed:

- Original source identity: `storage.objects.get` and `storage.objects.delete` for only `report-check/ib-mcp-credential/lease.json` in the existing private source bucket. Object creation and original Secret access/version-add already exist. Delete permission is needed for generation-conditional overwrite; the code makes no DELETE request.
- Worker identity: `run.jobs.get/run/runWithOverrides` on only the new fixed job; `run.operations.get` for its returned operation; `secretmanager.versions.get` on only the original IB credential metadata; `storage.objects.get` for the fixed `report-check/ib-sync-.../{snapshot,receipt}.json` handoff. The worker receives no IB Secret payload access.
- Existing worker state-bucket CAS permissions remain sufficient. Existing action image-deployer grants do not authorize creating this job or updating the worker; use a separately approved existing deployment identity, not expanded runtime privileges.

The inspection covered explicit resource/project bindings, not group membership, all deny policies, or a proof that every proposed IAM condition is supported. Approval must bind any grant to its actual resource/condition. No new broad runtime role is proposed.

## Activation remains separate

Keep `IB_DAILY_MODE=off` until exact-head protection, mappings, scoped permissions, built image validation and a bounded live read-only acceptance have passed. No PR or merge approval itself authorizes source reads, ordinary OAuth/credential rotation, deployment, IAM changes, state writes or recurring costs. Existing two trade schedules can be reused unchanged; paused cash schedules and the shared Schwab schedule stay as they are.

A proposed first acceptance is one normal 12:15 execution, with two IB tools, three Sharesight GETs, at most one ordinary IB refresh/save and one necessary Sharesight token request. It may write three private source records, two existing-state CAS records and up to four shared-lease CAS transitions. A successful day must make 12:30 perform zero financial reads. Those bounds are a proposal, not execution authorization. On failure restore the original IB worker behavior first; preserve unknown claims/lease outcomes and never restore an unlocked consumer while the new consumer remains active.

Resource proposal: source task1/parallel1/retry0/75s/1CPU/512MiB; existing worker max1/600s/1CPU/512MiB. At 23 scheduled days plus one fallback each, the combined timeout budget is 31,050 vCPU-seconds and 15,525 GiB-seconds/month, before startup, builds, images, logs, private objects and retained Secret versions. Previous one-shot budgets are not reused and no recurring spending is approved here.

## Offline checks

Run `python3 cloud/ib-daily/test_daily_wiring.py -v`. Its transports, portfolio identity, quantities and cash are synthetic; socket/DNS are forbidden. Existing Cloud source tests cover concurrent lease contention, loading expiry, unknown refresh/save, ownership fencing, normal orders limits and no-repeat capture. The normal required CI retains its existing owner, identity, privacy and publication checks. Every new path is registered sensitive; `/require-specific-owner-approval` is mandatory for this PR.
