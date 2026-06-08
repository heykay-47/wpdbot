import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { formatCaption } from './caption';
import { extractFirstSupportedUrl, normalizeUrlForDuplicate } from './url';
import type { Store } from './store';

export type IncomingMessage = {
  id: string;
  groupId: string;
  senderId: string;
  senderName: string;
  body: string;
  timestampMs: number;
  isGroup: boolean;
  fromMe: boolean;
};

export type RelayWhatsapp = {
  sendVideo(groupId: string, filePath: string, caption: string): Promise<void>;
  sendText(groupId: string, text: string): Promise<void>;
  deleteMessage(messageId: string): Promise<void>;
};

export type RelayDownloader = {
  download(url: string, maxFileSizeMb: number): Promise<{ filePath: string; sizeBytes: number }>;
};

export type HandleIncomingMessageInput = {
  message: IncomingMessage;
  store: Store;
  whatsapp: RelayWhatsapp;
  downloader: RelayDownloader;
  timezone: string;
  nowMs?: number;
  cleanupPath?: (filePath: string) => Promise<void>;
};

function hashUrl(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function defaultCleanupPath(filePath: string): Promise<void> {
  await rm(filePath, { force: true }).catch(() => undefined);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'unknown error';
}

export async function handleIncomingMessage({
  message,
  store,
  whatsapp,
  downloader,
  timezone,
  nowMs = Date.now(),
  cleanupPath = defaultCleanupPath,
}: HandleIncomingMessageInput): Promise<void> {
  if (!message.isGroup || message.fromMe) return;

  const supportedUrl = extractFirstSupportedUrl(message.body);
  if (!supportedUrl) return;

  const settings = store.getGroupSettings(message.groupId);
  if (!settings.enabled) return;

  const normalizedUrl = normalizeUrlForDuplicate(supportedUrl.url);
  const urlHash = hashUrl(normalizedUrl);
  if (store.wasRecentlyPosted(message.groupId, urlHash, nowMs, settings.duplicateWindowHours)) return;

  let filePath: string | null = null;

  try {
    let download: { filePath: string; sizeBytes: number };
    try {
      download = await downloader.download(supportedUrl.url, settings.maxFileSizeMb);
    } catch (error) {
      await whatsapp.sendText(message.groupId, `Could not download this video: ${errorMessage(error)}`);
      return;
    }

    filePath = download.filePath;

    try {
      await whatsapp.sendVideo(
        message.groupId,
        download.filePath,
        formatCaption({
          displayName: message.senderName,
          timestampMs: message.timestampMs,
          timezone,
          originalUrl: supportedUrl.url,
        }),
      );
    } catch (error) {
      await whatsapp.sendText(message.groupId, `Could not upload this video: ${errorMessage(error)}`);
      return;
    }

    try {
      await whatsapp.deleteMessage(message.id);
    } catch (error) {
      await whatsapp.sendText(
        message.groupId,
        `Video posted, but I could not delete the original message: ${errorMessage(error)}`,
      );
    }

    try {
      store.recordSuccessfulRepost({
        groupId: message.groupId,
        senderId: message.senderId,
        url: supportedUrl.url,
        urlHash,
        createdAtMs: nowMs,
      });
    } catch (error) {
      await whatsapp.sendText(message.groupId, `Video posted, but I could not save repost history: ${errorMessage(error)}`);
    }
  } finally {
    if (filePath) await cleanupPath(filePath).catch(() => undefined);
  }
}
