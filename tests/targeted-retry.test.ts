import { expect, it } from 'vitest';
import { RetryPreviewRegistry } from '../src/targetedRetry';
import { createStore } from '../src/store';
import { relayContentHash } from '../src/relay';
import type { RelaySource } from '../src/relayState';

it('reuses a live preview without extending it and keeps other admins separate', () => {
  let nextId = 0;
  const previews = new RetryPreviewRegistry(() => `preview-${++nextId}`);
  const base = { groupId: 'group', messageId: 'source', requesterId: 'admin-a', settingsRevision: 0, requestMessageAtMs: 1,
    sourceBefore: {} as never, sourceAfter: {} as never, targets: [{ linkIndex: 0, itemIndexes: [1] }] };

  const first = previews.issue(base, 10_000);
  const repeated = previews.issue(base, 60_000);
  const otherAdmin = previews.issue({ ...base, requesterId: 'admin-b' }, 60_000);

  expect(first.reused).toBe(false);
  expect(repeated.reused).toBe(true);
  expect(repeated.preview).toEqual(first.preview);
  expect(otherAdmin.reused).toBe(false);
  expect(otherAdmin.preview.expiresAtMs).toBe(360_000);
});

it("consumes only the exact requester's source preview once and invalidates previews on group disable", () => {
  const previews = new RetryPreviewRegistry(() => 'preview');
  const source = { groupId: 'group', messageId: 'source', requesterId: 'admin', settingsRevision: 2, requestMessageAtMs: 1,
    sourceBefore: {} as never, sourceAfter: {} as never, targets: [{ linkIndex: 0, itemIndexes: [1] }] };
  previews.issue(source, 100);

  expect(previews.consume('group', 'source', 'other-admin')).toBeNull();
  expect(previews.consume('other-group', 'source', 'admin')).toBeNull();
  expect(previews.consume('group', 'source', 'admin')?.id).toBe('preview');
  expect(previews.consume('group', 'source', 'admin')).toBeNull();

  previews.issue({ ...source, messageId: 'another-source' }, 100);
  previews.invalidateGroup('group');
  expect(previews.consume('group', 'another-source', 'admin')).toBeNull();
});

it('expires previews at five minutes and invalidates competing admins for an admitted source', () => {
  let nextId = 0;
  const previews = new RetryPreviewRegistry(() => `preview-${++nextId}`);
  const base = { groupId: 'group', messageId: 'source', requesterId: 'admin-a', settingsRevision: 0, requestMessageAtMs: 1,
    sourceBefore: {} as never, sourceAfter: {} as never, targets: [{ linkIndex: 0, itemIndexes: [1] }] };
  const first = previews.issue(base, 1_000);
  expect(previews.issue(base, first.preview.expiresAtMs).preview.id).not.toBe(first.preview.id);
  previews.issue({ ...base, requesterId: 'admin-b' }, 1_000);

  previews.invalidateSource('group', 'source');

  expect(previews.consume('group', 'source', 'admin-a')).toBeNull();
  expect(previews.consume('group', 'source', 'admin-b')).toBeNull();
});

it.each(['source', 'group'] as const)('invalidates consumed previews still undergoing validation on %s changes', (scope) => {
  const registry = new RetryPreviewRegistry();
  registry.issue({ groupId: 'group', messageId: 'source', requesterId: 'admin', settingsRevision: 0, requestMessageAtMs: 1,
    sourceBefore: {} as never, sourceAfter: {} as never, targets: [{ linkIndex: 0, itemIndexes: [1] }] }, 1_000);
  const validating = registry.consume('group', 'source', 'admin')!;
  expect(registry.isValid(validating)).toBe(true);
  if (scope === 'source') registry.invalidateSource('group', 'source');
  else registry.invalidateGroup('group');
  expect(registry.isValid(validating)).toBe(false);
});

