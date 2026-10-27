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
