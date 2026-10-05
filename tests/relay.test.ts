import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDownloader } from '../src/downloader';
import { handleIncomingMessage, type IncomingMessage } from '../src/relay';
import { createStore, type Store } from '../src/store';
import { videoProbeJson } from './fixtures/media';

const baseMessage: IncomingMessage = {
  id: 'message-1', groupId: 'group-1@g.us', senderId: 'sender@c.us', senderName: 'Mom',
  body: 'watch this https://www.youtube.com/shorts/AbCdEf123_-?utm_source=x',
  timestampMs: Date.UTC(2026, 5, 8, 14, 12), isGroup: true, fromMe: false,
};
const roots: string[] = [];
const stores: Store[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores) store.close();
  stores.length = 0;
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.length = 0;
});

async function fixture(platform: 'youtube' | 'instagram' = 'youtube') {
  const root = await mkdtemp(join(tmpdir(), 'wpdbot-relay-'));
  roots.push(root);
  const store = createStore(join(root, 'bot.sqlite'));
  stores.push(store);
  store.setGroupEnabled(baseMessage.groupId, true);
  const artifacts: string[] = [];
  const inspectedUrls: string[] = [];
  const failures = { inspection: false, download: false };
  const downloadDir = join(root, 'downloads');
  const downloader = createDownloader({ downloadDir, runner: async (_file, args) => {
    if (_file === 'ffprobe') return { stdout: videoProbeJson };
    if (args.includes('--dump-single-json')) {
      inspectedUrls.push(args.at(-1)!);
      if (failures.inspection) throw new Error('private upstream response');
      return { stdout: JSON.stringify({ extractor_key: platform === 'youtube' ? 'Youtube' : 'Instagram', id: platform === 'youtube' ? 'AbCdEf123_-' : 'post-1',
        formats: [{ url: 'https://media.example/video.mp4', ext: 'mp4' }] }) };
    }
    if (failures.download) throw new Error('cookies=/run/secrets/cookies.txt proxy=http://user:pass@example.com');
    const infoPath = args[args.indexOf('--load-info-json') + 1];
    const filePath = join(dirname(infoPath), 'video.mp4');
    writeFileSync(filePath, 'video');
    writeFileSync(join(dirname(infoPath), 'partial.mp4'), 'partial');
    artifacts.push(filePath);
    return { stdout: filePath };
  } });
  const whatsapp = {
    sendVideo: vi.fn(async () => undefined),
    sendVideoOnce: vi.fn(async (_groupId: string, _path: string, _caption: string) => ({ messageId: 'sent-1', ack: 1 })),
    sendText: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
  };
  const logs: Record<string, unknown>[] = [];
  return { message: platform === 'youtube' ? baseMessage : { ...baseMessage, body: 'https://instagram.com/p/example/' }, store, downloader, whatsapp, timezone: 'Asia/Kolkata', nowMs: Date.UTC(2026, 5, 8, 15, 0),
    downloadDir, artifacts, inspectedUrls, failures, logs, logger: (entry: Record<string, unknown>) => logs.push(entry) };
}

