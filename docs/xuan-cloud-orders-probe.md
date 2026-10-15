# One current Cloud Run orders test

This candidate supplies an executable test that does not depend on the expired
October 13 diagnostic. It has not been deployed or run against IB. Offline tests
and website success are not evidence of cloud OAuth recovery.

`orders_probe.mjs` uses the original fixed Secret Manager IB credential store and
its existing client ID, `mcp.read`, protected IB-HK account association and account
scope validator. It calls only `get_account_orders`; there is no tools/list,
summary, positions, balances, trades, financial write or authorization-code flow.
If the existing access token needs its normal refresh, at most one original-client
refresh is allowed and the rotated credential must be saved by the original
store. No new client, grant, scope, encryption key or IAM binding is created.

## Frozen deployment and one execution

1. Obtain the exact-head OWNER approval for the reviewed signed source PR and
   pass the existing required checks. Build `OrdersProbe.Dockerfile` as
   `linux/amd64` using an existing authorized build identity. Pin and verify the
   resulting image digest and approved source provenance. Do not expand IAM or
   an existing build allowlist to get around a denied build.
2. Separately approve creation of **one unscheduled** Cloud Run job named
   `xuan-preopen-orders-probe`, project `family-portfolio-gateway`, region
   `asia-east2`, using only the existing
   `xuan-preopen-source@family-portfolio-gateway.iam.gserviceaccount.com` identity.
   Use the pinned image, one task, parallelism one, max retries zero, 75-second
   task timeout, one CPU and 512 MiB. Do not modify the normal report job, clocks,
   schedules, WIF providers or existing Secret Manager/GCS grants. Verify the
   actual identity, digest, command, arguments and limits before executing.
3. Supply exactly `--request` and a JSON object with `requestId`, `dataDate`,
   `expiresAt`. Use a fresh UUIDv4 for this approved operation; never use a prior
   acceptance ID/nonce. Date must equal the actual Hong Kong execution date;
   expiry must be in that same date and within 15 minutes. Keep the same request
   ID if preparation takes longer; do not replace a consumed ID to retry.
4. Execute the job once. The program requires the exact job name, task index 0,
   task count 1 and initial attempt 0 before creating IO capabilities. It checks
   the protected association, claims a create-only private start marker **before
   loading IB credentials**, and imposes a 45-second whole-attempt abort signal.
   There is at most one orders call and one optional normal token refresh.
5. Keep the unscheduled job and immutable evidence for review. No second run,
   automatic reconnect, credential replacement or new grant is authorized.

The Cloud Run runtime's task index/count/attempt variables and Linux architecture
requirements are documented in the official [container runtime contract](https://docs.cloud.google.com/run/docs/container-contract#environment_variables_for_jobs).

## Evidence and stop conditions

The new operation writes only under
`report-check/orders-probe-<requestId>/`: `start.json`, private `orders.json` on a
successful read, and one completion `receipt.json`. Storage uses the existing
create-only upload guard. It neither consumes nor deletes a daily/EOD marker.
Unknown marker-write outcome, an existing marker, retry attempt, expired request,
wrong job or changed account association stops without another source request.

The stdout result contains only fixed safe status/code/phase/category, times,
request/execution identifiers, whether IB was actually contacted and receipt
hash. It excludes credentials, account/order IDs, securities, amounts and raw
upstream error bodies. The full order response stays in the existing private
bucket. Public summaries and Pages are never written by the test.

`upstreamAttempted: false` is an infrastructure/preflight failure, not a fresh IB
authorization rejection. A genuine token/MCP rejection preserves the existing
`safeIbFailure` phase, HTTP status and closed error category. Only that actual
evidence can justify the user's failure-then-reconnect step; an offline test
named invalid_grant proves nothing about production. Source account fields, if
returned, must match the existing approved account. The existing owner-attested
association is preserved; absent response identifiers do not become a new
independent account-identity proof.

A passed test proves this bounded cloud read path, not complete order coverage,
cash availability, a finished four-card report or successful daily publication.

Minimum execution approval: build the exact approved head; create the one fixed
unscheduled job with the original runtime identity and existing grants; execute
one current-date operation including at most one normal existing-token refresh
and original-store persistence; retain only private evidence and safe results.
This does not approve a normal-report deployment, today's cancelled publication,
new grants, new keys, financial writes or an automatic retry/reconnect.
