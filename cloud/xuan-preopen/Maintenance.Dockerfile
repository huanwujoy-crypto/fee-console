FROM node:24-bookworm-slim@sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd
WORKDIR /app
COPY scripts/ scripts/
COPY .github/workflows/validate-xuan-ib-handover.yml .github/workflows/validate-xuan-ib-handover.yml
COPY .github/workflows/promote-xuan-ib-handover.yml .github/workflows/promote-xuan-ib-handover.yml
COPY .github/workflows/xuan-preopen-image-maintenance.yml .github/workflows/xuan-preopen-image-maintenance.yml
COPY .github/workflows/xuan-preopen-image-build.yml .github/workflows/xuan-preopen-image-build.yml
COPY .github/workflows/xuan-preopen-image-deploy.yml .github/workflows/xuan-preopen-image-deploy.yml
COPY claude/xuan-ib-portfolio-registry.json claude/xuan-ib-portfolio-registry.json
COPY security/xuan-preopen-maintenance-iam.json security/xuan-preopen-maintenance-iam.json
COPY cloud/xuan-preopen/ cloud/xuan-preopen/
USER node
# Phone integrations remain in repository CI. The real Git archive regression
# runs in the full builder checkout before identity; neither runs in this image.
RUN --network=none node --test --test-skip-pattern='^phone |^isolated trusted archive loads the action guard and rejects a missing pure codec dependency$' cloud/xuan-preopen/*.test.mjs scripts/xuan-ib-night-action*.test.mjs scripts/xuan-ib-eod-holdings.test.mjs
ENTRYPOINT ["node", "cloud/xuan-preopen/daily.mjs"]
CMD []
