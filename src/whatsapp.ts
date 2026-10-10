import whatsappWeb from 'whatsapp-web.js';
import { canManageGroup, parseCommand, validateGroupSettingCommand } from './commands.js';
import { messageForError, userError } from './errorReporter.js';
import { formatGroupInspection, formatSourceInspection } from './inspection.js';
import { KeyedTaskQueue } from './keyedTaskQueue.js';
import { executeTargetedRetry, handleIncomingMessage, recoverRelaySources, observeRelayAcknowledgement, relayContentHash, type IncomingMessage, type RelayDownloader } from './relay.js';
import { RelayLifecycle } from './relayLifecycle.js';
import type { AppConfig } from './config.js';
import type { RepostConfirmation, RepostEvidence, Store } from './store.js';
import { prepareRetryWork, RetryPreviewRegistry, RetryValidationError, checkRetryLinkPlan, sameRetrySource } from './targetedRetry.js';
import { addCleanupDisqualification, UnsupportedRelayStateError, type CleanupDisqualification } from './relayState.js';
import { prepareWhatsappRuntime, resolveWhatsappRuntimePaths, type WhatsappRuntimePathInput } from './whatsappRuntime.js';
import type { CleanupCheckResult, CleanupDeleteResult, CleanupSourceIdentity } from './sourceCleanup.js';

const { Client, LocalAuth, MessageMedia } = whatsappWeb;

export type StatusInput = {
  enabled: boolean;
  maxFileSizeMb: number;
  duplicateWindowHours: number;
  botIsAdmin: boolean;
};

export type WhatsappRelay = {
  sendVideo(groupId: string, filePath: string, caption: string): Promise<string>;
  sendVideoOnce(groupId: string, filePath: string, caption: string, deliveryMode?: 'document', observe?: (evidence: RepostEvidence) => void): Promise<RepostConfirmation>;
  getSourceMessage(groupId: string, messageId: string): Promise<IncomingMessage | null>;
  lookupRepost(groupId: string, messageId: string): Promise<RepostConfirmation | null>;
  deleteMessage(groupId: string, messageId: string): Promise<void>;
  checkSourceForCleanup(source: CleanupSourceIdentity): Promise<CleanupCheckResult>;
  deleteSourceForCleanup(source: CleanupSourceIdentity, canInvoke: () => boolean): Promise<CleanupDeleteResult>;
  sendText(groupId: string, text: string): Promise<void>;
};

export type WhatsappBot = {
  client: InstanceType<typeof Client>;
  relayWhatsapp: WhatsappRelay;
  isReady(): boolean;
  start(): void;
  stop(): Promise<void>;
};

type CreateWhatsappBotInput = {
  config: AppConfig;
  store: Store;
  downloader: RelayDownloader;
  queue?: KeyedTaskQueue;
  runtimePaths?: WhatsappRuntimePathInput;
  logger?: (entry: Record<string, unknown>) => void;
};

type WhatsappMessage = {
  id?: { _serialized?: string } | string;
  from: string;
  author?: string;
  body?: string;
  links?: Array<{ link?: string; isSuspicious?: boolean }>;
  timestamp?: number;
  fromMe?: boolean;
  hasQuotedMsg?: boolean;
  getQuotedMessage?(): Promise<WhatsappMessage>;
  delete?(everyone: boolean): Promise<unknown>;
  reply(text: string): Promise<unknown> | unknown;
  getChat(): Promise<WhatsappChat>;
  getContact?(): Promise<WhatsappContact>;
};

type WhatsappContact = {
  id?: WhatsappId;
  pushname?: string;
  name?: string;
  number?: string;
};

type WhatsappChat = {
  isGroup?: boolean;
  id?: { _serialized?: string } | string;
  name?: string;
  participants?: WhatsappParticipant[];
};

type WhatsappParticipant = {
  id?: WhatsappId;
  lid?: string;
  phoneNumber?: WhatsappId;
  isAdmin?: boolean;
  isSuperAdmin?: boolean;
};

type WhatsappId = { _serialized?: string; user?: string; server?: string } | string;

export function formatStatus({ enabled, maxFileSizeMb, duplicateWindowHours, botIsAdmin }: StatusInput): string {
  return [
    `Bot status: ${enabled ? 'enabled' : 'disabled'}`,
    `Max size: ${maxFileSizeMb} MB`,
    `Duplicate window: ${duplicateWindowHours} hours`,
    'Supported: Instagram reels/posts, YouTube Shorts',
    `Bot admin: ${botIsAdmin ? 'yes' : 'no'}`,
  ].join('\n');
}

