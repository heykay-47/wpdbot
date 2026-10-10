import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { mediaIdentityKey, type MediaIdentity } from './mediaIdentity.js';
import { serializeRelaySource, UnsupportedRelayStateError, validateRelaySource, type RelaySource } from './relayState.js';

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
export type RepostEvidence = { messageId: string; ack: number | null };
export type InstagramItemProgress = { status: 'sending' | 'confirmed'; sentMessageId: string | null; ack: number | null };

export type MediaRepostKey = { groupId: string; messageId: string; identity: MediaIdentity };
export type MediaDisposition = 'ready' | 'completed' | 'duplicate' | 'held';
export type MediaAttempt = { status: 'sending' | 'confirmed'; sentMessageId: string | null; ack: number | null; sourceUrl: string };

export type StoreDefaults = {
  maxFileSizeMb?: number;
  duplicateWindowHours?: number;
};

export type RetryPassTarget = { linkIndex: number; itemIndexes: number[] };
export type RetryPassAdmission = {
  id: string;
  groupId: string;
  messageId: string;
  settingsRevision: number;
  createdAtMs: number;
  targets: RetryPassTarget[];
  sourceBefore: RelaySource;
  sourceAfter: RelaySource;
};
export type RetryReservationGuard = { retryPassId: string; settingsRevision: number };

export type GroupMetadata = {
  groupId: string;
  name: string;
  updatedAtMs: number;
};

export type Store = {
  acceptRelaySource(source: RelaySource): void;
  getRelaySource(groupId: string, messageId: string): RelaySource | null;
  saveRelaySource(source: RelaySource): void;
  listRelaySources(): RelaySource[];
  getGroupSettings(groupId: string): GroupSettings;
  getGroupSettingsRevision(groupId: string): number;
  setGroupSettings(groupId: string, values: Partial<Pick<GroupSettings, 'maxFileSizeMb' | 'duplicateWindowHours'>>): boolean;
  setGroupEnabled(groupId: string, enabled: boolean): void;
  claimRetryConfirmation(messageId: string): boolean;
  admitRetryPass(admission: RetryPassAdmission): 'admitted' | 'stale' | 'active';
  isRetryPassActive(id: string): boolean;
  hasActiveRetryPass(groupId: string, messageId: string): boolean;
  completeRetryPass(id: string): void;
  revokeRetryPass(id: string): void;
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
  beginMediaRepost(key: MediaRepostKey, record: RepostRecord, windowHours: number, guard?: RetryReservationGuard): 'started' | Exclude<MediaDisposition, 'ready'>;
  confirmMediaRepost(key: MediaRepostKey, confirmation: RepostConfirmation, record: RepostRecord): void;
  getMediaAttempt(key: MediaRepostKey): MediaAttempt | null;
  recordMediaEvidence(key: MediaRepostKey, evidence: RepostEvidence): void;
  countReposts(): number;
  close(): void;
};

type GroupSettingsRow = {
  group_id: string;
  enabled: number;
  max_file_size_mb: number;
  duplicate_window_hours: number;
};

