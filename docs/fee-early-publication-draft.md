# Fee chain minimum integration; early publication remains disabled

This draft wires credential-free preflight, encrypted destination association
receipts, retained safe diagnostics and fixed anonymous public acceptance into
existing workflows. Early publication remains a disabled, tested separate stage.
No new financial endpoint, source credential, authority or timer is activated.
Today's verified Oct6 data remains unchanged. Code approval cannot authorize the
missing source adapters, IAM, private storage, credential or schedule deployment.

## Existing work and preserved contracts

PR326 (0941660b9e24e69fe106905b3c66e894eff7f641) and PR330
(e398ea59d4db70214172131dde3900284742198f) are OPEN Drafts, unmerged.
The trigger decision source is reused verbatim from PR326, retaining its 11:45
window and benchmark-required published predicate. Do not activate that old core
for the proposed early path; integrate the new staged decision after review.
PR330 remains the fixed read-only observer; do not duplicate its collector.
No XUAN token, service account or clock permission is reused. All new files are
registered sensitive; ordinary registrations and approval semantics are unchanged.

Production daily.mjs already supports verified AUM/fees while benchmarks are
pending. Health accepts benchmark null only when the encrypted daily point has
no bd. Existing same-date replacement preserves the complete prior bundle when
omitted, never invents closed/session, never overwrites an existing same-bd price,
and retains dividends. Receipt validator, signed owner candidate, Validate,
protected Promote, privacy guards and public hash read-back remain mandatory.
Current producer instead chooses target from complete benchmark cache and requires
selectBenchmark before source reads. The new planner resolves target independently
using the existing reviewed NYSE calendar adapter; changing cron alone
cannot remove the benchmark dependency. Observed benchmark availability was
10:17–11:17 HKT, so 11:00 is a trial objective, not a promised publication time.

## Completion means covered evidence, never report date or double-read stability

Reuse the previously offline v2 completion policy and approved cash disclosure
without enabling its prototype. Each exact-target broker receipt must come through
a reviewed fixed authenticated transport: fixed provider, complete scoped scan and
pagination, zero review/unknown/partial/submitted/unposted/unknown-fee/metadata
pending, actual fee and unique trade/cash readback, cash provenance, nontrade
coverage and immutable generation/fingerprint bindings. Local JSON and supplied
issuer names cannot establish authentication. The callback-only planner is a test
seam, not a production authenticated adapter. SGOV Tasks or other real known pending
items must block; LIMITED coverage is disclosed and never relabeled FINAL.
The existing approved estimated Schwab cash option must retain the literal
"嘉信现金未独立核对". Default draft policy is stricter require-independent;
activation must explicitly select the already-approved disclosed option if used.

Broker snapshot fingerprint excludes benchmark values, so adding the same-target
SPY/QQQ bundle does not masquerade as a new broker sync. Re-read both immutable
receipt generations, pointer generations, source journal and exact destination
binding before writer, before candidate signing and at protected promotion.
Expired/revoked proof, a new pending item or concurrent source mutation stops.
Current main lacks this production completion transport and promotion recheck;
there is no authority to infer COMPLETE from its health sourceDates.

## Early two-stage implementation still required before early activation

1. Wire actual Schwab/Webull controlled evidence producers and authenticated
   generation-pinned GET transport; prove all declared covered inputs. Webull
   nontrade/actual-fee cloud authority and both complete receipts remain blockers.
2. Feed a fixed reviewed target-calendar resolver, not benchmark dates, to the
   original source reader; allow an absent bundle only after completion validation.
   Use original private economic source and daily writer, style and flow gates.
3. Bind encrypted completion evidence to exact candidate data hash and require
   live recheck in existing protected Validate/Promote; preserve signed owner,
   same-main-parent, amount-free diagnostics and fail-closed errors.
4. Core candidate omits the pending bundle and creates health benchmark null;
   benchmark arrival triggers the original same-target replacement with dividends,
   fee/ledger invariants and complete revalidation. Do not publish stale benchmark
   as current or call successful core publication benchmark-complete.
5. Use PR330 observer for main/public receipt equality, ciphertext hash, deployment
   state and candidate/run lists. Core success and benchmark pending are distinct.

## Proposed independent clock and exact new authority checklist

Project family-portfolio-gateway, region asia-east2; all new schedules start PAUSED.
Proposed fee-daily-clock Job: task1, parallelism1, maxRetries0, timeout120 seconds;
only fixed repository huanwujoy-crypto/fee-console, workflow365873934, main, no
caller-selected inputs. Scheduler proposes Tue–Sat 11:00 HKT launch/check and
11:30 check/alert. Later benchmark-driven same-target replacement remains bounded
and deduplicated; not tied to another GitHub cron reliability assumption.

