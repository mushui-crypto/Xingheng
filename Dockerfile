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
    STRATEGY_FORWARD_REPORT_PATH=/app/strategy-data/route-b-forward.json \
    STRATEGY_HISTORY_REPORT_PATH=/app/strategy-data/route-b-history.json \
    MARTINGALE_GRID_PAPER_REPORT_PATH=/app/strategy-data/martingale-grid-paper.json
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends sqlite3 \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist-server ./dist-server
COPY scripts ./scripts
RUN mkdir -p /app/data /app/strategy-data /backups \
  && chown -R node:node /app/data /app/strategy-data /backups
USER node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/api/health').then(r=>{if(!r.ok)throw Error(r.status)}).catch(()=>process.exit(1))"]
CMD ["node", "dist-server/index.js"]

FROM build AS strategy-tools
ARG GIT_COMMIT=development
LABEL org.opencontainers.image.revision="$GIT_COMMIT"
RUN mkdir -p /app/strategy-data /app/.cache/strategy \
  && chown -R node:node /app/strategy-data /app/.cache
USER node
CMD ["npm", "run", "research:ict:history"]

FROM caddy:2.10-alpine AS web
ARG GIT_COMMIT=development
LABEL org.opencontainers.image.revision="$GIT_COMMIT"
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
