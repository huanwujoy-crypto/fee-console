# IB-ORDERS-OAUTH-BOOTSTRAP-LOCAL-v1

This is local preparation, not approval to register, authorize, write a Secret,
deploy, change permissions, or run a financial request. The user's direction is
one owner-driven Mac authorization for a new cloud-only read-only orders grant;
the existing Mac connector is a fallback and may be replaced by the new consent.
Direction approval is not the final operation approval below.

## R3 timing and refresh compatibility correction

R2 remains an immutable NO-GO review artifact. R3 implements the parent's latest
instruction: ten minutes bounds callback admission, followed by one independent
40-second finalization window (exchange at most 15 seconds, maintenance proof at
most 5 seconds, write at most 20 seconds). Expiry after admission is a distinct
`BOOTSTRAP_FINALIZATION_EXPIRED`; unknown side effects never trigger a retry.
This replaces R2's ten-minute total-session interpretation. A timely accepted
callback is not aborted merely because the admission deadline passes.

A refresh response may omit `refresh_token`; the unchanged `ib_mcp` loader retains
only the token in the already validated client/version binding and saves the
updated credential as a new acknowledged version before orders. A present null,
empty, whitespace or non-string refresh token is rejected. Initial authorization
code responses still require both access and refresh tokens. No old Mac grant,
other Secret or unbound/latest credential is read to fill missing initial data.

## Frozen source and scope

Prepared from protected main `e226faae769aa920afdda977ca6173490ae63966`.
Only these seven repository paths may differ:

1. `scripts/xuan-ib-cloud-oauth-bootstrap.mjs`
2. `scripts/xuan-ib-cloud-oauth-bootstrap.test.mjs`
3. `cloud/xuan-preopen/cloud_io.mjs`
4. `cloud/xuan-preopen/cloud_io.test.mjs`
5. `cloud/xuan-preopen/orders_probe.mjs`
6. `cloud/xuan-preopen/orders_probe.test.mjs`
7. `docs/xuan-preopen-ib-oauth-bootstrap.md`

`ib_mcp.mjs`, account association policy, other sources, report publication,
schedules, workflows, Dockerfiles and IAM remain unchanged. An uncommitted
complete-diff SHA-256 and individual file hashes are delivered outside the
candidate. They identify the review candidate; they do not represent a signed
approved head or deployed image. No push or PR is part of preparation.

## Inert entry point and test boundary

`node scripts/xuan-ib-cloud-oauth-bootstrap.mjs` and `--plan` only print an offline
approval template. Unknown flags fail. They do not create a listener, open a
browser, generate an authorization link, spawn an SDK, read credentials, or make
network requests. There is deliberately no live CLI switch.

`createBootstrap` requires explicitly injected fetch, listener, browser, store,
maintenance and clock capabilities. `preflightLoopback` is a separate explicit
future action. The Node loopback, external-browser and SDK bridge factories are
inert until called by a separately reviewed operator invocation. Tests use only
synthetic adapters, fake clocks and fake subprocess results. A standard Python
subprocess exercises the embedded single-POST bridge core with fake identity and
HTTP transports under `__name__=synthetic_test`; it imports no SDK or HTTP package
and cannot enter the live entry point. Tests never bind, browse, or run an SDK.

Approval booleans and maintenance fixtures in tests are synthetic input. They
cannot substitute for human approval, identity evidence or an actual drain.

## Fixed destinations and requested registration

| Item | Fixed value |
| --- | --- |
| Issuer | `https://api.ibkr.com` |
| Register | `https://api.ibkr.com/oauth2/register` |
| Authorize | `https://api.ibkr.com/oauth2/authorize` |
| Token | `https://api.ibkr.com/oauth2/api/v1/token` |
| Resource | `https://api.ibkr.com/v1/api/mcp-public` |
| Project | `family-portfolio-gateway` |
| Original credential Secret | `projects/family-portfolio-gateway/secrets/xuan-preopen-ib-mcp` |
| Existing job | `xuan-preopen-orders-probe` |
| Existing source SA | `xuan-preopen-source@family-portfolio-gateway.iam.gserviceaccount.com` |
| Existing private bucket | `family-portfolio-gateway-xuan-preopen-private` |

