# Dividend cash evidence and posting-date gate

Cash transaction type alone cannot establish investor funding. A manually posted
dividend may appear as DEPOSIT, and its separately recorded collection fee may
appear as FEE, with null native payout/trade/holding links. Neither is a deposit
of investor capital. Generic dividend text or a standalone fee remains
insufficient evidence.

The fixed GET-only source reader recognizes only paired controlled
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
