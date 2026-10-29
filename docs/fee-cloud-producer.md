# 周／月报告候选说明

## Sharesight 账户来源口径（本地候选）

手工同步后的 Sharesight 持仓、各币种现金、交易及现金记录是账户事实；SPY/QQQ
仍仅作既有基准例外。普通买卖不再以逐笔交易／现金强配对或券商交叉复核作为发布前置。
已支持的现金记录若明确声明为买卖本金，按内部现金处理，不要求另一笔同日交易来证明。
裸 DEPOSIT/WITHDRAWAL 没有资金性质说明时仍标为待核，不全部当入出金或默认为零。

来源完整性、日期、身份、有限数字和外部资金性质检查保留。普通零成本 BUY 作为来源持仓事实，
不自动生成外部资本、认购或免管理费登记；既有明确豁免条目、费率及收益计算公式不变。
已批准转仓只沿用私密档案的精确事件映射、交接估值和去重规则；未知非现金资本事件仍需明确语义。
本地准备不恢复生产，也不修改已写认购。普通两次预算及五次失败历史保留；
上次恢复机会已消费。本次补丁不授权实际运行；任何新恢复机会必须另外批准准确签名版本、
2026-10-28 目标及受控凭据用途，手动占用后取消或失败也不能再用。

新周期合同见 [fee-report-periods.md](fee-report-periods.md)。内部仍复用以下逐日来源、
唯一 writer、现有凭据及保护推广；不新增 Secret 或权限。旧日报门禁在新版通过保护
合并前保持生效。本次代码准备不代表周期调度或真实 IB 来源已验收。

# Fee-console cloud producer

This is the Mac-independent producer for the simulated fund. It does not use
Claude, browser sessions, iPhone Mirroring, macOS Keychain, or a manager Gist
write token.

## Runtime boundary

The scheduled workflow runs from trusted `main` in the protected
`fee-cloud-producer` GitHub Environment. Repository variable `FEE_CLOUD_MODE`
is the release switch:

- unset or `disabled`: the job is skipped before secrets are exposed;
- `shadow`: complete double-read, calculation and validation, then delete all
  runtime files without creating a branch;
- `publish`: do the same work, create a fresh branch at the rechecked `main`,
  then append one GitHub-signed owner candidate commit.

The existing no-secret candidate validator and `trusted-promotion` workflow
remain the only path to `main`. Start with at least two completed-session shadow
runs that match the local producer before changing the variable to `publish`.
Keep the local heartbeat active until one real cloud candidate has been
validated, promoted and read back from Pages; then pause it to avoid two
producers.

## Cloud identity and environment secrets

The workflow does not keep a Google service-account key or a Sharesight client
credential in GitHub. GitHub OIDC is exchanged for the dedicated
`fee-cloud-producer@family-portfolio-gateway.iam.gserviceaccount.com` identity.
The Workload Identity provider accepts only this repository ID, owner ID,
trusted workflow path, `main` ref and the `schedule` / `workflow_dispatch`
events. That identity has Secret Manager accessor on exactly two version-pinned
resources:

- `sharesight-broker-sync-client-id:1`
- `sharesight-broker-sync-client-secret:1`

The pair is the second cloud Sharesight application already isolated from the
Mac Direct API credential. The workflow reads it only after OIDC authentication
and passes it to the fixed GET-only adapter for the duration of one job.

The protected GitHub Environment contains these three credential/configuration values;
the optional one-time private data input described below is separate:

| Secret | Purpose |
| --- | --- |
| `FEE_DATA_KEY` | Existing 32-byte fee-console encryption key |
| `FEE_ECON_GIST_ID` | Exact secret economic-ledger Gist locator |
| `FEE_CLOUD_GITHUB_TOKEN` | Owner fine-grained token restricted to this repository and Contents write; used only in publish mode |

Do not store a manager Gist token, browser link, access token, refresh token,
Mac credential export, or general-purpose `gh` token. The Sharesight client uses
`client_credentials` to obtain a short-lived token in memory. Its HTTP adapter
allows only one authentication POST and fixed GET routes for Schwab-HK and
Webull. It has no mutation route.

## Daily behavior

