# Fee report periods

This candidate changes publication cadence, not the economic contract. It is
inactive until signed review, exact-head OWNER approval and protected merge.
The existing stop-daily gate remains active on main during preparation.
Scheduled activation additionally requires the non-secret repository variable
`FEE_REPORT_PERIODS_ENABLED=true`. It is not created or enabled by this PR.
Leave it absent/false until the separately reviewed historical preview, source
checks and protected publication read-back pass. Manual dispatch retains its
explicit default-false `run_reviewed_once` gate and does not enable a schedule.

## Dates and source coverage

- Weekly: Saturday is available for manual synchronization; the first attempt
  is Sunday 00:00 Asia/Hong_Kong. The accounting cutoff is Friday and the stock
  price cutoff is that week's last reviewed NYSE session. A Friday holiday does
  not turn Thursday's quote into a Friday quote.
- Monthly: D is the month's last reviewed NYSE session. D+1 is available for
  synchronization; the first attempt is D+2 at HKT midnight, never earlier than
  the next natural month. The accounting cutoff is the month's last calendar
  day, independently of the last price day. If that day has not ended in New
  York, the public gate waits. It does not weaken the existing health clock.
- The public calendar/publication gate has HKT 00:00, 01:00, 08:00 and 13:00
  slots. It enters no financial environment when no period is due, a candidate
  is pending, the accounting day is incomplete, or that exact coverage is already
  published. This is not four financial reports per day.
- Weekly and monthly plans with the same accounting and price cutoffs combine
  into one report. An additional natural accounting day with the same stock
  quote is a different cutoff and keeps its genuine fee day.
- Unsupported calendar years, missing same-session SPY/QQQ quotes, source gaps,
  unstable reads and expired recovery/promotion windows fail closed. Calendar
  dates match the existing reviewed NYSE calendar for every supported day.

## Daily calculations, final month and presentation

`fee-report-producer.mjs` captures the whole bounded calendar-date range twice
before writing. Every date uses actual dated Sharesight valuation, native cash,
transactions and existing flow/income rules. Closed-session benchmark prices
carry only with positive reviewed-calendar evidence and never repeat dividends.
Account NAV is never interpolated from a Friday or a current holdings screen.

One frozen revision of the existing encrypted economic source is used throughout.
The original `daily.mjs` remains the sole writer. It rebuilds each daily point,
TWR chain, natural-day fee basis, high-water and receipt in a private temporary
candidate. There is no intermediate public report. Source changes or any failed
daily step discard the entire candidate. Original data and the economic book
remain untouched.

Final monthly reports lock their completed fee periods, semantic daily values,
automatic flow identities and applicable economic inputs inside authenticated
encrypted data. A later change fails with `FEE_REPORT_LOCKED_MONTH_CHANGED`;
it is not silently overwritten or corrected. Fee payment records remain
independent of those accrual locks. Corrections require separate review.

Report metadata is inside the encrypted payload, bound to the validated fee
receipt: weekly/monthly/combined type, report period, price cutoff, accounting
cutoff, generation time, next scheduled period and non-real-time status. Missing
or mismatched metadata is displayed as pending. Existing weekly coverage may
remain valid between reports; new candidate promotion still uses the unchanged
fresh-health and target-age checks.

The investor calculation and economic event history stay daily. Chart and table
presentation select inception, Fridays, calendar month ends and latest proved
date. Change between snapshots subtracts all intervening subscriptions and share
transfers. It does not compare a weekly difference with just one day's cash flow.

## Account and evidence boundaries

Schwab-HK + Webull remain the fee composite. Jenny's IB is an independent gross
TWR and drawdown assessment only. It never changes fee principal, management
rates, Carry, payment amounts, investor shares or original benchmarks.