The numeric project identifier `860729177589` is accepted only as the known
equivalent in the same exact Secret version resource name.

Requested profile: client name `XUAN Preopen Cloud Read-only v2`, scope exactly
`mcp.read`, grants exactly `authorization_code` and `refresh_token`, response
type exactly `code`, authentication method `none`, and one actual bound loopback
redirect. Resource is sent only in authorization/code-exchange/refresh requests,
not invented as a registration metadata field. No account-ids, identity, write,
order, email, profile, or openid scopes are added. The owner selects the already
approved single account on IB's consent page. The code never guesses an account
parameter or reuses a Codex client, callback, grant or stored credential.

The returned DCR metadata must explicitly confirm redirect, auth method, grants,
response type, scope and name. Missing or unexpected profile metadata stops with
`BOOTSTRAP_PROFILE_REVIEW_REQUIRED`; no fallback authentication method, second
registration, new Secret or new cloud infrastructure is attempted. Support for
DCR/PKCE does not guarantee acceptance or coexistence with the Mac connector.

## Separate bind preflight, frozen URI and callback

The future preflight binds only `127.0.0.1` with port zero, derives the real port
from the bind result, returns the clean callback URI, and closes. It does not
register or authorize. The final operation manifest freezes that exact URI.
Execution binds that exact port again; a failure or changed address stops, with
no automatic replacement URI. No real URI has been bound in this preparation.

The callback path is `/oauth/ib/callback`. A one-use loopback start path
`/oauth/ib/start` sets a random HttpOnly, SameSite=Lax cookie scoped to the
callback, then redirects the same browser to IB. Only the non-sensitive start
URI is passed to the external-browser process. The complete authorization URL,
callback query, state, verifier and cookie are never logged or passed in shell
arguments. Native HTTP access logging is not enabled.

Every session generates three independent 32-byte random values for state,
PKCE verifier and browser cookie. S256 and base64url without padding are used.
The callback admission TTL is ten minutes; a consumed valid code switches to the
independent bounded finalization window described above. Host and unique Host count, GET, exact path,
unique query keys, state, cookie and required exact `iss` are checked. Duplicate
code/state/iss, unknown parameters, code-plus-error, missing issuer, invalid
state, Admission expiry, finalization expiry, cancellation and replay stop. If binding finishes after cancellation
or expiry, cleanup waits for the late resource and closes it exactly once before
claiming `listenerClosed`; a failed close remains explicitly unconfirmed. The callback is synchronously
consumed before any await that can exchange the code. Only one exchange and one
initial Secret submission are admitted.

OAuth POSTs use only the fixed HTTPS endpoints, `redirect:error`, an independent
15-second deadline and a 64-KiB response bound. Duplicate JSON keys, including
escaped equivalents, invalid UTF-8 and unconfirmed outcomes are rejected.
The owner alone completes IB login, MFA and consent in the external browser;
the assistant never fills credentials or captures an authorization code.

## Zero-credential outputs and the existing SDK writer

Public results contain fixed status/error categories, safe registration metadata,
scope-evidence source, side-effect stage, and confirmed Secret name/state only.
Unknown fields are never spread from OAuth or SDK responses. An optional DCR
management token is held only in the response memory and is not persisted.
The clean registered redirect URI is allowed registration metadata; an actual
callback URL with code/state, or an authorization URL, is never an output.

Token acceptance requires nonempty access and refresh tokens, Bearer, positive
validity and only `mcp.read`. If token scope is omitted it inherits only the
explicit request and records `explicit-request-inherited`; returned scope uses
`token-response`. Fixed resource requests are not described as returned audience
or native account proof. No previous Mac/Secret credential is read to fill gaps.

