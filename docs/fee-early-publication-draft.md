# Fee-chain diagnostics and association evidence; early publication disabled

This draft improves the existing fee producer and protected publication chain.
It contains no real private trading, fee, cash, pending-item or completion observations.
Examples and regression fixtures are synthetic. Private source scope cannot be inferred
from the public health dates, destination report date or a stable double read.

## Minimum integration

- Preserve the existing GET-only source identity/stability checks, private economic
  source checks, style preflight, original daily writer, unresolved-flow gate,
  fee-calculation receipt and health/data hash validation.
- The existing strict Webull SELL/net-proceeds matcher emits structured destination
  association receipts. Canonical IDs compare without Number precision loss;
  original bounded source-ID validation remains intact. Unique trade/order and exact
  quantity/price/gross/net/recorded-fee relationships are still required.
- Destination receipts are explicitly DESTINATION_MATCHED_ONLY and never assert
  independent official actual fees or whole-day source completion. A separate
  official-business adapter checks the stronger supplied source proof in synthetic tests.
- Producer seals an association set on EVERY success, including an empty set, using
  the existing data key and AES-GCM AAD containing target date and exact data SHA.
  The encrypted plaintext has fixed 262,144-byte random padding. The public
  tradeLinkBinding envelope therefore has constant presence, shape and byte length
  independent of private activity or association count. Up to 500 associations fit;
  overflow fails before candidate creation. No plaintext IDs/counts enter health.
- Producer reopens and compares the sealed contents before final health validation.
  Public Validate/Promote check the exact allowed health shape, canonical fixed-size
  ciphertext envelope and data hash without acquiring the private key. Envelope
  shape validation is NOT independent validation of decrypted content. Original
  seven-field health remains valid for compatibility; unknown keys stay rejected.
- Producer emits the actual allowlisted diagnostic code to retained Actions logs
  in addition to Step Summary. Validate/Promote emit only fixed failure categories.
  These public safe diagnostics are not private financial storage.
- After the sole valid candidate is selected, freeze health/data FROM ITS EXACT SHA,
  independently of branch-loop scratch files. Revalidate these selected bytes.
  Protected promotion still rechecks main and uses only its existing dedicated key.
  The post-promotion fixed anonymous Pages GET compares the selected health/data
  for bounded attempts. Delayed Pages reports PUBLIC_BYTES_PENDING, never completion.
  The observation cannot change or reverse successful promotion.

## Regression and current-input acceptance

Synthetic regression remains in the existing PR scripts-check suite. New tests are
imported by its existing fee-cloud-source.test.mjs entrypoint. The local
fee-offline-preflight.mjs runner is named fee.synthetic-regression.v1, passes a small
explicit environment allowlist to children and prints test counts only. It neither
measures nor claims zero network/writes, and is not a sandbox or current-input
financial acceptance. Do not run this regression after installing a promotion key.
It is not repeated in producer, Validate or Promote.

Current-input acceptance remains the existing producer source/style/writer/flow/fee
receipt/health gates, candidate provenance validation, trusted-main promotion and
new exact selected-byte public observation. No fee math, investor allocation,
private ledger, normal target selection or original publication safeguard is removed.

## Early publication remains a separate disabled stage

Reuse PR326 trigger core and PR330 observer architecture, not duplicate services.
The core is reused verbatim and is not activated for the early stage. Reuse the
existing reviewed cloud/xuan-preopen/calendar.mjs NYSE annual tables via the fee
session adapter, with a conservative 06:00 HKT cutoff. Unsupported years fail closed.
This imports no IB account, financial source, completion requirement or schedule.
The normal producer still selects its original benchmark-derived target.

Early publication requires authenticated target-scoped full source coverage,
complete pagination/query bounds, no unresolved/pending/unknown-fee partition,
actual-fee and unique trade/cash proofs, nontrade coverage and immutable source,
journal, cash and destination bindings. Local JSON issuer names cannot establish
provider authority. Known pending SGOV or other Tasks block this early stage only.
A source report.end_date or stable destination double read is not a sync-complete proof.

| Source interface | Generic evidence that can compose | Required missing capability before early activation |
| --- | --- | --- |
| Webull native/manual receipt and journal v1 | Official order/actual fee proof, unique destination trade/net cash, authoritative Tasks result and immutable cash receipt may compose when supplied and verified | Source producer must attest complete target query/window, pagination, full pending/conflict partition and each actual fee; per-item manual completion cannot attest unseen orders. Extend existing hooks; new authoritative source capability, if needed, requires separate user approval. |
| Schwab scan/event state and destination readbacks | Target-dated verified events, exact readbacks and official confirmation fee economics may compose when supplied and verified | Scan timestamp alone cannot attest target window/pagination or zero pending. Capture complete partition and every target confirmation/actual fee. Missing independent cash must retain the reviewed estimate disclosure; unknown nontrade coverage never counts as complete. |
| Sharesight fixed GET-only portfolio reader | Performance, holdings, trades and cash demonstrate destination stability and exact associations | Destination dates do not prove source completion. Authenticated generation-pinned source proof and live source/journal/cash/destination rechecks must be wired before enabling early production. |

The prototype completion freshness bounds are proposed, not prior production
approval. Approximately 11:00 HKT is a future trial objective, with an 11:30 exception
check; no guarantee, timer or cron change is activated. Benchmark pending and later
same-target replacement use the original writer and revalidation once enabled.
No early coverage requirement is applied to today's normal producer.

## Private persistence and narrow authority review

Read-only project and relevant existing bucket IAM inspection did not establish an
explicit fee-producer storage grant. This repository is public; GitHub artifacts
are not private storage. Existing broker/XUAN identities and authority are not borrowed.
Local mode0700/mode0600 failure persistence is tested but runner files are ephemeral.

Private cloud failure persistence needs separate explicit approval: use the existing
fee producer identity and, if approved, create-only conditional access to
fee-failures/v1/ in the existing private broker-summary-state bucket. Review retention,
reader and exact condition before writing. No IAM grant, object, new identity, bucket,
credential or schedule is created by this draft.

Any later independent early clock needs a separately approved exact identity,
secret and fixed Job, target-and-stage durable claims, bounded retry and notification
recipient. GitHub Actions write is repository-wide, not workflow-specific. Never borrow
OWNER/XUAN tokens or extend workflow_run WIF authority by assumption.

## Finite first activation packet

1. Finish independent diff/privacy review, then freeze one signed complete head on
   current trusted main. Obtain the existing sensitive exact-head OWNER gate and
   full scripts-check/ui-pr-check/xuan-ib-policy-lock checks. Draft notices do not count.
2. Activate only the minimum existing code/workflow release. It needs no new IAM,
   identity, secret, resource or schedule. Early publication stays disabled.
3. Observe the next eligible normal producer through original financial gates,
   selected candidate provenance, protected promotion and exact Pages byte acceptance.
   Do not introduce redundant recovery runs; retry requires verified transient cause
   and an explicitly bounded authorization.
4. Keep private storage permissions and authenticated early source coverage as distinct
   explicit blockers. Never approve or claim the disabled early design as deployed.
