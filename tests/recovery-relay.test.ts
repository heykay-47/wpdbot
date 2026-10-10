import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { handleIncomingMessage, recoverRelaySources, observeRelayAcknowledgement, type IncomingMessage } from '../src/relay';
import { createStore, type Store } from '../src/store';
import type { RepostConfirmation, RepostEvidence } from '../src/store';
import { RelayLifecycle } from '../src/relayLifecycle';

const roots: string[] = [];
const stores: Store[] = [];
const message: IncomingMessage = {
  id: 'source-1', groupId: 'group@g.us', senderId: 'sender@c.us', senderName: 'Sender',
  body: 'private commentary https://youtube.com/shorts/AbCdEf123_-', timestampMs: 1_000, isGroup: true, fromMe: false,
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores) store.close();
  stores.length = 0;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wpdbot-recovery-'));
  roots.push(root);
  const path = join(root, 'bot.sqlite');
  const store = createStore(path);
  stores.push(store);
  store.setGroupEnabled(message.groupId, true);
  const filePath = join(root, 'video.mp4');
  writeFileSync(filePath, 'video');
  const downloader = {
    download: vi.fn(), resolveInstagram: vi.fn(),
    resolveYouTube: vi.fn(async () => ({ id: 'AbCdEf123_-', download: vi.fn(async () => ({ filePath, sizeBytes: 5 })) })),
  };
  const whatsapp = {
    sendVideo: vi.fn(), deleteMessage: vi.fn(), sendText: vi.fn(async () => undefined),
    sendVideoOnce: vi.fn(async (_group?: string, _path?: string, _caption?: string, _mode?: 'document', _observe?: (evidence: RepostEvidence) => void) => ({ messageId: 'repost-1', ack: 1 })),
    getSourceMessage: vi.fn(async (): Promise<IncomingMessage | null> => message), lookupRepost: vi.fn(async (): Promise<RepostConfirmation | null> => null),
  };
  return { store, downloader, whatsapp, message, timezone: 'UTC', nowMs: 2_000, cleanupPath: async () => undefined, path };
}

function reopen(input: ReturnType<typeof fixture>) {
  const index = stores.indexOf(input.store);
  input.store.close();
  input.store = createStore(input.path);
  stores[index] = input.store;
}

it('persists accepted work before queue execution and recovers it without storing surrounding prose or scanning history', async () => {
  const input = fixture();
  await handleIncomingMessage({ ...input, queue: { run: async () => undefined } });
  expect(input.downloader.resolveYouTube).not.toHaveBeenCalled();
  reopen(input);
  expect(JSON.stringify(input.store.listRelaySources())).not.toContain('private commentary');

  await recoverRelaySources(input);
  await recoverRelaySources(input);

  expect(input.whatsapp.getSourceMessage).toHaveBeenCalledWith(message.groupId, message.id);
  expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledOnce();
  expect(input.store.countReposts()).toBe(1);
  expect(input.whatsapp.deleteMessage).not.toHaveBeenCalled();
});

it('retains pending ID evidence across restart and confirms only that exact repost without another send', async () => {
  const input = fixture();
  input.whatsapp.sendVideoOnce.mockImplementationOnce(async (_group, _path, _caption, _mode, observe) => {
    observe?.({ messageId: 'pending-1', ack: 0 });
    throw new Error('Acknowledgement timed out');
  });
  await handleIncomingMessage(input);
  reopen(input);
  input.whatsapp.lookupRepost.mockResolvedValueOnce({ messageId: 'wrong-id', ack: 1 });
  await recoverRelaySources(input);
  expect(input.store.countReposts()).toBe(0);
  input.whatsapp.lookupRepost.mockResolvedValueOnce({ messageId: 'pending-1', ack: 1 });
  await recoverRelaySources(input);
  await recoverRelaySources(input);
  expect(input.whatsapp.lookupRepost).toHaveBeenCalledWith(message.groupId, 'pending-1');
  expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledOnce();
  expect(input.store.countReposts()).toBe(1);
});

it('keeps interrupted pre-send work recoverable when shutdown starts during a download', async () => {
  const input = fixture();
  const control = new RelayLifecycle();
  const original = input.downloader.resolveYouTube;
  input.downloader.resolveYouTube.mockImplementationOnce(async () => {
    const video = await original();
    return { ...video, download: vi.fn(async () => {
      await control.stop();
      return video.download();
    }) };
  });
  await handleIncomingMessage({ ...input, control });
  expect(input.whatsapp.sendVideoOnce).not.toHaveBeenCalled();
  expect(input.store.getRelaySource(message.groupId, message.id)).toMatchObject({ status: 'paused' });
  reopen(input);
  await recoverRelaySources(input);
  expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledOnce();
});

