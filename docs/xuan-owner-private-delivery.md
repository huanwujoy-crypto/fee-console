# Protected private owner action delivery

This change reuses the frozen `xuan-private-phone-automatic-local-r2` planner,
chronology, input-copy and conditional-write design. It prepares a real fixed
GCS transport and a source-verifying controller. It does not enable a schedule,
change an identity or grant, deploy a job, upload a report, modify a broker or
Sharesight, or place financial data in Pages. The original fee application and
its data are outside this change.

The existing app links to an empty `xuan-ib/private-action.html` entry. Its only
private destination is a top-level navigation to the already proposed fixed
authenticated browser object:

`https://storage.cloud.google.com/family-portfolio-gateway-xuan-preopen-private/delivery/owner-latest.html`

Google handles its existing cookie session. There is no financial fetch, iframe
login, credential input, file import, browser storage, configurable redirect or
new API service. The entry does not establish that the object exists or that a
phone's signed-in user has effective access. It explicitly describes missing
file/permission states. A previously open document or browser back/forward cache
cannot be promised erased by Google logout; actual device behavior remains an
acceptance item.

## Source and display admission

The first release accepts only an existing working-day `private_eod_action`
schema-9 partial report with unknown complete BUY reserve, planning budget and
executable budget. These are deliberate limitations, not zeros. Its private
model and completion receipt remain byte-for-byte distinct from the derived
static display. Current CALL declaration and its 50% rule, account association,
original source dates, five-minute composition and thirty-minute candidate
publication limits are preserved.

The displayed collection window must start with the actual receipt's start
minute. Field reports bind the exact saved capture interval; standard reports
bind the provable receipt window and pinned source-read lower bounds because
their producer does not persist a separate exact collection-end instant. Flex
read times must stay inside that real window. A future or relabelled header
cannot pass by merely rebuilding the model and outer hashes.

The controller reads the completed daily HTML and receipt at their actual GCS
generations. The verifier validates the existing receipt and canonical renderer,
then actually reads all four original `report-check/` objects at the receipt's
generations and hashes. It checks scope/raw fingerprints and rebuilds the model
from those source values. Merely returning `approved=true`, supplying hashes or
successfully reading the receipt does not authenticate the original sources.
The trusted transport/producer storage boundary remains the same trust boundary
as the existing pipeline; the JSON is not an independent cryptographic producer
signature.

The verifier reads trusted main association/CALL/public-baseline context twice.
Historical current-latest verification reads the original Git version and proves
it is an ancestor of current main. That phase preserves old capture times and
does not admit an old candidate as fresh. Missing historical context fails closed.
Flex requires the existing separately approved query configuration, never a
query value inferred from the archive. Unsupported claimed completed-sync or
independent financial-proof formats fail closed rather than accepting a source's
self-certification. Date-verified Sharesight records with explicit missing sync
proof remain eligible as partial facts.

Static display is derived only after exact canonical reproduction. It removes
the known renderer status updater, adds the four fixed card IDs and a CSP that
disables scripts and network resources, and preserves facts and unknowns. The
legacy order model has no native order-contract/currency proof, so displayed
currency and distance from market are labelled same-name-position reference.
No inferred currency establishes a reserve or executable budget.

## Fixed storage transaction

The store discovers the fixed latest generation with HEAD, then uses generation-
pinned metadata and raw-byte GETs. It reads the original daily report and receipt
behind the current object and verifies their byte hashes. It exposes no listing,
arbitrary bucket, credential lookup or delete API.

The one-shot publisher compares source date and capture chronology, derives its
display, and performs exactly one multipart upload to the literal latest object
with `ifGenerationMatch`. Bytes and custom metadata change atomically. MIME is
HTML UTF-8, disposition is inline, and cache policy is private/no-store. It then
independently reads the acknowledged generation's actual bytes and metadata.
Only that verified readback returns `published-verified`.

A 412 conflicts and stops. An uncertain write or late/unverified response returns
`unknown`, closes the publisher and is never retried or rolled back. A new process
must first resolve the actual generation/state before any separately authorized
new attempt. A missing object is distinguished from denied or uncertain reads;
only the fixed authenticated read's 404 can plan create-only generation zero.

