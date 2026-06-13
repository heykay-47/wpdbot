# Docker Reliability Hardening Design

Date: 2026-06-13

## Goal

Make `wpdbot` more reliable for people who clone the project and run it with Docker Compose. The first priority is clone-and-run reliability: prevent common startup failures, improve YouTube Shorts download readiness inside the image, and document simple recovery paths.

The design targets these observed failures:

- Chrome refuses to start because a persisted profile appears locked by another process.
- `yt-dlp` cannot solve YouTube's JavaScript challenge and reports missing formats.
- WhatsApp video upload can fail after download or transcode.

## Chosen Approach

Use Docker reliability hardening plus a small documentation update.

- Add startup cleanup for stale Chromium profile lock files in bot-controlled directories.
- Launch Puppeteer with explicit Chrome profile/cache paths owned by the container user.
- Add Docker runtime support for `yt-dlp` YouTube challenge handling, accepting a larger image when needed.
- Keep existing relay behavior, commands, persistence model, and downloader API unchanged.
- Document manual recovery steps for cases automatic cleanup cannot safely fix.

This approach fixes root causes for common Docker users without introducing queues, new services, or broad behavior changes.

## Scope

In scope:

- Docker startup reliability for WhatsApp Web and Chrome.
- Docker image dependencies needed by Chrome, `ffmpeg`, `yt-dlp`, and YouTube challenge solving.
- README troubleshooting for rebuilds, restarts, stale profile state, and corrupt sessions.
- Tests around startup cleanup helper behavior where practical.

Out of scope:

- Public SaaS deployment support.
- Replacing `whatsapp-web.js`.
- Replacing `yt-dlp` with a different downloader.
- Adding background queues or multi-worker processing.
- Guaranteeing every YouTube or Instagram URL works when upstream services block access or require cookies.

## Architecture

Add one startup reliability layer before WhatsApp client initialization.

Components:

- WhatsApp runtime prep: prepares known writable runtime directories and removes stale Chromium singleton lock files.
- Puppeteer launch config: uses explicit Chrome executable, user data directory, and cache directory.
- Docker runtime dependencies: includes Chrome, `ffmpeg`, Python, `yt-dlp`, and JavaScript runtime support used by `yt-dlp` challenge solving.
- README troubleshooting: explains rebuild and recovery commands for clone users.

The existing app remains a single Node.js service. It still uses `whatsapp-web.js` for WhatsApp Web, `yt-dlp` for downloads, and SQLite for persistent group settings.

## Startup Flow

1. Container starts as the `wpdbot` user.
2. App creates required runtime directories if missing.
3. App removes stale Chromium singleton lock files only inside bot-controlled Chrome profile/cache directories.
4. App creates the WhatsApp client with explicit Puppeteer profile/cache configuration.
5. WhatsApp Web initializes normally, using existing persisted session data if valid.
6. QR flow appears only when no valid session exists.

The cleanup must not delete WhatsApp auth credentials. It only removes lock artifacts that can survive unclean container shutdowns.

## Chrome Profile And Cache

Use deterministic paths under `/app` so Docker volumes and ownership are clear.

Recommended paths:

- WhatsApp auth: `/app/.wwebjs_auth`
- WhatsApp cache: `/app/.wwebjs_cache`
- Chrome profile: `/app/.wwebjs_auth/chrome-profile`
- Chrome cache: `/app/.wwebjs_cache/chrome-cache`

Puppeteer should receive these paths explicitly through `userDataDir` and Chrome args. This prevents Chrome from using an unexpected default profile and reduces collision risk after restarts.

## Lock Cleanup Rules

Startup cleanup may delete these files when they exist under the configured Chrome profile/cache directories:

- `SingletonLock`
- `SingletonSocket`
- `SingletonCookie`

Cleanup must be intentionally narrow:

- Do not recursively delete profile directories.
- Do not remove WhatsApp session credential files.
- Do not remove files outside the configured profile/cache roots.
- Log a short message when stale lock files are removed.

This handles the Docker error where Chrome reports the profile is in use by another process after a crashed or interrupted previous container.

## Downloader Runtime

The Docker image should include runtime support for `yt-dlp` YouTube challenge solving. `yt-dlp` already runs from a Python virtualenv in the image; the image should also provide the JavaScript runtime/solver support expected by current `yt-dlp` YouTube extraction.

Download behavior stays unchanged in the application code for this design:

- `src/downloader.ts` invokes `yt-dlp` with current format preferences and max file size.
- It still writes into a temporary download directory and returns the downloaded file path.
- If YouTube only exposes images or no requested formats, the bot still sends a download failure message and preserves the original WhatsApp message.

The goal is to make Docker builds include the support pieces that `yt-dlp` warns about, not to mask all upstream extraction failures.

## WhatsApp Upload Failure

Existing upload behavior remains:

- Try sending the downloaded file as a video.
- If video upload fails, transcode with `ffmpeg` and retry.
- If transcoded upload fails with a recoverable send failure, retry as a document.
- If all upload attempts fail, post a concise upload error and preserve the original link message.

This design does not change upload flow because the first priority is Docker startup reliability. Upload behavior can be hardened in a later implementation pass if errors continue after startup and downloader fixes.

## User-Facing Errors And Docs

README should add a troubleshooting section for common clone-user failures:

- Rebuild image to refresh Docker-installed `yt-dlp` and dependencies.
- Restart cleanly with `docker compose down` and `docker compose up -d`.
- If Chrome profile lock persists, restart the container; startup cleanup should handle stale locks.
- If WhatsApp session becomes corrupt, remove only auth/cache volumes and scan QR again.
- Explain that some YouTube or Instagram links may still fail because upstream extraction can require cookies, regional access, or updated `yt-dlp` support.

Messages in WhatsApp should remain concise. Detailed remediation belongs in README and logs.

## Testing Strategy

Automated tests:

- Runtime prep removes known singleton lock files from configured profile/cache paths.
- Runtime prep leaves unrelated files and directories intact.
- Runtime prep does not delete files outside configured roots.
- Existing relay tests continue to pass.

Build verification:

- `npm test`
- `npm run build`
- Docker image build when Docker is available.

Manual smoke test:

- Build image from a clean clone.
- Start with `docker compose up -d` and scan QR.
- Restart container and confirm session persists.
- Simulate stale Chrome lock files in the configured profile path, restart, and confirm bot initializes.
- Send a YouTube Shorts link in a test group and confirm either successful repost or concise failure without container crash.

## Risks

- WhatsApp Web internals can still change and break `whatsapp-web.js`.
- `yt-dlp` can still fail when YouTube changes extraction behavior or requires cookies.
- Automatic lock cleanup is safe only because it is limited to Chrome singleton files in bot-controlled paths.
- Docker image size may increase because challenge-solving support is prioritized over a minimal image.

## Success Criteria

- A fresh clone can build and start with documented Docker commands.
- A crashed or interrupted container restart no longer fails because of stale Chrome singleton locks.
- Docker image includes `yt-dlp` challenge-solving runtime support.
- Existing command, relay, duplicate, cleanup, and upload behaviors remain unchanged unless explicitly covered by tests.
- README gives clear recovery steps for corrupt sessions and upstream downloader failures.
