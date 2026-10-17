# Fixed local fresh maintenance bundle

`maintenance/ib-orders-fresh-execution-v1/` contains the actual native code for a
separately approved local maintenance operation. It is not a deployment, cloud
entry point, authorization to contact IBKR, or permission to read credentials.
No schedule is activated by this change. Import, no arguments and `--plan` are
offline; their windows remain null and live approval is false.

## Private binding and unchanged allowance

The public `binding.mjs` commits to one exact owner-only private JSON file by
SHA256. Its bytes contain the previously allocated operation, authorization and
request identities, the existing unspent runtime and claim path, the same 15
historical safe-record hashes and three directory listings, local approval and
executable locations, resource identities and external dependency pins. These
values and the generated execution manifest stay outside Git. No historical
ledger, private manifest, OAuth token, nonce, account response or credential is
included in this bundle or its test fixtures.

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
native Git/permissions preflight, native OAuth, SDK credentials, actual network
services, financial data and the real once runtime are not exercised by this
synthetic suite; execution still needs separate explicit approval and live
admission.