## Explicit entry and unchanged daily activation

`owner_latest_delivery.mjs --execute-current-workday` is the explicit controller.
Before using its existing Google credential environment it requires local HEAD
to equal live trusted main, a clean tracked tree, and all eight owner-delivery
source files plus both protected registrations to exist in that commit with matching bytes. An untracked new module on
an old main checkout cannot pass. It uses only the existing supplied identity;
it has no token endpoint, login, impersonation, Secret or Keychain reader.

The ordinary producer workflow does not call this command and is unchanged.
`collectDelivery` has an optional trusted private-publisher capability, default
`null`. When explicitly integrated after approval, it runs after receipt/HTML
validation and before public projection/equality. Thus an unchanged anonymous
public summary cannot skip a new private report. Unknown/conflict/blocked private
results stop that integration without making a successful-delivery claim.

Saturday/closed-market calls return `no-action` before storage or credential
access. This is not a weekend-daily bypass or a Mac-reference receipt adapter.
The separately collected local weekend preview has its own true dates and is
kept intact; it cannot be substituted for an immutable daily production bundle.

## Separately accepted Saturday preview

The local review patch adds a separate `xuan.owner-accepted-preview.v1` type.
Its one registration, `security/xuan-owner-accepted-preview.json`, freezes only
nonfinancial hashes, scope and actual dates/times of the October 17 Saturday
reference. It does not contain account numbers, amounts, raw orders or the
reversible private model. The report date is October 17, the source market date
is October 16, and the displayed original collection intervals are preserved.
Running later does not make these facts fresh or turn Saturday into a market day.

`deliverOwnerAcceptedPreview` is an explicit function entry with no automatic
schedule or preview CLI switch. It first enforces the protected checkout, then
reproduces the frozen static display from the exact original HTML, model and
source-manifest bytes. The display removes the private model marker and active
content while retaining the existing cards, financial facts and unknown states.
The verifier reads the actual registration bytes from trusted main twice. A
JSON assertion of approval, a locally modified registry or a hash supplied only
by the candidate is insufficient.

The entry additionally requires a trusted, real read-only destination-access
checker; it supplies none by default. Before this checker may pass, the actual
configured audience must have been disclosed and authorized, the existing
identity's exact permissions proven, and nonfinancial canary access verified
using already authorized sessions. Public-access prevention and uniform access
do not establish that only the owner can read. Do not infer permission from a
service account's expected system purpose, silently change identities or modify
IAM. This patch is not evidence that any of these live acceptance steps passed.

The preview publisher probes only the fixed `delivery/owner-latest.html`.
Any existing object, denied read or uncertain state stops before upload. Only
an explicit authenticated absence can make one atomic create with
`ifGenerationMatch=0`; preview metadata cannot be used with a replacement
generation. No extra receipt, model, raw source or financial test object is
uploaded. A separate pinned metadata/media readback must match exact bytes,
headers, registration and generation. Conflict and uncertain outcomes stop
without retry or rollback.

Future normal working-day candidates still pass the unchanged daily receipt,
source, calendar and freshness gates. Only the current-latest historical branch
recognizes this preview. It proves the registration commit is an ancestor of
current main, reads both versions of the registration and requires identical
bytes, checks the frozen display and original chronology, then uses the actual
stored generation for CAS. It never fabricates daily bundle/receipt objects for
the preview. Removing or changing the registration fails closed; any migration
would need its own protected review. This preview can never enter the ordinary
daily candidate lane.

## Existing Mac SDK and actual access capability

