# Fixed-URL encrypted action report

This change prepares code only. Merge, use of a real fee key, publication of an
encrypted real report, and persistent credential provisioning are separate
authorizations. No schedule is added. The fee UI, writer and `data.json` remain
unchanged. Tests use conspicuously synthetic keys, reports and receipts only.

## Viewing

`/fee-console/xuan-ib/` defaults to the encrypted viewer. It reads only the fixed
same-origin `action.enc.json` with no cookies, redirects, or cache reuse. The
existing public loader is retained at `?view=public`, explicitly labelled old
public records. Missing ciphertext, wrong keys, corruption or network failure
never fall back to that old report as a current result.

On an already unlocked browser Profile the viewer uses the existing
`feeConsole.key` entry. Otherwise the user enters only the key in a password
input; remembering it is unchecked by default. Saving, if selected and only
after successful decryption, updates that shared fee unlock entry (and therefore
affects the fee page too). The viewer never reads the fee GitHub token, Gist ID,
ledger cache or cookies. It does not accept a manager URL or a URL key parameter.
Locking this viewer disables its automatic unlock without deleting fee settings.
Plaintext is kept only in memory and discarded on pagehide; new devices,
cleared storage or a different Profile must unlock again.

The daily view auto-loads as before, showing one compact report-date/non-live
line. Older report dates explicitly say historical reference. Refresh and lock
are in collapsed Settings; history remains an explicit `?view=public` route and
conversion requires `?prepare=local`, with no daily-view links to either tool.
After authenticating and hash-checking the original plaintext, the viewer moves
the recognized book-report introduction and source paragraphs into a numbered,
closed disclosure. Unrecognized markup stays unchanged. This is a presentation
copy, not a new source report: all original dates, limitations and card values
remain, and ciphertext, the validated source hash, key storage, financial
calculations and publication policy do not change. No re-encryption is needed.
The original order warning concerns net-budget evidence, not a requirement for
sell orders to exist. A user's dated statement about no sell orders is not
silently converted into API completeness or carried forward as a live fact.

Both applications use the same origin; different paths or storage names are
not a security boundary. Same-origin script compromise can read the stored
master. Anyone holding that master can decrypt both reports. HKDF purpose
separation does not repair either risk. Browser key storage is not encrypted
hardware custody, and no such guarantee is made.

## Envelope and conversion

The preferred first-copy route is `/fee-console/xuan-ib/?prepare=local`, on the
same origin as the existing fee unlock page. It mounts only the local converter:
no automatic report fetch or key lookup occurs. The user selects the pinned
published HTML and its receipt, then personally clicks the conversion button.
Untrusted/programmatic click events are ignored. This is an interaction guard,
not isolation from other same-origin scripts. Only after the click are the two
bounded local files read and `feeConsole.key` looked up. There is no key input,
Secret/Keychain route, upload, credential write or background conversion.

The converter binds original bytes to the receipt, encrypts and decrypts its
own result for a local check, then offers only `action.enc.json` for download.
The download is an in-memory ciphertext Blob, revoked on replacement/pagehide.
Original HTML, receipt and master remain on the user's device. No action is
sent to the backend, and the download is explicitly not a publication. Missing
local unlock state directs the user to the existing fee page, not a new login.
The codec and receipt binding are shared by the browser and optional CLI.

`xuan-ib/action.enc.json` is pre-registered in sensitiveFiles without creating
that file or a placeholder envelope. Its first real ciphertext is a separate
exact-head OWNER-reviewed change. No public plaintext or financial receipt is
included in the code PR. This browser route must be protected-merged/deployed
before it can use the original site's storage; it cannot run from a downloaded
file or another origin and silently access that storage.

HKDF-SHA-256 derives a non-extractable AES-256-GCM key using a fresh 32-byte public
salt and the versioned `fee-console/xuan-ib/published-action/aes-256-gcm/v1`
context. Each envelope has a fresh 12-byte IV and authenticated schema. Neither
master nor subkey is included in the envelope. Dates, original generation,
source hash and complete HTML are inside the ciphertext; the public wrapper
contains only protocol identifiers, salt, IV and ciphertext.

The input is the already published static display, not its raw source model.
`packagePublishedAction` binds every byte to a fixed-version readback receipt,
preserves original report date/publication time and never recalculates anything.
It checks receipt consistency, not the authority of a user-supplied receipt:
the authorized operator still has to verify that the selected local receipt and
HTML are the previously confirmed production version. No new source read or
private latest CAS is needed to convert that already published version.

The CLI accepts only absolute input/receipt/output file paths; input files must
be owner-only regular files, not symlinks. Output is exclusive-create, ciphertext
only, owner-only, and never uploaded by the CLI. The key may be supplied solely
as `FEE_DATA_KEY` to the approved process; no key arguments, credential discovery,
Keychain calls, Secret retrieval, manager token, login or refresh are implemented.
No environment value is logged. Maximum source HTML is 2 MiB and envelope 3 MiB.

Proposed post-approval command shape (do not run during preparation):

```sh
node scripts/xuan-ib-encrypted-action-build.mjs \
  --input /private/pinned-display.html \
  --receipt /private/publication-completed.safe.json \
  --output /private/action.enc.json
```

The decrypted report is placed in an iframe with an empty sandbox, no origin or
script permissions, and a deny-all network CSP before its original content.
The codec also rejects active HTML. No raw HTML is inserted into the parent
document. In-session regression to an older generation/publication time, or
different bytes for the same generation, fails closed. This does not claim
server-proof freshness across devices or authenticity against a person holding
the shared master; source timestamps remain visible, with no live-data claim.

## One bundled activation approval

1. Freeze the signed code head, run required checks, obtain exact-head OWNER
   maintenance approval and normal protected merge. This is a privacy/credential
   purpose change, not the ordinary repair lane.
2. The user personally performs one local conversion using the browser's
   existing shared unlock entry after the source HTML/receipt have been
   downloaded and hash-verified under the separate authorization. This route
   needs neither the Node CLI nor a worker credential provider. This code does
   not grant the action job access to the `fee-cloud-producer` Environment.
   No key copying, new Secret, IAM change, persistent worker credential access
   or new daily task is included. The optional CLI remains inactive without a
   separately approved controlled provider; never export a key to make it run.
3. Approve conversion of one pinned, already-published private report and one
   protected publication of ciphertext at `xuan-ib/action.enc.json`, with public
   byte readback and local decryption verification. This new public artifact
   requires its own publication approval; old private CAS budgets are consumed.
   Keep source date/time and limitations unchanged. Do not put plaintext,
   original receipts, key values or financial metadata in public PR descriptions.

Public ciphertext is downloadable by anyone; decryption is controlled by key
possession, not the seven IAM principals. The original private bucket and its
readers do not change. Removing IAM access does not revoke downloaded copies or
a shared key. Daily production remains a separate unfinished integration.
