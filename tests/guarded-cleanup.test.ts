import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { handleIncomingMessage, observeRelayAcknowledgement, recoverRelaySources, type IncomingMessage } from '../src/relay';
import { RelayLifecycle } from '../src/relayLifecycle';
import { createStore, type Store } from '../src/store';
import { formatGroupInspection, formatSourceInspection } from '../src/inspection';

const roots: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores) store.close();
  stores.length = 0;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

it('cleans a newly accepted link-only source once after an inline repost is durably confirmed', async () => {
  const root = mkdtempSync('/tmp/opencode/wpdbot-guarded-cleanup-');
  roots.push(root);
  const store = createStore(join(root, 'bot.sqlite'));
  stores.push(store);
  const groupId = 'group@g.us';
  const message: IncomingMessage = {
    id: 'source-1', groupId, senderId: 'sender@c.us', senderName: 'Sender',
    body: ` \nhttps://youtube.com/shorts/AbCdEf123_-\t`, timestampMs: 1_000, isGroup: true, fromMe: false,
  };
  store.setGroupEnabled(groupId, true);
  const filePath = join(root, 'video.mp4');
  writeFileSync(filePath, 'synthetic video');
  const finalGuardChecks = vi.fn();
  const whatsapp = {
    sendVideo: vi.fn(),
    sendVideoOnce: vi.fn(async () => ({ messageId: 'repost-1', ack: 1 })),
    sendText: vi.fn(async () => undefined),
    deleteMessage: vi.fn(),
    checkSourceForCleanup: vi.fn(async () => 'ready' as const),
    deleteSourceForCleanup: vi.fn(async (_source: unknown, finalCheck: () => boolean) => {
      finalGuardChecks();
      return finalCheck() ? 'returned' as const : 'blocked' as const;
    }),
  };

  await handleIncomingMessage({
    message,
    store,
    whatsapp,
    downloader: {
      download: vi.fn(),
      resolveInstagram: vi.fn(),
      resolveYouTube: vi.fn(async () => ({ id: 'AbCdEf123_-', download: vi.fn(async () => ({ filePath, sizeBytes: 15, deliveryMode: 'video' as const })) })),
    },
    timezone: 'UTC', nowMs: 2_000, cleanupPath: async () => undefined,
  });

  const source = store.getRelaySource(groupId, message.id)!;
  expect(source.version).toBe(2);
  expect(source.cleanup).toMatchObject({ initial: 'link-only', intentRecorded: true, outcome: 'returned-unverified' });
  expect(formatSourceInspection(store, source)).toContain('group-wide removal unverified');
  expect(store.getMediaAttempt({ groupId, messageId: message.id, identity: { platform: 'youtube', videoId: 'AbCdEf123_-' } }))
    .toMatchObject({ status: 'confirmed', sentMessageId: 'repost-1', ack: 1, deliveryMode: 'video' });
  expect(finalGuardChecks).toHaveBeenCalledOnce();
  expect(whatsapp.checkSourceForCleanup).toHaveBeenCalledOnce();
  expect(whatsapp.deleteSourceForCleanup).toHaveBeenCalledOnce();
  expect(whatsapp.sendText).not.toHaveBeenCalled();
});

