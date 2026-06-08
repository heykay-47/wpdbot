import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
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
};

function hashUrl(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function cleanupDownloadedPath(filePath: string | null): Promise<void> {
  if (!filePath) return;

  const parent = dirname(filePath);
  const target = basename(parent).startsWith('download-') ? parent : filePath;
  await rm(target, { force: true, recursive: true }).catch(() => undefined);
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
}: HandleIncomingMessageInput): Promise<void> {
  if (!message.isGroup || message.fromMe) return;

  const supportedUrl = extractFirstSupportedUrl(message.body);
  if (!supportedUrl) return;

  const settings = store.getGroupSettings(message.groupId);
  if (!settings.enabled) return;

  const normalizedUrl = normalizeUrlForDuplicate(supportedUrl.url);
  const urlHash = hashUrl(normalizedUrl);
  if (store.wasRecentlyPosted(message.groupId, urlHash, message.timestampMs, settings.duplicateWindowHours)) return;

  let filePath: string | null = null;

  try {
    const download = await downloader.download(supportedUrl.url, settings.maxFileSizeMb);
    filePath = download.filePath;

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

    await whatsapp.deleteMessage(message.id).catch(() => undefined);
    store.recordDuplicate(message.groupId, urlHash, message.timestampMs);
    store.recordRepost({
      groupId: message.groupId,
      senderId: message.senderId,
      url: supportedUrl.url,
      urlHash,
      createdAtMs: message.timestampMs,
    });
  } catch (error) {
    await whatsapp.sendText(message.groupId, `Could not download this video: ${errorMessage(error)}`);
  } finally {
    await cleanupDownloadedPath(filePath);
  }
}