export function createWhatsappBot({ config, store, downloader, queue, runtimePaths: runtimePathInput, logger }: CreateWhatsappBotInput): WhatsappBot {
  const logSanitizedError = (_message: string, error: unknown, step: string) => { messageForError(error, { step, logger }); };
  const control = new RelayLifecycle();
  control.setUsable(false);
  const relayQueue = queue ?? new KeyedTaskQueue(config.concurrentDownloads);
  const retryPreviews = new RetryPreviewRegistry();
  const runtimePaths = resolveWhatsappRuntimePaths(runtimePathInput);
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim() || undefined;
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: runtimePaths.authDir }),
    puppeteer: {
      executablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        `--disk-cache-dir=${runtimePaths.chromeCacheDir}`,
      ],
    },
  });
  const pendingAcknowledgements = new Set<() => void>();

  const relayWhatsapp: WhatsappRelay = {
    async sendVideoOnce(groupId, filePath, caption, deliveryMode, observe) {
      const media = MessageMedia.fromFilePath(filePath);
      return new Promise<RepostConfirmation>((resolve, reject) => {
        let sentId: string | undefined;
        let finished = false;
        const acknowledgements = new Map<string, number>();
        const cleanup = () => {
          clearTimeout(timer);
          client.off('message_ack', onAck);
          pendingAcknowledgements.delete(dispose);
          acknowledgements.clear();
        };
        const finish = (error?: unknown, evidence?: RepostConfirmation, keepCorrelation = false) => {
          if (!keepCorrelation) cleanup();
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          if (error) reject(error);
          else resolve(evidence!);
        };
        const dispose = () => finish(new Error('Repost acceptance is unknown'));
        const accept = (evidence: RepostEvidence) => {
          if (!control.canPersist()) return;
          observe?.(evidence);
          if (evidence.ack !== null && evidence.ack >= 1 && evidence.ack <= 4) finish(undefined, { messageId: evidence.messageId, ack: evidence.ack });
        };
        const onAck = (message: { id?: WhatsappId; fromMe?: boolean; to?: string }, ack: number) => {
          const id = messageId(message);
          if (!id || !message.fromMe || message.to !== groupId || !Number.isInteger(ack) || ack < -1 || ack > 4) return;
          acknowledgements.set(id, Math.max(ack, acknowledgements.get(id) ?? -1));
          if (id === sentId) {
            try { accept({ messageId: id, ack: acknowledgements.get(id)! }); } catch (error) { finish(error); }
          }
        };
        const timer = setTimeout(() => finish(new Error('Repost acceptance is unknown'), undefined, !sentId), 30_000);
        pendingAcknowledgements.add(dispose);
        client.on('message_ack', onAck);
        void client.sendMessage(groupId, media, { caption, waitUntilMsgSent: false, ...(deliveryMode === 'document' ? { sendMediaAsDocument: true } : {}) })
          .then((sent) => {
            sentId = messageId(sent) ?? undefined;
            if (!sentId?.trim() || !sent?.fromMe || sent.to !== groupId) {
              finish(new Error('Repost acceptance is unknown'));
              return;
            }
            const returnedAck = Number.isInteger(sent.ack) && sent.ack >= -1 && sent.ack <= 4 ? sent.ack : null;
            const cachedAck = acknowledgements.get(sentId);
            const ack = cachedAck === undefined ? returnedAck : returnedAck === null ? cachedAck : Math.max(cachedAck, returnedAck);
            try { accept({ messageId: sentId, ack }); }
            catch (error) {
              if (finished) logSanitizedError('Failed to record late repost evidence', error, 'record');
              else finish(error);
            } finally { if (finished) cleanup(); }
          }, (error: unknown) => finish(error));
      });
    },

    async getSourceMessage(groupId, sourceId) {
      const message = await client.getMessageById(sourceId);
      if (!message || messageId(message) !== sourceId || message.fromMe || message.from !== groupId) return null;
      const chat = await message.getChat();
      if (!chat.isGroup || serializedId(chat.id) !== groupId) return null;
      return toIncomingMessage(message, chat, groupId);
    },

    async lookupRepost(groupId, repostId) {
      const message = await client.getMessageById(repostId);
      if (!message || messageId(message) !== repostId || !message.fromMe || message.to !== groupId
        || !Number.isInteger(message.ack) || message.ack < 1 || message.ack > 4) return null;
      return { messageId: repostId, ack: message.ack };
    },

    async sendVideo(groupId, filePath, caption) {
      const media = MessageMedia.fromFilePath(filePath);
      const sent = await client.sendMessage(groupId, media, { caption });
      return messageId(sent) ?? '';
    },

    async deleteMessage(_groupId, messageIdValue) {
      const message = await client.getMessageById(messageIdValue);
      await message.delete(true);
    },

    async checkSourceForCleanup(source): Promise<CleanupCheckResult> {
      const target = await cleanupTarget(client, control, source);
      return target.status;
    },

    async deleteSourceForCleanup(source, canInvoke): Promise<CleanupDeleteResult> {
      const target = await cleanupTarget(client, control, source);
      if (target.status !== 'ready') return target.status;
      let allowed: boolean;
      try { allowed = canInvoke(); }
      catch { return 'blocked'; }
      if (!target.message.delete || !allowed || !control.canSubmit() || !control.canPersist() || !client.info) return 'blocked';
      await target.message.delete(true);
      return 'returned';
    },

    async sendText(groupId, text) {
      await client.sendMessage(groupId, text);
    },
  };

  const recoveryInput = { store, downloader, whatsapp: relayWhatsapp, queue: relayQueue, control,
    timezone: config.timezone, downloadDir: config.downloadDir, maxMediaSizeMb: config.maxMediaSizeMb,
    logger };
  let recovery: Promise<void> | undefined;
  let recoveryRequested = false;
  const resume = (): Promise<void> => {
    if (!control.canSubmit()) return Promise.resolve();
    recoveryRequested = true;
    recovery ??= (async () => {
      do {
        recoveryRequested = false;
        await recoverRelaySources(recoveryInput);
      } while (recoveryRequested && control.canSubmit());
    })().catch((error: unknown) => {
      control.failStorage();
      logSanitizedError('Failed to recover relay work', error, 'recovery');
    }).finally(() => { recovery = undefined; });
    return recovery;
  };

  let authRequired = false;
  const requireAuth = () => {
    control.setUsable(false);
    if (authRequired) return;
    authRequired = true;
    logSanitizedError('Private login required', userError('Private login required', 'auth_required'), 'auth');
  };
  client.on('qr', requireAuth);
  client.on('ready', () => {
    authRequired = false;
    control.setUsable(true);
    return resume();
  });
  client.on('disconnected', () => control.setUsable(false));
  client.on('auth_failure', requireAuth);
  client.on('message_ack', (message, ack) => {
    const id = messageId(message);
    if (!id || !message.fromMe || !message.to) return;
    try {
      observeRelayAcknowledgement(recoveryInput, message.to, { messageId: id, ack });
      void resume();
    } catch (error) {
      control.failStorage();
      logSanitizedError('Failed to record repost acknowledgement', error, 'record');
    }
  });
  client.on('message', (message) => {
    if (!control.canSubmit()) return;
    return handleWhatsappMessage(message as WhatsappMessage, client, config, store, relayWhatsapp, downloader, relayQueue, retryPreviews, control, resume, logger).catch((error: unknown) => {
      control.failStorage();
      logSanitizedError('Failed to handle WhatsApp message', error, 'whatsapp-message');
    });
  });

  return {
    client,
    relayWhatsapp,
    isReady() {
      return store.isOpen() && control.canSubmit() && Boolean(client.info);
    },
    start() {
      void prepareWhatsappRuntime(runtimePaths)
        .then(() => { if (!control.isStopping()) return client.initialize(); })
        .catch((error: unknown) => {
          logSanitizedError('Failed to prepare WhatsApp runtime', error, 'whatsapp-runtime');
        });
    },
    async stop() {
      const deadline = Date.now() + 30_000;
      await control.stop(30_000);
      control.close();
      for (const dispose of pendingAcknowledgements) dispose();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          client.destroy(),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); }),
        ]);
      } finally { clearTimeout(timer); }
    },
  };
}

