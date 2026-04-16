# syntax=docker/dockerfile:1.6
ARG NODE_VERSION=20

# ---------- builder: install all deps + compile TS ----------
# Skip chromium download here (builder never runs the browser).
FROM node:${NODE_VERSION}-slim AS builder
ENV PUPPETEER_SKIP_DOWNLOAD=true
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- runtime: prod deps + puppeteer-managed Chromium ----------
FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production \
    TZ=UTC \
    PUPPETEER_CACHE_DIR=/home/bot/.cache/puppeteer

# Minimal shared libs Chromium needs (no `chromium` pkg — it's a snap shim on 24.04).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      tzdata \
      dumb-init \
      fonts-liberation \
      fonts-noto-color-emoji \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libatspi2.0-0 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libexpat1 \
      libgbm1 \
      libglib2.0-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libx11-6 \
      libxcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      wget \
      xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# non-root user first so puppeteer caches under its HOME
RUN groupadd -r bot && useradd -r -m -g bot -G audio,video bot

WORKDIR /app
RUN chown bot:bot /app
USER bot

COPY --chown=bot:bot package.json package-lock.json ./
# Let puppeteer (bundled by whatsapp-web.js) download its matched Chromium
# into /home/bot/.cache/puppeteer during install.
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=bot:bot --from=builder /app/dist ./dist

RUN mkdir -p /app/.wwebjs_auth /app/.wwebjs_cache /app/data

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "--enable-source-maps", "dist/index.js"]
