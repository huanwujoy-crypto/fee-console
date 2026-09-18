# XUAN-IB sleep-priority delivery — independent fast lane v2

The owner wants current holdings and existing open orders before the lengthy
full PM report. The adaptive v1 checkpoint was implemented but the 2026-09-17
scheduled run spent over 20 minutes capturing and deriving the full report
without publishing its priority checkpoint. The v2 fast lane is a separate
scheduled Claude Code Routine, not a later branch of that same run. This file
does not assert that the new Routine has been activated or observed live.

## Direct decision

Run two independent, read-only scheduled tasks for the same Hong Kong PM slot.

1. The priority Routine starts at the existing 21:30 HKT weekday trigger. It
   checks the current trusted policy and public pair, creates its own run ID,
   journal and `adhoc` pre-read association receipt, then captures the five
   required IB endpoints once. Only positions and open orders are displayed;
   the other three endpoints support the existing source checks. Sharesight
   weekly metadata may be explicitly unavailable under the approved minimal
   route. It must not wait for any of the nine full-report Sharesight reads.
2. As soon as the private five-source candidate is validated, publish it
   through the existing protected Validate → Promote → Pages chain. V2 has no
   artificial ten-minute hold. The target is a verified public pair within ten
   minutes of this Routine's actual start; a miss is reported, not concealed.
3. The existing PM Routine runs separately on its own schedule, run ID,
   journal and `pm` receipt. It performs the full source plan and publishes a
   complete PM report. The priority Routine never performs full-report work,
   and the PM Routine no longer waits at or operates a T+10 priority gate.
4. The complete PM target remains 20 minutes from its own original start.
   A priority page does not satisfy PM completion or reset its clock.

Both tasks use the same approved read-only account scope. The fast lane adds a
second bounded read of the five IB endpoints, not trading authority or any
financial write. Scheduler delay is measured separately for each task.

## Priority checkpoint contract

- Same read-only financial boundary as the full report: no order placement,
  amendment, cancellation, transfer or account write.
- Same association, source capture, private journal and exact-source evidence
  requirements for every value shown. Old values are never relabelled current.
- Holdings come only from the validated direct positions source. Open orders
  come only from the validated orders source. Missing/unusable inputs fail the
  priority checkpoint; they do not become zero or “no orders”.
- The page exposes `概览 → 持仓一览` and `待办 → 挂单提醒`. Risk, allocation and
  ETF must not copy stale numerical results into a current-dated priority page;
  they show `完整报告更新中`. The canonical policy disclosure remains visible.
- Keep stable decision IDs, cards and immutable receipts, clearly labelled as
  the prior verified state; do not introduce or resolve decisions from the
  priority checkpoint.
- Use a machine-readable edition/state distinct from ordinary `pm`. The fixed
  freshness watchdog continues to require the complete PM report for the slot.
- Publication remains atomic and integrity checked. A private checkpoint, local
  HTML, candidate commit or successful Validate is not public delivery.

## Idempotency and replacement

- Each Routine owns its own immutable run ID and journal; both reference the
  same PM date/slot key. Rechecks cannot start a second priority run or produce
  duplicate completion notices.
- At most one priority checkpoint and one complete report may publish for that
  slot. If a full PM candidate is already available, the protected selector
  chooses it and refuses the priority downgrade. A later complete report must
  have a newer trusted source epoch and may replace the same date's priority.
- If the PM run obtained its pre-read receipt before the priority page was
  published, its receipt remains bound to the priority page's verified prior
  source. Only a same-date `pm` replacement may use that anchor; the trusted
  guard still checks decisions and receipts against the actual current public
  priority page. A PM run starting after priority publication binds the current
  priority source normally. For unchanged layout/policy material, it may read
  the last complete source via the priority marker's prior SHA, but may not
  reuse old financial values as current data.
- A failed or late full report leaves the priority page visibly incomplete; it
  must never be renamed “睡前版” or counted as a completed PM report.
- The fixed loader keeps the last verified bytes on any mismatch and polls in
  the background. There is no user-facing Refresh control.

## Protected implementation in this maintenance change

- `xuan-ib-sleep-priority.mjs` preserves validation of historical ten-minute
  v1 markers and creates v2 markers eligible immediately upon verified source
  readiness. The timer starts at the priority Routine's actual start and cannot
  be reset by retries.
- `xuan-ib-sleep-priority-report.mjs` converts the validated weekly-mode
  five-IB-source minimal report into a visibly incomplete priority page. It
  does not copy old risk/configuration values into the new date.
- The trusted guard requires the marker, body attribute, `adhoc` edition and
  visible `临时版 · 睡前速览 · 完整报告更新中` wording together.
- Promote classifies both the current public page and every candidate. It
  blocks publication before that marker's versioned eligibility instant,
  duplicate same-slot priority pages and a priority downgrade after complete
  PM. A complete PM candidate wins over a same-date priority candidate and may
  replace an earlier priority page.
- The ordinary PM watchdog remains unchanged: only a real `pm` page completes
  the fixed sleep slot.

Operational CLI after the protected change is merged:

```sh
node scripts/xuan-ib-minimal-prepare.mjs PRIVATE_DIR --journal JOURNAL \
  --sleep-priority RUN_ID RUN_STARTED_AT
```

`PRIVATE_DIR/input.json` must be the supported weekly-mode, five-IB-source
capture with `edition: adhoc`; the separate `adhoc` association receipt and
the eventual `pm` receipt must be created before financial reads from the same
fresh policy lookup/journal bootstrap. Both receipts bind the same journal run
ID and previous source SHA. This does not permit replaying or retyping data.

## Routine activation and acceptance gates

1. Obtain the repository's exact-head owner approval and merge this protected
   maintenance change before changing a live Routine.
2. Create one new weekday 21:30 HKT Claude Code Routine in the same trusted
   `fee-console` project with only the existing read-only IBKR connector and
   GitHub publication path. Its instruction is: fetch current trusted main;
   read this file, `CLAUDE.md`, `claude/xuan-ib-current-runbook.md`, the active
   account-association policy and the source-capture order; preflight the
   current public HTML/meta pair and stop if today's priority or full PM is
   already published; bootstrap one new private journal and `adhoc` receipt
   before any financial read; capture the five IB endpoints in bounded parallel
   batches with exact same-call receipts; use the supported weekly-mode input
   and `xuan-ib-minimal-prepare.mjs --sleep-priority` once; publish its sole
   guarded candidate through Validate → Promote → Pages; verify the exact
   public source SHA and HTML blob; report elapsed time and any missing source.
   Never read all nine Sharesight portfolios, generate full PM, trade, transfer,
   write to a financial source, retry with an old journal, or run twice for a
   slot. Its schedule/model/connectors must be read back after saving.
3. Update the original PM Routine to remove the old same-run T+10 priority
   block while leaving its schedule, model, connector scope, full-live source
   requirements and 20-minute target unchanged. Read the saved prompt back.
4. Test fast-full, slow-full (priority then PM), missing IB input, failed full,
   duplicate run, out-of-order candidate, mismatched public pair and mobile
   auto-update. Observe one real slot and prove exact public bytes/times before
   calling the independent fast lane operational.