- New fee-daily-clock runtime identity: accessor only on new
  fee-daily-trigger-github secret; no financial credentials or project-wide role.
- New fee-daily-clock-invoker identity: run.invoker only on the one new fixed Job;
  no runWithOverrides or financial-job execution.
- New fine-grained GitHub credential: only this repository Actions read/write.
  This is REPOSITORY-WIDE, not single-workflow permission; compromised credential
  can operate other Actions. OWNER must separately accept this residual scope.
  No Contents/Issues/Administration write; no copied OWNER/XUAN/producer token.
- Proposed new private bucket fee-console-clock-state-860729177589,
  fee-clock/v1/ prefix: condition-scoped objectCreator/objectViewer
  for immutable generation=0 claim keys. One claim per target AND stage
  (core or benchmark replacement), so benchmark replacement is possible. Unknown
  POST result keeps claim and stops; do not delete claims for automatic retry.
- Separate read-only fee producer completion prefixes fee-completion/v2/schwab/
  and fee-completion/v2/webull/ in existing buckets
  family-portfolio-gateway-schwab-gmail-state-860729177589 and
  family-portfolio-gateway-webull-gmail-state-860729177589 respectively.
  Existing fee-cloud-producer identity requires separately approved custom
  feeCompletionObjectReader with storage.objects.get only and exact prefix
  conditions; no project-wide binding. Bucket identity/existence must be
  checked before any grant. Webull cash-result reader binding to bucket
  family-portfolio-gateway-webull-cash-oauth / cash-results/ for the existing
  webull-gmail-sync-runtime identity is a separate storage.objects.get scope,
  not silently implied by completion read. No wildcard storage admin roles.
- Monitoring uses an already verified OWNER channel; exact destination and token
  expiry alert need review. Do not send notifications while drafting.

At-least-once delivery requires atomic durable claims plus complete run/candidate/
Validate/Promote/Pages dedup. Existing GitHub concurrency serializes but is not
exactly-once financial reading. If source/publish jobs already exist, observe;
11:30 pending completion or missing start alerts, never forces a fake COMPLETE.

## Deployment and trial approval remain separate

No resources, credentials, IAM or schedules have been created by this draft.
Freeze and approve the complete signed code head, then separately review exact
identities, credential scope, prefixes, fixed image digest, paused schedules and
alert destination. First controlled live trial should be the next eligible date,
not an extra Oct6 rerun. Prove cloud clock -> real complete broker evidence ->
original writer/receipt -> signed candidate -> Validate/Promote/Pages -> public
same-target core hash, then same-target benchmark replacement and unchanged
ledger/fee/investor invariants. Measure source completion, dispatch/start, core
public-visible and benchmark-complete times; distinguish <=11:00 objective from
11:30 exception check. Retain current cron until actual independent trial passes.
Rollback pauses only the new schedules; never relax completion or fee guards.

## Consolidated workflow efficiency increment (Oct7 14:13 approval)

Keep one Draft and one reviewed release bundle. The new executable pieces are:

- `verifyWebullTradeLink`: adapts actual WEBULL_OFFICIAL_READ business fields
  order_id/symbol/side/business_date/quantity/price/cash_net and fees commission,
  sec, other to the existing exact SELL/cash/trade matcher. Emits a private
  per-trade receipt binding source evidence, approved policy, actual fee and
  destination hash. It explicitly sets wholeDayComplete=false. Same record
  evidence is reused by the downstream source, writer and publication preflight.
- `observeExistingFeeEvidence`: uses actual webull_manual_completion_v1,
  webull_gmail_sync_receipt_v1, webull_cloud_sync_state_v1, READONLY_PREVIEW.webull,
  and Schwab last_complete_scan_at/events/processed fields. These schemas do not
  contain a complete target-scoped pagination/partition and immutable receipt
  binding. The adapter therefore NEVER fabricates v2 COMPLETE, even when a
  human-facing summary says COMPLETE or a manual trade is read back.
- `fee-offline-preflight.mjs`: invokes the existing synthetic source/flow/style,
  private economic source, daily writer, actual fee, receipt, health, signed
  candidate, supervisor and new publication-guard tests. Only fixed count/state
  output is printed. No broker network, live ledger write or new credentials.
