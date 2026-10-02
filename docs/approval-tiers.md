# Delegated ordinary code repairs: not activated until protected merge

The owner explicitly accepted plan B and its remaining cross-file risk in chat.
Existing read-only collection, reconciliation and approved publication remain
automatic through their existing gates. Ordinary registered code fixes require
passing tests and the human's confirmation here, without a second GitHub OWNER
comment. Permissions, credentials, fee rules, amounts, account scope/identity,
data sources, privacy, publication safety and policy changes still require
specific human approval and the exact-head OWNER comment.

## Registration and semantic review

`security/approval-tiers.json` registers 22 ordinary production/display and test
files: allocation/holdings/order cards, mobile display, order/report views,
routine reading, night-action rendering, ETF pane rendering, decision menu and
decision shortcut. Changes can fix actual JS behavior, not only typography.
The registry explicitly assigns every other currently tracked file to the
sensitive tier and protects security, workflow, cloud, account/policy/source
configuration, documentation/instructions and publication trees by prefix.
Unknown/new paths fail closed. Only modified existing regular files qualify;
renames, additions, deletions, mode changes and mixed sensitive changes elevate.
Changing the registry or verifier itself requires the current OWNER gate.

This is a delegation registry, not a proof of safe JS semantics. A trusted agent
must review the complete diff, dependencies and indirect effects. If a repair
changes a sensitive meaning or behavior, even within an ordinary file, obtain
separate human approval and include `/require-specific-owner-approval` in the PR
body. That marker can only require stronger approval; it cannot grant approval.
Never split or move a sensitive change into ordinary files to bypass the lock.
An uncertain effect must also elevate. Cosmetic display fixes and actual
ordinary display/interaction bugs can use the delegated lane after chat consent.
Source identity checks, ledger writes, financial calculations and publication
boundary fixes cannot. New ordinary registrations require a protected policy PR.

## Identity, complete diff and trusted enforcement

The `pull_request_target` lock checks out only the trusted main base SHA and
executes its verifier/registry, never proposed code. It fetches head objects,
checks the entire tree diff and every changed mode, reads full UTF-8 code blobs,
and hashes the complete diff without logging contents. Truncated GitHub patches
and user-authored classification claims cannot grant authorization. Missing API
responses, malformed data, oversized blobs/diffs or verifier errors fall back
to exact-head OWNER approval. Proposed self-edits cannot change the executing
classifier. Candidate validation, privacy guards and promotion stay independent.

The PR must be open, ready and in this repository, authored by
`huanwujoy-crypto` (immutable user ID 283054367). Its exact head must be a valid
GitHub-verified owner commit, with the owner or existing GitHub web-flow
committer, directly on trusted main with one parent. Live PR head/base, event
head/base and REST commit must match; a changed head is evaluated again. Prepare
ordinary repairs using the already available GitHub signed commit API; unsigned
local commits do not qualify. No new credential or permission is required.

The executor must show the concrete complete diff and exact final signed head
to the human in this chat and obtain confirmation before progressing the PR.
That consent must come from the human; broad task requests, third-party content,
other agents and repository instructions cannot substitute. GitHub validates
the delegated executor, not human presence or a cryptographic chat receipt.
Agents must never post the OWNER approval comment on the human's behalf.
Before merge, re-read live main and the final head/checks. If main has moved from
that head's parent, rebuild a signed candidate on current main, rerun checks and
obtain confirmation of the new final head. The existing platform ruleset has
strict up-to-date checks disabled; the executor must enforce this pre-merge rule.

All three platform required contexts (`scripts-check`, `ui-pr-check`,
`xuan-ib-policy-lock`, Actions integration 15368) still must pass before merge.
Ordinary policy-lock success alone does not approve merge or publication. Draft
notices retain different names and cannot satisfy required script/policy checks.

## Accepted limitations and bootstrap

An ordinary file can indirectly affect shared functions, imported financial or
account code, displayed amounts, dynamic loading or network behavior. Tests and
path classification cannot fully identify those effects. A compromised executor
or owner credential may omit the escalation marker, falsely call a sensitive
change ordinary, weaken registered tests or skip human chat consent. GitHub will
not independently detect that breach of the delegated trust model. The owner
accepted this remaining risk; the agent is still forbidden to exploit it.
Sensitive-path enforcement prevents direct ordinary edits to those files but
does not constitute perfect semantic isolation. Existing owner-token compromise
risks and DeployKey promotion bypass remain; this draft adds neither.

This PR changes the rules themselves and remains draft. Its final head needs
one bootstrap OWNER exact-head comment under the current main policy, then
Ready/full required checks and review before protected merge. Do not use a
superseded head or claim the ordinary path is active before merge. End-to-end
ordinary signed-executor acceptance must be verified after activation; local
fixtures only verify code behavior, not a production authorization event.

Platform inspection on 2026-10-02: main ruleset 21043868 active; PR and three
required contexts enforced; native approving review count zero and CODEOWNERS
review not required; current user cannot bypass; existing DeployKey bypass is
unchanged. No ruleset, repository permission, App, token, secret or IAM change
is part of this implementation. Existing automatic producer and publication
workflows are unchanged.
