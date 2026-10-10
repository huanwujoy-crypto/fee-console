# Local EOD action-report candidate — wired, undeployed

This is a sensitive local code candidate, not a deployed report, a real sync
receipt, or publication approval. `daily.mjs` now selects `runFixedEodReport`
and its EOD schema-9 path by default in this local tree. The legacy explicit
`report.mjs --report-check` five-source schema-5 path remains available.
No endpoint, schedule, Flex query, credential, signing service, sync writer or
authorization-level rules are changed. Only explicit sensitive path registration
is added to the existing registry. IAM and renewal proposals below
are detached review artifacts; no actual grant or association change occurred.
The complete diff requires exact final-head OWNER approval before activation.

`adaptPrivateNoahUiExport` is a pure, explicitly supplied official UI cash-export
adapter for one-time private acceptance only. It checks pinned local transfer
bytes, exact existing portfolio/report URL scope, preserved report start and EOD
end dates, New York timezone, Investment type, exclusion of sold positions, USD
headers, export/read times and matching overview/group cash rows. It retains
`ui-export-observed` and original interval provenance, never an API wrapper or
sync-completion claim. Parent-reported original XLSX/PDF hashes are explicitly
not locally verified binary hashes. Period/compound or annualised returns are
not used as daily returns, and the adapter makes no instrument NAV/FX claim.

The private model can show that NOAH cash alongside dated IB facts while keeping
planning unknown. The API reader and production CLI/default do not select this
adapter. An explicit supplied-input `privateNoahUiExport` seam, requiring injected
transport, exercises the actual daily default generator for acceptance. The
acceptance harness denies real network; injection alone does not prove that.
It uses only `report-check/` objects and a distinct `private_eod_ui_acceptance`
receipt, never production delivery markers. Both the production EOD receipt
validator and canonical publication classifier reject UI-export observations.
There is no CLI/environment selector or daily browser dependency.
An unattended authenticated API call remains a separate deployment acceptance
item. All four new runtime/test/proposal paths are explicitly registered at the
existing sensitive level. Ordinary entries, prefix/level rules and exact-head
OWNER approval strength are unchanged; the registry edit is itself sensitive.

## Fixed default source and archive evidence

`daily` -> `runFixedEodReport` -> `runPrivateEodReport` -> immutable private
sources/HTML/receipt -> delivery HTML/receipt -> existing candidate-only publisher
is wired in the local tree. Synthetic tests exercise that actual default entry
without injecting `generate` or replacing cloud IO. Every request is mocked;
no new financial report, archive, secret or API was requested during implementation.
The already-authorized privately saved Oct8 XML was read only for offline format
acceptance; its contents remain outside the repository.

Local verification (2026-10-10): the actual default-entry roundtrip includes both
successful fixed reads and independent NOAH failure; no `generate` override is
used. Archive counterexamples cover identity/hash/cutoff/row dates/currency,
generation/metageneration and enumeration races, unsupported XML, pagination,
creation-time and byte/candidate/deadline budgets. Detached permission and
renewal boundary tests also passed. The private-ledger leak guard, retired
implementation-progress guard, diff whitespace check and renewal patch dry
applicability check passed. Astra's read-only offline evidence review found no
blocking local candidate issue in its initial review. Final indexed/committed
suite counts and final complete-diff review are recorded in the separate private
acceptance evidence. The three phone states' parser/status checks passed, plus
the EOD invalid-marker regression. Actual visual screenshots remain blocked:
local Chrome headless exited 134 without an image or diagnostic output; the
supported browser rejected local file URLs and forbade alternate paths to the
same blocked operation. No workaround or rendering-pass claim is made.
This is not protected CI, successful cash-source acceptance, phone visual
read-back, OWNER consent or deployment verification.

`privateCloudIo` reads only `family-portfolio-gateway-ib-cash-audit/reports/`
through fixed GCS JSON list/get routes and the existing source service identity.
The reader completely enumerates at most 5 pages of 100 entries (500 total) per
pass. A second complete pass compares the eligible identity/metadata set after
body reads: at most 10 list calls total. Total list and object-metadata response
bytes are limited to 2 MB, each metadata response to 250 KB. At most 4 eligible
bodies of 8 MB each (32 MB total) may be read. The archive operation has a
90-second overall abort deadline and each transport request a 30-second timeout.
Overflow, incomplete enumeration, duplicate names/tokens, malformed metadata,
invalid/future creation times, changed snapshots and ambiguity reject generation.