function cleanupFixture(body = 'https://youtube.com/shorts/AbCdEf123_-') {
  const root = mkdtempSync('/tmp/opencode/wpdbot-guarded-cleanup-');
  roots.push(root);
  const store = createStore(join(root, 'bot.sqlite'));
  stores.push(store);
  const groupId = 'group@g.us';
  const message: IncomingMessage = { id: 'source-1', groupId, senderId: 'sender@c.us', senderName: 'Sender',
    body, timestampMs: 1_000, isGroup: true, fromMe: false };
  store.setGroupEnabled(groupId, true);
  const filePath = join(root, 'video.mp4');
  writeFileSync(filePath, 'synthetic video');
  const now = { value: 2_000 };
  const whatsapp = {
    sendVideo: vi.fn(),
    sendVideoOnce: vi.fn(async (_group?: string, _path?: string, _caption?: string, _mode?: 'document', _observe?: (evidence: { messageId: string; ack: number | null }) => void) => ({ messageId: 'repost-1', ack: 1 })),
    sendText: vi.fn(async () => undefined),
    deleteMessage: vi.fn(),
    checkSourceForCleanup: vi.fn(async () => 'ready' as const),
    deleteSourceForCleanup: vi.fn(async (_source: unknown, finalCheck: () => boolean) => finalCheck() ? 'returned' as const : 'blocked' as const),
    getSourceMessage: vi.fn(async () => message),
    lookupRepost: vi.fn(async () => null),
  };
  const downloader = {
    download: vi.fn(),
    resolveInstagram: vi.fn(async () => ({ id: 'post-1', totalItems: 1, items: [] as Array<{ id: string; index: number; kind: 'video' | 'image' | 'unknown'; download: () => Promise<{ filePath: string; sizeBytes: number }> }> })),
    resolveYouTube: vi.fn(async (url: string) => ({
      id: url.split('/').at(-1)!, download: vi.fn(async () => ({ filePath, sizeBytes: 15, deliveryMode: 'video' as const })),
    })),
  };
  const input = () => ({ message, store, whatsapp, downloader, timezone: 'UTC', now: () => now.value, cleanupPath: async () => undefined });
  const recover = () => recoverRelaySources({ store, whatsapp, downloader, timezone: 'UTC', now: () => now.value,
    cleanupPath: async () => undefined });
  return { root, store, groupId, message, whatsapp, downloader, now, input, recover };
}

it.each(['mixed-content', 'prior-message-duplicate', 'document-repost', 'instagram-photo'] as const)
  ('retains sources disqualified by %s without consuming cleanup intent', async (caseName) => {
    const body = caseName === 'mixed-content' ? 'watch this https://youtube.com/shorts/AbCdEf123_-' :
      caseName === 'instagram-photo' ? 'https://instagram.com/p/Post123/' : 'https://youtube.com/shorts/AbCdEf123_-';
    const fixture = cleanupFixture(body);
    if (caseName === 'document-repost') {
      fixture.downloader.resolveYouTube.mockImplementationOnce(async (url) => ({
        id: url.split('/').at(-1)!, download: vi.fn(async () => ({ filePath: join(fixture.root, 'video.mp4'), sizeBytes: 15, deliveryMode: 'document' as const })),
      }));
    }
    if (caseName === 'prior-message-duplicate') {
      const key = { groupId: fixture.groupId, messageId: 'prior-source', identity: { platform: 'youtube' as const, videoId: 'AbCdEf123_-' } };
      const record = { groupId: fixture.groupId, senderId: 'prior-sender', url: 'https://youtube.com/shorts/AbCdEf123_-', urlHash: 'prior-url', createdAtMs: 1_000 };
      fixture.store.beginMediaRepost(key, record, 24, undefined, 'video');
      fixture.store.confirmMediaRepost(key, { messageId: 'prior-repost', ack: 1 }, record);
    }
    if (caseName === 'instagram-photo') {
      fixture.downloader.resolveInstagram.mockResolvedValueOnce({ id: 'Post123', totalItems: 2, items: [
        { id: 'video-1', index: 1, kind: 'video', download: async () => ({ filePath: join(fixture.root, 'video.mp4'), sizeBytes: 15, deliveryMode: 'video' as const }) },
        { id: 'photo-2', index: 2, kind: 'image', download: async () => ({ filePath: '', sizeBytes: 0 }) },
      ] });
    }

    await handleIncomingMessage(fixture.input());

    const saved = fixture.store.getRelaySource(fixture.groupId, fixture.message.id)!;
    expect(saved.version).toBe(2);
    if (saved.version === 2) {
      if (caseName === 'mixed-content') expect(saved.cleanup.initial).toBe('mixed-content');
      if (caseName === 'prior-message-duplicate') expect(saved.cleanup.disqualifications).toContain('prior-message-duplicate');
      if (caseName === 'document-repost') expect(saved.cleanup.disqualifications).toContain('document-repost');
      if (caseName === 'instagram-photo') expect(saved.cleanup.disqualifications).toContain('skipped-media');
      expect(saved.cleanup.intentRecorded).toBe(false);
    }
    expect(fixture.whatsapp.deleteSourceForCleanup).not.toHaveBeenCalled();
  });

