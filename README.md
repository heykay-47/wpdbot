# wpdbot

WhatsApp group media relay bot for personal use. It watches enabled WhatsApp groups for Instagram reels/posts and YouTube Shorts, downloads the media with `yt-dlp`, reposts the video in the same group with attribution, and skips duplicate links inside a configurable time window.

## Features

- Relays Instagram reels/posts and YouTube Shorts in WhatsApp groups.
- Uses `whatsapp-web.js` with QR login and persisted WhatsApp Web session data.
- Downloads media with `yt-dlp` and uses `ffmpeg` for WhatsApp-compatible retry transcodes.
- Deletes the original link message only after the repost succeeds.
- Skips duplicate URLs per group within a configurable window.
- Supports per-group enable/disable/status commands.
- Runs as a Docker Compose service with persisted auth, cache, database, and download volumes.

## Important Notes

- This project uses unofficial WhatsApp Web automation. WhatsApp Web changes can break it, and automated behavior may violate platform terms or trigger account restrictions.
- Use a dedicated WhatsApp account if possible.
- Enable the bot only in groups where members consent to media reposting.
- Downloading or reposting media may be subject to the source platform's terms and copyright rules.
- Some YouTube or Instagram links may fail when the upstream site requires cookies, blocks the server region, or changes extraction behavior before `yt-dlp` supports it.

## Requirements

- Docker with Compose v2.
- WhatsApp account available for QR login.
- WhatsApp group where the bot account can be made admin.
- `.env` file created from `.env.example`.

Node 20 is the supported runtime for local development.

## Quick Start With Docker

1. Clone the repository:

   ```sh
   git clone https://github.com/heykay-47/wpdbot.git
   cd wpdbot
   ```

2. Create an environment file:

   ```sh
   cp .env.example .env
   ```

3. Edit `.env` and set your bot owner WhatsApp ID:

   ```env
   BOT_OWNER_ID=919999999999@c.us
   SQLITE_PATH=/data/bot.db
   TIMEZONE=Asia/Kolkata
   MAX_FILE_SIZE_MB=64
   DUPLICATE_WINDOW_HOURS=24
   DOWNLOAD_DIR=/tmp/wpdbot-downloads
   MAX_DURATION_SECONDS=
   YT_DLP_COOKIES_PATH=
   YT_DLP_PROXY=
   CONCURRENT_DOWNLOADS=1
   ```

4. Build and start the bot:

   ```sh
   docker compose build
   docker compose up -d
   docker compose logs -f
   ```

5. Scan the QR code shown in logs.

6. Add the bot WhatsApp account to the target group and make it a group admin.

7. In the group, send:

   ```text
   !bot enable
   ```

8. Send an Instagram reel/post or YouTube Shorts link in the enabled group.

## Configuration

Configure the bot with `.env`.

| Variable | Default in `.env.example` | Description |
| --- | --- | --- |
| `BOT_OWNER_ID` | `919999999999@c.us` | WhatsApp ID allowed to manage the bot in any group. Replace with your number. |
| `SQLITE_PATH` | `./data/bot.db` | SQLite database path. Docker Compose overrides this to `/data/bot.db`. |
| `TIMEZONE` | `Asia/Kolkata` | Timezone used in repost captions. |
| `MAX_FILE_SIZE_MB` | `64` | Maximum downloaded file size per relay. |
| `DUPLICATE_WINDOW_HOURS` | `24` | How long repeated links are skipped per group. |
| `DOWNLOAD_DIR` | `/tmp/wpdbot-downloads` | Temporary download directory. |
| `WHATSAPP_AUTH_DIR` | Docker: `/app/.wwebjs_auth` | Optional WhatsApp auth directory override. Usually leave unset outside Docker. |
| `WHATSAPP_CACHE_DIR` | Docker: `/app/.wwebjs_cache` | Optional WhatsApp cache directory override. Usually leave unset outside Docker. |
| `MAX_DURATION_SECONDS` | empty | Optional maximum video duration in seconds. Leave empty to disable duration checks. |
| `YT_DLP_COOKIES_PATH` | empty | Optional path to a private Netscape cookies file for authenticated `yt-dlp` downloads. Never commit this file; mount it as a secret/volume and do not `COPY` it into a Docker image. |
| `YT_DLP_PROXY` | empty | Optional proxy URL passed to `yt-dlp` for network or region workarounds. |
| `CONCURRENT_DOWNLOADS` | `1` | Maximum concurrent active downloads. Keep `1` for personal reliability. |

WhatsApp ID format is usually `<country-code><number>@c.us`, for example `919999999999@c.us`.

## Bot Commands

Commands are sent in WhatsApp group chat.

