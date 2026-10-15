# Controlled private preview entry

This entry is prepared for review only. No real source call, build, deployment,
new permission, key or upload is performed by preparing it. R3 and R5 remain
separate frozen reviews; this integration needs its own complete source review,
signed exact head, required checks and specific one-shot execution approval.

`ActionPreviewOnce.Dockerfile` starts `action_preview_once.mjs --request JSON`.
The request has only requestId, current Hong Kong dataDate and expiresAt. Runtime
must be the fixed unscheduled `xuan-preopen-orders-probe`, original source SA,
one task/parallelism one, initial attempt zero and explicitly max retries zero.
No daily/EOD marker, old acceptance context or normal schedule is used.

## In-process source handoff

The unchanged R3 probe constructs its own native privateCloudIo with the reviewed
source/finalization signals. The controller does not inject an IO replacement.
Its fetch observer forwards options and responses unchanged, provisionally
copying only this new operation's GCS upload bodies for orders and receipt.
It never inspects OAuth, metadata or Secret Manager bodies. Copies are trusted
only after R3 confirms success and their hashes match its confirmed receipt and
source artifact. R5 then consumes that same bundle in the same Cloud Run process;
no source-SA object-reader grant and no raw-order object GET is needed.

A confirmed upstream auth/read failure can produce a partial report with valid
Sharesight/CALL facts and unknown orders. It is never reported as restored IB
authorization. Identity/integrity/claim failure, unconfirmed receipt, uncertain
token exchange/save and refresh service errors stop before Sharesight. No source
retry, replacement ID, old-token rollback or reconnect is automatic.

The composer receives only private create and gateway-token capabilities.
It performs two fixed Sharesight GETs at most, retaining successful siblings;
there is no IB/Flex capability or arbitrary portfolio/currency source selector.
CALL is the existing persistent owner-provided configuration, never an external
financial CALL lookup. Missing source data or invalid derivations remain unknown
and carry the reviewed closed fieldErrors. A generated HTML is not a claim of
financial completeness or an interactive release.

After composition, one immutable copy of its metadata-only receipt is saved as
`report-check/orders-probe-<requestId>/preview-receipt.json`. It points to the
private original report. Safe stdout contains only codes, actual times, closed
source status/errors and hashes. No raw financial rows or credential values are
serialized. Private uploads are capped at ten attempts, nine MB per object and
32 MiB total. There is no object listing/get or public-write capability here.

## 180 seconds versus the credential window

The proposed Cloud Run timeout is **180 seconds**, one CPU and 512 MiB; the
program caps total transport at 170 seconds and composition at 100 seconds.
These are new proposed bounds, not approval inherited from the 75-second probe.

For a reserved exclusive interval beginning at T, set request expiry to T+55s.
The entry rejects a remaining request lifetime above 55s and rejects late starts.
R3 admits IB requests for at most 45s and never after request expiry; necessary
finalization lasts at most 20s. Thus its credential activity must finish by
T+75s, even if Cloud Run startup was delayed. Composition after R3 makes no more
IB requests or credential writes. A late/failed attempt is not retried.

This timing restriction is **not a distributed lock or proof of exclusivity**.
Before real execution the operator must verify the actual future interval with
current permitted consumer/schedule metadata, one coordinator and assurance that
other original-grant clients (including Mac MCP) remain idle. Old idle lists
cannot prove the future window. Do not pause schedules or inspect the cancelled
EOD context to manufacture proof; stop if safe separation is unavailable.

## Build and delivery gates

Use only a separately reviewed fixed least-privilege build entry and existing
dedicated builder/repository. The current report-only maintenance guard does not
authorize this Dockerfile. The observed default compute Cloud Build identity has
Editor and must not be used. No build, guard relaxation, IAM/WIF change or default
identity fallback is part of this candidate. Build configuration is supplied as
a separate unapplied planning artifact, not an executable approved workflow.

The new Dockerfile reuses the official Node24 Linux/amd64 base digest already
pinned in the trusted maintenance source. Its test RUN and the proposed build
network are disabled. The fixed COPY closure contains only scripts, cloud source
and the existing non-secret portfolio registry; a future builder must derive the
file list/modes from the approved Git tree, reject symlinks or dirty additions,
and independently verify image/config digests, source labels and ENTRYPOINT.
Host-Node COPY-set simulation is not an actual container build.

Private HTML generation does not satisfy the requested phone-accessible
interactive application by itself. That needs a named, verified authenticated
interactive viewer and its exact data/destination approval. Raw assets must not
be published to public Pages. Verified owner-only Drive PNG/PDF delivery is only
a separately confirmed visual fallback; it is not an interactive app release.