it('prepares only definitely pre-intent failures and preserves confirmed and delivery-unknown outcomes', async () => {
  const store = createStore(':memory:');
  const groupId = 'group@g.us';
  const body = [
    'https://youtube.com/shorts/AbCdEf123_-',
    'https://youtube.com/shorts/Another123_',
    'https://youtube.com/shorts/Third123456',
  ].join(' ');
  const source: RelaySource = {
    version: 1, groupId, messageId: 'source', senderId: 'sender@c.us', senderName: 'Sender', timestampMs: 100,
    acceptedAtMs: 200, contentHash: relayContentHash(body), status: 'held', holdReason: 'retry-unresolved-send', cleanup: 'retained',
    links: ['AbCdEf123_-', 'Another123_', 'Third123456'].map((id, index) => ({
      url: body.split(' ')[index], platform: 'youtube' as const, urlHash: `hash-${index}`, status: index === 0 ? 'ready' as const : 'failed' as const,
      plan: { parentId: id, totalItems: 1, items: [{ index: 1, kind: 'video' as const, identity: { platform: 'youtube' as const, videoId: id },
        status: index === 0 ? 'confirmed' as const : 'failed' as const }] },
    })),
  };
  try {
    store.setGroupEnabled(groupId, true);
    store.acceptRelaySource(source);
    store.beginMediaRepost({ groupId, messageId: source.messageId, identity: { platform: 'youtube', videoId: 'Third123456' } },
      { groupId, senderId: source.senderId, url: source.links[2].url, urlHash: source.links[2].urlHash, createdAtMs: 300 }, 24);
    const downloader = { resolveYouTube: async (url: string) => ({ id: url.split('/').at(-1)!, download: async () => ({ filePath: '', sizeBytes: 1 }) }),
      resolveInstagram: async () => { throw new Error('not used'); } };

    const prepared = await import('../src/targetedRetry').then(({ prepareRetryWork }) => prepareRetryWork(
      store.getRelaySource(groupId, source.messageId)!, store, downloader, store.getGroupSettings(groupId), 400));

    expect(prepared.targets).toEqual([{ linkIndex: 1, itemIndexes: [1] }]);
    expect(prepared.sourceAfter.links.map((link) => link.plan?.items[0].status)).toEqual(['confirmed', 'ready', 'held']);
  } finally { store.close(); }
});

it('rejects a changed saved media identity instead of substituting the newly discovered item', async () => {
  const store = createStore(':memory:');
  const url = 'https://youtube.com/shorts/AbCdEf123_-';
  const source: RelaySource = { version: 1, groupId: 'group', messageId: 'source', senderId: 'sender', senderName: 'Sender',
    timestampMs: 100, acceptedAtMs: 200, contentHash: relayContentHash(url), status: 'settled', cleanup: 'retained',
    links: [{ url, platform: 'youtube', urlHash: 'hash', status: 'failed', plan: { parentId: 'AbCdEf123_-', totalItems: 1,
      items: [{ index: 1, kind: 'video', identity: { platform: 'youtube', videoId: 'AbCdEf123_-' }, status: 'failed' }] } }] };
  try {
    store.setGroupEnabled('group', true);
    store.acceptRelaySource(source);
    const downloader = { resolveYouTube: async () => ({ id: 'Another123_', download: async () => ({ filePath: '', sizeBytes: 1 }) }),
      resolveInstagram: async () => { throw new Error('not used'); } };
    const { prepareRetryWork } = await import('../src/targetedRetry');
    await expect(prepareRetryWork(store.getRelaySource('group', 'source')!, store, downloader, store.getGroupSettings('group'), 300))
      .rejects.toMatchObject({ reason: 'source-changed' });
  } finally { store.close(); }
});

it('does not retry failed items inside a source link that was terminally skipped', async () => {
  const store = createStore(':memory:');
  const url = 'https://youtube.com/shorts/AbCdEf123_-';
  const source: RelaySource = { version: 1, groupId: 'group', messageId: 'source', senderId: 'sender', senderName: 'Sender',
    timestampMs: 100, acceptedAtMs: 200, contentHash: relayContentHash(url), status: 'settled', cleanup: 'retained',
    links: [{ url, platform: 'youtube', urlHash: 'hash', status: 'skipped', plan: { parentId: 'AbCdEf123_-', totalItems: 1,
      items: [{ index: 1, kind: 'video', identity: { platform: 'youtube', videoId: 'AbCdEf123_-' }, status: 'failed' }] } }] };
  try {
    store.setGroupEnabled('group', true);
    store.acceptRelaySource(source);
    const downloader = { resolveYouTube: async () => ({ id: 'AbCdEf123_-', download: async () => ({ filePath: '', sizeBytes: 1 }) }),
      resolveInstagram: async () => { throw new Error('not used'); } };
    const { prepareRetryWork } = await import('../src/targetedRetry');
    await expect(prepareRetryWork(store.getRelaySource('group', 'source')!, store, downloader, store.getGroupSettings('group'), 300))
      .rejects.toMatchObject({ reason: 'not-eligible' });
  } finally { store.close(); }
});
