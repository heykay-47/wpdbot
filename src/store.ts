import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { mediaIdentityKey, type MediaIdentity } from './mediaIdentity.js';

export type GroupSettings = {
  groupId: string;
  enabled: boolean;
  maxFileSizeMb: number;
  duplicateWindowHours: number;
};

export type RepostRecord = {
  groupId: string;
  senderId: string;
  url: string;
  urlHash: string;
  createdAtMs: number;
};

export type InstagramItemKey = { groupId: string; messageId: string; postId: string; itemId: string };
export type RepostConfirmation = { messageId: string; ack: number };
export type InstagramItemProgress = { status: 'sending' | 'confirmed'; sentMessageId: string | null; ack: number | null };

export type MediaRepostKey = { groupId: string; messageId: string; identity: MediaIdentity };
export type MediaDisposition = 'ready' | 'completed' | 'duplicate' | 'held';

export type StoreDefaults = {
  maxFileSizeMb?: number;
  duplicateWindowHours?: number;
};

export type GroupMetadata = {
  groupId: string;
  name: string;
  updatedAtMs: number;
};

export type Store = {
  getGroupSettings(groupId: string): GroupSettings;
  setGroupEnabled(groupId: string, enabled: boolean): void;
  recordDuplicate(groupId: string, urlHash: string, createdAtMs: number): void;
  wasRecentlyPosted(groupId: string, urlHash: string, nowMs: number, windowHours: number): boolean;
  setGroupMetadata(groupId: string, name: string, updatedAtMs: number): void;
  getGroupMetadata(groupId: string): GroupMetadata | null;
  setBotOwnerId(ownerId: string): void;
  getBotOwnerId(): string | null;
  recordRepost(record: RepostRecord): void;
  recordSuccessfulRepost(record: RepostRecord): void;
  getInstagramItem(key: InstagramItemKey): InstagramItemProgress | null;
  beginInstagramItem(key: InstagramItemKey, nowMs: number): boolean;
  confirmInstagramItem(key: InstagramItemKey, confirmation: RepostConfirmation, record: RepostRecord): void;
  getMediaDisposition(key: MediaRepostKey, nowMs: number, windowHours: number): MediaDisposition;
  beginMediaRepost(key: MediaRepostKey, record: RepostRecord, windowHours: number): 'started' | Exclude<MediaDisposition, 'ready'>;
  confirmMediaRepost(key: MediaRepostKey, confirmation: RepostConfirmation, record: RepostRecord): void;
  countReposts(): number;
  close(): void;
};

type GroupSettingsRow = {
  group_id: string;
  enabled: number;
  max_file_size_mb: number;
  duplicate_window_hours: number;
};

type DuplicateRow = {
  created_at_ms: number;
};

type GroupMetadataRow = {
  group_id: string;
  name: string;
  updated_at_ms: number;
};

type BotIdentityRow = {
  value: string;
};

type CountRow = {
  count: number;
};

const defaultMaxFileSizeMb = 64;
const defaultDuplicateWindowHours = 24;
const botOwnerIdKey = 'owner_id';

