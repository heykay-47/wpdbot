import { createHash } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { formatCaption } from './caption.js';
import type { Downloader } from './downloader.js';
import { downloadCause, errorFacts, messageForError, userError, UserFacingError, type ErrorReportContext } from './errorReporter.js';
import { formatSourceInspection, sourceMediaUnfinished } from './inspection.js';
import type { KeyedTaskQueue } from './keyedTaskQueue.js';
import { extractSupportedUrls, normalizeUrlForDuplicate } from './extractors.js';
import { candidateMediaIdentity, mediaIdentityKey, type MediaIdentity } from './mediaIdentity.js';
import type { MediaRepostKey, RepostConfirmation, RepostEvidence, RetryPassTarget, Store } from './store.js';
import { addCleanupDisqualification, UnsupportedRelayStateError, type CleanupDisqualification, type RelayItem, type RelayLink, type RelayPlan, type RelaySource } from './relayState.js';
import type { RelayLifecycle } from './relayLifecycle.js';
import { attemptGuardedSourceCleanup, isLinkOnlySource, type CleanupCheckResult, type CleanupDeleteResult, type CleanupSourceIdentity } from './sourceCleanup.js';

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
  sendVideo(groupId: string, filePath: string, caption: string): Promise<unknown>;
  sendVideoOnce(groupId: string, filePath: string, caption: string, deliveryMode?: 'document', observe?: (evidence: RepostEvidence) => void): Promise<RepostConfirmation>;
  sendText(groupId: string, text: string): Promise<void>;
  deleteMessage(groupId: string, messageId: string): Promise<void>;
  checkSourceForCleanup?(source: CleanupSourceIdentity): Promise<CleanupCheckResult>;
  deleteSourceForCleanup?(source: CleanupSourceIdentity, canInvoke: () => boolean): Promise<CleanupDeleteResult>;
};

export type RelayDownloader = {
  download(url: string, maxFileSizeMb: number): Promise<{ filePath: string; sizeBytes: number; tempDir?: string; deliveryMode?: 'video' | 'document' }>;
  resolveYouTube: Downloader['resolveYouTube'];
  resolveInstagram: Downloader['resolveInstagram'];
};

export type HandleIncomingMessageInput = {
  message: IncomingMessage;
  store: Pick<Store, 'getGroupSettings' | 'wasRecentlyPosted' | 'getMediaDisposition' | 'beginMediaRepost' | 'confirmMediaRepost'
    | 'acceptRelaySource' | 'getRelaySource' | 'saveRelaySource' | 'listRelaySources' | 'getMediaAttempt' | 'recordMediaEvidence'
    | 'isRetryPassActive' | 'hasActiveRetryPass' | 'revokeRetryPass' | 'completeRetryPass'
    | 'beginRelaySourceCleanup' | 'recordRelaySourceCleanupOutcome'>;
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
  control?: RelayLifecycle;
  retry?: RetryExecution;
};

export type RetryExecution = {
  passId: string;
  settingsRevision: number;
  requesterStillAuthorized(): Promise<boolean>;
  sourceAndPlanStillMatch(source: RelaySource, link: RelayLink): Promise<boolean>;
};

type ActiveInput = HandleIncomingMessageInput & { source: RelaySource; link: RelayLink };
export type RecoveryInput = Omit<HandleIncomingMessageInput, 'message'> & {
  whatsapp: RelayWhatsapp & {
    getSourceMessage(groupId: string, messageId: string): Promise<IncomingMessage | null>;
    lookupRepost(groupId: string, messageId: string): Promise<RepostConfirmation | null>;
  };
};

