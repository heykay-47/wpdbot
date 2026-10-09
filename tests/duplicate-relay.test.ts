import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDownloader } from '../src/downloader';
import { KeyedTaskQueue } from '../src/keyedTaskQueue';
import { handleIncomingMessage, type IncomingMessage } from '../src/relay';
import { createStore, type Store, type StoreDefaults } from '../src/store';
import { videoProbeJson } from './fixtures/media';

const stores: Store[] = [];
const roots: string[] = [];
const message: IncomingMessage = {
  id: 'source-1', groupId: 'group-1@g.us', senderId: 'sender@c.us', senderName: 'Sender',
  body: 'https://www.youtube.com/shorts/AbCdEf123_-', timestampMs: 1_000, isGroup: true, fromMe: false,
};

afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores) store.close();
  stores.length = 0;
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.length = 0;
});

async function fixture(defaults: StoreDefaults = {}) {
  const root = await mkdtemp(join(tmpdir(), 'wpdbot-duplicates-'));
  roots.push(root);
  const databasePath = join(root, 'bot.sqlite');
  const store = createStore(databasePath, defaults);
  stores.push(store);
  store.setGroupEnabled(message.groupId, true);
  const clock = { value: 2_000 };
  const inspectedUrls: string[] = [];
  const downloadedPaths: string[] = [];
  const failures = { inspection: false, download: false };
  const downloader = createDownloader({ downloadDir: join(root, 'downloads'), runner: async (_file, args) => {
    if (_file === 'ffprobe') return { stdout: videoProbeJson };
    if (args.includes('--dump-single-json')) {
      inspectedUrls.push(args.at(-1)!);
      if (failures.inspection) throw new Error('Inspection unavailable');
      return { stdout: JSON.stringify({ id: 'AbCdEf123_-', extractor_key: 'Youtube',
        formats: [{ url: 'https://media.example/youtube.mp4', ext: 'mp4' }] }) };
    }
    if (failures.download) throw new Error('Download unavailable');
    const infoPath = args[args.indexOf('--load-info-json') + 1];
    const info = JSON.parse(readFileSync(infoPath, 'utf8'));
    const filePath = join(dirname(infoPath), `${info.id}.mp4`);
    writeFileSync(filePath, 'video');
    downloadedPaths.push(filePath);
    return { stdout: filePath };
  } });
  const whatsapp = {
    sendVideo: vi.fn(async () => undefined),
    sendVideoOnce: vi.fn(async (_groupId: string, _path: string, _caption: string) => ({ messageId: 'sent-1', ack: 1 })),
    sendText: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
  };
  return { message, store, downloader, whatsapp, timezone: 'UTC', now: () => clock.value, clock,
    databasePath, inspectedUrls, downloadedPaths, failures, downloadDir: join(root, 'downloads'), queue: new KeyedTaskQueue() };
}

function reopen(input: Awaited<ReturnType<typeof fixture>>) {
  const index = stores.indexOf(input.store);
  input.store.close();
  input.store = createStore(input.databasePath);
  stores[index] = input.store;
}

