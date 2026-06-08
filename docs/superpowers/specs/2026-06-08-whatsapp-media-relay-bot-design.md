# WhatsApp Media Relay Bot Design

Date: 2026-06-08

## Goal

Build a Dockerized WhatsApp bot for family and small group chats. When someone posts a supported video link, the bot downloads the video, reposts it directly in the same WhatsApp group, attributes the sender and timestamp, then deletes the original link message after successful repost.

Supported platforms for the first version:

- YouTube
- Instagram
- Facebook

The bot uses an unofficial WhatsApp Web session through `whatsapp-web.js`, so it is intended for personal use, not a public commercial service.

## Chosen Approach

Use one Node.js service with:

- `whatsapp-web.js` for WhatsApp Web connection, message events, media sending, and message deletion.
- `yt-dlp` CLI for video downloads from YouTube, Instagram, and Facebook.
- SQLite for persistent group settings and duplicate tracking.
- Docker for portable deployment on local machines, student-friendly free hosting, or DigitalOcean.

This keeps the first version simple while leaving room for later scaling with queues or workers.

## Core Constraints

- Bot runs as a separate WhatsApp number.
- Bot must be added to target groups.
- Bot must be WhatsApp group admin before `!bot enable` succeeds.
- Bot deletes original link messages only after video upload succeeds.
- WhatsApp upload limits and practical bandwidth limits apply.
- `whatsapp-web.js` and WhatsApp Web behavior can break when WhatsApp changes internals.
- Downloading/reposting platform videos may be subject to platform terms and copyright rules. Bot is for private group convenience.

## Architecture

Single Docker container runs the bot service.

Components:

- WhatsApp client: manages QR login, persistent session, group message events, contact/chat lookup, message delete, and media upload.
- Message router: filters group messages, ignores bot messages, extracts supported links, and routes commands versus video links.
- Command handler: processes group commands.
- Permission checker: validates group admin status and bot owner override.
- Downloader service: invokes `yt-dlp`, writes video to temp storage, returns local file path and metadata.
- Media sender: sends video back to WhatsApp group with attribution caption.
- Cleanup handler: deletes temp files and deletes original WhatsApp message after successful repost.
- SQLite store: persists group settings, duplicate cache, message history, and bot owner config-derived identity.

## Message Flow

1. A group member sends a YouTube, Instagram, or Facebook URL.
2. Bot receives the message event.
3. Bot ignores the message if it is not a group message, was sent by the bot, or belongs to a disabled group.
4. Bot extracts the first supported URL from the message.
5. Bot checks the group duplicate policy.
6. Bot downloads the video using `yt-dlp` into a temp directory.
7. Bot checks the downloaded file size against the group max size.
8. Bot sends the video to the same group.
9. Bot deletes the original link message only after the video message is sent successfully.
10. Bot records repost history and duplicate cache data.

Only the first supported URL in a message is processed in version one.

## Caption Format

Video caption:

```text
Sent by <display name> at <timestamp>
Original: <url>
```

Default timezone is configurable and starts as `Asia/Kolkata`.

Default timestamp format:

```text
DD MMM YYYY, h:mm A z
```

Example:

```text
Sent by Mom at 08 Jun 2026, 7:42 PM IST
Original: https://youtube.com/...
```

## Commands

Commands are sent in group chat.

- `!bot enable`: enables video relay in current group.
- `!bot disable`: disables video relay in current group.
- `!bot status`: shows enabled state, max file size, duplicate window, supported platforms, and bot admin status.

Permission rules:

- WhatsApp group admins can manage the bot in their group.
- Bot owner can manage the bot in any group.
- Non-admin users receive a short denial response for management commands.
- `!bot enable` fails if the bot is not currently a group admin.

## Configuration

Environment variables configure global defaults:

- Bot owner WhatsApp ID or number.
- Default timezone, initially `Asia/Kolkata`.
- Default max file size, initially `64 MB`.
- Default duplicate window, initially `24 hours`.
- Download temp directory path.
- SQLite database path.

SQLite stores per-group runtime state:

- Group enabled or disabled.
- Per-group max file size.
- Per-group duplicate window.
- URL duplicate hashes.
- Repost history.
- Last known group metadata needed for status output.

Docker volumes persist:

- WhatsApp Web auth/session data.
- SQLite database.
- Optional temp download directory, if not using ephemeral container storage.

## Duplicate Policy

Duplicate handling is configurable per group.

Default behavior:

- Skip duplicate URLs within 24 hours.
- Use normalized URL hash for matching.
- Store group ID with each URL hash so duplicates are scoped per group.

Version one exposes duplicate policy through configuration/defaults and `!bot status`. Chat commands for changing duplicate policy are deferred.

## Error Handling

The bot sends a concise group error message when a relay fails.

Failure cases:

- Unsupported URL: ignored.
- Download failure: original link remains; bot posts short failure reason.
- File larger than configured max size: original link remains; bot posts size error.
- Upload failure: original link remains; bot posts upload error.
- Bot not admin during enable: command fails with clear message.
- Bot loses admin rights after enable: relay may fail to delete original message; status should report missing admin rights.

Safety rules:

- Never delete original link before successful video upload.
- Always ignore bot's own messages.
- Always clean temp files after success or failure.
- Avoid logging full sensitive session data.
- Store URL hashes for duplicate detection; keep original URL only where needed for caption/history.

## Testing Strategy

Automated tests:

- URL extraction for YouTube, Instagram, Facebook, and unsupported links.
- Command parsing for `!bot enable`, `!bot disable`, and `!bot status`.
- Permission decisions for group admins, bot owner, and normal members.
- Duplicate policy decisions.
- Caption formatting with timezone.
- File size limit behavior.
- Message flow with mocked WhatsApp client and mocked `yt-dlp` runner.

Manual smoke test:

- Create private WhatsApp test group.
- Add bot account and make it admin.
- Scan QR and confirm persistent session survives container restart.
- Enable bot in test group.
- Send one supported YouTube link, one Instagram link, and one Facebook link.
- Confirm video repost, caption, original message deletion, duplicate handling, and failure message for oversized video.

## Out Of Scope For Version One

- Compression/downscaling of large videos.
- Multiple URLs from one message.
- Public SaaS usage.
- Web dashboard.
- Queue-based multi-worker download architecture.
- Generic video link support outside YouTube, Instagram, and Facebook.
- Chat commands for changing every per-group setting.

## Open Risks

- WhatsApp may change Web internals and break unofficial clients.
- WhatsApp account may face restrictions if behavior looks automated or spammy.
- `yt-dlp` support for Instagram/Facebook may require cookies for some private, age-gated, or region-limited content.
- Large uploads may be slow or fail on free hosting or low-memory machines.
- Deleting someone else's group message depends on WhatsApp admin capabilities exposed through Web behavior.
