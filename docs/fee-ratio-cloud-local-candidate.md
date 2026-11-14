# Manual ratio operation in the existing cloud producer

The manual ratio jobs reuse `fee-cloud-producer.yml`, its main-only WIF provider,
existing service account, Environment and serial concurrency group. No new
schedule, server, identity, provider, Google secret or service-account key is
introduced. Fee schedules/calculations/budgets/recovery/Nov3 once controls remain
unchanged. Every fee job, including always-run cleanup, is excluded when either
ratio input is present. The budget reader recognizes the two exact ratio job names
as non-fee-source work; unknown names still fail closed. A fixed ratio run title
excludes ratio failures from fee diagnosis. Ratio never creates a fee candidate
or triggers fee promotion.

## Shared configuration boundary

The owner personally adds **the exact existing manager token** as
`FEE_RATIO_MANAGER_TOKEN` in the existing `fee-cloud-producer` GitHub Environment's
official secret form. A same-scope replacement token is not the same cryptographic
recipient/signing identity. Never extract browser credentials, read credential
files, migrate from Google Secret Manager or include secrets in chat, workflow
inputs, source or logs. Existing `FEE_DATA_KEY` and `FEE_ECON_GIST_ID` are reused.
Only the ratio job maps the new token into its process. The Environment currently
restricts main but has no required reviewer or native per-job secret allowlist:
other admitted jobs could reference it through future protected code. The owner
accepted this shared boundary, not platform-level job isolation.

Only these bucket-level grants are added to the existing producer service account
on `family-portfolio-gateway-fee-ratio-private`:

- `feeRatioInputConsumer`: objects.get/delete, limited to `inputs/`.
- `feeRatioClaimRecorder`: objects.get/create, limited to `claims/`.

No claim deletion/reset, bucket listing, input upload or project-wide storage
access is granted. Earlier unused ratio pool/provider resources stay unbound;
they are neither used nor deleted. The bucket enforces public access prevention
and uniform access. Only inputs have a one-day delete lifecycle. Lifecycle is
asynchronous and is not an exact 24-hour erasure guarantee.

## Operations and private input transfer

After exact-head approval and protected merge, first run only **verify-current**
against the accepted V7 body digest: authenticated owner, recipient and full
snapshot; no Storage authentication, input read, claim, PATCH, Sharesight request,
ledger decoding or fee publication. This is not a fee run or natural-cycle proof.

Manual inputs are `ratio_main` (exact current reviewed main) and `ratio_plan`
(closed JSON). All fee/source-check inputs remain default. Only the existing
owner, main branch and first attempt are admitted. Public preflight validates
admission and live main; the protected job repeats that check before credentials
are used. Plans/hashes constrain execution but do not provide user consent.
Do not dispatch a manual ratio operation during the original Nov3 fee window.

A verify plan contains `mode: "verify-current"`, `previousBodySha256`, and
`bundleId`, `original`, `input`, `library`, `fee` all null. A later separately approved
publish plan uses `mode: "publish"` and two `{name,generation,sha256}` references:
`inputs/<64-hex-bundle>/original.json` and `input.json`. `library` is the approved
private source `{fileId,version}`. No arbitrary URL, destination or secret is input.

### Scheduled ratio (owner decision, 2026-11-14)

The first daily schedule slot (`0 1 * * *`, 09:00 Hong Kong) may also publish
the ratio, in the same run as the scheduled fee report and independently of it.
It is a separate opt-in: the repository variable `FEE_RATIO_AUTO_ENABLED` must
be `true`. Setting it to anything else returns the ratio to manual dispatch and
changes nothing for the fee report. No job, input, run title, secret or
credential is added; the existing `ratio-preflight` and `ratio` jobs gain a
schedule branch beside the unchanged owner dispatch.

- Target: the Hong Kong date before the run, and only when the reviewed market
  calendar proves a session on that date for `FEE_REPORT_MARKETS`. A day with
  no session publishes nothing and reads nothing. An unknown venue or year
  refuses.
- Plan: an ordinary `publish-api` plan with `fee: null`, derived by the code,
  never supplied by an operator. Its previous-body field is a placeholder; the
  publication step takes the just-read, fully verified current snapshot as the
  previous one, and every later lock uses that exact hash, so a snapshot that
  changes during the run is refused as before.
- Once a day: only the first slot carries the ratio, and a current snapshot
  already at or beyond the target date is left untouched.
- A scheduled ratio failure does not mark the scheduled run as failed (job-level
  `continue-on-error` on schedule only), so it cannot raise a fee-producer
  alert; its closed safe result is still printed and retained as an artifact.
- A missed or failed first slot is not retried by the later slots; publish
  manually for that day. The fee report's own 11:30 and 14:00 slots are
  unaffected, and `ratio` jobs never count as fee source attempts.

### Fee-first gate

**The handoff is optional (owner decision, 2026-11-14).** A publish plan may
carry `fee: null`. The ratio is then published on its own: `FEE_READBACK`,
`SOURCE_ROUND` and `FEE_RECHECK` do not run and no fee report is read. Nothing
in the snapshot, its signature or the page depends on the fee report — the
snapshot stores no fee identity and the page compares none — and each report
keeps its own real source date, so the two may show different dates. The key is
still required: a missing or malformed `fee` is refused, never read as absent.
Everything below applies unchanged to a plan that does carry a handoff. The
shared `fee-publication-critical` queue is kept, so a fee promotion and a ratio
write still never run at the same time.

