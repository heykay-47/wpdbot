import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createStore, type Store } from '../src/store';
import { handleIncomingMessage, relayContentHash } from '../src/relay';
import type { RelaySource } from '../src/relayState';
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
  getChatById = vi.fn(async (id: string): Promise<any> => ({
    isGroup: id.endsWith('@g.us'),
    id: { _serialized: id },
    participants: [
      { id: { _serialized: 'admin@c.us' }, isAdmin: true, isSuperAdmin: false },
      { id: { _serialized: 'bot@c.us' }, isAdmin: true, isSuperAdmin: false },
    ],
  }));

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

  test('authorized inspection works while disabled and keeps foreign references out of the summary', async () => {
    const store = fakeStore();
    const { createWhatsappBot } = await import('../src/whatsapp');
    createWhatsappBot({ config: baseConfig(), store, downloader: fakeDownloader() });
    const message = fakeMessage(' !BOT INSPECT ');
    await deliver(message);
    expect(message.reply).toHaveBeenCalledWith('Unfinished work in this group: 0 sources');
    expect(store.setGroupEnabled).not.toHaveBeenCalled();
  });

  test.each(['foreign', 'missing', 'untracked'])('rejects %s quoted targets without falling back to a group summary', async (kind) => {
    const store = fakeStore();
    const list = vi.spyOn(store, 'listRelaySources');
    const { createWhatsappBot } = await import('../src/whatsapp');
    createWhatsappBot({ config: baseConfig(), store, downloader: fakeDownloader() });
    const quoted = kind === 'missing' ? null : { ...fakeMessage('private source'), from: kind === 'foreign' ? 'other-group@g.us' : 'group-1@g.us' };
    const message = Object.assign(fakeMessage('!bot inspect'), { hasQuotedMsg: true, getQuotedMessage: vi.fn(async () => quoted) });
    await deliver(message);
    expect(message.reply).toHaveBeenCalledWith('Quoted source unavailable or untracked in this group. No work details shown.');
    expect(list).toHaveBeenCalledTimes(1); // Ready recovery only, not inspection fallback.
  });

  test('unauthorized inspection never resolves a quote or reads work', async () => {
    const store = fakeStore();
    const list = vi.spyOn(store, 'listRelaySources');
    const get = vi.spyOn(store, 'getRelaySource');
    const logger = vi.fn();
    const { createWhatsappBot } = await import('../src/whatsapp');
    createWhatsappBot({ config: baseConfig(), store, downloader: fakeDownloader(), logger });
    const message = Object.assign(fakeMessage('!bot inspect', { author: 'member@c.us', contact: { number: 'member' } }),
      { hasQuotedMsg: true, getQuotedMessage: vi.fn() });
    await deliver(message);
    expect(message.getQuotedMessage).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(1); // Ready recovery only.
    expect(get).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith(expect.stringContaining('no work details were shown'));
    expect(logger).toHaveBeenCalledWith(expect.objectContaining({ cause: 'permission_rejected' }));
    expect(JSON.stringify(logger.mock.calls)).not.toContain('member');
  });

  test('daemon never renders QR credentials or relays before authentication', async () => {
    const logger = vi.fn();
    const qr = await import('qrcode-terminal');
    const { createWhatsappBot } = await import('../src/whatsapp');
    createWhatsappBot({ config: baseConfig(), store: fakeStore(), downloader: fakeDownloader(), logger });
    clients[0].emit('qr', 'PRIVATE-QR-CANARY');
    clients[0].emit('qr', 'PRIVATE-QR-REFRESH');
    clients[0].emit('auth_failure', 'PRIVATE-FAILURE');
    expect(qr.default.generate).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.mock.calls)).not.toContain('PRIVATE');
    expect(logger).toHaveBeenCalledOnce();
    expect(logger).toHaveBeenCalledWith(expect.objectContaining({ cause: 'auth_required', stage: 'auth' }));
    await clients[0].handlers.get('message')?.(fakeMessage('!bot enable'));
    expect(clients[0].sendMessage).not.toHaveBeenCalled();
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

  test.each([
    ['!BOT SET MAX-SIZE 32', { maxFileSizeMb: 32 }, 'Maximum media size set to 32 MiB.'],
    ['!bot set duplicate-window 0', { duplicateWindowHours: 0 }, 'Duplicate window set to 0 hours.'],
  ])('updates one validated group setting with %s', async (body, update, reply) => {
    const store = fakeStore();
    const set = vi.spyOn(store, 'setGroupSettings');
    const { createWhatsappBot } = await import('../src/whatsapp');
    createWhatsappBot({ config: baseConfig(), store, downloader: fakeDownloader() });
    const message = fakeMessage(body);

    await deliver(message);

    expect(set).toHaveBeenCalledWith('group-1@g.us', update);
    expect(message.reply).toHaveBeenCalledWith(reply);
  });

  test('previews and admits one age-bypassing targeted retry for only the exact definitely pre-intent item', async () => {
    const store = createStore(':memory:');
    stores.push(store);
    const groupId = 'group-1@g.us';
    const sourceId = 'source-retry-1';
    const body = 'https://youtube.com/shorts/AbCdEf123_-';
    const acceptedAtMs = Date.now() - 25 * 60 * 60 * 1000;
    const source: RelaySource = {
      version: 1, groupId, messageId: sourceId, senderId: 'admin@c.us', senderName: 'Admin', timestampMs: acceptedAtMs,
      acceptedAtMs, contentHash: relayContentHash(body), status: 'held', holdReason: 'stale', cleanup: 'retained',
      links: [{ url: body, platform: 'youtube', urlHash: 'retry-hash', status: 'failed', plan: {
        parentId: 'AbCdEf123_-', totalItems: 1,
        items: [{ index: 1, kind: 'video', identity: { platform: 'youtube', videoId: 'AbCdEf123_-' }, status: 'failed' }],
      } }],
    };
    store.setGroupEnabled(groupId, true);
    store.acceptRelaySource(source);
    const sourceMessage = fakeMessage(body, { id: sourceId, from: groupId, author: 'admin@c.us', timestamp: Math.floor(acceptedAtMs / 1000) });
    const downloader = fakeDownloader();
    const { createWhatsappBot } = await import('../src/whatsapp');
    createWhatsappBot({ config: baseConfig(), store, downloader });
    clients[0].getMessageById.mockResolvedValue(sourceMessage);
    clients[0].sendMessage.mockResolvedValue({ id: { _serialized: 'retry-repost-1' }, ack: 1, fromMe: true, to: groupId });
    await clients[0].handlers.get('ready')?.();

    const requestTimestamp = Math.floor(Date.now() / 1000);
    const request = Object.assign(fakeMessage('!bot retry', { id: 'retry-request-1', timestamp: requestTimestamp }), {
      hasQuotedMsg: true,
      getQuotedMessage: vi.fn(async () => sourceMessage),
    });
    await clients[0].handlers.get('message')?.(request);
    expect(request.reply).toHaveBeenCalledWith(expect.stringContaining('1 definitely pre-send item eligible: Link 1, item 1'));
    expect(clients[0].sendMessage).not.toHaveBeenCalled();

    const confirmation = Object.assign(fakeMessage('!bot retry confirm', { id: 'retry-confirm-1', timestamp: requestTimestamp + 1 }), {
      hasQuotedMsg: true,
      getQuotedMessage: vi.fn(async () => sourceMessage),
    });
    await clients[0].handlers.get('message')?.(confirmation);

    expect(confirmation.reply).toHaveBeenCalledWith(expect.stringContaining('One targeted retry pass admitted'));
    expect(clients[0].sendMessage).toHaveBeenCalledOnce();
    expect(store.getMediaAttempt({ groupId, messageId: sourceId, identity: { platform: 'youtube', videoId: 'AbCdEf123_-' } }))
      .toMatchObject({ status: 'confirmed', sentMessageId: 'retry-repost-1', ack: 1 });
    expect(store.getRelaySource(groupId, sourceId)).toMatchObject({ status: 'settled', links: [{ plan: { items: [{ status: 'confirmed' }] } }] });

    await clients[0].handlers.get('message')?.(confirmation);
    expect(clients[0].sendMessage).toHaveBeenCalledOnce();
  });

  test('consumes a matching retry preview when the requester loses admin authority before confirmation', async () => {
    const store = createStore(':memory:');
    stores.push(store);
    const groupId = 'group-1@g.us';
    const sourceId = 'source-retry-lost-admin';
    const body = 'https://youtube.com/shorts/AbCdEf123_-';
    const acceptedAtMs = Date.now();
    store.setGroupEnabled(groupId, true);
    store.acceptRelaySource({ version: 1, groupId, messageId: sourceId, senderId: 'admin@c.us', senderName: 'Admin',
      timestampMs: acceptedAtMs, acceptedAtMs, contentHash: relayContentHash(body), status: 'settled', cleanup: 'retained',
      links: [{ url: body, platform: 'youtube', urlHash: 'retry-hash', status: 'failed', plan: { parentId: 'AbCdEf123_-', totalItems: 1,
        items: [{ index: 1, kind: 'video', identity: { platform: 'youtube', videoId: 'AbCdEf123_-' }, status: 'failed' }] } }] });
    const sourceMessage = fakeMessage(body, { id: sourceId, from: groupId, author: 'admin@c.us', timestamp: Math.floor(acceptedAtMs / 1000) });
    const { createWhatsappBot } = await import('../src/whatsapp');
    createWhatsappBot({ config: baseConfig(), store, downloader: fakeDownloader() });
    clients[0].getMessageById.mockResolvedValue(sourceMessage);
    await clients[0].handlers.get('ready')?.();

    const request = Object.assign(fakeMessage('!bot retry', { id: 'retry-lost-admin-request', timestamp: Math.floor(Date.now() / 1000) }), {
      hasQuotedMsg: true, getQuotedMessage: vi.fn(async () => sourceMessage),
    });
    await clients[0].handlers.get('message')?.(request);
    expect(request.reply).toHaveBeenCalledWith(expect.stringContaining('1 definitely pre-send item eligible: Link 1, item 1'));

    clients[0].getChatById.mockResolvedValue({ isGroup: true, id: { _serialized: groupId }, participants: [
      { id: { _serialized: 'member@c.us' }, isAdmin: false, isSuperAdmin: false },
      { id: { _serialized: 'bot@c.us' }, isAdmin: true, isSuperAdmin: false },
    ] });
    const confirmation = Object.assign(fakeMessage('!bot retry confirm', { id: 'retry-lost-admin-confirm', timestamp: Math.floor(Date.now() / 1000) + 1,
      participants: [{ id: { _serialized: 'member@c.us' }, isAdmin: false, isSuperAdmin: false },
        { id: { _serialized: 'bot@c.us' }, isAdmin: true, isSuperAdmin: false }] }), {
      author: 'admin@c.us', hasQuotedMsg: true, getQuotedMessage: vi.fn(async () => sourceMessage),
    });
    await clients[0].handlers.get('message')?.(confirmation);

    expect(store.claimRetryConfirmation('retry-lost-admin-confirm')).toBe(false);
    expect(confirmation.reply).toHaveBeenCalledWith(expect.stringContaining('current owner/admin authority could not be verified'));
    expect(clients[0].sendMessage).not.toHaveBeenCalled();

    clients[0].getChatById.mockResolvedValue({ isGroup: true, id: { _serialized: groupId }, participants: [
      { id: { _serialized: 'admin@c.us' }, isAdmin: true, isSuperAdmin: false },
      { id: { _serialized: 'bot@c.us' }, isAdmin: true, isSuperAdmin: false },
    ] });
    const replay = Object.assign(fakeMessage('!bot retry confirm', { id: 'retry-lost-admin-confirm-fresh', timestamp: Math.floor(Date.now() / 1000) + 2 }), {
      hasQuotedMsg: true, getQuotedMessage: vi.fn(async () => sourceMessage),
    });
    await clients[0].handlers.get('message')?.(replay);
    expect(replay.reply).toHaveBeenCalledWith(expect.stringContaining('No matching retry preview is pending'));
    expect(clients[0].sendMessage).not.toHaveBeenCalled();
  });

  test('consumes and rejects a retry preview when the live source changes before admission', async () => {
    const store = createStore(':memory:');
    stores.push(store);
    const groupId = 'group-1@g.us';
    const sourceId = 'source-retry-edited';
    const body = 'https://youtube.com/shorts/AbCdEf123_-';
    const changedBody = `${body} edited`;
    const acceptedAtMs = Date.now();
    store.setGroupEnabled(groupId, true);
    store.acceptRelaySource({ version: 1, groupId, messageId: sourceId, senderId: 'admin@c.us', senderName: 'Admin',
      timestampMs: acceptedAtMs, acceptedAtMs, contentHash: relayContentHash(body), status: 'settled', cleanup: 'retained',
      links: [{ url: body, platform: 'youtube', urlHash: 'retry-hash', status: 'failed', plan: { parentId: 'AbCdEf123_-', totalItems: 1,
        items: [{ index: 1, kind: 'video', identity: { platform: 'youtube', videoId: 'AbCdEf123_-' }, status: 'failed' }] } }] });
    const sourceMessage = fakeMessage(body, { id: sourceId, from: groupId, author: 'admin@c.us', timestamp: Math.floor(acceptedAtMs / 1000) });
    const { createWhatsappBot } = await import('../src/whatsapp');
    createWhatsappBot({ config: baseConfig(), store, downloader: fakeDownloader() });
    clients[0].getMessageById.mockResolvedValue(sourceMessage);
    await clients[0].handlers.get('ready')?.();

    const requestTimestamp = Math.floor(Date.now() / 1000);
    const request = Object.assign(fakeMessage('!bot retry', { id: 'retry-edit-request', timestamp: requestTimestamp }), {
      hasQuotedMsg: true, getQuotedMessage: vi.fn(async () => sourceMessage),
    });
    await clients[0].handlers.get('message')?.(request);
    expect(request.reply).toHaveBeenCalledWith(expect.stringContaining('1 definitely pre-send item eligible: Link 1, item 1'));

    clients[0].getMessageById.mockResolvedValue(fakeMessage(changedBody, { id: sourceId, from: groupId, author: 'admin@c.us', timestamp: requestTimestamp }));
    const confirmation = Object.assign(fakeMessage('!bot retry confirm', { id: 'retry-edit-confirm', timestamp: requestTimestamp + 1 }), {
      hasQuotedMsg: true, getQuotedMessage: vi.fn(async () => sourceMessage),
    });
    await clients[0].handlers.get('message')?.(confirmation);

    expect(store.claimRetryConfirmation('retry-edit-confirm')).toBe(false);
    expect(confirmation.reply).toHaveBeenCalledWith(expect.stringContaining('Source is missing, changed, or unavailable'));
    expect(store.getRelaySource(groupId, sourceId)).toMatchObject({ status: 'held', holdReason: 'source-unavailable-or-changed' });
    expect(clients[0].sendMessage).not.toHaveBeenCalled();
  });

  test('records an in-flight retry confirmation without reviving other work after group disable', async () => {
    const store = createStore(':memory:');
    stores.push(store);
    const groupId = 'group-1@g.us';
    const sourceId = 'source-retry-disabled-in-flight';
    const firstUrl = 'https://youtube.com/shorts/First123456';
    const secondUrl = 'https://youtube.com/shorts/Second12345';
    const acceptedAtMs = Date.now();
    store.setGroupEnabled(groupId, true);
    store.acceptRelaySource({ version: 1, groupId, messageId: sourceId, senderId: 'admin@c.us', senderName: 'Admin',
      timestampMs: acceptedAtMs, acceptedAtMs, contentHash: relayContentHash(`${firstUrl} ${secondUrl}`), status: 'settled', cleanup: 'retained',
      links: [
        { url: firstUrl, platform: 'youtube', urlHash: 'retry-first', status: 'failed', plan: { parentId: 'First123456', totalItems: 1,
          items: [{ index: 1, kind: 'video', identity: { platform: 'youtube', videoId: 'First123456' }, status: 'failed' }] } },
        { url: secondUrl, platform: 'youtube', urlHash: 'retry-second', status: 'failed', plan: { parentId: 'Second12345', totalItems: 1,
          items: [{ index: 1, kind: 'video', identity: { platform: 'youtube', videoId: 'Second12345' }, status: 'failed' }] } },
      ] });
    const sourceMessage = fakeMessage(`${firstUrl} ${secondUrl}`, { id: sourceId, from: groupId, author: 'admin@c.us', timestamp: Math.floor(acceptedAtMs / 1000) });
    const baseDownloader = fakeDownloader();
    const downloader = { ...baseDownloader, resolveYouTube: vi.fn(async (url: string) => {
      const id = url.includes('First') ? 'First123456' : 'Second12345';
      return { id, download: (maxFileSizeMb: number) => baseDownloader.download(url, maxFileSizeMb) };
    }) };
    const { createWhatsappBot } = await import('../src/whatsapp');
    createWhatsappBot({ config: baseConfig(), store, downloader });
    clients[0].getMessageById.mockResolvedValue(sourceMessage);
    await clients[0].handlers.get('ready')?.();

    const requestTimestamp = Math.floor(Date.now() / 1000);
    const request = Object.assign(fakeMessage('!bot retry', { id: 'retry-disable-request', timestamp: requestTimestamp }), {
      hasQuotedMsg: true, getQuotedMessage: vi.fn(async () => sourceMessage),
    });
    await clients[0].handlers.get('message')?.(request);
    expect(request.reply).toHaveBeenCalledWith(expect.stringContaining('2 definitely pre-send items eligible: Link 1, item 1; Link 2, item 1'));

    let finishSend!: (value: { id: { _serialized: string }; ack: number; fromMe: boolean; to: string }) => void;
    clients[0].sendMessage.mockImplementationOnce(() => new Promise((resolve) => { finishSend = resolve; }));
    const confirmation = Object.assign(fakeMessage('!bot retry confirm', { id: 'retry-disable-confirm', timestamp: requestTimestamp + 1 }), {
      hasQuotedMsg: true, getQuotedMessage: vi.fn(async () => sourceMessage),
    });
    const running = clients[0].handlers.get('message')?.(confirmation) as Promise<void>;
    await vi.waitFor(() => expect(clients[0].sendMessage).toHaveBeenCalledOnce());

    store.setGroupEnabled(groupId, false);
    expect(store.getRelaySource(groupId, sourceId)).toMatchObject({ status: 'held', holdReason: 'retry-interrupted-with-unknown-send',
      links: [{ plan: { items: [{ status: 'held' }] } }, { plan: { items: [{ status: 'failed' }] } }] });
    finishSend({ id: { _serialized: 'retry-disable-sent' }, ack: 1, fromMe: true, to: groupId });
    await running;

    const afterLateConfirmation = store.getRelaySource(groupId, sourceId)!;
    expect(afterLateConfirmation).toMatchObject({ status: 'settled',
      links: [{ plan: { items: [{ status: 'confirmed' }] } }, { plan: { items: [{ status: 'failed' }] } }] });
    expect(afterLateConfirmation.holdReason).toBeUndefined();
    expect(store.getMediaAttempt({ groupId, messageId: sourceId, identity: { platform: 'youtube', videoId: 'First123456' } }))
      .toMatchObject({ status: 'confirmed', sentMessageId: 'retry-disable-sent', ack: 1 });
    expect(store.getMediaAttempt({ groupId, messageId: sourceId, identity: { platform: 'youtube', videoId: 'Second12345' } })).toBeNull();
  });

  test.each(['!bot set max-size 0', '!bot set max-size 65', '!bot set max-size 1.5', '!bot set duplicate-window 721', '!bot set unknown 1'])('does not mutate settings for invalid command %s', async (body) => {
    const store = fakeStore();
    const set = vi.spyOn(store, 'setGroupSettings');
    const { createWhatsappBot } = await import('../src/whatsapp');
    createWhatsappBot({ config: baseConfig(), store, downloader: fakeDownloader() });
    const message = fakeMessage(body);

    await deliver(message);

    expect(set).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith(expect.stringContaining('No settings changed.'));
  });

  test('retries a real saved pre-intent failure rather than rejecting its unchanged snapshot', async () => {
    const fixture = await retryCommandFixture();
    fixture.store.saveRelaySource(fixture.store.getRelaySource(fixture.groupId, fixture.sourceId)!);
    await fixture.request();
    const confirmation = fixture.command('!bot retry confirm', 'confirm', 1);
    clients[0].sendMessage.mockResolvedValue({ id: { _serialized: 'retry-confirmed' }, ack: 1, fromMe: true, to: fixture.groupId });
    await clients[0].handlers.get('message')?.(confirmation);
    expect(confirmation.reply).toHaveBeenCalledWith(expect.stringContaining('One targeted retry pass admitted'));
    expect(fixture.store.getRelaySource(fixture.groupId, fixture.sourceId)?.links[0].plan?.items[0].status).toBe('confirmed');
  });

  test.each(['disable-enable', 'expiry', 'late-ack'] as const)('rejects %s occurring while confirmation validation is running', async (change) => {
    const fixture = await retryCommandFixture();
    await fixture.request();
    const resolve = fixture.downloader.resolveYouTube.getMockImplementation()!;
    let continueValidation!: () => void;
    const blocked = new Promise<void>((resume) => { continueValidation = resume; });
    fixture.downloader.resolveYouTube.mockImplementationOnce(async (url) => { await blocked; return resolve(url); });
    const confirmation = fixture.command('!bot retry confirm', 'confirm', 1);
    const confirming = clients[0].handlers.get('message')?.(confirmation);
    await vi.waitFor(() => expect(fixture.downloader.resolveYouTube).toHaveBeenCalledTimes(2));
    if (change === 'disable-enable') {
      await clients[0].handlers.get('message')?.(fakeMessage('!bot disable'));
      await clients[0].handlers.get('message')?.(fakeMessage('!bot enable'));
    } else if (change === 'expiry') {
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300_000);
    } else {
      const source = fixture.store.getRelaySource(fixture.groupId, fixture.sourceId)!;
      const key = { groupId: fixture.groupId, messageId: fixture.sourceId, identity: source.links[0].plan!.items[0].identity! };
      fixture.store.beginMediaRepost(key, { groupId: fixture.groupId, senderId: source.senderId,
        url: source.links[0].url, urlHash: source.links[0].urlHash, createdAtMs: Date.now() }, 24);
      fixture.store.recordMediaEvidence(key, { messageId: 'late-ack-repost', ack: 0 });
      clients[0].emit('message_ack', { id: { _serialized: 'late-ack-repost' }, fromMe: true, to: fixture.groupId }, 1);
    }
    continueValidation();
    await confirming;
    expect(confirmation.reply).not.toHaveBeenCalledWith(expect.stringContaining('One targeted retry pass admitted'));
    expect(clients[0].sendMessage).not.toHaveBeenCalled();
    expect(fixture.store.getRelaySource(fixture.groupId, fixture.sourceId)?.links[0].plan?.items[0].status)
      .toBe(change === 'late-ack' ? 'confirmed' : 'failed');
    vi.restoreAllMocks();
  });

  test('admission reply failure cannot abandon the pass or permit ordinary recovery', async () => {
    const fixture = await retryCommandFixture();
    await fixture.request();
    const confirmation = fixture.command('!bot retry confirm', 'confirm', 1);
    confirmation.reply.mockRejectedValueOnce(new Error('synthetic notification failure'));
    clients[0].sendMessage.mockResolvedValue({ id: { _serialized: 'retry-confirmed' }, ack: 1, fromMe: true, to: fixture.groupId });
    await clients[0].handlers.get('message')?.(confirmation);
    expect(fixture.store.getRelaySource(fixture.groupId, fixture.sourceId)?.links[0].plan?.items[0].status).toBe('confirmed');
    expect(clients[0].sendMessage).toHaveBeenCalledOnce();
  });

  test('ordinary recovery cannot execute explicit work while its admission notification is pending', async () => {
    const fixture = await retryCommandFixture();
    await fixture.request();
    const confirmation = fixture.command('!bot retry confirm', 'confirm', 1);
    let finishReply!: () => void;
    confirmation.reply.mockImplementationOnce(() => new Promise<void>((resolve) => { finishReply = resolve; }));
    const confirming = clients[0].handlers.get('message')?.(confirmation);
    await vi.waitFor(() => expect(confirmation.reply).toHaveBeenCalledOnce());
    const { recoverRelaySources } = await import('../src/relay');
    const send = vi.fn();
    await recoverRelaySources({ store: fixture.store, downloader: fixture.downloader,
      whatsapp: { ...fixture.bot.relayWhatsapp, sendVideoOnce: send }, timezone: 'UTC' });
    expect(send).not.toHaveBeenCalled();
    fixture.store.setGroupEnabled(fixture.groupId, false);
    finishReply();
    await confirming;
    expect(clients[0].sendMessage).not.toHaveBeenCalled();
    expect(fixture.store.getRelaySource(fixture.groupId, fixture.sourceId)?.links[0].plan?.items[0].status).toBe('failed');
  });

  test('competing authorized previews admit one pass and reject rather than queue another', async () => {
    const fixture = await retryCommandFixture();
    await fixture.request();
    const ownerRequest = fixture.command('!bot retry', 'owner-request', 0, 'owner@c.us');
    await clients[0].handlers.get('message')?.(ownerRequest);
    expect(ownerRequest.reply).toHaveBeenCalledWith(expect.stringContaining('1 definitely pre-send item eligible'));
    const confirmations = [fixture.command('!bot retry confirm', 'confirm-admin', 1),
      fixture.command('!bot retry confirm', 'confirm-owner', 1, 'owner@c.us')];
    let finishReply!: () => void;
    const reply = new Promise<void>((resolve) => { finishReply = resolve; });
    for (const confirmation of confirmations) confirmation.reply.mockReturnValue(reply);
    clients[0].sendMessage.mockResolvedValue({ id: { _serialized: 'retry-confirmed' }, ack: 1, fromMe: true, to: fixture.groupId });
    const confirming = confirmations.map((confirmation) => clients[0].handlers.get('message')?.(confirmation));
    await vi.waitFor(() => expect(confirmations.every((confirmation) => confirmation.reply.mock.calls.length > 0)).toBe(true));
    const replies = confirmations.map((confirmation) => String(confirmation.reply.mock.calls[0][0]));
    expect(replies.filter((text) => text.includes('One targeted retry pass admitted'))).toHaveLength(1);
    expect(replies.filter((text) => text.includes('already has active work'))).toHaveLength(1);
    finishReply();
    await Promise.all(confirming);
    expect(clients[0].sendMessage).toHaveBeenCalledOnce();
    const repeated = fixture.command('!bot retry confirm', 'confirm-loser-again', 2, 'owner@c.us');
    await clients[0].handlers.get('message')?.(repeated);
    expect(repeated.reply).toHaveBeenCalledWith(expect.stringContaining('No matching retry preview'));
  });

  test('old confirmations cannot authorize a fresh preview after a definite pre-intent retry failure', async () => {
    const fixture = await retryCommandFixture();
    await fixture.request();
    fixture.downloader.download.mockRejectedValueOnce(new Error('synthetic download failure'));
    const old = fixture.command('!bot retry confirm', 'old-confirm', 1);
    await clients[0].handlers.get('message')?.(old);
    expect(fixture.store.getRelaySource(fixture.groupId, fixture.sourceId)?.links[0].plan?.items[0].status).toBe('failed');
    const freshRequest = fixture.command('!bot retry', 'new-request', 2);
    await clients[0].handlers.get('message')?.(freshRequest);
    expect(freshRequest.reply).toHaveBeenCalledWith(expect.stringContaining('1 definitely pre-send item eligible'));
    await clients[0].handlers.get('message')?.(old);
    expect(old.reply).toHaveBeenLastCalledWith(expect.stringContaining('already used'));
    expect(mediaPaths).toHaveLength(0);
    clients[0].sendMessage.mockResolvedValue({ id: { _serialized: 'retry-confirmed' }, ack: 1, fromMe: true, to: fixture.groupId });
    await clients[0].handlers.get('message')?.(fixture.command('!bot retry confirm', 'new-confirm', 3));
    expect(mediaPaths).toHaveLength(1);
    expect(fixture.store.getRelaySource(fixture.groupId, fixture.sourceId)?.links[0].plan?.items[0].status).toBe('confirmed');
  });

  test('lost authority after admission revokes unused permission without ordinary recovery revival', async () => {
    const fixture = await retryCommandFixture();
    await fixture.request();
    const confirmation = fixture.command('!bot retry confirm', 'confirm', 1);
    confirmation.reply.mockImplementationOnce(async () => {
      clients[0].getChatById.mockResolvedValue({ isGroup: true, id: { _serialized: fixture.groupId }, participants: [] });
    });
    await clients[0].handlers.get('message')?.(confirmation);
    expect(fixture.store.hasActiveRetryPass(fixture.groupId, fixture.sourceId)).toBe(false);
    expect(fixture.store.getRelaySource(fixture.groupId, fixture.sourceId)?.links[0].plan?.items[0].status).toBe('failed');
    await clients[0].handlers.get('ready')?.();
    expect(mediaPaths).toHaveLength(0);
  });

  test.each(['authority', 'source'] as const)('rechecks %s after the final expensive retry plan resolution', async (change) => {
    const fixture = await retryCommandFixture();
    await fixture.request();
    const resolve = fixture.downloader.resolveYouTube.getMockImplementation()!;
    let finishPlan!: () => void;
    const blocked = new Promise<void>((resume) => { finishPlan = resume; });
    fixture.downloader.resolveYouTube.mockImplementation(async (url) => {
      if (fixture.downloader.resolveYouTube.mock.calls.length === 4) await blocked;
      return resolve(url);
    });
    const confirmation = fixture.command('!bot retry confirm', 'confirm', 1);
    const confirming = clients[0].handlers.get('message')?.(confirmation);
    await vi.waitFor(() => expect(fixture.downloader.resolveYouTube).toHaveBeenCalledTimes(4));
    if (change === 'authority') clients[0].getChatById.mockResolvedValue({ isGroup: true, id: { _serialized: fixture.groupId }, participants: [] });
    else clients[0].getMessageById.mockResolvedValue(fakeMessage(`${fixture.sourceMessage.body} edited`, { id: fixture.sourceId }));
    finishPlan();
    await confirming;
    expect(mediaPaths).toHaveLength(0);
    expect(fixture.store.hasActiveRetryPass(fixture.groupId, fixture.sourceId)).toBe(false);
    expect(fixture.store.getMediaAttempt({ groupId: fixture.groupId, messageId: fixture.sourceId,
      identity: { platform: 'youtube', videoId: 'AbCdEf123_-' } })).toBeNull();
  });

  test.each(['video', 'document'] as const)('enforces actual final %s bytes at the exact group budget', async (mode) => {
    for (const excess of [0, 1]) {
      clients.length = 0;
      mediaPaths.length = 0;
      const fixture = await retryCommandFixture();
      fixture.store.setGroupSettings(fixture.groupId, { maxFileSizeMb: 1 });
      await fixture.request();
      const download = fixture.downloader.download.getMockImplementation()!;
      fixture.downloader.download.mockImplementationOnce(async (url, limit) => {
        const file = await download(url, limit);
        writeFileSync(file.filePath, Buffer.alloc(1024 * 1024 + excess));
        return { ...file, sizeBytes: 1, deliveryMode: mode };
      });
      clients[0].sendMessage.mockResolvedValue({ id: { _serialized: 'retry-confirmed' }, ack: 1, fromMe: true, to: fixture.groupId });
      await clients[0].handlers.get('message')?.(fixture.command('!bot retry confirm', 'confirm', 1));
      expect(mediaPaths).toHaveLength(excess === 0 ? 1 : 0);
      expect(fixture.store.getRelaySource(fixture.groupId, fixture.sourceId)?.links[0].plan?.items[0].status)
        .toBe(excess === 0 ? 'confirmed' : 'failed');
      if (excess === 0 && mode === 'document') expect(clients[0].sendMessage).toHaveBeenCalledWith(fixture.groupId, expect.any(MockMessageMedia),
        expect.objectContaining({ sendMediaAsDocument: true }));
      await fixture.bot.stop();
    }
  });

  test.each(['hold-write', 'request-read', 'request-preparation', 'confirm-read', 'confirm-preparation', 'post-admission-read', 'post-admission-authority'] as const)(
    'stops new commands/submissions after a retry %s storage failure', async (fault) => {
      const fixture = await retryCommandFixture();
      const storageError = new Error('synthetic storage failure');
      const confirmationFault = fault.startsWith('confirm') || fault.startsWith('post-admission');
      if (confirmationFault) await fixture.request();
      if (fault === 'hold-write') {
        clients[0].getMessageById.mockResolvedValue(null);
        vi.spyOn(fixture.store, 'saveRelaySource').mockImplementationOnce(() => { throw storageError; });
      } else if (fault === 'request-read' || fault === 'confirm-read') {
        vi.spyOn(fixture.store, 'getRelaySource').mockImplementationOnce(() => { throw storageError; });
      } else if (fault === 'post-admission-read' || fault === 'post-admission-authority') {
        // Introduce the failure after successful atomic admission, at the final pre-intent guards.
      } else {
        vi.spyOn(fixture.store, 'getMediaDisposition').mockImplementationOnce(() => { throw storageError; });
      }
      const failing = fixture.command(confirmationFault ? '!bot retry confirm' : '!bot retry', 'failing', 1);
      if (fault.startsWith('post-admission')) {
        failing.reply.mockImplementationOnce(async () => {
          if (fault === 'post-admission-read') vi.spyOn(fixture.store, 'getRelaySource').mockImplementationOnce(() => { throw storageError; });
          else vi.spyOn(fixture.store, 'getBotOwnerId').mockImplementationOnce(() => { throw storageError; });
        });
      }
      await clients[0].handlers.get('message')?.(failing);
      const later = fakeMessage('!bot set max-size 32');
      await clients[0].handlers.get('message')?.(later);
      expect(later.reply).not.toHaveBeenCalled();
      expect(fixture.store.getGroupSettings(fixture.groupId).maxFileSizeMb).toBe(64);
      expect(mediaPaths).toHaveLength(0);
    });

  test('winning admission invalidates a competing consumed preview even if the source returns to the same failed state', async () => {
    const fixture = await retryCommandFixture();
    const source = fixture.store.getRelaySource(fixture.groupId, fixture.sourceId)!;
    source.links[0].status = 'ready';
    fixture.store.saveRelaySource(source);
    await fixture.request();
    await clients[0].handlers.get('message')?.(fixture.command('!bot retry', 'owner-request', 0, 'owner@c.us'));
    const getChat = clients[0].getChatById.getMockImplementation()!;
    let finishAuthority!: () => void;
    const blocked = new Promise<void>((resolve) => { finishAuthority = resolve; });
    clients[0].getChatById.mockImplementationOnce(async (id) => { await blocked; return getChat(id); });
    const losing = fixture.command('!bot retry confirm', 'losing-confirm', 1);
    const validating = clients[0].handlers.get('message')?.(losing);
    await vi.waitFor(() => expect(clients[0].getChatById).toHaveBeenCalledOnce());
    fixture.downloader.download.mockRejectedValueOnce(new Error('synthetic download failure'));
    await clients[0].handlers.get('message')?.(fixture.command('!bot retry confirm', 'winning-confirm', 1, 'owner@c.us'));
    expect(fixture.store.getRelaySource(fixture.groupId, fixture.sourceId)).toEqual(source);
    finishAuthority();
    await validating;
    expect(losing.reply).not.toHaveBeenCalledWith(expect.stringContaining('One targeted retry pass admitted'));
    expect(mediaPaths).toHaveLength(0);
  });

  test('mixed-platform A/B/C retry selects only failed B and preserves A/C through two reopens', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wpdbot-mixed-retry-'));
    tempDirs.push(root);
    const path = join(root, 'state.sqlite');
    const groupId = 'group-1@g.us';
    const sourceId = 'mixed-source';
    const body = 'https://youtube.com/shorts/First123456 https://instagram.com/p/Post123/ https://youtube.com/shorts/Third123456';
    const timestamp = Math.floor(Date.now() / 1000);
    const sourceMessage = fakeMessage(body, { id: sourceId, timestamp });
    const firstStore = createStore(path);
    firstStore.setGroupEnabled(groupId, true);
    let failB = true;
    const downloader = {
      resolveYouTube: vi.fn(async (url: string) => ({ id: url.split('/').at(-1)!,
        download: (limit: number) => fakeDownloader().download(url, limit) })),
      resolveInstagram: vi.fn(async (url: string) => ({ id: 'post-1', totalItems: 1,
        items: [{ id: 'video-1', index: 1, kind: 'video' as const, download: async (limit: number) => {
          if (failB) throw new Error('synthetic B failure');
          return fakeDownloader().download(url, limit);
        } }] })),
    };
    const { createWhatsappBot } = await import('../src/whatsapp');
    const firstBot = createWhatsappBot({ config: baseConfig(), store: firstStore, downloader });
    let sent = 0;
    clients[0].sendMessage.mockImplementation(async () => ({ id: { _serialized: `confirmed-${++sent}` }, ack: 1, fromMe: true, to: groupId }));
    await deliver(sourceMessage);
    const before = firstStore.getRelaySource(groupId, sourceId)!;
    expect(before.links.map((link) => link.plan?.items[0].status)).toEqual(['confirmed', 'failed', 'confirmed']);
    expect(firstStore.countReposts()).toBe(2);
    await firstBot.stop();
    firstStore.close();
    clients.length = 0;
    mediaPaths.length = 0;
    const secondStore = createStore(path);
    const secondBot = createWhatsappBot({ config: baseConfig(), store: secondStore, downloader });
    clients[0].getMessageById.mockResolvedValue(sourceMessage);
    clients[0].sendMessage.mockResolvedValue({ id: { _serialized: 'confirmed-B' }, ack: 1, fromMe: true, to: groupId });
    await clients[0].handlers.get('ready')?.();
    expect(secondStore.getRelaySource(groupId, sourceId)).toEqual(before);
    const command = (text: string, id: string, seconds: number) => Object.assign(fakeMessage(text, { id, timestamp: timestamp + seconds }),
      { hasQuotedMsg: true, getQuotedMessage: vi.fn(async () => sourceMessage) });
    const request = command('!bot retry', 'mixed-request', 1);
    await clients[0].handlers.get('message')?.(request);
    expect(request.reply).toHaveBeenCalledWith(expect.stringContaining('1 definitely pre-send item eligible: Link 2, item 1'));
    failB = false;
    await clients[0].handlers.get('message')?.(command('!bot retry confirm', 'mixed-confirm', 2));
    expect(mediaPaths).toHaveLength(1);
    expect(secondStore.countReposts()).toBe(3);
    expect(secondStore.getRelaySource(groupId, sourceId)?.links.map((link) => link.plan?.items[0].status))
      .toEqual(['confirmed', 'confirmed', 'confirmed']);
    await secondBot.stop();
    secondStore.close();
    const thirdStore = createStore(path);
    stores.push(thirdStore);
    expect(thirdStore.getRelaySource(groupId, sourceId)).toMatchObject({ workReference: before.workReference,
      acceptedAtMs: before.acceptedAtMs, cleanup: 'retained',
      links: [{ plan: { items: [{ status: 'confirmed' }] } }, { plan: { items: [{ status: 'confirmed' }] } }, { plan: { items: [{ status: 'confirmed' }] } }] });
    expect(thirdStore.countReposts()).toBe(3);
  });

  test('selected/full-collection overlap keeps skips and unknown holds protected through a retry window change', async () => {
    const fixture = await retryCommandFixture();
    const url = 'https://instagram.com/p/Post123/';
    fixture.sourceMessage.body = url;
    const source = fixture.store.getRelaySource(fixture.groupId, fixture.sourceId)!;
    source.contentHash = relayContentHash(url);
    source.links = [{ url, platform: 'instagram', urlHash: 'full-post', status: 'ready', plan: {
      parentId: 'post-1', totalItems: 3, items: [
        { index: 1, kind: 'video', identity: { platform: 'instagram', postId: 'post-1', itemId: 'video-1' }, status: 'skipped' },
        { index: 2, kind: 'video', identity: { platform: 'instagram', postId: 'post-1', itemId: 'video-2' }, status: 'failed' },
        { index: 3, kind: 'video', identity: { platform: 'instagram', postId: 'post-1', itemId: 'video-3' }, status: 'held' },
      ],
    } }];
    fixture.store.saveRelaySource(source);
    const selectedKey = { groupId: fixture.groupId, messageId: 'selected-source', identity: source.links[0].plan!.items[0].identity! };
    const selectedRecord = { groupId: fixture.groupId, senderId: source.senderId, url: `${url}?img_index=1`, urlHash: 'selected-post', createdAtMs: Date.now() };
    fixture.store.beginMediaRepost(selectedKey, selectedRecord, 24);
    fixture.store.confirmMediaRepost(selectedKey, { messageId: 'selected-confirmed', ack: 1 }, selectedRecord);
    const unknownKey = { groupId: fixture.groupId, messageId: fixture.sourceId, identity: source.links[0].plan!.items[2].identity! };
    fixture.store.beginMediaRepost(unknownKey, { ...selectedRecord, url, urlHash: 'full-post' }, 24);
    fixture.store.recordMediaEvidence(unknownKey, { messageId: 'unknown-repost', ack: 0 });
    fixture.downloader.resolveInstagram.mockImplementation(async () => ({ id: 'post-1', totalItems: 3,
      items: [1, 2, 3].map((index) => ({ id: `video-${index}`, index, kind: 'video' as const,
        download: (limit: number) => fixture.downloader.download(url, limit) })) }));
    await fixture.request();
    await clients[0].handlers.get('message')?.(fakeMessage('!bot set duplicate-window 0'));
    const obsolete = fixture.command('!bot retry confirm', 'obsolete-confirm', 1);
    await clients[0].handlers.get('message')?.(obsolete);
    expect(obsolete.reply).toHaveBeenCalledWith(expect.stringContaining('No matching retry preview'));
    const fresh = fixture.command('!bot retry', 'fresh-request', 2);
    await clients[0].handlers.get('message')?.(fresh);
    expect(fresh.reply).toHaveBeenCalledWith(expect.stringContaining('1 definitely pre-send item eligible: Link 1, item 2'));
    clients[0].sendMessage.mockResolvedValue({ id: { _serialized: 'confirmed-item-2' }, ack: 1, fromMe: true, to: fixture.groupId });
    await clients[0].handlers.get('message')?.(fixture.command('!bot retry confirm', 'fresh-confirm', 3));
    expect(mediaPaths).toHaveLength(1);
    expect(fixture.store.getRelaySource(fixture.groupId, fixture.sourceId)?.links[0].plan?.items.map((item) => item.status))
      .toEqual(['skipped', 'confirmed', 'held']);
    expect(fixture.store.getMediaAttempt(unknownKey)).toMatchObject({ status: 'sending', sentMessageId: 'unknown-repost', ack: 0 });
    expect(fixture.store.getMediaDisposition({ ...unknownKey, messageId: 'another-source' }, Date.now(), 0)).toBe('held');
    expect(fixture.store.countReposts()).toBe(2);
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

async function retryCommandFixture() {
  const store = createStore(':memory:');
  stores.push(store);
  const groupId = 'group-1@g.us';
  const sourceId = 'retry-source';
  const body = 'https://youtube.com/shorts/AbCdEf123_-';
  const now = Date.now();
  store.setGroupEnabled(groupId, true);
  store.acceptRelaySource({ version: 1, groupId, messageId: sourceId, senderId: 'admin@c.us', senderName: 'Admin',
    timestampMs: now, acceptedAtMs: now, contentHash: relayContentHash(body), status: 'settled', cleanup: 'retained',
    links: [{ url: body, platform: 'youtube', urlHash: 'retry-hash', status: 'failed', plan: { parentId: 'AbCdEf123_-', totalItems: 1,
      items: [{ index: 1, kind: 'video', identity: { platform: 'youtube', videoId: 'AbCdEf123_-' }, status: 'failed' }] } }] });
  const sourceMessage = fakeMessage(body, { id: sourceId, timestamp: Math.floor(now / 1000) });
  const downloader = fakeDownloader();
  const { createWhatsappBot } = await import('../src/whatsapp');
  const bot = createWhatsappBot({ config: baseConfig(), store, downloader });
  clients[0].getMessageById.mockResolvedValue(sourceMessage);
  await clients[0].handlers.get('ready')?.();
  const command = (text: string, id: string, seconds = 0, author = 'admin@c.us') => Object.assign(
    fakeMessage(text, { id, author, timestamp: Math.floor(now / 1000) + seconds }),
    { hasQuotedMsg: true, getQuotedMessage: vi.fn(async () => sourceMessage) });
  const request = async () => {
    const message = command('!bot retry', 'request');
    await clients[0].handlers.get('message')?.(message);
    expect(message.reply).toHaveBeenCalledWith(expect.stringContaining('1 definitely pre-send item eligible'));
    return message;
  };
  return { store, groupId, sourceId, sourceMessage, downloader, bot, command, request };
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
    id?: string;
    from?: string;
    timestamp?: number;
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
    id: { _serialized: options.id ?? 'message-1' },
    from: options.from ?? 'group-1@g.us',
    author: options.author ?? 'admin@c.us',
    body,
    links: options.links,
    timestamp: options.timestamp ?? 1,
    fromMe: options.fromMe ?? false,
    reply: vi.fn(),
    getContact: vi.fn(async () => options.contact ?? { pushname: 'Admin', name: 'Admin', number: 'admin' }),
    getChat: vi.fn(async () => ({
      isGroup: true,
       id: { _serialized: options.from ?? 'group-1@g.us' },
      name: 'Group 1',
      participants,
    })),
  };
}
