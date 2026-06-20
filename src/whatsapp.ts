import { rm } from 'node:fs/promises';
import { dirname, extname, join, basename } from 'node:path';
import qrcode from 'qrcode-terminal';
import whatsappWeb from 'whatsapp-web.js';
import { execa } from 'execa';
import { canManageGroup, parseCommand } from './commands.js';
import { messageForError } from './errorReporter.js';
import { KeyedTaskQueue } from './keyedTaskQueue.js';
import { handleIncomingMessage, type IncomingMessage, type RelayDownloader } from './relay.js';
import type { AppConfig } from './config.js';
import type { Store } from './store.js';
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
    async sendVideo(groupId, filePath, caption) {
      const media = MessageMedia.fromFilePath(filePath);
      let sent: unknown;
      let transcodedPath: string | null = null;

      try {
        sent = await client.sendMessage(groupId, media, { caption });
      } catch (error) {
        logSanitizedError('Video upload failed; retrying after WhatsApp transcode', error, 'whatsapp-upload');

        try {
          transcodedPath = await transcodeForWhatsapp(filePath);
          sent = await client.sendMessage(groupId, MessageMedia.fromFilePath(transcodedPath), { caption });
        } catch (transcodeOrUploadError) {
          if (isBrowserTargetClosedError(transcodeOrUploadError)) {
            logSanitizedError('Transcoded video upload failed; browser target closed', transcodeOrUploadError, 'whatsapp-transcode-upload');
            throw transcodeOrUploadError;
          }

          logSanitizedError('Transcoded video upload failed; retrying as document', transcodeOrUploadError, 'whatsapp-transcode-upload');
          sent = await client.sendMessage(groupId, media, { caption, sendMediaAsDocument: true });
        } finally {
          if (transcodedPath) await rm(transcodedPath, { force: true }).catch(() => undefined);
        }
      }

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

  const groupId = chatId(chat) ?? message.from;
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
    await message.reply(formatStatus({ ...settings, botIsAdmin }));
    return;
  }

  await handleIncomingMessage({
    message: await toIncomingMessage(message, chat, groupId, contact),
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
    queue,
    logger: (entry) => console.error('Relay error', entry),
  });
}

async function toIncomingMessage(message: WhatsappMessage, chat: WhatsappChat, groupId: string, contact?: WhatsappContact): Promise<IncomingMessage> {
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

function chatId(chat: WhatsappChat): string | null {
  return serializedId(chat.id);
}

function participantIsAdmin(participants: WhatsappParticipant[] | undefined, id: string | Set<string>): boolean {
  const targetIds = typeof id === 'string' ? idCandidates(id) : id;
  return Boolean(participants?.some((participant) => idsOverlap(participantIdCandidates(participant), targetIds) && (participant.isAdmin || participant.isSuperAdmin)));
}

function currentBotId(client: InstanceType<typeof Client>): string | null {
  const info = (client as unknown as { info?: { wid?: { _serialized?: string; user?: string } } }).info;
  if (!info?.wid) return null;
  return info.wid._serialized ?? (info.wid.user ? `${info.wid.user}@c.us` : null);
}

function messageId(message: unknown): string | null {
  return serializedId((message as { id?: { _serialized?: string } | string } | undefined)?.id);
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

  if (typeof value === 'object' && value) {
    addUserServerCandidate(candidates, value.user, value.server);
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

function addUserServerCandidate(candidates: Set<string>, user: string | undefined, server: string | undefined): void {
  if (user && server) addIdCandidate(candidates, `${user}@${server}`);
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

function isBrowserTargetClosedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Target closed') || message.includes('detached Frame');
}

async function transcodeForWhatsapp(filePath: string): Promise<string> {
  const extension = extname(filePath);
  const baseName = basename(filePath, extension);
  const outputPath = join(dirname(filePath), `${baseName}.whatsapp.mp4`);

  try {
    await execa('ffmpeg', [
    '-y',
    '-i',
    filePath,
    '-vf',
    'scale=1280:1280:force_original_aspect_ratio=decrease:force_divisible_by=2',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '28',
    '-maxrate',
    '1400k',
    '-bufsize',
    '2800k',
    '-pix_fmt',
    'yuv420p',
    '-profile:v',
    'baseline',
    '-level',
    '3.1',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
      outputPath,
    ]);
  } catch (error) {
    await rm(outputPath, { force: true }).catch(() => undefined);
    throw error;
  }

  return outputPath;
}
