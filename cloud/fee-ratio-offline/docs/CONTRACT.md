# Offline XLSX adapter contract and synthetic layout

## Status and boundary

This is deidentified documentation derived from the allowed Python/JavaScript code in the 2026-11-10 candidate. It is not new financial evidence, a validation of real workbooks, a runtime implementation claim, or publication approval. No original workbook, private binding/capture JSON, browser snapshot, credential, historical inception module, or historical footer allowlist was read. Examples below are invented. Original financial values, account names, Library identities, hashes, and historical exceptional amounts are deliberately absent.

“Historical” below means behavior observed in the allowed source code, including gaps. “Candidate requirement” means a proposed stricter local implementation rule, not a claim that existing code enforces it. The independent cloud implementation must report unsupported or unavailable evidence rather than importing historical private cases, inventing identity, or silently producing a partial success.

Source references: `parameters.py`, `build_sources.py`, `prepare_official_bundle.py`, `official_workbooks.py`, `performance_workbooks.py`, `aggregate_performance_workbooks.py`, `top5_workbooks.py`, `combined_top5.py`, `stock_subtotal_bridge.py`, `capture_comparison.py`, `evidence_source.py`, and `project.mjs`. References to other modules below describe call sites only, not inspection of those modules.

## 1. Input envelopes

### 1.1 Historical `ratio-ten-workbook-bindings.v1`

The root object has exactly `schema`, `scopeSha256`, `dates`, `bindings`, optionally `inception`. No other root keys are accepted by `build()`.

- `schema`: string, exactly `ratio-ten-workbook-bindings.v1`.
- `scopeSha256`: expected SHA-256 string of the normalized sorted account array described below. Historical validation compares it to the calculated lowercase hexadecimal digest; require explicit lowercase 64-hex syntax in a new implementation.
- `dates`: object with exactly `classification`, `exposure`, `performance`, each a canonical `YYYY-MM-DD` string. Classification and performance must equal the separately configured target date; exposure must equal the separately configured exposure date and be no earlier than either.
- `bindings`: object with exactly `allocation`, `assetclass`, `strategy`, `top5`, `stock`.
- `bindings.allocation`: exactly `classification`, `exposure`, `capture`.
- Each other binding group: exactly `all`, `oneYear`, `capture`.
- Every leaf is the source specification below. Thus there are 10 XLSX inputs and 5 JSON capture inputs, not 15 workbooks. All 15 `libraryFileId` values must be distinct.
- Optional `inception`: exactly `archive`, `browser`. `archive` is a source specification. `browser` is null or an object with exactly `evidence` (source specification) and `snapshots` (mapping whose values are source specifications). All added evidence IDs must be distinct from each other and the 15 inputs. The allowed outer code does not establish the permissible snapshot keys or archive/browser payload schemas. Do not invent those contracts.

Every source specification has exactly:

| Field | Required type and meaning |
|---|---|
| `path` | Absolute local path string to original materialized bytes |
| `sha256` | Lowercase 64-hex SHA-256 of those exact bytes |
| `libraryFileId` | String matching `libfile_[a-f0-9]{32}` |
| `libraryVersion` | Integer >= 0, excluding booleans |

Historical `pinned_file` rejects a final-path symlink/non-file, enforces 1..20 MiB, hashes the file, and checks `user.library-file-id` and `user.library-file-version` xattrs against the specification. It does not authenticate identity merely from a pathname or caller-supplied ID. It re-reads pinned inputs after parsing. It does not provide all the race/ancestor protection of `pinned_evidence`.

Historical `pinned_evidence` additionally requires owned regular 0600 files with one hard link, uses directory-relative no-follow opens throughout the path and a stable descriptor, validates identity xattrs and device/inode/mode/owner/link count/size/mtime/ctime before and after reading, and checks the byte hash. Maximum size remains 20 MiB.

