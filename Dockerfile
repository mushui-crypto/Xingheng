# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS build
ARG GIT_COMMIT=development
ENV GIT_COMMIT=$GIT_COMMIT
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS api
ARG GIT_COMMIT=development
LABEL org.opencontainers.image.revision="$GIT_COMMIT"
ENV NODE_ENV=production \
    API_PORT=8787 \
    GIT_COMMIT=$GIT_COMMIT \
    TRADING_DB_PATH=/app/data/trading.sqlite \
    BINANCE_TRADING_DB_PATH=/app/data/binance-personal.sqlite \
    BINANCE_USER_ORDER_DB_DIR=/app/data/binance-users \
    STRATEGY_FORWARD_REPORT_PATH=/app/strategy-data/route-b-forward.json \
    STRATEGY_HISTORY_REPORT_PATH=/app/strategy-data/route-b-history.json \
    MARTINGALE_GRID_PAPER_REPORT_PATH=/app/strategy-data/martingale-grid-paper.json
WORKDIR /app
RUN groupadd --system --gid 20001 xingheng \
  && useradd --system --uid 20001 --gid 20001 --home-dir /app --shell /usr/sbin/nologin xingheng
RUN apt-get update \
  && apt-get install -y --no-install-recommends sqlite3 \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist-server ./dist-server
COPY scripts ./scripts
RUN mkdir -p /app/data /app/strategy-data /backups \
  && chown -R 20001:20001 /app/data /app/strategy-data /backups
USER 20001:20001
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/api/health').then(r=>{if(!r.ok)throw Error(r.status)}).catch(()=>process.exit(1))"]
CMD ["sh", "-c", "umask 077; exec node dist-server/index.js"]

FROM build AS strategy-tools
ARG GIT_COMMIT=development
LABEL org.opencontainers.image.revision="$GIT_COMMIT"
RUN groupadd --system --gid 20001 xingheng \
  && useradd --system --uid 20001 --gid 20001 --home-dir /app --shell /usr/sbin/nologin xingheng
RUN mkdir -p /app/strategy-data /app/.cache/strategy \
  && chown -R 20001:20001 /app/strategy-data /app/.cache
USER 20001:20001
CMD ["npm", "run", "research:ict:history"]

FROM caddy:2.10-alpine AS web
ARG GIT_COMMIT=development
LABEL org.opencontainers.image.revision="$GIT_COMMIT"
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
