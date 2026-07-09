# ── build stage: compile TypeScript ────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── runtime stage ──────────────────────────────────────────────────
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public

# SQLite lives on a volume so caught webhooks survive container restarts
ENV DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8090
RUN mkdir /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8090/api/status > /dev/null || exit 1

CMD ["node", "dist/server.js"]
