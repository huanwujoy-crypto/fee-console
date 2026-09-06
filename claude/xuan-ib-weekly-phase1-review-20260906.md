# Weekly Sharesight phase 1 — technical review

Scope: explicit adhoc IB-live minimal reports, metadata-only weekly input,
unchanged financial-read-only/account/publication boundaries. This is not owner
approval, a financial source read, a generated production report or live SLA proof.

## Independent challenge and resolution

- Claude Fable 5.1 (CLI, Max) reviewed a technical summary only, with no account,
  financial, credential or raw source data. It accepted the legacy journal slot
  only with an exact discriminated metadata state, and requested downstream
  publication compatibility plus explicit HKT stale handling.
- Root verified the actual Validate/Promote workflows use the trusted guard and
  do not branch on live Sharesight count. Added synthetic post-guard checks of
  candidate selection, publication metadata/source truth and published decision
  menu. Existing decision/receipt template stays byte-identical. These tests do
  not execute GitHub approval, tags, pushes or Pages.
- Current/stale/missing/invalid metadata pass the real capture → prepare →
  trusted guard path. All metadata states leave dependent financial values
  disabled; stale dates remain original. Wrong account association and tampered
  hook proofs are rejected. Previously failed journals remain immutable.
- Claude Fable 5.1 (CLI, High) reviewed the bounded resolution summary and found
  no remaining design blocker for presenting this first stage for owner approval.
  This was a design review, not an independent line-by-line code audit.

## Verification and pending gates

- Full local test suite: exit 0, zero failures; two pre-existing skips remain.
- Latest focused minimal-prepare suite: 20/20 pass, including all four weekly
  cases, actual guard and offline post-guard functions.
- Added date-adversarial tests join the explicit blocking CI command.
- Exact-SHA owner approval, merge, fresh real source trial, controlled report
  promotion, Pages readback and actual <=20-minute acceptance remain pending.
- Durable weekly financial-value storage/capture/reuse, four-bucket current
  classification validation and AM/PM activation are NOT delivered by phase 1.
  No existing fee ledger store or credentials were repurposed.

## Efficiency observation

The initial broad local Fable/Max implementation request was stopped by the root
after approximately 15 minutes without source edits. Root implemented and tested
the bounded change directly. A small Fable/High follow-up completed in about
9 seconds. Different scopes prevent treating this as a model-speed benchmark;
use short review scopes and choose effort to fit the work.
