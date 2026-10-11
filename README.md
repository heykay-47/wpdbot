# wpdbot

WhatsApp group media relay bot for personal use. It watches enabled WhatsApp groups for Instagram reels/posts and YouTube Shorts, downloads the media with `yt-dlp`, reposts the video in the same group with attribution, and skips previously confirmed videos inside each group's duplicate window.

## Features

- Relays Instagram reels/posts and YouTube Shorts in WhatsApp groups.
- Uses `whatsapp-web.js` with QR login and persisted WhatsApp Web session data.
- Downloads identified videos with `yt-dlp`, using `ffmpeg` where stream merging requires it.
- Retains sources by default and applies one guarded cleanup attempt only to newly accepted, fully confirmed link-only sources.
- Suppresses equivalent-video reposts per group, with durable protection for unresolved sends.
- Tracks ordered multi-link work durably and resumes eligible interrupted work after restart.
- Supports authorized per-group enable/disable/status/inspect/settings commands and source-targeted safe retry.
- Runs as a Docker Compose service with persisted auth, cache, database, and download volumes.

### Equivalent links and safe sends

- Supported URLs remain YouTube `/shorts/` and Instagram `/p/` or `/reel/` on the existing bare, `www`, and `m` hosts. Distinct supported links are processed in first-appearance order; exact repeated URLs require one request. Definite failures and held videos do not prevent unrelated later links while the client is usable. There is no cross-message FIFO guarantee.
- Ordinary YouTube Shorts links with the same exact, case-sensitive video ID share an identity across accepted hostname aliases, HTTP/HTTPS, fragments, trailing slashes, and the already-recognized `utm_*`, `fbclid`, and `igsh` tracking parameters. Different uploads of the same footage are not detected as content duplicates.
- Instagram video identities use the resolved parent-post and video-item IDs. Sharing item 3, then the whole collection, reposts only its other unconfirmed videos inside the window. Sharing the whole collection, then item 3, does not repost that video again inside the window. `/p/` versus `/reel/` alone does not identify one equal video.
- Arbitrary queries, encoded/malformed IDs, unusual paths, long shortcode variants, and mobile Instagram links do not receive guessed equivalence. The submitted URL is kept for extraction and attribution. Verified metadata may establish an identity; otherwise no video is sent and the source remains visible. Fixture success does not prove mobile Instagram extraction works in a deployment.
- A group's duplicate window starts when a repost's confirmation is observed, not when its source was posted or queued. Duplicate skips do not extend it. A new source message may request another repost after expiry. Confirmed outcomes for the same source message remain completed even after expiry or restart. Queued work rechecks current settings and time.
- Both platforms prepare media before making one submission attempt. There are no transcode or document retries after submission begins. Confirmation requires a sent-message ID and an observed server-or-stronger acknowledgement in the originating group. A send waits at most 30 seconds for that evidence. Timeout does not cancel the external effect or prove failure. It does not prove every participant received the repost.
- Identity-based send reservations are stored before submission. An unresolved send blocks that video across source messages and restarts, regardless of duplicate-window expiry. A definite inspection/download failure does not create a confirmed duplicate marker. A submitted video whose confirmation cannot be recorded remains held rather than being sent again.
- Sources with document reposts, duplicate-only or mixed new/duplicate requests remain intact. Exact-ID reconciliation is supported; do not erase progress records to force another send.

### Guarded source cleanup

- Only a newly accepted source whose content consists solely of its supported links can qualify. Legacy source records are permanently ineligible; migration never reconstructs cleanup evidence. Mixed-content messages, duplicate skips, skipped or unverifiable media, document delivery, changed media plans, and positively observed source edits stay intact.
- Cleanup waits until every required video has a durable confirmed repost with its known message ID, inline-video delivery mode, and server-or-stronger acknowledgement in the originating group. Failed, held, or unresolved work keeps the source. Temporary lookup, group-enable, client, or authority blockers defer cleanup without recording an intent.
- The bot rechecks the source identity and current group/admin authority before its sole cleanup attempt, no later than 24 hours after durable acceptance. A durable deletion intent is recorded first and consumes that allowance even if a final check fails, the process stops, deletion throws, or its outcome cannot be saved. A later recovery event may reevaluate only work that has not recorded intent; there is no polling loop or cleanup command.
- A fulfilled WhatsApp delete request is recorded as returned but does not prove the source disappeared for every participant. Inspection reports the durable cleanup state and safe last-observed reasons for temporary deferral, not permanent ineligibility. Deferral reasons are saved when storage permits; no diagnostic write is assumed after a storage failure. A bounded group notice is sent at most once for post-intent failure or uncertainty. Successful requests are silent. Keep the database private because it contains source links and operational evidence.

