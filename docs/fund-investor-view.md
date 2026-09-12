# Investor share value view

The investor tab adds a separate inception-close view over the existing managed
Schwab + Webull composite. It neither changes the fee start date nor rewrites the
economic ledger. Company, fund, investor names and initial ownership are supplied
by a local profile file, never embedded as real personal data in public source.

## Valuation

`createFundInvestorCore` is the pure source factory; the browser includes an exact
copy enforced by the tests. Its input must be the existing verified fee receipt
projection and the same daily data. The exact inception day's closing account
total includes the founding asset transfer and cash. Do not add either again.

- Initial per-share asset value = inception closing composite / issued shares.
- Personal asset value = composite × investor shares / issued shares.
- The first investor is rounded to cents; the final allocation is the remainder,
  so the two investors always sum to the composite's exact cents.
- Performance starts after inception close. The inception day's own return and
  the founding transfer are not counted again.
- Shares remain fixed only while there is no later external event. Effective
  receipt flows, unconfirmed automatic flow candidates and unresolved flows all
  stop the series before the earliest later event, including net-zero pairs.
  The engine does not turn a candidate into an economic flow or issue shares.
- Missing exact inception values, account fields, dates, complete receipt or
  flow evidence give a pending state. It never takes a nearby date or treats
  missing accounts as zero. Current values are hidden after a flow boundary;
  earlier history remains explicitly dated.

The display is **before separately accrued management fees and Carry**, not a
formal NAV after all liabilities. Existing broker-recorded expenses remain in
the account totals. The monthly fee receipt has no daily fee-liability balance
at fund inception; subtracting all historical fees would mix periods or double
count payments. A future net NAV must extend the same trusted receipt, not add a
second fee calculator. Provisional source data is labelled; unmarked historical
points are not promoted to independent calibration evidence.

## Profile and access

The `fee-console.fund-profile.v1` file supplies `manager`, `fundName`,
`inceptionDate`, `inceptionNoticeDate`, `currency: USD`, `initialShares`, and
exactly two investors with `id`, `name`, `shares`. Unknown fields and incorrect
share totals are rejected. The file contains display configuration, not a
financial instruction or an independently authenticated share register.

Import requires the existing source to be verified. It changes only local
display configuration, so a read-only user can import without a manager token.
The profile is AES-GCM encrypted using the existing data key, bound internally
to the current Gist identity, and read back before saving. A previous encrypted
profile is retained. Concurrent imports use a generation check; account/key
changes abort the import. Import removes any old profile from the URL fragment
so a refresh cannot silently restore an older version.

The existing read-only share URL may include the encrypted profile in its
fragment. No profile is uploaded, no new origin is contacted, and no write token
is shared. A reader retains the authenticated encrypted profile locally for
standalone use. X/Z-style view selection is display only: anyone with the
existing read-only link can see both investors and the full underlying report.
Separate private investor accounts would require separately reviewed access
control and are not claimed by this tab.

## Verification and release

The existing `returns.test.mjs` suite imports the fund arithmetic and browser
storage/render tests. Support code can merge before the index-only UI PR: browser
tests skip only when the feature is wholly absent; a partially introduced feature
fails. Active UI must embed the exact source factory. Fixtures use synthetic
names, keys, dates and amounts. `data.json`, economic settings and financial
accounts are unchanged by this release.

No SPY/QQQ fund-inception benchmark is introduced. The current fee-period
benchmark is a separate view and must not be relabelled as inception performance.
