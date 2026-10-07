import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createStore, type Store } from '../src/store';
import { handleIncomingMessage } from '../src/relay';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn(async () => ({ stdout: '' })));

const clients: MockClient[] = [];
const mediaPaths: string[] = [];
const deletedMessages: Array<{ delete: ReturnType<typeof vi.fn> }> = [];
const tempDirs: string[] = [];
const stores: Store[] = [];

function runtimePaths() {
  const root = mkdtempSync(join(tmpdir(), 'wpdbot-whatsapp-test-'));
  tempDirs.push(root);

  return {
    authDir: join(root, 'auth'),
    cacheDir: join(root, 'cache'),
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores) store.close();
  stores.length = 0;
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

class MockClient extends EventEmitter {
  options: unknown;
  info = { wid: { _serialized: 'bot@c.us' } };
  handlers = new Map<string, (value?: unknown) => unknown>();
  initialize = vi.fn();
  sendMessage = vi.fn(async (_to: string, _content: unknown, _options?: unknown): Promise<{ id?: { _serialized: string }; ack?: number; fromMe?: boolean; to?: string }> => ({ id: { _serialized: 'sent-message-id' } }));
  destroy = vi.fn(async () => undefined);
  getMessageById = vi.fn(async (): Promise<any> => {
    const message = { delete: vi.fn() };
    deletedMessages.push(message);
    return message;
  });

  constructor(options: unknown) {
    super();
    this.options = options;
    clients.push(this);
  }

  on(event: string, handler: (...values: any[]) => unknown) {
    this.handlers.set(event, handler);
    return super.on(event, handler);
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

  test('recovers accepted work only after the client is ready, using exact source lookup', async () => {
    const store = fakeStore();
    store.getGroupSettings.mockReturnValue({ groupId: 'group-1@g.us', enabled: true, maxFileSizeMb: 64, duplicateWindowHours: 24 });
    const downloader = fakeDownloader();
    const body = 'https://youtube.com/shorts/AbCdEf123_-';
    await handleIncomingMessage({ message: { id: 'message-1', groupId: 'group-1@g.us', senderId: 'admin@c.us', senderName: 'Admin',
      body, timestampMs: 1_000, isGroup: true, fromMe: false }, store, downloader,
      whatsapp: { sendVideo: vi.fn(), sendVideoOnce: vi.fn(), sendText: vi.fn(), deleteMessage: vi.fn() },
      timezone: 'UTC', queue: { run: async () => undefined } });
    const { createWhatsappBot } = await import('../src/whatsapp');
    createWhatsappBot({ config: baseConfig(), store, downloader });
    clients[0].getMessageById.mockResolvedValueOnce(fakeMessage(body));
    clients[0].sendMessage.mockResolvedValueOnce({ id: { _serialized: 'recovered-1' }, ack: 1, fromMe: true, to: 'group-1@g.us' });
    expect(downloader.download).not.toHaveBeenCalled();
    await clients[0].handlers.get('ready')?.();
    await vi.waitFor(() => expect(store.confirmMediaRepost).toHaveBeenCalledOnce());
    expect(clients[0].getMessageById).toHaveBeenCalledWith('message-1');
  });

  test('enables group only when requester and bot are admins', async () => {
    const store = fakeStore();
    const { createWhatsappBot } = await import('../src/whatsapp');
    createWhatsappBot({ config: baseConfig(), store, downloader: fakeDownloader() });
    const message = fakeMessage('!bot enable');

    await deliver(message);

    expect(store.setGroupEnabled).toHaveBeenCalledWith('group-1@g.us', true);
    expect(message.reply).toHaveBeenCalledWith('Bot enabled.');
  });

  test('refuses enable when bot is not admin', async () => {
    const store = fakeStore();
    const { createWhatsappBot } = await import('../src/whatsapp');
    createWhatsappBot({ config: baseConfig(), store, downloader: fakeDownloader() });
    const message = fakeMessage('!bot enable', { botIsAdmin: false });

    await deliver(message);

    expect(store.setGroupEnabled).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith('Make bot a group admin before enabling.');
  });

  test('sends status with current settings and bot admin state', async () => {
    const { createWhatsappBot } = await import('../src/whatsapp');
    createWhatsappBot({ config: baseConfig(), store: fakeStore(), downloader: fakeDownloader() });
    const message = fakeMessage('!bot status');

    await deliver(message);

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

    await deliver(message);

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

    await deliver(message);

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

    await deliver(message);

    expect(store.setGroupEnabled).toHaveBeenCalledWith('group-1@g.us', true);
    expect(message.reply).toHaveBeenCalledWith('Bot enabled.');
  });

  test('ignores bot-authored commands', async () => {
    const store = fakeStore();
    const { createWhatsappBot } = await import('../src/whatsapp');
    createWhatsappBot({ config: baseConfig(), store, downloader: fakeDownloader() });
    const message = fakeMessage('!bot status', { fromMe: true });

    await deliver(message);

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

    await deliver(message);

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
    expect(clients[0].sendMessage).toHaveBeenCalledWith('group-1@g.us', expect.any(MockMessageMedia), { caption: 'caption', waitUntilMsgSent: false });
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
    vi.useFakeTimers();
    const { createWhatsappBot } = await import('../src/whatsapp');
    const bot = createWhatsappBot({ config: baseConfig(), store: fakeStore(), downloader: fakeDownloader() });
    clients[0].sendMessage.mockResolvedValueOnce(result);

    const rejected = expect(bot.relayWhatsapp.sendVideoOnce('group-1@g.us', '/tmp/video.mp4', 'caption')).rejects.toThrow('acceptance is unknown');
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;

    expect(clients[0].sendMessage).toHaveBeenCalledOnce();
    expect(execaMock).not.toHaveBeenCalled();
  });

  test('the legacy send adapter no longer resubmits after any send exception', async () => {
    const { createWhatsappBot } = await import('../src/whatsapp');
    const bot = createWhatsappBot({ config: baseConfig(), store: fakeStore(), downloader: fakeDownloader() });
    clients[0].sendMessage.mockRejectedValueOnce(new Error('Unknown submission outcome'));
    await expect(bot.relayWhatsapp.sendVideo('group-1@g.us', '/tmp/reel.mp4', 'caption')).rejects.toThrow('Unknown submission outcome');
    expect(clients[0].sendMessage).toHaveBeenCalledOnce();
    expect(execaMock).not.toHaveBeenCalled();
  });

  test('preselected documents use the same confirmation requirements without retrying', async () => {
    const { createWhatsappBot } = await import('../src/whatsapp');
    const bot = createWhatsappBot({ config: baseConfig(), store: fakeStore(), downloader: fakeDownloader() });
    clients[0].sendMessage.mockResolvedValueOnce({ id: { _serialized: 'document-1' }, ack: 1, fromMe: true, to: 'group-1@g.us' });
    await expect(bot.relayWhatsapp.sendVideoOnce('group-1@g.us', '/tmp/video.mp4', 'caption', 'document')).resolves.toEqual({ messageId: 'document-1', ack: 1 });
    expect(clients[0].sendMessage).toHaveBeenCalledWith('group-1@g.us', expect.any(MockMessageMedia), { caption: 'caption', waitUntilMsgSent: false, sendMediaAsDocument: true });
    clients[0].sendMessage.mockClear().mockRejectedValueOnce(new Error('Unknown document outcome'));
    await expect(bot.relayWhatsapp.sendVideoOnce('group-1@g.us', '/tmp/video.mp4', 'caption', 'document')).rejects.toThrow('Unknown document outcome');
    expect(clients[0].sendMessage).toHaveBeenCalledOnce();
  });

  test('records a pending ID immediately, then confirms a matching acknowledgement without submitting again', async () => {
    const { createWhatsappBot } = await import('../src/whatsapp');
    const bot = createWhatsappBot({ config: baseConfig(), store: fakeStore(), downloader: fakeDownloader() });
    const sent = { id: { _serialized: 'pending-1' }, ack: 0, fromMe: true, to: 'group-1@g.us' };
    clients[0].sendMessage.mockResolvedValueOnce(sent);
    const observe = vi.fn();
    const submission = bot.relayWhatsapp.sendVideoOnce('group-1@g.us', '/tmp/video.mp4', 'caption', undefined, observe);
    await vi.waitFor(() => expect(observe).toHaveBeenCalledWith({ messageId: 'pending-1', ack: 0 }));
    clients[0].emit('message_ack', sent, 1);
    await expect(submission).resolves.toEqual({ messageId: 'pending-1', ack: 1 });
    expect(clients[0].sendMessage).toHaveBeenCalledOnce();
  });

  test('retains a trustworthy returned ID even when the returned acknowledgement is unavailable', async () => {
    vi.useFakeTimers();
    const { createWhatsappBot } = await import('../src/whatsapp');
    const bot = createWhatsappBot({ config: baseConfig(), store: fakeStore(), downloader: fakeDownloader() });
    clients[0].sendMessage.mockResolvedValueOnce({ id: { _serialized: 'unknown-ack' }, fromMe: true, to: 'group-1@g.us' });
    const observe = vi.fn();
    const rejected = expect(bot.relayWhatsapp.sendVideoOnce('group-1@g.us', '/tmp/video.mp4', 'caption', undefined, observe)).rejects.toThrow('acceptance is unknown');
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(observe).toHaveBeenCalledWith({ messageId: 'unknown-ack', ack: null });
    expect(clients[0].sendMessage).toHaveBeenCalledOnce();
  });

  test('bounds an unresolved submission while still reporting positive evidence when its promise finishes late', async () => {
    vi.useFakeTimers();
    const { createWhatsappBot } = await import('../src/whatsapp');
    const bot = createWhatsappBot({ config: baseConfig(), store: fakeStore(), downloader: fakeDownloader() });
    let finish!: (value: any) => void;
    clients[0].sendMessage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const observe = vi.fn();
    const rejected = expect(bot.relayWhatsapp.sendVideoOnce('group-1@g.us', '/tmp/video.mp4', 'caption', undefined, observe)).rejects.toThrow('acceptance is unknown');
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    finish({ id: { _serialized: 'late-1' }, ack: 1, fromMe: true, to: 'group-1@g.us' });
    await vi.advanceTimersByTimeAsync(0);
    expect(observe).toHaveBeenCalledWith({ messageId: 'late-1', ack: 1 });
    expect(clients[0].sendMessage).toHaveBeenCalledOnce();
  });

  test('correlates an ACK observed after timeout but before the send promise returns its ID', async () => {
    vi.useFakeTimers();
    const { createWhatsappBot } = await import('../src/whatsapp');
    const bot = createWhatsappBot({ config: baseConfig(), store: fakeStore(), downloader: fakeDownloader() });
    let finish!: (value: any) => void;
    clients[0].sendMessage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const observe = vi.fn();
    const rejected = expect(bot.relayWhatsapp.sendVideoOnce('group-1@g.us', '/tmp/video.mp4', 'caption', undefined, observe)).rejects.toThrow('acceptance is unknown');
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    await vi.advanceTimersByTimeAsync(1_000);
    clients[0].emit('message_ack', { id: { _serialized: 'unrelated-repost' }, fromMe: true, to: 'group-1@g.us' }, 4);
    clients[0].emit('message_ack', { id: { _serialized: 'late-1' }, fromMe: true, to: 'group-1@g.us' }, 1);
    await vi.advanceTimersByTimeAsync(1_000);
    finish({ id: { _serialized: 'late-1' }, ack: 0, fromMe: true, to: 'group-1@g.us' });
    await vi.advanceTimersByTimeAsync(0);
    expect(observe).toHaveBeenCalledWith({ messageId: 'late-1', ack: 1 });
    expect(clients[0].sendMessage).toHaveBeenCalledOnce();
    expect(clients[0].listenerCount('message_ack')).toBe(1);
  });

  test.each(['cached', 'returned'] as const)('keeps positive %s ACK evidence when another observation is stale', async (mode) => {
    vi.useFakeTimers();
    const { createWhatsappBot } = await import('../src/whatsapp');
    const bot = createWhatsappBot({ config: baseConfig(), store: fakeStore(), downloader: fakeDownloader() });
    let finish!: (value: any) => void;
    clients[0].sendMessage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const confirmed = bot.relayWhatsapp.sendVideoOnce('group-1@g.us', '/tmp/video.mp4', 'caption').catch((error: unknown) => error);
    const sent = { id: { _serialized: 'repost-1' }, fromMe: true, to: 'group-1@g.us' };
    if (mode === 'cached') clients[0].emit('message_ack', sent, 1);
    clients[0].emit('message_ack', sent, 0);
    finish({ ...sent, ack: mode === 'returned' ? 1 : 0 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await confirmed).toEqual({ messageId: 'repost-1', ack: 1 });
  });

  test('shutdown removes unresolved-ID ACK correlations and ignores callbacks arriving after close', async () => {
    vi.useFakeTimers();
    const { createWhatsappBot } = await import('../src/whatsapp');
    const bot = createWhatsappBot({ config: baseConfig(), store: fakeStore(), downloader: fakeDownloader() });
    let finish!: (value: any) => void;
    clients[0].sendMessage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const observe = vi.fn();
    const rejected = expect(bot.relayWhatsapp.sendVideoOnce('group-1@g.us', '/tmp/video.mp4', 'caption', undefined, observe)).rejects.toThrow('acceptance is unknown');
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    await bot.stop();
    expect(clients[0].listenerCount('message_ack')).toBe(1);
    clients[0].emit('message_ack', { id: { _serialized: 'after-close' }, fromMe: true, to: 'group-1@g.us' }, 1);
    finish({ id: { _serialized: 'after-close' }, ack: 1, fromMe: true, to: 'group-1@g.us' });
    await vi.advanceTimersByTimeAsync(0);
    expect(observe).not.toHaveBeenCalled();
  });

  test('shutdown drains active submissions before destroying the client, without logging out or starting queued work', async () => {
    const { createWhatsappBot } = await import('../src/whatsapp');
    const store = fakeStore();
    store.getGroupSettings.mockReturnValue({ groupId: 'group-1@g.us', enabled: true, maxFileSizeMb: 64, duplicateWindowHours: 24 });
    const bot = createWhatsappBot({ config: baseConfig(), store, downloader: fakeDownloader() });
    await clients[0].handlers.get('ready')?.();
    let finish!: (value: any) => void;
    clients[0].sendMessage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const relaying = clients[0].handlers.get('message')?.(fakeMessage('https://youtube.com/shorts/AbCdEf123_-'));
    await vi.waitFor(() => expect(clients[0].sendMessage).toHaveBeenCalledOnce());
    const stopping = bot.stop();
    await clients[0].handlers.get('message')?.(fakeMessage('https://instagram.com/p/other/'));
    expect(clients[0].destroy).not.toHaveBeenCalled();
    finish({ id: { _serialized: 'shutdown-1' }, ack: 1, fromMe: true, to: 'group-1@g.us' });
    await stopping;
    await relaying;
    expect(store.confirmMediaRepost).toHaveBeenCalledOnce();
    expect(clients[0].destroy).toHaveBeenCalledOnce();
    expect(clients[0].sendMessage).toHaveBeenCalledOnce();
  });
});

function baseConfig() {
  return {
    ownerId: 'owner@c.us',
    sqlitePath: ':memory:',
    timezone: 'UTC',
    maxFileSizeMb: 64,
    maxMediaSizeMb: 64,
    duplicateWindowHours: 24,
    downloadDir: '/tmp/wpdbot-test',
  };
}

async function deliver(message: ReturnType<typeof fakeMessage>) {
  await clients[0].handlers.get('ready')?.();
  return clients[0].handlers.get('message')?.(message);
}

function fakeStore() {
  const store = createStore(':memory:');
  stores.push(store);
  return {
    ...store,
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
    beginMediaRepost: vi.fn(store.beginMediaRepost),
    confirmMediaRepost: vi.fn(store.confirmMediaRepost),
    countReposts: vi.fn(() => 0),
    close: vi.fn(),
  };
}

function fakeDownloader() {
  const root = mkdtempSync(join(tmpdir(), 'wpdbot-whatsapp-download-test-'));
  writeFileSync(join(root, 'video.mp4'), 'v');
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