SQLite initialization adds `media_relay_attempts` without rewriting existing settings, history, URL hashes, or `instagram_relay_items`. Legacy URL markers still suppress only their exact legacy-normalized URL in the same group/window; they are not promoted to ACK-confirmed identities or broadened to aliases. Old Instagram confirmations still protect the same source message, and old unresolved items protect the same resolved video across messages. Old records have no reliable confirmation timestamp, so no canonical windows are backfilled. A newly encountered URL alias can therefore be reposted despite an old URL-only marker.

### Durable work and restart recovery

- SQLite also adds versioned `relay_sources` snapshots. Intake persists the source/group IDs, attribution, timestamps, supported URLs, a content fingerprint and ordered link outcomes before queueing. Resolved video identities and positions are stored before downloading. Surrounding prose, credentials and raw extraction responses are not stored in this new table. The database still contains private URLs and attribution and must remain private.
- Startup waits for the WhatsApp client to be ready and recovers only previously accepted work. It does not scan group history for messages posted while offline. Pre-send work can download and prepare again; leftover temporary files are not trusted as resumable downloads.
- Before recovered sends, require the source to exist unchanged in its originating group. Missing, changed or unavailable sources stay held. Re-inspection must match saved collection identities/order; a changed plan stays held rather than substituting videos. Work older than 24 hours from acceptance, or with a future acceptance timestamp after clock rollback, requires authorized review. Age never expires confirmation records or unknown-delivery protection.
- Same-source confirmed and duplicate-skipped outcomes remain completed. Recorded inspection/download/preparation failures are not automatically retried on restart or repeated source events. A new source message can request a video again after a definite pre-send failure, subject to current duplicate and unresolved-send guards. Authorized admins and the configured owner can explicitly retry only definitely pre-send failures through the two-step flow below; confirmed, skipped, and delivery-unknown items remain protected.
- Send intent is committed before submission. A crash between that write and submission is conservatively held even if no send actually happened. Known repost IDs are stored immediately, including pending ACKs. Exact-ID lookup and later ACK events can establish positive confirmation in the originating group. Absent history, a failed lookup or no stored ID never establishes non-delivery and never authorizes another send. Legacy holds remain guards; no old queue or missing evidence is reconstructed.
- Disabling a group pauses unsubmitted work without clearing outcomes. An already-started send may still record its evidence. Re-enabling makes paused work eligible under current settings and the source/age checks; it does not reset failures, confirmations or holds. A storage failure stops new submissions until the process is restarted and storage is repaired.
- An admitted targeted retry grants one pass only. Restart, group disable, changed settings, or lost/unverifiable requester authority revokes any unused part of that grant. Preserve send evidence already in flight; remaining definitely pre-send work needs a fresh two-step preview and is never silently resumed as ordinary recovery.
- `SIGINT` and `SIGTERM` stop intake and new submissions immediately. Active submissions have up to 30 seconds to record evidence, then the client is destroyed and SQLite closed without logout or auth deletion. Compose allows 35 seconds before forced termination. Abrupt loss still relies on durable send-intent guards; shutdown does not provide exactly-once delivery.

A zero-hour stored group window disables prior-message confirmed suppression, not unresolved-send protection or same-source completion. Existing `.env` validation still requires a positive `DUPLICATE_WINDOW_HOURS`; the group setting command can set the current group's window to zero. Group settings never rewrite historical values during migration. Back up the database before updating a deployment, and do not run old and new relay versions against the same database concurrently.

### Instagram collections