Eligibility is a conservative **reader policy**: original GCS `timeCreated`
must fall from source-date New York 16:00 through the captured reader clock.
DST is resolved explicitly. All eligible bodies are inspected, including late
uploads of older statements; older objects outside the window require no body
GET. Exactly one supported original statement must match the source date within
that window. This does not prove all-history uniqueness, latest revision,
producer timezone or financial finality. Early-close/early-arrived archives can
be conservatively excluded. A newly appearing or changed eligible object causes
rejection on the second pass; the two passes are still not an atomic transaction.

Each read pins both generation and metageneration, uses GET preconditions, and
compares returned metadata with the listed identity. Raw-byte SHA-256 must match
the `reports/<sha256>.xml` filename, size must match, and the sole original XML
account is compared with the independent existing approved-account binding.
Original statement cutoff and cash/position row reportDate/toDate must agree.
CashReport fromDate, when present, must equal the statement start. Only
CashTransactions/ConversionRates may have historical reportDate within the
declared closed statement interval; other sections retain strict cutoff checks.
All dates must be valid; future/outside-period historical rows reject. These checks establish content identity
and dated archive facts within the trusted private bucket boundary. They are
not an IB signature or independent authentication of its historical producer.

Usable base USD cash requires an explicit supported original FlexStatement `baseCurrency`
or `currency` declaration of USD, with no conflicting declarations or custom
metadata. BASE_SUMMARY, native USD rows, rate=1 and reader-supplied USD metadata
alone cannot establish it. Offline acceptance of the already-authorized original
Oct8 XML confirmed a single approved account, original 2026-09-09 through
2026-10-08 statement interval, matching cash start/end dates and within-period
historical transaction/conversion report dates. Its pinned file hash matches and
the strict grammar/date inspection succeeds after the section-specific repair.
Its actual statement header has no baseCurrency or currency declaration.
The previous frozen default rejected the whole report with `USD_UNVERIFIED`,
contrary to the approved partial-data design. The repaired default separates
archive identity from cash capability: every original still undergoes all
hash/account/date/grammar/numeric/cash-shape checks, while missing base USD leaves
IB cash null with `FLEX_BASE_CURRENCY_UNVERIFIED`. Conflicting original currency
declarations or metadata still fail hard. Source identity/date/hash remain
verified; supplier USD metadata cannot turn cash into a verified USD balance.
Available Sharesight allocation, cash-like detail and non-cash funding need are
retained. Pool, cash budget, buying power and executable amounts remain unknown;
no reconciliation result is deleted, fabricated or upgraded.

The actual `daily` default entry (without injected generator or cloud IO) passed
offline replay of the already saved Oct8 XML and IB-HK API response. A second
actual-default replay includes the separately pinned real NOAH UI export through
the private seam: all four cards remain and the UI receipt/publication boundary
rejects promotion. The API replay preserves mocked NOAH failure separately;
the synthetic production roundtrip covers both successful APIs and independent
NOAH failure through receipt, delivery and candidate-only publication validation.
All transport/association/GCS metadata and test clocks are explicitly mocked;
these are not new financial reads, current authorization or cloud acceptance.
An independent original base-currency declaration is still required before the
IB USD cash itself can qualify. Earlier inferred-USD private model probes are
superseded by this replay. No private XML, amounts, full account,
positions or actual cash values enter the repository or synthetic fixtures.

`configuredQueryId=1630084` is fixed consumer configuration. Historical producer
query/source-code evidence is unavailable and remains explicitly
`producerQueryId=null`, `queryProvenance=unknown` in private evidence. XML queryid,
custom metadata and the expected consumer configuration cannot upgrade that
claim. Original provider generation text is retained without inferred timezone.
Producer source-code availability is not required to validate account/date/hash
or a supported original currency declaration; provenance remains separately unknown.

The two existing fixed Sharesight GET scopes are each called once behind
independent outcome boundaries, using the existing gateway credential. Failure
of one retains the other and the valid EOD baseline. No IB secret, OAuth refresh,
live capture, completion verifier or financial-finality verifier is selected.
Noah UI exports are never selected. Missing orders, reconciliation, sync proof
and buying power continue to suppress dependent budgets.

## Detached permission and renewal proposals

`security/xuan-preopen-eod-source-iam.proposed.json` lists only source-SA
`storage.objects.list` on the fixed cash bucket and prefix-constrained
`storage.objects.get` for `reports/`. GCS IAM list permission exposes metadata
for the entire bucket; the prefix, page and byte budgets constrain this reader,
not the IAM list grant. This exact metadata scope needs explicit review.
The earlier official policy diagnostic found bucket list ungranted; effective
GET was not established. The proposed roles/bindings have not been created,
granted or tested against real objects. Delivery, builder and deployer identities
gain no archive access. There is no IAM applier or permission-changing command.

