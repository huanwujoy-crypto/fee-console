# Application readiness and incident diagnostics — offline candidate

This change is an observation layer, not an activated producer, scheduler,
notification service or publication gate. It contains no financial credentials,
source requests, fees, account changes, registry writes or production dispatch.
The fee and XUAN-IB applications retain separate sources and publication chains.

## Why this is needed

On 2026-10-13 HKT, the fee producer's first planned start was 10:00 and the
Oct12 public result completed at 19:44: a 9h44m interval, not a missed promise
to finish at 10:00. The final approved production-to-publication chain took
about two minutes. Earlier recovery progressed through distinct dependencies:

1. At 02:10 the benchmark run correctly found no newly completed close before
   the New York close. At the morning observation, the 07:35/09:35 slots had
   no visible run. No-visible-run is not a financial request failure.
2. The 10:37 actual fee run failed cash reconciliation. PR381 fixed the verified
   cash-ledger date/independent opening-balance evidence and merged at 12:17.
3. The 13:11 actual fee run passed that source stage and failed the original
   style preflight. Later scheduled runs repeated the same metadata failure.
4. PR382 added a read-only diagnostic. AMZN's missing registry entry and true
   first-held date were then established. PR384 added one explicitly approved,
   narrowly locked proposal transport; the original writer persisted it.
5. A DOM fixture mismatch and Linux inode reuse required separate test repairs
   and approval of changed heads. The final Linux checks, protected merge,
   one approved recovery producer and public byte/date read-back then passed.

The cash fix, diagnostic, proposal transport and fixture repairs are code
changes. The same-day benchmark recovery, temporary reviewed proposal input
and policy-check refresh were manual recovery. The proposal input was deleted;
its Oct12-only transport is not a general future classifier. The later natural
run reused the verified published Oct12 result without a fresh financial read.

