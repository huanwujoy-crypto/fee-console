# Proportion-management migration — offline review candidate

No real source read, credential read, recipient registration, remote code write,
configuration change, production or retirement is performed by these tests.
The last published October 23 fee/IB report stays untouched.

## Source, portfolio and fee scope

All new account facts come from Sharesight. SPY/QQQ are the sole external market
source exception. Fee accounts remain Schwab/Webull. Jenny’s IB return/drawdown
remain an independent manager assessment. All Together ten-account Exposure is
a separate ratio denominator; none of those additional assets becomes fee AUM.

The original action handoff diff SHA256 is
`3809cd8cc67dbc8c0d9b113058f8c8956db16e5076e89b40d94d4ed2b464ea7f`.
Only its pure Exposure renderer is reused. No broker/Flex/mail/order reader or
independent cloud publisher is imported. The unified manager tab retains current
plan, cash-priority reference, stock four-category allocation, four Exposure
top-five groups and complete-holdings sections. Missing inputs remain unknown.

Exposure’s twenty ranked rows are not full holdings/cash/commitment data.
Secondary rows are individual securities already supplied by Exposure, not ETF
products or a second leverage multiplier. Original dual weights, class cash,
Top500/residual/partial-leverage limitations and actual source/download dates stay
visible. Stock policy remains 45/20/23/12; USSC 10% remains a budget share, not a
portfolio target. CALL 50% reserve policy is retained, but no accepted Sharesight
CALL/commitment contract exists: reserve/net/executable budgets stay unknown.
Visible order reminders are removed; unknown internal execution risk remains.

The complete-holdings heading explicitly says IB-HK, not full All Together.
NOAH-HK cash is one named portfolio, not every NOAH account. All Together remains
the ten-account Exposure denominator. Browser evidence now has its own `fee-console.ratio-sharesight-browser-book.v1`
contract. It never creates API portfolio/holding IDs. It preserves original
export/download/classification times separately, code/venue, source category,
USD value, nullable original quantity/name, value basis, converted book cash and
source totals. Unknown names display source code with a note, never a fabricated
API instrument name. Same-export underlying-plus-residual values remain labelled;
class/Exposure residual limitations and unfinished source migration are retained.

The official gate is now wired through `fee-ratio-browser-evidence.mjs`.
It accepts the complete original `sharesight-private-full-v1` JSON only when its
bytes match the independently pinned source SHA, its owned 0600 Library file
identity/version match the private plan, and complete original associations pass.
The comparison covers scope, original times, positions/nullable quantities,
portfolio-USD cash, all export rows/aggregates, top-five identities/values,
source denominators, residual composition and documented rounding/UI differences.
Negative original Residual rows remain signed; they are not clamped or leveraged.
The `readOnlySupplement` is excluded from all valuation/quantity/cash derivation.

A successful in-process proof is tied to exact input bytes, original SHA,
Library version, current local UID and manager scope. A serialized audit report,
summary, caller verified=true, changed identity/version/source/input or expired
capture cannot substitute for it. The finalizer checks source evidence before
financial keys, then checks its manager scope against the actual registered
recipient before the writer; the writer independently rereads and verifies it.
Only this path changes the manager-only model tag to
`verified-original-library-association`. The preflight proof is not an OWNER,
permission grant, health refresh, transaction history or IB flow certificate.

`fee-console.ratio-browser-evidence-plan.v1` exact fields are `workspace`,
`source:{path,sha256}`, `input:{path,sha256}`, `library:{libraryFileId,version}`,
`managerScopeId` and `localOwnerUid`, plus `schema`. All files are pinned private
regular non-hardlinked files in the owned 0700 workspace, including nested source
directories. Source Library xattrs must match the resolved identity/version.
The plan is a reviewed input, not a self-issued authorization; the trusted
materialization and explicit approved SHA remain the trust boundary. No new
online identity service or Secret is introduced. Cross-user UID, Library identity
and fund-scope mismatches refuse; an actual recipient is never inferred from data.
The local real-data unencrypted acceptance uses an explicitly labelled
credential-free audit scope, not a real manager recipient or new key.

The existing 36-hour capture limit remains tied to the original download, not
audit time. Source expiry requires genuinely new accepted source evidence;
rehashing, copying or rewriting an audit time does not renew it. An unverified
browser input remains a private preview only. All source/data stays outside Git.