`docs/xuan-preopen-eod-association-renewal.patch` is a detached 30-day candidate:
2026-10-10 13:30 UTC through 2026-11-09 13:30 UTC. The live policy file is unchanged.
Do not apply before the proposed validFrom, since doing so would invalidate the
currently valid interval. If approval occurs later, review concrete dates again
before application and require a currently active association for any report.
The patch preserves scope, basis, editions, publisher and purpose. It is neither
approval nor automatic renewal. Formal implementation, protected merge, IAM,
deployment, report execution/recovery and public read-back each remain pending
concrete authorization under the existing gates. Start markers remain immutable;
this candidate does not clear or retry an earlier failed execution.

## Report and calculation contract

Schema 9 keeps the original four cards: 本轮补仓（规划 · 非下单）, BUY + SELL
挂单提醒, 现金优先补仓参考, 股票四类配置. Sharesight's existing IB-HK custom
classification 83569 remains authoritative. The targets remain 45/20/23/12 and
the denominator includes stocks only. VGSH/VGIT/TLT must remain 防御资产 and
are separate cash-like detail, never assumed sold.

Flex cash has distinct trade-date EndingCash, EndingSettledCash and native
currency detail. With independently verified base USD, BaseCurrency/BASE_SUMMARY
is the one USD base aggregate; native
Currency rows are shown, never added to that aggregate. Four previously unmapped
cash categories remain explicit source components, without manufactured
CashTransactions mappings. They are not proof of cash reconciliation finality.

With verified optional orders and verified EOD execution/cash reconciliation,
the original planning rule is preserved as a conditional EOD scenario:
IB EOD trade-date cash + NOAH cash − owner CALL original × 50% − each BUY's
remaining quantity × limit. SELL proceeds are excluded. The original 10% USSC
budget scenario and buy-only EXUS/EIMI solver determine conditional planning
amounts; surplus is retained. The public model and prominent card text explicitly
state the assumption that there were no unreflected trades, cash or position
changes after EOD. It is not a current reconciled budget. Every nonzero cash
residual stays pending, including sub-cent residuals; absent residual is unknown.
Pending or unknown EOD reconciliation suppresses the budget while retaining
verified cash and allocation detail. No executable quantities are generated.

Without orders, BUY and SELL are `null`/unknown, not empty; reserve, net planning
budget, after-order values and total capacity stay `null`. The current verified
allocation and buy-only developed/emerging funding need remain visible, clearly
separate from a cash budget. A genuine empty verified orderbook yields arrays
and zero reserve. AvailableFunds is always unknown for this Activity-only EOD
capability: EOD cash/settled cash is not broker buying power. Every EOD page is
therefore partial, including an EOD page with a conditional planning amount.
The report script and phone loader preserve that status and the source cutoff.

## Private sources and injected seams

`eod_sources.mjs` is a strict pure XML subset codec plus a snapshot reader
boundary. `eod_report.mjs` has no default financial reader, network client,
credential lookup or CLI. To call it, the trusted caller must inject:

- `readArchive` and `verifyArchive`: bind the trusted private archive's approved
  account, raw-byte SHA-256, immutable object generation and original source-date
  cutoff. Configured query ID is consumer configuration, not historical producer
  proof or an XML queryid. A callback cannot be treated as independent
  production evidence merely because it returns the expected fields.
- Optional `verifyArchiveFinancial`: this is separate from archive identity.
  The pure archive parser ignores supplier residual, execution-coverage and
  cancellation metadata and always leaves financial finality unknown. The trusted
  injected verifier must independently inspect actual existing financial receipt
  and snapshot evidence, not echo those claims. Its internal normalized result
  binds approved account, configured query, exact raw XML SHA-256, immutable
  generation, cutoff and scope `eod-cash-and-executions`, plus receipt/snapshot
  hashes and generations. Its facts separately establish residual, cash/execution
  coverage, cancellation completeness and all cash movements (including applicable
  corporate actions/transfers). These are adapter fields, not an invented real
  receipt format or a claim that the evidence has been located. Missing, invalid
  or unbound proof leaves balances/cards visible and coverage/reconciliation/
  budget unknown. Only independently proven exact-zero reconciliation and complete
  execution/cash coverage can qualify conditional planning; no NAV or
  Sharesight-to-Flex position reconciliation capability is thereby asserted.