it('holds work that ages beyond 24 hours while waiting in the queue', async () => {
  const input = fixture();
  const clock = { value: 2_000 };
  await handleIncomingMessage({ ...input, now: () => clock.value, queue: { run: async (_key, task) => {
    clock.value += 24 * 60 * 60 * 1000 + 1;
    return task();
  } } });
  expect(input.whatsapp.sendVideoOnce).not.toHaveBeenCalled();
  expect(input.store.getRelaySource(message.groupId, message.id)).toMatchObject({ status: 'held', holdReason: 'stale' });
});

it.each([24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000 + 1, -1])('enforces the exact ordinary recovery age boundary at %s ms', async (age) => {
  const input = fixture();
  await handleIncomingMessage({ ...input, queue: { run: async () => undefined } });
  await recoverRelaySources({ ...input, nowMs: 2_000 + age });
  expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledTimes(age === 24 * 60 * 60 * 1000 ? 1 : 0);
  if (age !== 24 * 60 * 60 * 1000) expect(input.store.getRelaySource(message.groupId, message.id))
    .toMatchObject({ status: 'held', holdReason: 'stale' });
});

it('holds invalid acceptance timestamps without blocking unrelated supported work', async () => {
  const input = fixture();
  await handleIncomingMessage({ ...input, queue: { run: async () => undefined } });
  const raw = new (await import('better-sqlite3')).default(input.path);
  try {
    const source = input.store.getRelaySource(message.groupId, message.id)!;
    raw.prepare('UPDATE relay_sources SET state_json = ?').run(JSON.stringify({ ...source, acceptedAtMs: 'invalid' }));
    await recoverRelaySources(input);
    expect(input.whatsapp.sendVideoOnce).not.toHaveBeenCalled();
    expect(() => input.store.getRelaySource(message.groupId, message.id)).toThrow();
    await handleIncomingMessage({ ...input, message: { ...message, id: 'unrelated-source' } });
    expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledOnce();
  } finally { raw.close(); }
});

it.each(['missing', 'changed', 'wrong-group', 'wrong-sender', 'lookup-error'] as const)('holds %s sources without sending from an unchecked snapshot', async (mode) => {
  const input = fixture();
  await handleIncomingMessage({ ...input, queue: { run: async () => undefined } });
  if (mode === 'lookup-error') input.whatsapp.getSourceMessage.mockRejectedValueOnce(new Error('History unavailable'));
  else input.whatsapp.getSourceMessage.mockResolvedValueOnce(mode === 'missing' ? null : {
    ...message, body: mode === 'changed' ? `${message.body} edited` : message.body,
    groupId: mode === 'wrong-group' ? 'other@g.us' : message.groupId,
    senderId: mode === 'wrong-sender' ? 'other@c.us' : message.senderId,
  });
  await recoverRelaySources(input);
  expect(input.whatsapp.sendVideoOnce).not.toHaveBeenCalled();
  const saved = input.store.getRelaySource(message.groupId, message.id)!;
  expect(saved).toMatchObject({ status: 'held' });
  expect(saved.version).toBe(2);
  if (saved.version === 2) {
    expect(saved.cleanup.initial).toBe('mixed-content');
    expect(saved.cleanup.disqualifications).toEqual(mode === 'changed' || mode === 'wrong-group' || mode === 'wrong-sender'
      ? ['source-edited'] : []);
  }
});

it('pauses disabled work and resumes on re-enable under current settings without resetting its acceptance time', async () => {
  const input = fixture();
  await handleIncomingMessage({ ...input, queue: { run: async () => undefined } });
  input.store.setGroupEnabled(message.groupId, false);
  await recoverRelaySources(input);
  expect(input.whatsapp.sendVideoOnce).not.toHaveBeenCalled();
  expect(input.store.getRelaySource(message.groupId, message.id)?.status).toBe('paused');
  input.store.setGroupEnabled(message.groupId, true);
  await recoverRelaySources(input);
  expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledOnce();
  expect(input.store.getRelaySource(message.groupId, message.id)?.acceptedAtMs).toBe(2_000);
});

it('continues an unrelated later link after an ambiguous submission and never resends that held video', async () => {
  const input = fixture();
  input.message = { ...message, body: `${message.body} https://youtube.com/shorts/Another123_` };
  input.whatsapp.getSourceMessage.mockResolvedValue(input.message);
  input.downloader.resolveYouTube.mockImplementation(async (url: string) => ({
    id: url.split('/').at(-1)!, download: vi.fn(async () => ({ filePath: join(roots.at(-1)!, 'video.mp4'), sizeBytes: 5 })),
  }));
  input.whatsapp.sendVideoOnce.mockRejectedValueOnce(new Error('Ambiguous first send'));
  await handleIncomingMessage(input);
  reopen(input);
  await recoverRelaySources(input);
  expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledTimes(2);
  expect(input.store.countReposts()).toBe(1);
  expect(input.store.getRelaySource(message.groupId, message.id)?.links.map((link) => link.plan?.items[0].status)).toEqual(['held', 'confirmed']);
});