The source wrapper `fee-console.ratio-sources.v1` has `exposure` and optional
`book`. Book uses `fee-console.ratio-sharesight-book.v1`: source/date/capture hash,
IB-HK and NOAH-HK portfolio identity plus complete raw performance reports.
Original Sharesight cash/classification parsers are reused. Portfolio, USD,
cutoff, grouping, duplicate holdings, page/truncation markers and capture age are
checked. Missing book is explicitly unknown. It is never inferred from top five.
Pinned hashes prove file integrity; they do not authenticate a service or grant
permission. Real capture origin, complete pagination, currency conversions,
account scope and historical-date support still require bounded acceptance.

## Manager isolation using existing credentials

The fee master key is shared with investors and cannot protect manager holdings.
The existing manager capability is reused, with actual GitHub user/Gist-owner ID
and a private source verified. Token presence is insufficient. Capability is
checked on opening and refreshed on demand after ten minutes, not polled.
Role/source changes, hidden/pagehide and a ten-minute visible session clear
plaintext. Late decrypts cannot repopulate a locked or changed view. Offline
revocation cannot instantly erase already displayed plaintext; this bound is
explicit, and fresh verification failure prevents subsequent decryption.

`createFeeRatioCore` derives a nonextractable X25519 private recipient from the
existing fee key, original manager token and Gist scope under a separate domain.
No additional persistent private key or new Secret is required. A producer needs
only the public recipient; giving it the token-dependent existing symmetric key
would give cloud processes the manager secret or require interactive encryption
each period. HKDF-SHA256/AES-256-GCM binds ephemeral key, recipient, scope,
revision, prior-cipher commitment, fee receipt and source date.

This is a NEW encryption purpose/public-key configuration requiring exact review.
No real derivation/registration has happened. The proposed optional file
`fee-console-ratio-recipient.json` lives in the SAME existing private Gist.
The page first requires a trusted user action to generate a read-only preview,
showing purpose, persistent-file target, full recipient fingerprint and scope.
No write or download occurs during preview. A separate initially unchecked
purpose/configuration consent and a second trusted confirmation are mandatory.
The five-minute preview binds identity, source epoch, Gist revision and the
visible fingerprint/scope. Cancellation, changed role/source/revision/display,
expired preview or withdrawn consent refuses before write. Only creation or
exact idempotent reuse is allowed, with owner/private-source checks and read-back. Different existing registration refuses rotation. Public
metadata contains algorithm, scope hash, public key and recipient hash only.
The economic ledger is untouched. Same existing credentials work across devices;
changed tokens derive a different recipient and require explicit recovery review.
Browser X25519 compatibility and actual manager/investor acceptance remain pending.

## Implemented private writer and health binding

1. `node scripts/fee-ratio-packet.mjs /absolute/private/plan.json` stages a
   manager-only PREVIEW from pinned Sharesight files plus a public recipient.
   Schema `fee-console.ratio-stage-plan.v1` includes workspace/kind/targetDate/
   feeAccountingThrough/scopeId/input/recipient; each file spec is `{path,sha256}`.
   Inputs are owned 0600 files in a repository-external 0700 directory. No network,
   credentials or fee write occurs. Outputs are only 0600 cipher and validation.
2. Proposed official route:
   `./scripts/codex-fee-setup finalize-ratio /absolute/private/plan.json`.
   Schema `fee-console.ratio-local-finalize-plan.v1` exact fields are workspace,
   targetDate, baseData, baseHealth, ratioInput, ratioSourceDate, ratioKind,
   legacySource, ibBootstrap and producerEvidence. `legacySource` and ibBootstrap
   can be null. Browser evidence uses v2 with the additional pinned
   `browserEvidence:{path,sha256}` pointing to the evidence plan above. The writer
   receives only `--ratio-evidence-plan=<private path>` and independently verifies
   original bytes/identity/associations against the actual recipient scope.
   Evidence contains actual runId/candidateSha; it is not approval.
3. Before financial keys, this route checks clean signed current main, exact
   producer code/tree, real successful source/style/signing steps, candidate blobs,
   job log proof, canonical fresh health and original four-day/36-hour limits.
   It then uses ONLY existing Keychain services `fee-console.codex.FEE_DATA_KEY`
   and `fee-console.codex.FEE_ECON_GIST_ID`, fixed original account, in memory.
   Existing economic-source stable reads also pick up optional public recipient
   metadata; absent/bad optional metadata does not break ordinary fee production.
