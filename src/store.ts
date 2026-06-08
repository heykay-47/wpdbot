import Database from 'better-sqlite3';

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

export type Store = {
  getGroupSettings(groupId: string): GroupSettings;
  setGroupEnabled(groupId: string, enabled: boolean): void;
  recordDuplicate(groupId: string, urlHash: string, createdAtMs: number): void;
  wasRecentlyPosted(groupId: string, urlHash: string, nowMs: number, windowHours: number): boolean;
  recordRepost(record: RepostRecord): void;
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

type CountRow = {
  count: number;
};

const defaultMaxFileSizeMb = 64;
const defaultDuplicateWindowHours = 24;

export function createStore(path: string): Store {
  const db = new Database(path);

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
    ON CONFLICT(group_id, url_hash) DO UPDATE SET created_at_ms = excluded.created_at_ms
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
  const selectRepostCount = db.prepare<[], CountRow>(`
    SELECT COUNT(*) AS count
    FROM repost_history
  `);

  return {
    getGroupSettings(groupId) {
      insertDefaultSettings.run(groupId, defaultMaxFileSizeMb, defaultDuplicateWindowHours);
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
      insertDefaultSettings.run(groupId, defaultMaxFileSizeMb, defaultDuplicateWindowHours);
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

    recordRepost(record) {
      insertRepost.run(record.groupId, record.senderId, record.url, record.urlHash, record.createdAtMs);
    },

    countReposts() {
      return selectRepostCount.get()?.count ?? 0;
    },

    close() {
      db.close();
    },
  };
}