it.each(['disabled', 'lookup-unavailable', 'authority-unavailable'] as const)
  ('reevaluates temporary %s cleanup blockers only on a later recovery event', async (blocker) => {
    const fixture = cleanupFixture();
    if (blocker === 'disabled') fixture.whatsapp.sendVideoOnce.mockImplementationOnce(async () => {
      fixture.store.setGroupEnabled(fixture.groupId, false);
      return { messageId: 'repost-1', ack: 1 };
    });
    else fixture.whatsapp.checkSourceForCleanup.mockResolvedValueOnce(blocker === 'authority-unavailable' ? 'authority-unavailable' : 'unavailable');

    await handleIncomingMessage(fixture.input());

    const before = fixture.store.getRelaySource(fixture.groupId, fixture.message.id)!;
    expect(before.version).toBe(2);
    if (before.version === 2) expect(before.cleanup).toMatchObject({ intentRecorded: false,
      deferredReason: blocker === 'disabled' ? 'group-disabled' : blocker === 'lookup-unavailable' ? 'source-unavailable' : 'authority-unavailable' });
    expect(formatSourceInspection(fixture.store, before)).toContain('cleanup deferred');
    expect(formatGroupInspection(fixture.store, fixture.groupId)).toContain('cleanup deferred');
    expect(fixture.whatsapp.deleteSourceForCleanup).not.toHaveBeenCalled();
    fixture.store.setGroupEnabled(fixture.groupId, true);
    await fixture.recover();
    expect(fixture.whatsapp.deleteSourceForCleanup).toHaveBeenCalledOnce();
    expect(fixture.store.getRelaySource(fixture.groupId, fixture.message.id)?.cleanup).toMatchObject({ intentRecorded: true, outcome: 'returned-unverified' });
    expect(formatSourceInspection(fixture.store, fixture.store.getRelaySource(fixture.groupId, fixture.message.id)!)).not.toContain('cleanup deferred');
  });

it.each(['returned', 'threw'] as const)('does not emit incomplete-media feedback after multi-link recovery cleanup %s', async (outcome) => {
  const fixture = cleanupFixture('https://youtube.com/shorts/AbCdEf123_- https://youtube.com/shorts/Another123_');
  fixture.whatsapp.sendVideoOnce.mockImplementationOnce(async () => {
    fixture.store.setGroupEnabled(fixture.groupId, false);
    return { messageId: 'repost-a', ack: 1 };
  }).mockResolvedValueOnce({ messageId: 'repost-b', ack: 1 });
  await handleIncomingMessage(fixture.input());
  await fixture.recover();
  expect(fixture.store.getRelaySource(fixture.groupId, fixture.message.id)).toMatchObject({
    status: 'paused', cleanup: { intentRecorded: false },
  });
  fixture.whatsapp.sendText.mockClear();
  if (outcome === 'threw') fixture.whatsapp.deleteSourceForCleanup.mockRejectedValueOnce(new Error('private deletion uncertainty'));
  fixture.store.setGroupEnabled(fixture.groupId, true);
  await fixture.recover();
  expect(fixture.whatsapp.sendVideoOnce).toHaveBeenCalledTimes(2);
  expect(fixture.whatsapp.deleteSourceForCleanup).toHaveBeenCalledOnce();
  expect(fixture.whatsapp.sendText).toHaveBeenCalledTimes(outcome === 'returned' ? 0 : 1);
  const saved = fixture.store.getRelaySource(fixture.groupId, fixture.message.id)!;
  expect(saved.cleanup).toMatchObject({ intentRecorded: true, outcome: outcome === 'returned' ? 'returned-unverified' : 'threw' });
  expect(formatSourceInspection(fixture.store, saved)).not.toContain('cleanup deferred');
  if (outcome === 'threw') expect(fixture.whatsapp.sendText).toHaveBeenCalledWith(fixture.groupId, expect.stringContaining('could not be confirmed'));
  await fixture.recover();
  expect(fixture.whatsapp.sendVideoOnce).toHaveBeenCalledTimes(2);
  expect(fixture.whatsapp.deleteSourceForCleanup).toHaveBeenCalledOnce();
  expect(fixture.whatsapp.sendText).toHaveBeenCalledTimes(outcome === 'returned' ? 0 : 1);
});