Candidate requirements: apply equivalent stable descriptor/no-follow protection consistently to every original input; reject path aliases, duplicate keys, non-finite JSON numbers, invalid primitive types, unknown fields, identity/hash mismatches, and source changes. Do not create, edit, or backfill identity xattrs to pass validation. A synthetic fixture manifest can bind synthetic files for testing only; it is never evidence of real Library provenance. Synthetic identity mocks belong only in the test process. Do not expose a runtime test mode or injected verifier; fail closed when genuine identity is absent.

### 1.2 Historical runtime parameters

`parameters.checked_config` requires exactly:

- `targetDate`, `oneYearStartDate`, `allStartDate`, `exposureDate`: canonical date strings.
- `oneYearStartDate`: same month/day one calendar year before target, clamped to the last valid day of the earlier month (February 29 becomes February 28).
- `allStartDate <= oneYearStartDate`; `exposureDate >= targetDate`.
- `reviewedMain`: lowercase 40-hex commit string.
- `nodeExecutable`: absolute path string.

The expected ten role identifiers are `classification`, `exposure`, and `assetclass_all`, `assetclass_oneYear`, `strategy_all`, `strategy_oneYear`, `top5_all`, `top5_oneYear`, `stock_all`, `stock_oneYear`. A batch validator requires exactly these ten roles, with matching target/classification/exposure dates. Do not derive a report date from the machine clock, filename, upload date, or materialization mtime.

## 2. Original capture records

Capture records must come from a collector that actually observed the report controls and original download metadata. A parser does not manufacture evidence that closed positions or a particular cash setting were selected.

### 2.1 Allocation capture JSON

Root: exactly `classification`, `exposure`; no schema field in this historical format. Each value is an object with exactly:

- `sha256`: string equal to the associated XLSX SHA-256.
- `originalMtimeNs`: JSON integer, excluding boolean. Integer nanoseconds divided by 1,000,000 must equal the millisecond timestamp represented by `capturedAt`.
- `capturedAt`: UTC string with exact syntax `YYYY-MM-DDTHH:mm:ss.SSSZ`.
- `downloadCompletedAt`: null or the same timestamp syntax.

Original mtime/capturedAt must be no later than `now` and at most 36 hours old. If completion exists: capturedAt <= completion <= now. The report's original as-of date must be <= the date of capturedAt plus eight hours. Classification as-of must equal target; exposure as-of may be later but must equal the separately configured exposure date at the full build stage. Preserve both report dates separately.

Historical gap: `prepare_original` uses ordinary JSON loading for this capture and does not itself reject duplicate JSON keys. A stricter reader must reject them.

### 2.2 Performance capture JSON (four groups)

Root exactly:

- `schema`: `fee-console.performance-capture.v1`.
- `accounts`: array equal to the sorted expected normalized account names.
- `reports`: object with exactly `all`, `oneYear`.

Each report record has exactly these 13 fields:

| Field | Type and constraint |
|---|---|
| `sha256` | String equal to that report's original byte digest |
| `rangeKind` | `since-inception` for `all`; `trailing-twelve-months` for `oneYear` |
| `startDate` | Canonical date; equals actual XLSX title and configured period start |
| `endDate` | Canonical date; equals target and actual XLSX title |
| `includeClosed` | Boolean true |
| `combineByHolding` | Boolean false, except Top5 may be true |
| `currency` | String `USD` |
| `groupBy` | Exact role-specific string below |
| `cashPerformance` | Enum `included`, `excluded`, `mixed`, `unknown`, with narrower build constraints below |
| `originalMtimeNs` | String of exactly 19 decimal digits, not a JSON number |
| `downloadStartedAt` | Null or exact millisecond UTC timestamp |
| `downloadCompletedAt` | Null or exact millisecond UTC timestamp |
| `observedCompleteAt` | Required exact millisecond UTC timestamp |

Role/group mapping:

- assetclass: `资产类别`, uncombined.
- strategy: `小程序收益分类`, uncombined.
- top5: `小程序前五收益`, either uncombined or combined by holding.
- stock: `小程序股票市场收益`, uncombined.

