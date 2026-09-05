# Seven-day owner-attested account association — inactive pilot

## Status and boundaries

The owner approved implementation on 2026-09-05 after being told the residual
risk: a silent upstream account remapping may remain undetected and a read-only
report could be attributed to the wrong account. This is a time-limited owner
association, **not an IB API identity attestation**. The implementation ships
`inactive` with null start/end dates. Code approval does not activate the policy.

Activation requires a separate exact-head OWNER-approved maintenance change,
a fresh official IBKR observation of the target account and Anthropic consent,
and inspection of the current Claude connector. Store the actual observer as
`owner-approved-operator` and keep the observation outside every repository.
Do not publish account numbers, consent rows, usernames, credentials, or private
paths. Public policy uses only the existing alias `IB-HK`, fixed enums and dates.
The first period is at most seven days; no automatic renewal or extension.
The sole initial edition is expressly requested `adhoc`; AM and PM are unchanged.

## Runtime and publication

1. Initialize one real private run journal at actual Routine entry. Complete the
   existing bootstrap and effective Git identity checks before financial reads.
2. Run the account-association helper's `check` command after bootstrap and
   before starting **either** IB or Sharesight read stages. It fetches the current
   policy from the pinned GitHub `origin/main`, not candidate content or a cached
   checkout. Write the new run-bound receipt to a fresh private file outside any
   repository. A failed fetch, inactive/revoked/expired rule or mismatched purpose
   stops the recurring path. Never fall back to an old receipt or manual proof.
3. The source adapter receives `{associationReceipt, associationSnapshot,
   journalPath}` and checks all actual read intervals against the policy and
   journal. Renew the **read of the same policy** before preparation if its local
   snapshot is older than 60 seconds; this is not renewing its seven-day validity.
   Do not alter any raw response or insert an account ID into it. Missing ID is
   allowed only with the explicit recurring basis; present wrong/null/empty or
   contradictory account identifiers stop the run. An arbitrary matching nested
   field does not upgrade the source to native identity verification.
4. The operational prepare command independently reads current main again. A
   policy blob change during the run stops preparation, even if its account alias
   is unchanged. Unrelated main commits do not invalidate an unchanged policy.
   A minimal public receipt and exact short disclosure are added to folded
   `报告说明`; full source envelopes and observations stay private.
5. Trusted Validate and Promote independently fetch current main. While the
   policy selects the recurring ad-hoc pilot, an ordinary ad-hoc candidate must
   carry the receipt; stripping it is not a route to legacy publication. They
   require the same policy blob, active status and unexpired validity. A revoked
   or expired pilot does not silently become a native-account report. Historical
   records-only updates preserve prior report bytes and do not authorize reads.

The pure preparation/validation APIs accept injected snapshots for deterministic
synthetic tests. A local successful check is never publication authority: trusted
CI discards snapshot overrides and obtains the policy independently. A hash of
raw evidence detects alteration but does not prove a connector call occurred;
the existing trusted producer, author/signature checks and source audit remain.
Git-based revocation takes effect after protected main is updated and the next
check observes it; it is not instantaneous cancellation of in-flight work.

## Unchanged financial and timing requirements

- Keep all five IB and nine required Sharesight reads, bounded parallelism,
  actual journal times, source fingerprints, existing decision/receipt history
  and Validate → Promote → Pages → exact public read-back.
- Sharesight's roughly one-day sync lag and small interest/cash discrepancies
  are owner-provided operating expectations, not guarantees or numeric tolerances.
  Compare actual dates, intervening trades, valuation times and currencies. Do
  not require same-time NAV equality or assume an unexplained difference is interest.
- The approved positions fallback remains at most **one completed US trading
  day**. Required current reads and failure gates are not relaxed.
- Use current IB cash for the IB component. Existing NOAH components, combined
  cash pool, CALL reserve and availability formulas remain unchanged. Do not
  substitute older Sharesight IB-HK cash for current executable IB funds.
- No report action trades, cancels/modifies orders, transfers money or writes
  to IB/Sharesight. Connector write permissions are a separate user setting.
- Keep the old `manual-consent-once-v1` implementation, failed attempt, journal,
  proof and persistent controller store untouched. It is not reused or extended.
- This change removes per-report Mac confirmation from the proposed recurring
  path, not all possible authentication failures. Ten-minute delivery requires a
  real separately approved end-to-end ad-hoc sample, then separate PM acceptance.

## Reconfirmation triggers

Stop using the association after changing IB username/account, reconnecting or
replacing the Claude connector, suspecting a context/account switch, or observing
unexplained material source discrepancies. Revoke and review the old association
before a fresh observed, separately approved activation. Do not automatically
reconnect, enlarge scopes, or create balancing entries.