| Command | Description |
| --- | --- |
| `!bot enable` | Enables relay for the current group. The bot must be a group admin. |
| `!bot disable` | Disables relay for the current group. |
| `!bot status` | Shows enabled state, max size, duplicate window, supported platforms, and bot admin status. |

Only group admins or the configured bot owner can manage the bot.

## Operations

Common Docker commands:

```sh
docker compose up -d        # Start in background
docker compose logs -f      # Follow logs and QR/login output
docker compose restart      # Restart service
docker compose down         # Stop without deleting volumes
docker compose build        # Rebuild image
docker compose build --no-cache
```

Update an existing server checkout:

```sh
git fetch origin
git checkout master
git pull --ff-only origin master
docker compose build --pull
docker compose up -d
docker compose logs -f
```

If the server has local changes, inspect and save them before pulling:

```sh
git status
git diff
git stash push -m "server local changes"
git pull --ff-only origin master
```

## Persistent Data

Docker Compose mounts these named volumes:

| Volume | Container path | Contents |
| --- | --- | --- |
| `wpdbot-auth` | `/app/.wwebjs_auth` | WhatsApp Web login/session data. |
| `wpdbot-cache` | `/app/.wwebjs_cache` | WhatsApp Web and Chrome cache. |
| `wpdbot-data` | `/data` | SQLite database at `/data/bot.db`. |
| `wpdbot-downloads` | `/tmp/wpdbot-downloads` | Temporary downloaded media. |

Do not commit `.env`, WhatsApp auth/cache directories, database files, or downloaded media. Anyone with WhatsApp auth data may be able to control the logged-in session.

## Local Development

Docker is recommended because the image includes Chrome, `ffmpeg`, Python, and `yt-dlp` dependencies. For local WSL or Linux runs with `npm run dev`, install browser/runtime dependencies first:

```sh
sudo apt-get update
sudo apt-get install -y libnspr4 libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2t64 libxss1 libxshmfence1 libxrandr2 libxcomposite1 libxcursor1 libxdamage1 libxi6 libxtst6 fonts-liberation xdg-utils ffmpeg python3 python3-pip
pip3 install --break-system-packages "yt-dlp[default]"
```

Use local paths in `.env`:

```env
SQLITE_PATH=./data/bot.db
DOWNLOAD_DIR=./downloads
```

Install dependencies and run:

```sh
npm install
npm run dev
```

Run checks:

```sh
npm test
npm run build
```

## Troubleshooting

### GitHub SSH Pull Fails On A Server

If `git fetch origin` fails with `Permission denied (publickey)`, either configure a GitHub deploy key on the server or use the HTTPS remote for public clones:

```sh
git remote set-url origin https://github.com/heykay-47/wpdbot.git
git fetch origin
```

### Local Changes Block `git pull`

If Git says local changes would be overwritten, inspect and stash them before pulling:

```sh
git status
git diff -- docker-compose.yml
cp docker-compose.yml docker-compose.yml.vm-backup
git stash push -m "server docker compose local changes" -- docker-compose.yml
git pull --ff-only origin master
```

After pulling, reapply only the changes you still need.

### YouTube Shorts Fail With "Download Unavailable Or Blocked" On A Cloud Server

YouTube enforces PO (Proof of Origin) Token authentication and may return `LOGIN_REQUIRED` for requests from datacenter or cloud IPs (DigitalOcean, AWS, GCP, etc.) even when a PO token is provided. The error is sent to WhatsApp as "Could not download this video: Download unavailable or blocked." but does not appear in Docker logs because it is treated as a user-facing error internally.

Two things must be in place for YouTube Shorts to work reliably from a cloud server:

**1. PO token sidecar (`bgutil-ytdlp-pot-provider`)**

The `docker-compose.yml` in this repository includes a `bgutil-provider` sidecar service that runs `brainicism/bgutil-ytdlp-pot-provider`. The Docker image installs the matching yt-dlp plugin and a `/etc/yt-dlp.conf` pointing at the sidecar. If you pulled a version of the repository before this was added, rebuild:

```sh
docker compose build --no-cache
docker compose up -d
```

Verify the sidecar is running and the plugin is loaded:

```sh
docker ps                          # bgutil-provider should be Up
docker exec wpdbot-wpdbot-1 yt-dlp -v "https://www.youtube.com/shorts/dQw4w9WgXcQ" 2>&1 | grep -i "bgutil\|pot"
```

You should see a line like:
```
[youtube] [pot:bgutil:http] Generating a gvs PO Token for web_safari client via bgutil HTTP server
```

**2. YouTube cookies (`YT_DLP_COOKIES_PATH`)**

Even with PO tokens, YouTube requires an authenticated session from datacenter IPs. Export a Netscape-format cookies file from a browser logged into a YouTube/Google account, place it on the server (e.g. `/root/wpdbot/youtube-cookies.txt`), and set in `.env`:

