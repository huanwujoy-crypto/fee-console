# XUAN-ETF A/B/C method contract v1

Status: **approved method scaffold; baseline data pending**
Mode: **read-only measurement**
Time zone: **Asia/Hong_Kong**
T0: **2026-09-01**

This contract defines a deterministic, auditable A/B/C measurement engine for
the existing XUAN mobile page. It does not create a separate app and it does not
authorize an order, order change, cancellation, transfer, currency conversion,
or any other financial write.

## 1. The three arms

- **A — actual:** the policy-scope actual portfolio.
- **B — policy shadow:** an exact clone of A at T0. Only post-T0 cash-flow and
  policy-shadow effects may make it diverge. The v1 engine never rewrites the
  T0 clone into an idealized allocation.
- **C — market benchmark:** the exact CSPX accumulating share class identified
  by ISIN `IE00B5BMR087`.

The baseline is either `pending` or `established`. An established baseline
requires equal A/B values and equal A/B holdings fingerprints at T0. Missing
evidence remains missing; it is never reconstructed from a later price.

## 2. Economic date and market-effective date

Every verified external cash flow has one immutable `economicEventId`. A, B,
and C must reference the same:

- `economicDateHkt`;
- signed USD amount;
- FX identity and cutoff;
- `effectiveMarketDate` selected by the common valuation calendar.

`economicDateHkt` is the cash-flow accounting date and is never overwritten by
a market holiday. `effectiveMarketDate` is the first common market date at
which the valuation or future shadow treatment can use completed prices. It
does not move the cash flow to another economic date.

The calendar is a common HKT information cutoff, not an assertion that every
venue closes at the same clock time. If a venue is closed, the last completed
official close may be carried forward only with `staleMarketClosed=true`. If a
venue should be open but its price is missing, comparison is `unavailable`; the
engine does not bridge the missing date or read a future close.

In v1, `priceDates[*].date` means the HKT calendar date on which that official
close became observable, and it must equal the HKT date embedded in
`closeAtHkt`. A `complete` calendar accepts only official closes whose date is
the economic date. A carry accepts only an earlier completed close. This avoids
silently treating a prior-day close within a 36-hour window as same-day data;
v1 does not guess a separate venue trading date.

A market-closed carry may name a prospective common `effectiveMarketDate` no
more than seven calendar days after the economic date. It is a pending calendar
state: daily returns are null, comparison remains incomplete and no shadow units
are created. An unavailable calendar keeps its effective date on the economic
date instead of inventing a future resolution date.

An available comparison also requires holdings-bound coverage evidence. The A
instrument list is bound to its current holdings fingerprint; B is bound to its
shadow-units fingerprint and must cover CSPX, EQAC, USSC, EXUS and EIMI; C must
cover exact CSPX. A single benchmark price cannot stand in for the other arms.

## 3. Same-date, same-amount EOD cash flow

For each arm `x` on an available observation:

```text
endingValueAfterFlow[x] = endingValueBeforeFlow[x] + externalFlowUsd
dailyReturn[x] = endingValueBeforeFlow[x] / openingValue[x] - 1
```

This is equivalent to `(endingValueAfterFlow - flow) / openingValue - 1`.
Market return is applied first and the external cash flow is booked at EOD.
The new cash therefore earns no market return on its economic date.

Only verified movements across the policy boundary are external cash flows.
Trades, distributions, taxes, fees, FX conversions, and transfers between two
in-scope accounts are internal and must not be supplied to this engine as an
external cash flow.

## 4. B fail-closed behavior

B is a **marginal shadow** after cloning A at T0.

- When the CALL reserve is incomplete, a positive external flow increases
  `pendingCashUnallocated`. It creates no shadow units.
- When the CALL reserve is incomplete, a negative external flow increases
  `pendingOutflowUnsimulated`. The performance ledger still records the same
  negative flow on the same economic date, but v1 does not invent a sale,
  settlement, borrowing, or reserve treatment. B remains incomplete.
- Later verification is prospective. It must not backdate a shadow purchase or
  withdrawal simulation to the original flow date.

`implementationStatus` is derived, never accepted as a free assertion. Pending
outflow has first priority, then pending unallocated cash, then an incomplete
CALL gate; only a verified reserve with both pending balances at zero can be
`read-only-awaiting-shadow-signal`. Either non-zero pending balance keeps the
comparison incomplete and prevents ranking eligibility, even if the reserve has
already been verified.

A verified CALL reserve requires dated source evidence for verified 90-day
calls, the approved buffer and the FX/operations buffer. The accepted amount is
exactly `max(240000, calls + approvedBuffer + fxOpsBuffer)`; a bare
`reserveStatus=verified` assertion cannot open the comparison gate.

The zero-tilt candidate vector is fixed as:

```text
CSPX 60% · EQAC 0% · USSC 5% · EXUS 23% · EIMI 12%
```

After separately verified AI mapping and exposure validation, the eight-percent
vector is:

```text
CSPX 52% · EQAC 8% · USSC 5% · EXUS 23% · EIMI 12%
```

