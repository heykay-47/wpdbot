import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { formatCaption } from './caption.js';
import { messageForError, userError, type ErrorReportContext } from './errorReporter.js';
import { KeyedTaskQueue } from './keyedTaskQueue.js';
import { TempFileTracker } from './tempFileTracker.js';
import { extractFirstSupportedUrl, normalizeUrlForDuplicate } from './url.js';
import type { Store } from './store.js';

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
  download(url: string, maxFileSizeMb: number): Promise<{ filePath: string; sizeBytes: number; tempDir?: string }>;
};

export type HandleIncomingMessageInput = {
  message: IncomingMessage;
  store: Store;
  whatsapp: RelayWhatsapp;
  downloader: RelayDownloader;
  timezone: string;
  downloadDir?: string;
  nowMs?: number;
  cleanupPath?: (filePath: string) => Promise<void>;
  queue?: KeyedTaskQueue;
  logger?: (entry: Record<string, unknown>) => void;
};

function hashUrl(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isDirectDownloadSubdir(parentDir: string, downloadDir: string): boolean {
  const relativeParent = relative(resolve(downloadDir), resolve(parentDir));
  return basename(parentDir).startsWith('download-') && relativeParent !== '' && !relativeParent.startsWith('..') && !relativeParent.includes('..');
}

async function defaultCleanupPath(filePath: string, downloadDir?: string): Promise<void> {
  const parentDir = dirname(filePath);
  const target = downloadDir && isDirectDownloadSubdir(parentDir, downloadDir) ? parentDir : filePath;
  await rm(target, { force: true, recursive: target === parentDir }).catch(() => undefined);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'unknown error';
}

function safeDownloadMessage(error: unknown): string {
  const message = errorMessage(error);
  if (/^(Downloaded file exceeds|Video exceeds)\b/u.test(message)) return message;
  return 'Download unavailable or blocked.';
}

function safeUploadMessage(): string {
  return 'Upload failed.';
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
    await performRelayWork({
      message,
      store,
      whatsapp,
      downloader,
      timezone,
      downloadDir,
      nowMs,
      cleanupPath,
      supportedUrl: supportedUrl.url,
      extractorId: supportedUrl.extractorId,
      urlHash,
      maxFileSizeMb: settings.maxFileSizeMb,
      errorContext,
    });
  };

  const queueKey = `${message.groupId}:${urlHash}`;
  if (queue) await queue.run(queueKey, runRelay);
  else await runRelay();
}

type PerformRelayWorkInput = {
  message: IncomingMessage;
  store: Store;
  whatsapp: RelayWhatsapp;
  downloader: RelayDownloader;
  timezone: string;
  downloadDir?: string;
  nowMs: number;
  cleanupPath?: (filePath: string) => Promise<void>;
  supportedUrl: string;
  extractorId: string;
  urlHash: string;
  maxFileSizeMb: number;
  errorContext: ErrorReportContext;
};

async function performRelayWork({
  message,
  store,
  whatsapp,
  downloader,
  timezone,
  downloadDir,
  nowMs,
  cleanupPath,
  supportedUrl,
  extractorId,
  urlHash,
  maxFileSizeMb,
  errorContext,
}: PerformRelayWorkInput): Promise<void> {
  errorContext.urlHash = urlHash;
  errorContext.extractorId = extractorId;
  const tracker = new TempFileTracker();
  let filePath: string | null = null;
  let tempDir: string | null = null;

  try {
    let download: { filePath: string; sizeBytes: number; tempDir?: string };
    try {
      errorContext.step = 'download';
      download = await downloader.download(supportedUrl, maxFileSizeMb);
    } catch (error) {
      throw userError(`Could not download this video: ${safeDownloadMessage(error)}`);
    }

    filePath = download.filePath;
    tempDir = download.tempDir ?? null;
    if (tempDir && downloadDir && isDirectDownloadSubdir(tempDir, downloadDir)) {
      tracker.addDirectory(tempDir);
    } else if (tempDir) {
      tracker.addFile(filePath);
    }

    try {
      errorContext.step = 'upload';
      await whatsapp.sendVideo(
        message.groupId,
        download.filePath,
        formatCaption({
          displayName: message.senderName,
          timestampMs: message.timestampMs,
          timezone,
          originalUrl: supportedUrl,
        }),
      );
    } catch (error) {
      throw userError(`Could not upload this video: ${safeUploadMessage()}`);
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
        url: supportedUrl,
        urlHash,
        createdAtMs: nowMs,
      });
    } catch (error) {
      messageForError(error, errorContext);
      await whatsapp.sendText(message.groupId, 'Video posted, but repost history could not be saved.');
    }
  } finally {
    if (cleanupPath && filePath) await cleanupPath(filePath).catch(() => undefined);
    else if (tempDir) await tracker.cleanup();
    else if (filePath) await defaultCleanupPath(filePath, downloadDir).catch(() => undefined);
  }
}
