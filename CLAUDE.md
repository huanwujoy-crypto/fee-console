# XUAN-IB handover publication contract

Any complete XUAN-IB handover produced from this repository—scheduled, Run now,
manual, recovery, or ad hoc—must enter the same trusted publication path.

1. Create a branch named `claude/<descriptive-name>-<six-lowercase-alphanumeric>`.
2. Base it on `main` or a current ancestor of `main`.
3. Create exactly one non-merge commit that changes only `xuan-ib/index.html`.
4. Use the commit subject `handover YYYY-MM-DD`, matching the page data date.
5. Preserve the self-contained page marker and pass
   `node scripts/handover-guard.mjs xuan-ib/index.html YYYY-MM-DD`.
6. Push the candidate branch and report its branch, SHA, and guard result.
7. Do not claim that the phone page is updated until trusted promotion and Pages
   deployment have completed. Never edit `xuan-ib/latest.html` or
   `xuan-ib/latest.meta.json` directly.

The trusted promotion workflow anchors each published source commit under the
immutable `xuan-ib-published/` tag namespace. Do not create, move, or delete
those tags from a handover-producing session.

Financial systems are read-only for this workflow. Never place, modify, or cancel
orders, and never initiate transfers or write to IB, Sharesight, or another
financial account.
