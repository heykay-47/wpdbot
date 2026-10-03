import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { formatCaption } from './caption.js';
import type { Downloader } from './downloader.js';
import { messageForError, userError, type ErrorReportContext } from './errorReporter.js';
import type { KeyedTaskQueue } from './keyedTaskQueue.js';
import { extractFirstSupportedUrl, normalizeUrlForDuplicate } from './extractors.js';
import type { RepostConfirmation, Store } from './store.js';

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
  sendVideoOnce(groupId: string, filePath: string, caption: string): Promise<RepostConfirmation>;
  sendText(groupId: string, text: string): Promise<void>;
  deleteMessage(messageId: string): Promise<void>;
};

export type RelayDownloader = {
  download(url: string, maxFileSizeMb: number): Promise<{ filePath: string; sizeBytes: number; tempDir?: string }>;
  resolveInstagram: Downloader['resolveInstagram'];
};

export type HandleIncomingMessageInput = {
  message: IncomingMessage;
  store: Pick<Store, 'getGroupSettings' | 'wasRecentlyPosted' | 'recordSuccessfulRepost' | 'recordDuplicate' | 'getInstagramItem' | 'beginInstagramItem' | 'confirmInstagramItem'>;
  whatsapp: RelayWhatsapp;
  downloader: RelayDownloader;
  timezone: string;
  downloadDir?: string;
  nowMs?: number;
  cleanupPath?: (filePath: string) => Promise<void>;
  queue?: Pick<KeyedTaskQueue, 'run'>;
  logger?: (entry: Record<string, unknown>) => void;
};

function hashUrl(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isDirectDownloadSubdir(parentDir: string, downloadDir: string): boolean {
  const relativeParent = relative(resolve(downloadDir), resolve(parentDir));
  return basename(parentDir).startsWith('download-') && relativeParent !== '' && !relativeParent.startsWith('..') && !relativeParent.includes('..');
}

async function cleanupDownload(download: Awaited<ReturnType<RelayDownloader['download']>>, downloadDir?: string, cleanupPath?: HandleIncomingMessageInput['cleanupPath']): Promise<void> {
  if (cleanupPath) {
    await cleanupPath(download.filePath).catch(() => undefined);
    return;
  }
  const parentDir = download.tempDir || dirname(download.filePath);
  const recursive = Boolean(downloadDir && isDirectDownloadSubdir(parentDir, downloadDir));
  await rm(recursive ? parentDir : download.filePath, { force: true, recursive }).catch(() => undefined);
}

function safeDownloadMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/^(Downloaded file exceeds|Video exceeds)\b/u.test(message)) return message;
  return 'Download unavailable or blocked.';
}

export async function handleIncomingMessage(input: HandleIncomingMessageInput): Promise<void> {
  const errorContext: ErrorReportContext = {
    step: 'relay',
    groupId: input.message.groupId,
    messageId: input.message.id,
    logger: input.logger,
  };

  try {
    await handleIncomingMessageCore(input, errorContext);
  } catch (error) {
    const text = messageForError(error, errorContext);
    await input.whatsapp.sendText(input.message.groupId, text).catch((reportError: unknown) => {
      messageForError(reportError, errorContext);
    });
  }
}

async function handleIncomingMessageCore({
  message,
  store,
  whatsapp,
  downloader,
  timezone,
  downloadDir,
  nowMs = Date.now(),
  cleanupPath,
  queue,
}: HandleIncomingMessageInput, errorContext: ErrorReportContext): Promise<void> {
  if (!message.isGroup || message.fromMe) return;

  const supportedUrl = extractFirstSupportedUrl(message.body);
  if (!supportedUrl) return;
  errorContext.extractorId = supportedUrl.extractorId;

  errorContext.step = 'settings';
  const settings = store.getGroupSettings(message.groupId);
  if (!settings.enabled) return;

  const normalizedUrl = normalizeUrlForDuplicate(supportedUrl.url);
  const urlHash = hashUrl(normalizedUrl);
  errorContext.urlHash = urlHash;

  errorContext.step = 'duplicate-check';
  if (store.wasRecentlyPosted(message.groupId, urlHash, nowMs, settings.duplicateWindowHours)) return;

  const runRelay = async () => {
    errorContext.step = 'duplicate-check';
    if (store.wasRecentlyPosted(message.groupId, urlHash, nowMs, settings.duplicateWindowHours)) return;
    if (supportedUrl.extractorId === 'instagram') {
      await relayInstagram({ message, store, whatsapp, downloader, timezone, downloadDir, nowMs, cleanupPath }, supportedUrl.url, urlHash, errorContext);
      return;
    }
    let download: Awaited<ReturnType<RelayDownloader['download']>>;

    try {
      errorContext.step = 'download';
      download = await downloader.download(supportedUrl.url, settings.maxFileSizeMb);
    } catch (error) {
      throw userError(`Could not download this video: ${safeDownloadMessage(error)}`);
    }

    try {
      try {
        errorContext.step = 'upload';
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
      } catch {
        throw userError('Could not upload this video: Upload failed.');
      }

      try {
        errorContext.step = 'delete';
        await whatsapp.deleteMessage(message.id);
      } catch (error) {
        messageForError(error, errorContext);
        await whatsapp.sendText(message.groupId, 'Video posted, but I could not delete the original message.');
      }

      try {
        errorContext.step = 'record';
        store.recordSuccessfulRepost({
          groupId: message.groupId,
          senderId: message.senderId,
          url: supportedUrl.url,
          urlHash,
          createdAtMs: nowMs,
        });
      } catch (error) {
        messageForError(error, errorContext);
        await whatsapp.sendText(message.groupId, 'Video posted, but repost history could not be saved.');
      }
    } finally {
      await cleanupDownload(download, downloadDir, cleanupPath);
    }
  };

  const queueKey = `${message.groupId}:${urlHash}`;
  if (queue) await queue.run(queueKey, runRelay);
  else await runRelay();
}