Time rules: derive original capture milliseconds by integer division of original nanoseconds, never by the transferred file's mtime. Start, when present, <= original capture <= observed completion <= now. Completion, when present, lies between original capture and observation, and after start. Age is 0..36 hours inclusive. Assetclass/strategy/stock also explicitly require target <= date(capture + 8 hours). Top5's historical helper lacks that individual check; candidate should apply it uniformly. Each period uses its actual capture, and the combined output retains the oldest accepted original capture time.

Historical cash constraints differ: base performance parser accepts the four-value enum; current auxiliary merging requires primary and strategy to have the same `included` or `excluded` value. Top5 capture helper requires `included`. Stock capture accepts the enum but does not promote unknown stock cash metadata into a portfolio claim. The final historical receipt reports `included` unconditionally, even though current auxiliary merging can accept excluded. Candidate must preserve validated actual settings, and reject a contradictory batch or report them without changing their meaning.

The stock attachment stage additionally enforces performance as-of no more than four UTC calendar days old, no future date, and overall performance capture age <=36 hours. These gates exist before projection even with historical `source_only=True`.

## 3. XLSX container and canonical columns

Historical XML reader limits total declared decompressed ZIP member sizes to strictly less than 100,000,000 bytes, rejects duplicate ZIP entry names, restricts referenced sheets under `xl/worksheets/` without `..`, requires strictly ascending row numbers 1..100000, rejects duplicate cell references within a row and cells outside the selected width, and requires each address's row number to match its enclosing row. It supports shared strings (including rich-text runs), inline strings, string results, numeric cells, and booleans; other cell types fail. Numeric values must be finite. Missing rows/cells are padded with null. Formulas are recorded, never executed; a bare signed decimal literal can supply a value when no cache exists.

Candidate hardening beyond this historical reader should reject duplicate sheet names/relation IDs, unsupported/external relationships, ambiguous XML structures, and unsupported formulas wherever they could affect interpretation. Do not treat historical overwrite behavior or boolean support in the low-level reader as permission for boolean monetary cells.

### 3.1 Classification/performance 17-column layout

The header must be an exact entire row, once per sheet:

| Excel | Exact header | Meaning |
|---|---|---|
| A | Market | Source market identity; blank for cash |
| B | Code | Security code; blank for cash |
| C | Name | Native name |
| D | Portfolio | Account name; `Portfolios` only for combined Top5 |
| E | Price | Native price |
| F | Quantity | Native quantity; retain zero/absent distinctions |
| G | Value (us$) | Native USD value |
| H | Capital Gains | Native gain amount |
| I | Capital Gains Percentage | Native percentage |
| J | Dividends | Native income amount |
| K | Dividends Percentage | Native percentage |
| L | Currency | Native currency gain amount, not the reporting currency selector |
| M | Currency Percentage | Native percentage |
| N | Return | Native return amount |
| O | Return Percentage | Native return percentage/unit evidence |
| P | 资产类别 | Group label; replace header with exact role groupBy for supplementary reports |
| Q | Labels | Original labels |

### 3.2 Exposure 8-column layout

Exact headers A:H: `Market`, `Code`, `Name`, `Within Etf`, `Portfolio`, `Ownership`, `Percentage`, `Value`.

Allocation data rows are rows after the header with nonempty account (D for classification, E for exposure). Account must be string and value (G/H respectively) must be finite int/float, not bool. Historical data extraction ignores rows with empty account; candidate must reject orphan security/name/value rows rather than silently dropping them.

`Combined` is authoritative. Other sheets are duplicate group views, not additional assets. Compare the multiset of all full data rows in all non-Combined sheets to Combined. Multiplicity matters; a set comparison would hide duplication. Each grouping sheet must have exactly one Total and its amount, rounded to cents under the historical Decimal quantize behavior, must equal its own row sum. Sum of group totals must equal Combined row sum. Combined must have exactly one Total; historical allocation code records its footer-minus-rows difference rather than rejecting it. Candidate must reject new unexplained Combined differences; never adjust source amounts to force agreement.

