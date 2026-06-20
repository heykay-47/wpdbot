import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KeyedTaskQueue } from '../src/keyedTaskQueue';
import { handleIncomingMessage, type IncomingMessage, type RelayDownloader, type RelayWhatsapp } from '../src/relay';
import type { Store } from '../src/store';

const baseMessage: IncomingMessage = {
  id: 'message-1',
  groupId: 'group-1@g.us',
  senderId: 'sender@c.us',
  senderName: 'Mom',
  body: 'watch this https://www.youtube.com/shorts/Video123?utm_source=x',
  timestampMs: Date.UTC(2026, 5, 8, 14, 12),
  isGroup: true,
  fromMe: false,
};

type StoreCall = { name: string; args: unknown[] };

function createStore(overrides: Partial<Store> = {}): Store & { calls: StoreCall[] } {
  const calls: StoreCall[] = [];
  return {
    calls,
    getGroupSettings(groupId) {
      calls.push({ name: 'getGroupSettings', args: [groupId] });
      return { groupId, enabled: true, maxFileSizeMb: 32, duplicateWindowHours: 6 };
    },
    setGroupEnabled(groupId, enabled) {
      calls.push({ name: 'setGroupEnabled', args: [groupId, enabled] });
    },
    recordDuplicate(groupId, urlHash, createdAtMs) {
      calls.push({ name: 'recordDuplicate', args: [groupId, urlHash, createdAtMs] });
    },
    wasRecentlyPosted(groupId, urlHash, nowMs, windowHours) {
      calls.push({ name: 'wasRecentlyPosted', args: [groupId, urlHash, nowMs, windowHours] });
      return false;
    },
    setGroupMetadata(groupId, name, updatedAtMs) {
      calls.push({ name: 'setGroupMetadata', args: [groupId, name, updatedAtMs] });
    },
    getGroupMetadata(groupId) {
      calls.push({ name: 'getGroupMetadata', args: [groupId] });
      return null;
    },
    setBotOwnerId(ownerId) {
      calls.push({ name: 'setBotOwnerId', args: [ownerId] });
    },
    getBotOwnerId() {
      calls.push({ name: 'getBotOwnerId', args: [] });
      return null;
    },
    recordRepost(record) {
      calls.push({ name: 'recordRepost', args: [record] });
    },
    recordSuccessfulRepost(record) {
      calls.push({ name: 'recordSuccessfulRepost', args: [record] });
    },
    countReposts() {
      calls.push({ name: 'countReposts', args: [] });
      return 0;
    },
    close() {
      calls.push({ name: 'close', args: [] });
    },
    ...overrides,
  };
}

function createWhatsapp(overrides: Partial<RelayWhatsapp> = {}): RelayWhatsapp & { calls: StoreCall[] } {
  const calls: StoreCall[] = [];
  return {
    calls,
    async sendVideo(groupId, filePath, caption) {
      calls.push({ name: 'sendVideo', args: [groupId, filePath, caption] });
    },
    async sendText(groupId, text) {
      calls.push({ name: 'sendText', args: [groupId, text] });
    },
    async deleteMessage(messageId) {
      calls.push({ name: 'deleteMessage', args: [messageId] });
    },
    ...overrides,
  };
}

function createDownloader(filePath = '/tmp/video.mp4', overrides: Partial<RelayDownloader> = {}): RelayDownloader & { calls: StoreCall[] } {
  const calls: StoreCall[] = [];
  return {
    calls,
    async download(url, maxFileSizeMb) {
      calls.push({ name: 'download', args: [url, maxFileSizeMb] });
      return { filePath, sizeBytes: 1000 };
    },
    ...overrides,
  };
}

const tempRoots: string[] = [];

async function createDownloadedFile(rootPrefix = 'wpdbot-relay-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), rootPrefix));
  tempRoots.push(root);
  const downloadDir = join(root, 'download-abc');
  mkdirSync(downloadDir, { recursive: true });
  const filePath = join(downloadDir, 'video.mp4');
  writeFileSync(filePath, 'video');
  return filePath;
}

afterEach(async () => {
  for (const root of tempRoots) {
    await rm(root, { force: true, recursive: true });
  }
  tempRoots.length = 0;
});

