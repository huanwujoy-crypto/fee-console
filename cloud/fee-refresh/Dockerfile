# Manager refresh intake/job image. Build context: the repository root at the
# exact reviewed commit. Only the entry point and its import closure are
# copied (checked by scripts/fee-manager-refresh-deploy.test.mjs); no credential,
# data file or other source enters the image. Dockerfile.dockerignore limits
# the build context to the same files. Runs as a numeric non-root user.
#
# Base: official Docker Hub library/node, multi-arch index digest read from
# registry-1.docker.io on 2026-11-11T06:00Z and re-hashed locally;
# linux/amd64 manifest sha256:aaa4b5baf1ecff3b283486bb1f90405cdda225a3e6f79660d2c559fa510a7292.
# Node 22.23.4 is the runtime the synthetic tests ran on.
FROM node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
WORKDIR /app
COPY scripts/fee-data-health.mjs scripts/fee-engine.mjs scripts/fee-income-date-policy.mjs scripts/fee-legacy-policy.mjs scripts/fee-management-exemption.mjs scripts/fee-manager-refresh-entry.mjs scripts/fee-manager-refresh-server.mjs scripts/fee-manager-refresh.mjs scripts/fee-receipt-core.mjs /app/scripts/
USER 10001:10001
ENV NODE_ENV=production FEE_REFRESH_MODE=disabled
EXPOSE 8080
ENTRYPOINT ["node", "/app/scripts/fee-manager-refresh-entry.mjs"]
CMD ["serve"]
