# Fixed local fresh maintenance bundle

`maintenance/ib-orders-fresh-execution-v1/` contains the actual native code for a
separately approved local maintenance operation. It is not a deployment, cloud
entry point, authorization to contact IBKR, or permission to read credentials.
No schedule is activated by this change. Import, no arguments and `--plan` are
offline; their windows remain null and live approval is false.

## Private binding and unchanged allowance

The public `binding.mjs` commits to one exact owner-only private JSON file by
SHA256, checked independently by JavaScript and the renewal child. Its bytes
contain a newly allocated offline control identity and planned runtime/claim
location for this package, the same 15
historical safe-record hashes and three directory listings, local approval and
executable locations, resource identities and external dependency pins. These
values and the generated execution manifest stay outside Git. No historical
ledger, private manifest, OAuth token, nonce, account response or credential is
included in this bundle or its test fixtures.

The previous binding and its approval/window are retired for this new operation.
Their files remain unchanged historical evidence. Old approval flags, human
proofs, maintenance statements and execution hashes do not transfer to this
package. The new identity does not increase the remaining registration allowance.
Unused earlier renewal-artifact dependency hashes are retained in a local
provenance sidecar, outside the active binding and outside Git. The binding does
not contain its own public source hashes or future signed head/tree: those are
added to the later manifest, so the two fixed digest literals cannot form a
binding/source hash cycle.

A caller cannot select different binding contents through CLI, environment or
approval JSON: the loader verifies the raw bytes before branding and freezing
the object, and factories reject unbranded data. Supplying a different location
for the identical private file changes neither its contents nor the durable
runtime. The allowance is code policy: old remaining registrations **0**, prior
possible registrations **2**, future additional maximum **1**, cumulative
possible maximum **3**. The second request is never executable. Fresh code only
admits `initial-orders`; refresh, rotation, deployment, IAM, schedule changes,
new Google login/grants/scopes and automatic retry/resume remain disabled.

Only the strict public `freshCli(args)` entry can acquire native capabilities.
Its execution factory, approval and claim WeakSets, native filesystem, RPC,
cached SDK process bridge, renewal, listener and browser implementations are
lexical privates. The native guard requires both complete native proof validation
and read-back of the exclusive durable claim. No caller-supplied guard or IO
parameter can replace that admission, and no public factory returns those
capabilities. The public operator factory
contains only the pure state machine, validators and bridge source data;
bootstrap and parser dependencies likewise acquire no default native transport.
The pure offline manifest builder returns data only.

The binding commitment is not consent. A later, explicit, independently approved
execution manifest must cover the precise final signed head, complete diff,
private binding commitment, runtime source hashes, real time window, maintenance
proofs and trusted human evidence. An agent-created JSON assertion does not
supply that human approval. No previously discussed time window is activated.

## Signed source and local execution

The approved execution uses the public bundle files themselves. The private
binding points at this bundle inside the complete checkout; it does not point
at an old executable. Before native effects, the entry verifies a clean checkout,
its head and tree, regular tracked `100644` runtime files and equality between
every runtime file's disk bytes and its Git blob. It then compares that identity
and the nine file hashes against the separately approved manifest. The earlier
cloud source head/tree/image remain provenance and require live metadata
admission; they are not the new local execution head.

The native sequence retains the exclusive durable fresh claim before Google
renewal or IB activity, read-back and repeated source/claim verification,
registration audit persistence, a cached-credential-only SDK writer, absolute
window checks at each effect boundary, cancellation and the original bounded
10-minute callback admission plus 40-second finalization behavior. Unknown
outcomes consume their reservation and stop. The renewal child also reserves
one durable launch before SDK access; it cannot be restarted after an uncertain
outcome. None of those records is deleted on failure.

The control bridge is embedded in the public operator source. `renew.py` extracts
only that same public source, verifies it against the claim's approved hash,
and runs the existing-session-only renewal logic from this bundle. The public
bootstrap source contains the SDK writer logic. The SDK itself and pinned native
executables remain external dependencies. Historical renewal driver/bridge
locations in the private binding are checked as read-only provenance; they are
never imported or executed. Native Mac paths already present in trusted source
remain explicit local dependencies, not portable cloud entry points.

When independently authorized later, the native argument shape is:

```text
node maintenance/ib-orders-fresh-execution-v1/xuan-ib-orders-fresh.mjs \
  --execute --binding <owner-only-private-binding> \
  --approval <fixed-private-approval-path> --approval-sha256 <approved-raw-sha256>
```

This command is documentation only; preparation and CI never invoke it.

## Strict read-only package verification

The separate command below performs the native local package checks without
authorizing execution:

```text
node maintenance/ib-orders-fresh-execution-v1/xuan-ib-orders-fresh.mjs \
  --verify-package --binding <private-package>/private-binding.json \
  --manifest <private-package>/execution-manifest.NOT-APPROVED.json \
  --manifest-sha256 <manifest-raw-sha256>
```

It accepts exactly these seven arguments. The manifest must have the fixed
basename above in the binding file's owner-only directory, and its exact bytes
must match the supplied hash. Its entire structure must equal the public offline
manifest built from the actual Git head/tree and nine runtime hashes: approval
flags stay false and the window, human evidence and maintenance proof hashes
stay null. Normal existing-Google renewal selection remains the offline default
zero. There is no normalization that can erase an unauthorized field or flag.

