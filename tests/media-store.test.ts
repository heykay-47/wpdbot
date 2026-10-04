import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createStore, type MediaRepostKey, type Store } from '../src/store';

const stores: Store[] = [];
const roots: string[] = [];
const key: MediaRepostKey = { groupId: 'group-1@g.us', messageId: 'source-1', identity: { platform: 'youtube', videoId: 'AbCdEf123_-' } };
const record = { groupId: key.groupId, senderId: 'sender@c.us', url: 'https://youtube.com/shorts/AbCdEf123_-', urlHash: 'legacy-hash', createdAtMs: 1_000 };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wpdbot-media-store-'));
  roots.push(root);
  const path = join(root, 'bot.sqlite');
  const store = createStore(path);
  stores.push(store);
  return { store, path };
}

function reopen(store: Store, path: string): Store {
  const index = stores.indexOf(store);
  store.close();
  const next = createStore(path);
  stores[index] = next;
  return next;
}

afterEach(() => {
  for (const store of stores) store.close();
  stores.length = 0;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

describe('identity-based repost storage', () => {
  it('durably reserves one send per group/media across source messages, restarts, and window expiry', () => {
    const input = fixture();
    expect(input.store.beginMediaRepost(key, record, 24)).toBe('started');
    const store = reopen(input.store, input.path);
    const laterKey = { ...key, messageId: 'source-2' };

    expect(store.getMediaDisposition(laterKey, 1_000_000_000, 0)).toBe('held');
    expect(store.beginMediaRepost(laterKey, { ...record, createdAtMs: 1_000_000_000 }, 0)).toBe('held');
    expect(store.beginMediaRepost({ ...key, groupId: 'group-2@g.us' }, { ...record, groupId: 'group-2@g.us' }, 24)).toBe('started');
    expect(store.countReposts()).toBe(0);
  });

  it('starts the group window at confirmation and never expires the same source completion', () => {
    const input = fixture();
    input.store.beginMediaRepost(key, record, 1);
    input.store.confirmMediaRepost(key, { messageId: 'sent-1', ack: 1 }, { ...record, createdAtMs: 5_000 });
    const store = reopen(input.store, input.path);
    const otherSource = { ...key, messageId: 'source-2' };

    expect(store.getMediaDisposition(otherSource, 3_605_000, 1)).toBe('duplicate');
    expect(store.beginMediaRepost(otherSource, { ...record, createdAtMs: 3_605_000 }, 1)).toBe('duplicate');
    expect(store.getMediaDisposition(otherSource, 3_605_001, 1)).toBe('ready');
    expect(store.getMediaDisposition(otherSource, 5_000, 0)).toBe('ready');
    expect(store.getMediaDisposition({ ...otherSource, groupId: 'group-2@g.us' }, 5_000, 1)).toBe('ready');
    expect(store.getMediaDisposition(key, 1_000_000_000, 0)).toBe('completed');
    expect(store.countReposts()).toBe(1);
    expect(store.wasRecentlyPosted(key.groupId, record.urlHash, 5_000, 1)).toBe(false);
  });

  it('preserves legacy Instagram source completion and cross-message unknown sends without inventing confirmation times', () => {
    const input = fixture();
    const legacy = { groupId: key.groupId, messageId: key.messageId, postId: 'post-1', itemId: 'item-1' };
    input.store.setGroupEnabled(key.groupId, true);
    input.store.recordDuplicate(key.groupId, 'old-url-hash', 1_000);
    input.store.beginInstagramItem(legacy, 1_000);
    input.store.confirmInstagramItem(legacy, { messageId: 'old-sent-1', ack: 1 }, record);
    input.store.beginInstagramItem({ ...legacy, itemId: 'item-2' }, 1_000);
    const store = reopen(input.store, input.path);
    const confirmedKey: MediaRepostKey = { ...key, identity: { platform: 'instagram', postId: 'post-1', itemId: 'item-1' } };
    const unknownKey: MediaRepostKey = { ...confirmedKey, messageId: 'source-2', identity: { platform: 'instagram', postId: 'post-1', itemId: 'item-2' } };

    expect(store.getMediaDisposition(confirmedKey, 1_000_000_000, 0)).toBe('completed');
    expect(store.getMediaDisposition({ ...confirmedKey, messageId: 'source-2' }, 2_000, 24)).toBe('ready');
    expect(store.getMediaDisposition(unknownKey, 1_000_000_000, 0)).toBe('held');
    expect(store.beginMediaRepost(unknownKey, { ...record, createdAtMs: 1_000_000_000 }, 0)).toBe('held');
    expect(store.getGroupSettings(key.groupId).enabled).toBe(true);
    expect(store.wasRecentlyPosted(key.groupId, 'old-url-hash', 2_000, 24)).toBe(true);
    expect(store.countReposts()).toBe(1);
    expect(store.getInstagramItem(legacy)).toEqual({ status: 'confirmed', sentMessageId: 'old-sent-1', ack: 1 });
  });

  it('rejects invalid reservation/confirmation evidence without losing the unresolved-send guard', () => {
    const { store } = fixture();
    expect(() => store.beginMediaRepost({ ...key, identity: { platform: 'youtube', videoId: '' } }, record, 24)).toThrow();
    expect(() => store.beginMediaRepost(key, { ...record, groupId: 'another-group' }, 24)).toThrow();
    expect(store.beginMediaRepost(key, record, 24)).toBe('started');
    for (const confirmation of [{ messageId: '', ack: 1 }, { messageId: 'sent-1', ack: 0 }, { messageId: 'sent-1', ack: 5 }]) {
      expect(() => store.confirmMediaRepost(key, confirmation, record)).toThrow();
    }
    expect(() => store.confirmMediaRepost(key, { messageId: 'sent-1', ack: 1 }, { ...record, groupId: 'another-group' })).toThrow();
    expect(() => store.confirmMediaRepost(key, { messageId: 'sent-1', ack: 1 }, { ...record, createdAtMs: Infinity })).toThrow();
    expect(store.getMediaDisposition({ ...key, messageId: 'source-2' }, 1_000_000_000, 0)).toBe('held');
    expect(store.countReposts()).toBe(0);
  });

  it('opens a pre-identity SQLite fixture without rewriting its settings, history, owner or URL markers', () => {
    const root = mkdtempSync(join(tmpdir(), 'wpdbot-legacy-store-'));
    roots.push(root);
    const path = join(root, 'bot.sqlite');
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE group_settings (group_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, max_file_size_mb INTEGER NOT NULL, duplicate_window_hours INTEGER NOT NULL);
      INSERT INTO group_settings VALUES ('group-1@g.us', 1, 12, 3);
      CREATE TABLE duplicate_urls (group_id TEXT NOT NULL, url_hash TEXT NOT NULL, created_at_ms INTEGER NOT NULL, PRIMARY KEY (group_id, url_hash));
      INSERT INTO duplicate_urls VALUES ('group-1@g.us', 'old-hash', 1000);
      CREATE TABLE repost_history (id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT NOT NULL, sender_id TEXT NOT NULL, url TEXT NOT NULL, url_hash TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
      INSERT INTO repost_history (group_id, sender_id, url, url_hash, created_at_ms) VALUES ('group-1@g.us', 'sender@c.us', 'https://youtube.com/shorts/AbCdEf123_-', 'old-hash', 1000);
      CREATE TABLE bot_identity (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO bot_identity VALUES ('owner_id', 'owner@c.us');
    `);
    legacy.close();
    let store = createStore(path);
    stores.push(store);
    expect(store.getGroupSettings(key.groupId)).toEqual({ groupId: key.groupId, enabled: true, maxFileSizeMb: 12, duplicateWindowHours: 3 });
    expect(store.getBotOwnerId()).toBe('owner@c.us');
    expect(store.countReposts()).toBe(1);
    expect(store.wasRecentlyPosted(key.groupId, 'old-hash', 2_000, 3)).toBe(true);
    expect(store.getMediaDisposition(key, 2_000, 3)).toBe('ready');
    store.beginMediaRepost(key, record, 3);
    store.confirmMediaRepost(key, { messageId: 'new-sent-1', ack: 1 }, { ...record, createdAtMs: 2_000 });
    store = reopen(store, path);
    expect(store.countReposts()).toBe(2);
    expect(store.getGroupSettings(key.groupId).maxFileSizeMb).toBe(12);
    expect(store.getBotOwnerId()).toBe('owner@c.us');
    expect(store.wasRecentlyPosted(key.groupId, 'old-hash', 2_000, 3)).toBe(true);
    expect(store.getMediaDisposition(key, 2_000, 3)).toBe('completed');
  });
});