async function handleWhatsappMessage(
  message: WhatsappMessage,
  client: InstanceType<typeof Client>,
  config: AppConfig,
  store: Store,
  relayWhatsapp: WhatsappRelay,
  downloader: RelayDownloader,
  queue: KeyedTaskQueue,
  retryPreviews: RetryPreviewRegistry,
  control?: RelayLifecycle,
  resume?: () => Promise<void>,
  logger?: (entry: Record<string, unknown>) => void,
): Promise<void> {
  const chat = await message.getChat();
  if (control && !control.canSubmit()) return;
  if (!chat.isGroup) return;
  if (message.fromMe) return;

  const groupId = serializedId(chat.id) ?? message.from;
  store.setGroupMetadata(groupId, chat.name ?? groupId, Date.now());

  const senderId = message.author ?? message.from;
  const contact = await message.getContact?.();
  if (control && !control.canSubmit()) return;
  const botId = currentBotId(client);
  const senderIds = idCandidates(senderId, contact);
  const senderIsGroupAdmin = participantIsAdmin(chat.participants, senderIds);
  const botIsAdmin = botId ? participantIsAdmin(chat.participants, botId) : false;
  const command = parseCommand(message.body ?? '');

  if (command) {
    const ownerId = store.getBotOwnerId() ?? config.ownerId;
    const canManage = canManageGroup({ senderId, ownerId, senderIsGroupAdmin }) || idsOverlap(senderIds, idCandidates(ownerId));
    if (!canManage && command.action !== 'retry-confirm') {
      messageForError(userError('Command not run', 'permission_rejected'), { step: 'permission', logger });
      await message.reply('Only current-group admins or the bot owner may run this command. Command not run; no work details were shown.');
      return;
    }

    if (command.action === 'inspect') {
      if (!message.hasQuotedMsg) {
        await message.reply(formatGroupInspection(store, groupId));
        return;
      }
      const quoted = await message.getQuotedMessage?.().catch(() => null);
      const quotedId = messageId(quoted ?? undefined);
      if (!quoted || quoted.fromMe || quoted.from !== groupId || !quotedId) {
        await message.reply('Quoted source unavailable or untracked in this group. No work details shown.');
        return;
      }
      let source;
      try { source = store.getRelaySource(groupId, quotedId); }
      catch { await message.reply('Saved source state unavailable or unsupported. Work held; no details shown.'); return; }
      await message.reply(source ? formatSourceInspection(store, source) : 'Quoted source unavailable or untracked in this group. No work details shown.');
      return;
    }

    if (command.action === 'set') {
      const update = validateGroupSettingCommand(command, config.maxMediaSizeMb ?? 64);
      if (!update) {
        await message.reply(`Usage: !bot set max-size <MiB> (1–${config.maxMediaSizeMb ?? 64}) or !bot set duplicate-window <hours> (0–720). No settings changed.`);
        return;
      }
      const changed = store.setGroupSettings(groupId, { [update.setting]: update.value });
      if (changed) retryPreviews?.invalidateGroup(groupId);
      await message.reply(update.setting === 'maxFileSizeMb'
        ? `Maximum media size set to ${update.value} MiB.`
        : `Duplicate window set to ${update.value} hours.`);
      return;
    }

    if (command.action === 'invalid-retry') {
      await message.reply('Use !bot retry or !bot retry confirm, replying to the exact tracked source. No work was started.');
      return;
    }

    if (command.action === 'retry' || command.action === 'retry-confirm') {
      await handleTargetedRetryCommand({ action: command.action, message, client, config, store, relayWhatsapp, downloader,
        queue, retryPreviews, control, logger, groupId, senderId, contact });
      return;
    }

    if (command.action === 'enable') {
      if (!botIsAdmin) {
        messageForError(userError('Command not run', 'permission_rejected'), { step: 'permission', logger });
        await message.reply('Make bot a group admin before enabling.');
        return;
      }

      store.setGroupEnabled(groupId, true);
      await message.reply('Bot enabled.');
      void resume?.();
      return;
    }

    if (command.action === 'disable') {
      store.setGroupEnabled(groupId, false);
      retryPreviews?.invalidateGroup(groupId);
      await message.reply('Bot disabled.');
      return;
    }

    const settings = store.getGroupSettings(groupId);
    await message.reply(formatStatus({ ...settings, maxFileSizeMb: Math.min(settings.maxFileSizeMb, config.maxMediaSizeMb ?? 64), botIsAdmin }));
    return;
  }

  await handleIncomingMessage({
    message: toIncomingMessage(message, chat, groupId, contact),
    store,
    whatsapp: {
      sendVideo: async (targetGroupId, filePath, caption) => {
        await relayWhatsapp.sendVideo(targetGroupId, filePath, caption);
      },
      sendVideoOnce: relayWhatsapp.sendVideoOnce,
      sendText: relayWhatsapp.sendText,
      deleteMessage: relayWhatsapp.deleteMessage,
      checkSourceForCleanup: relayWhatsapp.checkSourceForCleanup,
      deleteSourceForCleanup: relayWhatsapp.deleteSourceForCleanup,
    },
    downloader,
    timezone: config.timezone,
    downloadDir: config.downloadDir,
    maxMediaSizeMb: config.maxMediaSizeMb,
    control,
    queue,
    logger,
  });
}

