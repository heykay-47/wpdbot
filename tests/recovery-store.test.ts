import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

it('rejects unsupported durable-state versions before accepting any work', () => {
  const store = createStore(':memory:');
  stores.push(store);
  expect(() => store.acceptRelaySource({ ...source, version: 2 } as unknown as RelaySource)).toThrow();
  expect(store.listRelaySources()).toEqual([]);
});
