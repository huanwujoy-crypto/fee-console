# Private economic-source acquisition

`scripts/fee-economic-source.mjs` supplies one freshly read encrypted source to
the existing fee calculation chain. It never decrypts, calculates fees, changes
the source, requests credentials, or schedules a run. Acquisition success is not
financial verification, publication, or phone acceptance.

## Configuration and fixed boundary

- Configure the migrated, exact Gist ID through `FEE_ECON_GIST_ID`; keep the
  new 32-byte decryption key separately in the local Keychain, or in the
  reviewed `fee-cloud-producer` GitHub Environment described by
  `docs/fee-cloud-producer.md`. A secret Gist is
  readable by exact ID, so the Codex daily reader needs **no GitHub PAT**.
  The manager's Gist write token stays only in the manager app. Do not put the
  ID or key in prompts, command arguments, the repository, unreviewed Actions or logs.
- Requests are GETs to fixed `api.github.com/gists/{id}` only. The helper freezes
  the exact locator for acquisition and `checkCurrent()`. It never borrows
  `GITHUB_TOKEN`, `GH_TOKEN`, `gh`, OAuth, cookies or the manager write token;
  no redirects, alternate endpoints, new permissions or network-policy bypass.
  A legacy dedicated fine-grained read PAT is accepted only when explicitly
  supplied; malformed values fail before the request, and an authenticated
  failure never falls back to anonymous access.
- Require returned ID, owner `huanwujoy-crypto`, `public:false`, complete
  `fee-console-db.json`, explicit non-truncation, matching size and encrypted
  v3/v4 envelope. Other files are ignored; duplicates in envelope keys fail.
- Two consecutive reads must have identical revision, ETag and exact source
  bytes. An old last-modified date is acceptable when freshly read unchanged;
  a previous attachment, local file date or cached hash is not freshness proof.
- Each double-read phase has at most four requests / 40 seconds. Retry only a
  network error or timeout once per read; reject every non-200 response, including
  403 and 304. Body/file limits are 2 MiB / 1 MiB; no truncated-content fallback.

## Required run lifecycle

Read this document and the receipt/copy runbooks before each scheduled, Run now,
manual or recovery fee run. Import `fetchEconomicSnapshot` from the reviewed
helper on that run's trusted main. Importing alone does not access the network.

1. Call `fetchEconomicSnapshot()` before the writer. A successful snapshot exposes
   `sourcePath`, `envelopeVersion`, `checkCurrent()` and `cleanup()`. Keep the path
   in the private runtime, not ordinary task output.
2. A native v4 snapshot supplies `FEE_ECON_FILE` directly, including after an
   explicitly reviewed, read-back-verified Gist migration. The archived v3
   backup is not an active economic source. For a still-active original v3, apply only the
   approved `fee-console.legacy-empty-expense.v1` copy policy, then supply the new
   encrypted v4 copy as `FEE_ECON_FILE` and the unchanged original snapshot as
   `FEE_ECON_V3_FILE`. Both stay in new repository-external 0700/0600 temp storage.
3. Use the existing authenticated strict converter, normal writer, independent
   reporter and same-input no-op checks. Never substitute an independent fee
   formula or silently change economic inputs to pass validation.
4. Immediately before the existing protected publication, await
   `snapshot.checkCurrent()`. It performs two **new** remote reads, requires them
   to match the frozen original version/ETag/bytes, and rechecks local ciphertext.
   A changed or unavailable source stops publication; the old snapshot is not
   overwritten or treated as current.
5. Always use `finally` to call `snapshot.cleanup()` and remove the separately
   created computation copy using its existing safe cleanup procedure, including
   on failure. The helper cleans only its own original-source snapshot.

If acquisition/configuration fails, stop **before invoking the writer**. Do not
drop `FEE_ECON_FILE` and continue as a way to finish the run. An existing legacy-v2
receipt and the published `data.json` must remain byte-identical on this missing-
source path; the writer enforces this backstop too. State that the current run
failed/source is unavailable, not that the previous receipt became a new result.
The phone's independent fresh-source gate remains unchanged and may hide fees.

On failure print only `sourceFailureCode(error)`, a fixed allowlisted code. Never
print raw exceptions, credentials, source IDs/URLs, snapshot objects, headers,
revisions, hashes or ciphertext. Respect native execution approvals and network
refusals. If an optional legacy read PAT is explicitly configured, it remains
in memory only and is never a snapshot field or file.

## Acceptance boundary

Synthetic tests are `scripts/fee-economic-source.test.mjs`; every request is
mocked. A manually uploaded copy can establish a bounded private capability test,
but cannot establish durable integration. A fresh Codex run must obtain
the reviewed helper and exact private locator/key configuration without a
prior manual attachment, then satisfy the same source/calculation/publication gates. Retain
the actual schedule and next-run/read-back distinction; do not claim permanent
success from a one-off manual session or from repository deployment alone.
