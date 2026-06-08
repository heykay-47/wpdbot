FROM node:20-slim AS build

ENV PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY tests ./tests

RUN npm test
RUN npm run build

FROM node:20-slim AS runtime

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    SQLITE_PATH=/data/bot.db \
    DOWNLOAD_DIR=/tmp/wpdbot-downloads

WORKDIR /app

RUN groupadd --system --gid 10001 wpdbot \
    && useradd --system --uid 10001 --gid wpdbot --home-dir /app --shell /usr/sbin/nologin wpdbot \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
      chromium \
      ffmpeg \
      python3 \
      python3-pip \
      python3-venv \
      ca-certificates \
      fonts-liberation \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir yt-dlp \
    && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app /data /tmp/wpdbot-downloads /app/.wwebjs_auth /app/.wwebjs_cache \
    && chown -R wpdbot:wpdbot /app /data /tmp/wpdbot-downloads

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

RUN chown -R wpdbot:wpdbot /app

USER wpdbot

CMD ["npm", "start"]