type TargetedRetryCommandInput = {
  action: 'retry' | 'retry-confirm';
  message: WhatsappMessage;
  client: InstanceType<typeof Client>;
  config: AppConfig;
  store: Store;
  relayWhatsapp: WhatsappRelay;
  downloader: RelayDownloader;
  queue: KeyedTaskQueue;
  retryPreviews: RetryPreviewRegistry;
  control?: RelayLifecycle;
  logger?: (entry: Record<string, unknown>) => void;
  groupId: string;
  senderId: string;
  contact?: WhatsappContact;
};

async function handleTargetedRetryCommand(input: TargetedRetryCommandInput): Promise<void> {
  const { message, groupId, store, retryPreviews } = input;
  const requesterId = serializedId(input.contact?.id) ?? input.senderId;
  if (!message.hasQuotedMsg) {
    if (input.action === 'retry-confirm') {
      await message.reply('No matching retry preview is pending for you and this source. Reply with !bot retry to request a fresh preview.');
      return;
    }
    await message.reply('Reply to the exact tracked source with !bot retry or !bot retry confirm. No work details shown.');
    return;
  }
  const quoted = await message.getQuotedMessage?.().catch(() => null);
  const sourceId = messageId(quoted ?? undefined);
  if (!quoted || quoted.fromMe || quoted.from !== groupId || !sourceId) {
    await message.reply('Quoted source unavailable or untracked in this group. No work details shown.');
    return;
  }

  if (input.action === 'retry-confirm' && !retryPreviews.get(groupId, sourceId, requesterId)) {
    await message.reply('No matching retry preview is pending for you and this source. Reply with !bot retry to request a fresh preview.');
    return;
  }

  if (input.action === 'retry-confirm') {
    await confirmRetryPreview(input, requesterId, sourceId);
    return;
  }

  let source;
  try { source = store.getRelaySource(groupId, sourceId); }
  catch (error) {
    if (!(error instanceof UnsupportedRelayStateError)) throw error;
    await message.reply('Saved source state unavailable or unsupported. Work held; no details shown.');
    return;
  }
  if (!source) {
    await message.reply('Quoted source unavailable or untracked in this group. No work details shown.');
    return;
  }

  await issueRetryPreview(input, requesterId, source);
}