- `snapshotReader`: use the existing fixed
  Sharesight source scopes (IB-HK, portfolio 936247, custom group 83569; NOAH-HK,
  portfolio 936238, investment_type). Reuse the existing stored API response
  wrappers and raw fields. Valid source/mode/portfolio/base-currency/cutoff and
  the original classification/cash parsers qualify dated API facts as
  `date-verified`. These facts can display classification, holdings-derived
  allocation, cash-like detail and cash without a new synchronization audit.
  Missing or malformed facts remain unavailable. This is not a completed-sync
  or independently reconciled broker-cash claim.
- Optional `verifySnapshotCompletion`: independently inspect a real
  completed-sync receipt and immutable snapshot, if available, then return the
  internal normalized proof binding source/date/raw hash/receipt hash/generation
  and completion time. The normalized proof is an adapter interface, not a
  claim that such a real receipt format or object has been located. Absent,
  invalid or failed completion verification retains dated facts and explicit
  null completion fields; the page says synchronization completion is unverified.
- `loadContext` and `io.savePrivate`: retain existing trusted account association,
  owner CALL ledger, prior public HTML hash, independent context recheck,
  create-only private storage and completion-marker-last discipline.
- Optional `captureOptionalLive`: reuse approved read-only capture and honor the
  supplied AbortSignal within the configured bound (maximum 30 seconds). There
  is deliberately no default MCP/OAuth dependency. Stale, future, malformed,
  timed-out or failed capture leaves unknown orders and cannot discard EOD or
  Sharesight outcomes. Providers that ignore AbortSignal are unsuitable for
  activation; timeout cannot cancel arbitrary noncooperative external code.

Public markers carry only curated report values, source outcomes, safe source
fingerprints and dates/times. They exclude account IDs, raw source payloads,
private object names/URLs and verifier material. Provider-generated text,
provider timezone (including unknown), source cutoff, sync-completed time and
read time remain distinct. Closed reason enums and scalar grammars reject raw
error text and arbitrary private strings. Order display time is derived from
accepted source capture timestamps rather than an injected display label. No timezone is inferred from archive creation time.

The private source manifest includes each exact source key, saved object name,
generation, saved-object SHA-256 and raw-input fingerprint relationship. After
source uploads, the runner checks the returned saved hashes, commits the canonical
manifest digest and source outcomes into the public opaque evidence hash, renders
HTML, then writes the completion receipt last. The private Flex source object also retains the independently accepted financial
proof alongside the archive and identity proof; its saved hash binds all three.
Only the opaque proof digest appears as `reconciliation.verificationSha256` in
the public marker. Private object names and financial proof contents remain out
of public markers. Daily, delivery and publisher recompute this binding; modifying
any source descriptor detaches the manifest and fails acceptance. This is a hash
binding within the existing trusted private archive boundary, not a new signing
system or independent authentication of a fabricated producer.

Daily and delivery accept only the new explicit EOD receipt mode, immutable
source evidence and matching canonical schema-9 HTML. The publisher retains its
existing association/reserve/context/head/owner/hash/age checks and only prepares
its original one-file candidate. It checks both initial and final refreshed context for same-date loss of verified
components or source freshness, including each independently available IB/NOAH
cash source and richer partial schema-4/schema-5/schema-9
reports. The existing protected classifier and promotion selector now recognize
canonical validated EOD pages, bind derived component/cutoff/read-time facts to
the actual HTML blob and apply the same downgrade preference. The selector
prefers a component-complete EOD candidate over a weaker candidate of the same
source cutoff. Ready same-date reports remain protected. No policy/workflow approval gate is changed.

The maintenance image copies the exact public association, source-IAM proposal
and detached renewal patch used by the runtime regression suite. Its allowlisted
build context and Docker COPY list must match; an isolated context executes the
runtime tests without repository metadata, historical pages or private inputs.

## Remaining activation gaps

The original business requirement for baseline EOD cards is an approved dated
cash source plus the existing Sharesight scope/classification. Broker positions,
executions, NAV/cost-basis archives and a new completed-sync receipt are not
prerequisites for displaying those facts. The additional financial verification
interface below applies only to the candidate's conditional cash-planning claim;
missing coverage leaves that claim unknown and does not block baseline cards.