- A post with several videos reposts each verifiable video in post order. Photos and entries without reliable video metadata are not reposted.
- A source link with `img_index=3` requests only the third media item, counting photos as positions too. An invalid, unavailable, or non-video selection does not fall back to another video.
- A failed item download or media preparation does not prevent other verifiable videos from being processed. Each video must meet the effective media budget; configured duration limits also apply to the probed final file.
- Instagram source messages containing photos, unverifiable entries, or other skipped media remain intact. A fully confirmed link-only video source may qualify under the guarded cleanup rules above; multi-item collections with skipped content do not.
- Unresolved sends stop that collection, not unrelated later links. Exact stored repost IDs may be reconciled. A targeted retry never includes an unresolved send; other definitely pre-send failures may be reviewed when their source and saved plan still match. Do not erase progress records to force a retry; review the group first because the video may already be present.

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
   YT_DLP_COOKIES_HOST_PATH=
   YT_DLP_PROXY=
   CONCURRENT_DOWNLOADS=1
   ```

4. Build the bot and stop its normal service before private login:

   ```sh
   docker compose build
   docker compose stop wpdbot
   docker compose run --rm --no-deps wpdbot node dist/entrypoint.js login
   ```

5. Scan the QR in that private interactive terminal, then run `docker compose up -d`. Never record/share the terminal. The one-shot flow exits after authentication, timeout or interruption; it does not relay. A noninteractive invocation refuses to expose a QR. The daemon never prints one.

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
| `DIAGNOSTICS_DIR` | Docker: `/app/.diagnostics`; local: `.diagnostics` | Private, regenerable allowlisted diagnostics, bounded to seven days and 30 MiB total. Keep separate from database/auth volumes. |
| `MAX_DURATION_SECONDS` | empty | Optional global maximum video duration in seconds, checked against known metadata and the probed final file. Unknown final duration rejects when configured. Leave empty to disable the limit. |
| `YT_DLP_COOKIES_PATH` | empty | Optional cookies-file path for local runs. In Compose, the app path is set to `/run/secrets/yt-dlp-cookies.txt` only when `YT_DLP_COOKIES_HOST_PATH` is configured. |
| `YT_DLP_COOKIES_HOST_PATH` | empty | Optional host-side cookies-file path for Compose. The file is mounted read-only at `/run/secrets/yt-dlp-cookies.txt`; keep it outside the repository. |
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
| `!bot inspect` | Bounded unfinished-work summary for this group (up to ten sources), also while disabled. |
| Reply to a source with `!bot inspect` | Saved link/item outcomes for that exact tracked source (up to twenty positions). Missing, foreign or untracked quotes show no work details. |
| `!bot set max-size <MiB>` | Sets the current group's whole-number media limit from 1 MiB through the configured global ceiling. |
| `!bot set duplicate-window <hours>` | Sets the current group's whole-number duplicate window from 0 through 720 hours. Zero disables only prior-message confirmed suppression. |
| Reply to a source with `!bot retry` | Previews eligible definitely pre-send work and its saved link/item positions. It queues no work. |
| Reply to the same source with `!bot retry confirm` | Requests one retry pass for that preview, within five minutes. Current settings, authority, source, saved plan, duplicate, media, and storage checks still apply. |

Only group admins or the configured bot owner can manage the bot.

Settings and retry commands are available while a group is disabled; retry itself is rejected until enabled. A retry preview is bound to the requesting admin, group, exact source, settings revision and eligible work; repeated requests do not extend its five-minute lifetime. Source age is the only retry bypass. Restart, disable, changed settings, or lost authority revokes unused retry permission. A confirmation for a delivery-unknown item never opens a retry path.

Every durably accepted source has a persistent random `W-…` reference. Equivalent links in different sources have different references; references grant no access. A settled source may still have failed items. Inspection uses saved outcomes and exact stored attempt evidence, not guessed historical causes/counts/times. Unsupported saved records remain untouched and held, without blocking unrelated supported recovery. Source inspection reports cleanup eligibility or the one recorded cleanup outcome without claiming group-wide removal.

## Operator Runbook

Use this runbook for one private instance. It describes offline operations; it does not authorize live-account testing or deployment changes.

### First setup and updates

For first setup, follow Quick Start. Keep `.env`, the auth volume, and the database private. Before an update, take a paired backup as described below. Stop the relay before changing versions; never run old and new versions concurrently against one database.

```sh
docker compose stop wpdbot
git fetch origin
git checkout master
git pull --ff-only origin master
docker compose build --pull
docker compose up -d wpdbot
```

If the checkout has local changes, inspect and preserve them before pulling. Do not blindly overwrite host configuration.

### Health, status, and deliberate restart

`docker compose ps` reports both process state and the Docker health status. `healthy` means the readiness check currently sees an open SQLite store and an authenticated and ready WhatsApp client. Process liveness is distinct from relay readiness: the process can remain running while readiness is false. The health endpoint is loopback-only on port 3000; it is not published to the host. `/health/live` reports that the process can answer requests, while `/health/ready` reports relay readiness.

Readiness is passive: it does not restart the container, log out, or delete authentication data. Existing `unless-stopped` behavior applies to process or host exits. Missing group-admin permission and an individual blocked download are group/operation problems, not global health failures. An unhealthy container is not automatically restarted by this health check.

Inspect only the allowlisted private diagnostics when readiness is unhealthy:

```sh
docker compose exec wpdbot sh -c 'cat /app/.diagnostics/*.jsonl'
```

Ordinary Docker output is disabled for the bot and token-provider. The daemon discards third-party stdout/stderr; diagnostics contain allowlisted stage, timestamp, safe cause, platform, opaque reference, and saved positions only. They omit URLs/hashes, identities, raw IDs, prose, stacks, stderr, commands, paths, payloads, secrets, and QR data. Unknown causes remain unknown, and reporting failures cannot change delivery evidence. Files rotate at 1 MiB, stay within 30 MiB total, and expire within seven days. Diagnostics are regenerable, not relay history; never upload them automatically.

For a diagnosed transient WhatsApp disconnect, perform one deliberate graceful restart:

```sh
docker compose restart wpdbot
```

Shutdown stops new work, allows active submissions up to 30 seconds to record evidence, then destroys the client without logout and closes SQLite. Compose allows 35 seconds before forced termination. If readiness remains unhealthy after one restart, stop and diagnose; do not create a restart loop. Fix missing admin permission in the group. For storage errors, preserve the data and auth volumes and repair storage. For blocked downloads, verify network/cookie configuration; only use the existing authorized targeted retry for definitely pre-intent work. Never retry delivery-unknown work.

### Private login

If diagnostics indicate authentication intervention, stop the normal service and run the one-shot login in a private interactive terminal against its existing auth volume:

```sh
docker compose stop wpdbot
docker compose run --rm --no-deps wpdbot node dist/entrypoint.js login
docker compose up -d wpdbot
```

Scan the transient QR only in that terminal; do not record or share it. The flow does not relay and exits after authentication, timeout, or interruption. The daemon never prints a QR. A shared OS-backed auth-profile lock prevents this version's daemon and login process from running together. Never automatically log out, delete auth state, relink, or run another version against the same auth/database volumes.

### Optional cookies

For Docker, leave `YT_DLP_COOKIES_HOST_PATH` empty to run without cookies. When needed, set it in the private `.env` to the host-side path of an existing Netscape-format cookies file. Compose mounts that file read-only at `/run/secrets/yt-dlp-cookies.txt` and sets the app's `YT_DLP_COOKIES_PATH` to that stable container path. The file is optional; without it, cookie-backed downloads are unavailable. The container runs as UID 10001; ensure that UID can read the file and traverse its parent directories without making the file broadly readable. Keep the file outside source control and do not put its contents or host path in diagnostics. Recreate the service after changing the configured mount or replacing the file contents, especially if the host replaces it by renaming a new file over the old one:

```sh
docker compose up -d --force-recreate wpdbot
```

### Paired backup and restore

Create a paired, quiesced snapshot of SQLite and WhatsApp LocalAuth together for the same instance. Ensure no one-shot login or second version is running. This helper assumes the normal service should be running afterward: it stops `wpdbot` for the snapshot and starts it again when finished. If the service is intentionally stopped, do not run this helper unchanged. The following encrypts the archive with GnuPG symmetric AES-256; install GnuPG on the host if needed, choose a strong passphrase, and store it separately from the archive. The plaintext archive streams directly from the container into GnuPG and is not written to the host filesystem. Run this Bash snippet with a private backup directory that has enough space:

```bash
set -euo pipefail
backup_dir="$HOME/wpdbot-backups"
umask 077
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
snapshot="$(mktemp --suffix=.tar.gz.gpg "$backup_dir/wpdbot-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")"
stopped=0
complete=0
cleanup() {
  status=$?
  trap - EXIT
  if [ "$complete" -ne 1 ]; then rm -f -- "$snapshot" || true; fi
  if [ "$stopped" -eq 1 ]; then docker compose start wpdbot || true; fi
  exit "$status"
}
trap cleanup EXIT

