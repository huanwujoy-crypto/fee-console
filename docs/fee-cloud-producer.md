# Fee-console cloud producer

This is the Mac-independent producer for the simulated fund. It does not use
Claude, browser sessions, iPhone Mirroring, macOS Keychain, or a manager Gist
write token.

## Runtime boundary

The scheduled workflow runs from trusted `main` in the protected
`fee-cloud-producer` GitHub Environment. Repository variable `FEE_CLOUD_MODE`
is the release switch:

- unset or `disabled`: the job is skipped before secrets are exposed;
- `shadow`: complete double-read, calculation and validation, then delete all
  runtime files without creating a branch;
- `publish`: do the same work, create a fresh branch at the rechecked `main`,
  then append one GitHub-signed owner candidate commit.

The existing no-secret candidate validator and `trusted-promotion` workflow
remain the only path to `main`. Start with at least two completed-session shadow
runs that match the local producer before changing the variable to `publish`.
Keep the local heartbeat active until one real cloud candidate has been
validated, promoted and read back from Pages; then pause it to avoid two
producers.

## Cloud identity and environment secrets

The workflow does not keep a Google service-account key or a Sharesight client
credential in GitHub. GitHub OIDC is exchanged for the dedicated
`fee-cloud-producer@family-portfolio-gateway.iam.gserviceaccount.com` identity.
The Workload Identity provider accepts only this repository ID, owner ID,
trusted workflow path, `main` ref and the `schedule` / `workflow_dispatch`
events. That identity has Secret Manager accessor on exactly two version-pinned
resources:

- `sharesight-broker-sync-client-id:1`
- `sharesight-broker-sync-client-secret:1`

The pair is the second cloud Sharesight application already isolated from the
Mac Direct API credential. The workflow reads it only after OIDC authentication
and passes it to the fixed GET-only adapter for the duration of one job.

The protected GitHub Environment therefore contains only these three values:

| Secret | Purpose |
| --- | --- |
| `FEE_DATA_KEY` | Existing 32-byte fee-console encryption key |
| `FEE_ECON_GIST_ID` | Exact secret economic-ledger Gist locator |
| `FEE_CLOUD_GITHUB_TOKEN` | Owner fine-grained token restricted to this repository and Contents write; used only in publish mode |

Do not store a manager Gist token, browser link, access token, refresh token,
Mac credential export, or general-purpose `gh` token. The Sharesight client uses
`client_credentials` to obtain a short-lived token in memory. Its HTTP adapter
allows only one authentication POST and fixed GET routes for Schwab-HK and
Webull. It has no mutation route.

## Daily behavior

The benchmark cache remains independent. It retries through 17:35 HKT; this
producer runs at 12:50, 13:50, 15:50 and 17:50 HKT Tuesday through Saturday. A run proceeds
only when SPY and QQQ have one complete common session with validated dividend
fields. Missing benchmark data remains pending rather than publishing an
earlier price as the target session.

For the selected session, the reader resolves and pins both live portfolio
identities, then reads performance, holdings, cash accounts, target-day cash
transactions and trades twice. The normalized reads must be byte-equivalent.
Cash accounts form `cash`, SGOV forms `other`, and remaining USD holdings form
`stock`; the three buckets must reconcile to the two portfolio totals. Style
classification continues through the existing static and encrypted learned
registry. Cash transactions linked to a trade remain internal. The fixed Webull
writer's exact account-bound principal-cash identity and its explicit `NOT
external funding` description are also retained as `internal_trade`; similar
free text or a generic deposit/withdrawal does not pass that rule. A remaining
bare deposit or withdrawal becomes unresolved unless the existing private
ledger already contains its reviewed classification.

The normal writer, fee receipt validator, amount-free health receipt, private
source recheck, signed candidate validation, protected promotion and Pages
deployment are unchanged. Workflow summaries contain only dates, outcome and
hashes; no amounts or credentials.

## One-time activation

1. Create the protected environment with the three GitHub secrets above. Create
   the repository- and workflow-bound Google Workload Identity provider and
   grant its dedicated service account accessor only on the two version-pinned
   Sharesight Secret Manager resources. Do not copy their values into GitHub.
2. Set `FEE_CLOUD_MODE=shadow` and dispatch the workflow twice on completed US
   sessions. Compare dates, encrypted output hash and investor share results
   with the local producer.
3. Set `FEE_CLOUD_MODE=publish`, dispatch once, and wait for candidate validation,
   protected promotion, Pages deployment and public/mobile read-back.
4. Pause the local Codex heartbeat only after the cloud result is proven.

Removing the variable or setting it to `disabled` is the immediate rollback.
It does not revoke credentials or alter the published ledger.