export function createStore(path: string, defaults: StoreDefaults = {}): Store {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);
  const maxFileSizeMb = defaults.maxFileSizeMb ?? defaultMaxFileSizeMb;
  const duplicateWindowHours = defaults.duplicateWindowHours ?? defaultDuplicateWindowHours;

  db.exec(`
    CREATE TABLE IF NOT EXISTS group_settings (
      group_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      max_file_size_mb INTEGER NOT NULL DEFAULT 64,
      duplicate_window_hours INTEGER NOT NULL DEFAULT 24
    );

    CREATE TABLE IF NOT EXISTS duplicate_urls (
      group_id TEXT NOT NULL,
      url_hash TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (group_id, url_hash)
    );

    CREATE TABLE IF NOT EXISTS repost_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      url TEXT NOT NULL,
      url_hash TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_metadata (
      group_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bot_identity (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS instagram_relay_items (
      group_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      post_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('sending', 'confirmed')),
      started_at_ms INTEGER NOT NULL,
      sent_message_id TEXT,
      ack INTEGER,
      PRIMARY KEY (group_id, message_id, post_id, item_id)
    );

    CREATE TABLE IF NOT EXISTS media_relay_attempts (
      group_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      media_key TEXT NOT NULL,
      source_url TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('sending', 'confirmed')),
      started_at_ms INTEGER NOT NULL,
      confirmed_at_ms INTEGER,
      sent_message_id TEXT,
      ack INTEGER,
      PRIMARY KEY (group_id, message_id, media_key)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS media_relay_pending
      ON media_relay_attempts (group_id, media_key) WHERE status = 'sending';
  `);

  const insertDefaultSettings = db.prepare(`
    INSERT OR IGNORE INTO group_settings (group_id, enabled, max_file_size_mb, duplicate_window_hours)
    VALUES (?, 0, ?, ?)
  `);
  const selectSettings = db.prepare<string, GroupSettingsRow>(`
    SELECT group_id, enabled, max_file_size_mb, duplicate_window_hours
    FROM group_settings
    WHERE group_id = ?
  `);
  const updateEnabled = db.prepare(`
    UPDATE group_settings
    SET enabled = ?
    WHERE group_id = ?
  `);
  const upsertDuplicate = db.prepare(`
    INSERT INTO duplicate_urls (group_id, url_hash, created_at_ms)
    VALUES (?, ?, ?)
    ON CONFLICT(group_id, url_hash) DO UPDATE SET created_at_ms = max(duplicate_urls.created_at_ms, excluded.created_at_ms)
  `);
  const selectDuplicate = db.prepare<[string, string], DuplicateRow>(`
    SELECT created_at_ms
    FROM duplicate_urls
    WHERE group_id = ? AND url_hash = ?
  `);
  const insertRepost = db.prepare(`
    INSERT INTO repost_history (group_id, sender_id, url, url_hash, created_at_ms)
    VALUES (?, ?, ?, ?, ?)
  `);
  const upsertGroupMetadata = db.prepare(`
    INSERT INTO group_metadata (group_id, name, updated_at_ms)
    VALUES (?, ?, ?)
    ON CONFLICT(group_id) DO UPDATE SET name = excluded.name, updated_at_ms = excluded.updated_at_ms
  `);
  const selectGroupMetadata = db.prepare<string, GroupMetadataRow>(`
    SELECT group_id, name, updated_at_ms
    FROM group_metadata
    WHERE group_id = ?
  `);
  const upsertBotIdentity = db.prepare(`
    INSERT INTO bot_identity (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const selectBotIdentity = db.prepare<string, BotIdentityRow>(`
    SELECT value
    FROM bot_identity
    WHERE key = ?
  `);
  const selectRepostCount = db.prepare<[], CountRow>(`
    SELECT COUNT(*) AS count
    FROM repost_history
  `);
  const recordSuccessfulRepost = db.transaction((record: RepostRecord) => {
    insertRepost.run(record.groupId, record.senderId, record.url, record.urlHash, record.createdAtMs);
    upsertDuplicate.run(record.groupId, record.urlHash, record.createdAtMs);
  });
  const selectInstagramItem = db.prepare<[string, string, string, string], InstagramItemProgress>(`
    SELECT status, sent_message_id AS sentMessageId, ack FROM instagram_relay_items
    WHERE group_id = ? AND message_id = ? AND post_id = ? AND item_id = ?
  `);
  const beginInstagramItem = db.prepare(`
    INSERT OR IGNORE INTO instagram_relay_items (group_id, message_id, post_id, item_id, status, started_at_ms)
    VALUES (?, ?, ?, ?, 'sending', ?)
  `);
  const confirmInstagramItem = db.prepare(`
    UPDATE instagram_relay_items SET status = 'confirmed', sent_message_id = ?, ack = ?
    WHERE group_id = ? AND message_id = ? AND post_id = ? AND item_id = ? AND status = 'sending'
  `);
  const recordInstagramConfirmation = db.transaction((key: InstagramItemKey, confirmation: RepostConfirmation, record: RepostRecord) => {
    if (!confirmation.messageId.trim() || !Number.isInteger(confirmation.ack) || confirmation.ack < 1 || confirmation.ack > 4) {
      throw new Error('Instagram repost lacks server acknowledgement');
    }
    const changed = confirmInstagramItem.run(confirmation.messageId, confirmation.ack, key.groupId, key.messageId, key.postId, key.itemId);
    if (!changed.changes) throw new Error('Instagram send reservation is missing or already confirmed');
    insertRepost.run(record.groupId, record.senderId, record.url, record.urlHash, record.createdAtMs);
  });

  const selectPendingMedia = db.prepare<[string, string], { message_id: string }>(`
    SELECT message_id FROM media_relay_attempts WHERE group_id = ? AND media_key = ? AND status = 'sending'
  `);
  const insertMediaAttempt = db.prepare(`
    INSERT INTO media_relay_attempts (group_id, message_id, media_key, source_url, status, started_at_ms)
    VALUES (?, ?, ?, ?, 'sending', ?)
  `);
  const selectSourceMedia = db.prepare<[string, string, string], { status: 'sending' | 'confirmed' }>(`
    SELECT status FROM media_relay_attempts WHERE group_id = ? AND message_id = ? AND media_key = ?
  `);
  const selectMediaConfirmation = db.prepare<[string, string], { confirmedAtMs: number | null }>(`
    SELECT max(confirmed_at_ms) AS confirmedAtMs FROM media_relay_attempts
    WHERE group_id = ? AND media_key = ? AND status = 'confirmed'
  `);
  const updateMediaConfirmation = db.prepare(`
    UPDATE media_relay_attempts SET status = 'confirmed', confirmed_at_ms = ?, sent_message_id = ?, ack = ?
    WHERE group_id = ? AND message_id = ? AND media_key = ? AND source_url = ? AND status = 'sending'
  `);
  const selectLegacyPendingItem = db.prepare<[string, string, string], { message_id: string }>(`
    SELECT message_id FROM instagram_relay_items
    WHERE group_id = ? AND post_id = ? AND item_id = ? AND status = 'sending' LIMIT 1
  `);
  const getMediaDisposition = (key: MediaRepostKey, nowMs: number, windowHours: number): MediaDisposition => {
    const identityKey = mediaIdentityKey(key.identity);
    if (selectSourceMedia.get(key.groupId, key.messageId, identityKey)?.status === 'confirmed') return 'completed';
    if (key.identity.platform === 'instagram') {
      const { postId, itemId } = key.identity;
      if (selectInstagramItem.get(key.groupId, key.messageId, postId, itemId)?.status === 'confirmed') return 'completed';
      if (selectLegacyPendingItem.get(key.groupId, postId, itemId)) return 'held';
    }
    if (selectPendingMedia.get(key.groupId, identityKey)) return 'held';
    const confirmedAtMs = selectMediaConfirmation.get(key.groupId, identityKey)?.confirmedAtMs;
    if (windowHours > 0 && confirmedAtMs != null && nowMs - confirmedAtMs <= windowHours * 60 * 60 * 1000) return 'duplicate';
    return 'ready';
  };
  const beginMediaRepost = db.transaction((key: MediaRepostKey, record: RepostRecord, windowHours: number): ReturnType<Store['beginMediaRepost']> => {
    if (record.groupId !== key.groupId || !key.groupId.trim() || !key.messageId.trim()) throw new Error('Media send requires matching group and source identities');
    if (!Number.isSafeInteger(record.createdAtMs)) throw new Error('Media send timestamp is invalid');
    const disposition = getMediaDisposition(key, record.createdAtMs, windowHours);
    if (disposition !== 'ready') return disposition;
    insertMediaAttempt.run(key.groupId, key.messageId, mediaIdentityKey(key.identity), record.url, record.createdAtMs);
    return 'started';
  });
  const confirmMediaRepost = db.transaction((key: MediaRepostKey, confirmation: RepostConfirmation, record: RepostRecord) => {
    if (record.groupId !== key.groupId || !confirmation.messageId.trim() || !Number.isInteger(confirmation.ack) || confirmation.ack < 1 || confirmation.ack > 4) {
      throw new Error('Media repost lacks matching group and server acknowledgement');
    }
    if (!Number.isSafeInteger(record.createdAtMs)) throw new Error('Media confirmation timestamp is invalid');
    const changed = updateMediaConfirmation.run(record.createdAtMs, confirmation.messageId, confirmation.ack,
      key.groupId, key.messageId, mediaIdentityKey(key.identity), record.url);
    if (!changed.changes) throw new Error('Media send reservation is missing or already confirmed');
    insertRepost.run(record.groupId, record.senderId, record.url, record.urlHash, record.createdAtMs);
  });

  return {
    getGroupSettings(groupId) {
      insertDefaultSettings.run(groupId, maxFileSizeMb, duplicateWindowHours);
      const row = selectSettings.get(groupId);

      if (!row) {
        throw new Error(`Group settings not found for ${groupId}`);
      }

      return {
        groupId: row.group_id,
        enabled: row.enabled === 1,
        maxFileSizeMb: row.max_file_size_mb,
        duplicateWindowHours: row.duplicate_window_hours,
      };
    },

    setGroupEnabled(groupId, enabled) {
      insertDefaultSettings.run(groupId, maxFileSizeMb, duplicateWindowHours);
      updateEnabled.run(enabled ? 1 : 0, groupId);
    },

    recordDuplicate(groupId, urlHash, createdAtMs) {
      upsertDuplicate.run(groupId, urlHash, createdAtMs);
    },

    wasRecentlyPosted(groupId, urlHash, nowMs, windowHours) {
      const row = selectDuplicate.get(groupId, urlHash);
      if (!row || row.created_at_ms > nowMs) {
        return false;
      }

      return nowMs - row.created_at_ms <= windowHours * 60 * 60 * 1000;
    },

    setGroupMetadata(groupId, name, updatedAtMs) {
      upsertGroupMetadata.run(groupId, name, updatedAtMs);
    },

    getGroupMetadata(groupId) {
      const row = selectGroupMetadata.get(groupId);
      if (!row) {
        return null;
      }

      return {
        groupId: row.group_id,
        name: row.name,
        updatedAtMs: row.updated_at_ms,
      };
    },

    setBotOwnerId(ownerId) {
      upsertBotIdentity.run(botOwnerIdKey, ownerId);
    },

    getBotOwnerId() {
      return selectBotIdentity.get(botOwnerIdKey)?.value ?? null;
    },

    recordRepost(record) {
      insertRepost.run(record.groupId, record.senderId, record.url, record.urlHash, record.createdAtMs);
    },

    recordSuccessfulRepost,

    getInstagramItem(key) {
      return selectInstagramItem.get(key.groupId, key.messageId, key.postId, key.itemId) ?? null;
    },

    beginInstagramItem(key, nowMs) {
      if (![key.groupId, key.messageId, key.postId, key.itemId].every((value) => value.trim())) {
        throw new Error('Instagram send requires source and item identities');
      }
      return Boolean(beginInstagramItem.run(key.groupId, key.messageId, key.postId, key.itemId, nowMs).changes);
    },

    confirmInstagramItem: recordInstagramConfirmation,

    getMediaDisposition,

    beginMediaRepost: beginMediaRepost.immediate,

    confirmMediaRepost,

    countReposts() {
      return selectRepostCount.get()?.count ?? 0;
    },

    close() {
      db.close();
    },
  };
}