type GroupSettingsVersionRow = { settings_revision: number };
type RetryPassRow = {
  id: string;
  group_id: string;
  message_id: string;
  settings_revision: number;
  state: 'active' | 'revoked' | 'completed';
  source_before_json: string;
  targets_json: string;
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
      duplicate_window_hours INTEGER NOT NULL DEFAULT 24,
      settings_revision INTEGER NOT NULL DEFAULT 0
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

    CREATE TABLE IF NOT EXISTS relay_sources (
      group_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      state_json TEXT NOT NULL,
      PRIMARY KEY (group_id, message_id)
    );
    CREATE TABLE IF NOT EXISTS relay_references (
      group_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      reference TEXT NOT NULL UNIQUE,
      PRIMARY KEY (group_id, message_id)
    );
    CREATE TABLE IF NOT EXISTS retry_passes (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      settings_revision INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'revoked', 'completed')),
      source_before_json TEXT NOT NULL,
      targets_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS retry_pass_one_active_source
      ON retry_passes (group_id, message_id) WHERE state = 'active';
    CREATE TABLE IF NOT EXISTS retry_confirmation_messages (
      message_id TEXT PRIMARY KEY
    );
  `);

  const settingsColumns = db.prepare<[], { name: string }>('PRAGMA table_info(group_settings)').all();
  if (!settingsColumns.some((column) => column.name === 'settings_revision')) {
    db.exec('ALTER TABLE group_settings ADD COLUMN settings_revision INTEGER NOT NULL DEFAULT 0');
  }

  const insertRelaySource = db.prepare('INSERT OR IGNORE INTO relay_sources (group_id, message_id, state_json) VALUES (?, ?, ?)');
  const selectRelaySource = db.prepare<[string, string], { state: string }>('SELECT state_json AS state FROM relay_sources WHERE group_id = ? AND message_id = ?');
  const updateRelaySource = db.prepare('UPDATE relay_sources SET state_json = ? WHERE group_id = ? AND message_id = ?');
  const selectRelaySources = db.prepare<[], { groupId: string; messageId: string; state: string }>('SELECT group_id AS groupId, message_id AS messageId, state_json AS state FROM relay_sources ORDER BY rowid');
  const insertRetryPass = db.prepare(`
    INSERT INTO retry_passes (id, group_id, message_id, settings_revision, state, source_before_json, targets_json, created_at_ms)
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
  `);
  const selectActiveRetryPass = db.prepare<[string, string], RetryPassRow>(`
    SELECT id, group_id, message_id, settings_revision, state, source_before_json, targets_json
    FROM retry_passes WHERE group_id = ? AND message_id = ? AND state = 'active' LIMIT 1
  `);
  const selectRetryPass = db.prepare<string, RetryPassRow>(`
    SELECT id, group_id, message_id, settings_revision, state, source_before_json, targets_json
    FROM retry_passes WHERE id = ?
  `);
  const selectActiveRetryPasses = db.prepare<[], RetryPassRow>(`
    SELECT id, group_id, message_id, settings_revision, state, source_before_json, targets_json
    FROM retry_passes WHERE state = 'active'
  `);
  const selectActiveRetryPassesForGroup = db.prepare<string, RetryPassRow>(`
    SELECT id, group_id, message_id, settings_revision, state, source_before_json, targets_json
    FROM retry_passes WHERE group_id = ? AND state = 'active'
  `);
  const updateRetryPassState = db.prepare("UPDATE retry_passes SET state = ? WHERE id = ? AND state = 'active'");
  const insertRetryConfirmation = db.prepare('INSERT OR IGNORE INTO retry_confirmation_messages (message_id) VALUES (?)');
  const insertReference = db.prepare('INSERT OR IGNORE INTO relay_references (group_id, message_id, reference) VALUES (?, ?, ?)');
  const selectReference = db.prepare<[string, string], { reference: string }>('SELECT reference FROM relay_references WHERE group_id = ? AND message_id = ?');
  const ensureReference = (groupId: string, messageId: string) => {
    while (!selectReference.get(groupId, messageId)) insertReference.run(groupId, messageId, `W-${randomBytes(16).toString('hex').toUpperCase()}`);
    return selectReference.get(groupId, messageId)!.reference;
  };
  const readSource = (state: string, groupId: string, messageId: string): RelaySource => {
    let source: RelaySource;
    try { source = JSON.parse(state) as RelaySource; }
    catch { throw new UnsupportedRelayStateError('Durable source state is invalid or unsupported'); }
    validateRelaySource(source);
    if (source.groupId !== groupId || source.messageId !== messageId) throw new UnsupportedRelayStateError('Durable source identity does not match its record');
    return { ...source, workReference: ensureReference(groupId, messageId) };
  };
  const acceptSource = db.transaction((source: RelaySource) => {
    validateRelaySource(source);
    const existing = selectRelaySource.get(source.groupId, source.messageId);
    if (existing) { readSource(existing.state, source.groupId, source.messageId); return; }
    insertRelaySource.run(source.groupId, source.messageId, serializeRelaySource(source));
    ensureReference(source.groupId, source.messageId);
  });

  const insertDefaultSettings = db.prepare(`
    INSERT OR IGNORE INTO group_settings (group_id, enabled, max_file_size_mb, duplicate_window_hours)
    VALUES (?, 0, ?, ?)
  `);
  const selectSettings = db.prepare<string, GroupSettingsRow>(`
    SELECT group_id, enabled, max_file_size_mb, duplicate_window_hours
    FROM group_settings
    WHERE group_id = ?
  `);
  const selectSettingsRevision = db.prepare<string, GroupSettingsVersionRow>('SELECT settings_revision FROM group_settings WHERE group_id = ?');
  const selectSettingsForRetry = db.prepare<string, { enabled: number; max_file_size_mb: number; duplicate_window_hours: number; settings_revision: number }>(`
    SELECT enabled, max_file_size_mb, duplicate_window_hours, settings_revision FROM group_settings WHERE group_id = ?
  `);
  const updateEnabled = db.prepare(`
    UPDATE group_settings
    SET settings_revision = settings_revision + CASE WHEN enabled != ? THEN 1 ELSE 0 END, enabled = ?
    WHERE group_id = ?
  `);
  const updateGroupSettings = db.prepare(`
    UPDATE group_settings
    SET max_file_size_mb = ?, duplicate_window_hours = ?, settings_revision = settings_revision + 1
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
  const selectMediaAttempt = db.prepare<[string, string, string], MediaAttempt>(`
    SELECT status, sent_message_id AS sentMessageId, ack, source_url AS sourceUrl FROM media_relay_attempts
    WHERE group_id = ? AND message_id = ? AND media_key = ?
  `);
  const updateMediaEvidence = db.prepare(`
    UPDATE media_relay_attempts SET sent_message_id = ?, ack = ?
    WHERE group_id = ? AND message_id = ? AND media_key = ? AND status = 'sending'
      AND (sent_message_id IS NULL OR sent_message_id = ?)
  `);
  const selectMediaConfirmation = db.prepare<[string, string], { confirmedAtMs: number | null }>(`
    SELECT max(confirmed_at_ms) AS confirmedAtMs FROM media_relay_attempts
    WHERE group_id = ? AND media_key = ? AND status = 'confirmed'
  `);
  const updateMediaConfirmation = db.prepare(`
    UPDATE media_relay_attempts SET status = 'confirmed', confirmed_at_ms = ?, sent_message_id = ?, ack = ?
    WHERE group_id = ? AND message_id = ? AND media_key = ? AND source_url = ? AND status = 'sending'
      AND (sent_message_id IS NULL OR sent_message_id = ?)
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
  const compensateRetryPass = (pass: RetryPassRow): void => {
    const stateRow = selectRelaySource.get(pass.group_id, pass.message_id);
    if (stateRow) {
      let current: RelaySource;
      try {
        current = JSON.parse(stateRow.state) as RelaySource;
        validateRelaySource(current);
        if (current.groupId !== pass.group_id || current.messageId !== pass.message_id) throw new UnsupportedRelayStateError('Retry source identity is unsupported');
      } catch {
        // Unsupported snapshots remain untouched and cannot enter normal recovery.
        updateRetryPassState.run('revoked', pass.id);
        return;
      }
      // Damaged grant metadata must not release a supported retry-activated source to ordinary recovery.
      const before = JSON.parse(pass.source_before_json) as RelaySource;
      const targets = JSON.parse(pass.targets_json) as RetryPassTarget[];
      validateRelaySource(before);
      if (before.groupId !== pass.group_id || before.messageId !== pass.message_id || !Array.isArray(targets) || !targets.length
        || targets.some((target) => !Number.isSafeInteger(target.linkIndex) || !current.links[target.linkIndex]?.plan
          || !Array.isArray(target.itemIndexes) || !target.itemIndexes.length
          || target.itemIndexes.some((index) => !Number.isSafeInteger(index) || !current.links[target.linkIndex].plan!.items.some((item) => item.index === index)))) {
        throw new UnsupportedRelayStateError('Retry grant metadata is unsupported');
      }
      let unknown = false;
      for (const target of targets) {
        const link = current.links[target.linkIndex];
        if (!link?.plan) continue;
        for (const itemIndex of target.itemIndexes) {
          const item = link.plan.items.find((candidate) => candidate.index === itemIndex);
          if (!item?.identity) continue;
          const attempt = selectMediaAttempt.get(pass.group_id, pass.message_id, mediaIdentityKey(item.identity));
          if (attempt?.status === 'confirmed') item.status = 'confirmed';
          else if (attempt?.status === 'sending') { item.status = 'held'; unknown = true; }
          else if (item.status === 'held') unknown = true;
          else if (item.status !== 'confirmed' && item.status !== 'skipped') item.status = 'failed';
        }
        if (link.status !== 'skipped') link.status = 'ready';
      }
      current.status = unknown ? 'held' : before.status === 'ready' ? 'settled' : before.status;
      if (unknown) current.holdReason = 'retry-interrupted-with-unknown-send';
      else if (before.holdReason) current.holdReason = before.holdReason;
      else delete current.holdReason;
      updateRelaySource.run(serializeRelaySource(current), pass.group_id, pass.message_id);
    }
    updateRetryPassState.run('revoked', pass.id);
  };
  const revokePass = db.transaction((id: string) => {
    const pass = selectRetryPass.get(id);
    if (pass?.state === 'active') compensateRetryPass(pass);
  });
  const revokeActivePasses = db.transaction((groupId?: string) => {
    const passes = groupId ? selectActiveRetryPassesForGroup.all(groupId) : selectActiveRetryPasses.all();
    for (const pass of passes) compensateRetryPass(pass);
  });
  const admitPass = db.transaction((admission: RetryPassAdmission): ReturnType<Store['admitRetryPass']> => {
    const { sourceBefore, sourceAfter, groupId, messageId, settingsRevision, targets } = admission;
    if (!admission.id.trim() || !Number.isSafeInteger(admission.createdAtMs)
      || sourceBefore.groupId !== groupId || sourceBefore.messageId !== messageId
      || sourceAfter.groupId !== groupId || sourceAfter.messageId !== messageId || !targets.length) return 'stale';
    validateRelaySource(sourceBefore);
    validateRelaySource(sourceAfter);
    const settings = selectSettingsForRetry.get(groupId);
    const current = selectRelaySource.get(groupId, messageId);
    if (!settings?.enabled || settings.settings_revision !== settingsRevision || !current
       || serializeRelaySource(readSource(current.state, groupId, messageId)) !== serializeRelaySource(sourceBefore)) return 'stale';
    if (selectActiveRetryPass.get(groupId, messageId)) return 'active';
    const requestedItems = new Set(targets.flatMap((target) => target.itemIndexes.map((itemIndex) => `${target.linkIndex}:${itemIndex}`)));
    if (requestedItems.size !== targets.reduce((count, target) => count + target.itemIndexes.length, 0)) return 'stale';
    const currentlyEligible = new Set<string>();
    for (const [linkIndex, previousLink] of sourceBefore.links.entries()) {
      const link = sourceAfter.links[linkIndex];
      if (!link?.plan || previousLink.status === 'skipped') continue;
      if (previousLink.plan) {
        for (const item of previousLink.plan.items) {
          if (item.kind !== 'video' || !item.identity || !['ready', 'failed'].includes(item.status)) continue;
          if (selectMediaAttempt.get(groupId, messageId, mediaIdentityKey(item.identity))) continue;
          const key = { groupId, messageId, identity: item.identity };
          if (getMediaDisposition(key, admission.createdAtMs, settings.duplicate_window_hours) === 'ready') currentlyEligible.add(`${linkIndex}:${item.index}`);
        }
      } else {
        if (!['ready', 'failed'].includes(previousLink.status)) continue;
        if (settings.duplicate_window_hours > 0) {
          const duplicate = selectDuplicate.get(groupId, previousLink.urlHash);
          if (duplicate && duplicate.created_at_ms <= admission.createdAtMs
            && admission.createdAtMs - duplicate.created_at_ms <= settings.duplicate_window_hours * 60 * 60 * 1000) continue;
        }
        for (const item of link.plan.items) {
          if (item.kind !== 'video' || !item.identity) continue;
          const key = { groupId, messageId, identity: item.identity };
          if (!selectMediaAttempt.get(groupId, messageId, mediaIdentityKey(item.identity))
            && getMediaDisposition(key, admission.createdAtMs, settings.duplicate_window_hours) === 'ready') currentlyEligible.add(`${linkIndex}:${item.index}`);
        }
      }
    }
    if (requestedItems.size !== currentlyEligible.size || [...requestedItems].some((key) => !currentlyEligible.has(key))) return 'stale';
    for (const target of targets) {
      const link = sourceAfter.links[target.linkIndex];
      const previousLink = sourceBefore.links[target.linkIndex];
      if (!link?.plan || !previousLink || !target.itemIndexes.length) return 'stale';
      if (link.plan.items.some((item) => target.itemIndexes.includes(item.index) && item.status !== 'ready')) return 'stale';
      for (const itemIndex of target.itemIndexes) {
        const item = link.plan.items.find((candidate) => candidate.index === itemIndex);
        if (!item?.identity || selectMediaAttempt.get(groupId, messageId, mediaIdentityKey(item.identity))) return 'stale';
        if (getMediaDisposition({ groupId, messageId, identity: item.identity }, admission.createdAtMs, settings.duplicate_window_hours) !== 'ready') return 'stale';
      }
      if (settings.duplicate_window_hours > 0 && !previousLink.plan) {
        const duplicate = selectDuplicate.get(groupId, previousLink.urlHash);
        if (duplicate && duplicate.created_at_ms <= admission.createdAtMs
          && admission.createdAtMs - duplicate.created_at_ms <= settings.duplicate_window_hours * 60 * 60 * 1000) return 'stale';
      }
    }
    insertRetryPass.run(admission.id, groupId, messageId, settingsRevision, serializeRelaySource(sourceBefore), JSON.stringify(targets), admission.createdAtMs);
    updateRelaySource.run(serializeRelaySource(sourceAfter), groupId, messageId);
    return 'admitted';
  });
  const beginMediaRepost = db.transaction((key: MediaRepostKey, record: RepostRecord, windowHours: number, guard?: RetryReservationGuard): ReturnType<Store['beginMediaRepost']> => {
    if (record.groupId !== key.groupId || !key.groupId.trim() || !key.messageId.trim()) throw new Error('Media send requires matching group and source identities');
    if (!Number.isSafeInteger(record.createdAtMs)) throw new Error('Media send timestamp is invalid');
    if (guard) {
      const settings = selectSettingsForRetry.get(key.groupId);
      if (!settings?.enabled || settings.settings_revision !== guard.settingsRevision || selectRetryPass.get(guard.retryPassId)?.state !== 'active') return 'held';
    } else if (selectActiveRetryPass.get(key.groupId, key.messageId)) return 'held';
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
      key.groupId, key.messageId, mediaIdentityKey(key.identity), record.url, confirmation.messageId);
    if (!changed.changes) throw new Error('Media send reservation is missing or already confirmed');
    insertRepost.run(record.groupId, record.senderId, record.url, record.urlHash, record.createdAtMs);
  });

  // Explicit retry permission never survives process restart. Preserve any crossed send intents while revoking unsubmitted work.
  try { revokeActivePasses(); }
  catch (error) { db.close(); throw error; }

  return {
    acceptRelaySource(source) {
      acceptSource(source);
    },

    getRelaySource(groupId, messageId) {
      const row = selectRelaySource.get(groupId, messageId);
      if (!row) return null;
      return readSource(row.state, groupId, messageId);
    },

    saveRelaySource(source) {
      validateRelaySource(source);
      if (!updateRelaySource.run(serializeRelaySource(source), source.groupId, source.messageId).changes) {
        throw new Error('Durable source is missing');
      }
    },

    listRelaySources() {
      const sources: RelaySource[] = [];
      for (const row of selectRelaySources.all()) {
        // Unsupported/corrupt records remain untouched, never submitted, and cannot block valid work.
        let source: RelaySource;
        try {
          source = JSON.parse(row.state) as RelaySource;
          validateRelaySource(source);
          if (source.groupId !== row.groupId || source.messageId !== row.messageId) continue;
        } catch { continue; }
        sources.push({ ...source, workReference: ensureReference(row.groupId, row.messageId) });
      }
      return sources;
    },

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

    getGroupSettingsRevision(groupId) {
      insertDefaultSettings.run(groupId, maxFileSizeMb, duplicateWindowHours);
      return selectSettingsRevision.get(groupId)?.settings_revision ?? 0;
    },

    setGroupSettings(groupId, values) {
      const keys = Object.keys(values);
      if (!keys.length || keys.some((key) => !['maxFileSizeMb', 'duplicateWindowHours'].includes(key))) throw new Error('Group settings update is invalid');
      if (values.maxFileSizeMb !== undefined && (!Number.isSafeInteger(values.maxFileSizeMb) || values.maxFileSizeMb < 1)) throw new Error('Maximum media size must be a positive integer');
      if (values.duplicateWindowHours !== undefined && (!Number.isSafeInteger(values.duplicateWindowHours) || values.duplicateWindowHours < 0 || values.duplicateWindowHours > 720)) throw new Error('Duplicate window must be a whole number from 0 to 720');
      insertDefaultSettings.run(groupId, maxFileSizeMb, duplicateWindowHours);
      const current = selectSettings.get(groupId);
      if (!current) throw new Error(`Group settings not found for ${groupId}`);
      const nextMax = values.maxFileSizeMb ?? current.max_file_size_mb;
      const nextWindow = values.duplicateWindowHours ?? current.duplicate_window_hours;
      if (nextMax === current.max_file_size_mb && nextWindow === current.duplicate_window_hours) return false;
      revokeActivePasses(groupId);
      updateGroupSettings.run(nextMax, nextWindow, groupId);
      return true;
    },

    setGroupEnabled(groupId, enabled) {
      insertDefaultSettings.run(groupId, maxFileSizeMb, duplicateWindowHours);
      if (!enabled) revokeActivePasses(groupId);
      updateEnabled.run(enabled ? 1 : 0, enabled ? 1 : 0, groupId);
    },

    claimRetryConfirmation(messageId) {
      if (!messageId.trim()) return false;
      return Boolean(insertRetryConfirmation.run(messageId).changes);
    },

    admitRetryPass(admission) {
      return admitPass.immediate(admission);
    },

    isRetryPassActive(id) {
      return selectRetryPass.get(id)?.state === 'active';
    },

    hasActiveRetryPass(groupId, messageId) {
      return Boolean(selectActiveRetryPass.get(groupId, messageId));
    },

    completeRetryPass(id) {
      updateRetryPassState.run('completed', id);
    },

    revokeRetryPass(id) {
      revokePass(id);
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

    getMediaAttempt(key) {
      return selectMediaAttempt.get(key.groupId, key.messageId, mediaIdentityKey(key.identity)) ?? null;
    },

    recordMediaEvidence(key, evidence) {
      if (!evidence.messageId.trim() || (evidence.ack !== null && (!Number.isInteger(evidence.ack) || evidence.ack < -1 || evidence.ack > 4))) {
        throw new Error('Repost evidence is invalid');
      }
      if (!updateMediaEvidence.run(evidence.messageId, evidence.ack, key.groupId, key.messageId,
        mediaIdentityKey(key.identity), evidence.messageId).changes) throw new Error('Repost evidence has no matching pending attempt');
    },

    countReposts() {
      return selectRepostCount.get()?.count ?? 0;
    },

    close() {
      db.close();
    },
  };
}
