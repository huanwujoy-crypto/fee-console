# GitHub Actions failure review — 2026-08-29

Repository: `huanwujoy-crypto/fee-console`

## Executive conclusion

The notification bundle did not represent fourteen independent product
defects. Most red runs were the same two fail-closed controls correctly
rejecting intentional maintenance pull requests. Two historical script
failures were real but already fixed by later commits. One freshness failure
correctly detected a missing scheduled XUAN-IB report.

Historical runs are retained as audit evidence. They cannot and should not be
rewritten after completion.

## Classification

### Publication-policy lock

The seven notifications reported by the operator, plus one later rerun observed
during this review, all failed for the same expected reason: a pull request
changed a protected XUAN-IB publication file. Representative first and latest
runs:

- <https://github.com/huanwujoy-crypto/fee-console/actions/runs/33138355360>
- <https://github.com/huanwujoy-crypto/fee-console/actions/runs/33230246928>

Resolution: keep the fail-closed lock, but add exact-head-SHA repository-owner
maintenance approval. A new commit automatically invalidates the approval.

### UI pull-request validation

The four notifications reported by the operator, plus one later rerun observed
during this review, duplicated the publication lock by rejecting the same fixed
page and metadata paths. Representative first and latest runs:

- <https://github.com/huanwujoy-crypto/fee-console/actions/runs/33179616579>
- <https://github.com/huanwujoy-crypto/fee-console/actions/runs/33230247750>

Resolution: remove only the duplicate publication-path rejection from
`ui-pr-check`; retain the UI risk guard. The base-controlled policy lock remains
the required security boundary.

### Script validation

Two real historical failures occurred before their branches were corrected:

- <https://github.com/huanwujoy-crypto/fee-console/actions/runs/33038017599>
  (`d93d138`): the candidate replaced the loader directly and did not match the
  trusted publication metadata.
- <https://github.com/huanwujoy-crypto/fee-console/actions/runs/33046573645>
  (`1564064`): the publication metadata epoch did not match the candidate.

Both branches were corrected before merge. Current main and later pull requests
pass the complete script suite; for example:

- <https://github.com/huanwujoy-crypto/fee-console/actions/runs/33226959256>
- <https://github.com/huanwujoy-crypto/fee-console/actions/runs/33230247747>

### Fixed-page freshness

The failure below was a real missing-report alarm, not a browser cache problem:

- <https://github.com/huanwujoy-crypto/fee-console/actions/runs/33181338384>

At the expected 2026-08-28 PM window, both GitHub main history and the public
page still showed the 2026-08-27 PM report. The HKT edition and Saturday-AM
watching semantics were subsequently corrected. A 2026-08-29 manual AM retry
also failed closed because the IBKR balances, NAV, orders, and trades read-only
endpoints were unavailable; it did not overwrite the phone page with guesses.

## Resulting operating model

- `xuan-ib-policy-lock`: one required publication-boundary lock.
- `ui-pr-check`: UI security validation without duplicate publication failures.
- `scripts-check`: formula, metadata, loader, and workflow regression tests.
- freshness watcher: a real operational alarm; never suppressed merely to make
  the dashboard green.
- intentional maintenance: draft PR plus exact-SHA owner approval; no temporary
  removal of branch protection in future.

## Follow-up audit — 2026-08-30

The nine additional failure emails generated on 2026-08-29 HKT were reconciled
against GitHub's run records:

- five `xuan-ib-policy-lock` failures: three were from the superseded double-lock
  design on PRs 65/66, while PRs 69/70 failed before their exact-head-SHA owner
  comments and then passed on runs `33237423342` and `33241002794`;
- three UI failures: the old UI guard duplicated the publication lock on PRs
  65/66 and was permanently de-duplicated by PR 67; and
- one freshness failure (`33232411691`): this was a true alarm because the
  scheduled 2026-08-29 AM edition was absent and the fixed page still proved
  only the 2026-08-27 PM edition. A later ad-hoc report must not be relabelled as
  that missing scheduled edition.

After the final failure at 2026-08-29 15:28 HKT, the next 50 workflow runs were
49 successful and one deliberately skipped, with no failure or in-progress run.
Historical red runs are retained and are not rerun merely to change their
colour. The next scheduled PM/AM edition remains the end-to-end operational
proof for the freshness watcher.

The policy lock deliberately remains fail closed while a protected maintenance
PR lacks an exact-SHA owner comment. To reduce notification races without
weakening the required check, use this order: create the draft, immediately add
the exact-SHA owner comment, then mark the PR ready. Do not make draft checks
artificially green, because the same head SHA could otherwise have a brief
mergeable window while the `ready_for_review` check is being registered.