With a pending tilt state, the zero-tilt vector is display-only and explicitly
`candidate-not-deployable`. This v1 engine returns ratios only; it never turns
them into live dollar amounts or units.

An eight-percent state is invalid without a dated, fingerprinted validation
record that is effective no later than the observation. Merely writing `eight`
is not evidence.

## 5. C accumulating-share treatment

C is fixed to CSPX accumulating, ISIN `IE00B5BMR087`. Its cash dividend input
must be exactly zero because ordinary fund distributions are already embedded
in the accumulating share price. The zero is an accounting treatment, not a
claim that the underlying companies paid no dividends. A product-identity
change or exceptional cash distribution requires a new reviewed method version.

## 6. Metrics and ranking

The engine preserves exactly five raw metrics:

1. after-tax return;
2. maximum drawdown;
3. AI participation;
4. US-situs share;
5. CALL coverage.

It computes no weighted score and no composite ranking. `2026-Q3` is always a
stub because T0 is 2026-09-01. A ranking cannot even become eligible until at
least four later complete quarters exist, all five raw metrics are available,
and the A/B/C comparison is complete. Eligibility still does not itself create
a rank. A quarter is not complete until its calendar quarter has ended before
the observation date; future quarter labels are rejected rather than counted.

## 7. Runtime integration

`renderEtfAbcRuntimeCard()` emits a compact, static, read-only section.
It validates the full result, derives the public state and delegates byte-for-
byte rendering to `renderEtfAbcPublicRuntimeCard(state)`. This lets the trusted
publication guard require the visible card to match the canonical public JSON,
rather than validating the JSON while leaving independently editable text.
The first compact status line always renders both baseline and comparison
state; initial publication therefore says `基线待建立 · 暂不比较` without adding
another phone-card row. If an unavailable calendar also contains some visibly
carried prices, `估值不完整` takes display priority over the carry wording because
the missing common valuation prevents comparison.
`upsertEtfAbcRuntime()` is the only integration helper: it accepts HTML and an
already computed result, locates the unique existing `.pane.p5`, and inserts or
replaces the runtime block immediately after the unique canonical policy
section. It preserves every byte outside that block and fails closed when the
pane or exact canonical policy bytes differ, or when runtime markers are
orphaned, duplicated, or misplaced. Attribute-aware tokenization counts quoted
and unquoted reserved IDs rather than treating attribute text as markup. It
never writes a repository file.

The embedded JSON template contains only public method state and statuses. It
does not contain NAV, cash, positions, flow amounts, prices, or other live
financial values; the append-only measurement ledger remains the authoritative
continuity source. The card and template have no script, form, button, link,
broker action, or financial-write capability. Publication remains subject to
the existing candidate, validation, promotion, Pages, and phone read-back
gates. `validateEtfAbcPublicRuntimeState()` checks the exact public shape and
cross-field invariants. `parseEtfAbcPublicRuntimeStateJson()` additionally
requires the generator's canonical JSON bytes, so duplicate keys, reordered or
unknown fields and noncanonical encoding fail closed.

`countVisibleEtfAbcRuntimeClassElements(html)` is the trusted guard scanner for
the visible runtime class. It reuses the quote-aware tokenizer, counts exact
class tokens only on real non-inert elements outside templates, and rejects
malformed, duplicate, or character-reference encoded reserved identity
attributes. Self-closing syntax on `template` or a raw-text/inert container is
also rejected because browsers keep those non-void elements open. The guard
therefore does not rely on a bypassable regular expression or XML-like parsing.

The public evidence includes `baselineStatus`, `rawMetricsComplete` and the
ordered `completedQuarterIds`; counts and ranking status are re-derived from
them. During the initial rollout,
`validateEtfAbcInitialPublicRuntimeState()` is the mandatory publication gate:
it accepts only a pending baseline, incomplete comparison, no completed
quarters, incomplete raw metrics and `rankingEligible=false`. Established or
eligible states require a later reviewed integration with the separately
trusted append-only measurement ledger; self-asserted public JSON is not enough.

## 8. Private ledger and public checkpoint boundary

The authoritative evidence manifest, append-only measurement ledger and HMAC
secret are private operational data. They must remain outside this public
repository, below an explicitly approved current-user-owned `0700` root. The
loader accepts only direct-child, current-user-owned, single-link regular files
with exact `0600` permissions and reads them through a no-follow file
descriptor. It rejects symlinks, hard links, directories, oversized files and
roots inside the public repository.

The private manifest is byte-canonical JSON. An established baseline cannot be
asserted by a caller: it must contain T0 `2026-09-01`, an explicit completed
common valuation cutoff exactly at `2026-09-02T04:00:00+08:00`, an
evidence-observed timestamp at or after that cutoff and not in the future,
policy/scope/source/calendar fingerprints, and sorted per-account holding
evidence. Every holding binds its account, instrument, canonical quantity,
canonical USD unit price, explicit valuation-as-of HKT timestamp within the T0
window, source fingerprint and valuation-evidence fingerprint. The code rounds
each holding's quantity times price to USD cents
using half-up rounding, then sums those cents to derive A. It derives B as an
exact value-and-holdings clone of A. A later price cannot be used to reconstruct
missing T0 evidence, and neither A nor B can be supplied as an input amount.