Allocation totals recognize `str(A).strip() == 'Total'`; performance parsers require exact `A == 'Total'`. If a total value is a formula, historical allocation supports only `=-?digits[.digits]`; expressions/references such as `SUM(G5:G8)` are unsupported. Historical allocation does not check formula/cache disagreement or forbid formulas in all holding cells. Candidate should require consistent literal/cache evidence and formula-free holding data, not inherit these gaps.

Allocation date evidence: exactly one string cell among the first five Combined rows containing English dates `d Mon yyyy`; all matched dates in that string must be identical. Parse this into original ISO as-of. This does not establish a fixed allocation title literal, nor do allowed sources prove mandatory identical title metadata on every allocation group sheet.

Exactly ten normalized account names are required by historical allocation validation. Normalize only literal `&amp;` to `&`, sort unique accounts, serialize compact JSON with non-ASCII preserved, hash UTF-8 bytes with SHA-256. Both allocation files must yield identical accounts and match `scopeSha256`.

Money projected from allocation must have exact cent precision (`Decimal(str(value))*100` integral). Classification cash requires empty B, empty A, P=`Cash Accounts`; other rows are positions. Exposure mapping preserves source percentage, normalizes empty market/code/within-ETF to null, and uses `Cash` when source ownership is empty. These transformations must not imply full ETF-universe or closed-position coverage; historical allocation explicitly claims neither transaction history nor closed positions.

## 4. Performance title, membership, Total, and period rules

All performance paths require Combined plus at least one grouping sheet, exactly one expected header per sheet, and one exact title before that header:

`Showing performance by <groupBy> between dates <d Mon yyyy> to <d Mon yyyy>`

Dates must match capture, runtime configuration, and the chosen period. Every aggregate, Top5, and stock sheet must contain the exact preamble string `Including sold shares`. Reject exclusion evidence. Historical implementations differ in whether they reject only the exact exclusion string, any substring `Excluding sold shares`, or a case-insensitive phrase. Candidate should reject contradictory exclusion evidence consistently. The older individual-return `parse_report` rejects exclusion phrases but does not require positive including-closed text; this is a historical gap, not the required new behavior.

Never remove closed holdings merely because quantity/value is zero or price is absent. Any nonempty code/name after a header requires an account in aggregate/stock/individual paths. New candidate must enforce it on Top5 as well.

Noncash member identity is `{account, market, securityCode}`; A/B/C must be nonempty strings and account must be in the expected scope. Normalize account entity spelling as above. Aggregate cash identities are `{account, market:'CASH', securityCode:<cash account name from C>}` with A/B blank and P=`Cash Accounts`. Duplicates are errors. Aggregate Combined must cover exactly all expected accounts. Historical individual holding parser skips valid cash rows and excludes only explicitly identified members; zero values do not authorize exclusion.

Every sheet has exactly one native Total row. A new candidate must reconcile native G with all native G data rows on that sheet exactly, with no global tolerance, no rewritten footer, and no copied historical exception. Historical aggregate/Top5/stock code calls `footer_reconciliation.reconcile` with file hash, group, sheet, column G, and report date range. The helper and its private cases were not inspected here. Its mere existence is not authority to accept a new mismatch. Allocation's separate permissive Combined behavior is likewise not a generic exception.

Formula differences in historical paths:

- Individual holding parser and Top5/stock reject formulas in every holding column A:Q.
- Aggregate parser rejects formulas only in membership/value columns A/B/C/D/F/G/P. A stricter candidate rejects formulas throughout holding data.
- Aggregate and Top5 validate numeric-literal formulas in Total G/O and require a non-null parsed value equal to the literal. Because the low-level reader supplies a literal fallback, an absent original XML cache may still pass; don't describe this as requiring an actual XML cache.
- Stock validates Total G/N/O using raw Decimal cache values. A literal formula is allowed without cache; any supplied cache must agree exactly. Expressions or cell references are refused.