Manual synchronization completion is per account and per captured period. A
stable Sharesight response does not prove that an externally reported migration
has been recorded. Until later IB source coverage is attested, normal IB handoff
is held at the existing audited baseline cutoff (or validated finite private
coverage in the local future-period candidate) with
`IB_SOURCE_COVERAGE_UNVERIFIED`. Original composite production can continue.
Post-cutoff transfers cannot enter an earlier historical report. Payout date,
settlement date and actual cash-credit date remain distinct under existing income
date evidence; no sync or duplicate payout write is performed by this candidate.

The previously confirmed private IB historical correction remains valid. The
strict native source may still differ from it or lack linked noncash evidence.
Code tests do not establish a matching real baseline, provision an environment
variable or privately attach that history. No new JSON Secret, private storage
channel, browser import, credential, source write or seed workflow is introduced.
Real independent values may replace pending only after a valid source/return/
drawdown bundle is actually encrypted, protected, published and unlocked for
read-back. See `ib-manager-return.md` for the remaining evidence-carriage boundary.

## One reviewed historical preview

### HKT midnight versus the current New York completion guard

No schedule or guard is changed by the future-IB local candidate. The requested
monthly start remains D+2 HKT 00:00, not a silently changed 13:00 schedule.
`monthlyReportPlan` separately chooses the last NYSE price date and the last
calendar accounting day. `reportPlanReadiness` then explicitly requires the
current New York date to be later than that accounting day. For October 2026,
11/1 00:00 HKT is still 10/31 12:00 New York. The NY day finishes at 11/1 12:00
HKT; the next existing gate is 13:00. Thus 00:00 begins checking, not guaranteed
final-month publication. Weekly 10/30 coverage is independently eligible at 00:00.

The source checks `report.start_date`, `end_date`, `portfolio_tz_name` and dated
cash `date_time`/query bounds. It has no observed provider field certifying
"this business day is closed". Requiring exact historical dates, complete
cash/transactions and refusing unoccurred future activity is necessary. The
fixed NY-current-date wait is this implementation's extra conservative method;
it has not been proved to be an API-mandated delay. Two stable midday reads are
not proof that no later month-end cash event will arrive. Finalizing at HKT
midnight would need independently verified period-close evidence or an explicitly
reviewed accounting-timezone/contract decision, not simply removing this guard.
Neither is implemented here. Explain this difference before production activation.

The normal path can prepare an explicitly selected weekly or month-end target:

```
node scripts/fee-report-producer.mjs --mode=preflight --report-kind=weekly --report-target=YYYY-MM-DD
```

This preflight reads only public main publication evidence. A production dispatch
requires `run_reviewed_once=true`, an agreed kind and accounting target, the final
protected source code and the existing trusted environment. Do not reuse an old
request or execute it during code preparation. No key is passed in arguments.
An encrypted ledger already ahead of the requested historical cutoff is refused;
current holdings are never used to roll it backwards or impersonate history.
The original signed two-file candidate and trusted promotion remain mandatory.

## Proposed source-attempt ceiling (local, not enabled)

The four public daily gates previously could enter financial sources again after
a failed due period. This local candidate caps financial entry at two source jobs
per report kind and accounting cutoff: the original plus at most one later gate.
It reads only fixed public Actions run/job metadata, including all job attempts;
no logs, secrets, private input channel or new persistent state is introduced.
Each source job is labelled with its kind and cutoff. A legacy unlabelled source
job conservatively consumes either budget. Missing/partial metadata, another
active job, or an exhausted budget waits without financial credentials.
Workflow reruns are refused before financial source access, including reruns of
older workflows that predate the queried period. A new dispatch is not implicitly
authorized by an available budget. The original period, freshness, source,
signature, candidate and publication gates remain mandatory.

This is a local scheduling-safety candidate only. It does not enable the schedule,
prove transfer ingestion, provide future IB coverage or automate ratio capture and
manager authentication. Public metadata acceptance and the final protected code
review are still required before activation.

## Fixed read-only field acceptance (local candidate; not executed)

### Credential-free plan diagnosis

