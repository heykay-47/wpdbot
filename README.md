# wpdbot

WhatsApp media relay bot for groups. It watches enabled WhatsApp groups for supported social video links, downloads media with `yt-dlp`, reposts video, and skips duplicate links inside configured window.

## Requirements

- Docker with Compose v2.
- WhatsApp account available for QR login.
- Group where bot account can be made admin before enabling relay.
- `.env` configured from `.env.example`.

## Setup

1. Create local env file:

   ```sh
   cp .env.example .env
   ```

2. Edit `.env` and set owner WhatsApp ID:

   ```env
   BOT_OWNER_ID=919999999999@c.us
   SQLITE_PATH=/data/bot.db
   TIMEZONE=Asia/Kolkata
   MAX_FILE_SIZE_MB=64
   DUPLICATE_WINDOW_HOURS=24
   DOWNLOAD_DIR=/tmp/wpdbot-downloads
   ```

3. Build image:

   ```sh
   docker compose build
   ```

4. Start bot:

   ```sh
   docker compose up -d
   ```

5. Watch logs and scan WhatsApp QR code on first run:

   ```sh
   docker compose logs -f
   ```

6. Add bot WhatsApp account to target group and make it group admin.

7. In group chat, send `!bot enable` from group admin or configured owner account.

8. Send supported YouTube, Instagram, or Facebook link in enabled group to test relay.

## Local Development

Docker is recommended because it includes Chromium and `yt-dlp` dependencies. For local WSL runs with `npm run dev`, install browser/runtime dependencies first:

```sh
sudo apt-get update
sudo apt-get install -y libnspr4 libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2t64 libxss1 libxshmfence1 libxrandr2 libxcomposite1 libxcursor1 libxdamage1 libxi6 libxtst6 fonts-liberation xdg-utils ffmpeg python3 python3-pip
pip3 install --break-system-packages yt-dlp
```

Then use local paths in `.env`:

```env
SQLITE_PATH=./data/bot.db
DOWNLOAD_DIR=./downloads
```

Run locally:

```sh
npm install
npm run dev
```

Node 20 is the supported runtime. Newer Node versions may work but are not the target runtime.

## Commands

Bot commands:

- `!bot enable` enables relay for current group. Bot must be group admin.
- `!bot disable` disables relay for current group.
- `!bot status` shows current group settings and bot admin status.

Docker commands:

- `docker compose up -d` starts bot in background.
- `docker compose logs -f` tails QR/login/runtime logs.
- `docker compose restart` restarts bot.
- `docker compose down` stops bot without deleting persisted data.
- `docker compose build --no-cache` rebuilds image from scratch.

## Persistent Data

Compose mounts these Docker volumes into container:

- `wpdbot-auth` stores WhatsApp session auth at `/app/.wwebjs_auth`.
- `wpdbot-cache` stores WhatsApp Web cache at `/app/.wwebjs_cache`.
- `wpdbot-data` stores SQLite database at `/data/bot.db`.
- `wpdbot-downloads` stores temporary downloaded media at `/tmp/wpdbot-downloads`.

Do not commit `.env`, WhatsApp auth/cache, database files, or downloads. The container runs as a non-root user, and image-created mount points are owned by that user.

## Safety

- Use dedicated WhatsApp account if possible. Automation can violate platform terms or trigger account restrictions.
- Enable bot only in groups where members consent to reposting media.
- Original link message is deleted only after successful repost. Failed downloads or uploads keep original message in chat.
- Keep `MAX_FILE_SIZE_MB` reasonable to avoid disk and bandwidth spikes.
- Keep `downloads` and `data` on storage with enough free space.
- Protect `.env` and `.wwebjs_auth`; anyone with them may control bot session.

## Manual Smoke Test

- Create a private WhatsApp test group.
- Add bot account and make it group admin.
- Start the container and scan QR.
- Restart the container; confirm session persists without a new QR scan.
- Send `!bot status`; confirm bot admin shows `yes`.
- Send `!bot enable`; confirm enabled response.
- Send one YouTube link; confirm repost, caption, and original deletion.
- Send one Instagram link; confirm repost, caption, and original deletion.
- Send one Facebook link; confirm repost, caption, and original deletion.
- Send the same link again within 24 hours; confirm duplicate skip.
- Send `!bot disable`; confirm future links are ignored.

## Final Verification

- `npm test`: passed, 8 files, 71 tests.
- `npm run build`: passed.
- `docker compose build`: not run; `docker` command unavailable in WSL.
