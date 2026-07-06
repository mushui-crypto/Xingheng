# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS api
ENV NODE_ENV=production \
    API_PORT=8787 \
    TRADING_DB_PATH=/app/data/trading.sqlite
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends sqlite3 \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist-server ./dist-server
COPY scripts ./scripts
RUN mkdir -p /app/data /backups && chown -R node:node /app/data /backups
USER node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/api/health').then(r=>{if(!r.ok)throw Error(r.status)}).catch(()=>process.exit(1))"]
CMD ["node", "dist-server/index.js"]

FROM caddy:2.10-alpine AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
