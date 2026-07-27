# syntax=docker/dockerfile:1.7
ARG XINGHENG_REVISION
FROM node:22-bookworm-slim AS build
ARG XINGHENG_REVISION
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN test "${#XINGHENG_REVISION}" -eq 40 \
  && ! printf '%s' "$XINGHENG_REVISION" | grep -Eq '[^0-9a-f]' \
  && printf '%s\n' "$XINGHENG_REVISION" > /app/.build-revision \
  && chmod 0444 /app/.build-revision
RUN npm run build

FROM node:22-bookworm-slim AS api
ARG XINGHENG_REVISION
LABEL org.opencontainers.image.revision="$XINGHENG_REVISION"
RUN groupadd --gid 20001 xingheng \
  && useradd --uid 20001 --gid 20001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin xingheng
ENV NODE_ENV=production \
    API_PORT=8787 \
    TRADING_DB_PATH=/app/data/trading.sqlite \
    RWA_AUTOMATION_DATA_DIR=/app/rwa-automation-data \
    RWA_AUTOMATION_BACKUP_DIR=/app/rwa-automation-backups \
    STRATEGY_FORWARD_REPORT_PATH=/app/strategy-data/route-b-forward.json \
    STRATEGY_HISTORY_REPORT_PATH=/app/strategy-data/route-b-history.json \
    MARTINGALE_GRID_PAPER_REPORT_PATH=/app/strategy-data/martingale-grid-paper.json
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends sqlite3 unzip util-linux \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/.build-revision /app/.build-revision
COPY --from=build /app/dist-server ./dist-server
COPY scripts ./scripts
COPY scripts/verify-runtime-revision.sh /usr/local/bin/verify-runtime-revision
COPY deploy/rwa-automation-current.json /app/rwa-automation-current.json
COPY deploy/rwa-automation-current.json /app/rwa-automation-data/current.json
RUN mkdir -p /app/data /app/strategy-data /app/rwa-automation-data/generation-initial \
    /app/rwa-automation-backups /app/rwa-automation-lock /backups \
  && chmod 0555 /usr/local/bin/verify-runtime-revision \
  && chmod 0444 /app/rwa-automation-current.json \
  && chmod 0700 /app/rwa-automation-data /app/rwa-automation-data/generation-initial \
    /app/rwa-automation-backups /app/rwa-automation-lock \
  && chmod 0600 /app/rwa-automation-data/current.json \
  && chown -R 20001:20001 /app/data /app/strategy-data /app/rwa-automation-data \
    /app/rwa-automation-backups /app/rwa-automation-lock /backups \
  && touch /app/rwa-automation-lock/operation.lock \
  && chown 20001:20001 /app/rwa-automation-lock/operation.lock \
  && chmod 0600 /app/rwa-automation-lock/operation.lock \
  && chown 0:0 /app/rwa-automation-lock \
  && chmod 0555 /app/rwa-automation-lock
USER 20001:20001
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/verify-runtime-revision"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/api/health').then(r=>{if(!r.ok)throw Error(r.status)}).catch(()=>process.exit(1))"]
CMD ["node", "dist-server/index.js"]

FROM build AS strategy-tools
ARG XINGHENG_REVISION
LABEL org.opencontainers.image.revision="$XINGHENG_REVISION"
RUN groupadd --gid 20001 xingheng \
  && useradd --uid 20001 --gid 20001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin xingheng
ENV NODE_ENV=production \
    STRATEGY_HISTORY_REPORT_PATH=/app/strategy-data/route-b-history.json \
    STRATEGY_FORWARD_REPORT_PATH=/app/strategy-data/route-b-forward.json \
    MARTINGALE_GRID_PAPER_REPORT_PATH=/app/strategy-data/martingale-grid-paper.json
RUN apt-get update \
  && apt-get install -y --no-install-recommends unzip \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /app/strategy-data /app/.cache/strategy \
  && chown -R 20001:20001 /app/strategy-data /app/.cache
COPY scripts/verify-runtime-revision.sh /usr/local/bin/verify-runtime-revision
RUN chmod 0555 /usr/local/bin/verify-runtime-revision
USER 20001:20001
ENTRYPOINT ["/usr/local/bin/verify-runtime-revision"]
CMD ["npm", "run", "research:ict:history"]

FROM caddy:2.10-alpine AS web
ARG XINGHENG_REVISION
LABEL org.opencontainers.image.revision="$XINGHENG_REVISION"
COPY --from=build /app/.build-revision /app/.build-revision
COPY scripts/verify-runtime-revision.sh /usr/local/bin/verify-runtime-revision
COPY scripts/verify-real-test-web-health.sh /usr/local/bin/verify-real-test-web-health
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY deploy/Caddyfile.real-test /etc/caddy/Caddyfile.real-test
COPY deploy/Caddyfile.real-test-standalone /etc/caddy/Caddyfile.real-test-standalone
COPY --from=build /app/dist /srv
RUN chmod 0555 /usr/local/bin/verify-runtime-revision \
  /usr/local/bin/verify-real-test-web-health
ENTRYPOINT ["/usr/local/bin/verify-runtime-revision"]
