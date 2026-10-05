# wpdbot

WhatsApp group media relay bot for personal use. It watches enabled WhatsApp groups for Instagram reels/posts and YouTube Shorts, downloads the media with `yt-dlp`, reposts the video in the same group with attribution, and skips previously confirmed videos inside each group's duplicate window.

## Features

- Relays Instagram reels/posts and YouTube Shorts in WhatsApp groups.
- Uses `whatsapp-web.js` with QR login and persisted WhatsApp Web session data.
- Downloads identified videos with `yt-dlp`, using `ffmpeg` where stream merging requires it.
- Retains source messages for both platforms until the remaining cleanup safeguards are implemented.
- Suppresses equivalent-video reposts per group, with durable protection for unresolved sends.
- Supports per-group enable/disable/status commands.
- Runs as a Docker Compose service with persisted auth, cache, database, and download volumes.

### Equivalent links and safe sends

- Supported URLs remain YouTube `/shorts/` and Instagram `/p/` or `/reel/` on the existing bare, `www`, and `m` hosts. Only the first supported source link in a message is processed in this implementation.
- Ordinary YouTube Shorts links with the same exact, case-sensitive video ID share an identity across accepted hostname aliases, HTTP/HTTPS, fragments, trailing slashes, and the already-recognized `utm_*`, `fbclid`, and `igsh` tracking parameters. Different uploads of the same footage are not detected as content duplicates.
- Instagram video identities use the resolved parent-post and video-item IDs. Sharing item 3, then the whole collection, reposts only its other unconfirmed videos inside the window. Sharing the whole collection, then item 3, does not repost that video again inside the window. `/p/` versus `/reel/` alone does not identify one equal video.
- Arbitrary queries, encoded/malformed IDs, unusual paths, long shortcode variants, and mobile Instagram links do not receive guessed equivalence. The submitted URL is kept for extraction and attribution. Verified metadata may establish an identity; otherwise no video is sent and the source remains visible. Fixture success does not prove mobile Instagram extraction works in a deployment.
- A group's duplicate window starts when a repost's confirmation is observed, not when its source was posted or queued. Duplicate skips do not extend it. A new source message may request another repost after expiry. Confirmed outcomes for the same source message remain completed even after expiry or restart. Queued work rechecks current settings and time.
- Both platforms prepare media before making one submission attempt. There are no transcode or document retries after submission begins. Confirmation requires a sent-message ID and an observed server-or-stronger acknowledgement in the originating group. It does not prove every participant received the repost.
- Identity-based send reservations are stored before submission. An unresolved send blocks that video across source messages and restarts, regardless of duplicate-window expiry. A definite inspection/download failure does not create a confirmed duplicate marker. A submitted video whose confirmation cannot be recorded remains held rather than being sent again.
- All source messages remain intact, including document reposts, duplicate-only and mixed new/duplicate requests. General reconciliation, authorized retry commands, and guarded source cleanup remain later work. Do not erase progress records to force another send.

SQLite initialization adds `media_relay_attempts` without rewriting existing settings, history, URL hashes, or `instagram_relay_items`. Legacy URL markers still suppress only their exact legacy-normalized URL in the same group/window; they are not promoted to ACK-confirmed identities or broadened to aliases. Old Instagram confirmations still protect the same source message, and old unresolved items protect the same resolved video across messages. Old records have no reliable confirmation timestamp, so no canonical windows are backfilled. A newly encountered URL alias can therefore be reposted despite an old URL-only marker.

A zero-hour stored group window disables prior-message confirmed suppression, not unresolved-send protection or same-source completion. Existing `.env` validation still requires a positive `DUPLICATE_WINDOW_HOURS`; new group-setting commands and ranges are not part of this change. Back up the database before updating a deployment, and do not run old and new relay versions against the same database concurrently.

### Instagram collections

- A post with several videos reposts each verifiable video in post order. Photos and entries without reliable video metadata are not reposted.
- A source link with `img_index=3` requests only the third media item, counting photos as positions too. An invalid, unavailable, or non-video selection does not fall back to another video.
- A failed item download or media preparation does not prevent other verifiable videos from being processed. Each video must meet the effective media budget; configured duration limits also apply to the probed final file.
- Instagram source messages are always retained, including fully reposted single-video posts. Safe automatic cleanup awaits the remaining restart-recovery and deletion-guard work.
- Unresolved sends stop the collection. There is no automatic reconciliation or recovery command yet. Do not erase progress records to force a retry; review the group first because the video may already be present.

Metadata handling is conservative when yt-dlp omits entries or cannot establish their positions. Its deployed version is not pinned by this project, so fixture-based checks do not replace a separately authorized private-group smoke test.

### Media quality and pre-send fallbacks