docker compose stop wpdbot
stopped=1
docker compose run --rm --no-deps -T --entrypoint sh wpdbot -ec \
  'test -f /data/bot.db && test -d /app/.wwebjs_auth && tar -C / -czf - data app/.wwebjs_auth' |
  gpg --symmetric --cipher-algo AES256 --yes --output "$snapshot"
chmod 600 "$snapshot"
complete=1
docker compose start wpdbot
stopped=0
trap - EXIT
```

Treat the encrypted archive like the logged-in WhatsApp account. Store it in a private location and label the instance and snapshot time outside the repository. Cache and downloads are regenerable and are not part of the snapshot.

Restore only the exact SQLite/LocalAuth pair for the same instance, while stopped, when no later WhatsApp sends may have occurred. A restore rolls back local evidence; if the account may have sent or received work since the snapshot, do not restore it. Never restore SQLite alone or combine a database with a different/stale auth profile. Keep the service stopped if any restore step fails; start it only after both volumes have been restored.

```bash
set -eu
umask 077
snapshot="/absolute/private/path/to/wpdbot-snapshot.tar.gz.gpg"
test -r "$snapshot"
restore_dir="$(mktemp -d "$HOME/wpdbot-restore.XXXXXX")"
trap 'rm -rf -- "$restore_dir"' EXIT
chmod 700 "$restore_dir"
gpg --decrypt --output "$restore_dir/snapshot.tar.gz" "$snapshot"
chmod 600 "$restore_dir/snapshot.tar.gz"
tar -tzf "$restore_dir/snapshot.tar.gz" >/dev/null
docker compose stop wpdbot
docker compose run --rm --no-deps -T \
  -v "$restore_dir/snapshot.tar.gz:/restore/snapshot.tar.gz:ro" --user 0:0 \
  --entrypoint sh wpdbot -ec '
    mkdir -p /tmp/wpdbot-restore
    tar -xzf /restore/snapshot.tar.gz -C /tmp/wpdbot-restore
    test -f /tmp/wpdbot-restore/data/bot.db
    test -d /tmp/wpdbot-restore/app/.wwebjs_auth
    find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
    cp -a /tmp/wpdbot-restore/data/. /data/
    find /app/.wwebjs_auth -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
    cp -a /tmp/wpdbot-restore/app/.wwebjs_auth/. /app/.wwebjs_auth/
  '