describe('group duplicate relaying', () => {
  it('confirms one YouTube repost across equivalent source URLs without fallback sends or source deletion', async () => {
    const input = await fixture();
    await handleIncomingMessage(input);
    reopen(input);
    input.message = { ...message, id: 'source-2', body: 'http://m.youtube.com/shorts/AbCdEf123_-/?utm_source=x#fragment' };

    await handleIncomingMessage(input);

    expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledOnce();
    expect(input.whatsapp.sendVideo).not.toHaveBeenCalled();
    expect(input.whatsapp.deleteMessage).not.toHaveBeenCalled();
    expect(input.store.countReposts()).toBe(1);
    expect(input.downloadedPaths.every((path) => !existsSync(dirname(path)))).toBe(true);
  });

  it('uses observed confirmation time, does not extend the window on skips, and never resets the same source', async () => {
    const input = await fixture({ duplicateWindowHours: 1 });
    input.whatsapp.sendVideoOnce.mockImplementationOnce(async () => {
      input.clock.value = 10_000;
      return { messageId: 'sent-1', ack: 1 };
    });
    await handleIncomingMessage(input);
    input.clock.value = 3_610_000;
    input.message = { ...message, id: 'source-2', body: 'https://m.youtube.com/shorts/AbCdEf123_-' };
    await handleIncomingMessage(input);
    expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledOnce();
    input.clock.value += 1;
    input.message = { ...message };
    await handleIncomingMessage(input);
    expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledOnce();
    input.message = { ...input.message, id: 'source-3' };
    await handleIncomingMessage(input);
    expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledTimes(2);
    expect(input.store.countReposts()).toBe(2);
    expect(input.whatsapp.deleteMessage).not.toHaveBeenCalled();
  });

  it.each(['throw', 'pending-ack', 'missing-id', 'record-failure'] as const)('holds %s outcomes across aliases, source messages and restarts with a zero duplicate window', async (mode) => {
    const input = await fixture({ duplicateWindowHours: 0 });
    if (mode === 'throw') input.whatsapp.sendVideoOnce.mockRejectedValueOnce(new Error('Disconnected after submission'));
    if (mode === 'pending-ack') input.whatsapp.sendVideoOnce.mockResolvedValueOnce({ messageId: 'sent-1', ack: 0 });
    if (mode === 'missing-id') input.whatsapp.sendVideoOnce.mockResolvedValueOnce({ messageId: '', ack: 1 });
    if (mode === 'record-failure') vi.spyOn(input.store, 'confirmMediaRepost').mockImplementationOnce(() => { throw new Error('Database unavailable'); });
    await handleIncomingMessage(input);
    reopen(input);
    input.clock.value += 48 * 60 * 60 * 1000;
    input.message = { ...message, id: 'source-2', body: 'https://youtube.com/shorts/AbCdEf123_-?igsh=x' };

    await handleIncomingMessage(input);

    expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledOnce();
    expect(input.whatsapp.sendVideo).not.toHaveBeenCalled();
    expect(input.store.countReposts()).toBe(0);
    expect(input.whatsapp.sendText).toHaveBeenLastCalledWith(message.groupId, expect.stringContaining('Do not retry or repost'));
    expect(input.whatsapp.deleteMessage).not.toHaveBeenCalled();
  });

  it('serializes equivalent queued URLs and rechecks the first confirmed outcome before sending again', async () => {
    const input = await fixture();
    let started!: () => void;
    let acknowledge!: () => void;
    const sending = new Promise<void>((resolve) => { started = resolve; });
    const acknowledged = new Promise<void>((resolve) => { acknowledge = resolve; });
    input.whatsapp.sendVideoOnce.mockImplementationOnce(async () => {
      started();
      await acknowledged;
      return { messageId: 'sent-1', ack: 1 };
    });
    const first = handleIncomingMessage(input);
    await sending;
    const second = handleIncomingMessage({ ...input, message: { ...message, id: 'source-2', body: 'https://m.youtube.com/shorts/AbCdEf123_-?utm_source=x' } });
    acknowledge();
    await Promise.all([first, second]);

    expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledOnce();
    expect(input.store.countReposts()).toBe(1);
  });

  it('protects a pending video reached through a different request key even without a shared queue', async () => {
    const input = await fixture({ duplicateWindowHours: 0 });
    let started!: () => void;
    let acknowledge!: () => void;
    const sending = new Promise<void>((resolve) => { started = resolve; });
    const acknowledged = new Promise<void>((resolve) => { acknowledge = resolve; });
    input.whatsapp.sendVideoOnce.mockImplementationOnce(async () => {
      started();
      await acknowledged;
      return { messageId: 'sent-1', ack: 1 };
    });
    const first = handleIncomingMessage({ ...input, queue: undefined });
    await sending;
    await handleIncomingMessage({ ...input, queue: undefined, message: { ...message, id: 'source-2', body: 'https://youtube.com/shorts/AbCdEf123_-?other=x' } });
    acknowledge();
    await first;

    expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledOnce();
    expect(input.store.countReposts()).toBe(1);
    expect(input.whatsapp.sendText).toHaveBeenCalledWith(message.groupId, expect.stringContaining('Do not retry or repost'));
  });

  it.each(['inspection', 'download'] as const)('permits a later request after a definite pre-send %s failure', async (mode) => {
    const input = await fixture();
    input.failures[mode] = true;
    await handleIncomingMessage(input);
    expect(input.whatsapp.sendVideoOnce).not.toHaveBeenCalled();
    input.failures[mode] = false;
    input.message = { ...message, id: 'source-2' };
    await handleIncomingMessage(input);
    expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledOnce();
    expect(input.store.countReposts()).toBe(1);
  });

  it('suppresses legacy exact-URL hashes without promoting them to alias-wide confirmed identities', async () => {
    const input = await fixture();
    input.store.recordDuplicate(message.groupId, 'd60dc06457b51ea150d2b9162b3dfac62ed2a904bcba110bd249b9b13cf87cd9', 1_000);
    await handleIncomingMessage(input);
    expect(input.whatsapp.sendVideoOnce).not.toHaveBeenCalled();
    expect(input.inspectedUrls).toEqual([]);
    input.message = { ...message, id: 'source-2', body: 'https://m.youtube.com/shorts/AbCdEf123_-' };
    await handleIncomingMessage(input);
    expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledOnce();
    expect(input.store.countReposts()).toBe(1);
    expect(input.whatsapp.deleteMessage).not.toHaveBeenCalled();
  });

  it('isolates confirmed repost windows by group and disables suppression at zero without resetting a source completion', async () => {
    const input = await fixture({ duplicateWindowHours: 0 });
    await handleIncomingMessage(input);
    input.message = { ...message, id: 'source-2' };
    await handleIncomingMessage(input);
    expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledTimes(2);
    input.store.setGroupEnabled('group-2@g.us', true);
    input.message = { ...message, groupId: 'group-2@g.us' };
    await handleIncomingMessage(input);
    expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledTimes(3);
    expect(input.store.countReposts()).toBe(3);
  });

  it('rechecks the current group window and clock after queued work waits', async () => {
    const input = await fixture({ duplicateWindowHours: 1 });
    await handleIncomingMessage(input);
    input.message = { ...message, id: 'source-2' };
    input.clock.value += 2 * 60 * 60 * 1000;
    await handleIncomingMessage({ ...input, queue: {
      async run(_key, task) {
        const database = new Database(input.databasePath);
        database.prepare('UPDATE group_settings SET duplicate_window_hours = 3 WHERE group_id = ?').run(message.groupId);
        database.close();
        input.clock.value += 30 * 60 * 1000;
        return task();
      },
    } });
    expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledOnce();
    input.clock.value += 31 * 60 * 1000;
    input.message = { ...message, id: 'source-3' };
    await handleIncomingMessage(input);
    expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledTimes(2);
  });

  it('does not submit queued work after the group is disabled', async () => {
    const input = await fixture();
    await handleIncomingMessage({ ...input, queue: { async run(_key, task) {
      input.store.setGroupEnabled(message.groupId, false);
      return task();
    } } });
    expect(input.whatsapp.sendVideoOnce).not.toHaveBeenCalled();
    expect(input.inspectedUrls).toEqual([]);
  });

  it('does not submit a video when its reservation cannot be stored', async () => {
    const input = await fixture();
    vi.spyOn(input.store, 'beginMediaRepost').mockImplementationOnce(() => { throw new Error('Database unavailable'); });
    await handleIncomingMessage(input);
    expect(input.whatsapp.sendVideoOnce).not.toHaveBeenCalled();
    expect(input.whatsapp.deleteMessage).not.toHaveBeenCalled();
    expect(input.store.countReposts()).toBe(0);
    expect(input.downloadedPaths.every((path) => !existsSync(dirname(path)))).toBe(true);
  });

  it.each([
    'https://youtube.com/shorts/Another123_/../AbCdEf123_-',
    'https://youtube.com/shorts/Another123_/%2e%2e/AbCdEf123_-',
  ])('inspects the submitted unusual path %s instead of skipping it by a guessed canonical identity', async (url) => {
    const input = await fixture();
    await handleIncomingMessage(input);
    input.message = { ...message, id: 'source-2', body: url };
    await handleIncomingMessage(input);
    expect(input.inspectedUrls).toEqual([message.body, url]);
    expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledOnce();
  });
});