`owner_sdk_transport.mjs` and its Python worker supply the previously missing
real transport using the Mac's existing official Google Cloud SDK. They use only
the original cached owner identity through the SDK's credential-store API.
The noncredential `XUAN_OWNER_EXISTING_SDK_ROOT` runtime locator must resolve
to the already inspected SDK path hash in both bridge processes. Missing or
different locations fail closed; the private old workspace path is not published
in source, and no SDK is discovered from PATH or installed by this change.
No token or credential value leaves the worker, no Keychain/ADC/metadata or
service-account fallback is used, and auth/endpoint/proxy/credential overrides
are rejected. An invalid, stale or expiring cached credential fails closed.
The worker rejects every token request: it does not log in, refresh credentials,
impersonate, enable a service or call Secret Manager. Authorized HTTP requests
disable redirect following, automatic refresh/replay and transport retries.
Node and Python communicate only through bounded memory pipes; financial
request/response bodies and credential headers are never logged or stored by
this adapter. Killing a timed-out worker cannot authorize another attempt.

The normal request capability accepts only the literal latest object and a
single CAS0 upload. A separate canary capability accepts only the already
designated `delivery/owner-phone-canary-v1.html` and a strict nonfinancial
template containing a fresh UUID, real creation time and registered candidate
hash. It cannot accept arbitrary HTML, financial values or extra metadata.
The immutable canary is independently read back at the acknowledged generation.
The creation entry stops for any existing canary; it is not overwritten or
silently reused.

### Stored attributes, API responses and actual browser display

These are separate checks. Stored object metadata and upload-ACK resource
attributes still require UTF-8 HTML, `Content-Disposition: inline` and
`Cache-Control: private, no-store, max-age=0`. The fixed authenticated JSON API
HEAD/media response may instead use the complete observed representation:
`attachment` with `no-cache, no-store, max-age=0, must-revalidate`. Only these
two complete response profiles are accepted; their fields cannot be mixed.
Missing `no-store`, bare `no-cache`, public caching, positive TTLs, unknown
profiles, encoding, generation/length or byte-hash mismatches still fail.

