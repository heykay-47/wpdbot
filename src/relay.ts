import { createHash } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { formatCaption } from './caption.js';
import type { Downloader } from './downloader.js';
import { messageForError, userError, type ErrorReportContext } from './errorReporter.js';
import type { KeyedTaskQueue } from './keyedTaskQueue.js';
import { extractFirstSupportedUrl, normalizeUrlForDuplicate } from './extractors.js';
import { candidateMediaIdentity, sourceRequestKey, type MediaIdentity } from './mediaIdentity.js';
import type { MediaRepostKey, RepostConfirmation, Store } from './store.js';

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
  sendVideoOnce(groupId: string, filePath: string, caption: string, deliveryMode?: 'document'): Promise<RepostConfirmation>;
  sendText(groupId: string, text: string): Promise<void>;
  deleteMessage(messageId: string): Promise<void>;
};

export type RelayDownloader = {
  download(url: string, maxFileSizeMb: number): Promise<{ filePath: string; sizeBytes: number; tempDir?: string; deliveryMode?: 'video' | 'document' }>;
  resolveYouTube: Downloader['resolveYouTube'];
  resolveInstagram: Downloader['resolveInstagram'];
};

export type HandleIncomingMessageInput = {
  message: IncomingMessage;
  store: Pick<Store, 'getGroupSettings' | 'wasRecentlyPosted' | 'getMediaDisposition' | 'beginMediaRepost' | 'confirmMediaRepost'>;
  whatsapp: RelayWhatsapp;
  downloader: RelayDownloader;
  timezone: string;
  downloadDir?: string;
  maxMediaSizeMb?: number;
  nowMs?: number;
  now?: () => number;
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

async function handleIncomingMessageCore(input: HandleIncomingMessageInput, errorContext: ErrorReportContext): Promise<void> {
  const { message, store, queue } = input;
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
  if (settings.duplicateWindowHours > 0 && store.wasRecentlyPosted(message.groupId, urlHash, processingNow(input), settings.duplicateWindowHours)) return;

  const runRelay = async () => {
    const currentSettings = store.getGroupSettings(message.groupId);
    if (!currentSettings.enabled) return;
    errorContext.step = 'duplicate-check';
    if (currentSettings.duplicateWindowHours > 0 && store.wasRecentlyPosted(message.groupId, urlHash, processingNow(input), currentSettings.duplicateWindowHours)) return;
    if (supportedUrl.extractorId === 'instagram') {
      await relayInstagram(input, supportedUrl.url, urlHash, errorContext);
      return;
    }
    await relayYouTube(input, supportedUrl.url, urlHash, errorContext);
  };

  const queueKey = JSON.stringify([message.groupId, sourceRequestKey(supportedUrl.url)]);
  if (queue) await queue.run(queueKey, runRelay);
  else await runRelay();
}

async function relayYouTube(input: HandleIncomingMessageInput, url: string, urlHash: string, errorContext: ErrorReportContext): Promise<void> {
  const { message, store, downloader } = input;
  if (!message.id.trim()) throw userError('YouTube relay needs a source message ID. Original message kept.');
  const candidate = candidateMediaIdentity(url);
  if (candidate) {
    const progress = store.getMediaDisposition({ groupId: message.groupId, messageId: message.id, identity: candidate },
      processingNow(input), store.getGroupSettings(message.groupId).duplicateWindowHours);
    if (progress === 'completed' || progress === 'duplicate') return;
    if (progress === 'held') throw unresolvedSendError('youtube');
  }
  errorContext.step = 'download';
  const video = await downloader.resolveYouTube(url).catch(() => {
    throw userError('Could not establish this YouTube video identity. Original message kept.');
  });
  const key = { groupId: message.groupId, messageId: message.id, identity: { platform: 'youtube' as const, videoId: video.id } };
  errorContext.step = 'duplicate-check';
  const progress = store.getMediaDisposition(key, processingNow(input), store.getGroupSettings(message.groupId).duplicateWindowHours);
  if (progress === 'completed' || progress === 'duplicate') return;
  if (progress === 'held') throw unresolvedSendError('youtube');
  errorContext.step = 'download';
  const download = await video.download(store.getGroupSettings(message.groupId).maxFileSizeMb).catch((error: unknown) => {
    throw userError(`Could not download this video: ${safeDownloadMessage(error)} Original message kept.`);
  });
  await submitMedia(input, {
    key, url, urlHash, download,
    unknownMessage: 'YouTube delivery is unknown. No automatic retry. Original message kept.',
  }, errorContext);
}

async function relayInstagram(input: HandleIncomingMessageInput, url: string, urlHash: string, errorContext: ErrorReportContext): Promise<void> {
  const { message, store, whatsapp, downloader } = input;
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
    const key = { groupId: message.groupId, messageId: message.id, identity: { platform: 'instagram' as const, postId: source.id, itemId: item.id } };
    errorContext.step = 'record';
    const progress = store.getMediaDisposition(key, processingNow(input), store.getGroupSettings(message.groupId).duplicateWindowHours);
    if (progress === 'completed' || progress === 'duplicate') continue;
    if (progress === 'held') throw unresolvedSendError('instagram');

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

    await submitMedia(input, {
      key, url, urlHash, download,
      captionSuffix: source.totalItems > 1 ? `\nInstagram item ${item.index} of ${source.totalItems}` : '',
      unknownMessage: `Instagram item ${item.index} delivery is unknown. No automatic retry. Original message kept.`,
    }, errorContext);
  }

  if (skippedItems || !complete || !hasVideo) {
    await whatsapp.sendText(message.groupId, hasVideo
      ? 'Photos or unresolved Instagram items were not reposted. Original message kept.'
      : 'No verifiable video in this Instagram post or selected item. Original message kept.');
  }
}

