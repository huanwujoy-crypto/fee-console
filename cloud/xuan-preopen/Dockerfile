FROM node:24-bookworm-slim
WORKDIR /app
COPY scripts/ scripts/
COPY cloud/xuan-preopen/ cloud/xuan-preopen/
USER node
CMD ["node", "cloud/xuan-preopen/probe.mjs", "--source-check"]
