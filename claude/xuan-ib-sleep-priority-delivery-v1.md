# XUAN-IB sleep-priority delivery v1 — protected code candidate, Routine not active

This design records the owner request dated 2026-09-16: at bedtime, current
holdings and existing open orders matter before the rest of the report. Merely
reordering tabs or revealing an already-downloaded document in two steps is not
a data-delivery improvement. Activation requires a separately reviewed change
to the protected producer, publication workflow and original PM Routine, plus
exact-SHA owner approval and a real timed read-back.

## Direct decision

Use an **adaptive priority checkpoint**, not two unconditional public releases.

1. At the original PM trigger, start one journal and perform the existing
   account-association pre-read.
2. Capture and validate the IB inputs required for holdings and open orders.
   Build a private deterministic `sleep-priority` checkpoint containing only:
   the report date/read times, holdings table and open-order reminder.
3. Continue the ordinary full-live read, derivation and guard in the same run.
4. If the full report is candidate-ready by T+10 minutes, discard the private
   priority checkpoint and publish the full report once.
5. If it is not candidate-ready by T+10 minutes, publish the guarded priority
   checkpoint, clearly labelled `睡前速览 · 完整报告更新中`; continue the same
   run and replace it with the complete PM report when ready.
6. The complete report still targets exact public read-back by T+20 minutes.
   A priority checkpoint does not satisfy that target and does not reset the
   timer.

The existing duration audit measured Validate → Promote → Pages at roughly
75–85 seconds. Unconditionally repeating that chain would add latency and a
second conflict window even when the full candidate is already ready. The
adaptive threshold gives the owner an earlier useful view only when it is
actually needed.

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

- One PM slot owns one run ID and one priority key. Rechecks cannot start a
  second priority run or produce duplicate completion notices.
- At most one priority checkpoint and one complete report may publish for that
  slot. A later complete report must have a newer trusted source epoch and may
  replace only its own slot's priority checkpoint.
- A failed or late full report leaves the priority page visibly incomplete; it
  must never be renamed “睡前版” or counted as a completed PM report.
- The fixed loader keeps the last verified bytes on any mismatch and polls in
  the background. There is no user-facing Refresh control.

## Protected implementation in this maintenance change

- `xuan-ib-sleep-priority.mjs` defines the exact ten-minute threshold, delivery
  marker, coordinator decisions and public-page classifier. The timer starts at
  the original run start and cannot be reset by retries.
- `xuan-ib-sleep-priority-report.mjs` converts the validated weekly-mode
  five-IB-source minimal report into a visibly incomplete priority page. It
  does not copy old risk/configuration values into the new date.
- The trusted guard requires the marker, body attribute, `adhoc` edition and
  visible `临时版 · 睡前速览 · 完整报告更新中` wording together.
- Promote classifies both the current public page and every candidate. It
  blocks publication before T+10, duplicate same-slot priority pages and a
  priority downgrade after complete PM. A complete PM candidate wins over a
  same-date priority candidate and may replace an earlier priority page.
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

## Remaining rollout gates before activation

1. Persist `priorityReadyAt`, `priorityPublishedAt` and `fullPublishedAt` in the
   original PM run's private operational state; compute all durations from the
   original PM start. The pure coordinator is present, but its output is not a
   durable journal receipt by itself.
2. Update the original PM Routine only after the protected code lands; read the
   saved prompt back without changing schedule, model, permissions or account
   scope.
3. Test the saved Routine paths: fast-full (one release), slow-full (priority then full), missing IB
   input (no priority), failed full (priority stays incomplete), duplicate run,
   out-of-order publish, public HTML/meta mismatch and phone auto-update.
4. Observe one real PM slot and prove exact public bytes/times before calling
   the staged route operational.