it('permanently disqualifies an observed source edit, even after the source later matches again', async () => {
  const fixture = cleanupFixture();
  fixture.whatsapp.checkSourceForCleanup.mockResolvedValueOnce('mismatch');
  await handleIncomingMessage(fixture.input());
  const edited = fixture.store.getRelaySource(fixture.groupId, fixture.message.id)!;
  expect(edited.version).toBe(2);
  if (edited.version === 2) expect(edited.cleanup.disqualifications).toContain('source-edited');

  fixture.whatsapp.checkSourceForCleanup.mockResolvedValue('ready');
  await fixture.recover();
  expect(fixture.whatsapp.deleteSourceForCleanup).not.toHaveBeenCalled();
});

it('late positive evidence completes a partial source and allows cleanup without resending confirmed media', async () => {
  const body = 'https://youtube.com/shorts/AbCdEf123_- https://youtube.com/shorts/Another123_';
  const fixture = cleanupFixture(body);
  fixture.whatsapp.getSourceMessage.mockResolvedValue(fixture.message);
  fixture.downloader.resolveYouTube.mockImplementation(async (url) => ({
    id: url.split('/').at(-1)!, download: vi.fn(async () => ({ filePath: join(fixture.root, 'video.mp4'), sizeBytes: 15, deliveryMode: 'video' as const })),
  }));
  fixture.whatsapp.sendVideoOnce.mockImplementationOnce(async () => ({ messageId: 'repost-a', ack: 1 }))
    .mockImplementationOnce(async (_group, _path, _caption, _mode, observe) => {
      observe?.({ messageId: 'repost-b', ack: 0 });
      throw new Error('synthetic acknowledgement timeout');
    });

  await handleIncomingMessage(fixture.input());
  expect(fixture.whatsapp.deleteSourceForCleanup).not.toHaveBeenCalled();
  const { message: _message, ...ackInput } = fixture.input();
  observeRelayAcknowledgement(ackInput, fixture.groupId, { messageId: 'repost-b', ack: 1 });
  await fixture.recover();

  expect(fixture.whatsapp.sendVideoOnce).toHaveBeenCalledTimes(2);
  expect(fixture.whatsapp.deleteSourceForCleanup).toHaveBeenCalledOnce();
  expect(fixture.store.getRelaySource(fixture.groupId, fixture.message.id)?.cleanup).toMatchObject({ intentRecorded: true, outcome: 'returned-unverified' });
});

it('consumes the deletion allowance when the final enabled-state check fails', async () => {
  const fixture = cleanupFixture();
  fixture.whatsapp.deleteSourceForCleanup.mockImplementationOnce(async (_source, finalCheck) => {
    fixture.store.setGroupEnabled(fixture.groupId, false);
    return finalCheck() ? 'returned' : 'blocked';
  });

  await handleIncomingMessage(fixture.input());

  expect(fixture.whatsapp.deleteSourceForCleanup).toHaveBeenCalledOnce();
  expect(fixture.store.getRelaySource(fixture.groupId, fixture.message.id)?.cleanup).toMatchObject({
    intentRecorded: true, outcome: 'not-invoked', noticeClaimed: false,
  });
  fixture.store.setGroupEnabled(fixture.groupId, true);
  await fixture.recover();
  expect(fixture.whatsapp.deleteSourceForCleanup).toHaveBeenCalledOnce();
});

it('records not-invoked when shutdown begins before the final cleanup invocation', async () => {
  const fixture = cleanupFixture();
  const control = new RelayLifecycle();
  let shutdown: Promise<void> | undefined;
  fixture.whatsapp.deleteSourceForCleanup.mockImplementationOnce(async (_source, finalCheck) => {
    shutdown = control.stop(0);
    return finalCheck() ? 'returned' : 'blocked';
  });

  await handleIncomingMessage({ ...fixture.input(), control });
  await shutdown;

  expect(fixture.whatsapp.deleteSourceForCleanup).toHaveBeenCalledOnce();
  expect(fixture.store.getRelaySource(fixture.groupId, fixture.message.id)?.cleanup).toMatchObject({
    intentRecorded: true, outcome: 'not-invoked', noticeClaimed: false,
  });
  await fixture.recover();
  expect(fixture.whatsapp.deleteSourceForCleanup).toHaveBeenCalledOnce();
});