Grouping checks differ intentionally in historical code: individual/Top5 compare complete rows plus O's number format; stock also compares exact raw numeric E:O decimals; aggregate compares only A/B/C/D/F/G/P membership/value/classification. Candidate must document its chosen stronger grouping check and not silently ignore duplicate or missing members.

Read native O; never sum, average, weight, or annualize source percentages. Supported missing values are null, empty string, `-`, `—`, `N/A` and produce unavailable. Text percentages support signed decimal plus `%`, optionally `p.a.`. Numeric `General` is transcribed in percentage points with unknown unit. Supported percentage number formats match optional `#,##` followed by `0`, optional decimal zeroes, `%`, optionally a quoted `p.a.` suffix. Numeric values in such a format are multiplied by 100 for display magnitude only. `p.a.` must be explicit in the individual cell/format. Report duration or settings do not prove annualisation. Native rows otherwise retain `termEvidence: {type:'unknown'}`.

## 5. Native aggregates, Top5, and stock

### 5.1 Asset-class and strategy totals

Use native Total O from Combined for `All Together` portfolio and grouping sheets for classifications. A grouping sheet must contain exactly one nonempty P label; scopes must be unique. `VC/PE` maps to `PE/VC`. In strategy reports, `Uncategorised` maps to `二级市场`; labels beginning `常青基金 · ` or `对冲基金 · ` map to a fund-strategy scope with that parent and the nonempty suffix.

A scope containing an explicitly excluded benchmark is withheld as a whole, never recalculated. Portfolio total with mixed/unknown cash evidence is withheld. Missing native union totals are unavailable, not synthesized.

Primary and strategy reports must agree on period/start/end/includeClosed/method/currency/cash status. Their portfolio member sets must match. Required fund parents are PE/VC, 对冲基金, 常青基金. Strategy derives from the first explicit code/name field before a supported dated marker, otherwise a delimited first field, otherwise 未分类. Do not infer strategy from brand. Supplementary PE/VC, each expected fund strategy, nonfund/noncash 二级市场, and Cash Accounts must match exact expected member sets; extra scopes are rejected. Replace only root, fund-strategy, and 二级市场 rows with the corresponding native supplementary rows, preserving their source identity.

### 5.2 Top5

Targets come from the pinned production projection of allocation, not arbitrary fixtures or current row order. Direct membership selection includes matching market/code in the target category and, for 常青基金 only, supported dated-name suffix matches. Every current target member must appear; duplicate history member identity fails. A single member can use its native row O. Multiple members require exactly matching native combined row or a group subtotal with complete exact membership; absent/ambiguous evidence is unavailable or rejected, never computed.

Combined Top5 requires header D=`Portfolios` and `combineByHolding=true`. Parse the source comma-space list against the exact known account-name vocabulary, accepting exactly one complete unambiguous parse with no duplicate accounts. Do not blindly split on commas because account names can contain delimiters. Each combined security row binds all primary rows for that instrument, not just a subset; account/name/market/code must match. Expanded Combined must cover every primary member exactly once; all expanded group sheets must duplicate that coverage exactly once in aggregate.

Quantity sums must agree exactly, with all-missing vs numeric patterns preserved. J income amounts remain exact (all absent is allowed; partial absence is not a computed zero). Value and other permitted economic differences use the explicit cross-capture comparison below, not a tolerance. Expanded rows are primary membership evidence only, not rewritten Top5 economic values.

### 5.3 Stock subtotal

Stock membership is exactly the primary categories 美国底仓, 美国科技, 非美发达, 新兴市场. Must be nonempty. No market/code instrument may appear both inside and outside this set. All source members across primary and stock Combined must match. Stock-group P is exactly 股票市场 for selected members, Cash Accounts for cash, Uncategorised for everything else. Exactly one non-Combined stock sheet must contain exactly the selected members. Use its native Total O. Do not change nonstock output, Top5, or inherited cash status when appending it.

### 5.4 Native return amount

