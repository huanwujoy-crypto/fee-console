FROM node:24-bookworm-slim@sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd
WORKDIR /app
COPY scripts/ scripts/
COPY .github/workflows/validate-xuan-ib-handover.yml .github/workflows/validate-xuan-ib-handover.yml
COPY .github/workflows/promote-xuan-ib-handover.yml .github/workflows/promote-xuan-ib-handover.yml
COPY .github/workflows/xuan-preopen-image-maintenance.yml .github/workflows/xuan-preopen-image-maintenance.yml
COPY .github/workflows/xuan-preopen-image-build.yml .github/workflows/xuan-preopen-image-build.yml
COPY .github/workflows/xuan-preopen-image-deploy.yml .github/workflows/xuan-preopen-image-deploy.yml
COPY claude/xuan-ib-portfolio-registry.json claude/xuan-ib-portfolio-registry.json
COPY claude/xuan-ib-account-association-v1.json claude/xuan-ib-account-association-v1.json
COPY security/xuan-preopen-maintenance-iam.json security/xuan-preopen-maintenance-iam.json
COPY security/xuan-preopen-eod-source-iam.proposed.json security/xuan-preopen-eod-source-iam.proposed.json
COPY docs/xuan-preopen-eod-association-renewal.patch docs/xuan-preopen-eod-association-renewal.patch
COPY cloud/xuan-preopen/ cloud/xuan-preopen/
USER node
# The two phone integration tests require a historical page that is not a runtime input.
# They remain mandatory in the full repository suite; every other cloud/guard test runs here.
RUN --network=none node --test --test-skip-pattern='^phone ' cloud/xuan-preopen/*.test.mjs scripts/xuan-ib-night-action*.test.mjs
ENTRYPOINT ["node", "cloud/xuan-preopen/daily.mjs"]
CMD []