4. The sole writer `daily.mjs --ratio-only` reconstructs the model and encrypts
   it internally. Official admission does not accept an opaque external cipher.
   The reporter validates the genuine economic receipt; finalizer independently
   checks all non-attachment fields, fees and original IB returns are unchanged.
   Health is bound to the new outer cipher with ORIGINAL checkedAt/source dates.
   Raw style/log text is never output or stored. A new run’s single derived log
   endpoint requires its own bounded execution approval; old approvals are spent.
5. `ratio-finalized/` contains owned 0600 data/health/validation, ready for signed
   candidate review, `publicationReady:false`. Existing signed two-file validate/
   protected promotion and manager/investor unlock tests remain necessary.
   The finalizer never signs, pushes, merges, promotes, dispatches or enables jobs.

Optional `ibBootstrap:{baseline,coverage}` uses the SAME private file handoff and
outer encrypted payload. It checks original confirmed return/drawdown receipts
exactly, refuses replacing an existing native checkpoint, and adds only owner
baseline plus finite Sharesight audit metadata. No new private Secret/channel.
Owner-confirmed historical correction remains an explicit exception, never
relabeled as Sharesight-native. Source-v3 then checks exact opening positions/
cash and daily proofs, and incrementally continues beyond the one-time audit;
unknown transfers/absence/price evidence stop IB only. No recurring blanket
`flowsComplete=true` or old-date reuse substitutes for new daily evidence.

The official page binds cipher hash/version/fee receipt/source date and compares
an accepted-generation watermark scoped to recipient in existing local storage.
Only nonfinancial dates/revision/cipher hash are stored. Replay/role/source-change
failures clear old plaintext. Preview is visibly unpublished and cannot advance
the official watermark. Investor archives/share URLs never receive the model.

## Real-source acceptance and cadence still pending

Capture binding (2026-11-10): before any claim, the pinned original's frozen
earliest capture instant must not precede the handed-over fee health's
`checkedAt` (a lower bound of that fee production, from the hash-verified,
main- and Pages-read-back fee publication). Each official source keeps its own
real date. The handoff stays an identity: an older fee that is still live may
be handed over explicitly, so this does not prove the handed fee is the current
round's; the coordinator must confirm the handoff is the round's approved fee
target (its own new publication) before dispatching the ratio. The capture instant is the collector's declared
original download-file mtime (`downloadCompletedAt` is null), so this is a
misuse guard, not proof of a new official export: a re-audited copy of an old
workbook can carry a new mtime and the cloud cannot tell, while a genuine
re-export without changes may be byte-identical to the previous one. Freshness
therefore relies on the trusted actual export process; an mtime alone never
proves a new download. Existing verified interfaces do not cover automatic
Exposure export, and nothing in this repository fetches official workbooks.

Signed date policy (2026-11-10): every new snapshot's signed source carries
`datePolicy: hkt-calendar-v1`, so source age (future, at most four days) is
counted in Hong Kong calendar days at signing (`verifyOriginal`, `candidate`,
`authenticate`) and at its own `confirmedAt` when read (`verify`). The policy is
inside the MAC-covered body: it cannot be stripped, swapped or downgraded, an
unknown value is refused, and new signing without it is refused. A signed
source without the field is an earlier snapshot and keeps its original
UTC-day semantics. Reading a snapshot after its 36-hour capture window still
only marks it stale. A pre-policy page refuses new snapshots, so the reviewed
page update must be deployed before the first new ratio publication.

The file-to-writer-to-health-to-manager-display path is covered with synthetic
inputs. This does not prove an active Sharesight Tools/export session or that
existing OAuth scope covers all ten portfolios. No Tools Exposure API endpoint is
invented. First read-only acceptance must verify the existing Sharesight tool’s
All Together ten-account Tools Exposure scope plus complete IB-HK/NOAH-HK reports,
original dates/classifications/cash/holdings/transactions and transfer evidence.
The known twenty-row export alone cannot meet the complete book requirement.
If historical Tools cutoff or full pagination is unavailable, that module stays
pending with its actual source date; fees remain publishable. No broker fallback.

Suggested next normal target is the reviewed weekly October 30 cutoff, first
scheduled attempt November 1 00:00 HKT, without changing the calendar. There is
no current dispatch approval for this new candidate. Month-end first attempt
remains Hong Kong 00:00; the existing New York-date wait is additional conservatism
and is NOT proven necessary by an actual API field. Any change to it must be a
separate explicitly chosen calendar change, not silent movement to 13:00.
No daily financial polling is added. Until source/device/recurring transport and
exact protected candidate are accepted, automatic ratio/IB switches stay off.

