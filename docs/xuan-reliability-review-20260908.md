# XUAN reliability review — 2026-09-08

## Decision and scope

Claude proposed first using the current `fable` alias with `--effort max`
(returned main model: `claude-fable-5-1`). Codex independently inspected the
implementation, challenged the proposal and obtained agreement on this bounded
first batch. The review covered source selection/capture, account scope,
calculations, report preparation, publication, phone presentation, timing and
duplicate-run/notification controls. Technical material only was shared.

The duplicate lower Usage Guide was already deployed by PR #154; it is not a
new change in this batch. Its canonical financial report pair was unchanged.

## Findings and first batch

| Finding | Implemented response | Acceptance boundary |
|---|---|---|
| A fixed report used the wrong Sharesight method/name lookup on its first attempt | Deterministic 5-IB/9-Sharesight source plan; exact tools, ID-string inputs and account-scope prerequisites | The plan is intent, not a connector call, capture file or receipt |
| Current and retired runbooks overlap | Current AM/PM entrypoint read first from `CLAUDE.md` | Merged instructions are not proof that the original cloud Routines were updated |
| Retry-only timings can hide an earlier failed attempt | Observation-only whole-run summary, separate from authoritative journals | Complete real timestamps/evidence are required; no guessed or reset clock |
| Some list-form source limitations could disappear during note shortening | Preserve original contextual subtrees in a closed source fold; material exceptions retain context outside it | No financial arithmetic or canonical report bytes change |
| A failed optional layout import never retried for the same verified report | Manual Refresh retries only failed imports; successful or partially applied DOM is not mutated twice | No new financial fetch, permission, timer or background retry loop |
| Holdings tables force narrow-screen sideways reading | Exact known holdings tables gain mobile cards; retain original desktop/print tables and change groups | Unknown/malformed shapes use the original table fallback |
| Refresh briefly hid the stale-report warning | Keep it visible until successful pair verification establishes a current report | Fetch completion alone is not freshness |

The September 8 AM recovery produced a valid report but did not meet the
20-minute target: approximately 08:05 entry, 08:43 deployment, 08:44 public
read-back (HKT). These are operator-observed timings, not a newly reconstructed
stage journal. Missing stage times remain missing. The five-minute observer
that repeated scheduled prompts remains paused; no replacement scheduler was
created. Promotion no-op and a second collection attempt are distinct events.

Claude's subsequent code review returned **PASS with limitations**. Codex
confirmed the existing freshness/status functions and verified-success reset,
the retained table's parent through full browser transforms, and the absence
of import-time hook activation. Review follow-ups add bare-list qualifier
preservation, text-less source structure preservation, visible limitation
labels, total-row and nested/header quote cues, strict tool-name checks and a
completed-attempt prerequisite for timing pass. A browser-cached dependency
failure may require reopening the page; the loader now says so explicitly and
removes its temporary notice before transforming report content.

## Preserved boundaries

- Financial sources remain read-only. No trading, order changes, transfers,
  broker/Sharesight writes, credentials, permission-mode changes or hook arming.
- Account association still expires on the approved date; no renewal or native
  account-ID substitution is introduced.
- Preparation remains separate from controlled Validate → Promote → Pages and
  trusted public-byte read-back. Existing guards, rules, receipts and the current
  `latest.html/latest.meta.json` pair remain unchanged.
- Retired four-bucket management, manual report generation and paused Flex
  setup are not dependencies. Concrete cash-plan amounts stay on the dashboard.
- The existing minimal/weekly trial assembler is not activated for fixed AM/PM:
  it lacks the full fixed-report view and has stricter readiness restrictions.

## Remaining gates and deliberately deferred work

Final unchanged-code recheck: 1,611 tests, 1,609 passed, 2 existing skips,
zero failures (22.44 seconds).
Browser checks used isolated Chrome with the real current report at 320, 390
and 1280 pixels, all five panes, mobile holdings, desktop/print preservation,
failed-module recovery and unchanged canonical cache. The Saturday archive also
retained all 26 holdings and its immutable record templates. These are local
checks, not production rollout or physical-phone proof. A formerly fixed 15ms
test wait now observes completion of the actual progress task with a bounded
timeout; production timing is unchanged.
One full-suite run also exposed an unchanged legacy manual-consent concurrency
test's fail-closed error-text race (`private store size is invalid` rather than
one of its expected loser messages). Its one-success/one-refusal invariant
held. The retired manual-consent implementation and its strict assertions were
not modified or bypassed; retain this test flake in the audit rather than
claiming the whole repository has no pre-existing intermittent failures.

1. **Release:** exact-head owner approval and all formal checks remain required.
   Local tests do not authorize deployment.
2. **Real workflow:** after release, update and read back only the original AM/PM
   Routine instructions; preserve schedule/status/model. Observe one actual AM
   and PM from original start through public verification. A 20-minute pass is
   not claimed yet.
3. **Native capture and duplicate collection:** intent validation does not
   capture connector output or enforce a cross-host lock. Do not reuse a failed
   attempt's sources under a new receipt. An authoritative multi-host lease
   needs a separately reviewed design; no shared filesystem is assumed.
4. **ETF lifecycle:** calculation and display modules exist, but actual fixed
   task production and trading-date freshness of the embedded summary need
   live read-back. A valid schema or older completed baseline is not currentness.
5. **New holdings:** fee growth/value registry automation exists; a `newEventId`
   alone is not notification-delivery proof. Fee style classification is not
   the XUAN AI T1/T2 risk taxonomy. Do not convert one into the other.
6. **Phone detail:** the four-class allocation table still uses local horizontal
   scrolling on narrow screens; this batch fixes holdings, not every table.
   Headless mobile widths are not physical iPhone Mirroring acceptance.

Keep these items out of user-action To do unless the user actually needs to
act. Codex owns the technical follow-through; incomplete gates are not labelled
complete or silently discarded.
