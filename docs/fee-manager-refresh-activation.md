# Manager refresh: activation patch drafts (NOT applied)

Status: drafts only. Nothing here changes the page, the origin allowlist or
any deployment. Apply only after the acceptance run in
`docs/fee-manager-refresh.md` has passed and the owner approved each PR at
its exact head. `<INTAKE_ORIGIN>` is the exact `https://…run.app` origin of
the **production** intake service, known only after deployment; never the
acceptance service.

## 1. Security-policy PR (separate PR, only this file)

`security/allowed-origins.txt` — append one line:

```diff
 https://api.github.com
 https://gist.githubusercontent.com
 https://github.com
+<INTAKE_ORIGIN>
```

Checks before approval: the origin is exactly the production intake
service (`fee-refresh-intake-<hash>-<region>.a.run.app`), not the acceptance
service, has no path, and appears nowhere else.

## 2. Index-only PR (after 1 is on main)

`index.html` — one constant changes inside the reviewed client block:

```diff
-const MR_INTAKE_ORIGIN=null;
+const MR_INTAKE_ORIGIN="<INTAKE_ORIGIN>";
```

The same PR must bump the build (`fee-console-build` and `UI_VERSION_LABEL`)
and is preceded by the usual support-stage registration of the new page
hash in the shared UI test pins (`scripts/fixtures/fee-ratio-aggregate-returns-ui.json`,
`scripts/fee-ratio-aggregate-ui-fixture.mjs`, `scripts/fee-receipt-ui-contract.test.mjs`,
`scripts/ui-flows.test.mjs`, `scripts/fee-gift-registry-status.test.mjs`,
`scripts/ib-manager-return.test.mjs`) — coordinated with the ratio work so
the two directions never re-pin the page concurrently.

Effect: managers can submit. Ratio stays disabled (`MR_RATIO_READY=false`).
Ordinary users are unaffected.

## 3. Rollback

Revert the index-only PR (sets `MR_INTAKE_ORIGIN` back to `null`; the page
stops sending), then set the production service and job to
`FEE_REFRESH_MODE=disabled`. Never delete ledger, queue or status objects:
they hold the per-date success limits and the request history.

## Not covered here

The production `FEE_REFRESH_MODE=launch` switch is a separate owner
approval for a named first date, after this activation.