The benchmark cache remains independent, with existing 07:35 and 09:35 HKT
attempts before the first producer slot. From 2026-10-10, the producer starts at 10:00 HKT,
with independent 11:40, 11:55, 12:20, 12:50, 13:50, 15:50 and 17:50 HKT slots
Tuesday through Saturday. GitHub may delay a scheduled start; 10:00 is the
first attempt, not a guaranteed time for completed public publication.
Its default target is computed independently of the
cache: the latest New York weekday whose 16:15 close boundary has passed.
SPY and QQQ must both have exactly one complete row for that target, including
validated dividend fields. Old or future cache rows cannot change that target.
Holiday and half-day support is not added here: absence of the expected row
stops the run as benchmark pending; it does not invent a closed-session point.
Explicit reviewed recovery dates still use the existing writer's backfill
gates. Publication preflight passes its selected target to calculation, so a
clock boundary between steps cannot silently change the date.

An unreadable publication state is retried within the bounded preflight, then
stops before financial credentials or sources are used. It never means that
there is no candidate. Known pending candidates retain the existing wait and
main-receipt requirements.

The workflow does not publish on Sunday or Monday HKT. When the next completed
New York session follows a weekend, the same private candidate first adds the
missing Saturday and Sunday calendar-day carry points from the last published
Friday point, then writes the new session. The carry path accepts only consecutive
weekend dates, identical account/split/benchmark values, the prior source
provenance, an explicit closed benchmark state, and no cash movements. A missing
weekday remains blocked. This keeps calendar-day fee accrual complete without
creating a separate weekend publication or requiring the Mac to be online.

For the selected session, the reader resolves and pins both live portfolio
identities, then reads performance, holdings, cash accounts, target-day cash
transactions and trades twice. The normalized reads must be byte-equivalent.
All list envelopes must be complete and have unique record identities. An
explicit next page, restricted/limited report, duplicate ID, missing cash
collection or mismatched account/date stops calculation; management history
retains its existing separate completeness gate. Pagination is not silently
followed or truncated.

### Sharesight reference authority

The cloud and period producers explicitly select `sourceMode=sharesight-reference`;
provider JSON cannot select this mode. The fixed same-day Sharesight performance
report supplies NAV, current holdings and all currencies' USD cash valuations.
The dated cash list supplies native-currency identities and transactions. A/B
reads still compare the complete normalized input. Missing, restricted, paginated,
duplicate, misdated or invalid current data remains an error.

Ordinary catalog-only positions are auxiliary; they do not trigger a historical
holding replay or an additional sold-position report. Ordinary cash movements
need no running balance, full-ledger predecessor, timestamp ordering or
`opening + movements = closing` reconstruction. The reader no longer obtains the
full `to=target` cash history or a previous-day cash list for that purpose.
Previous/peer positions remain required for the already approved in-kind events;
existing management-exemption lots still require their original full history.

A difference between the dated auxiliary cash list and the same-day report is
`AUXILIARY_CASH_BALANCE_DIFF`; it does not replace report NAV/cash. Catalog-scope
differences and the old 50% NAV-jump heuristic are similarly fixed warnings.
The sole writer receives a closed `fee-console.sharesight-reference.v1` input:
date, USD cash by account, native-currency set and fixed warnings. It explicitly
records `cashHistoryReconstructed:false`, validates the current cash/split binding
and movement identities, and selects the same reference branch. No synthetic
opening balance or historical-reconciliation success is manufactured. This input
is a business contract, not a source authentication certificate or new permission.

Every actual cash movement remains available for classification. Recognized
internal trade/income/fee records are not investor capital. Unknown funding stays
unresolved and prevents a valid fee candidate; it is never zeroed or guessed.
Internal non-USD movements retain their native currency; an external or unknown
non-USD movement without a proven USD amount stops. A reported zero cash amount
is retained as zero internal movement. The seven approved transfer events,
their exact private selector/valuation/zero-cash proof and business-key dedup
remain unchanged, as do subscriptions, fee/TWR/Carry/HWM formulas and privacy.

### Legacy reconstruction contract

The following historical rules remain available for the legacy reader/writer
contract. The reference producer above does not claim or require these proofs.