A publish plan also carries `fee`: the coordinator's handoff of the fee report
that is already formally published, `{mainSha, accountingThrough, dataSha256,
healthSha256}`. A producer job or a candidate branch is not a publication. Before
the claim (`FEE_READBACK`) and again before the durable write intent
(`FEE_RECHECK`, bound to the first proof), `scripts/fee-ratio-fee-publication.mjs`
requires all of the following:
- `data.json` and `fee-data-health.json` at `fee.mainSha` hash exactly to the
  handoff;
- the live main is still this run's `ratio_main`, and its root carries the same
  two blobs, so a newer promotion supersedes the handoff;
- Pages serves the same bytes;
- the health receipt is a verified `updated`/`no-op` bound to the data, for
  `fee.accountingThrough`;
- the decrypted fee receipt, period metadata, Jenny return and drawdown verify
  for that cutoff.

Repository reads use only the existing read-only `GITHUB_TOKEN` and only fixed
`api.github.com/repos/huanwujoy-crypto/fee-console/` URLs; Pages reads carry no
credential and no redirect is followed. The only added input is the existing
non-secret `vars.IB_MANAGER_BASELINE_SHA256`.

The fee and ratio reports keep their own real source dates and may differ; the
fee cutoff comes only from the handoff, never from the ratio source. There is no
36-hour age gate: identity decides. An older fee report is accepted only when it
is explicitly handed over and still live, and a superseded one is refused. A
refusal before the claim reports `WAITING_FEE_READBACK_NO_WRITE` and consumes
nothing. A refusal after the claim stops before PATCH and keeps the claim
consumed, as with `PREWRITE`. A benchmark-pending fee publication and one
without a verified Jenny section are refused until those cases are reviewed.

Serialization. The protected `ratio` job and the `promote` job, the only
Actions jobs that write the ratio snapshot or the fee pair on main, share one
job-level group:
- `fee-publication-critical`, `cancel-in-progress: false`, `queue: max`;
- a FIFO queue of up to 100 by wait start, never a replaced pending job.

A promotion therefore cannot land between `FEE_RECHECK` and the PATCH, and a
ratio cannot run while a promotion job is selecting or fast-forwarding.

Neither job waits on anything while holding the group: there are no polling
loops and no waits on another workflow. The outer `fee-cloud-producer` and
`promote-fee-data` groups are acquired before the job starts, so there is no
lock cycle.

The outer groups are left unchanged on purpose. The period gate refuses any run
in its window that lists no jobs (`fee-report-producer.mjs`
`readPeriodSourceAttempts`), and a queued outer run may list none. So a ratio
dispatch pending behind a producer run can still be replaced, visibly as
cancelled, by a newer producer run.

Not covered by this group:
- Pages deployment after the push: the `PAGES_*` checks refuse until it serves
  the bytes.
- Any browser or manual Gist write (fund, ledger, recipient, snapshot) and any
  manual push to main.
- The order in which queued jobs were dispatched: FIFO is by wait start, and a
  full queue still cancels.

Coordination therefore remains required:
1. Dispatch the ratio only after promotion and the fee Pages readback.
2. Use the current main as `ratio_main` and the exact fee handoff.
3. Confirm the ratio run actually started; a queued promotion may also move
   main first, which the `MAIN_HEAD` check then refuses before credentials.
4. Make no browser Gist writes during the window.

The consuming executor materializes only the approved private Library inputs
through Library's supported flow, then uploads the exact two projections using
the owner's existing authorized official Cloud Storage session. Verify complete
byte digests and object generations before dispatch. Do not use public GitHub
artifacts/links or new uploader credentials. The cloud runner cannot upload inputs
and has no assumed Library credentials. Original projection associations retain
the official workbook provenance. This transport does not create new evidence or
authorize future uploads.

The existing source/model/proof/crypto code recomputes associations and validates
real dates, freshness, recipient and previous body. Complete bytes are hash- and
generation-pinned. Identical source is a no-op. A generation-zero claim binds
previous body plus both source digests; changing run/main/generation/Library
version cannot reset it. Unknown claim outcome stops without retry. Claims
contain no financial payload or credentials and are never deleted by this job.

Only `fee-console-ratio-snapshot.json` can be PATCHed, at most once. An atomic,
fsynced safe intent precedes PATCH. Fresh revision/recipient/snapshot bytes must
match immediately before writing. Gist has no atomic cross-writer compare-and-swap:
retain the single-writer rule, including the browser. A failed/unknown PATCH gets
one authenticated exact readback, never a resend. Save the safe result before print.

Requests go only to fixed GitHub API, validated immutable raw-file URLs and the
one Storage bucket. No redirects or credentials sent to the raw host. Responses
are size-bounded with a 60-second limit; the job has a 10-minute cap. Plaintext is
only in short-lived memory, not artifacts. JavaScript strings cannot be guaranteed
erased; no debug/dump mode is enabled. Only the closed safe receipt is retained
for seven days. An owned claim permits deletion of exactly the two pinned input
generations. Unknown/unowned claims cannot delete another run's inputs. Cleanup
failure remains explicit; lifecycle is fallback. Cancellation/platform failure
can delay cleanup, so do not claim exact deletion in those cases.

Fee report, health, Jenny, recipient, fund and economic ledger are not written.
For release, pause producer/promotion, prove the original Nov3 opportunity is
unconsumed, rebind that SAME opportunity to final main and restore exact waiting.
Never add an opportunity, reset a claim or enable the retired benchmark.

Synthetic tests cover the actual runtime plus original publisher: full authentication,
truncated reads, pinning, create-only claim, single write/readback/cleanup, secret
canaries, final CLI rejection, receipt failures and unchanged fee budget counting.
Real cloud acceptance remains pending owner secret entry and protected release.