describe('handleIncomingMessage', () => {
  it('downloads first supported URL, sends video, deletes original, records success with nowMs, and cleans through injected cleanup', async () => {
    const filePath = await createDownloadedFile();
    const store = createStore();
    const whatsapp = createWhatsapp();
    const downloader = createDownloader(filePath);
    const cleanupCalls: string[] = [];
    const nowMs = Date.UTC(2026, 5, 8, 15, 0);

    await handleIncomingMessage({
      message: baseMessage,
      store,
      whatsapp,
      downloader,
      timezone: 'Asia/Kolkata',
      nowMs,
      cleanupPath: async (path) => {
        cleanupCalls.push(path);
      },
    });

    expect(downloader.calls).toEqual([
      { name: 'download', args: ['https://www.youtube.com/shorts/Video123?utm_source=x', 32] },
    ]);
    expect(whatsapp.calls).toEqual([
      {
        name: 'sendVideo',
        args: [
          'group-1@g.us',
          filePath,
          'Sent by Mom at 08 Jun 2026, 7:42 PM IST\nOriginal: https://www.youtube.com/shorts/Video123?utm_source=x',
        ],
      },
      { name: 'deleteMessage', args: ['message-1'] },
    ]);
    expect(store.calls.map((call) => call.name)).toEqual([
      'getGroupSettings',
      'wasRecentlyPosted',
      'wasRecentlyPosted',
      'recordSuccessfulRepost',
    ]);
    expect(store.calls.find((call) => call.name === 'wasRecentlyPosted')?.args[2]).toBe(nowMs);
    expect(store.calls.find((call) => call.name === 'recordSuccessfulRepost')?.args[0]).toMatchObject({
      groupId: 'group-1@g.us',
      senderId: 'sender@c.us',
      url: 'https://www.youtube.com/shorts/Video123?utm_source=x',
      createdAtMs: nowMs,
    });
    expect(cleanupCalls).toEqual([filePath]);
    expect(existsSync(filePath)).toBe(true);
  });

  it('default cleanup removes download subdirectory inside configured downloadDir after success', async () => {
    const downloadRoot = await mkdtemp(join(tmpdir(), 'wpdbot-downloads-'));
    tempRoots.push(downloadRoot);
    const downloadSubdir = join(downloadRoot, 'download-abc');
    mkdirSync(downloadSubdir, { recursive: true });
    const filePath = join(downloadSubdir, 'video.mp4');
    writeFileSync(filePath, 'video');
    const store = createStore();
    const whatsapp = createWhatsapp();
    const downloader = createDownloader(filePath);

    await handleIncomingMessage({ message: baseMessage, store, whatsapp, downloader, timezone: 'Asia/Kolkata', downloadDir: downloadRoot });

    expect(existsSync(downloadSubdir)).toBe(false);
    expect(existsSync(downloadRoot)).toBe(true);
  });

  it('default cleanup does not recursively remove download-looking parent outside configured downloadDir', async () => {
    const filePath = await createDownloadedFile('wpdbot-outside-');
    const siblingPath = join(dirname(filePath), 'keep.txt');
    writeFileSync(siblingPath, 'keep');
    const unrelatedDownloadRoot = await mkdtemp(join(tmpdir(), 'wpdbot-downloads-'));
    tempRoots.push(unrelatedDownloadRoot);
    const store = createStore();
    const whatsapp = createWhatsapp();
    const downloader = createDownloader(filePath);

    await handleIncomingMessage({
      message: baseMessage,
      store,
      whatsapp,
      downloader,
      timezone: 'Asia/Kolkata',
      downloadDir: unrelatedDownloadRoot,
    });

    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(siblingPath)).toBe(true);
    expect(existsSync(dirname(filePath))).toBe(true);
  });

  it('uses processing time for duplicate cache checks instead of message timestamp', async () => {
    const nowMs = baseMessage.timestampMs + 10 * 60 * 1000;
    const store = createStore();
    const whatsapp = createWhatsapp();
    const downloader = createDownloader();

    await handleIncomingMessage({ message: baseMessage, store, whatsapp, downloader, timezone: 'Asia/Kolkata', nowMs });

    expect(store.calls.find((call) => call.name === 'wasRecentlyPosted')?.args[2]).toBe(nowMs);
    expect(store.calls.find((call) => call.name === 'recordSuccessfulRepost')?.args[0]).toMatchObject({
      createdAtMs: nowMs,
    });
  });

  it('ignores non-group messages, bot messages, unsupported URLs, and disabled groups', async () => {
    for (const message of [
      { ...baseMessage, isGroup: false },
      { ...baseMessage, fromMe: true },
      { ...baseMessage, body: 'https://example.com/video' },
      baseMessage,
    ]) {
      const disabledStore = createStore({
        getGroupSettings(groupId) {
          return { groupId, enabled: false, maxFileSizeMb: 32, duplicateWindowHours: 6 };
        },
      });
      const whatsapp = createWhatsapp();
      const downloader = createDownloader();

      await handleIncomingMessage({ message, store: disabledStore, whatsapp, downloader, timezone: 'Asia/Kolkata' });

      expect(downloader.calls).toEqual([]);
      expect(whatsapp.calls).toEqual([]);
    }
  });

  it('skips duplicate URLs within the group duplicate window', async () => {
    const store = createStore({
      wasRecentlyPosted(groupId, urlHash, nowMs, windowHours) {
        store.calls.push({ name: 'wasRecentlyPosted', args: [groupId, urlHash, nowMs, windowHours] });
        return true;
      },
    });
    const whatsapp = createWhatsapp();
    const downloader = createDownloader();

    await handleIncomingMessage({ message: baseMessage, store, whatsapp, downloader, timezone: 'Asia/Kolkata' });

    expect(store.calls.map((call) => call.name)).toEqual(['getGroupSettings', 'wasRecentlyPosted']);
    expect(downloader.calls).toEqual([]);
    expect(whatsapp.calls).toEqual([]);
  });

  it('serializes same group URL and re-checks duplicate after queue wait', async () => {
    const filePath = await createDownloadedFile();
    let duplicateChecks = 0;
    const store = createStore({
      wasRecentlyPosted(groupId, urlHash, nowMs, windowHours) {
        store.calls.push({ name: 'wasRecentlyPosted', args: [groupId, urlHash, nowMs, windowHours] });
        duplicateChecks += 1;
        // checks: 1=msg1 pre-queue, 2=msg1 in-queue, 3=msg2 pre-queue, 4=msg2 in-queue (already posted)
        return duplicateChecks === 4;
      },
    });
    const whatsapp = createWhatsapp();
    const downloader = createDownloader(filePath);
    const queue = new KeyedTaskQueue();

    await Promise.all([
      handleIncomingMessage({ message: baseMessage, store, whatsapp, downloader, timezone: 'Asia/Kolkata', queue }),
      handleIncomingMessage({ message: { ...baseMessage, id: 'message-2' }, store, whatsapp, downloader, timezone: 'Asia/Kolkata', queue }),
    ]);

    expect(store.calls.filter((call) => call.name === 'wasRecentlyPosted')).toHaveLength(4);
    expect(downloader.calls).toHaveLength(1);
    expect(whatsapp.calls.filter((call) => call.name === 'sendVideo')).toHaveLength(1);
  });

  it('re-checks duplicates inside queued relay work after waiting', async () => {
    let postedDuringQueueWait = false;
    const store = createStore({
      wasRecentlyPosted(groupId, urlHash, nowMs, windowHours) {
        store.calls.push({ name: 'wasRecentlyPosted', args: [groupId, urlHash, nowMs, windowHours] });
        return postedDuringQueueWait;
      },
    });
    const whatsapp = createWhatsapp();
    const downloader = createDownloader();
    const queue = {
      activeCount() {
        return 0;
      },
      async run<T>(_key: string, task: () => Promise<T>): Promise<T> {
        postedDuringQueueWait = true;
        await Promise.resolve();
        return task();
      },
    } as unknown as KeyedTaskQueue;

    await handleIncomingMessage({ message: baseMessage, store, whatsapp, downloader, timezone: 'Asia/Kolkata', queue });

    // pre-queue check (false) + in-queue check (true after wait) = 2 total
    expect(store.calls.filter((call) => call.name === 'wasRecentlyPosted')).toHaveLength(2);
    expect(downloader.calls).toHaveLength(0);
    expect(whatsapp.calls.filter((call) => call.name === 'sendVideo')).toHaveLength(0);
  });

  it('reports unexpected relay errors with an error id and logs context', async () => {
    const store = createStore({
      getGroupSettings() {
        throw new Error('database exploded');
      },
    });
    const whatsapp = createWhatsapp();
    const downloader = createDownloader();
    const logs: Record<string, unknown>[] = [];

    await handleIncomingMessage({
      message: baseMessage,
      store,
      whatsapp,
      downloader,
      timezone: 'Asia/Kolkata',
      logger: (entry) => logs.push(entry),
    });

    expect(whatsapp.calls.at(-1)?.name).toBe('sendText');
    expect(String(whatsapp.calls.at(-1)?.args[1])).toMatch(/^Something went wrong\. Error ID: ERR-[0-9A-F]{6}$/u);
    expect(logs[0]).toMatchObject({ step: 'settings', groupId: 'group-1@g.us', messageId: 'message-1', extractorId: 'youtube' });
  });

  it('logs unexpected upload-reporting failures with URL context and upload step', async () => {
    const filePath = await createDownloadedFile();
    const store = createStore();
    const whatsapp = createWhatsapp({
      async sendVideo(groupId, path, caption) {
        whatsapp.calls.push({ name: 'sendVideo', args: [groupId, path, caption] });
        throw new Error('upload failed cookie=session-cookie-123');
      },
      async sendText(groupId, text) {
        whatsapp.calls.push({ name: 'sendText', args: [groupId, text] });
        throw new Error('send text failed');
      },
    });
    const downloader = createDownloader(filePath);
    const logs: Record<string, unknown>[] = [];

    await handleIncomingMessage({
      message: baseMessage,
      store,
      whatsapp,
      downloader,
      timezone: 'Asia/Kolkata',
      logger: (entry) => logs.push(entry),
    });

    expect(logs[0]).toMatchObject({
      step: 'upload',
      groupId: 'group-1@g.us',
      messageId: 'message-1',
      extractorId: 'youtube',
      urlHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  it('logs unexpected record-reporting failures with URL context and record step', async () => {
    const filePath = await createDownloadedFile();
    const store = createStore({
      recordSuccessfulRepost(record) {
        store.calls.push({ name: 'recordSuccessfulRepost', args: [record] });
        throw new Error('database password=secret');
      },
    });
    const whatsapp = createWhatsapp({
      async sendText(groupId, text) {
        whatsapp.calls.push({ name: 'sendText', args: [groupId, text] });
        throw new Error('send text failed');
      },
    });
    const downloader = createDownloader(filePath);
    const logs: Record<string, unknown>[] = [];

    await handleIncomingMessage({
      message: baseMessage,
      store,
      whatsapp,
      downloader,
      timezone: 'Asia/Kolkata',
      logger: (entry) => logs.push(entry),
    });

    expect(logs[0]).toMatchObject({
      step: 'record',
      groupId: 'group-1@g.us',
      messageId: 'message-1',
      extractorId: 'youtube',
      urlHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  it('sends a concise group text and preserves original message when download fails', async () => {
    const store = createStore();
    const whatsapp = createWhatsapp();
    const downloader = createDownloader('/tmp/video.mp4', {
      async download(url, maxFileSizeMb) {
        downloader.calls.push({ name: 'download', args: [url, maxFileSizeMb] });
        throw new Error('yt-dlp failed --cookies /run/secrets/cookies.txt --proxy http://user:pass@example.test');
      },
    });

    await handleIncomingMessage({ message: baseMessage, store, whatsapp, downloader, timezone: 'Asia/Kolkata' });

    expect(whatsapp.calls).toEqual([
      { name: 'sendText', args: ['group-1@g.us', 'Could not download this video: Download unavailable or blocked.'] },
    ]);
    expect(store.calls.map((call) => call.name)).toEqual(['getGroupSettings', 'wasRecentlyPosted', 'wasRecentlyPosted']);
  });

  it('preserves original message, sends upload error text, and cleans file when upload fails', async () => {
    const filePath = await createDownloadedFile();
    const store = createStore();
    const whatsapp = createWhatsapp({
      async sendVideo(groupId, path, caption) {
        whatsapp.calls.push({ name: 'sendVideo', args: [groupId, path, caption] });
        throw new Error('upload failed session=whatsapp-session-123');
      },
    });
    const downloader = createDownloader(filePath);

    await handleIncomingMessage({ message: baseMessage, store, whatsapp, downloader, timezone: 'Asia/Kolkata' });

    expect(whatsapp.calls.map((call) => call.name)).toEqual(['sendVideo', 'sendText']);
    expect(whatsapp.calls.at(-1)).toEqual({
      name: 'sendText',
      args: ['group-1@g.us', 'Could not upload this video: Upload failed.'],
    });
    expect(store.calls.map((call) => call.name)).toEqual(['getGroupSettings', 'wasRecentlyPosted', 'wasRecentlyPosted']);
    expect(existsSync(filePath)).toBe(false);
  });

  it('sends safe delete-specific text and logs context when delete fails after successful send', async () => {
    const filePath = await createDownloadedFile();
    const store = createStore();
    const whatsapp = createWhatsapp({
      async deleteMessage(messageId) {
        whatsapp.calls.push({ name: 'deleteMessage', args: [messageId] });
        throw new Error('not admin at /home/wsl/.wwebjs_auth/session');
      },
    });
    const downloader = createDownloader(filePath);
    const logs: Record<string, unknown>[] = [];

    await handleIncomingMessage({
      message: baseMessage,
      store,
      whatsapp,
      downloader,
      timezone: 'Asia/Kolkata',
      logger: (entry) => logs.push(entry),
    });

    expect(whatsapp.calls.map((call) => call.name)).toEqual(['sendVideo', 'deleteMessage', 'sendText']);
    expect(whatsapp.calls.at(-1)).toEqual({
      name: 'sendText',
      args: ['group-1@g.us', 'Video posted, but I could not delete the original message.'],
    });
    expect(logs[0]).toMatchObject({ step: 'delete', groupId: 'group-1@g.us', messageId: 'message-1' });
    expect(store.calls.map((call) => call.name)).toEqual([
      'getGroupSettings',
      'wasRecentlyPosted',
      'wasRecentlyPosted',
      'recordSuccessfulRepost',
    ]);
    expect(existsSync(filePath)).toBe(false);
  });

  it('sends safe history-specific text and logs context when store recording fails after successful send', async () => {
    const filePath = await createDownloadedFile();
    const store = createStore({
      recordSuccessfulRepost(record) {
        store.calls.push({ name: 'recordSuccessfulRepost', args: [record] });
        throw new Error('database locked at /data/bot.db');
      },
    });
    const whatsapp = createWhatsapp();
    const downloader = createDownloader(filePath);
    const logs: Record<string, unknown>[] = [];

    await handleIncomingMessage({
      message: baseMessage,
      store,
      whatsapp,
      downloader,
      timezone: 'Asia/Kolkata',
      logger: (entry) => logs.push(entry),
    });

    expect(whatsapp.calls.map((call) => call.name)).toEqual(['sendVideo', 'deleteMessage', 'sendText']);
    expect(whatsapp.calls.at(-1)).toEqual({
      name: 'sendText',
      args: ['group-1@g.us', 'Video posted, but repost history could not be saved.'],
    });
    expect(logs[0]).toMatchObject({ step: 'record', groupId: 'group-1@g.us', messageId: 'message-1' });
    expect(existsSync(filePath)).toBe(false);
  });

  it('skips relay before queueing when link is already a recent duplicate', async () => {
    const store = createStore({
      wasRecentlyPosted() {
        store.calls.push({ name: 'wasRecentlyPosted', args: [] });
        return true;
      },
    });
    const whatsapp = createWhatsapp();
    const downloader = createDownloader();
    const queue = new KeyedTaskQueue();

    await handleIncomingMessage({ message: baseMessage, store, whatsapp, downloader, timezone: 'Asia/Kolkata', queue });

    expect(store.calls.map((c) => c.name)).toEqual(['getGroupSettings', 'wasRecentlyPosted']);
    expect(downloader.calls).toHaveLength(0);
    expect(whatsapp.calls).toHaveLength(0);
  });

  it('tracker cleans tempDir only when it is a bot-created download subdir under downloadDir', async () => {
    const downloadRoot = await mkdtemp(join(tmpdir(), 'wpdbot-downloads-'));
    tempRoots.push(downloadRoot);
    const validTempDir = join(downloadRoot, 'download-xyz');
    mkdirSync(validTempDir, { recursive: true });
    const filePath = join(validTempDir, 'video.mp4');
    writeFileSync(filePath, 'video');
    const store = createStore();
    const whatsapp = createWhatsapp();
    const downloader: RelayDownloader = {
      async download() {
        return { filePath, sizeBytes: 5, tempDir: validTempDir };
      },
    };

    await handleIncomingMessage({ message: baseMessage, store, whatsapp, downloader, timezone: 'Asia/Kolkata', downloadDir: downloadRoot });

    expect(existsSync(validTempDir)).toBe(false);
    expect(existsSync(downloadRoot)).toBe(true);
  });

  it('tracker does not recursively delete tempDir outside configured downloadDir', async () => {
    const untrustedRoot = await mkdtemp(join(tmpdir(), 'wpdbot-untrusted-'));
    tempRoots.push(untrustedRoot);
    const untrustedTempDir = join(untrustedRoot, 'download-xyz');
    mkdirSync(untrustedTempDir, { recursive: true });
    const filePath = join(untrustedTempDir, 'video.mp4');
    const siblingFile = join(untrustedTempDir, 'sibling.txt');
    writeFileSync(filePath, 'video');
    writeFileSync(siblingFile, 'keep');

    const downloadRoot = await mkdtemp(join(tmpdir(), 'wpdbot-downloads-'));
    tempRoots.push(downloadRoot);
    const store = createStore();
    const whatsapp = createWhatsapp();
    const downloader: RelayDownloader = {
      async download() {
        return { filePath, sizeBytes: 5, tempDir: untrustedTempDir };
      },
    };

    await handleIncomingMessage({ message: baseMessage, store, whatsapp, downloader, timezone: 'Asia/Kolkata', downloadDir: downloadRoot });

    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(siblingFile)).toBe(true);
    expect(existsSync(untrustedTempDir)).toBe(true);
  });
});
