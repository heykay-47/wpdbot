import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn(async () => ({ stdout: '' })));

const clients: MockClient[] = [];
const mediaPaths: string[] = [];
const deletedMessages: Array<{ delete: ReturnType<typeof vi.fn> }> = [];
const tempDirs: string[] = [];

function runtimePaths() {
  const root = mkdtempSync(join(tmpdir(), 'wpdbot-whatsapp-test-'));
  tempDirs.push(root);

  return {
    authDir: join(root, 'auth'),
    cacheDir: join(root, 'cache'),
  };
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
  tempDirs.length = 0;
});

class MockLocalAuth {
  clientId?: string;
  dataPath?: string;

  constructor(options: { clientId?: string; dataPath?: string } = {}) {
    this.clientId = options.clientId;
    this.dataPath = options.dataPath;
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
  sendMessage = vi.fn(async (_to: string, _content: unknown, _options?: unknown): Promise<{ id?: { _serialized: string }; ack?: number; fromMe?: boolean; to?: string }> => ({ id: { _serialized: 'sent-message-id' } }));
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
  default: {
    Client: MockClient,
    LocalAuth: MockLocalAuth,
    MessageMedia: MockMessageMedia,
  },
}));

vi.mock('execa', () => ({
  execa: execaMock,
}));

describe('formatStatus', () => {
  test('formats enabled group status exactly', async () => {
    const { formatStatus } = await import('../src/whatsapp');

    const status = formatStatus({ enabled: true, maxFileSizeMb: 64, duplicateWindowHours: 24, botIsAdmin: true });

    expect(status).toBe(
      'Bot status: enabled\nMax size: 64 MB\nDuplicate window: 24 hours\nSupported: Instagram reels/posts, YouTube Shorts\nBot admin: yes',
    );
  });
});

describe('index entrypoint', () => {
  test('can be imported without starting WhatsApp', async () => {
    const index = await import('../src/index');

    expect(index.main).toEqual(expect.any(Function));
    expect(clients).toHaveLength(0);
  });
});

