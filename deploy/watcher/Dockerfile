# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22.23.4-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
COPY tests ./tests
COPY scripts ./scripts
ARG BUILD_REVISION
ENV BUILD_REVISION=${BUILD_REVISION}
RUN npm run check && npm run build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production DEPLOYMENT_DATA_ROOT=/app/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir -p /app/data /app/backups && chown node:node /app/data /app/backups
COPY --from=build /app/dist/src ./dist/src
COPY --from=build /app/dist/build-info.json ./dist/build-info.json
USER node
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 CMD ["node","--experimental-sqlite","--env-file-if-exists=/run/secrets/watcher.env","dist/src/cli.js","deploy:health"]
ENTRYPOINT ["node","--experimental-sqlite","--env-file-if-exists=/run/secrets/watcher.env","dist/src/cli.js"]
CMD ["deploy:run"]