`createSdkWriter` sends only the whitelisted credential JSON via stdin. The
fixed Python 3.12 binary and embedded source, original account, project, Secret,
no-shell argument list, no-HTTP-debug mode and private stdout parsing cannot be
supplied as CLI flags. Credentials never appear in process arguments. The SDK
credential store loads only the pinned stored user identity, with no ADC, static
provider, metadata, impersonation or alternate-file fallback. A direct requests
HTTPS transport submits the Secret POST once: adapter retries are zero, redirects
are disabled, and no AuthorizedSession authentication replay is used. A 401,
5xx, disconnect after server acceptance, or response timeout stays unknown and
cannot resubmit. Original Google user credentials can refresh before the one
Secret POST; that is not an IB refresh or a Secret POST retry.
The session defaults and real subprocess bridge independently pin the original operator account
SHA-256 `1f95a16df4e38086493c3447a048fdf375e8402fa4ba709ece794e3b830d49ee`.
Synthetic identity-hash injection is used by fake session/process fixtures; the
real bridge independently rejects it before importing/spawning the SDK. There
is no CLI flag for this test injection, and the default session rejects a wrong
operator before admitting listener or DCR capabilities.

The writer pins the existing SDK at the recorded 575.0.1 location and Python
3.12, uses the original configured profile path `/Users/huanwu/.config/gcloud`,
and disables impersonation and HTTP debug overrides. The exact operator account
and correctness of that configuration directory must be checked privately
before final approval; this preparation does not run the SDK to verify them.
If the original configuration differs, stop for a revised reviewed invocation;
do not log in, choose another identity or add an impersonation permission.

The child has a 20-second deadline and bounded stdout; stderr is consumed and
discarded, never returned, logged, put in an exception or saved. Only a matching
original Secret `ENABLED` numeric version newer than the preceding version is
accepted. Duplicate/malformed/wrong-name responses fail. Unknown writes are not
resubmitted and old grants are not restored. No Mac process uses Cloud Run's
metadata identity. Clearing references/buffers is best effort; JavaScript string
memory erasure is not a provable promise.

## Exact-version cloud acceptance

`ibStore.loadBound({version,clientId})` accepts only a canonical numeric version
and checks the access response's exact original Secret/project/version name plus
credential client ID. Latest, aliases, other projects/Secrets, traversal, missing
pairs and duplicate JSON are rejected. Legacy `load()` behavior remains available.

Orders requests add one strict paired variant:

```json
{"requestId":"11111111-2222-4333-8444-555555555555","dataDate":"2026-10-16","expiresAt":"2026-10-16T02:00:55.000Z","credentialBinding":{"clientId":"SYNTHETIC_NEW_CLIENT","version":"51"}}
```

This example is synthetic and expired, not an executable approval. Recovery must
use the paired variant. A mismatch admits zero IB requests and never falls back
to latest. Safe receipts contain `consumedCredentialVersion`,
`savedCredentialVersion`, `credentialClientMatched` and `credentialVersionMatched`.
An acknowledged rotation must advance the numeric version and match the fixed
Secret. The next run uses exactly that confirmed version. The new bound path also
rejects duplicate refresh JSON and conflicting returned client/resource values.
Omitted refresh tokens use only the original token from that validated bound
version; explicitly invalid values fail closed.

`ib_mcp.mjs` is unchanged. Only `get_account_orders` with `{}` is admitted,
at most once. Existing owner-attested account association, response account-ID
checks (including null/empty/conflicting/duplicate claims), 45-second source
cutoff and 20-second finalization are retained. An admitted refresh can complete
and save within finalization, but no IB request starts after source cutoff.
Missing response IDs remain owner-attested, never native identity proof.

## Maintenance and the final one-operation approval template

No local lock is presented as cross-process exclusion. A live operator must
identify and pause all original-Secret consumer entrypoints, drain old executions,
block manual old-version requests, record the preceding version, and recheck
immediately before writing. The injected maintenance receipt is a required
capability input, not independent proof or a newly implemented control platform.
Any drift or unproven drain stops. The Secret append API has no new global CAS
or long-term exclusion guarantee in this change.

Final approval must contain:

1. Exact reviewed final code head/diff and, when needed, immutable existing-job
   image digest; real bound URI; original operator identity and SDK profile.
2. Exact registration profile; one registration, one owner authorization/code
   exchange, at most one initial version in the original Secret.
3. Fixed existing job/SA/bucket and the complete paused-consumer/drain evidence,
   preceding version, drift checks, and manual-run exclusion.
4. At most two sequential version-bound `get_account_orders({})` runs. First uses
   the saved initial version. Second runs only when the real credential reaches
   the existing normal refresh window, with at most one refresh and one orders
   call plus its confirmed rotation save. No expiry-field edits or production
   force-refresh switch. A run before the window cannot prove refresh acceptance.