async function issueRetryPreview(input: TargetedRetryCommandInput, requesterId: string, source: NonNullable<ReturnType<Store['getRelaySource']>>): Promise<void> {
  const { message, groupId, store, retryPreviews, relayWhatsapp, downloader } = input;
  const now = Date.now();
  const existing = retryPreviews.get(groupId, source.messageId, requesterId);
  if (existing && now < existing.expiresAtMs) {
    const currentSettings = store.getGroupSettings(groupId);
    const settingsRevision = store.getGroupSettingsRevision(groupId);
    if (!currentSettings.enabled) {
      retryPreviews.invalidateGroup(groupId);
      await message.reply('This group is disabled. Retry is unavailable; the bot was not enabled.');
      return;
    }
    if (settingsRevision === existing.settingsRevision && sameRetrySource(existing.sourceBefore, source)) {
      const liveSource = await relayWhatsapp.getSourceMessage(groupId, source.messageId).catch(() => null);
      if (!liveSourceMatches(source, liveSource)) {
        retryPreviews.invalidateSource(groupId, source.messageId);
        holdRetrySource(store, source, input.logger, liveSource ? 'source-edited' : undefined);
        await message.reply('Source is missing, changed, or unavailable. Work remains held; no retry was admitted.');
        return;
      }
      try {
        const currentPreparation = await prepareRetryWork(source, store, downloader, currentSettings, Date.now());
        if (JSON.stringify(currentPreparation.targets) === JSON.stringify(existing.targets)
          && sameRetrySource(currentPreparation.sourceAfter, existing.sourceAfter)) {
          const latest = store.getRelaySource(groupId, source.messageId);
          const latestSettings = store.getGroupSettings(groupId);
          const currentPreview = retryPreviews.get(groupId, source.messageId, requesterId);
          if (latest && sameRetrySource(latest, existing.sourceBefore) && latestSettings.enabled
            && store.getGroupSettingsRevision(groupId) === existing.settingsRevision && currentPreview?.id === existing.id) {
            const checkedLiveSource = await relayWhatsapp.getSourceMessage(groupId, source.messageId).catch(() => null);
            if (!liveSourceMatches(latest, checkedLiveSource)) {
              retryPreviews.invalidateSource(groupId, source.messageId);
              holdRetrySource(store, latest, input.logger, checkedLiveSource ? 'source-edited' : undefined);
              await message.reply('Source is missing, changed, or unavailable. Work remains held; no retry was admitted.');
              return;
            }
            if (Date.now() < existing.expiresAtMs && store.getGroupSettingsRevision(groupId) === existing.settingsRevision
              && retryPreviews.get(groupId, source.messageId, requesterId)?.id === existing.id) {
              await message.reply(retryPreviewText(existing.sourceBefore.workReference, existing.targets));
              return;
            }
          }
        }
      } catch (error) {
        if (!(error instanceof RetryValidationError) && !(error instanceof UnsupportedRelayStateError)) throw error;
        retryPreviews.invalidateSource(groupId, source.messageId);
        if (error instanceof RetryValidationError && ['source-unavailable', 'source-changed'].includes(error.reason)) {
          holdRetrySource(store, source, input.logger, error.reason === 'source-changed' ? 'media-plan-changed' : undefined);
        }
        await message.reply('The previous retry preview is no longer valid. No retry was admitted; request a fresh preview.');
        return;
      }
    }
    retryPreviews.invalidateSource(groupId, source.messageId);
  }
  const requestMessageAtMs = whatsappTimestampMs(message.timestamp);
  if (requestMessageAtMs === null) {
    await message.reply('Retry preview unavailable because the command timestamp could not be verified.');
    return;
  }
  const settings = store.getGroupSettings(groupId);
  if (!settings.enabled) {
    await message.reply('This group is disabled. Retry is unavailable; the bot was not enabled.');
    return;
  }
  const settingsRevision = store.getGroupSettingsRevision(groupId);
  const liveSource = await relayWhatsapp.getSourceMessage(groupId, source.messageId).catch(() => null);
  if (!liveSourceMatches(source, liveSource)) {
    holdRetrySource(store, source, input.logger, liveSource ? 'source-edited' : undefined);
    await message.reply('Source is missing, changed, or unavailable. Work remains held; no retry was admitted.');
    return;
  }

  let preparation;
  try { preparation = await prepareRetryWork(source, store, downloader, settings, Date.now()); }
  catch (error) {
    if (!(error instanceof RetryValidationError) && !(error instanceof UnsupportedRelayStateError)) throw error;
    if (error instanceof RetryValidationError && ['source-unavailable', 'source-changed'].includes(error.reason)) {
      holdRetrySource(store, source, input.logger, error.reason === 'source-changed' ? 'media-plan-changed' : undefined);
    }
    await message.reply(error instanceof RetryValidationError && error.reason === 'not-eligible'
      ? 'No definitely pre-send work currently qualifies. Confirmed, skipped, and delivery-unknown work stay protected.'
      : 'Retry preview could not validate the saved source and plan. Work remains held; no retry was admitted.');
    return;
  }

  const latest = store.getRelaySource(groupId, source.messageId);
  const latestSettings = store.getGroupSettings(groupId);
  if (!latest || !sameRetrySource(latest, source)) {
    await message.reply('Source state changed while preparing the preview. Request a fresh inspection and retry preview.');
    return;
  }
  if (!latestSettings.enabled || store.getGroupSettingsRevision(groupId) !== settingsRevision) {
    await message.reply('Group settings changed while preparing the preview. Request a new retry preview.');
    return;
  }
  const checkedLiveSource = await relayWhatsapp.getSourceMessage(groupId, source.messageId).catch(() => null);
  if (!liveSourceMatches(source, checkedLiveSource)) {
    holdRetrySource(store, source, input.logger, checkedLiveSource ? 'source-edited' : undefined);
    await message.reply('Source is missing, changed, or unavailable. Work remains held; no retry was admitted.');
    return;
  }

  const issued = retryPreviews.issue({ groupId, messageId: source.messageId, requesterId, settingsRevision,
    requestMessageAtMs, sourceBefore: latest, sourceAfter: preparation.sourceAfter, targets: preparation.targets }, Date.now());
  await message.reply(retryPreviewText(issued.preview.sourceBefore.workReference, issued.preview.targets));
}