Portfolio amount uses N on the same source row and source identity as native percentage O. Do not derive amount from value times rate. Historical amount validation requires a signed decimal literal numeric cell/formula, cache agreement when both exist, O consistent with expected percentage under percentage-format scaling to within 1e-9 percentage points, exact cent precision, magnitude <= 1e12, and H+J+L=N. Native member N values that exist must sum to N; historical code skips missing member amounts in this sum. Candidate should require complete member amount evidence if claiming completeness. The float round-trip must preserve the Decimal amount. Stock amount is checked by the builder, while the visible source bridge attaches the stock percentage; the portfolio output explicitly carries `returnAmountUSD`.

## 6. Cross-capture differences are evidence, not repairs

The historical `SourceComparison` evidence object has exactly `sha256`, `originalMtimeNs`, `capturedAt`, `period`, `startDate`, `endDate`, `currency`, `includeClosed`. It is reconstructed from already validated capture records. Both sides must have identical period/start/end/currency/includeClosed and bind to the actual original hashes. Record differing originals; never refresh the timestamps or assert their cause.

Per-account rows match by source account plus A/B/C; every identity must match and be unique. P is skipped only because independently verified group contracts differ. Other columns are compared, using exact XML Decimal values for E:O when available.

Differences allowed only when both hash and original nanosecond capture time differ:

- E price and G USD value may differ only if both finite nonzero values have the same sign; absent/zero/sign-change differences fail.
- H/I/K/L/M/N/O derived amount/percentage cells may differ or become unavailable under validated representation rules. Numeric/text/annualised text representations cannot be swapped except through a missing value.
- F quantity, J dividends/income, A:D identity, Q labels, and any other unrecognized fields remain exact. This is not a general numeric tolerance.
- Cash valuation differences require blank A/B, P=`Cash Accounts`, and genuinely null F. Identical explicit missing-price literals may remain as such. They cannot be normalized to zero; missing G fails. No native cash-balance or exchange-rate cause is proved.

Emit differences privately with source hashes, original capture times, source row/column, original left/right values and `cause:'unverified'`; report `sourceValuesAdjusted:false`. No assertion of exact equality when any difference exists. Candidate may choose to refuse all cross-capture differences initially, but must label that as stricter behavior, not pretend the historical contract demanded it.

## 7. Synthetic fixture layout for independent implementation

These are generated test inputs only, not real originals or authenticated captures. Use names such as `Account 01` through `Account 10`, fictional instruments `TEST:A001`, and invented exact-decimal amounts. Use ten accounts if testing historical allocation compatibility. Compute hashes from generated bytes; never copy a real digest or assign a made-up Library ID as genuine identity.

Suggested performance sheet layout (row numbers are suggestions; parser finds exact header):

1. A1: exact title with the selected group and synthetic period dates.
2. A2: `Including sold shares`.
3. A3: optional benign explanatory text or blank.
4. A4:Q4: the exact 17 headers.
5. Row 5 onward: fixture holdings with D account and P group, plus at least one valid cash row and one valid zero-quantity closed row for coverage tests.
6. Final row: A=`Total`, D empty, G=sum of member G, N=native fixture amount, O=chosen native fixture percentage. Put percentage style on O. Totals are fixtures, not inferred economic truth.

Make `Combined` contain every fixture row exactly once. Each non-Combined group sheet contains only its relevant rows, the same title/including-closed/header, and a native Total. Combined/group duplicates must agree according to the contract. For strategy/top5/stock copies change P header and intended labels only, plus D=`Portfolios` when combined Top5 is explicitly enabled. Preserve exact underlying membership. Do not use performance period title containing two dates as allocation single-as-of evidence: allocation needs exactly one date-bearing cell within first five rows with a unique date. Exposure uses A:H, account E and value H.