Evidence: [early benchmark](https://github.com/huanwujoy-crypto/fee-console/actions/runs/38289082963),
[PR381](https://github.com/huanwujoy-crypto/fee-console/pull/381),
[source-to-style transition](https://github.com/huanwujoy-crypto/fee-console/actions/runs/38350165563),
[PR382](https://github.com/huanwujoy-crypto/fee-console/pull/382),
[PR384](https://github.com/huanwujoy-crypto/fee-console/pull/384),
[successful recovery](https://github.com/huanwujoy-crypto/fee-console/actions/runs/38392015275),
[verified publication reuse](https://github.com/huanwujoy-crypto/fee-console/actions/runs/38392737527).

## Small implementation

`scripts/app-readiness.mjs` collects a fixed checklist in one pass, retaining
every failed, unavailable or unchecked dependency. A failure never suppresses
the next independent probe. Raw exceptions and financial payloads are replaced
with fixed codes. Probes must use the application's already authorized,
bounded read-only checks; a dependent probe reports unavailable when its
required snapshot is absent. This module does not create an extra source read.

The fee adapters call the existing `selectBenchmark` and `resolveStyle`
against supplied snapshots. They do not alter either validator. Classification
diagnostics expose a missing count, not ticker, holding identity or values.
There are explicit `fee`, `ib-live` and `ib-eod` profiles. The IB profiles do
not decide whether a missing item may be omitted or whether an EOD financial
proof is sufficient: those decisions remain with the existing source,
classification and section gates. Missing optional live EOD data must never
be promoted to a zero cash/order value or labelled current.

The publication check is a separate completion observation, not a prerequisite
that demands an already-published result before producing it. `allChecksReady`
describes the supplied observations only. `grantsPublication` is always false.
An early readiness summary must be revalidated at the actual producer boundary;
it cannot freeze overnight prices, positions or ledger revisions indefinitely.

`scripts/app-run-diagnostics.mjs` makes pure decisions from a caller-supplied
target/window listing and independently verified public-result observation:

- Not due, not started, queued, in progress, skipped, cancelled, failed,
  timed out, candidate and reuse are separate states.
- Only the existing transient source-code allowlist permits one retry, with
  two attempts maximum. Identity, date, cash and classification failures stop.
- A known blocker escalates immediately. Two completed failures for the target
  without verified publication escalate; other unverified results escalate at
  an explicit caller-provided deadline. A skip/cancellation is not a failure.
- One incident key per application/target deduplicates repeated observations.
  A changed reason updates that incident. No function sends a notification,
  closes an existing repair issue or starts another producer.
- Candidate/reuse success never establishes public completion. An unavailable
  run listing produces observation-unavailable, never not-started.

The caller must validate the complete Actions listing, target binding and
observation window before reporting coverage=complete. This pure helper does
not authenticate that assertion. `attemptAt` must bind the observed attempt,
not a rerun's old `created_at`. A history of blockers/two failures remains
unresolved through a later queue, skip, cancellation, candidate or reuse until
public completion is independently verified. `feeDiagnosticCode` safely maps
known producer codes; the historical coarse STYLE code does not prove which
holding is missing. Unmapped codes remain UNKNOWN. It does not establish
exchange calendars or deadlines. The current supervisor is untouched.

## Classification impact and escalation boundary

In the fee application, the original style resolver runs before the writer
creates the target point and fee receipt. A missing entry currently blocks
the entire new daily candidate, including AUM/receipt delivery. It is a missing
report-metadata gate, not evidence that a holding's fee arithmetic failed.
This candidate does not change that boundary or publish partial fees.

Already reviewed entries for the same verified holding identity are reused
under the original immutable registry. A new identity requires its actual
first-held date and the existing independent review; a matching ticker alone
does not authorize inheritance. IB's existing automatic classification and
optional-section rules are separate from the fee registry.

For future standing delegation, ordinary issuer classifications with verified
instrument identity, complete first-held history and independent review could
be prepared together before the production window. The user should approve
the concrete recurring scope once rather than make the same routine choice
each day. That delegation is a proposal, not granted by this implementation.
Unknown fund/derivative strategy, ambiguous identity or first-held history,
conflicting classification, external capital ownership, fee/Carry/HWM rules
and income attribution remain explicit blocking decisions. Never default to
growth or use a guessed date to obtain a green run.

## Validation before release

The existing `scripts-check` gains the new diagnostics tests. A separate
PR-only Linux/macOS check also executes the existing style-file replacement
and full browser-ledger fixtures. The former creates two simultaneously live
files before rename, so the test does not depend on deleted inode reuse. The
latter exercises the real inline browser app and its DOM fixture. These jobs
use only contents:read, no Environment, financial secret or OIDC identity.

Run the full existing formal script groups on the proposed code, plus the
new groups and privacy/UI guards. Collect Linux and macOS results before
freezing the exact final head and requesting one code-release approval. Do
not call a local macOS pass a Linux pass. New/changed workflows and files are
sensitive under the current approval registry. This candidate registers its
six new paths as sensitive so the complete-file registration test remains
intact. It does not change the 22 ordinary files, prefixes, classifier, OWNER
fallback or any required check. This registration diff needs separate explicit
review as authorization-policy metadata before a protected code release.

## Separate approval and remaining integration

This local diff does not activate probes or an observer. A subsequent reviewed
integration needs these concrete decisions, presented together rather than
requested one by one:

1. **Read-only binding:** bind the readiness probes to the existing authorized
   reader snapshots and validators, without additional financial calls or
   credential access. Stop on an unavailable prerequisite and report it.
2. **Publication schedule/deadline:** approve a preflight time and an explicit
   completion deadline separately from the producer's planned start. Keep New
   York completed-session dates and official exchange holiday/half-day rules;
   any schedule/calendar/source changes need their own concrete diff.
3. **Alert activation:** approve reuse of the existing amount-free repair-issue
   path and its delivery destination. To detect GitHub's own missing schedule,
   use an independently operating observer; another GitHub cron cannot prove
   reliable detection when GitHub itself does not trigger. No such external
   observer or permission has been established by this local work.
4. **Financial meanings:** no fee/rate/attribution change or unknown-classification
   downgrade is proposed here. Any future partial-publication or standing
   classification policy requires explicit scope approval and regression proof.
5. **Production/permissions:** signed PR/merge, enabling observer or source
   integration, production runs and any credential/permission change remain
   separate approvals. Today must not be run again to test this candidate.
6. **Sensitive registration:** approve only the six new sensitive file-list
   entries in `security/approval-tiers.json`, alongside the concrete code diff.
   This grants no ordinary delegation or account/cloud permission. No change
   to the trusted classifier, OWNER requirement or platform rules is requested.

There is no database, new financial provider, generic classifier or new
credential in this proposal. Real-world activation and independent public
read-back remain outstanding; the current Oct12 receipt remains the completed
production result, unaffected by this offline candidate.