async function relayInstagram(input: HandleIncomingMessageInput, url: string, urlHash: string, errorContext: ErrorReportContext): Promise<void> {
  const { message, store, whatsapp, downloader, timezone, downloadDir, cleanupPath, nowMs = Date.now() } = input;
  if (!message.id.trim()) throw userError('Instagram relay needs a source message ID. Original message kept.');
  errorContext.step = 'download';
  const source = await downloader.resolveInstagram(url).catch(() => {
    throw userError('Could not inspect this Instagram post or selected item. Original message kept.');
  });
  let complete = true;
  let hasVideo = false;
  let skippedItems = false;

  for (const item of source.items) {
    if (item.kind !== 'video') {
      skippedItems = true;
      continue;
    }
    hasVideo = true;
    const key = { groupId: message.groupId, messageId: message.id, postId: source.id, itemId: item.id };
    errorContext.step = 'record';
    const progress = store.getInstagramItem(key);
    if (progress?.status === 'confirmed') continue;
    if (progress) throw userError('An Instagram video has an unresolved send. No automatic retry. Original message kept.');

    let download: Awaited<ReturnType<RelayDownloader['download']>>;
    try {
      errorContext.step = 'download';
      download = await item.download(store.getGroupSettings(message.groupId).maxFileSizeMb);
    } catch (error) {
      complete = false;
      await whatsapp.sendText(message.groupId, `Could not download Instagram item ${item.index}: ${safeDownloadMessage(error)} Original message kept.`).catch((reportError: unknown) => {
        messageForError(reportError, errorContext);
      });
      continue;
    }

    try {
      if (!store.getGroupSettings(message.groupId).enabled) {
        throw userError('Bot disabled. Remaining Instagram items were not reposted. Original message kept.');
      }
      errorContext.step = 'record';
      if (!store.beginInstagramItem(key, nowMs)) {
        if (store.getInstagramItem(key)?.status === 'confirmed') continue;
        throw userError('An Instagram video has an unresolved send. No automatic retry. Original message kept.');
      }
      const caption = formatCaption({ displayName: message.senderName, timestampMs: message.timestampMs, timezone, originalUrl: url })
        + (source.totalItems > 1 ? `\nInstagram item ${item.index} of ${source.totalItems}` : '');
      errorContext.step = 'upload';
      const confirmation = await whatsapp.sendVideoOnce(message.groupId, download.filePath, caption).catch(() => {
        throw userError(`Instagram item ${item.index} delivery is unknown. No automatic retry. Original message kept.`);
      });
      errorContext.step = 'record';
      store.confirmInstagramItem(key, confirmation, {
        groupId: message.groupId, senderId: message.senderId, url, urlHash, createdAtMs: nowMs,
      });
    } finally {
      await cleanupDownload(download, downloadDir, cleanupPath);
    }
  }

  if (complete && hasVideo) {
    errorContext.step = 'record';
    store.recordDuplicate(message.groupId, urlHash, nowMs);
  }
  if (skippedItems || !complete || !hasVideo) {
    await whatsapp.sendText(message.groupId, hasVideo
      ? 'Photos or unresolved Instagram items were not reposted. Original message kept.'
      : 'No verifiable video in this Instagram post or selected item. Original message kept.');
  }
}
