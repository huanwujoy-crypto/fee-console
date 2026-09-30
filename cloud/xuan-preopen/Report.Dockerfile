FROM node:24-bookworm-slim
WORKDIR /app
COPY scripts/ scripts/
COPY .github/workflows/validate-xuan-ib-handover.yml .github/workflows/validate-xuan-ib-handover.yml
COPY .github/workflows/promote-xuan-ib-handover.yml .github/workflows/promote-xuan-ib-handover.yml
COPY claude/xuan-ib-portfolio-registry.json claude/xuan-ib-portfolio-registry.json
COPY cloud/xuan-preopen/ cloud/xuan-preopen/
USER node
RUN node --test cloud/xuan-preopen/*.test.mjs scripts/xuan-ib-night-action*.test.mjs
# Explicit source date must be supplied for private acceptance. No schedule yet.
ENTRYPOINT ["node", "cloud/xuan-preopen/report.mjs", "--report-check", "--source-date"]
