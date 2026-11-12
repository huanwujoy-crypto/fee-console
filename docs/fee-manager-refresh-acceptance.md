# Refresh API acceptance preparation

This is local implementation and synthetic verification only. No deployment,
resource/IAM acceptance, real owner request, browser-button acceptance or
production approval is supplied. The page entry and ratio remain disabled.
The CLI has no token option and never creates or updates a Gist.

`GET /v1/mode` returns only `schema: fee-console.manager-refresh-mode.v1` and
the configured `mode`. The entry passes the mode from `readConfig`; caller
parameters cannot select it. Exact existing Origin/CORS and no-store apply.
Disabled mode retains its original 503 refusal. The endpoint accesses no Gist,
storage, Job or credential. It describes the intake configuration only, and
does not attest the separate Job, revision traffic, runtime identity or IAM.

## Default: read-only preflight

```sh
node scripts/fee-manager-refresh-acceptance.mjs --intake=<verified-acceptance-origin>
```

Replace the placeholder with the exact HTTPS root of the deployed
`fee-refresh-intake-acceptance` service. Only the classic
`fee-refresh-intake-acceptance-<hash>-<region-code>.a.run.app` or project-number
`fee-refresh-intake-acceptance-<number>.<region>.run.app` shape is accepted.
Syntax and a service's own mode report do not establish deployment identity.
Credentials, ports, paths, query strings and fragments are refused.

Preflight performs only GET /v1/mode, OPTIONS /v1/requests and wrong/missing
Origin GET probes. It requires acceptance mode, exact allowed Origin,
no-store and the existing CORS method/header contract. No queue writes, Gist
reads or Job starts occur. A missing endpoint or an unknown, launch or disabled
mode stops the run. `stage: preflight, passed: true` is not full API acceptance.

## Explicit intake-only execution

Add `--execute` only for a separately authorized isolation run. The flag records
intent in the command; it is not authorization to create records or start Jobs.
The runner rechecks intake mode immediately before every POST. It checks an
invalid request, an unknown UUID, atomic close and repeated close, then an
invalid proof after closure. It leaves the closed test record permanently;
there is no deletion, overwrite, replacement UUID or cleanup/retry operation.

Without a valid owner proof, this proves only refusal of invalid POSTs after
closure. It does not prove a valid late owner POST raced across instances.
`intakeOnlyPassed` and `validOwnerCloseRaceVerified` are separate; the latter
always remains false. A successful intake-only stage never sets
`ownerRequestPassed`.

## Explicit full owner-request execution

In addition to `--execute`, supply `--request-id=<UUID-v4>` and
`--gist-version=<latest-40-hex-revision>`. The owner must already have been
authorized to write a fresh fee-only request. The CLI neither reads nor writes
the Gist and accepts no credential. It requires, in order:

1. Exactly HTTP 202 queued for that UUID.
2. Exactly HTTP 202 duplicate for the identical UUID/revision. This second POST
   is the explicit idempotency probe, allowed only after definite queue receipt.
3. HTTP 200 queued/received from close, showing a queued request is not revoked.
4. HTTP 200 status for the same UUID and contents `[fee]`, ratio null, ending in
   exactly fee state failed and code PUBLISHER_REFUSED. A returned dataDate must
   be a valid calendar date.

Published, unknown, stale, identity failures, missing reading credentials,
ordinary failures, wrong HTTP/identity or any ratio content cannot pass. A
partial stage or an early refusal does not substitute for reaching the fixed
acceptance publisher through the actual Job/coordinator.

The acceptance Job holds no GitHub credential at all: `credentialFor` refuses to
start an acceptance Job that has `/secrets/github/token` mounted, and a launch
Job that lacks it. The acceptance Job's GitHub reads (owner request, main,
previous publication) are anonymous GETs of public data; a rate-limited or
failed read is `VERIFY_UNAVAILABLE`, never success, so it can only fail the
run. Its publisher never performs an Actions dispatch. Reading an existing
producer job log needs a credential and is therefore not exercised by
acceptance; it stays a launch-only capability to be verified separately.

## Bounds and evidence limits

`--wait-seconds` bounds the entire run (default 60, maximum 300).
`--request-timeout-ms` bounds each request including its streamed body
(default 5000, maximum 15000). Polling is GET-only, at most 60 status requests,
and also stops at the overall deadline. Responses are limited to 8192 bytes,
strict UTF-8/JSON with duplicate keys refused. Redirects and changed response
URLs are refused; requests omit credentials, Cookie, Authorization and referrer.

Every uncertain POST or close ends the run immediately. The runner does not
resend, close an uncertain submission or pick another UUID. Output contains
fixed check identifiers and stage booleans, never response bodies, error text,
UUIDs, Gist revisions or credentials. Exit zero means only the reported stage
passed; `deploymentIsolationVerified` and `launchReady` always remain false.

The service API may use a separately approved request-only secret Gist owned by
the fixed owner. The existing page writes its configured ledger Gist, so API
success using an independent Gist cannot establish full button acceptance.
Actual browser Origin/CORS, UI confirmation/storage/recovery, resource and IAM
isolation, image/source identity, existing log reads and deployment remain
outstanding. No real acceptance or production run was performed here.

The runner, its tests and this document are registered as sensitive paths and
both suites run in `scripts-check.yml`.

```sh
node --test scripts/fee-manager-refresh-mode.test.mjs scripts/fee-manager-refresh-acceptance.test.mjs
```

These tests inject fictional transports, credentials and memory storage while
running the actual intake, Job, coordinator and health verifier. They do not
demonstrate that a real credential or cloud environment is available.
