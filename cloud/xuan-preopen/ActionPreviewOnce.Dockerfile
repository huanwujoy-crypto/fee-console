FROM node:24-bookworm-slim@sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd
WORKDIR /app
COPY scripts/ scripts/
COPY claude/xuan-ib-portfolio-registry.json claude/xuan-ib-portfolio-registry.json
COPY cloud/xuan-preopen/ cloud/xuan-preopen/
USER node
RUN --network=none node --test cloud/xuan-preopen/action_preview_once.test.mjs cloud/xuan-preopen/action_preview.test.mjs cloud/xuan-preopen/orders_probe.test.mjs cloud/xuan-preopen/ib_mcp.test.mjs cloud/xuan-preopen/ib_diagnostics.test.mjs
ENTRYPOINT ["node", "cloud/xuan-preopen/action_preview_once.mjs"]
