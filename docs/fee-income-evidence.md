# Dividend cash evidence and posting-date gate

Cash transaction type alone cannot establish investor funding. A manually posted
dividend may appear as DEPOSIT, and its separately recorded collection fee may
appear as FEE, with null native payout/trade/holding links. Neither is a deposit
of investor capital. Generic dividend text or a standalone fee remains
insufficient evidence.

For the existing separate-fee convention, the fixed GET-only source reader recognizes paired controlled
`webull.dividend` cash keys. It reads the exact referenced native payout twice
with the other source snapshots. Both legs must be unique, belong to the same
USD cash account and target date, and match the confirmed payout's portfolio,
instrument, original paid date, gross, withholding and after-tax amounts. The
separate negative fee must reconcile with the source fee calculation and the
total cash increase. Its economic identity never becomes an external funding
flow, and withholding tax is not charged a second time as collection fee.

The payout's `paid_on` date and a broker email saying “deposited” do not prove the
actual cash posting date. Absent independent posting evidence, matched legs are
tagged `internal_income_pending_date` and remain unresolved with a precise date
evidence reason. No fee receipt or publish-ready claim can bypass that gate.

`incomeDateEvidence`, keyed to the exact paired source event, is a controlled
reader attestation. An accepted entry requires the exact target cash date,
`verified: true`, a nonempty source reference, and either `broker-cash-ledger`
authority or an explicit `owner-approved-cash-posting` decision. Comments and
notifications cannot create this attestation automatically. The production
reader supplies no such approval by default. Obtaining actual broker records
or explicitly reviewing the already-posted accounting date is a separate
source-review step; neither path rewrites the payout, cash records, fees or
payments here.

Only a complete, reviewed pair becomes `internal_income`. The existing unresolved
rows for those exact source cash records may then be removed; no external flow
is introduced. Unknown identity, duplicates, changed amounts, unconfirmed
payouts, unmatched fees and other currencies retain the ordinary fail-closed
classification. The usual stable-source, receipt and promotion gates remain.

No source references, actual cash record IDs, payout IDs, holder names, instrument
associations or monetary values belong in this document or public PR text.

Conditional owner estimates use a separate `internal_income_estimated` authority,
with `verified:false`; they never assert a verified broker posting date. The proof
must bind the exact portfolio, payout, cash account and two cash-record IDs. A
complete reviewed preceding-day statement must show no dividend, collection fee
or corresponding net cash movement, and the owner must explicitly authorize the
next-day estimate. Unknown or conflicting evidence remains unresolved.

The encrypted daily point retains the original conditional instruction, statement
reference, absence checks and `awaiting-official-record` follow-up. Its audit is
committed into the receipt hash and independently sets `owner-estimated-cash-date`
provisional status, even when valuation quotes are calibrated. The phone consumer
shows that the cash date is owner-estimated pending formal statement/Fund Records.
Same-day cloud reads restore only these scoped audits from authenticated encrypted
data. A later official record requires reviewed reconciliation: confirm the date
or correct it through the existing controlled backfill process; this change does
not automatically change broker payout dates or erase the estimate provenance.

A reviewed official statement may append a `resolution` to the original estimated
audit. It binds the same cash date and source pair to statement identity, SHA-256,
pages, issue date, reviewer and the gross/withholding/separate collection fee
reconciliation. The original estimate, absence checks and original follow-up stay
intact as historical provenance. Only a fully matching resolution clears the
owner-estimated cash-date provisional code; other provisional causes remain.
The writer permits only this additive transition once and rejects changed or
removed published resolutions. No cash record or payout is created or edited.

## Owner notification date with a single net cash deposit

The separate `owner-notification-cash-posting` authority records an owner-selected
investment-tracking convention. It requires `verified:false`, an exact notification
date equal to the target cash date, the original payout date, and
`awaiting-official-record` with `actualBrokerDate:null`. It does not require the old
preceding-day absence condition and never asserts that a notification proves the
broker's actual posting date. The phone displays this distinction and the
`owner-notification-cash-date` provisional code independently of quote calibration.

The audit binds one existing confirmed USD payout, holding and net DEPOSIT through
their immutable source identities. It records integer cents for gross, withholding,
collection fee, combined deduction and net cash. Withholding plus collection fee
must equal the combined deduction, and gross minus that deduction must equal both
the payout amount and the one cash deposit. The source's deduction field represents
the combined amount under this chosen convention; it is not a pure tax figure or
a tax-reporting calculation. The separate-fee convention continues to require its
own two legs and cannot reuse this payout or deposit.

The reader fetches the exact scoped payout through the existing GET allowlist in
both stable snapshots. It rejects missing or duplicate records, cross-account or
holding mismatches, changed cents, trade links and extra payout-linked cash legs.
Generic text supplies no evidence. An unmatched additional fee remains unresolved.
Classification adds no external capital, subscription, investor shares, second fee
or payment. Flow identity excludes dates and free-form descriptions; replaying the
same source identity is idempotent. Reusing a payout or deposit across audited days,
including between the old and new conventions, fails closed. Ambiguous old pending
flows require separate review rather than being silently removed.

For the first private import, the existing local producer accepts
`--income-date-evidence-file` with a strict `fee-console.income-date-evidence.v1`
envelope containing only `schema`, `targetDate` and `audits`. This transport records
a separately reviewed owner decision; it grants no consent itself. It accepts only
this new authority, with an absolute regular non-symlink file outside the repository,
owned by the current user in a private directory, both without group/other access.
The input is checked for changes around reading, writing and final validation.
Conflicting published audits cannot be replaced. Import is refused in GitHub Actions;
there is no new workflow input, secret, financial endpoint or source write.

The writer persists the normalized audit only in the authenticated encrypted target
daily point. Later same-day reads reload it from that point, and the receipt and
phone consumer commit and validate the same projection. The new authority requires
receipt engine `fee-v4.6.3`; older receipts remain valid for their existing inputs
but cannot be used to downgrade a new audit. Removing or changing the provenance
invalidates its receipt. No official-date resolution is inferred or appended by
this change; that reconciliation remains a separate reviewed operation.

The release requires two separately reviewed candidates because the existing UI
guard permits an `index.html` PR to change that file only. The backend candidate
retains the exact current phone consumer: offline tests pin its full index,
consumer and factory hashes and prove that it accepts existing audits while
rejecting a new notification audit, including attempted receipt downgrades. The
following UI-only candidate installs the matching factory and receipt consumer.
Private first import must wait until that consumer is deployed and read back.
Neither candidate imports real records or authorizes a financial operation.

The writer preserves other daily points. This alone cannot establish whether an
earlier source NAV changed when the upstream payout date was edited; that needs a
separately authorized historical source read. The cash-balance freshness gate also
remains unchanged. An already published target-day receipt does not prove that a
later producer run succeeded.