SPY/QQQ local changes strictly recheck cache symbol/currency/exchange. The
Yahoo-independent extension uses the already existing Nasdaq provider only,
with at most three extra requests per ETF per run (six total), no paid API/key.
It requires a previously verified opening cache, exactly the next completed
session, quote/history agreement and cash-dividend evidence. SPY calendar expiry,
missing dividends, after-hours quotes, gaps or wrong identity fail without cache
rewrite. No index substitution or price-only total return. These are offline
fixtures; real endpoint availability/latest workflow state is not yet verified.

## One combined authorization plan, after final signed heads exist

Review support and index-only UI separately through existing exact-head OWNER and
required checks, serialized to preserve main-base identity. Current work is local
and UNSIGNED; do not request OWNER against a temporary test-fixture commit.
The subsequent single execution package should name (a) the one public-recipient
registration in the existing private Gist, (b) a bounded Sharesight-only source/
scope/date acceptance through existing access, stopping if insufficient, (c) one
normal fresh producer plus its unique successful log proof, (d) one local pair of
existing Keychain uses for private additions, and (e) existing protected cipher
publication and real manager/investor validation. No new credentials/permissions.
The usual source/client call count must be frozen from actual supported capture
routes before execution; the twenty-row export supplies no such permission.

Only after unified acceptance: retire old independent action entry, producer,
clock/watch and action-specific monitoring duty. Preserve historical objects,
keys/IAM, shared Pages and fee/benchmark monitors. Exact old IDs are in the action
handoff and need fresh read-back before changes. No old jobs are resumed here.

## Independent manager snapshot — local candidate, not enabled

The independent source date no longer needs an unrelated fee cutoff or fee
receipt. Existing fee-attached publication and its producer/style/health checks
are unchanged; this route neither edits nor imitates them. The only proposed
remote destination is `fee-console-ratio-snapshot.json` in the same private Gist.
No workflow, automatic schedule, financial source or permission is added.

`node scripts/fee-ratio-snapshot-packet.mjs /absolute/private/plan.json` accepts
`fee-console.ratio-snapshot-plan.v1` with exact fields `workspace`, `evidence`,
`recipient`, `previous` (null on first publication) and `schema`. File pins are
`{path,sha256}`; `evidence` points to the existing complete-original Library
plan. It checks owned 0700/0600 regular non-linked files, exact original Library
identity/version, input bytes, scope and full associations. It rebuilds the model
and encrypts with the registered PUBLIC recipient only. `ratio-independent-candidate/`
contains candidate packet, inner preview envelope and validation; always
`publicationReady:false`, `authentication:null`. No financial credential or
network is used. Previous packets are pinned hints, never publication authority.

The shared `createRatioSourceCore` runs the SAME full association logic in Node
and browser. Browser review needs the full original and exact converted input
via local file selectors. Files are read in browser memory, never uploaded.
The model, original hashes, full row relationships, same scope/currency/date and
unmodified capture time must agree; a summary, serialized proof or caller flag
cannot substitute. Library native xattrs are checked by the local builder.
A browser cannot independently authenticate Library service identity/xattrs;
its subsequent attestation states manager-confirmed full-original association,
not a new Sharesight API read or independently authenticated Library download.
The approved original hash/materialization remains an explicit trust boundary.

Public-key encryption authenticates ciphertext integrity but does not prove who
produced it. Therefore a new, separately approved manager authentication purpose
is required for formal delivery: after trusted review and a separate unchecked
consent, the existing manager credentials derive a domain-separated,
nonextractable HMAC-SHA256 key in memory. The original X25519 recipient and
fingerprint are unchanged. No fee Keychain read, key export, new Secret or new
persistent credential occurs. A token alone or investor fee key alone cannot
forge this attestation. Combined manager-token/fee-key compromise still can.
This new use has NOT been exercised with real credentials by local tests.

The attestation binds full source/input/model/cipher hashes, original capture
and expiry, scope/recipient, integer version, prior snapshot/cipher commitment,
confirmation time and a digest of the actual in-page validator/codec factories.
The profile digest records code identity; it is not a remote CI proof or OWNER
approval. Formal code still needs signed exact-head review and protected merge.
No old producer run, fee style evidence or checkedAt is rewritten or reused as
independent source health. The new record is manager-confirmed snapshot health,
not a fee producer receipt or certification of transactions/future IB flows.

