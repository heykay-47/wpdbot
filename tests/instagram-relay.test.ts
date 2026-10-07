import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDownloader } from '../src/downloader';
import { handleIncomingMessage, type IncomingMessage } from '../src/relay';
import { createStore, type Store } from '../src/store';
import { videoProbeJson } from './fixtures/media';

const roots: string[] = [];
const stores: Store[] = [];
const message: IncomingMessage = {
  id: 'source-1', groupId: 'group-1@g.us', senderId: 'sender@c.us', senderName: 'Sender',
  body: 'https://www.instagram.com/p/example/', timestampMs: 1_000, isGroup: true, fromMe: false,
};
const metadata = {
  extractor_key: 'Instagram',
  _type: 'playlist', id: 'post-1', entries: [
    { id: 'video-1', formats: [{ url: 'https://media.example/one.mp4', ext: 'mp4' }] },
    { id: 'photo-2', formats: [] },
    { id: 'video-3', formats: [{ url: 'https://media.example/three.mp4', ext: 'mp4' }] },
  ],
};

afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores) store.close();
  stores.length = 0;
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.length = 0;
});

async function fixture(sourceMetadata: unknown = metadata, failDownloads = new Set<string>()) {
  const root = await mkdtemp(join(tmpdir(), 'wpdbot-instagram-'));
  roots.push(root);
  const databasePath = join(root, 'bot.sqlite');
  const store = createStore(databasePath);
  stores.push(store);
  store.setGroupEnabled(message.groupId, true);
  const downloads: string[] = [];
  const inspectedUrls: string[] = [];
  const downloader = createDownloader({
    downloadDir: join(root, 'downloads'),
    runner: async (_file, args) => {
      if (_file === 'ffprobe') return { stdout: videoProbeJson };
      if (args.includes('--dump-single-json')) {
        inspectedUrls.push(args.at(-1)!);
        return { stdout: JSON.stringify(sourceMetadata) };
      }
      const infoPath = args[args.indexOf('--load-info-json') + 1];
      const info = JSON.parse(readFileSync(infoPath, 'utf8')) as { id: string };
      if (failDownloads.has(info.id)) throw new Error('Download unavailable');
      const filePath = join(dirname(infoPath), `${info.id}.mp4`);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, 'video');
      downloads.push(filePath);
      return { stdout: `${filePath}\n` };
    },
  });
  const whatsapp = {
    sendVideo: vi.fn(async () => undefined),
    sendVideoOnce: vi.fn(async (_groupId: string, path: string, _caption: string) => ({ messageId: `sent-${basename(path)}`, ack: 1 })),
    sendText: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
  };
  return { root, databasePath, downloads, inspectedUrls, store, whatsapp, downloader, message, timezone: 'UTC', downloadDir: join(root, 'downloads'), nowMs: 2_000 };
}

function reopenStore(input: Awaited<ReturnType<typeof fixture>>) {
  const index = stores.indexOf(input.store);
  input.store.close();
  input.store = createStore(input.databasePath);
  stores[index] = input.store;
}