Google documents that nonpublic JSON API responses use `no-cache` regardless
of stored metadata; that alone is insufficient for this workflow's no-store
requirement. The additional observed response directives remain mandatory in
the second profile. See [JSON API Cache-Control](https://docs.cloud.google.com/storage/docs/json_api/v1/parameters#cache-control).
An API `attachment` response is not a browser-display result. The cookie-based
`storage.cloud.google.com` entry uses a separate authenticated browser endpoint;
it must actually render and be inspected in the existing user browser. The
October 17 Mac Chrome check did render the canary inline and match its fields,
but did not expose the specific Google principal, raw byte hash, HTTP status,
or phone acceptance. None of those missing facts are inferred from it.

Both upload types explicitly request `Accept-Encoding: identity` at the trusted
transport boundary. Compressed responses remain rejected rather than silently
decompressed. Canary failures report a bounded stage and symbolic reason;
unknown writes remain closed and are never retried.

### Explicit read-only use of the one registered existing canary

The original unknown session is closed. `verifyRegisteredCanary()` is a distinct,
argument-free, read-only entry, bound to the one protected pin in
`security/xuan-owner-registered-canary.json`. That file is included in committed
source-byte checks; it grants neither IAM nor caller-asserted browser approval.
After the real original-actor/full-IAM preflight, the new session must read the
registered generation's metadata and exact nonfinancial bytes from GCS and
then confirm that the unversioned entry still has that generation. UUID,
original creation time, candidate hash, body hash, size and stored metadata are
checked. The existing canary is not relabelled as freshly created or rewritten.

Create and registered verification share a one-shot choice consumed before the
first await. Failure closes the session; there is no fallback, caller pin,
saved-receipt override or revival of the previous unknown write. Successful
verification returns `existing-verified`, not `published-verified`, and does
not mint a financial POST admission. Actual user-browser inspection remains a
separate executor step. The same new session must then refresh the original
actor/IAM checks, re-read the canary and current generation before its short
single-use financial admission. The financial target remains first-create
CAS0 only, followed by independent pinned readback and actual final-page UI
acceptance. Google principal visibility and device limits remain explicit.

### Bounded preview timing

A read-only measurement on October 17 at 11:42 UTC took 14.457 seconds for
two current-boundary checks, two pinned canary readbacks with current-entry
checks, and one public admission-context read. That subset already exceeds
the original ten-second publisher limit. It excludes the second context,
financial-object presence checks, create and independent financial readback;
it is not a measurement or successful run of the complete publisher.

The explicitly registered accepted-preview publisher therefore has its own
fixed 45-second total deadline. Callers cannot extend it. The normal daily
publisher retains its ten-second deadline. The actual access checks still
enforce the 60-second full-preflight lifetime and five-second single-use POST
admission independently; none of those authorization windows is extended.
Expiry, abort, conflict and uncertain writes still close without retry.
The larger preview limit remains a finite execution bound, not proof that a
future complete create/readback will succeed within it.

The reviewed local executor sets Node's native connection-family attempt
timeout to 1000ms before production imports or public context reads, verifies
that value, and stops if it drifts before financial execution. The installed
runtime's 250ms default intermittently produced connection timeouts and IPv6
unreachability on the immutable public source host; a public protected-context
probe and the read-only measurement succeeded at 1000ms. This process setting
does not change endpoints, DNS order, TLS verification, proxies, Python SDK
HTTP, identity, permissions, authorization lifetimes or the publisher deadline.
It adds no I/O retry or fallback. Actual private-report UI acceptance remains
required after independent pinned financial readback.

`owner_preview_access.mjs` constructs the production capability from this actual
SDK transport after protected-checkout admission. It reads the protected
`security/xuan-owner-approved-audience.json`, which records hashes rather than
the owner's or service accounts' exact identities. Live checks cover the same
owner, fixed bucket/project boundary, uniform access/public-access prevention,
bucket and project IAM, conditional/convenience expansion, current object
permission definitions and the exact seven accepted configured readers. Only
Storage permissions are fingerprinted; unrelated non-Storage additions to a
Google-managed role do not purport to be unchanged. The existing Storage
`testIamPermissions` read must confirm `storage.objects.get` and
`storage.objects.create`; no grant is added to satisfy it.

The full preflight is short lived. Before the financial write, real checks
re-read the current actor/IAM and the same session's generation-pinned canary;
stale, changed or uncertain results stop. The trusted executor must first
actually open the canary using the existing owner browser session. An empty
callback, caller-supplied `approved=true`, saved JSON receipt or successful unit
test cannot stand in for that workflow or the live SDK capability. The same
session's real checker and request capability are then passed to the explicit
preview entry. The executor must separately open and verify the final private
report before claiming delivery. No schedule or automatic preview execution
is added.

The policy fingerprint compares complete binding/condition/member semantics,
normalizing only user-email case and explicit versus omitted IAM policy-version
formatting. It does not claim to exhaust inherited deny policies, non-Storage
delegation or every reader's actual successful GET. Those limits were retained
in the disclosed audience review. The original owner SDK identity remains an
exact hash match, and successful live permission tests plus pinned canary/report
readback remain separate requirements.

## Approval and real acceptance still required

The complete sensitive source diff needs its final GitHub-verified signed head,
the owner's exact-head `/approve-xuan-ib-maintenance <head>` comment, and the
existing `scripts-check`, `ui-pr-check`, and `xuan-ib-policy-lock` checks before
protected merge. New commits invalidate approval. The agent cannot post the
owner comment. Code merge may publish the empty public entry; it does not approve
a financial upload or schedule activation.

The current delivery identity's read role has `storage.objects.get`; its existing
prefix restrictions do not establish original `report-check/` source access or
create/delete on the fixed latest object. Do not extend its permissions, switch
identities, or treat an absent direct binding as proof of no effective access.
Use an already authorized identity only after proving the exact effective rights
and owner-authorized private audience; otherwise return that precise permission blocker.

Real admission requires a fresh normal-workday original completed bundle and the
existing approved Flex configuration where relevant. Then independently verify
returned generation, bytes/hash, metadata, cache/MIME/disposition and private
access. Owner phone/Safari/PWA login, four-card scrolling, unknowns, cold/warm
reopen, later update and unauthenticated/wrong-user denial remain real acceptance
items. Use existing authorized test sessions; create no identities or grants.
Offline tests and localhost viewport tests do not substitute for those results.
