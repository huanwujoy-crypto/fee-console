FROM node:24-bookworm-slim
WORKDIR /app
COPY cloud/xuan-preopen/trigger.mjs cloud/xuan-preopen/trigger.mjs
COPY cloud/xuan-preopen/calendar.mjs cloud/xuan-preopen/calendar.mjs
COPY cloud/xuan-preopen/cloud_io.mjs cloud/xuan-preopen/cloud_io.mjs
USER node
ENTRYPOINT ["node", "cloud/xuan-preopen/trigger.mjs"]
