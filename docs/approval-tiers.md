# Approval tiers: inactive integration plan

The owner requested these tiers in the Codex conversation on 2026-10-02:

- Existing read-only collection, reconciliation and publication may continue
  automatically through their already approved source and publication gates.
- Ordinary code fixes should require passing tests and the owner's confirmation
  in chat, without another GitHub comment.
- Permission, credential, fee calculation/rule and account-scope changes require
  explicit confirmation of the concrete change separately. Approval-policy
  changes are included in this tier.

This request authorizes preparing this policy draft. It does not authenticate a
future PR head. No conversation approval verifier is configured or exposed in
the available Codex/GitHub interfaces. GitHub-verified commits identify a commit
signer, not whether the human personally approved its content. Agents can invoke
the same authenticated GitHub connector; its comments cannot serve as human chat
approval. Do not post an OWNER approval on the user's behalf.

## What this draft implements

`scripts/approval-tier-plan.mjs` is a conservative, offline advisory classifier.
Only a narrow list of display-code paths is suggested for ordinary review;
unknown paths, renamed sensitive paths and mixed changes need specific review.
Path matching cannot prove that a diff preserves permission, privacy, account or
fee semantics. A human must review the complete diff even for the ordinary tier.
The classifier produces no approval and is not consumed by the enforcing lock.
Missing or forged `approved` properties cannot unlock anything.

The policy lock additionally protects this plan, its tests, `security/`, AGENTS
and this document. Existing exact-head OWNER approval, source identity, private
data guards, required tests and promotion checks remain enforced. Draft notices
remain distinct from required contexts.

## Activation prerequisites and minimal fallback

A real chat receipt would need a platform-issued verifiable human identity,
repository, PR, full head SHA, approval tier and concrete scope, timestamp,
expiry and replay/revocation protection. A verifier must run from trusted main,
fail closed on unknown issuers/keys, and reject agent text, third-party content,
self-signed receipts and approvals invalidated by new commits. No issuer, key,
token, GitHub App or persistent permission is introduced here. Such integration
requires a separate proposal and approval when a supported issuer exists.

Until then, the minimum feasible reduction is to complete tests and freeze the
head before presenting one exact OWNER command and the PR link. One GitHub human
action remains necessary for locked ordinary fixes. A native GitHub human review
could eventually replace the comment, but it is still outside chat and would
need its own exact-head verifier; do not claim it fulfills chat-only approval.

This security-policy draft itself needs a one-time bootstrap OWNER comment:
`/approve-xuan-ib-maintenance <final full head SHA>`, followed by Ready for review
and all required checks. Every new commit invalidates that approval. No merge,
ruleset mutation, required-check removal or publication activation is authorized
by this document. Present the concrete draft and remaining limitation to the
parent conversation before activation.

## Platform evidence (read-only, 2026-10-02)

Main ruleset 21043868 is active, requires a PR plus `scripts-check`, `ui-pr-check`
and `xuan-ib-policy-lock` from GitHub Actions integration 15368. Native approving
review count is zero and CODEOWNERS review is not required. The current user
cannot bypass; an existing DeployKey bypass remains for controlled promotion.
Legacy branch protection returns 404; this does not negate the active ruleset.
The ruleset and repository permissions are unchanged by this draft.
