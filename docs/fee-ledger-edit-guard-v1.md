# Fee ledger accidental-edit guard

## Purpose and authority

The owner approved implementation of a default-read-only editing workflow on
2026-09-03. Codex and Claude independently reviewed the design and agreed on the
controls below. This is permission to build the protection, not to invent or
change opening balances, cash flows, payment records, rates, credentials or
broker transactions. Viewing needs no additional password.

## User experience

1. View and refresh normally. A stored manager token does not unlock editing.
2. Choose **修改账本** to read the existing encrypted ledger and open a separate
   draft. Figures shown in the main report continue to use the committed ledger.
3. Review the original and proposed values, enter a reason, then explicitly
   confirm saving. Empty or invalid numeric input must never become zero.
4. Five minutes of inactivity or switching to the background locks editing.
   Keep the draft, but invalidate its previous confirmation. Resume requires
   another remote read and a fresh version comparison.
5. Conflicts keep the draft and allow comparison with the remote ledger. A
   network error after submission means **result unknown**, not "not saved";
   read back before retrying. Never silently overwrite or discard either side.
6. Only verified write/read-back completion is called saved. Economic input
   changes invalidate old calculation receipts until a new verified one arrives.

## Write boundary

- Rendering, connecting, refresh, online events and page resumption never create
  or update a Gist. They may read existing configuration and daily AUM data.
- Only a reviewed explicit save may PATCH an already identified, encrypted,
  validated v4 ledger. Do not create a blank remote ledger during recovery.
- Compare the complete remote source revision and encrypted content both when
  entering/resuming edit and immediately before saving. Bind the intended
  encrypted content and unique change ID before issuing the write.
- Read back the exact intended encrypted content and validate its decrypted
  ledger before accepting success. Preserve uncertain submissions and drafts.
- Preserve historical audit entries as an unchanged ordered prefix; append one
  new entry carrying the change ID, time, reason, baseline and reviewed changes.
  Keep that audit inside the encrypted ledger, never public build output.
- Retain any differing pre-existing local ledger; a migration to read-only must
  not silently discard potentially unsynced historical input.
- Legacy v3 recovery is a separate, strict, copy-only conversion. Do not use the
  display migration function to authorize a real write.

## Limits, deliberately not overstated

This is an accidental-edit guard, not a new server-side identity or authorization
system. The existing GitHub credential retains its existing capabilities. A local
PIN would not change that fact and is not introduced by this feature.

Gist revision checks are optimistic conflict detection, not an atomic
compare-and-swap operation. Another writer can race between the last read and
PATCH. Avoid simultaneous editing on multiple devices. A stronger guarantee
requires a separately approved authenticated write service or verified server-side
conditional-write contract. Client-side append-only checks do not make an audit
tamper-proof against a holder of the underlying write credential.

Locking cannot retract an already submitted HTTP request. If the page locks or
loses connectivity during saving, reconciliation/read-back determines its result.
Never claim the lock guarantees that an in-flight save did not reach the server.

## Release and evidence

Use two separately reviewed changes: tests/support first, then a root
`index.html`-only UI PR. Changes to the CI workflow require the repository's
exact-SHA OWNER maintenance approval. Do not weaken publication checks or reuse
an approval for a later SHA.

Synthetic tests must cover default read-only behavior, draft isolation, invalid
input, cancellation, reason and review binding, inactivity/background locks,
remote conflict, audit continuity, unknown write results and exact read-back.
Production data recovery, a verified calculation receipt, deployment and real
iPhone rendering are separate acceptance gates. Synthetic tests prove none of
those by themselves. Do not test editing by writing dummy values to the real
financial ledger.