- Fixed GCS transport reused from the reviewed offline prototype validates exact
  bucket/prefix, metadata generation, raw receipt hash, fixed provider boundary,
  pointer state and receipt coverage. It cannot turn old v1 state into v2 proof.
- `assertCompletionBeforePromotion`: executable live re-read of generation-pinned
  proof and destination fingerprint, plus AES-GCM sealed binding to exact target
  and candidate ciphertext hash. Disabled mode blocks this new guard; no existing
  production workflow calls it yet. `assertFeePublicReadback` distinguishes core
  pending benchmark from completed same-target benchmark using actual byte hashes.
- `persistSafeFeeFailure`: persists only fixed stage/code/run/time JSON in an
  external mode0700 directory as mode0600 atomic create. Raw exception, stack,
  account, amount, URL and source payload are discarded. This local adapter is
  tested; cloud persistence still requires the separately reviewed create-only
  prefix below. No promise that ephemeral container files are durable.

### Actual schema boundary and real archive replay

The existing archive demonstrates the Oct6 manual SELL link and actual fee can
be proven without another source call. It also has a manual receipt with
end_to_end_complete=false, Webull receipt pending/Tasks not authoritatively clear,
and no target-scoped v2 scan receipt; Schwab has a scan timestamp without complete
target partition/generation attestation. These are archived observations, NOT a
new current-state reading and not an assertion that later independent work failed.
The adapter reports these deficiencies, not a guessed zero pending count. IB
fields and its COMPLETE status are excluded from the fee scope.

### Single consolidated deployment/permission/trial review packet

Before requesting final deployment approval, freeze the complete controller,
broker adapter and fee guard code, production config and immutable image digests
as one package. Do not ask the user to approve a planner as a production release.
The existing broker services should emit new authoritative v2 coverage from their
actual scans/readbacks; do not add a separate microservice per stage. The fee clock
is one independent fixed relay Job, not separate jobs for each gate. Preserve all
existing identities, write switches, cash policy, pubsub and financial endpoints.

In addition to the exact new scopes already listed above:

- Existing fee-cloud-producer needs create-only access in the proposed private
  fee-console-clock-state-860729177589 bucket under fee-failures/v1/ only, if cloud
  durable safe summaries are selected. No raw payloads, update/delete/list, wider
  bucket role or copied signing/financial token. Review owner read/retention
  destination separately; do not publicly upload private raw failure material.
- Protected candidate/promote recheck identity and fixed job/workflow WIF trust
  must be explicitly reviewed. Current dispatch-only source identity is not
  automatically authorized for workflow_run or pull_request. An authenticated
  fixed recheck adapter is needed; no broad trust widening is implied.
- The native Schwab/Webull evidence producer deployment and its existing source
  availability must be included in the one packet. Missing full trade/nontrade/
  actual fee authority is an external blocker, not solved by new receipt names.
- Scan/calendar/receipt freshness bounds, same-target core/benchmark stage claims,
  bounded dispatch and unknown-POST behavior must be stated explicitly. One
  eligible-date controlled trial, with one core and one benchmark replacement
  only when new verified bundle is available; no unbounded recovery loop.

Order: offline complete compatibility preflight and immutable release review ->
exact OWNER code approvals -> existing-service adapter deployment in current
permitted scope -> separate explicitly approved new prefix/identity/token/clock
bindings -> paused configuration readback -> amount-free alert test -> one real
next-eligible-date trial -> full public data/fee/investor/content acceptance ->
unpause. Unknown fees/Tasks/identity/receipt revoke stops; old verified report
remains visible. Step Summary must be inspected via the existing logged-in
GitHub UI, not mistaken for shell fallback source. Future reviewed workflow should
write the already allowlisted fixed diagnostic into logs and private durable
summary before cleanup, preventing another diagnostic-code PR merely to expose
an existing error. No production change is executed by this packet.


## Integrated first release (2026-10-07)

This is now an executable minimum integration rather than a planner-only package:

- The existing producer, candidate validator and trusted-main promoter each execute
  the credential-free full fee-chain preflight. Candidate preflight runs only after
  the original candidate boundary, verified-owner signature, envelope and health
  checks. No candidate authority, deploy-key boundary or existing amount gate is removed.
- The existing strict Webull SELL/net-proceeds matcher emits a structured destination
  association receipt. Producer seals it with the existing data key using AES-GCM
  and AAD binding target date plus exact candidate data SHA. The optional
  `tradeLinkBinding` is persisted in health, preserving ciphertext-only public
  storage. Original seven-field health remains valid; unknown fields and malformed
  association envelopes remain invalid. Existing Validate/Promote health CLI therefore
  checks the new envelope with no new secret access. Destination matching is explicitly
  `DESTINATION_MATCHED_ONLY`, not independent official broker actual-fee proof or
  whole-day completion. The stronger archived official-business adapter remains separate.
