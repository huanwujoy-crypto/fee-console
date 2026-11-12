# Linux Library identity reader: isolated candidate only

`readLinuxLibraryIdentity(file)` returns null by default without source-file,
dependency or subprocess access. Only `{enabled:true}` opts in; there is no
environment activation. The API accepts no identity, verifier, runtime,
interpreter or command. The module has no executable CLI.

Enabled reads return only `{libraryFileId,version}` (version is canonical decimal
text). Failures expose only `RATIO_LINUX_LIBRARY_IDENTITY_REFUSED`. This is file
identity association, not a provider signature, browser observation, accepted
process proof, source-origin verification or publication approval.

The fixed /usr/bin/python3 dependency resolves only to a system Python 3 binary.
The reader checks consistent non-caller system ownership, nonwritable system
directories/binary, write access and before/after metadata. Managed filesystems
may map system ownership to UID 65534; that UID is not treated as proof of root
ownership or package provenance. This assumes the managed system installation
is trusted. The child uses -I -S -B, a fixed minimal environment, bounded private
pipes and a two-second deadline. Parent preload/environment hooks are refused;
unrelated inherited variables are not passed to the child.

Source paths must be canonical, owned regular 0600 files with one hardlink in an
owned private 0700 parent. Symlinks, git ancestors, missing/unsupported attributes
and access failures refuse. Only xattrs/metadata are read, using O_NOFOLLOW and
descriptor-based getxattr. The helper repeats both xattrs and checks descriptor,
path and parent stability; the Node boundary rechecks file and dependency
metadata. No file contents or xattrs are written, and no permission is repaired.

This adds no supported formal workspace location. The existing evidence guard
also validates its workspace and all relevant private parent paths. In this
executor only /workspace and /tmp are the declared writable roots; both have
observed .git markers. That establishes a blocker for formal evidence workspaces
under those roots, not an absence of legal directories elsewhere on the machine.
This task does not locate, create or configure another private evidence workspace.

The existing browser-evidence reader, source collector, snapshot, registry and
CI are unchanged. Later coordination would need to review default-runtime
selection in browserEvidenceRuntime, register the three new sensitive paths,
add the test suite to CI, and validate actual materializer xattr behavior in an
approved private runtime. None of that makes Library metadata provider-origin
authentication; the separate source-observation trust contract remains open.

```sh
node --test scripts/fee-ratio-linux-library-identity.test.mjs
```

Positive tests use closed synthetic filesystem/process substitutes. The exact
embedded Python code also runs with a synthetic OS module: it never opens a
real source file or installs Library xattrs. Tests do not establish genuine
Library identity, source authorization, cloud compatibility or readiness.
