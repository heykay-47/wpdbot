import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStore, type Store } from '../src/store';

let tempDirs: string[] = [];
let stores: Store[] = [];

function createTempStore(defaults?: { maxFileSizeMb?: number; duplicateWindowHours?: number }): Store {
  const dir = mkdtempSync(join(tmpdir(), 'wpdbot-store-'));
  tempDirs.push(dir);
  const store = createStore(join(dir, 'bot.sqlite'), defaults);
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores) {
    store.close();
  }
  stores = [];

  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

describe('createStore', () => {
  it('persists Instagram send reservations and confirmations across restarts without losing existing data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wpdbot-store-'));
    tempDirs.push(dir);
    const path = join(dir, 'bot.sqlite');
    const key = { groupId: 'group-1@g.us', messageId: 'source-1', postId: 'post-1', itemId: 'video-1' };
    let store = createStore(path);
    store.setGroupEnabled(key.groupId, true);
    store.recordDuplicate(key.groupId, 'existing-hash', 1_000);

    expect(store.beginInstagramItem(key, 2_000)).toBe(true);
    expect(store.beginInstagramItem(key, 2_001)).toBe(false);
    store.close();
    store = createStore(path);
    expect(store.getInstagramItem(key)).toEqual({ status: 'sending', sentMessageId: null, ack: null });
    expect(store.beginInstagramItem(key, 3_000)).toBe(false);
    store.confirmInstagramItem(key, { messageId: 'sent-1', ack: 1 }, {
      groupId: key.groupId, senderId: 'sender@c.us', url: 'https://www.instagram.com/p/example/', urlHash: 'post-hash', createdAtMs: 3_000,
    });
    store.close();
    store = createStore(path);
    stores.push(store);

    expect(store.getInstagramItem(key)).toEqual({ status: 'confirmed', sentMessageId: 'sent-1', ack: 1 });
    expect(store.beginInstagramItem(key, 4_000)).toBe(false);
    expect(store.countReposts()).toBe(1);
    expect(store.getGroupSettings(key.groupId).enabled).toBe(true);
    expect(store.wasRecentlyPosted(key.groupId, 'existing-hash', 4_000, 1)).toBe(true);
    expect(store.wasRecentlyPosted(key.groupId, 'post-hash', 4_000, 1)).toBe(false);
  });

  it('creates default group settings when missing', () => {
    const store = createTempStore();

    expect(store.getGroupSettings('group-1@g.us')).toEqual({
      groupId: 'group-1@g.us',
      enabled: false,
      maxFileSizeMb: 64,
      duplicateWindowHours: 24,
    });
  });

  it('creates missing database parent directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wpdbot-store-'));
    tempDirs.push(dir);
    const databasePath = join(dir, 'nested', 'bot.sqlite');

    const store = createStore(databasePath);
    stores.push(store);

    expect(existsSync(join(dir, 'nested'))).toBe(true);
    expect(store.getGroupSettings('group-1@g.us').enabled).toBe(false);
  });

  it('uses injected defaults for new group settings', () => {
    const store = createTempStore({ maxFileSizeMb: 128, duplicateWindowHours: 6 });

    expect(store.getGroupSettings('group-1@g.us')).toEqual({
      groupId: 'group-1@g.us',
      enabled: false,
      maxFileSizeMb: 128,
      duplicateWindowHours: 6,
    });
  });

  it('persists enabled state for a group', () => {
    const store = createTempStore();

    store.setGroupEnabled('group-1@g.us', true);

    expect(store.getGroupSettings('group-1@g.us')).toMatchObject({
      groupId: 'group-1@g.us',
      enabled: true,
    });
  });

  it('persists validated group settings and advances a revision only when values change', () => {
    const store = createTempStore();
    const groupId = 'group-1@g.us';

    expect(store.getGroupSettingsRevision(groupId)).toBe(0);
    expect(store.setGroupSettings(groupId, { maxFileSizeMb: 48 })).toBe(true);
    expect(store.setGroupSettings(groupId, { maxFileSizeMb: 48 })).toBe(false);
    expect(store.setGroupSettings(groupId, { duplicateWindowHours: 0 })).toBe(true);

    expect(store.getGroupSettings(groupId)).toEqual({
      groupId,
      enabled: false,
      maxFileSizeMb: 48,
      duplicateWindowHours: 0,
    });
    expect(store.getGroupSettingsRevision(groupId)).toBe(2);
    expect(() => store.setGroupSettings(groupId, { maxFileSizeMb: 0 })).toThrow();
    expect(() => store.setGroupSettings(groupId, { duplicateWindowHours: 721 })).toThrow();
    expect(store.getGroupSettingsRevision(groupId)).toBe(2);
  });

  it('scopes duplicate checks by group and time window', () => {
    const store = createTempStore();
    const createdAtMs = 1_000;
    const oneHourMs = 60 * 60 * 1000;

    store.recordDuplicate('group-1@g.us', 'hash-a', createdAtMs);

    expect(store.wasRecentlyPosted('group-1@g.us', 'hash-a', createdAtMs + oneHourMs, 2)).toBe(true);
    expect(store.wasRecentlyPosted('group-2@g.us', 'hash-a', createdAtMs + oneHourMs, 2)).toBe(false);
    expect(store.wasRecentlyPosted('group-1@g.us', 'hash-a', createdAtMs + oneHourMs * 3, 2)).toBe(false);
  });

  it('upserts duplicate hashes per group', () => {
    const store = createTempStore();

    store.recordDuplicate('group-1@g.us', 'hash-a', 1_000);
    store.recordDuplicate('group-1@g.us', 'hash-a', 5_000);

    expect(store.wasRecentlyPosted('group-1@g.us', 'hash-a', 6_000, 1)).toBe(true);
    expect(store.wasRecentlyPosted('group-1@g.us', 'hash-a', 4_000_000, 1)).toBe(false);
  });

  it('does not replace newer duplicate timestamp with older timestamp', () => {
    const store = createTempStore();

    store.recordDuplicate('group-1@g.us', 'hash-a', 5_000);
    store.recordDuplicate('group-1@g.us', 'hash-a', 1_000);

    expect(store.wasRecentlyPosted('group-1@g.us', 'hash-a', 3_604_000, 1)).toBe(true);
  });

  it('stores repost history count', () => {
    const store = createTempStore();

    store.recordRepost({
      groupId: 'group-1@g.us',
      senderId: 'sender@c.us',
      url: 'https://www.youtube.com/shorts/example',
      urlHash: 'hash-a',
      createdAtMs: 1_000,
    });
    store.recordRepost({
      groupId: 'group-2@g.us',
      senderId: 'sender@c.us',
      url: 'https://instagram.com/reel/example',
      urlHash: 'hash-b',
      createdAtMs: 2_000,
    });

    expect(store.countReposts()).toBe(2);
  });

  it('records duplicate cache and repost history in one successful repost operation', () => {
    const store = createTempStore();

    store.recordSuccessfulRepost({
      groupId: 'group-1@g.us',
      senderId: 'sender@c.us',
      url: 'https://www.youtube.com/shorts/example',
      urlHash: 'hash-a',
      createdAtMs: 5_000,
    });

    expect(store.countReposts()).toBe(1);
    expect(store.wasRecentlyPosted('group-1@g.us', 'hash-a', 6_000, 1)).toBe(true);
  });

  it('stores and returns group metadata', () => {
    const store = createTempStore();

    expect(store.getGroupMetadata('group-1@g.us')).toBeNull();

    store.setGroupMetadata('group-1@g.us', 'Family Group', 1_000);

    expect(store.getGroupMetadata('group-1@g.us')).toEqual({
      groupId: 'group-1@g.us',
      name: 'Family Group',
      updatedAtMs: 1_000,
    });
  });

  it('returns null when bot owner id is missing', () => {
    const store = createTempStore();

    expect(store.getBotOwnerId()).toBeNull();
  });

  it('stores and returns bot owner id', () => {
    const store = createTempStore();

    store.setBotOwnerId('919999999999@c.us');

    expect(store.getBotOwnerId()).toBe('919999999999@c.us');
  });
});