async function confirmRetryPreview(input: TargetedRetryCommandInput, requesterId: string, sourceId: string): Promise<void> {
  const { message, groupId, store, retryPreviews, queue } = input;
  const pending = retryPreviews.get(groupId, sourceId, requesterId);
  if (!pending) {
    await message.reply('No matching retry preview is pending for you and this source. Reply with !bot retry to request a fresh preview.');
    return;
  }
  const commandMessageId = messageId(message);
  if (!commandMessageId) {
    retryPreviews.consume(groupId, sourceId, requesterId);
    await message.reply('This confirmation could not be uniquely identified. Request a fresh retry preview.');
    return;
  }
  if (!store.claimRetryConfirmation(commandMessageId)) {
    await message.reply('This confirmation was already used or could not be verified. Request a fresh retry preview.');
    return;
  }
  const preview = retryPreviews.consume(groupId, sourceId, requesterId);
  if (!preview) {
    await message.reply('No matching retry preview is pending. Request a fresh preview.');
    return;
  }
  const confirmedAtMs = whatsappTimestampMs(message.timestamp);
  if (confirmedAtMs === null || confirmedAtMs <= preview.requestMessageAtMs || confirmedAtMs > Date.now() + 60_000) {
    await message.reply('Confirmation time could not be verified against this preview. Request and confirm a fresh retry preview.');
    return;
  }
  if (!await requesterStillAuthorized(input, requesterId)) {
    await message.reply('Your current owner/admin authority could not be verified. Request a fresh authorized retry preview.');
    return;
  }

  const queueKey = JSON.stringify([groupId, sourceId]);
  const admitted = queue.runIfIdle(queueKey, async () => admitAndRunRetry(input, requesterId, preview));
  if (!admitted) {
    await message.reply('This source already has active work. No retry was queued; request a fresh preview after it finishes.');
    return;
  }
  await admitted;
}

async function admitAndRunRetry(input: TargetedRetryCommandInput, requesterId: string, preview: import('./targetedRetry.js').RetryPreview): Promise<void> {
  const { message, groupId, store, relayWhatsapp, downloader, retryPreviews } = input;
  const reject = async (text: string) => { await message.reply(text); };
  if (Date.now() >= preview.expiresAtMs) {
    await reject('Retry preview expired before final admission. Request a fresh preview.');
    return;
  }
  const currentSettings = store.getGroupSettings(groupId);
  if (!currentSettings.enabled || store.getGroupSettingsRevision(groupId) !== preview.settingsRevision) {
    await reject('Group settings changed or the group is disabled. Request a fresh retry preview.');
    return;
  }
  let sourceBefore;
  try { sourceBefore = store.getRelaySource(groupId, preview.messageId); }
  catch (error) {
    if (!(error instanceof UnsupportedRelayStateError)) throw error;
    await reject('Saved source state is unavailable or unsupported. Work remains held; request a fresh preview after it is resolved.');
    return;
  }
  if (!sourceBefore || !sameRetrySource(sourceBefore, preview.sourceBefore)) {
    await reject('Saved source state changed after the preview. Request a fresh preview.');
    return;
  }
  let liveSource = await relayWhatsapp.getSourceMessage(groupId, preview.messageId).catch(() => null);
  if (!liveSourceMatches(sourceBefore, liveSource)) {
    holdRetrySource(store, sourceBefore, input.logger, liveSource ? 'source-edited' : undefined);
    await reject('Source is missing, changed, or unavailable. Work remains held; no retry was admitted.');
    return;
  }
  let preparation;
  try { preparation = await prepareRetryWork(sourceBefore, store, downloader, currentSettings, Date.now()); }
  catch (error) {
    if (!(error instanceof RetryValidationError) && !(error instanceof UnsupportedRelayStateError)) throw error;
    if (error instanceof RetryValidationError && ['source-unavailable', 'source-changed'].includes(error.reason)) {
      holdRetrySource(store, sourceBefore, input.logger, error.reason === 'source-changed' ? 'media-plan-changed' : undefined);
    }
    await reject(error instanceof RetryValidationError && error.reason === 'not-eligible'
      ? 'The previewed eligible work changed. Nothing was retried; request a fresh preview.'
      : 'The source or saved plan could not be revalidated. Work remains held; request a fresh preview.');
    return;
  }
  if (JSON.stringify(preparation.targets) !== JSON.stringify(preview.targets)
    || !sameRetrySource(preparation.sourceAfter, preview.sourceAfter)) {
    await reject('The previewed eligible work changed. Nothing was retried; request a fresh preview.');
    return;
  }
  liveSource = await relayWhatsapp.getSourceMessage(groupId, preview.messageId).catch(() => null);
  if (!liveSourceMatches(sourceBefore, liveSource)) {
    holdRetrySource(store, sourceBefore, input.logger, liveSource ? 'source-edited' : undefined);
    await reject('Source is missing, changed, or unavailable. Work remains held; no retry was admitted.');
    return;
  }
  if (!await requesterStillAuthorized(input, requesterId)) {
    await reject('Your current owner/admin authority could not be verified. No retry was admitted.');
    return;
  }

  const finalSettings = store.getGroupSettings(groupId);
  let finalSource;
  try { finalSource = store.getRelaySource(groupId, preview.messageId); }
  catch (error) {
    if (!(error instanceof UnsupportedRelayStateError)) throw error;
    await reject('Saved source state is unavailable or unsupported. Work remains held; no retry was admitted.');
    return;
  }
  if (Date.now() >= preview.expiresAtMs) {
    await reject('Retry preview expired before final admission. Request a fresh preview.');
    return;
  }
  if (!retryPreviews.isValid(preview) || !finalSettings.enabled || store.getGroupSettingsRevision(groupId) !== preview.settingsRevision
    || !finalSource || !sameRetrySource(finalSource, preview.sourceBefore)) {
    await reject('Source or settings changed before atomic admission. Request a fresh preview.');
    return;
  }
  const admissionAtMs = Date.now();
  if (admissionAtMs >= preview.expiresAtMs) {
    await reject('Retry preview expired before final admission. Request a fresh preview.');
    return;
  }

  const status = store.admitRetryPass({ id: preview.id, groupId, messageId: preview.messageId,
    settingsRevision: preview.settingsRevision, createdAtMs: admissionAtMs, targets: preview.targets,
    sourceBefore: finalSource, sourceAfter: preview.sourceAfter });
  if (status !== 'admitted') {
    await reject(status === 'active' ? 'Another retry pass is already active for this source. No work was queued.'
      : 'Source, settings, or eligible work changed before admission. Request a fresh preview.');
    return;
  }
  retryPreviews.invalidateSource(groupId, preview.messageId);
  try {
    await message.reply(`One targeted retry pass admitted for Ref ${preview.sourceBefore.workReference ?? 'unavailable'}: ${retryPositionSummary(preview.targets)}. Existing media, duplicate, size, permission, and storage checks still apply.`);
  } catch (error) {
    messageForError(error, { step: 'notification', reference: preview.sourceBefore.workReference, logger: input.logger });
  }

  const retry = {
    passId: preview.id,
    settingsRevision: preview.settingsRevision,
    requesterStillAuthorized: () => requesterStillAuthorized(input, requesterId),
    sourceAndPlanStillMatch: async (savedSource: import('./relayState.js').RelaySource, link: import('./relayState.js').RelayLink) => {
      const planCheck = await checkRetryLinkPlan(link, downloader);
      if (planCheck !== 'matching') {
        holdRetrySource(store, savedSource, input.logger, planCheck === 'changed' ? 'media-plan-changed' : undefined);
        return false;
      }
      const persisted = store.getRelaySource(groupId, preview.messageId);
      if (!persisted || !sameRetrySource(persisted, savedSource)) return false;
      const current = await relayWhatsapp.getSourceMessage(groupId, preview.messageId).catch(() => null);
      if (liveSourceMatches(savedSource, current)) return true;
      holdRetrySource(store, savedSource, input.logger, current ? 'source-edited' : undefined);
      return false;
    },
  };
  try {
    await executeTargetedRetry({ message: liveSource!, store, whatsapp: relayWhatsapp, downloader, timezone: input.config.timezone,
      downloadDir: input.config.downloadDir, maxMediaSizeMb: input.config.maxMediaSizeMb, control: input.control,
      queue: input.queue, logger: input.logger, retry }, liveSource!, preview.targets);
  } finally {
    if ((!input.control || input.control.canPersist()) && store.isRetryPassActive(preview.id)) store.revokeRetryPass(preview.id);
  }
}