The mode shares the actual runtime-file/stat/Git/blob, external ordinary-file
pins, Node version/executable and historical 15-file/three-directory checks with
execution. It also verifies the two binding digest literals, exact local source
location and absence of the new approval and runtime directories; only `ENOENT`
establishes absence. Its private IO object contains only read, Git identity and
directory-listing methods and is never admitted as native execution IO. It does
not call the human-proof verifier, mint approval or claim brands, reserve a
claim, renew a session, open native adapters, contact a service or create a
listener/browser. Default, import and `--plan` still perform no IO.

A successful result reports public source identity/hashes and safe check counts.
It observes Git identity rather than certifying a commit signature, protected
checks or an OWNER decision; those remain separate exact-head evidence. Native
Git reads disable optional locks and filesystem-monitor helpers.
It explicitly leaves human proof, claim and live metadata admission unverified.
It does not prove Google credential validity, cloud maintenance or permissions,
costs, provider consent, financial results or any approved execution window.
After remote signing, the manifest must be rebuilt for that exact signed head
and the real read-only command run again at the same fixed checkout location.

## Relationship to the frozen local R2 package

The original 21-file R2 directory and its evidence are unchanged. It is a local
historical artifact, not a second execution entry for the new signed candidate.
The new code has these explicit source mappings:

| Frozen R2 source | Public bundle treatment |
| --- | --- |
| `xuan-ib-orders-fresh.mjs` | Actual strict entry, durable claim and private native adapters/RPC/cached SDK/listener/browser/renewal closure, committed binding and signed-checkout validation |
| `xuan-ib-orders-live-operator.mjs` | Pure actual fresh engine, control bridge source data and validators; no native capability acquisition or adapter exports |
| `renew.py` | Actual renewal policy; executes the same public bridge, validates private claim/binding and reserves one child launch |
| `source/scripts/xuan-ib-oauth-registration-audit.mjs` | Actual profile/audit logic; fresh persistence now requires the branded binding and rejects the old continuation schema |
| `source/scripts/xuan-ib-cloud-oauth-bootstrap.mjs` | Actual pure bootstrap, deadlines, callback, audit and SDK writer; native listener/browser moved to the private entry and unused legacy entry/process bridges removed |
| `source/cloud/xuan-preopen/cloud_io.mjs`, `source/scripts/xuan-ib-decision-menu.mjs` | Retained pure version validators and strict JSON parser; unused default network, filesystem and menu CLI capabilities removed |
| `source/cloud/xuan-preopen/ib_diagnostics.mjs` | Copied byte-for-byte as a pure dependency inside this isolated namespace |
| Original `AGENTS.md`, supplemental files, historical manifest and all original test files | Kept local; not copied into the public execution closure |

The final signed head identifies the new runtime files, not the old 21 hashes.
The private review record can map every original file hash to its retained, adapted
or local-only destination without publishing historical bindings. Every new
tracked file is registered individually as sensitive; the 22 ordinary files,
production source files and workflows are unchanged.

## CI scope

The existing `node --test cloud/xuan-preopen/*.test.mjs` workflow glob discovers
`fresh_execution.test.mjs`. Its synthetic VM harness evaluates the actual bundle
logic with a synthetic committed binding and rejects native dynamic imports,
credential/SDK access and financial networking. It uses standard Node VM scripts,
without `--experimental-vm-modules` or a workflow change. The VM adapts the
binding commitment and ES-module loading syntax and exposes explicit private observations only inside
that synthetic context; product export assertions remain separate. Function
bodies are unchanged by the harness; no production test mode, real
ledger fixture or configurable live-binding bypass is added. Fake clocks,
filesystems and HTTP transports exercise behavior and rejection cases, rather
than comparing hashes alone. The suite has 94 top-level tests, including one
Python group with 25 executed cases, for 119 reported passing tests. That group
starts a real local `python3 -I -c` test subprocess and executes the actual
renewal functions, embedded control bridge and SDK submit implementation against
fake transports with SDK/network imports forbidden. It never starts the native
execution command, credential store, SDK, browser or financial service.

The old R2 results of 931 Node tests, 91 Python tests and 66 independent checks
are historical Mac-only evidence. They are not claimed to run under Linux CI or
to validate these refactored bytes. The new synthetic suite and existing
repository suites must pass independently for this candidate. The complete
native permissions preflight, native OAuth, SDK credentials, actual network
services, financial data and the real once runtime are not exercised by this
synthetic suite; execution still needs separate explicit approval and live
admission.

`fresh_git_identity.test.mjs`, discovered by the same workflow glob, separately
executes the actual private `codeIdentity()` method body against real temporary
Git repositories containing the nine public runtime files. Its test-only loader
allows read-only Git commands and reads inside the synthetic repository; it
does not expose a product export or call the execution entry. The regression
covers the bundle subdirectory, root and other caller working directories,
tracked file modes, clean-tree checks and every runtime file's committed bytes.
It also retains the original failure: without `ls-tree --full-tree`, a
repository-root pathspec from the bundle directory returns no row. Git blob
paths use root-relative tree names; `--full-tree` makes both pathspec and output
independent of the Git command's bundle-directory cwd. This local Git coverage
does not read the private binding, credentials or real operation records, and
does not invoke the SDK, network, browser, listener, claim or live entry.

`fresh_package.test.mjs` additionally starts the actual read-only CLI in real
synthetic temporary repositories. Its fixed test bindings and both digest
literals are generated only inside those fixtures; no configurable production
pin or native test mode is added. The fixture uses nine public runtime files,
ordinary synthetic external pins and synthetic historical records, and tests
the full manifest, path and identity rejection boundaries. This is separate from
the real local package's read-only verification; neither invokes `--execute`.