describe('handleIncomingMessage', () => {
  it('relays only the first supported source link, attributes its unchanged URL, and retains the source', async () => {
    const input = await fixture();
    input.message = { ...baseMessage, body: `${baseMessage.body} https://instagram.com/p/another/` };

    await handleIncomingMessage(input);

    expect(input.inspectedUrls).toEqual(['https://www.youtube.com/shorts/AbCdEf123_-?utm_source=x']);
    expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledWith(baseMessage.groupId, input.artifacts[0],
      'Sent by Mom at 08 Jun 2026, 7:42 PM IST\nOriginal: https://www.youtube.com/shorts/AbCdEf123_-?utm_source=x');
    expect(input.whatsapp.sendVideo).not.toHaveBeenCalled();
    expect(input.whatsapp.deleteMessage).not.toHaveBeenCalled();
    expect(input.store.countReposts()).toBe(1);
  });

  it('submits a preselected document once and holds an ambiguous outcome without any fallback send', async () => {
    const input = await fixture();
    const original = input.downloader.resolveYouTube;
    vi.spyOn(input.downloader, 'resolveYouTube').mockImplementation(async (url) => {
      const video = await original(url);
      return { ...video, download: async (limit) => ({ ...await video.download(limit), deliveryMode: 'document' }) };
    });
    input.whatsapp.sendVideoOnce.mockRejectedValue(new Error('Unknown outcome'));
    await handleIncomingMessage(input);
    expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledWith(baseMessage.groupId, input.artifacts[0], expect.stringContaining('Sent by Mom'), 'document');
    await handleIncomingMessage(input);
    expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledOnce();
    expect(input.whatsapp.sendVideo).not.toHaveBeenCalled();
    expect(input.store.countReposts()).toBe(0);
    expect(input.whatsapp.deleteMessage).not.toHaveBeenCalled();
  });

  it('rechecks the current group budget before reserving a send and cleans the rejected media', async () => {
    const input = await fixture();
    const getSettings = input.store.getGroupSettings;
    vi.spyOn(input.store, 'getGroupSettings').mockImplementation((groupId) => ({ ...getSettings(groupId), maxFileSizeMb: 128 }));
    const resolveVideo = input.downloader.resolveYouTube;
    vi.spyOn(input.downloader, 'resolveYouTube').mockImplementation(async (url) => {
      const video = await resolveVideo(url);
      return { ...video, download: async (limit) => {
        const download = await video.download(limit);
        writeFileSync(download.filePath, Buffer.alloc(1024 * 1024 + 1));
        return download;
      } };
    });
    await handleIncomingMessage({ ...input, maxMediaSizeMb: 1 });
    expect(input.whatsapp.sendVideoOnce).not.toHaveBeenCalled();
    expect(input.store.getMediaDisposition({ groupId: baseMessage.groupId, messageId: baseMessage.id, identity: { platform: 'youtube', videoId: 'AbCdEf123_-' } }, input.nowMs, 24)).toBe('ready');
    expect(existsSync(input.artifacts[0])).toBe(false);
    expect(input.store.getGroupSettings(baseMessage.groupId).maxFileSizeMb).toBe(128);
  });

  it.each(['non-group', 'from-me', 'unsupported', 'disabled'] as const)('ignores %s source messages', async (mode) => {
    const input = await fixture();
    input.message = { ...baseMessage, isGroup: mode !== 'non-group', fromMe: mode === 'from-me',
      body: mode === 'unsupported' ? 'https://youtube.com/watch?v=AbCdEf123_-' : baseMessage.body };
    if (mode === 'disabled') input.store.setGroupEnabled(baseMessage.groupId, false);

    await handleIncomingMessage(input);

    expect(input.inspectedUrls).toEqual([]);
    expect(input.whatsapp.sendVideoOnce).not.toHaveBeenCalled();
    expect(input.whatsapp.sendText).not.toHaveBeenCalled();
  });

  it('does not send when a source-message identity is missing', async () => {
    const input = await fixture();
    input.message = { ...baseMessage, id: '' };
    await handleIncomingMessage(input);
    expect(input.whatsapp.sendVideoOnce).not.toHaveBeenCalled();
    expect(input.whatsapp.sendText).toHaveBeenCalledWith(baseMessage.groupId, 'YouTube relay needs a source message ID. Original message kept.');
  });

  it('uses injected file cleanup without deleting the source message', async () => {
    const input = await fixture();
    const cleaned: string[] = [];
    await handleIncomingMessage({ ...input, cleanupPath: async (path) => { cleaned.push(path); } });
    expect(cleaned).toEqual(input.artifacts);
    expect(existsSync(input.artifacts[0])).toBe(true);
    expect(input.whatsapp.deleteMessage).not.toHaveBeenCalled();
  });

  it.each([false, true])('cleans owned download artifacts after a send with unknown outcome=%s', async (unknown) => {
    const input = await fixture();
    if (unknown) input.whatsapp.sendVideoOnce.mockRejectedValueOnce(new Error('Disconnected'));
    await handleIncomingMessage(input);
    expect(input.artifacts.every((path) => !existsSync(dirname(path)))).toBe(true);
    expect(existsSync(input.downloadDir)).toBe(true);
    expect(input.whatsapp.deleteMessage).not.toHaveBeenCalled();
  });

  it.each([false, true])('does not recursively clean a download directory that is not configured as owned, omitted=%s', async (omitted) => {
    const input = await fixture();
    const ownedDir = input.downloadDir;
    await handleIncomingMessage({ ...input, downloadDir: omitted ? undefined : join(ownedDir, 'another-root') });
    expect(existsSync(input.artifacts[0])).toBe(false);
    expect(readFileSync(join(dirname(input.artifacts[0]), 'partial.mp4'), 'utf8')).toBe('partial');
  });

  it.each(['inspection', 'download'] as const)('reports %s failure without exposing secrets or creating a confirmed outcome', async (step) => {
    const input = await fixture();
    input.failures[step] = true;
    await handleIncomingMessage(input);
    expect(input.whatsapp.sendVideoOnce).not.toHaveBeenCalled();
    expect(input.whatsapp.sendText).toHaveBeenCalledWith(baseMessage.groupId, step === 'inspection'
      ? 'Could not establish this YouTube video identity. Original message kept.'
      : 'Could not download this video: Download unavailable or blocked. Original message kept.');
    expect(input.store.countReposts()).toBe(0);
    expect(input.whatsapp.deleteMessage).not.toHaveBeenCalled();
  });

  it('logs an unexpected settings error with its source context and a safe group error ID', async () => {
    const input = await fixture();
    vi.spyOn(input.store, 'getGroupSettings').mockImplementationOnce(() => { throw new Error('database exploded'); });
    await handleIncomingMessage(input);
    expect(input.whatsapp.sendText).toHaveBeenCalledWith(baseMessage.groupId, expect.stringMatching(/^Something went wrong\. Error ID: ERR-[0-9A-F]{6}$/u));
    expect(input.logs[0]).toMatchObject({ step: 'settings', groupId: baseMessage.groupId, messageId: baseMessage.id, extractorId: 'youtube' });
  });

  it('keeps upload-error reporting failures scoped to the upload and source URL fingerprint', async () => {
    const input = await fixture();
    input.whatsapp.sendVideoOnce.mockRejectedValueOnce(new Error('session=secret'));
    input.whatsapp.sendText.mockRejectedValueOnce(new Error('Reporting unavailable'));
    await handleIncomingMessage(input);
    expect(input.logs[0]).toMatchObject({ step: 'upload', groupId: baseMessage.groupId, messageId: baseMessage.id,
      extractorId: 'youtube', urlHash: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    expect(input.whatsapp.sendVideo).not.toHaveBeenCalled();
  });

  it('logs confirmation-storage failure without deleting the source or initiating another send', async () => {
    const input = await fixture();
    vi.spyOn(input.store, 'confirmMediaRepost').mockImplementationOnce(() => { throw new Error('database locked'); });
    await handleIncomingMessage(input);
    expect(input.logs[0]).toMatchObject({ step: 'record', groupId: baseMessage.groupId, messageId: baseMessage.id,
      extractorId: 'youtube', urlHash: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledOnce();
    expect(input.whatsapp.deleteMessage).not.toHaveBeenCalled();
    expect(input.store.countReposts()).toBe(0);
  });

  it.each(['youtube', 'instagram'] as const)('cleans downloaded %s artifacts if caption formatting throws before submission', async (platform) => {
    const input = await fixture(platform);
    await handleIncomingMessage({ ...input, timezone: 'Invalid/Zone' });
    expect(input.artifacts).toHaveLength(1);
    expect(existsSync(dirname(input.artifacts[0]))).toBe(false);
    expect(input.whatsapp.sendVideoOnce).not.toHaveBeenCalled();
    expect(input.whatsapp.deleteMessage).not.toHaveBeenCalled();
    expect(input.store.countReposts()).toBe(0);
  });
});