Capture fixture generation must explicitly choose a test `now`, a nonfuture original capture within 36 hours, valid observation sequence, original nanosecond string or integer according to capture family, and matching actual report dates. A fixed test clock must be confined to test-process patches, not a runtime clock override or refreshed real evidence. Tests should separately reject stale 36-hour captures, future timestamps, four-day date-age overflow, leap-year window mismatch, target/exposure confusion, and altered bytes.

Negative fixture matrix: missing or extra role; duplicate identity/key; wrong type/null; header spelling/width/group/currency mismatch; missing Combined/group; duplicate sheet/member/cell; omitted/extra grouping row; contradictory including/excluding-closed text; altered date/title; orphan holding; unknown account; unsupported formula; literal/cache conflict; footer mismatch; all-missing/partial-missing amounts; missing percentage; unit mismatch; combined Top5 ambiguous account list/partial instrument/coverage gap; cross-capture protected F/J change; zero/sign-change valuation; unmatched stock membership; unsupported inception schema. Every failure must stay local, avoid financial writes, and preserve originals.

## 8. Output and validation boundary

Historical allocation output is `sharesight-private-full-v2`. Historical assembled private output is `sharesight-private-performance-v1` containing accounts, allocation, performance and oldest `performanceCapturedAt`. Native aggregate performance uses `fee-console.ratio-performance-source.v2`; individual holding output uses v1; Top5 uses `fee-console.ratio-top5-source.v1`. These schemas are not interchangeable with an inception evidence schema simply because each mentions v2.

The historical JS bridge checks a trusted-module manifest against explicit reviewed-main and module byte digests, creates production allocation and company-exposure associations, builds native targets, requires both portfolio amount fields and stock supplementary sources, runs preview model validation, and emits `input.json`. Its `targets` mode already invokes production projection/association checks; source-only is not equivalent to a purely independent parser or permission to skip those checks. The trusted modules themselves were outside this inspection, so exact production acceptance beyond visible calls is not claimed.

A local independent candidate should expose precise stage results (container parsed, binding verified, captures validated, scopes reconciled, native values extracted, production projection unrun/blocked/passed), with `publicationReady:false`, no uploads/publications, and no success inferred merely from writing output. Use a new owned private output directory and exclusive 0600 files; never overwrite a historical attempt. Do not ship actual evidence with this contract.

## 9. Initial inception-v2 inspection limits and historical special cases

Allowed code proves only optional archive/browser evidence bindings, strict evidence-byte identity checks, and later calls into `inception_archive.prepare` and `browser_first_buy.supplement`. Those two modules were explicitly excluded and not read. This documentation therefore cannot assert their schema, historical identities, first-buy dates, invariants, completeness, refreshability, or general applicability. The same applies to the private historical footer reconciliation allowlist.

No general inception-v2 payload validator or schema is visible in the allowed code. A new implementation must not accept an opaque archive by copying private constants, treating source dates as inception dates, treating include-closed as full transaction history, or labeling a hardcoded case reusable. Until a deidentified approved inception-v2 contract and authentic evidence are available, fail closed for requested inception association or explicitly mark it unavailable and do not claim a full production build.

Recommended future inception-v2 design requirements (proposal only): versioned exact schema; genuine per-input byte identity and capture provenance; explicit account/member scope; original event/source locator and original event date; coverage boundaries including closed members and absence/unknown states; deduplication and contradiction checks; clear relationship between archive and browser corroboration; explicit independence from annualisation and report start dates; immutable evidence binding and post-read verification. Do not fabricate field names or silently present this requirements list as an existing accepted schema.

The implementation must remain capable of distinguishing “synthetic adapter tests passed,” “original sources validated,” “inception evidence supported,” and “current protected projection accepted.” None entails publication, and this document establishes only the first one's implementable contract, not a result for any actual batch.

## 10. Later implemented boundary

The subsequent code-only inspection of the existing aggregate consumer and its
source-core call established the precise v2 declaration/quantity contract. See
`PERFORMANCE-BOUNDARY.md` for the implementation and explicit authenticity limits.
This supersedes the earlier lack of a consumer schema in section 9, without
importing the excluded historical private modules or inventing new source proof.