```env
YT_DLP_COOKIES_PATH=/cookies/youtube-cookies.txt
```

The `docker-compose.yml` volume-mounts `/root/wpdbot/youtube-cookies.txt` to `/cookies/youtube-cookies.txt` inside the container. After editing `.env`, force-recreate the container to apply the change:

```sh
docker compose up -d --force-recreate wpdbot
```

Verify the cookie file is read:

```sh
docker exec wpdbot-wpdbot-1 yt-dlp -v "https://www.youtube.com/shorts/dQw4w9WgXcQ" 2>&1 | grep -i cookie
# Should print: [youtube] Found YouTube account cookies
```

**Note:** Cookies expire. If downloads start failing again after previously working, re-export fresh cookies from your browser and replace the file on the server. Restart the container after replacing the file.

### Refresh `yt-dlp` And Chrome Dependencies

If YouTube Shorts fail with an `n challenge solving failed` warning or `Requested format is not available`, rebuild the image so Docker installs the current `yt-dlp[default]` package and challenge solver scripts:

```sh
docker compose build --no-cache
docker compose up -d
docker compose logs -f
```

### Recover From Chrome Profile Locks

The bot removes stale Chromium `SingletonLock`, `SingletonSocket`, and `SingletonCookie` files at startup. If Chrome still reports that the profile is in use, restart cleanly:

```sh
docker compose down
docker compose up -d
docker compose logs -f
```

### Reset A Corrupt WhatsApp Session

Only do this when restart does not recover the session. This removes the saved WhatsApp login and browser cache, so you must scan the QR code again:

```sh
docker compose down
docker volume ls
docker volume rm <compose-project>_wpdbot-auth <compose-project>_wpdbot-cache
docker compose up -d
docker compose logs -f
```

Replace `<compose-project>` with the prefix shown by `docker volume ls`; it is often the clone directory name or `COMPOSE_PROJECT_NAME`.

Keep the `wpdbot-data` volume unless you also want to erase group settings and repost history.

## Manual Smoke Test

- Create a private WhatsApp test group.
- Add the bot account and make it group admin.
- Start the container and scan QR.
- Restart the container and confirm the session persists without a new QR scan.
- Send `!bot status` and confirm bot admin shows `yes`.
- Send `!bot enable` and confirm enabled response.
- Send one YouTube Shorts link, one Instagram reel link, and one Instagram post link.
- Confirm repost, caption, original deletion, and duplicate skip behavior.
- Send an unsupported link and confirm the bot ignores it.
- Send `!bot disable` and confirm future links are ignored.

## Security And Safety

- Keep `.env`, `.wwebjs_auth`, `.wwebjs_cache`, database files, and Docker volumes private.
- Use a dedicated WhatsApp account where possible.
- Keep `MAX_FILE_SIZE_MB` reasonable to avoid disk, bandwidth, and upload failures.
- Keep enough disk space for `wpdbot-data` and `wpdbot-downloads`.
- Do not expose this bot as a public service without reviewing platform terms, copyright implications, abuse controls, and account-risk tradeoffs.

## Contributing

Issues and pull requests are welcome. For changes, please include:

- Clear description of the problem or feature.
- Tests for code changes where practical.
- Output from `npm test` and `npm run build`.

## License

No license file is currently included. Until a license is added, this project is publicly visible but not explicitly licensed for reuse or redistribution.

## Disclaimer

This project is intended **for personal and educational purposes only**.

- **YouTube Terms of Service:** Downloading YouTube content may violate [YouTube's Terms of Service](https://www.youtube.com/t/terms), specifically the prohibition on downloading content without explicit permission unless a download button or link is provided by YouTube. This bot is not affiliated with, endorsed by, or approved by YouTube or Google.
- **Instagram Terms of Service:** Downloading or reposting Instagram content may violate [Instagram's Terms of Use](https://help.instagram.com/581066165581870), including restrictions on automated data collection and redistribution of content without the creator's consent. This bot is not affiliated with, endorsed by, or approved by Instagram or Meta.
- **WhatsApp Terms of Service:** Using automated tools to interact with WhatsApp may violate [WhatsApp's Terms of Service](https://www.whatsapp.com/legal/terms-of-service). WhatsApp accounts used for automation may be restricted or banned.
- **Copyright:** Downloaded and reposted media remains the intellectual property of the original creators and platforms. Reposting without the creator's permission may infringe copyright in your jurisdiction.
- **No liability:** The authors of this project accept no responsibility for misuse, account bans, copyright claims, or any other consequences arising from use of this software. You use it at your own risk.

Use this project responsibly, only in private groups with the informed consent of all members, and only for content you have the right to share.