describe('Instagram collection relaying', () => {
  it('reposts every verifiable video in order, records individual confirmations, skips photos, and keeps the source', async () => {
    const input = await fixture();

    await handleIncomingMessage(input);

    expect(input.whatsapp.sendVideoOnce.mock.calls.map((call) => basename(call[1]))).toEqual(['video-1.mp4', 'video-3.mp4']);
    expect(input.whatsapp.sendVideo).not.toHaveBeenCalled();
    expect(input.whatsapp.deleteMessage).not.toHaveBeenCalled();
    expect(input.store.countReposts()).toBe(2);
    expect(input.store.getMediaDisposition({ groupId: message.groupId, messageId: message.id, identity: { platform: 'instagram', postId: 'post-1', itemId: 'video-1' } }, input.nowMs, 24)).toBe('completed');
    expect(input.downloads.every((path) => !existsSync(dirname(path)))).toBe(true);
  });

  it('does not resend confirmed collection items when the same source is received after a restart', async () => {
    const input = await fixture();
    await handleIncomingMessage(input);
    reopenStore(input);
    input.nowMs += 25 * 60 * 60 * 1000;

    await handleIncomingMessage(input);

    expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledTimes(2);
    expect(input.store.countReposts()).toBe(2);
    expect(input.whatsapp.deleteMessage).not.toHaveBeenCalled();
  });

  it('keeps the original URL duplicate window for mixed posts even though their source messages remain visible', async () => {
    const input = await fixture();
    await handleIncomingMessage(input);
    input.message = { ...message, id: 'source-2' };

    await handleIncomingMessage(input);

    expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledTimes(2);
    expect(input.store.countReposts()).toBe(2);
    expect(input.whatsapp.deleteMessage).not.toHaveBeenCalled();
  });

  it('continues after a definite download failure without automatically retrying recorded failures on later source events', async () => {
    const failDownloads = new Set(['video-2']);
    const input = await fixture({ ...metadata, entries: [metadata.entries[0],
      { id: 'video-2', formats: [{ url: 'https://media.example/two.mp4', ext: 'mp4' }] }, metadata.entries[2],
    ] }, failDownloads);
    await handleIncomingMessage(input);
    expect(input.whatsapp.sendVideoOnce.mock.calls.map((call) => basename(call[1]))).toEqual(['video-1.mp4', 'video-3.mp4']);
    expect(input.whatsapp.deleteMessage).not.toHaveBeenCalled();
    failDownloads.clear();
    reopenStore(input);

    await handleIncomingMessage(input);

    expect(input.whatsapp.sendVideoOnce.mock.calls.map((call) => basename(call[1]))).toEqual(['video-1.mp4', 'video-3.mp4']);
    expect(input.store.countReposts()).toBe(2);
    expect(input.downloads.every((path) => !existsSync(dirname(path)))).toBe(true);
  });

  it('continues downloading other videos when a download-failure notification cannot be sent', async () => {
    const input = await fixture(metadata, new Set(['video-1']));
    input.whatsapp.sendText.mockRejectedValueOnce(new Error('Notification failed'));

    await handleIncomingMessage(input);

    expect(input.whatsapp.sendVideoOnce.mock.calls.map((call) => basename(call[1]))).toEqual(['video-3.mp4']);
    expect(input.store.countReposts()).toBe(1);
    expect(input.whatsapp.deleteMessage).not.toHaveBeenCalled();
  });

  it('holds ambiguous sends across restarts and never retries them or already confirmed items', async () => {
    const input = await fixture();
    input.whatsapp.sendVideoOnce
      .mockResolvedValueOnce({ messageId: 'sent-video-1', ack: 1 })
      .mockRejectedValueOnce(new Error('Browser disconnected after submission'));
    await handleIncomingMessage(input);
    expect(input.store.getMediaDisposition({ groupId: message.groupId, messageId: message.id, identity: { platform: 'instagram', postId: 'post-1', itemId: 'video-3' } }, input.nowMs, 24)).toBe('held');
    reopenStore(input);

    await handleIncomingMessage(input);

    expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledTimes(2);
    expect(input.store.countReposts()).toBe(1);
    expect(input.whatsapp.sendText).toHaveBeenLastCalledWith(message.groupId, 'An Instagram video has an unresolved send. No automatic retry. Original message kept.');
    expect(input.whatsapp.deleteMessage).not.toHaveBeenCalled();
    expect(input.downloads.every((path) => !existsSync(dirname(path)))).toBe(true);
  });

  it('does not send when a prior process reserved the item but crashed before recording its outcome', async () => {
    const input = await fixture();
    input.store.beginInstagramItem({ groupId: message.groupId, messageId: message.id, postId: 'post-1', itemId: 'video-1' }, 1_500);
    reopenStore(input);

    await handleIncomingMessage(input);

    expect(input.whatsapp.sendVideoOnce).not.toHaveBeenCalled();
    expect(input.downloads).toEqual([]);
    expect(input.whatsapp.deleteMessage).not.toHaveBeenCalled();
  });

  it('retains the source and holds a submitted video when confirmation storage fails', async () => {
    const input = await fixture();
    vi.spyOn(input.store, 'confirmMediaRepost').mockImplementationOnce(() => { throw new Error('Database locked'); });
    await handleIncomingMessage(input);
    reopenStore(input);

    await handleIncomingMessage(input);

    expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledOnce();
    expect(input.whatsapp.deleteMessage).not.toHaveBeenCalled();
    expect(input.store.countReposts()).toBe(0);
    expect(input.downloads.every((path) => !existsSync(dirname(path)))).toBe(true);
  });

  it('does not submit a video if its send reservation cannot be stored', async () => {
    const input = await fixture();
    vi.spyOn(input.store, 'beginMediaRepost').mockImplementationOnce(() => { throw new Error('Database unavailable'); });

    await handleIncomingMessage(input);

    expect(input.whatsapp.sendVideoOnce).not.toHaveBeenCalled();
    expect(input.whatsapp.deleteMessage).not.toHaveBeenCalled();
    expect(input.downloads.every((path) => !existsSync(dirname(path)))).toBe(true);
  });

  it('reposts only the explicitly selected video and identifies its original position in the caption', async () => {
    const input = await fixture();
    input.message = { ...message, body: `${message.body}?img_index=3` };

    await handleIncomingMessage(input);

    expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledOnce();
    expect(basename(input.whatsapp.sendVideoOnce.mock.calls[0][1])).toBe('video-3.mp4');
    expect(input.whatsapp.sendVideoOnce.mock.calls[0][2]).toContain('Instagram item 3 of 3');
    expect(input.store.countReposts()).toBe(1);
    expect(input.whatsapp.deleteMessage).not.toHaveBeenCalled();
  });

  it('reposts only missing videos when a selected-item request is followed by an equivalent whole-post link', async () => {
    const input = await fixture();
    input.message = { ...message, body: `${message.body}?img_index=3` };
    await handleIncomingMessage(input);
    input.message = { ...message, id: 'source-2', body: 'https://instagram.com/reel/example/?igsh=tracking' };

    await handleIncomingMessage(input);

    expect(input.whatsapp.sendVideoOnce.mock.calls.map((call) => basename(call[1]))).toEqual(['video-3.mp4', 'video-1.mp4']);
    expect(input.store.countReposts()).toBe(2);
    expect(input.whatsapp.deleteMessage).not.toHaveBeenCalled();
  });

  it('does not resend a selected video already confirmed by an equivalent whole-post request', async () => {
    const input = await fixture();
    await handleIncomingMessage(input);
    input.message = { ...message, id: 'source-2', body: 'https://instagram.com/reel/example/?img_index=3' };
    await handleIncomingMessage(input);
    expect(input.whatsapp.sendVideoOnce.mock.calls.map((call) => basename(call[1]))).toEqual(['video-1.mp4', 'video-3.mp4']);
    expect(input.store.countReposts()).toBe(2);
    expect(input.whatsapp.deleteMessage).not.toHaveBeenCalled();
  });

  it('holds an unknown selected video across source messages and expiry without holding other videos in the post', async () => {
    const input = await fixture();
    input.message = { ...message, body: `${message.body}?img_index=3` };
    input.whatsapp.sendVideoOnce.mockRejectedValueOnce(new Error('Outcome unknown'));
    await handleIncomingMessage(input);
    reopenStore(input);
    input.nowMs += 48 * 60 * 60 * 1000;
    input.message = { ...message, id: 'source-2', body: 'https://instagram.com/reel/example/' };
    await handleIncomingMessage(input);
    expect(input.whatsapp.sendVideoOnce.mock.calls.map((call) => basename(call[1]))).toEqual(['video-3.mp4', 'video-1.mp4']);
    expect(input.store.countReposts()).toBe(1);
    expect(input.whatsapp.deleteMessage).not.toHaveBeenCalled();
  });

  it('resolves a mobile Instagram request only through verified metadata and never rewrites its source URL', async () => {
    const input = await fixture();
    input.message = { ...message, body: 'https://m.instagram.com/p/example/?img_index=3&other=unknown' };
    await handleIncomingMessage(input);
    expect(input.inspectedUrls).toEqual(['https://m.instagram.com/p/example/?img_index=3&other=unknown']);
    expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledOnce();
    expect(input.whatsapp.sendVideoOnce.mock.calls[0][2]).toContain('Original: https://m.instagram.com/p/example/?img_index=3&other=unknown');
  });

  it.each(['2', '0', '4', 'invalid'])('keeps selected non-video or invalid item %s without choosing another video', async (selection) => {
    const input = await fixture();
    input.message = { ...message, body: `${message.body}?img_index=${selection}` };

    await handleIncomingMessage(input);

    expect(input.whatsapp.sendVideoOnce).not.toHaveBeenCalled();
    expect(input.whatsapp.sendVideo).not.toHaveBeenCalled();
    expect(input.whatsapp.deleteMessage).not.toHaveBeenCalled();
    expect(input.store.countReposts()).toBe(0);
  });
});
