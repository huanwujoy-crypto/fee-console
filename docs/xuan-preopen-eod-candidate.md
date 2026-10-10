# Local EOD action-report candidate — inactive

This is a sensitive local code candidate, not a deployed report, a real sync
receipt, or publication approval. The existing report/daily CLI still selects
`runPrivateReport` and its five-source schema-5 path. Nothing selects the new
`runPrivateEodReport` by default. No endpoint, schedule, Flex query, credential,
IAM configuration, signing service, sync writer or security policy is added.
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
planning unknown. The API reader and production entry points do not select this
adapter; both the production EOD receipt validator and canonical publication
classifier reject UI-export observations. No daily browser dependency is added.
An unattended authenticated API call remains a separate deployment acceptance
item. The six added EOD files are listed only in the existing sensitive registry;
ordinary entries, prefixes, classifier and exact-head OWNER strength are unchanged.

## Report and calculation contract

Schema 9 keeps the original four cards: 本轮补仓（规划 · 非下单）, BUY + SELL
挂单提醒, 现金优先补仓参考, 股票四类配置. Sharesight's existing IB-HK custom
classification 83569 remains authoritative. The targets remain 45/20/23/12 and
the denominator includes stocks only. VGSH/VGIT/TLT must remain 防御资产 and
are separate cash-like detail, never assumed sold.

Flex cash has distinct trade-date EndingCash, EndingSettledCash and native
currency detail. BaseCurrency/BASE_SUMMARY is the one USD base aggregate; native
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

- `readArchive` and `verifyArchive`: authenticate the real producer/archive,
  independently bind approved account, configured query ID, raw-byte SHA-256,
  immutable object generation and completed source-date cutoff. Configured
  query ID is not an XML queryid. A callback cannot be treated as independent
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
binding within the existing trusted private producer boundary, not a new signing
system or independent authentication of a fabricated producer.

Daily and delivery accept only the new explicit EOD receipt mode, immutable
source evidence and matching canonical schema-9 HTML. The publisher retains its
existing association/reserve/context/head/owner/hash/age checks and only prepares
its original one-file candidate. It checks both initial and final refreshed context for same-date loss of verified
components or source freshness, including richer partial schema-5/schema-9
reports. The existing protected classifier and promotion selector now recognize
canonical validated EOD pages, bind derived component/cutoff/read-time facts to
the actual HTML blob and apply the same downgrade preference. The selector
prefers a component-complete EOD candidate over a weaker candidate of the same
source cutoff. Ready same-date reports remain protected. No policy/workflow approval gate is changed.

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