describe('createWhatsappBot', () => {
  beforeEach(() => {
    clients.length = 0;
    mediaPaths.length = 0;
    deletedMessages.length = 0;
    execaMock.mockClear();
    vi.clearAllMocks();
  });

  test('creates client with LocalAuth, explicit runtime paths, and prepares before initialize', async () => {
    const { createWhatsappBot } = await import('../src/whatsapp');
    const paths = runtimePaths();

    const bot = createWhatsappBot({ config: baseConfig(), store: fakeStore(), downloader: fakeDownloader(), runtimePaths: paths });

    expect(clients).toHaveLength(1);
    expect(clients[0].options).toMatchObject({
      puppeteer: {
        args: expect.arrayContaining([
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          `--disk-cache-dir=${join(paths.cacheDir, 'chrome-cache')}`,
        ]),
      },
    });
    expect((clients[0].options as { authStrategy: MockLocalAuth }).authStrategy).toBeInstanceOf(MockLocalAuth);
    expect((clients[0].options as { authStrategy: MockLocalAuth }).authStrategy.dataPath).toBe(paths.authDir);

    bot.start();
    await vi.waitFor(() => expect(clients[0].initialize).toHaveBeenCalledOnce());
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
      'Bot status: disabled\nMax size: 64 MB\nDuplicate window: 24 hours\nSupported: Instagram reels/posts, YouTube Shorts\nBot admin: yes',
    );
  });

  test('allows group admin when message author uses LID and participant has phone id', async () => {
    const { createWhatsappBot } = await import('../src/whatsapp');
    createWhatsappBot({ config: baseConfig(), store: fakeStore(), downloader: fakeDownloader() });
    const message = fakeMessage('!bot status', {
      author: 'admin-lid@lid',
      contact: { id: { _serialized: 'admin-phone@c.us' }, number: 'admin-phone', pushname: 'Admin' },
      participants: [
        { id: { _serialized: 'admin-phone@c.us', user: 'admin-phone', server: 'c.us' }, lid: 'admin-lid', isAdmin: true, isSuperAdmin: false },
        { id: { _serialized: 'bot@c.us' }, isAdmin: true, isSuperAdmin: false },
      ],
    });

    await clients[0].handlers.get('message')?.(message);

    expect(message.reply).toHaveBeenCalledWith(
      'Bot status: disabled\nMax size: 64 MB\nDuplicate window: 24 hours\nSupported: Instagram reels/posts, YouTube Shorts\nBot admin: yes',
    );
  });

  test('allows owner when configured phone id matches sender alternate LID', async () => {
    const store = fakeStore();
    store.getBotOwnerId.mockReturnValue('admin-phone@c.us');
    const { createWhatsappBot } = await import('../src/whatsapp');
    createWhatsappBot({ config: { ...baseConfig(), ownerId: 'admin-phone@c.us' }, store, downloader: fakeDownloader() });
    const message = fakeMessage('!bot status', {
      author: 'admin-lid@lid',
      contact: { id: { _serialized: 'admin-phone@c.us' }, number: 'admin-phone', pushname: 'Admin' },
      participants: [
        { id: { _serialized: 'admin-phone@c.us', user: 'admin-phone', server: 'c.us' }, lid: 'admin-lid', isAdmin: false, isSuperAdmin: false },
        { id: { _serialized: 'bot@c.us' }, isAdmin: true, isSuperAdmin: false },
      ],
    });

    await clients[0].handlers.get('message')?.(message);

    expect(message.reply).toHaveBeenCalledWith(
      'Bot status: disabled\nMax size: 64 MB\nDuplicate window: 24 hours\nSupported: Instagram reels/posts, YouTube Shorts\nBot admin: yes',
    );
  });

  test('allows owner using sender alternate LID to enable group when bot is admin', async () => {
    const store = fakeStore();
    store.getBotOwnerId.mockReturnValue('admin-phone@c.us');
    const { createWhatsappBot } = await import('../src/whatsapp');
    createWhatsappBot({ config: { ...baseConfig(), ownerId: 'admin-phone@c.us' }, store, downloader: fakeDownloader() });
    const message = fakeMessage('!bot enable', {
      author: 'admin-lid@lid',
      contact: { id: { _serialized: 'admin-phone@c.us' }, number: 'admin-phone', pushname: 'Admin' },
      participants: [
        { id: { _serialized: 'admin-phone@c.us', user: 'admin-phone', server: 'c.us' }, lid: 'admin-lid', isAdmin: false, isSuperAdmin: false },
        { id: { _serialized: 'bot@c.us' }, isAdmin: true, isSuperAdmin: false },
      ],
    });

    await clients[0].handlers.get('message')?.(message);

    expect(store.setGroupEnabled).toHaveBeenCalledWith('group-1@g.us', true);
    expect(message.reply).toHaveBeenCalledWith('Bot enabled.');
  });

  test('ignores bot-authored commands', async () => {
    const store = fakeStore();
    const { createWhatsappBot } = await import('../src/whatsapp');
    createWhatsappBot({ config: baseConfig(), store, downloader: fakeDownloader() });
    const message = fakeMessage('!bot status', { fromMe: true });

    await clients[0].handlers.get('message')?.(message);

    expect(message.reply).not.toHaveBeenCalled();
    expect(store.getGroupSettings).not.toHaveBeenCalled();
    expect(store.setGroupEnabled).not.toHaveBeenCalled();
  });

  test('relays supported link from WhatsApp links field when body is empty', async () => {
    const store = fakeStore();
    store.getGroupSettings.mockReturnValue({ groupId: 'group-1@g.us', enabled: true, maxFileSizeMb: 64, duplicateWindowHours: 24 });
    const downloader = fakeDownloader();
    const { createWhatsappBot } = await import('../src/whatsapp');
    createWhatsappBot({ config: baseConfig(), store, downloader });
    clients[0].sendMessage.mockResolvedValueOnce({ id: { _serialized: 'sent-1' }, ack: 1, fromMe: true, to: 'group-1@g.us' });
    const message = fakeMessage('', {
      links: [{ link: 'https://www.instagram.com/reel/DWJbfWGDBQg/', isSuspicious: false }],
    });

    await clients[0].handlers.get('message')?.(message);

    expect(downloader.download).toHaveBeenCalledWith('https://www.instagram.com/reel/DWJbfWGDBQg/', 64);
    expect(store.confirmMediaRepost).toHaveBeenCalledWith(
      { groupId: 'group-1@g.us', messageId: 'message-1', identity: { platform: 'instagram', postId: 'post-1', itemId: 'video-1' } },
      { messageId: 'sent-1', ack: 1 }, expect.objectContaining({ url: 'https://www.instagram.com/reel/DWJbfWGDBQg/' }),
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

  test('Instagram sends require observed server acknowledgement and never retry an ambiguous send', async () => {
    const { createWhatsappBot } = await import('../src/whatsapp');
    const bot = createWhatsappBot({ config: baseConfig(), store: fakeStore(), downloader: fakeDownloader() });
    clients[0].sendMessage.mockResolvedValueOnce({ id: { _serialized: 'instagram-1' }, ack: 1, fromMe: true, to: 'group-1@g.us' });

    await expect(bot.relayWhatsapp.sendVideoOnce('group-1@g.us', '/tmp/video.mp4', 'caption')).resolves.toEqual({ messageId: 'instagram-1', ack: 1 });
    expect(clients[0].sendMessage).toHaveBeenCalledWith('group-1@g.us', expect.any(MockMessageMedia), { caption: 'caption', waitUntilMsgSent: true });
    clients[0].sendMessage.mockClear().mockRejectedValueOnce(new Error('connection lost after submission'));

    await expect(bot.relayWhatsapp.sendVideoOnce('group-1@g.us', '/tmp/video.mp4', 'caption')).rejects.toThrow('connection lost');
    expect(clients[0].sendMessage).toHaveBeenCalledOnce();
    expect(execaMock).not.toHaveBeenCalled();
  });

  test.each([
    { id: { _serialized: 'pending' }, ack: 0, fromMe: true, to: 'group-1@g.us' },
    { id: { _serialized: '' }, ack: 1, fromMe: true, to: 'group-1@g.us' },
    { id: { _serialized: 'wrong-group' }, ack: 1, fromMe: true, to: 'other-group@g.us' },
    { id: { _serialized: 'wrong-sender' }, ack: 1, fromMe: false, to: 'group-1@g.us' },
  ])('does not claim Instagram confirmation without suitable ID, ACK, and group evidence: %j', async (result) => {
    const { createWhatsappBot } = await import('../src/whatsapp');
    const bot = createWhatsappBot({ config: baseConfig(), store: fakeStore(), downloader: fakeDownloader() });
    clients[0].sendMessage.mockResolvedValueOnce(result);

    await expect(bot.relayWhatsapp.sendVideoOnce('group-1@g.us', '/tmp/video.mp4', 'caption')).rejects.toThrow('acceptance is unknown');

    expect(clients[0].sendMessage).toHaveBeenCalledOnce();
    expect(execaMock).not.toHaveBeenCalled();
  });

  test('relayWhatsapp transcodes and retries inline video before document fallback', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { createWhatsappBot } = await import('../src/whatsapp');
    const bot = createWhatsappBot({ config: baseConfig(), store: fakeStore(), downloader: fakeDownloader() });
    clients[0].sendMessage
      .mockRejectedValueOnce(new Error('t'))
      .mockResolvedValueOnce({ id: { _serialized: 'transcoded-video-id' } });

    const sentId = await bot.relayWhatsapp.sendVideo('group-1@g.us', '/tmp/reel.mp4', 'caption');

    expect(sentId).toBe('transcoded-video-id');
    expect(execaMock).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-i', '/tmp/reel.mp4']));
    expect(execaMock.mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        'scale=1280:1280:force_original_aspect_ratio=decrease:force_divisible_by=2',
        '-crf',
        '28',
        '-maxrate',
        '1400k',
        '-bufsize',
        '2800k',
      ]),
    );
    expect(clients[0].sendMessage).toHaveBeenNthCalledWith(1, 'group-1@g.us', expect.any(MockMessageMedia), { caption: 'caption' });
    expect(clients[0].sendMessage).toHaveBeenNthCalledWith(2, 'group-1@g.us', expect.any(MockMessageMedia), {
      caption: 'caption',
    });
    expect((clients[0].sendMessage.mock.calls[1][1] as MockMessageMedia).filePath).toBe('/tmp/reel.whatsapp.mp4');
    expect(consoleError).toHaveBeenCalledWith(
      'Video upload failed; retrying after WhatsApp transcode',
      expect.objectContaining({ step: 'whatsapp-upload', message: 't', errorId: expect.stringMatching(/^ERR-[0-9A-F]{6}$/u) }),
    );
  });

  test('relayWhatsapp uses document only after transcoded inline retry fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { createWhatsappBot } = await import('../src/whatsapp');
    const bot = createWhatsappBot({ config: baseConfig(), store: fakeStore(), downloader: fakeDownloader() });
    clients[0].sendMessage
      .mockRejectedValueOnce(new Error('first failed'))
      .mockRejectedValueOnce(new Error('second failed'))
      .mockResolvedValueOnce({ id: { _serialized: 'document-message-id' } });

    const sentId = await bot.relayWhatsapp.sendVideo('group-1@g.us', '/tmp/reel.mp4', 'caption');

    expect(sentId).toBe('document-message-id');
    expect(clients[0].sendMessage).toHaveBeenNthCalledWith(3, 'group-1@g.us', expect.any(MockMessageMedia), {
      caption: 'caption',
      sendMediaAsDocument: true,
    });
    expect(consoleError).toHaveBeenCalledWith(
      'Transcoded video upload failed; retrying as document',
      expect.objectContaining({ step: 'whatsapp-transcode-upload', message: 'second failed', errorId: expect.stringMatching(/^ERR-[0-9A-F]{6}$/u) }),
    );
  });

  test('relayWhatsapp does not try document fallback after browser target closes', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { createWhatsappBot } = await import('../src/whatsapp');
    const bot = createWhatsappBot({ config: baseConfig(), store: fakeStore(), downloader: fakeDownloader() });
    clients[0].sendMessage
      .mockRejectedValueOnce(new Error('t'))
      .mockRejectedValueOnce(new Error("Attempted to use detached Frame 'abc'."));

    await expect(bot.relayWhatsapp.sendVideo('group-1@g.us', '/tmp/reel.mp4', 'caption')).rejects.toThrow('detached Frame');

    expect(clients[0].sendMessage).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalledWith(
      'Transcoded video upload failed; browser target closed',
      expect.objectContaining({
        step: 'whatsapp-transcode-upload',
        message: "Attempted to use detached Frame 'abc'.",
        errorId: expect.stringMatching(/^ERR-[0-9A-F]{6}$/u),
      }),
    );
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
    getInstagramItem: vi.fn(() => null),
    beginInstagramItem: vi.fn(() => true),
    confirmInstagramItem: vi.fn(),
    getMediaDisposition: vi.fn(() => 'ready' as const),
    beginMediaRepost: vi.fn(() => 'started' as const),
    confirmMediaRepost: vi.fn(),
    countReposts: vi.fn(() => 0),
    close: vi.fn(),
  };
}