`source_plan_check_only=true` is a separate default-false manual mode. It must
not be combined with `source_acceptance_once` or `run_reviewed_once`. Its
three-minute `source-plan-check` job has only `contents: read`, no financial
Environment, OIDC exchange, Secret step, benchmark read, writer or source
capture. It uses the same `source_main`, `source_from`, `source_target` and
`--check-plan` CLI gates as field acceptance. Normal period production and the
financial source job are explicitly excluded whenever this mode is selected.
It does not install a schedule or enable any production variable.

Plan failure emits only a finite phase/reason JSON object: arguments,
environment, attempt, Git HEAD/tracked/untracked, dates or public-main checks.
Public HTTP status/rate-limit classification is included without headers,
response bodies, raw exceptions, paths, environment names or values. Before
source capture, the diagnostic can truthfully report zero source/OAuth calls;
after entry to capture those counters are unknown rather than invented zeroes.
It is diagnostic data, never health, source completeness or publication proof.
Unknown exceptions remain redacted, and every existing refusal stays closed.

After this exact code has passed protected review, a separately authorized
metadata-only check may use `source_plan_check_only=true`, the two financial
mode flags false, and the frozen live protected main plus reviewed dates.
It makes at most the existing three public GitHub metadata GETs and does not
load Sharesight credentials. A successful plan check does not authorize or
consume a financial capture: a new bounded source attempt still needs its own
specific execution scope and current main. Do not replay a failed or consumed
run, replace dates automatically, renew evidence times or weaken a guard.

The old CLI collapsed every exception to `FEE_SOURCE_ACCEPTANCE_REFUSED`.
Where a historical run did not record its inner reason, replaying selected
inputs cannot prove which unrecorded host-environment or HTTP condition occurred.
Keep that uncertainty explicit; the new diagnostic must not retroactively
attribute an old failure to a particular branch without evidence.

The same `fee-cloud-producer.yml` has a default-false manual-only
`source_acceptance_once` input, mutually exclusive with `run_reviewed_once`.
It never runs naturally, never reruns, and never invokes the fee writer,
economic source, signing token, fee decryption key, Gist delivery or promotion.
Its expected-main/date plan is checked before existing source credentials are
loaded, and again before source access. The CLI verifies clean tracked code,
public main twice, verified owner identity, and refuses extra decryption or
publication credentials and preload/debug injection.

After separate exact-version and bounded-execution approval, the concrete call is:

```
node scripts/fee-source-acceptance.mjs --check-plan \
  --expected-main=<frozen-protected-main> --from-date=2026-10-24 \
  --target-date=2026-10-27 --out-dir=<private-temporary-directory>
```

The real capture uses those same arguments without `--check-plan`, only in the
reviewed source job. Its four-date maximum includes one additional opening
anchor. Two whole passes use the existing Sharesight client: Schwab-HK and
Webull daily performance, complete holdings/trades, dated cash and ledger
predecessors; IB-HK gets the same bounded date window and native transfer
fields. There is no broker, mail, Flex, arbitrary API URL or market quote call.
Limits are 300 source GETs, 10 OAuth client-credential grants, 2 MiB per response,
32 MiB private evidence and a 15-minute job. Scope, dates, currencies, truncation,
stability or any limit failure stops. OAuth replies, source secrets and bearer
values are never persisted. Bounded financial replies and the private manifest
are 0700/0600, never uploaded as artifacts, and cleaned on the hosted runner.
Only dates, fixed reason codes, counts and hashes reach the job output.
`fields-captured` is not a fee calculation, IB coverage grant or publication proof.
No actual field acceptance, permission expansion or financial run happened during
local development. There is no new Secret, IAM, recipient, private storage service
or financial write. Existing source rights being insufficient must stop the check.

## In-kind transfer adapter and valuation boundary

Normal reviewed period capture now validates account position changes. A newly
received Sharesight `OPENING_BALANCE` can become an effective existing
`external_asset_transfer` flow only with a unique same-day IB-HK `TRANSFER_OUT`,
exact instrument/market/currency and quantities, both dated position deltas,
complete cash coverage without a nonzero linked cash leg, and receiving EOD
market value agreeing with the explicit transfer-out valuation. Opening price
and value can preserve historical cost and never set the external-flow amount.
The original writer, flow identity/deduplication and TWR/fee rules are reused.