it('fails storage closed when final cleanup eligibility evidence cannot be read', async () => {
  const fixture = cleanupFixture();
  const control = new RelayLifecycle();
  const originalGetGroupSettings = fixture.store.getGroupSettings;
  fixture.whatsapp.deleteSourceForCleanup.mockImplementationOnce(async (_source, finalCheck) => {
    fixture.store.getGroupSettings = ((groupId: string) => {
      fixture.store.getGroupSettings = originalGetGroupSettings;
      throw new Error(`private storage failure for ${groupId}`);
    }) as typeof fixture.store.getGroupSettings;
    return finalCheck() ? 'returned' : 'blocked';
  });

  await handleIncomingMessage({ ...fixture.input(), control });

  expect(control.canSubmit()).toBe(false);
  expect(fixture.store.getGroupSettings).toBe(originalGetGroupSettings);
  expect(fixture.store.getRelaySource(fixture.groupId, fixture.message.id)?.cleanup).toMatchObject({
    intentRecorded: true, outcome: 'not-invoked', noticeClaimed: false,
  });
  expect(fixture.whatsapp.sendText).not.toHaveBeenCalled();
  expect(fixture.whatsapp.deleteSourceForCleanup).toHaveBeenCalledOnce();
});

it('records a thrown deletion as uncertain, sends at most one safe notice, and never retries', async () => {
  const fixture = cleanupFixture();
  fixture.whatsapp.deleteSourceForCleanup.mockRejectedValueOnce(new Error('PRIVATE source and group identifiers'));

  await handleIncomingMessage(fixture.input());
  const source = fixture.store.getRelaySource(fixture.groupId, fixture.message.id)!;
  expect(source.version).toBe(2);
  if (source.version === 2) expect(source.cleanup).toMatchObject({ intentRecorded: true, outcome: 'threw', noticeClaimed: true });
  expect(fixture.whatsapp.sendText).toHaveBeenCalledOnce();
  expect(fixture.whatsapp.sendText).toHaveBeenCalledWith(fixture.groupId, expect.stringContaining('source may still be visible'));
  expect(fixture.whatsapp.sendText.mock.calls[0][1]).not.toContain(fixture.message.id);

  const inspection = formatSourceInspection(fixture.store, source);
  expect(inspection).toContain('remote outcome uncertain — no further attempt');
  expect(inspection).not.toContain(fixture.message.id);
  expect(formatGroupInspection(fixture.store, fixture.groupId)).toContain('remote outcome uncertain — no further attempt');
  await fixture.recover();
  await fixture.recover();
  expect(fixture.whatsapp.deleteSourceForCleanup).toHaveBeenCalledOnce();
  expect(fixture.whatsapp.sendText).toHaveBeenCalledOnce();
});

it('does not delete if durable intent cannot be saved, and may reevaluate after storage recovers', async () => {
  const fixture = cleanupFixture();
  const raw = new Database(join(fixture.root, 'bot.sqlite'));
  fixture.whatsapp.checkSourceForCleanup.mockImplementationOnce(async () => {
    raw.exec(`CREATE TRIGGER reject_cleanup_intent BEFORE UPDATE ON relay_sources
      WHEN json_extract(NEW.state_json, '$.cleanup.intentRecorded') = 1
      BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END`);
    return 'ready';
  });

  try {
    await handleIncomingMessage(fixture.input());
    expect(fixture.whatsapp.deleteSourceForCleanup).not.toHaveBeenCalled();
    expect(fixture.store.getRelaySource(fixture.groupId, fixture.message.id)?.cleanup).toMatchObject({ intentRecorded: false,
      deferredReason: 'storage-unavailable' });
    raw.exec('DROP TRIGGER reject_cleanup_intent');
    await fixture.recover();
    expect(fixture.whatsapp.deleteSourceForCleanup).toHaveBeenCalledOnce();
  } finally { raw.close(); }
});

it('preserves the last-observed cleanup deferral across an unrelated stale source save', async () => {
  const fixture = cleanupFixture();
  fixture.whatsapp.checkSourceForCleanup.mockResolvedValueOnce('authority-unavailable');
  await handleIncomingMessage(fixture.input());
  const stale = fixture.store.getRelaySource(fixture.groupId, fixture.message.id)!;
  if (stale.version !== 2) throw new Error('Expected prospective cleanup state');
  delete stale.cleanup.deferredReason;
  fixture.store.saveRelaySource(stale);
  expect(fixture.store.getRelaySource(fixture.groupId, fixture.message.id)?.cleanup).toMatchObject({
    intentRecorded: false, deferredReason: 'authority-unavailable',
  });
});

