import qrcode from 'qrcode-terminal';
import whatsappWeb from 'whatsapp-web.js';
import { canManageGroup, parseCommand } from './commands.js';
import { messageForError } from './errorReporter.js';
import { KeyedTaskQueue } from './keyedTaskQueue.js';
import { handleIncomingMessage, type IncomingMessage, type RelayDownloader } from './relay.js';
import type { AppConfig } from './config.js';
import type { RepostConfirmation, Store } from './store.js';
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
  sendVideoOnce(groupId: string, filePath: string, caption: string, deliveryMode?: 'document'): Promise<RepostConfirmation>;
  deleteMessage(groupId: string, messageId: string): Promise<void>;
  sendText(groupId: string, text: string): Promise<void>;
};

export type WhatsappBot = {
  client: InstanceType<typeof Client>;
  relayWhatsapp: WhatsappRelay;
  start(): void;
};

type CreateWhatsappBotInput = {
  config: AppConfig;
  store: Store;
  downloader: RelayDownloader;
  queue?: KeyedTaskQueue;
  runtimePaths?: WhatsappRuntimePathInput;
};

type WhatsappMessage = {
  id?: { _serialized?: string } | string;
  from: string;
  author?: string;
  body?: string;
  links?: Array<{ link?: string; isSuspicious?: boolean }>;
  timestamp?: number;
  fromMe?: boolean;
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

export function createWhatsappBot({ config, store, downloader, queue, runtimePaths: runtimePathInput }: CreateWhatsappBotInput): WhatsappBot {
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

  const relayWhatsapp: WhatsappRelay = {
    async sendVideoOnce(groupId, filePath, caption, deliveryMode) {
      const media = MessageMedia.fromFilePath(filePath);
      const sent = await client.sendMessage(groupId, media, { caption, waitUntilMsgSent: true, ...(deliveryMode === 'document' ? { sendMediaAsDocument: true } : {}) });
      const id = messageId(sent);
      if (!id?.trim() || !sent?.fromMe || sent.to !== groupId || !Number.isInteger(sent.ack) || sent.ack < 1 || sent.ack > 4) {
        throw new Error('Repost acceptance is unknown');
      }
      return { messageId: id, ack: sent.ack };
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

  client.on('qr', (qr) => qrcode.generate(qr, { small: true }));
  client.on('ready', () => console.log('WhatsApp client ready'));
  client.on('message', (message) => {
    return handleWhatsappMessage(message as WhatsappMessage, client, config, store, relayWhatsapp, downloader, queue).catch((error: unknown) => {
      logSanitizedError('Failed to handle WhatsApp message', error, 'whatsapp-message');
    });
  });

  return {
    client,
    relayWhatsapp,
    start() {
      void prepareWhatsappRuntime(runtimePaths)
        .then(() => client.initialize())
        .catch((error: unknown) => {
          logSanitizedError('Failed to prepare WhatsApp runtime', error, 'whatsapp-runtime');
        });
    },
  };
}

function logSanitizedError(message: string, error: unknown, step: string): void {
  messageForError(error, {
    step,
    logger: (entry) => console.error(message, entry),
  });
}

async function handleWhatsappMessage(
  message: WhatsappMessage,
  client: InstanceType<typeof Client>,
  config: AppConfig,
  store: Store,
  relayWhatsapp: WhatsappRelay,
  downloader: RelayDownloader,
  queue?: KeyedTaskQueue,
): Promise<void> {
  const chat = await message.getChat();
  if (!chat.isGroup) return;
  if (message.fromMe) return;

  const groupId = serializedId(chat.id) ?? message.from;
  store.setGroupMetadata(groupId, chat.name ?? groupId, Date.now());

  const senderId = message.author ?? message.from;
  const contact = await message.getContact?.();
  const botId = currentBotId(client);
  const senderIds = idCandidates(senderId, contact);
  const senderIsGroupAdmin = participantIsAdmin(chat.participants, senderIds);
  const botIsAdmin = botId ? participantIsAdmin(chat.participants, botId) : false;
  const command = parseCommand(message.body ?? '');

  if (command) {
    const ownerId = store.getBotOwnerId() ?? config.ownerId;
    const canManage = canManageGroup({ senderId, ownerId, senderIsGroupAdmin }) || idsOverlap(senderIds, idCandidates(ownerId));
    if (!canManage) {
      await message.reply('Only group admins or bot owner can manage bot.');
      return;
    }

    if (command.action === 'enable') {
      if (!botIsAdmin) {
        await message.reply('Make bot a group admin before enabling.');
        return;
      }

      store.setGroupEnabled(groupId, true);
      await message.reply('Bot enabled.');
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
      deleteMessage: async (messageIdValue) => relayWhatsapp.deleteMessage(groupId, messageIdValue),
    },
    downloader,
    timezone: config.timezone,
    downloadDir: config.downloadDir,
    maxMediaSizeMb: config.maxMediaSizeMb,
    queue,
    logger: (entry) => console.error('Relay error', entry),
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