- Prefer MP4/H.264 with AAC audio when present, a short edge of at most 720 pixels and at most 30 fps. Silent video is allowed. Selection keeps bounded resolution alternatives; missing upstream dimensions may proceed to local probing. No unrestricted highest-resolution fallback or repeated lower-quality download loop exists.
- Validate final filesystem bytes and use `ffprobe` for streams, dimensions, pixel format, frame rate and duration. Inline MP4 eligibility also requires a recognized MP4-family major brand and an MP4 filename for MIME selection. FFprobe's shared MOV/MP4 demuxer name alone is insufficient; unknown brands require preparation or document delivery. Probe success is not a full-frame decode test or a promise of recipient playback.
- Within-budget media that already meets the profile is sent without re-encoding. Otherwise attempt one full-video conversion using libx264, yuv420p, CRF 28, veryfast, AAC 128k and faststart. Scale down only, preserve aspect ratio with even dimensions, cap frame rate, and use two encoder/filter threads. There is no fixed H.264 level claim, trimming, byte-target guarantee or repeated compression loop.
- Recheck converted size, profile and duration before selecting it. A duration difference greater than 0.25 seconds rejects that conversion. If conversion fails, times out, is oversized or fails validation, select the validated original as a document under the same byte and duration budgets. Unknown original duration with no configured duration limit permits document delivery without conversion, since conversion completeness cannot be checked.
- Empty, oversized or unprobeable originals are not sent as videos or documents. Missing upstream size/duration is not treated as zero. Duration evidence must cover the container or every video stream; audio-only duration cannot establish the video's duration. With `MAX_DURATION_SECONDS` configured, an unavailable final duration prevents sending. Without it, unknown duration remains allowed for a valid original.
- Each yt-dlp subprocess has a five-minute timeout, conversion two minutes, and each probe 30 seconds. Metadata inspection and downloading are separate calls. These plus existing concurrency settings bound processing, but temporary components, muxing and base64/browser copies can exceed the final file budget. No hard disk or process-memory quota is claimed.
- The effective budget is `min(stored group limit, MAX_MEDIA_SIZE_MB)`, measured in MiB, for both videos and documents. Existing stored limits are not rewritten. Recheck actual bytes against current settings before the send reservation. Status reports the effective limit using the existing MB label.
- Document delivery is chosen before any submission, preserves attribution and retains the source. It does not guarantee playback. After a submitted video/document throws or lacks confirmation, hold its identity without automatically resubmitting in another mode. The legacy send adapter also no longer retries exceptions.

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

Node 24 is the supported runtime for local development and Docker. Node 20 is no longer supported.

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
    MAX_MEDIA_SIZE_MB=64
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
| `MAX_FILE_SIZE_MB` | `64` | Initial per-video group budget in MiB for new groups. Existing stored group limits are preserved. |
| `MAX_MEDIA_SIZE_MB` | `64` | Operator-wide ceiling in MiB, applied to video and document downloads/final files. Effective limit is the smaller of this ceiling and the stored group budget. This is an application budget, not a guaranteed WhatsApp limit. |
| `DUPLICATE_WINDOW_HOURS` | `24` | Initial positive duplicate window for new groups, measured from observed confirmation. Existing group settings are preserved. |
| `DOWNLOAD_DIR` | `/tmp/wpdbot-downloads` | Temporary download directory. |
| `WHATSAPP_AUTH_DIR` | Docker: `/app/.wwebjs_auth` | Optional WhatsApp auth directory override. Usually leave unset outside Docker. |
| `WHATSAPP_CACHE_DIR` | Docker: `/app/.wwebjs_cache` | Optional WhatsApp cache directory override. Usually leave unset outside Docker. |
| `MAX_DURATION_SECONDS` | empty | Optional global maximum video duration in seconds, checked against known metadata and the probed final file. Unknown final duration rejects when configured. Leave empty to disable the limit. |
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

### Dependency security

`whatsapp-web.js` 1.34.7 pins Puppeteer 24.38.0, whose browser-download dependencies include the unpatched `extract-zip` package. `package.json` overrides only `@puppeteer/browsers` to 3.2.3 to remove that dependency chain while retaining Puppeteer's WhatsApp-compatible interface. The browser helper requires Node 22.12 or newer; this project uses Node 24. Keep this scoped override until WhatsApp's upstream dependency is updated and a fresh audit and browser check pass.

Check both development and production dependencies:

```sh
npm audit
npm audit --omit=dev
```

After changing browser dependencies, run the offline integration check with an installed Chrome or Chromium binary:

```sh
PUPPETEER_EXECUTABLE_PATH=/path/to/chrome npm run test:browser
```

This check launches and shuts down the real WhatsApp client browser with a temporary profile and intercepts page requests with fixture HTML. It does not contact WhatsApp, log in, or send messages. The manual smoke test below is still needed to verify live relaying.

## Troubleshooting

### Native SQLite crashes on Node 24.19

Node 24.19.0 has an [upstream native-addon cleanup bug](https://github.com/nodejs/node/issues/65446). A SQLite addon compiled with its headers can abort with `RemoveEnvironmentCleanupHook` and `Assertion failed: (env) != nullptr` during garbage collection. Changing only the runtime does not repair an already affected binary.

Rebuild the existing dependency using Node 24.18.x headers. For example, with an installed Node 24.18.0 through nvm:

```sh
nvm use 24.18.0
npm_config_build_from_source=true npm rebuild better-sqlite3
npm test
```

If npm gates install scripts, use its scoped `--allow-scripts=better-sqlite3` option for that rebuild. Do not enable unrelated install scripts. No SQLite database deletion or dependency-version upgrade is required. The rebuilt addon also runs on Node 24.19.0. Until the upstream fix lands, this caveat also applies to native dependencies compiled by the floating `node:24-slim` Docker base; use unaffected build headers when rebuilding an image.

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

YouTube enforces PO (Proof of Origin) Token authentication and may return `LOGIN_REQUIRED` for requests from datacenter or cloud IPs (DigitalOcean, AWS, GCP, etc.) even when a PO token is provided. Inspection failures now produce "Could not establish this YouTube video identity. Original message kept." Download failures produce "Could not download this video: Download unavailable or blocked. Original message kept." These user-facing errors still bypass diagnostic logging; richer diagnostics remain later work.

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
- Confirm reposts, captions, equivalent-link duplicate skips, and source retention for both platforms. Automatic source cleanup is disabled in the incoming relay.
- Test an Instagram collection containing several videos and a photo, then a link selecting a video with `img_index`. Verify video order, photo omission, selected-item attribution, and source retention.
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
