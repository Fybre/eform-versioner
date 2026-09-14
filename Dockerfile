FROM node:20-bookworm-slim

# System Chromium instead of Puppeteer's own bundled download: Puppeteer's "Chrome for
# Testing" download has no linux-arm64 build (x64 only), so it can't run on an arm64 host
# (e.g. Apple Silicon) without x86 emulation. The apt package is built for whatever
# architecture the image actually is, so this works on amd64 and arm64 alike.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium ca-certificates fonts-liberation wget \
    && rm -rf /var/lib/apt/lists/*

# Puppeteer must not try to download its own Chrome — point it at the apt-installed one.
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public

RUN groupadd --gid 1001 eformv \
    && useradd --uid 1001 --gid eformv --home-dir /app --shell /usr/sbin/nologin eformv \
    && mkdir -p /app/data \
    && chown -R eformv:eformv /app

USER eformv

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -q -O- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "src/server.js"]