it('stops later submissions after storage failure even when another source arrives', async () => {
  const input = fixture();
  const control = new RelayLifecycle();
  vi.spyOn(input.store, 'acceptRelaySource').mockImplementationOnce(() => { throw new Error('Disk full'); });
  await handleIncomingMessage({ ...input, control });
  await handleIncomingMessage({ ...input, control, message: { ...message, id: 'source-2' } });
  expect(input.downloader.resolveYouTube).not.toHaveBeenCalled();
  expect(input.whatsapp.sendVideoOnce).not.toHaveBeenCalled();
});

it.each(['replacement', 'reordering', 'parent'] as const)('holds an interrupted collection after a metadata %s instead of substituting videos', async (change) => {
  const input = fixture();
  const control = new RelayLifecycle();
  input.message = { ...message, body: 'https://instagram.com/p/example/' };
  input.whatsapp.getSourceMessage.mockResolvedValue(input.message);
  const download = async () => ({ filePath: join(roots.at(-1)!, 'video.mp4'), sizeBytes: 5 });
  const items = [
    { id: 'video-1', index: 1, kind: 'video' as const, download },
    { id: 'video-2', index: 2, kind: 'video' as const, download: async () => { await control.stop(); return download(); } },
  ];
  input.downloader.resolveInstagram.mockResolvedValueOnce({ id: 'post-1', totalItems: 2, items });
  await handleIncomingMessage({ ...input, control });
  expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledOnce();
  reopen(input);
  input.downloader.resolveInstagram.mockResolvedValue({ id: change === 'parent' ? 'different-parent' : 'post-1', totalItems: 2,
    items: change === 'reordering' ? [{ ...items[1], index: 1, download }, { ...items[0], index: 2 }]
      : [items[0], { ...items[1], id: change === 'replacement' ? 'video-3' : 'video-2', download }],
  });
  await recoverRelaySources(input);
  expect(input.whatsapp.sendVideoOnce).toHaveBeenCalledOnce();
  expect(input.store.countReposts()).toBe(1);
  expect(input.store.getRelaySource(message.groupId, message.id)).toMatchObject({ status: 'held', holdReason: 'media-changed' });
});

it('correlates an ACK with its reserved source URL and preserves earlier duplicate-skipped outcomes for equivalent links', async () => {
  const input = fixture();
  input.message = { ...message, body: `${message.body} https://m.youtube.com/shorts/AbCdEf123_- https://youtube.com/shorts/Another123_` };
  input.whatsapp.getSourceMessage.mockResolvedValue(input.message);
  const clock = { value: 2_000 };
  input.downloader.resolveYouTube.mockImplementation(async (url: string) => ({
    id: url.split('/').at(-1)!, download: vi.fn(async () => ({ filePath: join(roots.at(-1)!, 'video.mp4'), sizeBytes: 5 })),
  }));
  const previous = { groupId: message.groupId, messageId: 'previous-source', identity: { platform: 'youtube' as const, videoId: 'AbCdEf123_-' } };
  const record = { groupId: message.groupId, senderId: message.senderId, url: 'https://youtube.com/shorts/AbCdEf123_-', urlHash: 'hash', createdAtMs: 1_000 };
  input.store.beginMediaRepost(previous, record, 1);
  input.store.confirmMediaRepost(previous, { messageId: 'old-repost', ack: 1 }, record);
  const settings = input.store.getGroupSettings;
  vi.spyOn(input.store, 'getGroupSettings').mockImplementation((group) => ({ ...settings(group), duplicateWindowHours: 1 }));
  const disposition = input.store.getMediaDisposition;
  vi.spyOn(input.store, 'getMediaDisposition').mockImplementation((key, now, window) => {
    const result = disposition(key, now, window);
    if (result === 'duplicate') clock.value = 3_601_001;
    return result;
  });
  input.whatsapp.sendVideoOnce.mockImplementationOnce(async (_group, _path, _caption, _mode, observe) => {
    observe?.({ messageId: 'new-repost', ack: 0 });
    observeRelayAcknowledgement({ ...input, now: () => clock.value }, message.groupId, { messageId: 'new-repost', ack: 1 });
    return { messageId: 'new-repost', ack: 1 };
  });
  input.whatsapp.sendVideoOnce.mockRejectedValueOnce(new Error('Third request has an unresolved send'));
  await handleIncomingMessage({ ...input, now: () => clock.value });
  expect(input.store.getRelaySource(message.groupId, message.id)?.links.map((link) => link.plan?.items[0].status)).toEqual(['skipped', 'confirmed', 'held']);
  reopen(input);
  await recoverRelaySources({ ...input, now: () => clock.value });
  expect(input.store.countReposts()).toBe(2);
  expect(input.store.getRelaySource(message.groupId, message.id)?.links.map((link) => link.plan?.items[0].status)).toEqual(['skipped', 'confirmed', 'held']);
});