- Producer emits the actual fixed diagnostic code directly to retained Actions logs
  before failing, in addition to Step Summary. Validate/Promote retain only fixed
  categories. Logs are public, bounded safe evidence, not private financial storage.
- After protected promotion, a fixed anonymous GET checks Pages health/data against
  the selected candidate for up to eight attempts. Byte/date/health disagreement reports
  `PUBLIC_BYTES_PENDING`, never success. This observational step cannot reverse or
  overwrite a successful promotion and does not block later Pages publishing.
- Early target now reuses `cloud/xuan-preopen/calendar.mjs` NYSE annual tables only,
  with a conservative 06:00 HKT cutoff. No IB account, source, completion or schedule
  dependency is imported. Unsupported calendar years fail closed. Existing producer
  still selects its original benchmark-derived target; early publication stays disabled.

### Existing private storage: read-only inspection

Project IAM and the existing broker-summary, Webull state and Schwab state bucket IAM
were read without any objects, credentials or broker calls. No explicit producer
storage grant was found at project level or on those three buckets. They contain
broker identities' existing grants, which are not borrowed. This repository is public;
Actions artifacts are not a private storage substitute. Thus private cloud failure
persistence is still a real permission blocker, not silently considered deployed.
A minimal future choice is create-only access for the existing fee producer to
`fee-failures/v1/` in the existing private broker-summary bucket, after separate
approval of the new prefix, exact condition and retention/readback destination.
No such grant or object was created. The local 0600 private persistence module is
ready but an ephemeral runner directory is never claimed durable.

### Broker-specific early-publication gaps

| Broker / existing interface | Evidence already composable | Proof still missing / action |
| --- | --- | --- |
| Webull native read + manual completion v1 + native receipt v1 + cloud journal v1 | Official FILLED order/actual-fee archive can link unique confirmed Sharesight trade and matching net cash; manual Tasks/cash readbacks and immutable cash-result hashes can be retained; destination performance/holdings/trades/cash/raw hashes can be bound | No authenticated target-scoped full scan partition, complete pagination/query bounds and authoritative zero pending/conflict statement is currently emitted. Manual end-to-end and per-order readback do not attest unseen orders. Extend existing runtime scan/Task hook and publisher to emit v2 proof; source fees require official order/actual fee capture for every target trade, including SGOV. Any unavailable authoritative source scope requires user-approved source capability/new interface. |
| Schwab existing Gmail scan state + events/processed + Sharesight exact readbacks | Existing scan timestamp, target-dated VERIFIED events and original exact trade/cash matcher can be combined with captured official confirmation fee economics and destination raw hashes | Timestamp has no immutable target query/window/pagination/pending partition; processed entries cannot establish target zero pending. Official actual-fee confirmations must reconcile every target trade; absent confirmations stay pending, not zero-fee guesses. Extend existing scan and confirmation hooks to emit covered target v2 proof. Independent cash currently explicitly unverified; approved estimate/disclosure may remain, unknown non-trade coverage cannot. New source access, if required, needs separate approval. |
| Both existing Sharesight GET-only portfolio interfaces | Same-target performance plus holdings, trades and cash can demonstrate stable destination state and exact associations | `report.end_date` and double-read stability cannot prove source ingestion completion. Generation-pinned signed service boundary, journal/source/cash and destination binding rechecks require source producers and exact read-only IAM before enabling early path. |

### Finite activation packet

1. Approve the final signed complete diff under the existing sensitive OWNER gate;
   required script/UI/policy checks and trusted-main freshness remain mandatory.
2. Merge the minimum integrated code/workflows only. No IAM, identity, secret, storage,
   cron or data-rule change is necessary for preflight, encrypted association health,
   retained safe diagnostics and observational public-byte acceptance.
3. On the next eligible normal fee publication, observe one existing producer chain:
   source stability, writer, fee receipt, health binding, provenance, promotion, Pages
   byte acceptance. A retry requires a specific verified transient failure and a bounded
   authorization; do not add another Oct6 catch-up run after the successful recovery.
4. Private cloud diagnostics remain a separately named narrow existing-bucket grant.
   Early publication is a separate disabled stage until actual broker full-coverage
   emitters and rechecks pass. The inherited prototype one-hour completion freshness
   bounds are proposed, not prior production approval. No fixed 11:00 guarantee is made.
