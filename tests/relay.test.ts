import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleIncomingMessage, type IncomingMessage, type RelayDownloader, type RelayWhatsapp } from '../src/relay';
import type { Store } from '../src/store';

const baseMessage: IncomingMessage = {
  id: 'message-1',
  groupId: 'group-1@g.us',
  senderId: 'sender@c.us',
  senderName: 'Mom',
  body: 'watch this https://youtu.be/Video123?utm_source=x',
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

async function createDownloadedFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wpdbot-relay-'));
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
  it('downloads first supported URL, sends video, deletes original, records history, and cleans temp directory', async () => {
    const filePath = await createDownloadedFile();
    const store = createStore();
    const whatsapp = createWhatsapp();
    const downloader = createDownloader(filePath);

    await handleIncomingMessage({ message: baseMessage, store, whatsapp, downloader, timezone: 'Asia/Kolkata' });

    expect(downloader.calls).toEqual([
      { name: 'download', args: ['https://youtu.be/Video123?utm_source=x', 32] },
    ]);
    expect(whatsapp.calls).toEqual([
      {
        name: 'sendVideo',
        args: [
          'group-1@g.us',
          filePath,
          'Sent by Mom at 08 Jun 2026, 7:42 PM IST\nOriginal: https://youtu.be/Video123?utm_source=x',
        ],
      },
      { name: 'deleteMessage', args: ['message-1'] },
    ]);
    expect(store.calls.map((call) => call.name)).toEqual([
      'getGroupSettings',
      'wasRecentlyPosted',
      'recordDuplicate',
      'recordRepost',
    ]);
    expect(store.calls.find((call) => call.name === 'recordRepost')?.args[0]).toMatchObject({
      groupId: 'group-1@g.us',
      senderId: 'sender@c.us',
      url: 'https://youtu.be/Video123?utm_source=x',
      createdAtMs: baseMessage.timestampMs,
    });
    expect(existsSync(dirname(filePath))).toBe(false);
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

  it('sends a concise group text and preserves original message when download fails', async () => {
    const store = createStore();
    const whatsapp = createWhatsapp();
    const downloader = createDownloader('/tmp/video.mp4', {
      async download(url, maxFileSizeMb) {
        downloader.calls.push({ name: 'download', args: [url, maxFileSizeMb] });
        throw new Error('too large');
      },
    });

    await handleIncomingMessage({ message: baseMessage, store, whatsapp, downloader, timezone: 'Asia/Kolkata' });

    expect(whatsapp.calls).toEqual([
      { name: 'sendText', args: ['group-1@g.us', 'Could not download this video: too large'] },
    ]);
    expect(store.calls.map((call) => call.name)).toEqual(['getGroupSettings', 'wasRecentlyPosted']);
  });

  it('preserves original message, sends error text, and cleans temp directory when upload fails', async () => {
    const filePath = await createDownloadedFile();
    const store = createStore();
    const whatsapp = createWhatsapp({
      async sendVideo(groupId, path, caption) {
        whatsapp.calls.push({ name: 'sendVideo', args: [groupId, path, caption] });
        throw new Error('upload failed');
      },
    });
    const downloader = createDownloader(filePath);

    await handleIncomingMessage({ message: baseMessage, store, whatsapp, downloader, timezone: 'Asia/Kolkata' });

    expect(whatsapp.calls.map((call) => call.name)).toEqual(['sendVideo', 'sendText']);
    expect(whatsapp.calls.at(-1)).toEqual({
      name: 'sendText',
      args: ['group-1@g.us', 'Could not download this video: upload failed'],
    });
    expect(store.calls.map((call) => call.name)).toEqual(['getGroupSettings', 'wasRecentlyPosted']);
    expect(existsSync(dirname(filePath))).toBe(false);
  });

  it('does not claim download failure when delete fails after successful send', async () => {
    const filePath = await createDownloadedFile();
    const store = createStore();
    const whatsapp = createWhatsapp({
      async deleteMessage(messageId) {
        whatsapp.calls.push({ name: 'deleteMessage', args: [messageId] });
        throw new Error('not admin');
      },
    });
    const downloader = createDownloader(filePath);

    await handleIncomingMessage({ message: baseMessage, store, whatsapp, downloader, timezone: 'Asia/Kolkata' });

    expect(whatsapp.calls.map((call) => call.name)).toEqual(['sendVideo', 'deleteMessage']);
    expect(store.calls.map((call) => call.name)).toEqual([
      'getGroupSettings',
      'wasRecentlyPosted',
      'recordDuplicate',
      'recordRepost',
    ]);
    expect(existsSync(dirname(filePath))).toBe(false);
  });
});
