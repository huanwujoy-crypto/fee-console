FROM node:24-bookworm-slim
WORKDIR /app
COPY scripts/ scripts/
COPY claude/xuan-ib-portfolio-registry.json claude/xuan-ib-portfolio-registry.json
COPY cloud/xuan-preopen/ cloud/xuan-preopen/
USER node
RUN node --test cloud/xuan-preopen/orders_probe.test.mjs cloud/xuan-preopen/ib_mcp.test.mjs cloud/xuan-preopen/ib_diagnostics.test.mjs
ENTRYPOINT ["node", "cloud/xuan-preopen/orders_probe.mjs"]