function fakeDownloader() {
  const root = mkdtempSync(join(tmpdir(), 'wpdbot-whatsapp-download-test-'));
  tempDirs.push(root);
  const download = vi.fn(async (_url: string, _maxFileSizeMb: number) => ({ filePath: join(root, 'video.mp4'), sizeBytes: 1, tempDir: root }));
  return {
    download,
    resolveYouTube: vi.fn(async (url: string) => ({
      id: 'AbCdEf123_-', download: (maxFileSizeMb: number) => download(url, maxFileSizeMb),
    })),
    resolveInstagram: vi.fn(async (url: string) => ({
      id: 'post-1', totalItems: 1,
      items: [{ id: 'video-1', index: 1, kind: 'video' as const, download: async (maxFileSizeMb: number) => ({ ...await download(url, maxFileSizeMb), tempDir: '/tmp/download-test' }) }],
    })),
  };
}

function fakeMessage(
  body: string,
  options: {
    botIsAdmin?: boolean;
    fromMe?: boolean;
    author?: string;
    contact?: Record<string, unknown>;
    participants?: Array<Record<string, unknown>>;
    links?: Array<{ link: string; isSuspicious: boolean }>;
  } = {},
) {
  const botIsAdmin = options.botIsAdmin ?? true;
  const participants = options.participants ?? [
    { id: { _serialized: 'admin@c.us' }, isAdmin: true, isSuperAdmin: false },
    { id: { _serialized: 'bot@c.us' }, isAdmin: botIsAdmin, isSuperAdmin: false },
  ];
  return {
    id: { _serialized: 'message-1' },
    from: 'group-1@g.us',
    author: options.author ?? 'admin@c.us',
    body,
    links: options.links,
    timestamp: 1,
    fromMe: options.fromMe ?? false,
    reply: vi.fn(),
    getContact: vi.fn(async () => options.contact ?? { pushname: 'Admin', name: 'Admin', number: 'admin' }),
    getChat: vi.fn(async () => ({
      isGroup: true,
      id: { _serialized: 'group-1@g.us' },
      name: 'Group 1',
      participants,
    })),
  };
}
