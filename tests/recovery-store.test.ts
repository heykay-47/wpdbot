import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { createStore, type Store } from '../src/store';
import type { RelaySource } from '../src/relayState';

const roots: string[] = [];
const stores: Store[] = [];
export const source: RelaySource = {
  version: 1, groupId: 'group@g.us', messageId: 'source-1', senderId: 'sender@c.us', senderName: 'Sender',
  timestampMs: 1_000, acceptedAtMs: 2_000, contentHash: 'a'.repeat(64), status: 'ready', cleanup: 'retained',
  links: [{ url: 'https://youtube.com/shorts/AbCdEf123_-', platform: 'youtube', urlHash: 'url-hash', status: 'ready', plan: null }],
};

afterEach(() => {
  for (const store of stores) store.close();
  stores.length = 0;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

it('durably accepts ordered work once without resetting acceptance time or completed outcomes on repeated intake', () => {
  const root = mkdtempSync(join(tmpdir(), 'wpdbot-recovery-store-'));
  roots.push(root);
  const path = join(root, 'bot.sqlite');
  const first = createStore(path);
  first.acceptRelaySource(source);
  const saved = first.getRelaySource(source.groupId, source.messageId)!;
  saved.links[0].status = 'skipped';
  first.saveRelaySource(saved);
  first.close();

  const store = createStore(path);
  stores.push(store);
  store.acceptRelaySource({ ...source, acceptedAtMs: 99_000 });
  expect(store.listRelaySources()).toEqual([{ ...source, workReference: saved.workReference, links: [{ ...source.links[0], status: 'skipped' }] }]);
  expect(store.getRelaySource('other-group', source.messageId)).toBeNull();
  expect(store.countReposts()).toBe(0);
});

it('persists a pending repost ID without claiming acceptance or releasing its hold', () => {
  const store = createStore(':memory:');
  stores.push(store);
  const key = { groupId: source.groupId, messageId: source.messageId, identity: { platform: 'youtube' as const, videoId: 'AbCdEf123_-' } };
  store.beginMediaRepost(key, { groupId: source.groupId, senderId: source.senderId, url: source.links[0].url, urlHash: 'hash', createdAtMs: 2_000 }, 24);
  store.recordMediaEvidence(key, { messageId: 'pending-repost', ack: 0 });
  expect(store.getMediaAttempt(key)).toMatchObject({ status: 'sending', sentMessageId: 'pending-repost', ack: 0 });
  expect(store.getMediaDisposition({ ...key, messageId: 'source-2' }, 999_999_999, 0)).toBe('held');
  expect(() => store.recordMediaEvidence(key, { messageId: 'different-repost', ack: 1 })).toThrow();
  expect(store.countReposts()).toBe(0);
});

it('revokes an unused explicit retry pass on restart without making its work automatically resumable', () => {
  const root = mkdtempSync(join(tmpdir(), 'wpdbot-retry-restart-'));
  roots.push(root);
  const path = join(root, 'retry.sqlite');
  const original: RelaySource = { ...source, status: 'settled', links: [{ ...source.links[0], status: 'failed', plan: {
    parentId: 'AbCdEf123_-', totalItems: 1, items: [{ index: 1, kind: 'video', identity: { platform: 'youtube', videoId: 'AbCdEf123_-' }, status: 'failed' }],
  } }] };
  let store = createStore(path);
  store.setGroupEnabled(original.groupId, true);
  store.acceptRelaySource(original);
  const before = store.getRelaySource(original.groupId, original.messageId)!;
  const after = structuredClone(before);
  after.status = 'ready';
  after.links[0].status = 'ready';
  after.links[0].plan!.items[0].status = 'ready';
  expect(store.admitRetryPass({ id: 'pass-unused', groupId: original.groupId, messageId: original.messageId,
    settingsRevision: store.getGroupSettingsRevision(original.groupId), createdAtMs: 3_000, targets: [{ linkIndex: 0, itemIndexes: [1] }],
    sourceBefore: before, sourceAfter: after })).toBe('admitted');
  expect(store.isRetryPassActive('pass-unused')).toBe(true);
  store.close();

  store = createStore(path);
  stores.push(store);
  expect(store.isRetryPassActive('pass-unused')).toBe(false);
  expect(store.getRelaySource(original.groupId, original.messageId)).toMatchObject({ status: 'settled', links: [{ status: 'ready', plan: { items: [{ status: 'failed' }] } }] });
});

it('preserves delivery ambiguity and revokes remaining retry work after restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'wpdbot-retry-unknown-'));
  roots.push(root);
  const path = join(root, 'retry.sqlite');
  const original: RelaySource = { ...source, status: 'settled', links: [{ ...source.links[0], status: 'failed', plan: {
    parentId: 'AbCdEf123_-', totalItems: 1, items: [{ index: 1, kind: 'video', identity: { platform: 'youtube', videoId: 'AbCdEf123_-' }, status: 'failed' }],
  } }] };
  let store = createStore(path);
  store.setGroupEnabled(original.groupId, true);
  store.acceptRelaySource(original);
  const before = store.getRelaySource(original.groupId, original.messageId)!;
  const after = structuredClone(before);
  after.status = 'ready';
  after.links[0].status = 'ready';
  after.links[0].plan!.items[0].status = 'ready';
  const revision = store.getGroupSettingsRevision(original.groupId);
  expect(store.admitRetryPass({ id: 'pass-unknown', groupId: original.groupId, messageId: original.messageId,
    settingsRevision: revision, createdAtMs: 3_000, targets: [{ linkIndex: 0, itemIndexes: [1] }], sourceBefore: before, sourceAfter: after })).toBe('admitted');
  expect(store.beginMediaRepost({ groupId: original.groupId, messageId: original.messageId, identity: { platform: 'youtube', videoId: 'AbCdEf123_-' } },
    { groupId: original.groupId, senderId: original.senderId, url: original.links[0].url, urlHash: original.links[0].urlHash, createdAtMs: 3_001 }, 24,
    { retryPassId: 'pass-unknown', settingsRevision: revision })).toBe('started');
  store.close();

  store = createStore(path);
  stores.push(store);
  expect(store.getRelaySource(original.groupId, original.messageId)).toMatchObject({ status: 'held', holdReason: 'retry-interrupted-with-unknown-send', links: [{ plan: { items: [{ status: 'held' }] } }] });
  expect(store.isRetryPassActive('pass-unknown')).toBe(false);
  expect(store.getMediaDisposition({ groupId: original.groupId, messageId: 'later', identity: { platform: 'youtube', videoId: 'AbCdEf123_-' } }, 99_999, 0)).toBe('held');
});

it.each(['settings-change', 'disable'] as const)('atomically revokes an unused retry pass on %s', (change) => {
  const store = createStore(':memory:');
  const original: RelaySource = { ...source, status: 'settled', links: [{ ...source.links[0], status: 'failed', plan: {
    parentId: 'AbCdEf123_-', totalItems: 1, items: [{ index: 1, kind: 'video', identity: { platform: 'youtube', videoId: 'AbCdEf123_-' }, status: 'failed' }],
  } }] };
  try {
    store.setGroupEnabled(original.groupId, true);
    store.acceptRelaySource(original);
    const before = store.getRelaySource(original.groupId, original.messageId)!;
    const after = structuredClone(before);
    after.status = 'ready';
    after.links[0].status = 'ready';
    after.links[0].plan!.items[0].status = 'ready';
    const passId = `pass-${change}`;
    const revision = store.getGroupSettingsRevision(original.groupId);
    expect(store.admitRetryPass({ id: passId, groupId: original.groupId, messageId: original.messageId,
      settingsRevision: revision, createdAtMs: 3_000, targets: [{ linkIndex: 0, itemIndexes: [1] }], sourceBefore: before, sourceAfter: after })).toBe('admitted');

    if (change === 'settings-change') store.setGroupSettings(original.groupId, { duplicateWindowHours: 0 });
    else store.setGroupEnabled(original.groupId, false);

    expect(store.isRetryPassActive(passId)).toBe(false);
    expect(store.getRelaySource(original.groupId, original.messageId)).toMatchObject({ status: 'settled', links: [{ plan: { items: [{ status: 'failed' }] } }] });
    expect(store.getMediaAttempt({ groupId: original.groupId, messageId: original.messageId, identity: { platform: 'youtube', videoId: 'AbCdEf123_-' } })).toBeNull();
  } finally { store.close(); }
});

it('persists consumed confirmation message IDs so redelivery cannot bind to a later preview', () => {
  const root = mkdtempSync(join(tmpdir(), 'wpdbot-retry-confirmation-'));
  roots.push(root);
  const path = join(root, 'retry.sqlite');
  let store = createStore(path);
  expect(store.claimRetryConfirmation('confirmation-id')).toBe(true);
  expect(store.claimRetryConfirmation('confirmation-id')).toBe(false);
  store.close();

  store = createStore(path);
  stores.push(store);
  expect(store.claimRetryConfirmation('confirmation-id')).toBe(false);
  expect(store.claimRetryConfirmation('fresh-confirmation-id')).toBe(true);
});

it.each(['saved-reference', 'terminal-skip', 'storage-failure'] as const)('protects retry admission/revocation for %s', (scenario) => {
  const root = mkdtempSync(join(tmpdir(), 'wpdbot-retry-revocation-'));
  roots.push(root);
  const path = join(root, 'retry.sqlite');
  const store = createStore(path);
  stores.push(store);
  store.setGroupEnabled(source.groupId, true);
  store.acceptRelaySource({ ...source, status: 'settled', links: [{ ...source.links[0], status: 'failed', plan: {
    parentId: 'AbCdEf123_-', totalItems: 1,
    items: [{ index: 1, kind: 'video', identity: { platform: 'youtube', videoId: 'AbCdEf123_-' }, status: 'failed' }],
  } }] });
  const before = store.getRelaySource(source.groupId, source.messageId)!;
  const raw = new Database(path);
  try {
    if (scenario === 'saved-reference') {
      // Stage 1 saved this redundant field in snapshots; do not rewrite historical data to admit it.
      raw.prepare('UPDATE relay_sources SET state_json = ?').run(JSON.stringify(before));
    }
    const after = structuredClone(before);
    after.status = 'ready';
    after.links[0].status = 'ready';
    after.links[0].plan!.items[0].status = 'ready';
    expect(store.admitRetryPass({ id: 'pass', groupId: source.groupId, messageId: source.messageId,
      settingsRevision: store.getGroupSettingsRevision(source.groupId), createdAtMs: 3_000,
      targets: [{ linkIndex: 0, itemIndexes: [1] }], sourceBefore: before, sourceAfter: after })).toBe('admitted');
    if (scenario === 'terminal-skip') {
      const current = store.getRelaySource(source.groupId, source.messageId)!;
      current.links[0].plan!.items[0].status = 'skipped';
      store.saveRelaySource(current);
      store.setGroupSettings(source.groupId, { duplicateWindowHours: 0 });
      expect(store.getRelaySource(source.groupId, source.messageId)?.links[0].plan?.items[0].status).toBe('skipped');
    } else if (scenario === 'storage-failure') {
      raw.exec("CREATE TRIGGER reject_retry_compensation BEFORE UPDATE ON relay_sources BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END");
      expect(() => store.revokeRetryPass('pass')).toThrow('synthetic storage failure');
      expect(store.isRetryPassActive('pass')).toBe(true);
      expect(store.getRelaySource(source.groupId, source.messageId)?.links[0].plan?.items[0].status).toBe('ready');
      raw.exec('DROP TRIGGER reject_retry_compensation');
      store.revokeRetryPass('pass');
      expect(store.getRelaySource(source.groupId, source.messageId)?.links[0].plan?.items[0].status).toBe('failed');
    }
  } finally { raw.close(); }
});

it('rejects unsupported durable-state versions before accepting any work', () => {
  const store = createStore(':memory:');
  stores.push(store);
  expect(() => store.acceptRelaySource({ ...source, version: 2 } as unknown as RelaySource)).toThrow();
  expect(store.listRelaySources()).toEqual([]);
});