No received event means no fabricated receipt or added asset. No receipt event
in the managed accounts requires no IB connection. When an actual managed
receipt exists but its counterpart/date/valuation is missing, that account's
source is incomplete; this is not a reason to silently count the NAV rise as
profit. Date-mismatched settlement, arbitrary BUYs without proved cash, unsupported
splits/types and opposite/within-composite transfers remain unsupported and
fail closed; this first adapter does not pretend every transfer form is accepted.
It does not modify Sharesight, acquisition dates, cost base or historical fees.
The independent IB report remains nonblocking for an otherwise proved fee report.

The new independent-IB proof variant accepts a confirmed provider-native
`TRANSFER_OUT` with a positive dated price/value as noncash valuation rather
than sale cash. Value must equal exact quantity times price, cash legs must be
zero, and dates/quantity changes/identity/sole-trade coverage still match. A
surviving position independently agrees with that unit mark. For full disposal,
the explicit provider transfer valuation is recorded as
`nativeTransferValuation` and revalidated with the signed proof; it is a
Sharesight ledger valuation, not a new independently observed market quote.
This new evidence authority requires exact-version review and real API-field
acceptance before activation. Legacy zero-price SELL/history corrections keep
their existing quote requirements and previously confirmed dates.

## Ratio cycle preparation and legal delivery boundary

`node scripts/fee-ratio-cycle.mjs <private-cycle-plan.json>` is a concrete local
period entry. The plan is 0600 outside Git, schema
`fee-console.ratio-cycle-plan.v1`, fields `period` (the reviewed pure report plan)
and `packetPlan:{path,sha256}` (the existing private snapshot plan). It refuses
not-due/incomplete monthly periods and altered files. It calls the real original
Library proof -> source association -> public-recipient encryption path, and
writes a 0600 cycle handoff beside the candidate. It never changes original
capture time or disguises actual source asOf as the fee price/accounting cutoff.
It has no token, fee key, Keychain, browser or network access and cannot formally
publish. Existing trusted manager preview, explicit consent, owner/recipient/scope,
Gist revision, MAC, version chain, exact PATCH/readback and replay checks remain.

A periodic operator still needs fresh complete original Sharesight Tools Exposure,
classification/position/cash evidence and genuine Library materialization, then
an online unlocked Mac and its existing owner-verified manager browser session.
Only the existing same private Gist's `fee-console-ratio-snapshot.json` can be
updated through the existing confirmation flow; the recipient, fee data/health
and economic ledger stay untouched. Continuing this browser authentication and
private file transfer on a schedule is a new recurring purpose and must be
approved with its concrete frequency/recipient. The local entry does not install
a daemon, renew sessions, export credentials or turn the read-only monitor into
a publisher. No unattended Exposure collector or cloud manager-token delivery
has been demonstrated. Cloud fee production does not need the Mac; ratio
browser delivery does. Mac offline/session failure keeps the last real dated
snapshot stale and cannot claim a current update.

### Remaining live-adapter gates, not solved by field capture

The local independent IB TWR reader can now retain unchanged non-USD native cash
with complete dated cash-account balances and matching USD report valuations.
FX repricing stays in NAV return; native balances are preserved in the verified
checkpoint. Missing/changed native balances, nonzero foreign-currency ledger
events, changed currency or bad dated USD reconciliation fail closed. No FX
transaction is guessed or silently counted as a USD external flow. Actual source
field acceptance remains necessary before activation; the field check reports
native currency codes without amounts and is not calculation approval.

