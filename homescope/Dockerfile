FROM ghcr.io/home-assistant/base:3.21 AS builder

ARG BUILD_VERSION
ARG BUILD_ARCH
LABEL \
    io.hass.version="${BUILD_VERSION}" \
    io.hass.type="app" \
    io.hass.arch="${BUILD_ARCH}" \
    org.opencontainers.image.title="Home Assistant Add-on: HomeScope" \
    org.opencontainers.image.description="Interactive time-series visualization for InfluxDB data" \
    org.opencontainers.image.licenses="MIT"

RUN apk add --no-cache \
    nodejs \
    npm

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY backend ./backend
COPY frontend ./frontend
COPY tsconfig*.json ./
COPY vite.config.ts ./

RUN npm run build && npm prune --omit=dev

FROM ghcr.io/home-assistant/base:3.21

ARG BUILD_VERSION
ARG BUILD_ARCH
LABEL \
    io.hass.version="${BUILD_VERSION}" \
    io.hass.type="app" \
    io.hass.arch="${BUILD_ARCH}" \
    org.opencontainers.image.title="Home Assistant Add-on: HomeScope" \
    org.opencontainers.image.description="Interactive time-series visualization for InfluxDB data" \
    org.opencontainers.image.licenses="MIT"

RUN apk add --no-cache \
    nodejs

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/frontend/src/fixtures ./frontend/src/fixtures

COPY run.sh /run.sh
RUN chmod +x /run.sh

CMD ["/run.sh"]
