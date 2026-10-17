# Protected owner-only action delivery

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
to equal live trusted main, a clean tracked tree, and all four new executable
modules to exist in that commit with matching bytes. An untracked new module on
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
and owner-only destination; otherwise return that precise permission blocker.

Real admission requires a fresh normal-workday original completed bundle and the
existing approved Flex configuration where relevant. Then independently verify
returned generation, bytes/hash, metadata, cache/MIME/disposition and private
access. Owner phone/Safari/PWA login, four-card scrolling, unknowns, cold/warm
reopen, later update and unauthenticated/wrong-user denial remain real acceptance
items. Use existing authorized test sessions; create no identities or grants.
Offline tests and localhost viewport tests do not substitute for those results.