docker compose start wpdbot
```

Decryption and archive validation happen before the service stops or either volume changes. The temporary plaintext restore file lives in a mode-0700 private directory and is removed when the shell exits. The restore helper runs only while the service is stopped; root is used in this disposable helper so the original volume ownership can be preserved. Review the selected snapshot path and same-instance/no-later-sends conditions before running it. After restart, confirm Docker readiness and inspect saved work before any recovery action. Missing history or visual absence never proves non-delivery.

### Exact-ID reconciliation

The bot reconciles only an already-stored repost message ID in its originating group, using positive WhatsApp history/acknowledgement evidence. Do not issue raw-ID group commands or treat a failed lookup, missing history, or visual absence as proof that a send did not happen. No negative-evidence override grants a retry.

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

Recovery tests include disposable SQLite databases, synthetic metadata/media, mocked WhatsApp, actual child-process kills at intake/plan/send-intent/evidence/confirmation boundaries, and real SIGINT/SIGTERM handling with a mocked client. These checks do not prove live WhatsApp history availability, recipient playback or delivery.

### Offline Docker qualification

With Docker Compose 2.24.4 or newer and host GnuPG available, run:

```sh
npm run test:docker
```

This builds the real Dockerfile (including the complete unit suite and TypeScript build), then rehearses private operations under a randomly named Compose project with disposable named volumes. Image builds may download public dependencies; all rehearsal containers have networking disabled and use synthetic SQLite/auth/cookie fixtures. The normal `.env`, deployment project, and real account volumes are not used. Only the rehearsal's containers, volumes, temporary files and image are removed afterward.

The check exercises passive healthy/unhealthy transitions with process liveness intact, absent and read-only cookie mounts, graceful stopping, GnuPG-encrypted paired SQLite/LocalAuth backup, root-helper restore with preserved UID/file modes, and all saved rows and ambiguity/cleanup guards through two reopens. It uses a synthetic service with the production health server and store, not a logged-in WhatsApp client. Its health intervals are shortened for testing; the normal 30-second drain/35-second Compose grace and passive restart policy remain unchanged. A passing rehearsal is not live extraction, login, delivery, playback, deletion, or deployment qualification.

The synthetic service stops without active sends; the production drain behavior is covered separately by the unit/process-boundary suite. Retry-confirmation replay markers and completed/revoked retry passes are included in the paired snapshot. If Docker resource cleanup fails, the command fails and retains its synthetic configuration for diagnosis rather than claiming successful cleanup.

## Troubleshooting

### Native SQLite crashes on Node 24.19

Node 24.19.0 has an [upstream native-addon cleanup bug](https://github.com/nodejs/node/issues/65446). A SQLite addon compiled with its headers can abort with `RemoveEnvironmentCleanupHook` and `Assertion failed: (env) != nullptr` during garbage collection. Changing only the runtime does not repair an already affected binary.

Rebuild the existing dependency using Node 24.18.x headers. For example, with an installed Node 24.18.0 through nvm:

```sh
nvm use 24.18.0
npm_config_build_from_source=true npm rebuild better-sqlite3
npm test
```

If npm gates install scripts, use its scoped `--allow-scripts=better-sqlite3` option for that rebuild. Do not enable unrelated install scripts. No SQLite database deletion or dependency-version upgrade is required. The rebuilt addon also runs on Node 24.19.0. The Docker build uses Node 24.18.0 target headers for native dependencies, then copies the tested, production-only dependencies to runtime without downgrading the floating `node:24-slim` runtime. Keep this workaround until the upstream cleanup-hook issue is fixed and a fresh Docker qualification passes.

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

YouTube can enforce PO (Proof of Origin) Token authentication or require source access. Failures now produce safe group feedback and allowlisted diagnostics. An unspecified upstream exception remains an unknown cause; raw stderr is never shown or logged. Contact the operator rather than posting cookies, URLs, raw errors or credentials into support.

Reliable cloud downloads use the PO token sidecar. Some sources additionally require authenticated cookies; cookie configuration remains optional:

**1. PO token sidecar (`bgutil-ytdlp-pot-provider`; included in this Compose setup)**

The `docker-compose.yml` in this repository includes a `bgutil-provider` sidecar service that runs `brainicism/bgutil-ytdlp-pot-provider`. The Docker image installs the matching yt-dlp plugin and a `/etc/yt-dlp.conf` pointing at the sidecar. If you pulled a version of the repository before this was added, rebuild:

```sh
docker compose build --no-cache
docker compose up -d
```

Verify the sidecar is running:

```sh
docker ps                          # bgutil-provider should be Up
```

Do not capture verbose downloader output in ordinary logs or public support. Live source checks require separate authorization and private scope.

**2. Optional cookies**

Some source downloads may require authenticated access. Docker cookie configuration is optional; follow the Operator Runbook's optional-cookie instructions for its read-only mount. Cookies can expire. If a source stops working after previously succeeding, check the private cookie file and network configuration without posting cookies, paths, URLs, or raw errors in support.

### Refresh `yt-dlp` And Chrome Dependencies

If YouTube Shorts fail with an `n challenge solving failed` warning or `Requested format is not available`, rebuild the image so Docker installs the current `yt-dlp[default]` package and challenge solver scripts:

```sh
docker compose build --no-cache
docker compose up -d
```

### Recover From Chrome Profile Locks

The bot removes stale Chromium `SingletonLock`, `SingletonSocket`, and `SingletonCookie` files at startup. If Chrome still reports that the profile is in use, restart cleanly:

```sh
docker compose down
docker compose up -d
```

### Authentication Failure

Preserve database and LocalAuth data. Diagnose privately, then use the stopped-service one-shot login flow if authentication intervention is needed. Do not delete auth/database volumes to force recovery. Never restore a database alone or roll back a stale snapshot after later sends; follow the paired quiesced backup/restore section in the Operator Runbook.

## Manual Smoke Test

- Create a private WhatsApp test group.
- Add the bot account and make it group admin.
- Only with explicit live-account authorization: stop the normal service, use private one-shot login, then start it.
- Restart the container and confirm the session persists without a new QR scan.
- Send `!bot status` and confirm bot admin shows `yes`.
- Send `!bot enable` and confirm enabled response.
- Send one YouTube Shorts link, one Instagram reel link, and one Instagram post link.
- Confirm reposts, captions, equivalent-link duplicate skips, and the guarded cleanup behavior. A newly accepted link-only source may be removed automatically after every required inline-video repost is confirmed; do not use content that must remain visible.
- Test an Instagram collection containing several videos and a photo, then a link selecting a video with `img_index`. Verify video order, photo omission, selected-item attribution, and that sources with skipped photo content remain intact.
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