type MediaSubmission = {
  key: MediaRepostKey;
  url: string;
  urlHash: string;
  download: Awaited<ReturnType<RelayDownloader['download']>>;
  captionSuffix?: string;
  unknownMessage: string;
};

async function submitMedia(input: HandleIncomingMessageInput, submission: MediaSubmission, errorContext: ErrorReportContext): Promise<void> {
  const { message, store, whatsapp, timezone, downloadDir, cleanupPath } = input;
  const { key, url, urlHash, download, captionSuffix, unknownMessage } = submission;
  try {
    const settings = store.getGroupSettings(message.groupId);
    if (!settings.enabled) throw userError(key.identity.platform === 'instagram'
      ? 'Bot disabled. Remaining Instagram items were not reposted. Original message kept.'
      : 'Bot disabled. Video was not reposted. Original message kept.');
    const caption = formatCaption({ displayName: message.senderName, timestampMs: message.timestampMs, timezone, originalUrl: url }) + (captionSuffix ?? '');
    const limit = Math.min(settings.maxFileSizeMb, input.maxMediaSizeMb ?? 64);
    const file = await stat(download.filePath);
    if (!Number.isSafeInteger(limit) || limit <= 0 || !file.isFile() || file.size === 0 || file.size > limit * 1024 * 1024) {
      throw userError('Video no longer meets the current media size limit. Original message kept.');
    }
    errorContext.step = 'record';
    const record = { groupId: message.groupId, senderId: message.senderId, url, urlHash, createdAtMs: processingNow(input) };
    const reservation = store.beginMediaRepost(key, record, settings.duplicateWindowHours);
    if (reservation === 'completed' || reservation === 'duplicate') return;
    if (reservation === 'held') throw unresolvedSendError(key.identity.platform);
    errorContext.step = 'upload';
    const confirmation = await (download.deliveryMode === 'document'
      ? whatsapp.sendVideoOnce(message.groupId, download.filePath, caption, 'document')
      : whatsapp.sendVideoOnce(message.groupId, download.filePath, caption)).catch(() => {
      throw userError(unknownMessage);
    });
    errorContext.step = 'record';
    store.confirmMediaRepost(key, confirmation, { ...record, createdAtMs: processingNow(input) });
  } finally {
    await cleanupDownload(download, downloadDir, cleanupPath);
  }
}

function unresolvedSendError(platform: MediaIdentity['platform']): Error {
  const name = platform === 'instagram' ? 'An Instagram' : 'A YouTube';
  return userError(`${name} video has an unresolved send. No automatic retry. Original message kept.`);
}

function processingNow(input: HandleIncomingMessageInput): number {
  return input.now?.() ?? input.nowMs ?? Date.now();
}