Admission and confirmation preserve the 36-hour ORIGINAL capture and four-UTC-day
source-date windows. A new audit/confirmation/model generation cannot renew them.
Authenticated historical snapshots may still be viewed after expiry with their
actual date and explicit “待更新”, never labelled current. The page verifies the
MAC, model and recipient each time and records only recipient-scoped version,
hash and dates in its existing local watermark. A new device without a prior
watermark cannot prove global anti-rollback; it relies on current authenticated
Gist content, visible source dates and expiry. Owner/source/role changes,
hidden/pagehide, late async completions and ten-minute view expiry clear content.
A corrupt independent file fails closed, without falling back to old fee data.

A five-minute confirmation preview binds owner, source epoch, Gist revision,
actual file/body hashes and the visible summary. The protected browser PATCH
allows exactly the snapshot filename. It does not send original files, plaintext,
keys, tokens in body, data.json, fee health, recipient config or ledger writes.
Before writing it rereads the Gist and verifies the authenticated previous version;
a changed revision or chain refuses. It reads back exact bytes and verifies the
MAC. A network error after dispatch keeps an explicit pending state and allows
only read-only outcome checks, never an automatic retry. Gist partial PATCH has
no server-side compare-and-swap transaction: the prewrite revision check narrows,
but cannot eliminate, concurrent owner-write races. Run one publisher at a time.

New official snapshots show “资产配置总览” as six mutually exclusive rows,
using the classification workbook's actual date and all ten accounts' direct
asset values. The reference targets are PE/VC 0%, hedge 15%, evergreen 35%,
stock market 40%, cash-like 8%, and thematic 2%. These are comparison targets,
not actual weights or instructions to trade. Stock market includes only the
four stock classifications; cash-like includes every Cash Accounts row and
every source-classified defensive asset, across all accounts. Thematic assets
are separate. No leverage or Exposure look-through value enters this total.
Each row retains a collapsed account breakdown. Integer-cent category/account
totals must reconcile to the unchanged classification total. Unknown source
categories refuse the new projection rather than being guessed into stocks.

Older authenticated snapshots without this optional projection retain their
four-category overview; the UI never invents six-category values from their
four totals or IB-only subset. The four top-five groups and their existing
per-security total/class weights remain unchanged. Their legacy “二级市场”
includes cash and thematic assets and differs from the new stock-market row.
New source associations recompute the optional projection from the same
pinned original rows; no report/health/ledger or source dates are rewritten.

Local candidate validation does not approve a live new cryptographic use or Gist
write. First publication requires review of the exact signed support and aligned
index-only UI heads, required checks/protected merges, explicit one-time manager
authentication/delivery approval, then actual owner/manager decrypt, investor
refusal and exact same-Gist readback. No auto-production or action retirement
is enabled by this candidate. Real source files and decrypted preview artifacts
remain private, outside Git, with 0700 directories/0600 files.
# Benchmark-only assets and date-specific denominators

New official projections use basis
`complete-official-classification-excluding-benchmark-only.v1`.
Only `QQQ.NASDAQ` and `SPY.NYSE` in `Citi-HK & 地产四期` are reference-only:
exclude their direct asset values from classification, six-category totals and
account contributions, and exclude their complete Direct or Underlying plus
Residual association from Exposure totals, rankings and denominators. Preserve
other accounts' real holdings, other securities and cash. IB-HK stock allocation
is unchanged. Source workbooks and benchmark-price consumption are unchanged.

Validate the entire original source before projection. Classification and
Exposure can have different dates and values: subtract each date's own complete
reference assets, never the other source's amount. Source dates remain the
actual official export dates; a fee-report cutoff does not advance ratio data.
Prior authenticated snapshots retain the previous basis and original totals.
Original-source association reconstructs that explicit historical basis; new
builders default to the exclusion rule. Invalid original rows remain errors
even when they belong to reference-only holdings.

## Fund distribution account and holding details

New official projections retain every evergreen and hedge-fund classification
row in its original strategy group. The collapsed “分类、账户与参考目标” section
shows strategy → account → holding, with accounts and holdings ordered by value.
Names use the same original-source date-suffix formatter as the top-five list;
individual periods and account associations remain traceable rather than being
replaced by a truncated display alias. Classification values do not include
ETF look-through contributions. Each group, account and fund total must reconcile.

Bar percentages use the corresponding fund category as denominator. The
evergreen 35% and hedge 15% references are the existing portfolio-level asset
targets, not strategy targets. No strategy target is invented. Authenticated
older snapshots without the optional holding details remain readable and
explicitly state that an updated snapshot is required for these details.
Raw source names and accounts stay inside the existing private authenticated
snapshot; only synthetic examples belong in public tests. This is a data-model
and display update, not a fee, ledger, source-date or authentication change.
