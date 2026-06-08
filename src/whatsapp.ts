import qrcode from 'qrcode-terminal';
import whatsappWeb from 'whatsapp-web.js';
import { canEnableGroup, canManageGroup, parseCommand } from './commands.js';
import { handleIncomingMessage, type IncomingMessage, type RelayDownloader } from './relay.js';
import type { AppConfig } from './config.js';
import type { Store } from './store.js';

const { Client, LocalAuth, MessageMedia } = whatsappWeb;

export type StatusInput = {
  enabled: boolean;
  maxFileSizeMb: number;
  duplicateWindowHours: number;
  botIsAdmin: boolean;
};

export type WhatsappRelay = {
  sendVideo(groupId: string, filePath: string, caption: string): Promise<string>;
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
};

type WhatsappMessage = {
  id?: { _serialized?: string } | string;
  from: string;
  author?: string;
  body?: string;
  timestamp?: number;
  fromMe?: boolean;
  reply(text: string): Promise<unknown> | unknown;
  getChat(): Promise<WhatsappChat>;
  getContact?(): Promise<{ pushname?: string; name?: string; number?: string }>;
};

type WhatsappChat = {
  isGroup?: boolean;
  id?: { _serialized?: string } | string;
  name?: string;
  participants?: WhatsappParticipant[];
};

type WhatsappParticipant = {
  id?: { _serialized?: string } | string;
  isAdmin?: boolean;
  isSuperAdmin?: boolean;
};

export function formatStatus({ enabled, maxFileSizeMb, duplicateWindowHours, botIsAdmin }: StatusInput): string {
  return [
    `Bot status: ${enabled ? 'enabled' : 'disabled'}`,
    `Max size: ${maxFileSizeMb} MB`,
    `Duplicate window: ${duplicateWindowHours} hours`,
    'Supported: YouTube, Instagram, Facebook',
    `Bot admin: ${botIsAdmin ? 'yes' : 'no'}`,
  ].join('\n');
}

export function createWhatsappBot({ config, store, downloader }: CreateWhatsappBotInput): WhatsappBot {
  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  });

  const relayWhatsapp: WhatsappRelay = {
    async sendVideo(groupId, filePath, caption) {
      const sent = await client.sendMessage(groupId, MessageMedia.fromFilePath(filePath), { caption });
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
    void handleWhatsappMessage(message as WhatsappMessage, client, config, store, relayWhatsapp, downloader);
  });

  return {
    client,
    relayWhatsapp,
    start() {
      client.initialize();
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
): Promise<void> {
  const chat = await message.getChat();
  if (!chat.isGroup) return;

  const groupId = chatId(chat) ?? message.from;
  store.setGroupMetadata(groupId, chat.name ?? groupId, Date.now());

  const senderId = message.author ?? message.from;
  const botId = currentBotId(client);
  const senderIsGroupAdmin = participantIsAdmin(chat.participants, senderId);
  const botIsAdmin = botId ? participantIsAdmin(chat.participants, botId) : false;
  const command = parseCommand(message.body ?? '');

  if (command) {
    const ownerId = store.getBotOwnerId() ?? config.ownerId;
    const canManage = canManageGroup({ senderId, ownerId, senderIsGroupAdmin });
    if (!canManage) {
      await message.reply('Only group admins or bot owner can manage bot.');
      return;
    }

    if (command.action === 'enable') {
      if (!canEnableGroup({ senderId, ownerId, senderIsGroupAdmin, botIsGroupAdmin: botIsAdmin })) {
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
    await message.reply(formatStatus({ ...settings, botIsAdmin }));
    return;
  }

  await handleIncomingMessage({
    message: await toIncomingMessage(message, chat, groupId),
    store,
    whatsapp: {
      sendVideo: async (targetGroupId, filePath, caption) => {
        await relayWhatsapp.sendVideo(targetGroupId, filePath, caption);
      },
      sendText: relayWhatsapp.sendText,
      deleteMessage: async (messageIdValue) => relayWhatsapp.deleteMessage(groupId, messageIdValue),
    },
    downloader,
    timezone: config.timezone,
    downloadDir: config.downloadDir,
    nowMs: Date.now(),
  });
}

async function toIncomingMessage(message: WhatsappMessage, chat: WhatsappChat, groupId: string): Promise<IncomingMessage> {
  const contact = await message.getContact?.();
  const senderId = message.author ?? message.from;

  return {
    id: messageId(message) ?? '',
    groupId,
    senderId,
    senderName: contact?.pushname ?? contact?.name ?? contact?.number ?? senderId,
    body: message.body ?? '',
    timestampMs: (message.timestamp ?? Math.floor(Date.now() / 1000)) * 1000,
    isGroup: Boolean(chat.isGroup),
    fromMe: Boolean(message.fromMe),
  };
}

function chatId(chat: WhatsappChat): string | null {
  return serializedId(chat.id);
}

function participantIsAdmin(participants: WhatsappParticipant[] | undefined, id: string): boolean {
  const normalizedId = normalizeId(id);
  return Boolean(participants?.some((participant) => normalizeId(serializedId(participant.id) ?? '') === normalizedId && (participant.isAdmin || participant.isSuperAdmin)));
}

function currentBotId(client: InstanceType<typeof Client>): string | null {
  const info = (client as unknown as { info?: { wid?: { _serialized?: string; user?: string } } }).info;
  if (!info?.wid) return null;
  return info.wid._serialized ?? (info.wid.user ? `${info.wid.user}@c.us` : null);
}

function messageId(message: unknown): string | null {
  return serializedId((message as { id?: { _serialized?: string } | string } | undefined)?.id);
}

function serializedId(value: { _serialized?: string } | string | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value._serialized ?? null;
}

function normalizeId(value: string): string {
  return value.includes('@') ? value : `${value}@c.us`;
}