export function relayContentHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashUrl(value: string): string {
  return relayContentHash(value);
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

export async function handleIncomingMessage(input: HandleIncomingMessageInput): Promise<void> {
  if (input.control && !input.control.canSubmit()) return;
  const errorContext: ErrorReportContext = {
    step: 'relay',
    groupId: input.message.groupId,
    messageId: input.message.id,
    logger: input.logger,
  };

  try {
    await handleIncomingMessageCore(input, errorContext);
  } catch (error) {
    if (!(error instanceof UserFacingError) && !(error instanceof UnsupportedRelayStateError)) input.control?.failStorage();
    if (input.control && !input.control.canPersist()) return;
    await reportError(input, error instanceof UnsupportedRelayStateError ? userError('Unsupported source held', 'unsupported_state') : error, errorContext);
  }
}

async function handleIncomingMessageCore(input: HandleIncomingMessageInput, errorContext: ErrorReportContext): Promise<void> {
  const { message, store, queue } = input;
  if (!message.isGroup || message.fromMe) return;

  const links = extractSupportedUrls(message.body);
  if (!links.length) return;
  errorContext.extractorId = links[0].extractorId;

  errorContext.step = 'settings';
  const settings = store.getGroupSettings(message.groupId);
  if (!settings.enabled) return;

  if (!message.id.trim()) throw userError(`${links[0].platform === 'youtube' ? 'YouTube' : 'Instagram'} relay needs a source message ID. Original message kept.`);
  errorContext.step = 'record';
  const contentHash = relayContentHash(message.body);
  store.acceptRelaySource({
    version: 2, groupId: message.groupId, messageId: message.id, senderId: message.senderId,
    senderName: message.senderName, timestampMs: message.timestampMs, acceptedAtMs: processingNow(input),
    contentHash, status: 'ready', cleanup: { version: 1, initial: isLinkOnlySource(message.body, links) ? 'link-only' : 'mixed-content',
      initialFingerprint: contentHash, disqualifications: [], intentRecorded: false, outcome: 'not-attempted', noticeClaimed: false },
    links: links.map((link) => ({ url: link.url, platform: link.platform, urlHash: hashUrl(normalizeUrlForDuplicate(link.url)), status: 'ready', plan: null })),
  });

  const runRelay = async () => {
    if (input.control && !input.control.canPersist()) return;
    const source = store.getRelaySource(message.groupId, message.id)!;
    errorContext.reference = source.workReference;
    if (store.hasActiveRetryPass(message.groupId, message.id)) return;
    if (source.contentHash !== relayContentHash(message.body) || source.senderId !== message.senderId) {
      holdSource(input, source, 'source-changed');
      return;
    }
    if (source.status === 'settled' || source.status === 'held') {
      await maybeCleanupSource(input, source);
      return;
    }
    if (!checkpoint(input, source)) return;
    source.status = 'ready';
    const previousOutcomes = JSON.stringify(source.links);
    for (const link of source.links) {
      if (link.status !== 'ready') continue;
      errorContext.extractorId = link.platform;
      errorContext.urlHash = link.urlHash;
      errorContext.link = source.links.indexOf(link) + 1;
      errorContext.item = undefined;
      const active = { ...input, source, link };
      if (!checkpoint(input, source)) return;
      const currentSettings = store.getGroupSettings(message.groupId);
      if (!currentSettings.enabled) { source.status = 'paused'; break; }
      if (!link.plan && currentSettings.duplicateWindowHours > 0
        && store.wasRecentlyPosted(message.groupId, link.urlHash, processingNow(input), currentSettings.duplicateWindowHours)) {
        link.status = 'skipped';
        disqualifySourceCleanup(store, source, 'prior-message-duplicate');
        store.saveRelaySource(source);
        continue;
      }
      try {
        if (link.platform === 'instagram') await relayInstagram(active, link.url, link.urlHash, errorContext);
        else await relayYouTube(active, link.url, link.urlHash, errorContext);
      } catch (error) {
        if (!(error instanceof UserFacingError)) throw error;
        await reportError(input, error, errorContext);
      }
      if (['held', 'paused'].includes(source.status)) break;
    }
    if (source.status === 'ready' && !source.links.some((link) => link.status === 'ready'
      && (!link.plan || link.plan.items.some((item) => item.status === 'ready' || item.status === 'held')))) source.status = 'settled';
    if (!input.control || input.control.canPersist()) store.saveRelaySource(source);
    await maybeCleanupSource(input, source);
    if (input.control && !input.control.canSubmit()) return;
    const latest = store.getRelaySource(message.groupId, message.id);
    if (latest && latest.links.length > 1 && sourceMediaUnfinished(latest, store) && JSON.stringify(latest.links) !== previousOutcomes) {
      await input.whatsapp.sendText(message.groupId, `Relay update · source incomplete; original kept.\n${formatSourceInspection(store, latest)}`)
        .catch((error: unknown) => { messageForError(error, { ...errorContext, step: 'notification' }); });
    }
  };

  const queueKey = JSON.stringify([message.groupId, message.id]);
  if (queue) await queue.run(queueKey, runRelay);
  else await runRelay();
}

async function reportError(input: HandleIncomingMessageInput, error: unknown, context: ErrorReportContext): Promise<void> {
  if (!context.reference) {
    try { context.reference = input.store.getRelaySource(input.message.groupId, input.message.id)?.workReference; } catch { /* Reference unavailable before durable acceptance. */ }
  }
  const text = messageForError(error, context);
  if (input.control && !input.control.canSubmit()) return;
  await input.whatsapp.sendText(input.message.groupId, text).catch((reportError: unknown) => { messageForError(reportError, { ...context, step: 'notification' }); });
}

export async function recoverRelaySources(input: RecoveryInput): Promise<void> {
  const sources = input.store.listRelaySources();
  for (const entry of sources) {
    const run = async () => {
      if (input.control && !input.control.canPersist()) return;
      const source = input.store.getRelaySource(entry.groupId, entry.messageId)!;
      let sourceChanged = false;
      for (const link of source.links) {
        for (const item of link.plan?.items ?? []) {
          if (!item.identity || item.status === 'skipped') continue;
          const key = { groupId: source.groupId, messageId: source.messageId, identity: item.identity };
          const attempt = input.store.getMediaAttempt(key);
          if (attempt?.status === 'confirmed') {
            if (item.status !== 'confirmed') { item.status = 'confirmed'; sourceChanged = true; }
            continue;
          }
          if (item.status === 'failed') continue;
          if (attempt?.status !== 'sending' || !attempt.sentMessageId || attempt.sourceUrl !== link.url) continue;
          const evidence = await input.whatsapp.lookupRepost(source.groupId, attempt.sentMessageId).catch(() => null);
          if (input.control && !input.control.canPersist()) return;
          if (!evidence || evidence.messageId !== attempt.sentMessageId || !confirmedEvidence(evidence)) continue;
          if (input.store.getMediaAttempt(key)?.status !== 'confirmed') {
            input.store.confirmMediaRepost(key, evidence, { groupId: source.groupId, senderId: source.senderId,
              url: link.url, urlHash: link.urlHash, createdAtMs: processingNow(input) });
          }
          item.status = 'confirmed'; sourceChanged = true;
        }
      }
      if (sourceChanged) {
        releaseResolvedRetryHold(input.store, source);
        input.store.saveRelaySource(source);
      }
      await maybeCleanupSource(input, source);
      if (source.status === 'settled' || source.status === 'held') return;
      if (input.store.hasActiveRetryPass(source.groupId, source.messageId)) return;
      if (!checkpoint(input, source)) return;
      const message = await input.whatsapp.getSourceMessage(source.groupId, source.messageId).catch(() => null);
      if (input.control && !input.control.canPersist()) return;
      if (!message || !message.isGroup || message.fromMe || message.groupId !== source.groupId || message.id !== source.messageId
         || message.senderId !== source.senderId || relayContentHash(message.body) !== source.contentHash) {
        if (message) disqualifySourceCleanup(input.store, source, 'source-edited');
        holdSource(input, source, 'source-unavailable-or-changed');
        return;
      }
      await handleIncomingMessage({ ...input, queue: undefined, message: { ...message, senderName: source.senderName, timestampMs: source.timestampMs } });
    };
    try {
      if (input.queue) await input.queue.run(JSON.stringify([entry.groupId, entry.messageId]), run);
      else await run();
    } catch (error) {
      if (error instanceof UnsupportedRelayStateError) {
        messageForError(userError('Unsupported source held', 'unsupported_state'), { step: 'recovery', reference: entry.workReference, logger: input.logger });
        continue;
      }
      input.control?.failStorage();
      throw error;
    }
  }
}

export async function executeTargetedRetry(
  input: HandleIncomingMessageInput & { retry: RetryExecution },
  message: IncomingMessage,
  targets: RetryPassTarget[],
): Promise<void> {
  const executionInput = { ...input, message };
  const source = input.store.getRelaySource(message.groupId, message.id);
  if (!source) { input.store.revokeRetryPass(input.retry.passId); return; }
  const errorContext: ErrorReportContext = { step: 'recovery', reference: source.workReference, logger: input.logger };
  try {
    for (const { linkIndex } of targets) {
      if (!checkpoint(executionInput, source)) return;
      const link = source.links[linkIndex];
      if (!link?.plan) { input.store.revokeRetryPass(input.retry.passId); return; }
      link.status = 'ready';
      const active = { ...executionInput, source, link };
      errorContext.extractorId = link.platform;
      errorContext.urlHash = link.urlHash;
      errorContext.link = linkIndex + 1;
      errorContext.item = undefined;
      if (!checkpoint(executionInput, source)) return;
      try {
        if (link.platform === 'instagram') await relayInstagram(active, link.url, link.urlHash, errorContext);
        else await relayYouTube(active, link.url, link.urlHash, errorContext);
      } catch (error) {
        if (!(error instanceof UserFacingError)) throw error;
        await reportError(input, error, errorContext);
      }
      if (source.status === 'held' || source.status === 'paused') break;
    }
    if (!input.store.isRetryPassActive(input.retry.passId)) return;
    const unknown = sealRetryTargets(input.store, source, targets);
    if (unknown) {
      source.status = 'held';
      source.holdReason = 'retry-unresolved-send';
    } else if (source.status === 'ready' && !source.links.some((link) => link.status === 'ready'
      && (!link.plan || link.plan.items.some((item) => item.status === 'ready' || item.status === 'held')))) source.status = 'settled';
    if (!executionInput.control || executionInput.control.canPersist()) executionInput.store.saveRelaySource(source);
    executionInput.store.completeRetryPass(executionInput.retry.passId);
    await maybeCleanupSource(executionInput, source);
  } catch (error) {
    executionInput.store.revokeRetryPass(executionInput.retry.passId);
    if (!(error instanceof UserFacingError) && !(error instanceof UnsupportedRelayStateError)) executionInput.control?.failStorage();
    if (!executionInput.control || executionInput.control.canSubmit()) await reportError(executionInput, error, errorContext);
  }
}

export function observeRelayAcknowledgement(input: Omit<HandleIncomingMessageInput, 'message'>, groupId: string, evidence: RepostConfirmation): void {
  if (!confirmedEvidence(evidence) || (input.control && !input.control.canPersist())) return;
  for (const source of input.store.listRelaySources()) {
    if (source.groupId !== groupId) continue;
    for (const link of source.links) {
      for (const item of link.plan?.items ?? []) {
        if (!item.identity) continue;
        const key = { groupId, messageId: source.messageId, identity: item.identity };
        const attempt = input.store.getMediaAttempt(key);
        if (attempt?.status !== 'sending' || attempt.sentMessageId !== evidence.messageId || attempt.sourceUrl !== link.url) continue;
        input.store.confirmMediaRepost(key, evidence, { groupId, senderId: source.senderId,
          url: link.url, urlHash: link.urlHash, createdAtMs: processingNow(input) });
        item.status = 'confirmed';
        releaseResolvedRetryHold(input.store, source);
        input.store.saveRelaySource(source);
      }
    }
  }
}

async function relayYouTube(input: ActiveInput, url: string, urlHash: string, errorContext: ErrorReportContext): Promise<void> {
  const { message, store, downloader } = input;
  if (!message.id.trim()) throw userError('YouTube relay needs a source message ID. Original message kept.');
  if (input.link.plan?.items.every((item) => item.status === 'confirmed' || item.status === 'skipped' || item.status === 'failed')) return;
  const candidate = candidateMediaIdentity(url);
  if (candidate?.platform === 'youtube') {
    const progress = store.getMediaDisposition({ groupId: message.groupId, messageId: message.id, identity: candidate },
      processingNow(input), store.getGroupSettings(message.groupId).duplicateWindowHours);
    if (progress !== 'ready') {
      const alreadyHeld = input.link.plan?.items[0]?.status === 'held';
      const plan: RelayPlan = { parentId: candidate.videoId, totalItems: 1, items: [{ index: 1, kind: 'video', identity: candidate, status: progress === 'completed' ? 'confirmed' : progress === 'duplicate' ? 'skipped' : 'held' }] };
      if (!input.link.plan) input.link.plan = plan;
      else input.link.plan.items[0].status = plan.items[0].status;
      if (progress === 'duplicate') disqualifySourceCleanup(store, input.source, 'prior-message-duplicate');
      store.saveRelaySource(input.source);
      if (progress === 'held' && !alreadyHeld) throw unresolvedSendError('youtube');
      return;
    }
  }
  errorContext.step = 'download';
  const video = await downloader.resolveYouTube(url).catch((error: unknown) => {
    if (!checkpoint(input, input.source)) return null;
    input.link.status = 'failed'; store.saveRelaySource(input.source);
    throw userError('Could not establish this YouTube video identity. Original message kept.', downloadCause(error), errorFacts(error));
  });
  if (!video || !checkpoint(input, input.source)) return;
  const key = { groupId: message.groupId, messageId: message.id, identity: { platform: 'youtube' as const, videoId: video.id } };
  const plan: RelayPlan = { parentId: video.id, totalItems: 1, items: [{ index: 1, kind: 'video', identity: key.identity, status: 'ready' }] };
  savePlan(input, plan);
  const item = input.link.plan!.items[0];
  errorContext.item = item.index;
  errorContext.step = 'duplicate-check';
  const progress = store.getMediaDisposition(key, processingNow(input), store.getGroupSettings(message.groupId).duplicateWindowHours);
  if (progress !== 'ready') {
    item.status = progress === 'completed' ? 'confirmed' : progress === 'duplicate' ? 'skipped' : 'held';
    if (progress === 'duplicate') disqualifySourceCleanup(store, input.source, 'prior-message-duplicate');
    store.saveRelaySource(input.source);
    if (progress === 'held') throw unresolvedSendError('youtube');
    return;
  }
  errorContext.step = 'download';
  const download = await video.download(store.getGroupSettings(message.groupId).maxFileSizeMb).catch((error: unknown) => {
    if (!checkpoint(input, input.source)) return null;
    item.status = 'failed'; store.saveRelaySource(input.source);
    throw userError('Download unavailable. Original kept.', downloadCause(error), errorFacts(error));
  });
  if (!download) return;
  await submitMedia(input, {
    key, url, urlHash, download, item,
    unknownMessage: 'YouTube delivery is unknown. No automatic retry. Original message kept.',
  }, errorContext);
}

async function relayInstagram(input: ActiveInput, url: string, urlHash: string, errorContext: ErrorReportContext): Promise<void> {
  const { message, store, whatsapp, downloader } = input;
  if (!message.id.trim()) throw userError('Instagram relay needs a source message ID. Original message kept.');
  if (input.link.plan?.items.every((item) => item.status === 'confirmed' || item.status === 'skipped' || item.status === 'failed')) return;
  errorContext.step = 'download';
  const source = await downloader.resolveInstagram(url).catch((error: unknown) => {
    if (!checkpoint(input, input.source)) return null;
    input.link.status = 'failed'; store.saveRelaySource(input.source);
    throw userError('Could not inspect this Instagram post or selected item. Original message kept.', downloadCause(error), errorFacts(error));
  });
  if (!source || !checkpoint(input, input.source)) return;
  savePlan(input, { parentId: source.id, totalItems: source.totalItems, items: source.items.map((item) => ({
    index: item.index, kind: item.kind, status: item.kind === 'video' ? 'ready' : 'skipped',
    ...(item.kind === 'video' ? { identity: { platform: 'instagram' as const, postId: source.id, itemId: item.id } } : {}),
  })) });
  let complete = true;
  let hasVideo = false;
  let skippedItems = false;

  for (const [position, item] of source.items.entries()) {
    const savedItem = input.link.plan!.items[position];
    errorContext.item = savedItem.index;
    if (item.kind !== 'video') {
      skippedItems = true;
      continue;
    }
    hasVideo = true;
    if (!checkpoint(input, input.source)) return;
    if (savedItem.status === 'confirmed' || savedItem.status === 'skipped' || savedItem.status === 'failed') continue;
    const key = { groupId: message.groupId, messageId: message.id, identity: { platform: 'instagram' as const, postId: source.id, itemId: item.id } };
    errorContext.step = 'record';
    const progress = store.getMediaDisposition(key, processingNow(input), store.getGroupSettings(message.groupId).duplicateWindowHours);
    if (progress !== 'ready') {
      const alreadyHeld = savedItem.status === 'held';
      savedItem.status = progress === 'completed' ? 'confirmed' : progress === 'duplicate' ? 'skipped' : 'held';
      if (progress === 'duplicate') disqualifySourceCleanup(store, input.source, 'prior-message-duplicate');
      store.saveRelaySource(input.source);
      if (progress === 'held') {
        if (!alreadyHeld) throw unresolvedSendError('instagram');
        return;
      }
      continue;
    }

    let download: Awaited<ReturnType<RelayDownloader['download']>>;
    try {
      errorContext.step = 'download';
      download = await item.download(store.getGroupSettings(message.groupId).maxFileSizeMb);
    } catch (error) {
      if (!checkpoint(input, input.source)) return;
      savedItem.status = 'failed'; store.saveRelaySource(input.source);
      complete = false;
      await reportError(input, userError('Download unavailable. Original kept.', downloadCause(error), errorFacts(error)), errorContext);
      continue;
    }

    await submitMedia(input, {
      key, url, urlHash, download, item: savedItem,
      captionSuffix: source.totalItems > 1 ? `\nInstagram item ${item.index} of ${source.totalItems}` : '',
      unknownMessage: `Instagram item ${item.index} delivery is unknown. No automatic retry. Original message kept.`,
    }, errorContext);
    if (input.source.status === 'paused') return;
  }

  if ((!input.control || input.control.canSubmit()) && (skippedItems || !complete || !hasVideo)) {
    await whatsapp.sendText(message.groupId, hasVideo
      ? 'Photos or unresolved Instagram items were not reposted. Original message kept.'
      : 'No verifiable video in this Instagram post or selected item. Original message kept.');
  }
}

function savePlan(input: ActiveInput, plan: RelayPlan): void {
  const signature = (value: RelayPlan) => JSON.stringify({ ...value, items: value.items.map(({ status: _status, ...item }) => item) });
  if (input.link.plan && signature(input.link.plan) !== signature(plan)) {
    holdSource(input, input.source, 'media-changed');
    throw userError('Source media changed. Remaining work held. Original message kept.', 'source_changed');
  }
  input.link.plan ??= plan;
  if (plan.items.some((item) => item.kind !== 'video')) disqualifySourceCleanup(input.store, input.source, 'skipped-media');
  input.store.saveRelaySource(input.source);
}

type MediaSubmission = {
  item: RelayItem;
  key: MediaRepostKey;
  url: string;
  urlHash: string;
  download: Awaited<ReturnType<RelayDownloader['download']>>;
  captionSuffix?: string;
  unknownMessage: string;
};

async function submitMedia(input: ActiveInput, submission: MediaSubmission, errorContext: ErrorReportContext): Promise<void> {
  const { message, store, whatsapp, timezone, downloadDir, cleanupPath } = input;
  const { key, url, urlHash, download, captionSuffix, unknownMessage } = submission;
  try {
    if (!checkpoint(input, input.source)) return;
    const caption = formatCaption({ displayName: message.senderName, timestampMs: message.timestampMs, timezone, originalUrl: url }) + (captionSuffix ?? '');
    const file = await stat(download.filePath);
    if (!checkpoint(input, input.source)) return;
    const currentLimit = Math.min(store.getGroupSettings(message.groupId).maxFileSizeMb, input.maxMediaSizeMb ?? 64);
    if (!Number.isSafeInteger(currentLimit) || currentLimit <= 0 || !file.isFile() || file.size === 0 || file.size > currentLimit * 1024 * 1024) {
      submission.item.status = 'failed'; store.saveRelaySource(input.source);
      throw userError('Video no longer meets the current media size limit. Original message kept.', 'size_limit');
    }
    if (!await retryGuard(input, errorContext)) return;
    const deliveryMode = download.deliveryMode === 'document' ? 'document' : 'video';
    if (deliveryMode === 'document') {
      disqualifySourceCleanup(store, input.source, 'document-repost');
    }
    errorContext.step = 'record';
    const record = { groupId: message.groupId, senderId: message.senderId, url, urlHash, createdAtMs: processingNow(input) };
    const reservation = store.beginMediaRepost(key, record, store.getGroupSettings(message.groupId).duplicateWindowHours,
      input.retry ? { retryPassId: input.retry.passId, settingsRevision: input.retry.settingsRevision } : undefined, deliveryMode);
    if (reservation !== 'started') {
      if (input.retry && !store.isRetryPassActive(input.retry.passId)) return;
      submission.item.status = reservation === 'completed' ? 'confirmed' : reservation === 'duplicate' ? 'skipped' : 'held';
      if (reservation === 'duplicate') disqualifySourceCleanup(store, input.source, 'prior-message-duplicate');
      store.saveRelaySource(input.source);
      if (reservation === 'held') throw unresolvedSendError(key.identity.platform);
      return;
    }
    errorContext.step = 'upload';
    let observationError: unknown;
    const observe = (evidence: RepostEvidence) => {
      if (input.control && !input.control.canPersist()) return;
      try {
        errorContext.step = 'record';
        const attempt = store.getMediaAttempt(key);
        if (attempt?.status === 'confirmed' && attempt.sentMessageId === evidence.messageId) return;
        store.recordMediaEvidence(key, evidence);
        if (confirmedEvidence(evidence)) {
          store.confirmMediaRepost(key, evidence, { ...record, createdAtMs: processingNow(input) });
        }
      } catch (error) {
        input.control?.failStorage();
        observationError = error;
        throw error;
      }
    };
    const sending = whatsapp.sendVideoOnce(message.groupId, download.filePath, caption,
      deliveryMode === 'document' ? 'document' : undefined, observe);
    const confirmation = await (input.control ? input.control.track(sending) : sending).catch((error: unknown) => {
      if (input.control && !input.control.canPersist()) return null;
      persistSubmittedItemStatus(input, submission.item, 'held');
      if (observationError) throw observationError;
      throw userError(unknownMessage, 'delivery_unknown');
    });
    if (!confirmation || (input.control && !input.control.canPersist())) return;
    errorContext.step = 'record';
    if (!confirmedEvidence({ messageId: confirmation.messageId, ack: confirmation.ack })) {
      if (confirmation.messageId.trim() && Number.isInteger(confirmation.ack) && confirmation.ack >= -1 && confirmation.ack <= 4) {
        store.recordMediaEvidence(key, confirmation);
      }
      persistSubmittedItemStatus(input, submission.item, 'held');
      throw userError(unknownMessage, 'delivery_unknown');
    }
    if (store.getMediaAttempt(key)?.status !== 'confirmed') observe(confirmation);
    persistSubmittedItemStatus(input, submission.item, 'confirmed');
  } finally {
    await cleanupDownload(download, downloadDir, cleanupPath);
  }
}

function persistSubmittedItemStatus(input: ActiveInput, item: RelayItem, status: RelayItem['status']): void {
  const linkIndex = input.source.links.indexOf(input.link);
  if (linkIndex < 0 || !item.identity) throw new Error('Submitted media no longer matches its source link');
  const current = input.store.getRelaySource(input.source.groupId, input.source.messageId);
  const link = current?.links[linkIndex];
  const persistedItem = link?.plan?.items.find((candidate) => candidate.index === item.index);
  if (!current || !link || !persistedItem?.identity || mediaIdentityKey(persistedItem.identity) !== mediaIdentityKey(item.identity)) {
    throw new Error('Submitted media no longer matches its saved source plan');
  }
  const key = { groupId: input.source.groupId, messageId: input.source.messageId, identity: persistedItem.identity };
  persistedItem.status = input.store.getMediaAttempt(key)?.status === 'confirmed' ? 'confirmed' : status;
  if (persistedItem.status === 'confirmed') releaseResolvedRetryHold(input.store, current);
  input.store.saveRelaySource(current);

  Object.assign(input.link, link);
  input.source.status = current.status;
  if (current.holdReason) input.source.holdReason = current.holdReason;
  else delete input.source.holdReason;
  item.status = persistedItem.status;
}

function releaseResolvedRetryHold(store: HandleIncomingMessageInput['store'], source: RelaySource): void {
  if (source.holdReason !== 'retry-unresolved-send' && source.holdReason !== 'retry-interrupted-with-unknown-send') return;
  const unresolved = source.links.some((link) => link.plan?.items.some((item) => item.identity
    && store.getMediaAttempt({ groupId: source.groupId, messageId: source.messageId, identity: item.identity })?.status === 'sending'));
  if (unresolved) return;
  source.status = 'settled';
  delete source.holdReason;
}

function holdSource(input: Pick<HandleIncomingMessageInput, 'store' | 'logger'>, source: RelaySource, reason: 'source-changed' | 'media-changed' | 'source-unavailable-or-changed' | 'stale'): void {
  const changed = source.status !== 'held' || source.holdReason !== reason;
  if (reason === 'source-changed') disqualifySourceCleanup(input.store, source, 'source-edited');
  if (reason === 'media-changed') disqualifySourceCleanup(input.store, source, 'media-plan-changed');
  source.status = 'held'; source.holdReason = reason;
  input.store.saveRelaySource(source);
  if (changed) messageForError(userError('Work held', reason === 'stale' ? 'age_held' : reason === 'source-unavailable-or-changed' ? 'source_unavailable' : 'source_changed'),
    { step: 'recovery', reference: source.workReference, logger: input.logger });
}

function disqualifySourceCleanup(store: Pick<Store, 'saveRelaySource'>, source: RelaySource, reason: CleanupDisqualification): void {
  if (addCleanupDisqualification(source, reason)) store.saveRelaySource(source);
}

async function maybeCleanupSource(input: Omit<HandleIncomingMessageInput, 'message'>, source: RelaySource): Promise<void> {
  const checkSourceForCleanup = input.whatsapp.checkSourceForCleanup;
  const deleteSourceForCleanup = input.whatsapp.deleteSourceForCleanup;
  if (!checkSourceForCleanup || !deleteSourceForCleanup) return;
  await attemptGuardedSourceCleanup({
    store: input.store,
    source,
    whatsapp: {
      checkSourceForCleanup: (target) => checkSourceForCleanup.call(input.whatsapp, target),
      deleteSourceForCleanup: (target, canInvoke) => deleteSourceForCleanup.call(input.whatsapp, target, canInvoke),
      sendText: (groupId, text) => input.whatsapp.sendText(groupId, text),
    },
    now: () => processingNow(input),
    canSubmit: () => input.control?.canSubmit() ?? true,
    canPersist: () => input.control?.canPersist() ?? true,
    failStorage: () => input.control?.failStorage(),
    track: input.control ? (operation) => input.control!.track(operation) : undefined,
    logger: input.logger,
  });
}

function checkpoint(input: Pick<HandleIncomingMessageInput, 'control' | 'store' | 'now' | 'nowMs' | 'logger' | 'retry'>, source: RelaySource): boolean {
  if (input.control && !input.control.canPersist()) {
    if (input.retry) input.store.revokeRetryPass(input.retry.passId);
    return false;
  }
  if (input.retry && !input.store.isRetryPassActive(input.retry.passId)) return false;
  const age = processingNow(input) - source.acceptedAtMs;
  if (age < 0 && input.retry) { input.store.revokeRetryPass(input.retry.passId); return false; }
  if (age < 0 || (!input.retry && age > 24 * 60 * 60 * 1000)) {
    holdSource(input, source, 'stale');
    return false;
  }
  if ((input.control && !input.control.canSubmit()) || !input.store.getGroupSettings(source.groupId).enabled) {
    if (input.retry) { input.store.revokeRetryPass(input.retry.passId); return false; }
    source.status = 'paused'; input.store.saveRelaySource(source);
    return false;
  }
  return true;
}

function sealRetryTargets(store: HandleIncomingMessageInput['store'], source: RelaySource, targets: RetryPassTarget[]): boolean {
  let unknown = false;
  for (const target of targets) {
    const link = source.links[target.linkIndex];
    if (!link?.plan) continue;
    for (const itemIndex of target.itemIndexes) {
      const item = link.plan.items.find((candidate) => candidate.index === itemIndex);
      if (!item?.identity) continue;
      const attempt = store.getMediaAttempt({ groupId: source.groupId, messageId: source.messageId, identity: item.identity });
      if (attempt?.status === 'confirmed') item.status = 'confirmed';
      else if (attempt?.status === 'sending') { item.status = 'held'; unknown = true; }
      else if (item.status === 'ready') item.status = 'failed';
    }
  }
  for (const link of source.links) {
    for (const item of link.plan?.items ?? []) {
      if (!item.identity) continue;
      if (store.getMediaAttempt({ groupId: source.groupId, messageId: source.messageId, identity: item.identity })?.status === 'sending') unknown = true;
    }
  }
  return unknown;
}

async function retryGuard(input: ActiveInput, context: ErrorReportContext): Promise<boolean> {
  const retry = input.retry;
  if (!retry) return true;
  if (!input.store.isRetryPassActive(retry.passId)) return false;
  const sourceMatches = await retry.sourceAndPlanStillMatch(input.source, input.link);
  if (!sourceMatches) {
    input.store.revokeRetryPass(retry.passId);
    const current = input.store.getRelaySource(input.source.groupId, input.source.messageId);
    if (current) holdSource(input, current, 'source-unavailable-or-changed');
    return false;
  }
  const authorized = await retry.requesterStillAuthorized();
  if (!authorized) {
    input.store.revokeRetryPass(retry.passId);
    messageForError(userError('Retry permission changed; remaining work held for a fresh request.', 'permission_rejected'), { ...context, step: 'permission', reference: input.source.workReference, logger: input.logger });
    return false;
  }
  return checkpoint(input, input.source);
}

function confirmedEvidence(evidence: RepostEvidence): evidence is RepostConfirmation {
  return Boolean(evidence.messageId.trim()) && evidence.ack !== null && Number.isInteger(evidence.ack) && evidence.ack >= 1 && evidence.ack <= 4;
}

function unresolvedSendError(platform: MediaIdentity['platform']): Error {
  const name = platform === 'instagram' ? 'An Instagram' : 'A YouTube';
  return userError(`${name} video has an unresolved send. No automatic retry. Original message kept.`, 'delivery_unknown');
}

function processingNow(input: Pick<HandleIncomingMessageInput, 'now' | 'nowMs'>): number {
  return input.now?.() ?? input.nowMs ?? Date.now();
}
