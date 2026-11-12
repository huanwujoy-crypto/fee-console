# Ratio source collection: intake prepared, live acquisition blocked

This isolated candidate is based on main
`6de56ffb708e8995edfc3b67895841ab474a2c02`. It does not
activate a collector. The earlier external 29-test prototype was unavailable
in this environment and has not been imported or treated as real acceptance.

The repository already has complete-original association, native aggregate
returns, manager encryption, fee-first publication and readback gates. The new
`scripts/fee-ratio-source-collector.mjs` reuses those source contracts to prepare
the existing input format from pinned original bytes. It does not change their
semantics or grant their authentication proofs.

## Runnable now

`ratioCollectionReadiness()` and an unconfigured `collectRatioSourceInput()`
return `BLOCKED` with four explicit gaps: official Exposure transport,
classification export transport, native aggregate performance transport and an
authorized ten-account session. No source request, credential lookup or fallback
occurs. Readiness is a statement about this implementation, not a live account
probe or proof that Sharesight lacks a feature.

`prepareCollectedRatioInput({originalBytes, expectedSha256})` accepts complete
`sharesight-private-performance-v1` evidence wrapping the existing official
workbook allocation contract. It builds the existing `ratio-sources.v3`, checks
the registered ten-account scope, complete row associations, independent source
dates, 36-hour capture window, Hong Kong calendar age and native performance
contracts, and returns original/input bytes plus their hashes. Closed positions,
benchmark membership, native units and inception evidence retain their existing
validation; no return is averaged or reconstructed.

The default requires performance evidence. An explicit
`requirePerformance:false` permits allocation-only v2 evidence; missing returns
remain absent. Unknown schemas, API JSON, summaries, invalid JSON, changed pins,
incomplete rows, stale/future captures or mismatched accounts refuse the bundle.

An integration may supply `readOriginal` to read an **already pinned** original.
The pin must come independently of the reader. It is validated before IO; the
reader is invoked once, a failure is not retried, raw exceptions are discarded,
and freshness is checked using the completion clock. Intake now has a 20-second
default deadline (configurable from 1 ms to 30 seconds) and accepts an external
`AbortSignal`. A pre-cancelled request never invokes the reader; a pending read
receives a cancellation signal on timeout or cancellation, and a late result
cannot become a prepared input. A reader that ignores the signal may continue
its own work, so its transport must also bound IO and clean up. Clock exceptions
become fixed refusal codes. This seam has no built-in network reader or source
authentication. It is not an automatic official download adapter.

Every prepared result says `PREPARED_UNAUTHENTICATED`,
`downloadVerified:false`, `publicationReady:false`. Hashes prove integrity only;
injected callbacks, test scope overrides and returned metadata are not authority.
No original download time is refreshed. The existing independent Library/source
identity, approved original SHA, fee-first verified handoff, manager recipient,
signed publication and authenticated readback gates still apply to the exact
returned bytes. No serialized result can substitute for those proofs.

## Real acquisition still blocked