Private entries use a SHA-256 hash chain and immutable-prefix continuity.
Public checkpoints use domain-separated `HMAC-SHA256` commitments under a
private random secret, expose only a non-secret key identifier, and bind ledger
identity, method, T0, entry count and private head. Each successor must link to
both the preceding public checkpoint and preceding private-head commitment;
trusted verification requires the secret and both private ledger states.

The repository may contain only
`claude/xuan-ib-etf-ledger-public-genesis-v1.json`: a canonical, value-free
pending bootstrap checkpoint. Its committed key and commitments are structural
test fixtures, not an operational secret or proof that the baseline is
established. Before an actual baseline exists, operations must create a new
chain with a private random secret and private evidence under the approved
root. Public validation rejects records, payloads, NAV, cash, flows, prices,
holdings, positions and units. A public checkpoint is continuity evidence only;
it does not establish the baseline or authorize a financial write.

## 9. Private bootstrap CLI runbook

The bootstrap CLI only creates or verifies files under an approved private root
outside this repository. The root must be current-user-owned mode `0700`; every
direct-child input or output file is mode `0600`. Output creation is atomic and
no-clobber. The CLI never prints the commitment secret or derived portfolio
values, and it never copies a private ledger or manifest into the repository.

Use absolute paths throughout:

```text
node scripts/xuan-ib-etf-ledger.mjs init \
  --private-root /ABSOLUTE/PRIVATE_ROOT \
  --ledger-out /ABSOLUTE/PRIVATE_ROOT/pending-ledger.json \
  --secret-out /ABSOLUTE/PRIVATE_ROOT/commitment.key \
  --checkpoint-out /ABSOLUTE/PRIVATE_ROOT/pending-checkpoint.json

node scripts/xuan-ib-etf-ledger.mjs readiness \
  --private-root /ABSOLUTE/PRIVATE_ROOT \
  --ledger /ABSOLUTE/PRIVATE_ROOT/pending-ledger.json \
  --secret /ABSOLUTE/PRIVATE_ROOT/commitment.key \
  --checkpoint /ABSOLUTE/PRIVATE_ROOT/pending-checkpoint.json \
  --manifest /ABSOLUTE/PRIVATE_ROOT/t0-evidence.json

node scripts/xuan-ib-etf-ledger.mjs establish-from-manifest \
  --private-root /ABSOLUTE/PRIVATE_ROOT \
  --ledger-in /ABSOLUTE/PRIVATE_ROOT/pending-ledger.json \
  --manifest /ABSOLUTE/PRIVATE_ROOT/t0-evidence.json \
  --expected-manifest-fingerprint COPY_EXACT_FINGERPRINT_FROM_READINESS \
  --ledger-out /ABSOLUTE/PRIVATE_ROOT/established-ledger.json

node scripts/xuan-ib-etf-ledger.mjs checkpoint \
  --private-root /ABSOLUTE/PRIVATE_ROOT \
  --secret /ABSOLUTE/PRIVATE_ROOT/commitment.key \
  --previous-ledger /ABSOLUTE/PRIVATE_ROOT/pending-ledger.json \
  --previous-checkpoint /ABSOLUTE/PRIVATE_ROOT/pending-checkpoint.json \
  --ledger /ABSOLUTE/PRIVATE_ROOT/established-ledger.json \
  --checkpoint-out /ABSOLUTE/PRIVATE_ROOT/established-checkpoint.json

node scripts/xuan-ib-etf-ledger.mjs readiness \
  --private-root /ABSOLUTE/PRIVATE_ROOT \
  --ledger /ABSOLUTE/PRIVATE_ROOT/established-ledger.json \
  --secret /ABSOLUTE/PRIVATE_ROOT/commitment.key \
  --checkpoint /ABSOLUTE/PRIVATE_ROOT/established-checkpoint.json \
  --previous-ledger /ABSOLUTE/PRIVATE_ROOT/pending-ledger.json \
  --previous-checkpoint /ABSOLUTE/PRIVATE_ROOT/pending-checkpoint.json \
  --manifest /ABSOLUTE/PRIVATE_ROOT/t0-evidence.json
```

`init` creates only a pending chain. `readiness` is read-only.
`establish-from-manifest` accepts only the canonical, cutoff-bound T0 manifest.
Its mandatory expected fingerprint must be copied exactly from the immediately
reviewed `readiness` output; any intervening manifest change fails closed. It
creates a new immutable successor ledger and never overwrites the pending
ledger. `checkpoint` accepts only the one-record pending ledger to two-record
established ledger transition and creates a value-free successor checkpoint
after verifying both predecessor links. These commands do not publish an
established state to the mobile report: that requires a later separately
reviewed integration and the normal Validate, Promote, Pages and phone
read-back gates.
