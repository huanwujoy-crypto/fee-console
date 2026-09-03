# Private economic-source acquisition

`scripts/fee-economic-source.mjs` supplies one freshly read encrypted source to
the existing fee calculation chain. It never decrypts, calculates fees, changes
the source, requests credentials, or schedules a run. Acquisition success is not
financial verification, publication, or phone acceptance.

## Configuration and fixed boundary

- Configure only the exact already-authorized original locator through
  `FEE_ECON_GIST_ID` and the separately approved **dedicated, 30-day fine-grained
  PAT** through `FEE_ECON_GITHUB_TOKEN` in the authorized private fee Routine
  environment. The PAT must have **no added permissions**, especially no Gists
  write permission. GitHub documents that [Get a gist with a fine-grained token
  requires no permissions](https://docs.github.com/en/rest/gists/gists#get-a-gist).
  The owner must verify the credential's scope and expiry when configuring it;
  successful acquisition is not proof of either. Do not put either value in
  prompts, command arguments, the repository, Actions, setup scripts, logs or
  output. Environment values are available to sessions/editors sharing that
  environment; this is not a dedicated secret vault or a guarantee of single-
  Routine isolation. Do not widen environment access to provision the PAT.
- Requests are authenticated GETs to fixed `api.github.com/gists/{id}` only,
  with `Authorization: Bearer` from that dedicated environment variable. The
  helper freezes the exact locator and PAT for acquisition and `checkCurrent()`.
  No `GITHUB_TOKEN`, `GH_TOKEN`, `gh`, OAuth, cookie, keychain or anonymous fallback;
  no redirects, alternate endpoints, new permissions or network-policy bypass.
  The existing decryption key stays in its authorized private environment and
  is used only by the existing downstream tools.
- Missing or malformed PAT configuration fails with `SOURCE_AUTH_CONFIG` before
  any request or snapshot write. Syntax must be `github_pat_` followed by 20–255
  ASCII letters, digits or underscores, with no trimming. This bounded local
  check rejects obvious bad/header-unsafe values; it does not validate a token,
  scope, owner or expiry. A 401 fails with `SOURCE_AUTH`, a 403 with
  `SOURCE_FORBIDDEN`; neither retries anonymously or with another credential.
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
2. A native v4 snapshot supplies `FEE_ECON_FILE`. For original v3, apply only the
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
revisions, hashes or ciphertext. The PAT is used in memory for the fixed request
header and is never a snapshot field or file; cleanup releases its closure
reference, not the owner's environment configuration. Respect native execution
approvals and network refusals. Expiry/revocation requires authorized credential
renewal, never removal of authentication or broader permissions.

## Acceptance boundary

Synthetic tests are `scripts/fee-economic-source.test.mjs`; every request is
mocked. A manually uploaded copy can establish a bounded private capability test,
but cannot establish durable integration. A fresh original Routine must obtain
the reviewed helper and dedicated private locator/PAT configuration without a
prior manual attachment, then satisfy the same source/calculation/publication gates. Retain
the actual schedule and next-run/read-back distinction; do not claim permanent
success from a one-off manual session or from repository deployment alone.