it('requires atomic cleanup APIs instead of allowing generic source saves to forge intent or outcome', async () => {
  const fixture = cleanupFixture();
  fixture.whatsapp.checkSourceForCleanup.mockResolvedValueOnce('unavailable');
  await handleIncomingMessage(fixture.input());
  const beforeIntent = fixture.store.getRelaySource(fixture.groupId, fixture.message.id)!;
  expect(beforeIntent.version).toBe(2);
  if (beforeIntent.version !== 2) return;
  expect(beforeIntent.cleanup.intentRecorded).toBe(false);

  const forgedIntent = structuredClone(beforeIntent);
  forgedIntent.cleanup.intentRecorded = true;
  forgedIntent.cleanup.outcome = 'unknown';
  expect(() => fixture.store.saveRelaySource(forgedIntent)).toThrow();
  expect(fixture.store.getRelaySource(fixture.groupId, fixture.message.id)?.cleanup).toMatchObject({
    intentRecorded: false, outcome: 'not-attempted',
  });

  expect(fixture.store.beginRelaySourceCleanup(beforeIntent)).toBe(true);
  const afterIntent = fixture.store.getRelaySource(fixture.groupId, fixture.message.id)!;
  expect(afterIntent.version).toBe(2);
  if (afterIntent.version !== 2) return;
  const forgedOutcome = structuredClone(afterIntent);
  forgedOutcome.cleanup.outcome = 'returned-unverified';
  expect(() => fixture.store.saveRelaySource(forgedOutcome)).toThrow();
  expect(fixture.store.getRelaySource(fixture.groupId, fixture.message.id)?.cleanup).toMatchObject({
    intentRecorded: true, outcome: 'unknown',
  });
});

it('never retries after a deletion result cannot be persisted', async () => {
  const fixture = cleanupFixture();
  const raw = new Database(join(fixture.root, 'bot.sqlite'));
  fixture.whatsapp.deleteSourceForCleanup.mockImplementationOnce(async (_source, finalCheck) => {
    expect(finalCheck()).toBe(true);
    raw.exec(`CREATE TRIGGER reject_cleanup_outcome BEFORE UPDATE ON relay_sources
      WHEN json_extract(NEW.state_json, '$.cleanup.outcome') = 'returned-unverified'
      BEGIN SELECT RAISE(ABORT, 'synthetic outcome storage failure'); END`);
    return 'returned';
  });

  try {
    await handleIncomingMessage(fixture.input());
    expect(fixture.store.getRelaySource(fixture.groupId, fixture.message.id)?.cleanup).toMatchObject({
      intentRecorded: true, outcome: 'unknown',
    });
    expect(fixture.whatsapp.sendText).not.toHaveBeenCalled();
    raw.exec('DROP TRIGGER reject_cleanup_outcome');
    await fixture.recover();
    expect(fixture.whatsapp.deleteSourceForCleanup).toHaveBeenCalledOnce();
    expect(fixture.store.getRelaySource(fixture.groupId, fixture.message.id)?.cleanup).toMatchObject({ outcome: 'unknown' });
  } finally { raw.close(); }
});

it.each([24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000 + 1])('enforces the cleanup age boundary at %s ms, without a later clock rollback bypass', async (age) => {
  const fixture = cleanupFixture();
  fixture.whatsapp.sendVideoOnce.mockImplementationOnce(async () => {
    fixture.now.value = 2_000 + age;
    return { messageId: 'repost-1', ack: 1 };
  });

  await handleIncomingMessage(fixture.input());

  expect(fixture.whatsapp.deleteSourceForCleanup).toHaveBeenCalledTimes(age === 24 * 60 * 60 * 1000 ? 1 : 0);
  const source = fixture.store.getRelaySource(fixture.groupId, fixture.message.id)!;
  if (age > 24 * 60 * 60 * 1000 && source.version === 2) expect(source.cleanup.disqualifications).toContain('expired');
  fixture.now.value = 2_000 + 24 * 60 * 60 * 1000;
  await fixture.recover();
  expect(fixture.whatsapp.deleteSourceForCleanup).toHaveBeenCalledTimes(age === 24 * 60 * 60 * 1000 ? 1 : 0);
});
