import { beforeEach, describe, expect, test, vi } from 'vitest';

const clients: MockClient[] = [];
const mediaPaths: string[] = [];
const deletedMessages: Array<{ delete: ReturnType<typeof vi.fn> }> = [];

class MockLocalAuth {
  clientId?: string;

  constructor(options: { clientId?: string } = {}) {
    this.clientId = options.clientId;
  }
}

class MockMessageMedia {
  filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  static fromFilePath(filePath: string) {
    mediaPaths.push(filePath);
    return new MockMessageMedia(filePath);
  }
}

class MockClient {
  options: unknown;
  info = { wid: { _serialized: 'bot@c.us' } };
  handlers = new Map<string, (value?: unknown) => unknown>();
  initialize = vi.fn();
  sendMessage = vi.fn(async (_to: string, _content: unknown, _options?: unknown) => ({ id: { _serialized: 'sent-message-id' } }));
  getMessageById = vi.fn(async () => {
    const message = { delete: vi.fn() };
    deletedMessages.push(message);
    return message;
  });

  constructor(options: unknown) {
    this.options = options;
    clients.push(this);
  }

  on(event: string, handler: (value?: unknown) => unknown) {
    this.handlers.set(event, handler);
    return this;
  }
}

vi.mock('qrcode-terminal', () => ({
  default: { generate: vi.fn() },
  generate: vi.fn(),
}));

vi.mock('whatsapp-web.js', () => ({
  Client: MockClient,
  LocalAuth: MockLocalAuth,
  MessageMedia: MockMessageMedia,
}));

describe('formatStatus', () => {
  test('formats enabled group status exactly', async () => {
    const { formatStatus } = await import('../src/whatsapp');

    const status = formatStatus({ enabled: true, maxFileSizeMb: 64, duplicateWindowHours: 24, botIsAdmin: true });

    expect(status).toBe(
      'Bot status: enabled\nMax size: 64 MB\nDuplicate window: 24 hours\nSupported: YouTube, Instagram, Facebook\nBot admin: yes',
    );
  });
});

describe('createWhatsappBot', () => {
  beforeEach(() => {
    clients.length = 0;
    mediaPaths.length = 0;
    deletedMessages.length = 0;
    vi.clearAllMocks();
  });

  test('creates client with LocalAuth and no-sandbox puppeteer args', async () => {
    const { createWhatsappBot } = await import('../src/whatsapp');

    const bot = createWhatsappBot({ config: baseConfig(), store: fakeStore(), downloader: fakeDownloader() });

    expect(clients).toHaveLength(1);
    expect(clients[0].options).toMatchObject({ puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] } });
    expect((clients[0].options as { authStrategy: MockLocalAuth }).authStrategy).toBeInstanceOf(MockLocalAuth);
    bot.start();
    expect(clients[0].initialize).toHaveBeenCalledOnce();
  });

  test('enables group only when requester and bot are admins', async () => {
    const store = fakeStore();
    const { createWhatsappBot } = await import('../src/whatsapp');
    createWhatsappBot({ config: baseConfig(), store, downloader: fakeDownloader() });
    const message = fakeMessage('!bot enable');

    await clients[0].handlers.get('message')?.(message);

    expect(store.setGroupEnabled).toHaveBeenCalledWith('group-1@g.us', true);
    expect(message.reply).toHaveBeenCalledWith('Bot enabled.');
  });

  test('refuses enable when bot is not admin', async () => {
    const store = fakeStore();
    const { createWhatsappBot } = await import('../src/whatsapp');
    createWhatsappBot({ config: baseConfig(), store, downloader: fakeDownloader() });
    const message = fakeMessage('!bot enable', { botIsAdmin: false });

    await clients[0].handlers.get('message')?.(message);

    expect(store.setGroupEnabled).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith('Make bot a group admin before enabling.');
  });

  test('sends status with current settings and bot admin state', async () => {
    const { createWhatsappBot } = await import('../src/whatsapp');
    createWhatsappBot({ config: baseConfig(), store: fakeStore(), downloader: fakeDownloader() });
    const message = fakeMessage('!bot status');

    await clients[0].handlers.get('message')?.(message);

    expect(message.reply).toHaveBeenCalledWith(
      'Bot status: disabled\nMax size: 64 MB\nDuplicate window: 24 hours\nSupported: YouTube, Instagram, Facebook\nBot admin: yes',
    );
  });

  test('relayWhatsapp sends video, text, and deletes messages for everyone', async () => {
    const { createWhatsappBot } = await import('../src/whatsapp');
    const bot = createWhatsappBot({ config: baseConfig(), store: fakeStore(), downloader: fakeDownloader() });

    const sentId = await bot.relayWhatsapp.sendVideo('group-1@g.us', '/tmp/video.mp4', 'caption');
    await bot.relayWhatsapp.sendText('group-1@g.us', 'hello');
    await bot.relayWhatsapp.deleteMessage('group-1@g.us', 'message-1');

    expect(mediaPaths).toEqual(['/tmp/video.mp4']);
    expect(sentId).toBe('sent-message-id');
    expect(clients[0].sendMessage).toHaveBeenCalledWith('group-1@g.us', expect.any(MockMessageMedia), { caption: 'caption' });
    expect(clients[0].sendMessage).toHaveBeenCalledWith('group-1@g.us', 'hello');
    expect(clients[0].getMessageById).toHaveBeenCalledWith('message-1');
    expect(deletedMessages[0].delete).toHaveBeenCalledWith(true);
  });
});

function baseConfig() {
  return {
    ownerId: 'owner@c.us',
    sqlitePath: ':memory:',
    timezone: 'UTC',
    maxFileSizeMb: 64,
    duplicateWindowHours: 24,
    downloadDir: '/tmp/wpdbot-test',
  };
}

function fakeStore() {
  return {
    getGroupSettings: vi.fn(() => ({ groupId: 'group-1@g.us', enabled: false, maxFileSizeMb: 64, duplicateWindowHours: 24 })),
    setGroupEnabled: vi.fn(),
    recordDuplicate: vi.fn(),
    wasRecentlyPosted: vi.fn(() => false),
    setGroupMetadata: vi.fn(),
    getGroupMetadata: vi.fn(() => null),
    setBotOwnerId: vi.fn(),
    getBotOwnerId: vi.fn(() => 'owner@c.us'),
    recordRepost: vi.fn(),
    recordSuccessfulRepost: vi.fn(),
    countReposts: vi.fn(() => 0),
    close: vi.fn(),
  };
}

function fakeDownloader() {
  return { download: vi.fn(async () => ({ filePath: '/tmp/video.mp4', sizeBytes: 1 })) };
}

function fakeMessage(body: string, options: { botIsAdmin?: boolean } = {}) {
  const botIsAdmin = options.botIsAdmin ?? true;
  return {
    id: { _serialized: 'message-1' },
    from: 'group-1@g.us',
    author: 'admin@c.us',
    body,
    timestamp: 1,
    fromMe: false,
    reply: vi.fn(),
    getContact: vi.fn(async () => ({ pushname: 'Admin', name: 'Admin', number: 'admin' })),
    getChat: vi.fn(async () => ({
      isGroup: true,
      id: { _serialized: 'group-1@g.us' },
      name: 'Group 1',
      participants: [
        { id: { _serialized: 'admin@c.us' }, isAdmin: true, isSuperAdmin: false },
        { id: { _serialized: 'bot@c.us' }, isAdmin: botIsAdmin, isSuperAdmin: false },
      ],
    })),
  };
}