The inspected known cash-only query has CashReport/CashTransactions/ConversionRates.
It proves neither executions nor positions/NAV coverage. The bounded XML codec
requires one balanced supported root/group/statement, direct supported sections
and rows, and rejects duplicate paired/self-closing sections alike; unsupported
real layouts remain an explicit activation gap. This does not imply
that all Flex queries lack those sections. The separately mentioned positions
and valuation archive remains unbound. Synthetic tests cover the official-style
summary position and execution field mapping only; actual expanded Activity XML,
NAV/cash/stock/total mapping, cost basis, P&L, corporate actions/transfers, cancel
coverage and real cash finality need an independently verified real source before
being used. The codec does not turn cash-only data into those capabilities.
No raw account/holdings/amounts from private archives were used in fixtures.
The existing real independent financial receipt/snapshot and trusted verifier
have not been located or bound. XML identity/hash verification, report-date
headers, supplier metadata and later hashing of those claims cannot establish
cancel, cash, corporate-action or transfer completeness.

The real existing Sharesight completed-sync snapshot object and completion
receipt format have not been located; those optional facts are not baseline
activation prerequisites. Existing API availability is separate:
not-called, request-failure, missing-fields, date-mismatch, malformed and
dated API facts without verified completion are distinct outcomes. HTTP 200, Scheduler success and a
lease owner/lease_until object cannot prove completed sync. The candidate supplies
no plausible invented production path or default verifier to bridge this gap.

Baseline activation requires trusted binding of the existing dated sources,
real private acceptance within the authorized scope, a fresh
protected-main/base check, review of the entire exact frozen diff and exact-head
OWNER approval, required protected checks, protected merge, approved deployment
and actual public/phone read-back. Offline fixtures and simulated publisher
requests prove code behavior only. They grant none of those approvals.

## Review repair evidence

Round-one Astra findings R1–R8 are covered by synthetic tracked acceptance tests:
closed public scalars/error reasons; private source manifest binding; richer
partial replacement protection at preparation and final promotion; real selector
roundtrip for validated EOD; conditional mixed-cutoff assumptions and suppressed
unreconciled budgets; strict XML topology/duplicates; derived order capture clock;
and exact-zero reconciliation policy. The tests assert corrected/rejected
behavior, unlike the preserved external round-one adversarial reproduction log.
All source and completion fixtures remain synthetic and grant no real acceptance.

Schema-9 public field increments after review are: opaque
`sourceManifestSha256`; `cash.planningBasis` (fixed conditional assumption or
closed unknown reason); orders `capturedStartedAt`/`capturedCompletedAt`; and
`reconciliation.status=unknown` for absent residual. All reasons, note text,
dates, UTC instants, IANA timezone and order trend scalars have closed values or
grammars. Protected action publication state adds only derived component bits,
source cutoff/read times and actual HTML blob binding; it contains no private
source paths or payloads. Existing schema-5 model/calculation fields stay intact.

Round-three R2N1/R2N2 acceptance regressions ensure that 61 valid orders or an
unsupported public SELL description cannot discard EOD/Sharesight cards: the
entire optional public-order contract is validated inside its degradation
boundary, with no truncation. The exact same validator is used by the final
model guard. A fixed independent synthetic oracle binds one predeclared XML
hash and separate synthetic receipt/snapshot; metadata-only mutations cannot
promote its financial facts. Missing proof, identity-only proof, altered source
bindings or incomplete independent facts keep budgets unknown. Synthetic oracle
results certify only fixture behavior, never real receipt availability or sync.


Round-four R3N1 validates the unknown-order core baseline before attempting a
captured orderbook. The same complete schema-9 guard then validates the whole
optional derived candidate, including reserve bounds, projected category values
and percentages, projected denominator, aggregate cash capacity and conditional
plan arithmetic. Only after the identical core facts have independently passed
may a capture-induced failure downgrade orders and every dependent field to
unknown. Core failures still escape. Synthetic regressions include oversized
reserves, fractional category rounding, projected-total overflow and aggregate
capacity overflow; supported empty books and all 60 supported orders remain
intact. The original schema-5 projection and planning formulas are unchanged.


Round-five R4N1 adds schema-9-only derived publication facts for reconciliation
status and opaque independent financial proof digest. At the same EOD cutoff,
replacement may neither discard an existing independent proof nor downgrade a
verified reconciliation. This comparison runs at initial and refreshed publisher
context, the trusted canonical classifier/selector, and candidate preference.
Original schema-5 complete reports keep their existing superseding behavior;
these financial facts are not universal component bits. A newer cutoff follows
the existing component and source/read-time checks. At an unchanged cutoff even
a new independent pending proof conservatively cannot replace a verified result:
no actual superseding-financial-evidence contract has been accepted. Pending is
still valid for a new report or a prior unknown result with retained evidence.
This is replacement protection, not production financial-format acceptance.