async function requesterStillAuthorized(input: TargetedRetryCommandInput, requesterId: string): Promise<boolean> {
  const ownerId = input.store.getBotOwnerId() ?? input.config.ownerId;
  const requesterIds = idCandidates(requesterId, input.contact);
  if (idsOverlap(requesterIds, idCandidates(ownerId))) return true;
  try {
    const chat = await input.client.getChatById(input.groupId) as WhatsappChat;
    return Boolean(chat.isGroup && serializedId(chat.id) === input.groupId && participantIsAdmin(chat.participants, requesterIds));
  } catch { return false; }
}

function retryPreviewText(reference: string | undefined, targets: Array<{ linkIndex: number; itemIndexes: number[] }>): string {
  const itemCount = targets.reduce((count, target) => count + target.itemIndexes.length, 0);
  if (!itemCount) return `Ref ${reference ?? 'unavailable'} has no definitely pre-send items eligible for retry. Confirmed, skipped, and delivery-unknown work stay protected.`;
  return `Ref ${reference ?? 'unavailable'} has ${itemCount} definitely pre-send item${itemCount === 1 ? '' : 's'} eligible: ${retryPositionSummary(targets)}. No work is queued or reserved. Reply to the same source with !bot retry confirm within 5 minutes. Confirmed, skipped, and delivery-unknown items stay protected.`;
}

function retryPositionSummary(targets: Array<{ linkIndex: number; itemIndexes: number[] }>): string {
  return targets.flatMap((target) => target.itemIndexes.map((itemIndex) => `Link ${target.linkIndex + 1}, item ${itemIndex}`)).join('; ');
}

function liveSourceMatches(source: NonNullable<ReturnType<Store['getRelaySource']>>, live: IncomingMessage | null): live is IncomingMessage {
  return Boolean(live && live.isGroup && !live.fromMe && live.groupId === source.groupId && live.id === source.messageId
    && live.senderId === source.senderId && relayContentHash(live.body) === source.contentHash);
}

type CleanupTargetResult = { status: Exclude<CleanupCheckResult, 'ready'> } | { status: 'ready'; message: WhatsappMessage };