An authenticated confirmed-baseline/finite-coverage checkpoint is still required.
The local `finalize-ib-bootstrap` path below decouples this one-time seed from a
ratio report date, using the existing encrypted carrier rather than a JSON Secret
or new storage channel. Once a finite audited boundary has been rebuilt by two
stable source reads, the first normal report can extend it in memory through the
ordinary native checkpoint rules. The old audit is not extended or reissued; no
intermediate result is published as the final target. Native gaps still have the
existing eight-day limit and all transfer/cash/anchor proof gates. A failed IB
read remains nonblocking for an otherwise valid original fee report.

The next-cycle prior packet can be downloaded through the proposed manager-only
"下载当前加密快照（供下期衔接）" UI. It verifies owner, recipient, MAC and current
watermark and exports only the existing encrypted packet, never a token, private
key, fee key, raw holdings or ledger. It refuses pending/uncertain writes and
role/source changes. This is a separate index-only candidate; it neither changes
the formal Gist nor supplies recurring authentication approval. The downloaded
cipher is moved into the existing private workspace and chmod 0600 before use by
the packet stager. There is no direct hidden-config extraction path.

### Independent historical IB seed in the existing encrypted carrier

`./scripts/codex-fee-setup finalize-ib-bootstrap <private-plan.json>` is a proposed
one-time local adapter, not an enabled schedule or a new private input channel.
Its exact schema is `fee-console.ib-bootstrap-local-finalize-plan.v1`, fields
`targetDate`, `workspace`, `baseData`, `baseHealth`, `legacySource`, `ibBootstrap`
and `producerEvidence`. The two `ibBootstrap` members `baseline` and `coverage`
and every other input use the existing `{path,sha256}` private-file contract:
same owned repository-external 0700 directory, regular 0600 files, no symlinks,
no overwrite, bytes rechecked throughout. The baseline is rebuilt against the
already published IB return and drawdown receipts; a hash or coverage JSON does
not grant user/source approval. A finite audited interval must come from an
actually reviewed complete Sharesight reconciliation, not identical stale GETs.

Before either existing Keychain item is used, the adapter requires protected
clean signed main, exact base blobs, a successful real producer run/candidate,
source/style/runtime equality and original health within 36 hours and four UTC
days. It accepts the old `produce` job name or exactly `Produce weekly <target>`
or `Produce monthly <target>`; ambiguous or wrong-target names fail. Actual job
log access keeps the existing private-pipe parser and requires its own concrete
endpoint approval; no historical single-request authorization is reused.

After separately approved one-time use of the two fixed local services
`fee-console.codex.FEE_DATA_KEY` and `fee-console.codex.FEE_ECON_GIST_ID`, the
sole `daily.mjs --ib-bootstrap-only` writer dry-runs then constructs a new
encrypted candidate. Reporter/economic checks require the complete original fee,
IB returns/drawdown, ratio envelopes and every non-seed field to remain identical.
Only `ibManagerBaselineState` and `ibManagerCoverageState` are added. Existing
health is rebound to the exact checked cipher with the original checkedAt and
source dates; neither freshness nor style proof is manufactured. Fixed output
`ib-bootstrap-finalized/` contains 0600 data/health/validation; result remains
`publicationReady:false` until the original signed two-file protected promotion.
No manager token, recipient registration, financial call, ledger write, secret
creation or automatic flag is part of this adapter. No real execution occurred
during this local development.

## Ordinary daily HKT10:30 readiness

A validated ordinary v2 `daily` plan with no monthly cutoff becomes calendar-ready
at its original next-day HKT10:30 time. Its target, accounting date and source
query remain the previous HKT calendar date; no earlier date is substituted.
The extra New York midnight wait still applies to v1 weekly/monthly plans and
v2 `daily-monthly` plans that finalize a month. The reviewed one-off contract,
including its exact manual synchronization confirmation, is unchanged.

Calendar readiness alone does not confirm manual synchronization or source
completeness. Schedule activation still needs its own authorized scope and the
current target's confirmed manual synchronization. The normal source dates,
benchmark coverage, candidate and concurrency checks, original attempt budget,
rerun refusal and protected publication remain mandatory. No dispatch or enablement
is performed by this code change; it does not authorize future daily execution.
