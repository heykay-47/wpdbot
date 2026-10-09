import whatsappWeb from 'whatsapp-web.js';
import { canManageGroup, parseCommand } from './commands.js';
import { messageForError, userError } from './errorReporter.js';
import { formatGroupInspection, formatSourceInspection } from './inspection.js';
import { KeyedTaskQueue } from './keyedTaskQueue.js';
import { handleIncomingMessage, recoverRelaySources, observeRelayAcknowledgement, type IncomingMessage, type RelayDownloader } from './relay.js';
import { RelayLifecycle } from './relayLifecycle.js';
import type { AppConfig } from './config.js';
import type { RepostConfirmation, RepostEvidence, Store } from './store.js';
import { prepareWhatsappRuntime, resolveWhatsappRuntimePaths, type WhatsappRuntimePathInput } from './whatsappRuntime.js';

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
  sendText(groupId: string, text: string): Promise<void>;
};

export type WhatsappBot = {
  client: InstanceType<typeof Client>;
  relayWhatsapp: WhatsappRelay;
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
    return handleWhatsappMessage(message as WhatsappMessage, client, config, store, relayWhatsapp, downloader, relayQueue, control, resume, logger).catch((error: unknown) => {
      control.failStorage();
      logSanitizedError('Failed to handle WhatsApp message', error, 'whatsapp-message');
    });
  });

  return {
    client,
    relayWhatsapp,
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
  queue?: KeyedTaskQueue,
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
    if (!canManage) {
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