5. Explicit acceptance that the new grant may replace the Mac connector. No
   automatic Mac re-login; any fallback reauthorization needs fresh confirmation.
6. Unknown DCR/exchange/write outcomes are not retried. After a confirmed write
   but failed cloud validation, retain maintenance; do not revoke the grant,
   delete/disable versions or fall back to invalid old v14. A new authorization,
   retry or revocation returns to explicit approval.
7. Before ordinary consumers resume, privately prove which confirmed version
   they will read. Legacy latest is not a strong-consistency guarantee; an
   unproven consumer stays paused. Originally closed schedules remain closed.

The 2026-10-16 09:01:30 HKT verified local job snapshot records 1 CPU, 512 MiB,
one task, zero retries, **180-second timeout and the private-action-preview
image**. It is not a fresh configuration read and is incompatible with this
orders-only acceptance. The final live manifest must prove the reviewed
`node cloud/xuan-preopen/orders_probe.mjs` image/entrypoint and a 75-second job
limit. Any necessary existing-job deployment/configuration needs its own exact
approval. Nothing is changed here, and the existing preview image must not be
run as an orders-only substitute.

## Cost approval template — not a hard billing cap

New services, buckets, Secrets, IAM and log routes: zero; new infrastructure $0.
At most two new versions (initial plus rotation), using the requested full-month,
no-free-allowance assumption: **US$0.12 × actual billable replica locations**.
The replication count is not verified in this preparation. It must not be
assumed to be one.

The verified historical 1 CPU / 0.5 GiB configuration, if reconfirmed and bounded
to two 75-second tasks, gives at most 150 vCPU-seconds and 75 GiB-seconds before
applying the applicable job prices/minimums. Add private-object/network charges
and any separately required image build/storage cost. Unit prices, replication
count and image-build costs remain unverified; therefore a numeric total below
US$1 is **not asserted**. US$1 is the incremental operation approval threshold,
not a GCP hard budget, and excludes historical usage and unlimited future token
rotations. If it cannot be shown below threshold, return for review. Never delete
or destroy old versions to reduce the estimate.

## Synthetic safe registration manifest example

The following is a fixture, not an observed registration or real bound URI:

```json
{"spec":"IB-ORDERS-OAUTH-BOOTSTRAP-LOCAL-v1","clientId":"SYNTHETIC_NEW_CLIENT","clientName":"XUAN Preopen Cloud Read-only v2","redirectUri":"http://127.0.0.1:45123/oauth/ib/callback","tokenEndpointAuthMethod":"none","grantTypes":["authorization_code","refresh_token"],"responseTypes":["code"],"scope":"mcp.read","issuer":"https://api.ibkr.com","resource":"https://api.ibkr.com/v1/api/mcp-public","issuerEvidence":"fixed-endpoint","resourceEvidence":"explicit-request-only","observedAtUtc":"2026-10-16T02:00:00.000Z","timestampEvidence":"local-registration-response-received","codeSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","managementCredentialReturned":true,"managementCredentialPersisted":false}
```

## Offline validation and actions not executed

```text
node --test scripts/xuan-ib-cloud-oauth-bootstrap.test.mjs cloud/xuan-preopen/cloud_io.test.mjs cloud/xuan-preopen/orders_probe.test.mjs cloud/xuan-preopen/ib_mcp.test.mjs cloud/xuan-preopen/ib_diagnostics.test.mjs
```

These tests cover fixed-profile success, S256/cookie binding, duplicate and
contradictory query/JSON fields, wrong state/issuer/URI/client/version, scope
expansion, missing refresh tokens, expiry/concurrency/replay, HTTP/network/write
timeouts and unknown outcomes, exact version chains and transport-level source
cutoff/finalization regressions. Synthetic canaries check safe failure outputs;
no test snapshots contain credentials or raw OAuth/SDK responses.

Not executed: real bind preflight, DCR, browser authorization, code exchange,
refresh, SDK/Keychain/Secret access, financial reads, consumer pause/drain,
cloud execution, image build, deployment, IAM/logging changes, push/PR, formal
publication or schedule activation. The completed private mixed-time preview
is separate and unchanged by this candidate.
