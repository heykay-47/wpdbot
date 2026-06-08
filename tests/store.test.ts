import { mkdtempSync, rmSync } from 'node:fs';
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
  it('creates default group settings when missing', () => {
    const store = createTempStore();

    expect(store.getGroupSettings('group-1@g.us')).toEqual({
      groupId: 'group-1@g.us',
      enabled: false,
      maxFileSizeMb: 64,
      duplicateWindowHours: 24,
    });
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
      url: 'https://youtu.be/example',
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