The undated holdings list is an identity catalog and can retain sold positions.
The dated open-position report must match each catalog holding's instrument ID,
ticker, market and currency; its start/end date, New York timezone and
`include_sales=false` scope are checked. A catalog-only row is accepted only
when a complete additional performance report from the earliest catalog
inception through the target date, with `include_sales=true`, covers the entire
catalog and reports exactly zero ending quantity and value for that row, with
zero unconfirmed transactions. Sharesight defines these figures as report-end
values ([official report contract](https://help.sharesight.com/us/performance_report/)).
The terminal report must match account, dates, timezone, currency, grouping,
instrument identities, current active quantities/values, total value and cash
scope. Original JSON number text supplies exact zero and equality checks;
underflow to Number zero does not qualify.

Complete confirmed history must still begin at each extra holding's catalog
inception and include a sale on its latest transaction date. Dates are grouped,
without inferring intraday order from IDs. BUY, SELL, one initial OPENING_BALANCE and a SPLIT
with an explicit company-event identity are supported. Unknown types, missing
history, pagination, identity conflicts and conflicting target-day views stop
the run. Exact original trade quantities and event IDs are retained in private
audit proof. BUY/SELL contribution differences are recorded, without assigning
them a rounding explanation or reconstructing a split ratio. Historical
arithmetic is not the authoritative ending-position test. This changes the
closed-position evidence contract; it does not verify broker synchronization.
Historical instrument codes are preserved as bounded exact strings, including
custom codes with spaces; active report tickers keep their strict format.

Webull reuses its existing management-history read; Schwab obtains the same
fixed as-of history GET when catalog-only rows need proof. Both accounts obtain
the additional inception-to-target terminal report only when needed. The new
date range, sold-position report and closed-position authority require specific
owner review before release. Canonical proof is bound into the private stable
A/B fingerprint. There is no new Sharesight read at the later signing boundary,
and original management-exemption, income and receipt gates remain independent.

For both portfolios, each A/B read also obtains the fixed previous calendar
day's performance using the same GET-only endpoint and identity checks. This
is an additional date scope requiring specific review before release. It is
read even when no target-day movements are returned. The report's USD cash is
retained as dated evidence, but is not the opening authority for a target batch:
report cash can already include a debit whose transaction filter assigns it to
the following day. Cash lists use the
fixed target date. If a portfolio has foreign cash, the same existing portfolio
list endpoint is also requested for the fixed previous date. The
[official V2 cash-list contract](https://portfolio.sharesight.com/api/2/doc/index.html#api-User_API_Cash_Accounts-CashAccountsList)
defines the date parameter and original- and portfolio-currency balances. Each
row must carry the requested date, portfolio and currency identities, and
two-decimal balances; both dated lists must cover the same complete account set.
Each day's USD report valuation must agree with its independently listed
portfolio-currency balance. Foreign original balances must be exactly unchanged
between those dates, and any target-day foreign cash transaction still stops.
Missing previous evidence or an ignored date parameter stops. Both dates' original
balances and USD valuations are bound into the private A/B fingerprint. Foreign
FX valuation changes remain in total assets and the cash split, and create no
cash flow or external funding.

Each A/B read also obtains the same cash-transactions endpoint with only `to`
set to the target date for every verified USD cash account, including accounts
with no target movement. This extends the existing GET-only date scope and
requires specific owner review. The complete history's target subset must match
the original `from=to=target` collection by IDs, raw timestamp, exact cents,
cash account, trade/holding/payout links, description, type and foreign ID. The
target must be a complete consecutive timestamp suffix; interleaved dates,
mixed boundary timestamps or later records stop. Explicit pagination,
restriction, limitation, truncation and the existing 2 MiB/timeout limits stop;
the documented endpoint provides no pagination parameters. A server silently
violating its complete-list contract cannot be proven complete by a balance
equation, especially when omitted movements net to zero.

The latest complete group strictly before that suffix supplies the independent
opening from actual predecessor transaction balances. A single row supplies its
balance directly. A same-time group must have one independent terminal after
consuming every balance edge; IDs and response ordering are not chronology.
Multiple-balance zero-net cycles, disconnected paths and missing predecessors
stop. A one-balance zero-amount group is unambiguous. Neither current cash minus
target movements nor the first target balance minus its amount establishes the
opening. With no target rows the history's target subset must also be empty,
and its independent terminal must still equal target cash. No fallback zero,
new snapshot store or financial write is introduced.

USD report cash, listed USD balance, terminal dated movement and per-USD-account
movement sum must agree. The aggregate movement check and writer's
`acctCash` / `prevAcctCash` use only USD cash accounts. The latter is the sum of
independent balances before the complete target batch, with each predecessor's
real date retained; it is not labelled as yesterday's report balance. NAV,
economic flow dates, original writer and fee formulas retain their contracts.
Linked trade cash is read once into target flows for validation, never written
back to Sharesight or recorded as a second debit or external subscription.
Trade/holding IDs retain priority in the existing classification. A UI date
offset does not change the economic date or permit amount/currency mismatches.
Portfolio totals and
`splits.cash` retain every currency's USD valuation. Transactions are grouped by timestamp;
each group must form a balance chain from its independently established opening
balance and consume every record. IDs and response order cannot determine
execution order. Contradictory or ambiguous same-time balance paths stop;
zero movements and identical balance edges are interchangeable for cash proof.
Missing prior evidence, a changed cash-account set or unexplained original-
currency balance or valuation differences stop automatic publication for review.
Canonical full-history commitments, predecessor groups, target records, old
USD report evidence and portfolio cash settings enter the existing private A/B
fingerprint; array order does not churn it. Those records and amounts are never
included in public health or workflow logs. This implementation does not add a
dated-list fallback for ambiguous predecessors; those cases remain blocked.

### Shared calculation and publication checks

Cash accounts form `cash`, SGOV forms `other`, and remaining USD holdings form
`stock`; the three buckets must reconcile to the two portfolio totals. Style
classification continues through the existing static and encrypted learned
registry. The same verified equity holdings are aggregated by ticker across both
portfolios; the three largest positive positions are stored in the encrypted
daily point for the compact mobile summary. Their displayed weights use the
same day's managed-composite total. Cash and SGOV remain in “现金及其它” and are
not repeated in the top-three list. Cash transactions linked to a trade remain
internal. The fixed Webull writer's exact account-bound principal-cash identity
and its explicit `NOT external funding` description are also retained as
`internal_trade`. The reference branch also accepts the existing explicit,
account-bound Sharesight trade-principal declaration without reconstructing a
same-day trade/cash pair. It does not accept similar arbitrary free text as
funding evidence. A remaining bare deposit or
withdrawal becomes unresolved unless the existing private ledger already
contains its reviewed classification.

HTTP deadlines cover headers, streamed body, byte limits and JSON decoding.
The workflow has a 15-minute outer budget. Signing HTTP is also bounded and
never automatically repeats a mutation after an uncertain response. This
phase does not yet carry the source session into the separate signing step;
that remaining boundary still needs the audited follow-up design.

The producer retries one transient source-network or stable-read mismatch in
the same run. Identity, schema, permission, amount, reconciliation and receipt
failures are never retried. If a candidate contains an unresolved cash flow,
the run reports the amount-free `FEE_CLOUD_UNRESOLVED_FLOW` code before the
generic receipt validator. The job summary never includes portfolio amounts.

`fee-cloud-supervisor.yml` is a secret-free, read-only observer of completed
producer runs. One failure is left for the normal independent schedule slots.
Two consecutive scheduled or manual failures create or refresh a single
amount-free GitHub repair issue for Codex diagnosis. Failure counting resets
only at a matching successful run/job whose source/calculation and signed
candidate steps actually executed successfully. Historical successes are
checked too; a new failure does not accumulate failures from before such an
execution. Skipped/already-published, shadow or unreadable job evidence cannot
reset that execution counter. The existing Actions jobs read permission is
sufficient; no secret or permission is added.
An outer job `timed_out` conclusion counts as a failure; cancellation retains
its existing non-failure semantics.

Automatic issue closure is disabled in this first phase. Even a genuine
producer execution does not prove its own candidate reached main and Pages.
A health timestamp in the same run window could belong to an unrelated local
publication. Existing issues therefore remain open with recovery unverified;
restoring automatic closure requires a separately reviewed run-bound candidate
receipt and actual main/Pages proof. No green skip or unrelated publication
can clear a repair issue.
The issue is only a repair candidate: it cannot read source or
ledger secrets, publish data, edit the economic Gist, or change investor
shares. Any repair still requires a tested pull request and the existing
protected release path.

The normal writer, fee receipt validator in amount-free `validate` mode, amount-free health receipt, private
source recheck, signed candidate validation, protected promotion and Pages
deployment are unchanged. Workflow summaries contain only dates, outcome and
hashes; no amounts or credentials.

## One-time activation

1. Create the protected environment with the three GitHub secrets above. Create
   the repository- and workflow-bound Google Workload Identity provider and
   grant its dedicated service account accessor only on the two version-pinned
   Sharesight Secret Manager resources. Do not copy their values into GitHub.
2. Set `FEE_CLOUD_MODE=shadow` and dispatch the workflow twice on completed US
   sessions. Compare canonical business inputs, dates, fees and investor share
   results with the local producer. Independent changed-data encryption uses
   fresh nonces, so its ciphertext hashes need not match. Exact byte/hash
   equality applies to a frozen candidate and its main/Pages read-back, or
   repeated semantic no-op.
3. Set `FEE_CLOUD_MODE=publish`, dispatch once, and wait for candidate validation,
   protected promotion, Pages deployment and public/mobile read-back.
4. Pause the local Codex heartbeat only after the cloud result is proven.

Removing the variable or setting it to `disabled` is the immediate rollback.
It does not revoke credentials or alter the published ledger.


## One-time private style-proposal transport (requires specific release approval)

A missing learned classification may be supplied as one reviewed proposal via
`--style-proposal-file`, in an owner-only 0700 directory and 0600 file outside
the checkout. The file is bounded to 64 KiB, must be a regular non-symlink owned
by the runtime user, and must have exactly `schema`, `targetDate`, `proposal`.
Schema is `fee-console.style-proposal.v1`; targetDate must match the independently
selected producer target. The proposal has the unchanged registry entry format.
This file grants no user or OWNER approval. Same-holding first-transaction and
whole-period independent business review remain required external evidence.

The loader merges one proposal into the complete stable two-account source
input after the original A/B reads. It never replaces holdings, totals, dates,
flows, benchmark or economic inputs. The original resolver/preflight rejects
wrong identities, dates, incomplete sums, missing review, static conflicts or
mutation of an existing learned entry. Proposal bytes/identity are rechecked
before preflight, writer and candidate validation. Missing/wrong lock, changed
proposal hash or scope cannot fall back to an unlocked proposal. An exact repeated registry
entry stays a no-op; an existing source proposal cannot be overwritten.

For the reviewed one-time workflow route, two temporary Environment data input
secrets supply the envelope and its independently frozen lock:
`FEE_STYLE_PROPOSAL_JSON` and `FEE_STYLE_PROPOSAL_LOCK`. The lock has exactly
`schema`, `targetDate`, `proposalSha256`, `portfolioId`, `holdingId`, `ticker`,
`style`, `firstHeldOn`, `effectiveFrom`; schema is
`fee-console.style-proposal-lock.v1`. It binds the SHA-256 of the exact proposal
file bytes and the separately approved holding identity. The code additionally
permits only target 2026-10-12, Schwab, AMZN/growth and equal dates 2025-11-04;
all other target/account/style/date scopes fail closed. These values are integrity
and scope inputs, not human authorization. They contain the one approved record
and necessary audit fields, no amounts, ledger locator or financial token.
These are new private data inputs, not new credentials: no OAuth client, key, token, OIDC identity, IAM,
repository permission or ledger write permission is added. Installing these
inputs requires explicit approval separate from the classification fields.
Only an explicitly selected workflow_dispatch boolean `apply_style_proposal`
(default false) exposes it to the producer step. No IDs or proposal text are
workflow_dispatch inputs, repository plaintext, command arguments or output.
The step writes it privately, unsets the transport environment variable, and
passes only its path. The producer removes both transport variables from child
environments; only the needed private style-input file reaches the original
writer. Existing always-cleanup shreds the proposal file with other runtime files.
Remove both temporary secrets after the one-time attempt and retained private audit,
including failure. Removal is by the already authorized secret operator, not the
producer: no Secrets-management permission is added to its Contents-only token.
A later attempt needs a fresh explicit execution authorization. Ordinary schedule
and default dispatch behavior remain unchanged.

Successful persistence uses only the original daily writer: registry plus the
target day's splits are encrypted into data.json atomically. The existing
published encrypted data therefore remains final storage, but is not a bootstrap
input for a proposal absent from its registry. The existing economic Gist is not
repurposed or modified. Financial writer/publication authorization, signed owner
candidate, Validate, Promote, Pages and read-back remain separate gates. Existing
weekend carry behavior is unchanged.