async function cleanupTarget(
  client: InstanceType<typeof Client>,
  control: RelayLifecycle,
  source: CleanupSourceIdentity,
): Promise<CleanupTargetResult> {
  if (!control.canSubmit() || !client.info) return { status: 'client-unavailable' };
  let message: WhatsappMessage | null;
  try { message = await client.getMessageById(source.messageId) as WhatsappMessage | null; }
  catch { return { status: 'unavailable' }; }
  if (!message) return { status: 'missing' };
  if (messageId(message) !== source.messageId || message.fromMe || message.from !== source.groupId) return { status: 'mismatch' };

  let chat: WhatsappChat;
  try { chat = await message.getChat(); }
  catch { return { status: 'unavailable' }; }
  if (!chat.isGroup || serializedId(chat.id) !== source.groupId) return { status: 'mismatch' };
  const current = toIncomingMessage(message, chat, source.groupId);
  if (current.senderId !== source.senderId || relayContentHash(current.body) !== source.contentHash) return { status: 'mismatch' };
  if (!message.delete) return { status: 'authority-unavailable' };

  const botId = currentBotId(client);
  if (!botId || !participantIsAdmin(chat.participants, botId)) return { status: 'authority-unavailable' };
  if (!control.canSubmit() || !client.info) return { status: 'client-unavailable' };
  return { status: 'ready', message };
}

function holdRetrySource(store: Store, expected: NonNullable<ReturnType<Store['getRelaySource']>>, logger?: (entry: Record<string, unknown>) => void, disqualification?: CleanupDisqualification): void {
  try {
    const source = store.getRelaySource(expected.groupId, expected.messageId);
    if (!source || source.contentHash !== expected.contentHash || source.senderId !== expected.senderId) return;
    const snapshotMatches = sameRetrySource(source, expected);
    const cleanupChanged = disqualification ? addCleanupDisqualification(source, disqualification) : false;
    if (!snapshotMatches) {
      if (cleanupChanged) store.saveRelaySource(source);
      return;
    }
    if (!cleanupChanged && source.status === 'held' && source.holdReason === 'source-unavailable-or-changed') return;
    source.status = 'held';
    source.holdReason = 'source-unavailable-or-changed';
    store.saveRelaySource(source);
    messageForError(userError('Work held', 'source_unavailable'), { step: 'retry', reference: source.workReference, logger });
  } catch (error) {
    if (!(error instanceof UnsupportedRelayStateError)) throw error;
  }
}

function whatsappTimestampMs(timestamp: number | undefined): number | null {
  if (!Number.isSafeInteger(timestamp) || timestamp! < 0) return null;
  const value = timestamp! * 1000;
  return Number.isSafeInteger(value) ? value : null;
}

function toIncomingMessage(message: WhatsappMessage, chat: WhatsappChat, groupId: string, contact?: WhatsappContact): IncomingMessage {
  const senderId = message.author ?? message.from;

  return {
    id: messageId(message) ?? '',
    groupId,
    senderId,
    senderName: contact?.pushname ?? contact?.name ?? contact?.number ?? senderId,
    body: messageText(message),
    timestampMs: (message.timestamp ?? Math.floor(Date.now() / 1000)) * 1000,
    isGroup: Boolean(chat.isGroup),
    fromMe: Boolean(message.fromMe),
  };
}

function messageText(message: WhatsappMessage): string {
  const parts = [message.body ?? ''];
  for (const link of message.links ?? []) {
    if (!link.isSuspicious && link.link) parts.push(link.link);
  }
  return parts.join(' ');
}

function participantIsAdmin(participants: WhatsappParticipant[] | undefined, id: string | Set<string>): boolean {
  const targetIds = typeof id === 'string' ? idCandidates(id) : id;
  return Boolean(participants?.some((participant) => idsOverlap(participantIdCandidates(participant), targetIds) && (participant.isAdmin || participant.isSuperAdmin)));
}

function currentBotId(client: InstanceType<typeof Client>): string | null {
  const info = client.info;
  if (!info?.wid) return null;
  return info.wid._serialized ?? (info.wid.user ? `${info.wid.user}@c.us` : null);
}

function messageId(message: { id?: WhatsappId } | undefined): string | null {
  return serializedId(message?.id);
}

function serializedId(value: WhatsappId | undefined): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value._serialized) return value._serialized;
  return value.user && value.server ? `${value.user}@${value.server}` : null;
}

function idCandidates(value: WhatsappId | undefined, contact?: WhatsappContact): Set<string> {
  const candidates = new Set<string>();
  addIdCandidate(candidates, serializedId(value));

  if (typeof value === 'object' && value?.user && value.server) {
    addIdCandidate(candidates, `${value.user}@${value.server}`);
  }

  addIdCandidate(candidates, serializedId(contact?.id));
  addIdCandidate(candidates, contact?.number);

  return candidates;
}

function participantIdCandidates(participant: WhatsappParticipant): Set<string> {
  const candidates = idCandidates(participant.id);
  addIdCandidate(candidates, serializedId(participant.phoneNumber));
  addIdCandidate(candidates, participant.lid);
  return candidates;
}

function idsOverlap(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) {
    if (right.has(value)) return true;
  }

  return false;
}

function addIdCandidate(candidates: Set<string>, value: string | null | undefined): void {
  if (!value) return;

  const trimmed = value.trim();
  if (!trimmed) return;

  candidates.add(trimmed);
  if (!trimmed.includes('@')) {
    candidates.add(`${trimmed}@c.us`);
    candidates.add(`${trimmed}@lid`);
  }
}
