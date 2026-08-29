# XUAN-IB maintenance approval v1

This procedure keeps the XUAN-IB publication boundary fail closed without
temporarily changing the repository ruleset.

## Normal changes

Ordinary pull requests must not change the protected XUAN-IB publication
boundary. The `xuan-ib-policy-lock` required check remains the single lock for
that boundary. The separate `ui-pr-check` validates general UI safety and does
not duplicate the publication lock.

## Intentional maintenance

1. Create the maintenance pull request as a draft.
2. Read its exact 40-character head commit SHA.
3. Add a pull-request comment from the repository owner containing exactly:

   `/approve-xuan-ib-maintenance <head-sha>`

4. Mark the pull request ready for review. The required policy check reads the
   comment from the trusted base workflow and accepts only an `OWNER` comment
   whose SHA is identical to the current pull-request head.
5. Run and review all other required checks before merge.

Every new commit changes the head SHA and therefore invalidates the approval.
The pull request must receive a new exact-SHA owner comment before it can pass.
No branch-protection rule, required check, workflow, or environment needs to be
disabled for future maintenance.

