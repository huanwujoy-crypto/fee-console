FROM node:24-bookworm-slim
WORKDIR /app
COPY scripts/ scripts/
COPY .github/workflows/validate-xuan-ib-handover.yml .github/workflows/validate-xuan-ib-handover.yml
COPY .github/workflows/promote-xuan-ib-handover.yml .github/workflows/promote-xuan-ib-handover.yml
COPY .github/workflows/xuan-preopen-cloud-producer.yml .github/workflows/xuan-preopen-cloud-producer.yml
COPY claude/xuan-ib-portfolio-registry.json claude/xuan-ib-portfolio-registry.json
COPY claude/xuan-ib-preopen-report-profile-v1.json claude/xuan-ib-preopen-report-profile-v1.json
COPY cloud/xuan-preopen/ cloud/xuan-preopen/
USER node
# Run every cloud/source/publication contract without historical financial pages.
# Only the two phone-page tests run separately in the required full repository suite.
RUN node --test --test-skip-pattern='^phone ' cloud/xuan-preopen/*.test.mjs scripts/xuan-ib-night-action*.test.mjs
ENTRYPOINT ["node", "cloud/xuan-preopen/report.mjs", "--report-check", "--source-date"]