Official [API introduction](https://portfolio.sharesight.com/api/) and
[usage limits](https://portfolio.sharesight.com/api/2/usage_limits) confirm API
access is separately permissioned and list Performance/Diversity report routes.
Those routes do not establish an Exposure interface, accepted classification
export semantics or native returns for each required consolidated scope.
The endpoint references render through client-side JavaScript; their complete
schemas were not retrieved here. No parameter or response mapping is invented.

This cloud environment has no configured Sharesight credential. Its actual
browser login state cannot be inspected: desktop capability is enabled with
state `unknown`, but no desktop JavaScript/browser-control tool is offered to
this thread. This is not evidence that an existing login has expired or does
not exist. No authenticated API/export request was attempted or denied.
To complete acquisition, the coordinator must identify an existing
authorized source session and genuine official export mechanism, then verify
scope, date controls, pagination, original files and native aggregate membership
with bounded read-only acceptance. If Exposure has no supported API, use only a
separately accepted genuine browser export; Diversity is not a substitute.
Do not add credentials, permissions, schedules or broker fallbacks to resolve
these gaps implicitly.

### Verified official browser routes and remaining acceptance

The following public documentation was checked on 2026-11-11. These are genuine
UI workflows, not verified automatic download endpoints or observed selectors.

| Source | Confirmed official route | Still needs actual authorized acceptance |
| --- | --- | --- |
| Exposure | [Tools → Exposure Report](https://help.sharesight.com/exposure-report/), choose grouping and up to Top 500, run, then [Export → Spreadsheet](https://help.sharesight.com/exporting-a-report/). Consolidated portfolios are supported. | Exact All Together ten-account identity, available plan/Top 500, complete original workbook and direct/underlying/residual rows. The guide describes current value; a historical date control is not established by it. Preserve the real export date and do not assign a requested historical cutoff. |
| Classification | The [Investments page](https://help.sharesight.com/show_portfolio/) guide, updated 2026-11-05, explicitly says that page has no Export button and instructs users to open a report. The [Performance Report](https://help.sharesight.com/performance_report/) supports custom grouping and spreadsheet export. | Observe whether the existing 资产类别 custom group and exact complete USD classification/cash rows can be exported through that report. This is a candidate path requiring a reviewed mapping; it is not automatically equivalent to the historical Investments classification workbook. Do not create or edit groups to make it fit. |
| Native returns | [Tools → Performance Report](https://help.sharesight.com/performance_report/), set period/grouping, include open and closed positions, run, export. The guide confirms native group subtotals and overall totals, as well as conditional cash performance. | Exact all-time/one-year source periods, required consolidated/class/strategy membership, native amount/percentage units, cash setting, closed positions, inception evidence and workbook cells. Never aggregate individual-account rates or ETF look-through exposure into a return. |

Exposure preserves residuals beyond the top 500 and may include negative
residuals for leveraged ETFs, as its official guide explains. It does not
look through all managed funds. These are source limitations, not errors to
fill using invented constituents. The existing projection retains signed
residuals and incomplete-universe disclosures.

All three UI paths stop at login, permission, plan-limit or missing-control
boundaries. Google Drive export is not selected: it introduces a separate
sensitive-data transfer and does not by itself establish trusted provenance.
The normal spreadsheet route must be observed before selecting it in an actual
authorized session; no internal app request URL, cookie or bearer extraction
is used as an automatic transport.

### Current session inspection result

Environment:
`ccarenv_b64_Y2NhcmVudl8yZTZjODNiNzA5ZTQ4MTkxOTAwNTAzNDBkNDkzZDI5MA`.
Fresh status reports `running`, `connected`, current observations and an
enforced restricted network policy, with no configured secrets/runtime
variables and no custom allowed hosts. It declares remote desktop enabled,
state `unknown`; discovery exposes neither `cua_repl.js`/desktop JS nor a
browser-control tool. Therefore login/session/account scope are **unverified**.
The environment's allowed hosts do not include the Sharesight API or portfolio
site; no request was made to test or evade that restriction and no environment
change was requested. Public documentation was read through the available web
tool without account data. Inspecting cookie databases, browser profiles,
DevTools credentials or another device's secrets is outside this task.

## Synthetic XLSX decoder (not an official layout or live collector)

`parseRatioWorkbook({workbookBytes,expectedSha256,profile,now,timeoutMs,signal})`
now calls the independent standard-library Python reader `fee-ratio-xlsx.py`.
It passes a pinned binary and exact JSON layout through private pipes to fixed
`/usr/bin/python3 -I`; only PATH, LANG and PYTHONIOENCODING are inherited. No
browser profile, token, ledger key, file input, network transport, formula
execution or publication is involved. Python must already be available in the
eventual collection runtime; the existing refresh image is not changed here.

All XLSX tests construct wholly fictitious accounts, securities, amounts and
layouts. No real workbook bytes were obtained in this cloud thread. Archived
originals were located in Library, but its download helper could not reach the
hosted tool service inside or outside the sandbox. This synthetic layout is
not presented as Sharesight's actual XLSX format.

An explicit `fee-console.ratio-xlsx-layout.v1` profile names one sheet, exact
header row/text and column letters, contiguous first/last data rows, metadata
cell coordinates/encodings, static label cells, expected view/accounts, and
percent representation (`percentage-points` or `excel-fraction`). Missing/extra
rows, duplicate identities or nonempty unconsumed cells in that sheet refuse.
Extra worksheets are counted, never asserted to be duplicate groupings or
complete coverage. Layouts, account declarations and hashes are not authority.

The reader supports inline/shared/rich-text strings, typed booleans and bounded
decimals. Dates require ISO or explicitly selected Excel-serial encoding; both
Excel epochs are supported, fictitious 1900-02-29 and fractional serial dates
refuse, and age uses Hong Kong days. Classification and Exposure retain their
independent dates. Metadata must say USD; no FX conversion, locale-number
guessing, implicit rounding or implicit percentage-unit conversion is added.

Classification keeps raw category, quantity/null and cash identity; the existing
official-source core retains financial bucket authority. Exposure preserves
signed Residual, matches each ETF residual to underlying rows in the same
account, and refuses negative direct/cash values, missing residuals or negative
net ETF values. No leverage multiplier or residual clamp is applied. Performance
keeps native amounts/rates and `p.a.`/`period`/`unknown`/`unavailable` units,
requires closed positions, checks exact one-year dates including leap day, and
preserves unknown cash scope. It never averages rates, annualizes them, or
constructs historical membership, first-buy or term evidence.

ZIP/XML sizes, entry count, expansion ratio, rows, cells and strings are bounded.
Duplicate/path-traversing/encrypted archives, external relationships, macro/`.bin`
parts, DTD/entities, invalid UTF-8, error cells, hidden selected sheets
and merges refuse. The parent caps stdout/stderr, hides raw errors, kills the
isolated child on timeout/cancellation and never retries. Only fixed
`RATIO_XLSX_*` failure codes escape. A late child result cannot undo a timeout.
The original classification/Exposure/performance profiles still refuse every
formula. The separate Diversity raw-table mode below has one explicit footer-only
exception; it neither evaluates formulas nor uses their cached values.

OPC internal relationship Targets now resolve `.` / `..` from the related source
part's directory (or from the package root for one leading slash). A worksheet
relationship such as `../tables/table1.xml` can resolve to `xl/tables/table1.xml`
only if that exact ZIP member exists. Traversing above the package root is
refused immediately, even if later segments would re-enter the archive. URLs,
network-authority paths, percent encodings, backslashes, query/fragment syntax,
empty segments and directory targets remain refused. External TargetMode and
duplicate relationship IDs are still rejected, and ZIP entry names themselves
still cannot contain traversal segments. No filesystem resolution or extraction
is involved. This compatibility change does not read a remote part, interpret
table data, change formula/cache handling or grant source authentication.

Seven new synthetic OPC cases bring the Python suite to 40 tests. The actual
isolated Diversity child fixture also includes the parent-relative table
relationship while retaining all original-intake, account-scope and publication
refusals. No real workbook or external compatibility patch was used.
The OPC continuation passes the combined Node regression with 644/644 tests,
zero failures/skips; the 40 Python tests are invoked inside it, not an additive
count. Syntax/diff and existing privacy/progress checks pass.

Results use `fee-console.ratio-xlsx-preview.v1`, status
`PARSED_UNAUTHENTICATED`, and false `publicationReady`, `sourceVerified` and
`completenessVerified`, binding workbook/profile hashes and source rows. They
are not `sharesight-private-full-v2` originals, Library identity, original capture
time, aggregate membership/term evidence or an official intake proof. A real
subprocess test confirms that the existing official intake refuses this preview.

Remaining coordinated interfaces are genuine accepted layouts per workbook;
complete worksheet/group/cash/member association; original download evidence;
and an authorized browser/export runtime. The mapper must preserve the true
report origin (Diversity cannot silently become Investments), independent dates
and original bytes before using the existing official and publication gates.
No live collector or new official-source schema is enabled by this reader.

Format references: Microsoft's [shared string table](https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/working-with-the-shared-string-table),
[Excel date systems](https://support.microsoft.com/en-gb/excel/date-systems-in-excel)
and [1900 leap-year compatibility issue](https://learn.microsoft.com/en-us/troubleshoot/microsoft-365-apps/excel/wrongly-assumes-1900-is-leap-year).

## Diversity raw-table preview from an abstract layout observation

The coordinator reported a read-only check of one real portfolio's Diversity
XLSX: each sheet's report date is A2, the first header is row 4 and the next
three headers are row 5, with Market / Code / Name / Percentage / Value / 资产类别.
The first sheet's detail is the multiset union of the remaining three and must
not be added to them. Numeric details are numbers; total formulas may lack cached
results. No account names, amounts or original workbook bytes were supplied here.
One portfolio does not establish completeness for three, ten or any other
multi-account scope, or authenticate a source.

The original classification decoder could not consume this structure: it requires
account/quantity/USD/view evidence and refuses formulas. A separate
`fee-console.ratio-diversity-layout.v1` profile now decodes only raw tables through
the existing pinned `parseRatioWorkbook` child. Its `kind` is `diversity`, not
`classification`. The profile has exactly schema, kind, canonicalSheet, date,
columns and sheets. Each sheet declares its name, header/detail row boundaries,
static labels and total cells. The six column mappings require the observed exact
header names, with explicit column letters. No sheet names or row ranges are
guessed, and extra/nonempty unconsumed cells or omitted worksheets refuse.

All declared sheets must have the same report date. The fixture uses A2 and
header rows 4/5/5/5; the implementation accepts explicit mappings rather than
hardcoding those positions. Date encoding must be explicit ISO text or Excel
serial; the actual A2 string/number encoding has not been supplied or accepted.
Unknown textual report-date formats are not guessed from the browser's date
input format. Existing Hong Kong freshness and archive/XML bounds apply.

The decoder compares complete raw row multisets across the canonical sheet and
its partitions, preserving repeated rows and their multiplicity. Only canonical
rows are returned. A declared empty partition contributes no invented zero
holding. The row fields are market, code, name, percentageRaw, valueRaw and
category, with source sheet/row. Missing optional raw identities remain null.
Percentage numbers retain their original magnitude; no fraction/percentage-point
conversion or rounding to USD cents occurs. Currency, view and account scope are
unknown, and no account, quantity or valueUSD field is manufactured.

Only explicitly declared numeric footer cells may contain a plain local
`SUM(<that column's first detail row>:<last detail row>)`. They must be outside
the detail range and in the mapped Percentage/Value column. The parser ignores
the formula and any cache, recording only its location and cache presence; it
does not evaluate it, use a wrong cache or substitute zero when no cache exists.
Other formulas, including formulas inside details or unexpected ranges/functions,
remain refused. Genuine formula variants and other workbook features still need
actual read-only acceptance before any supported mapping can be expanded.

The result is an unauthenticated XLSX preview with `kind: diversity`, false
publication/source/completeness flags, null currency/view and an unverified
account-scope marker. Matching table partitions is internal byte consistency,
not verified account coverage. The full classification/workbook-set preflight,
official-original intake and manager collection validator reject this preview.
There is no conversion to an approved original or publisher receipt.

Nine new Python synthetic cases exercise the four-table shape, no-cache/wrong-
cache totals, duplicate multiplicity, date/header contradictions, raw numbers,
restricted formulas, unknown sheets/cells, missing scope and empty partitions.
Python passes 33 tests. An actual isolated Node child also decodes this wholly
fictitious workbook and confirms the existing intake refusals. No original was
imported, downloaded, authenticated, deployed or published in this stage.
Combined ratio/refresh/packaging/registry regression passes 644/644, zero
failures/skips (498 ratio, 105 refresh, 12 packaging, 29 registry tests). The
33 Python tests run inside that Node suite and are not an additive total.
Python/Node syntax, diff and existing privacy/progress checks pass.

## Whole-set preview and remaining pipeline connections

`parseRatioWorkbookSet({workbooks,now,timeoutMs,signal})` decodes already supplied
bytes, not remote downloads. Its explicitly selected inventory is classification,
Exposure and all-time/one-year pairs for asset class, strategy, stock and top-five
returns (ten roles matching the archived inventory). This is a preview inventory,
not a claim that all future official reports must have this layout or file count.
Each descriptor has exactly role, workbookBytes, expectedSha256 and profile.

Before starting any subprocess it checks every role, pin and declared account/view
relationship and copies all bytes/profiles. Missing or duplicate roles and bad pins
stop without decoding earlier files. It decodes sequentially within one total
deadline, limits input and decoded totals to 20 MiB, stops on the first failure,
kills a pending child on cancellation and returns no partial bundle. Callback
mutation cannot change the captured bytes, profile or supplied clock.

Across the decoded previews it checks USD, exact declared views, matching all-time/
one-year periods including closed positions, and one common performance end date.
Classification and performance may be earlier than Exposure; neither may be later.
Their actual dates remain distinct. Declared account consistency is not proof of
the ten-account consolidated view, and ten workbook roles are not ten accounts.

Results have schema `fee-console.ratio-xlsx-set-preview.v1`, three false authority
flags and a hash-bound unauthenticated manifest. There is deliberately no `state:
success`/`COLLECTED_NOT_PUBLISHED` receipt. Tests confirm that both the manager
refresh collection validator and the official-original intake reject this preview
as a completed collection or publication proof. No source ID, capture timestamp,
native member evidence or authenticated origin is generated from it.

The current repository's remaining connections are:

| Stage | Current state |
| --- | --- |
| Genuine browser/API export | Not configured or accepted in this environment; no transport retry is attempted. |
| Local XLSX decoding | Single-file and whole-set synthetic decoding implemented; genuine layouts and complete worksheet associations remain unverified. |
| Decoded rows to accepted complete original | Still requires real origin/capture/Library evidence, cash/group/member/inception mapping and existing source-core acceptance. A preview cannot be renamed to the original schema. |
| Protected ratio publication | Existing cloud publisher verifies original bytes, manager binding, fee-first final readback, claim, signed snapshot and authenticated readback. Those existing gates are unchanged and were not run on real data. |
| Refresh-to-ratio wiring | Current `ratioStep` uses `RATIO_COLLECTOR_NOT_CONFIGURED` by default, stops with `RATIO_PUBLISHER_NOT_CONFIGURED` without an adapter and still returns `RATIO_DATE_POLICY_BLOCKED` if a publisher is supplied. These shared refresh files are intentionally not changed here. |

The refresh owner/coordinator must resolve the date/receipt interface and protected
publisher connection; official Exposure has no historical date control, so its date
must not be falsified to satisfy a request cutoff. This whole-set helper neither
activates a source runtime nor resolves those publication gaps.

## Observed report-control contract (no browser driver)

The coordinator supplied additional read-only page observations on 2026-11-11:
Tools has Exposure, Diversity and Performance entries; Diversity has
`Enter your date`; Performance has `Enter your start date`,
`Enter your end date` and `Include closed positions`. The observed date format
is `DD/MM/YYYY`. Exposure has grouping and Top 50/100/250/500 controls and no
observed date input. Export becomes visible after running each report. No export
was downloaded, and the actual portfolios behind `ALL` and `All Together` were
not established. These are coordinator observations, not a browser execution or
download performed by this worker.

`planRatioReportControls(intent)` now accepts exactly `role`, `report`, `view`,
`asOf`, `startDate`, `period` and `exposure`. All keys are explicit, with nulls
for inapplicable fields. It creates an offline intent and no browser actions:

| Role | Planned controls |
| --- | --- |
| Classification through Diversity | One strict ISO `asOf`, formatted as day/month/year in `Enter your date`; start/period/Exposure options null. |
| Eight native Performance roles | Explicit ISO start/end, matching all-time/one-year role, both observed date placeholders, and `Include closed positions` true. One-year uses the existing exact calendar rule; all-time requires an explicit start and never infers inception. |
| Exposure | No date inputs and null asOf/start/period. Require an observed grouping choice and one of 50/100/250/500; no historical date or custom grouping is invented. |

Classification via a Performance period report still requires an accepted real
mapping and is refused by this new control helper. The broader existing source
declaration can preserve such an origin, but does not supply that mapping. No
Performance custom-group selector or membership is inferred from a workbook role.

`assessRatioReportControls(intent,observed)` checks exactly `report`, `view`,
`dateInputs`, `includeClosedLabel`, `includeClosed`, `exposure` and `exportVisible`.
Each date input is exactly `{placeholder,value}`. Placeholder order may differ;
missing, duplicate or substituted controls refuse. Dates require ten-character
`DD/MM/YYYY` and a real calendar date, then must match the exact intended ISO
date. Locale guessing, swapped month/day, omitted zeros and impossible dates
refuse. Performance binds both the checkbox label and boolean value.

The selected view label must match exactly: `ALL` is never normalized to
`All Together`, and neither proves the ten-account scope. An Export visibility
claim only records a visible control; an absent control is explicitly listed as
an issue. Every result keeps source/scope/download/publication verification false
and includes `DOWNLOAD_NOT_OBSERVED`. The integrity hash binds the intent only.
No capture time, original bytes, download completion, scope membership or source
receipt is manufactured. Existing manager collection validation and official
original intake both refuse this assessment. Source dates/freshness must still
be verified independently from genuine report bytes by the existing gates.

Eight synthetic tests cover these controls, exact dates/leap day, closed-position
binding, current-only Exposure, distinct view labels, invalid identities and the
inability to turn a visible Export into an original or publication receipt. The
helper has no transport, browser, credential or publisher callback. No external
patch, actual account session, download or production action was used.
The combined ratio/refresh/packaging/registry regression now passes 643/643,
zero failures/skips (497 ratio, 105 refresh, 12 packaging, 29 registry tests).
The 24 Python synthetic tests remain invoked inside the Node ratio suite and
are not a separate total to add. Syntax/diff and existing protection checks pass.

## Declared source/date contract and local recovery

`createRatioWorkbookSession({workbooks,sourceContract,clock,timeoutMs})` freezes
the already supplied bytes, layout profiles and a separate
`fee-console.ratio-xlsx-source-contract.v1` declaration before any subprocess.
The declaration has exactly `schema`, `requestDataAsOf` and ten `sources`. Each
source has exactly `role`, `workbookSha256`, `profileSha256`, `provider`, `report`,
`transport`, `view`, `dateMode`, `requestedDate` and `capture`. Its pins/view must
match the frozen binary and exact JSON profile. `provider: Sharesight` is a claim,
never provider authentication; accepted transports are declared `browser-xlsx`
and `archived-xlsx`, neither of which performs a download here.

| Role | Declared report/date behavior |
| --- | --- |
| Classification | Preserve `Diversity`, `Performance` or archived `Investments` as the actual declared origin. Use `dateMode: as-of`; the decoded date must equal `requestedDate`. A live Investments export claim is refused. |
| Exposure | Require `report: Exposure`, `dateMode: current-only`, and `requestedDate: null`. Retain the decoded date, even when it is later than the overall request cutoff; report that discrepancy without inventing a historical export. |
| Eight native performance roles | Require `report: Performance`, `dateMode: period`, and one common requested end date matching the decoded reports. Existing closed-position and exact one-year checks remain in force. |

Dated source requests cannot follow the overall cutoff. Actual classification
and performance dates cannot follow Exposure. Source dates use the existing
four-Hong-Kong-day freshness limit, checked again after parsing. None of these
consistency checks supplies missing membership, inception or true report-layout
evidence, or resolves the refresh publisher's date policy.

`capture` is exactly `{basis,at}`. Basis is `download-completed`,
`original-file-mtime` or `unknown`. Known times must be canonical UTC instants,
not future, no more than 36 hours old, and no earlier than the source's Hong Kong
calendar date. Unknown means `at: null`; mtime remains explicitly mtime-only.
Parsing never fills an unknown time, refreshes an old time or authenticates a
declared download time. `assessRatioWorkbookSources(preview,sourceContract,{now})`
returns `UNVERIFIED`, an integrity-only contract hash, preserved declared origins
and capture claims, and issues including `SOURCE_ORIGIN_UNVERIFIED`. It always
keeps `sourceVerified` and `publicationReady` false.

A session is single-flight. `run()` starts only a new session. Local timeout or
cancellation produces `PAUSED` with no partial rows; only an explicit `resume()`
can restart the entire local decode from the same frozen inputs. Resume checks
the current clock and original capture times before starting a child and again
at completion. It cannot replace inputs, renew timestamps or accept a serialized
status as a checkpoint. Data/contract/date errors and unknown process failures
produce permanent `BLOCKED`, with no automatic retry. `close()` aborts any child,
releases the session's input references and permanently closes it. Each attempt
retains one bounded total deadline of at most 30 seconds.

Successful local parsing returns `PREVIEW_READY`, not a collection receipt. Its
publication/source/completeness flags remain false, and existing manager
collection validation refuses it. Recovery has no export, reader, publisher,
credential or filesystem callback and cannot retry an external access failure.
There is no durable checkpoint, production claim or restart after a process exit.

## Validation and integration boundary

Run the new suite with:

```sh
node --test scripts/fee-ratio-source-collector.test.mjs
```

It imports existing official synthetic fixtures and therefore also exercises
the existing source tests. In this managed sandbox every writable root has an
injected `.git` marker, which intentionally trips the private-directory guard.
Running the unchanged tests with an approved outer command and
`TMPDIR=/var/tmp` preserves the guard and permits the existing private fixtures.
No production evidence is used in these tests.

Initial validation in this cloud thread: the focused collector/official-source
suite passed 37 tests and the ratio regression suite passed 459 tests.
The continuation adds five deadline/cancellation/clock tests; the focused new
intake tests pass 17/17. Final combined regression:
`env TMPDIR=/var/tmp node --test scripts/fee-ratio-*.test.mjs` passed 464/464,
zero failures/skips. Syntax checks and
diff whitespace checks also passed. These are synthetic/offline checks, not
proof of a real Sharesight connection, source download or production readback.

Synthetic-XLSX continuation: Python's standalone suite passes 24 tests; the
ratio-only Node regression passes 471 tests, zero failures/skips. Seven Node
tests cover child isolation, pins, malformed outputs, timeout/cancellation,
an actual synthetic XLSX subprocess and refusal by the official intake. The
Node suite also invokes the standalone Python suite; these counts are not
independent sets to add together. No full-system independent audit was run.

Repository-only whole-set continuation adds eight tests and passes the same
ratio regression with 479/479 tests, zero failures/skips. It includes an actual
isolated decode of ten generated workbooks, preflight with no child IO, date/
period/scope contradictions, mutation isolation, cancellation and failure with
no partial result. No failed Space transfer was retried and no external patch,
financial source or browser was used for this continuation.

Source/date and local-recovery continuation adds ten tests. The ratio regression
passes 489/489, zero failures/skips, including the actual isolated ten-workbook
decode through the session. It covers origin preservation, pinned declaration
preflight, current-only Exposure, unknown/mtime capture claims, 36-hour and date
boundaries, explicit recovery of frozen inputs, non-resumable failures, stale
capture refusal before a retry, single-flight operation, backward/completion
clocks and permanent close. These are synthetic checks; no real source was
authenticated, failed Space transfer retried or external patch imported.

```sh
python3 -B scripts/fee-ratio-xlsx.test.py
env TMPDIR=/var/tmp node --test --test-concurrency=2 scripts/fee-ratio-*.test.mjs
```

The original three collector files were registered as sensitive in the previous
integration. The subsequent refresh isolation-preparation stage adds the two
Python paths as sensitive and includes the collector suite in CI, resolving
those two integration gaps. Its complete tracked-path check passes; all existing
registrations and the 22 ordinary paths remain intact. The earlier ratio-only
changes did not edit shared registry/workflow/UI/fixtures or the refresh backend.
The preparation stage changes no fee writer, runtime permissions, schedules,
production data or deployments. Unknown paths remain specific/sensitive. No
test or guard is removed or relaxed.
Protected exact-head approval, required checks and later independent review still
apply. Decoder tests alone do not establish a real source or publication readiness.
