import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createStore } from '../src/store';
import type { RelaySource } from '../src/relayState';

it('preserves legacy/current evidence through migration and paired quiesced restore', () => {
  const dir = mkdtempSync('/tmp/opencode/wpdbot-stage1-upgrade-');
  const path = join(dir, 'bot.db');
  const authPath = join(dir, 'auth');
  mkdirSync(join(authPath, 'session'), { recursive: true });
  writeFileSync(join(authPath, 'session', 'Default'), 'SYNTHETIC-AUTH-STATE');
  const source: RelaySource = {
    version: 1, groupId: 'group', messageId: 'source', senderId: 'sender', senderName: 'Name',
    timestampMs: 100, acceptedAtMs: 200, contentHash: 'a'.repeat(64), status: 'settled', cleanup: 'retained',
    links: [{ url: 'https://youtube.com/shorts/AbCdEf123_-', platform: 'youtube', urlHash: 'hash', status: 'ready',
      plan: { parentId: 'AbCdEf123_-', totalItems: 1, items: [{ index: 1, kind: 'video', identity: { platform: 'youtube', videoId: 'AbCdEf123_-' }, status: 'confirmed' }] } },
    { url: 'https://youtube.com/shorts/Another123_', platform: 'youtube', urlHash: 'hash2', status: 'skipped', plan: null }],
  };
  try {
    const initial = createStore(path);
    initial.setGroupEnabled('group', true);
    initial.setBotOwnerId('owner');
    const record = { groupId: 'group', senderId: 'sender', url: source.links[0].url, urlHash: 'old-hash', createdAtMs: 1000 };
    initial.recordSuccessfulRepost(record);
    const confirmed = { groupId: 'group', messageId: 'source', identity: source.links[0].plan!.items[0].identity! };
    initial.beginMediaRepost(confirmed, record, 24);
    initial.confirmMediaRepost(confirmed, { messageId: 'sent', ack: 1 }, { ...record, createdAtMs: 2000 });
    initial.beginMediaRepost({ ...confirmed, messageId: 'unknown', identity: { platform: 'youtube', videoId: 'Another123_' } }, { ...record, url: source.links[1].url }, 24);
    initial.beginInstagramItem({ groupId: 'group', messageId: 'legacy-unknown', postId: 'post', itemId: 'held-item' }, 500);
    const legacy = { groupId: 'group', messageId: 'legacy-confirmed', postId: 'post', itemId: 'done-item' };
    initial.beginInstagramItem(legacy, 600);
    initial.confirmInstagramItem(legacy, { messageId: 'legacy-sent', ack: 1 }, record);
    const currentSource: RelaySource = {
      version: 2, groupId: 'group', messageId: 'new-source', senderId: 'sender', senderName: 'Name',
      timestampMs: 100, acceptedAtMs: 300, contentHash: 'b'.repeat(64), status: 'settled',
      cleanup: { version: 1, initial: 'link-only', initialFingerprint: 'b'.repeat(64), disqualifications: [],
        intentRecorded: false, outcome: 'not-attempted', noticeClaimed: false, deferredReason: 'authority-unavailable' },
      links: [{ url: 'https://youtube.com/shorts/NewSrc12345', platform: 'youtube', urlHash: 'new-hash', status: 'ready',
        plan: { parentId: 'NewSrc12345', totalItems: 1,
          items: [{ index: 1, kind: 'video', identity: { platform: 'youtube', videoId: 'NewSrc12345' }, status: 'confirmed' }] } }],
    };
    initial.acceptRelaySource(currentSource);
    const currentKey = { groupId: 'group', messageId: 'new-source', identity: { platform: 'youtube' as const, videoId: 'NewSrc12345' } };
    const currentRecord = { groupId: 'group', senderId: 'sender', url: currentSource.links[0].url, urlHash: 'new-hash', createdAtMs: 3_000 };
    initial.beginMediaRepost(currentKey, currentRecord, 24, undefined, 'video');
    initial.confirmMediaRepost(currentKey, { messageId: 'new-sent', ack: 1 }, currentRecord);
    const cleanupUnknown: RelaySource = {
      version: 2, groupId: 'group', messageId: 'cleanup-unknown', senderId: 'sender', senderName: 'Name',
      timestampMs: 100, acceptedAtMs: 400, contentHash: 'c'.repeat(64), status: 'settled',
      cleanup: { version: 1, initial: 'link-only', initialFingerprint: 'c'.repeat(64), disqualifications: [],
        intentRecorded: true, outcome: 'unknown', noticeClaimed: false },
      links: [{ url: currentSource.links[0].url, platform: 'youtube', urlHash: 'cleanup-hash', status: 'ready',
        plan: { parentId: 'NewSrc12345', totalItems: 1,
          items: [{ index: 1, kind: 'video', identity: { platform: 'youtube', videoId: 'NewSrc12345' }, status: 'confirmed' }] } }],
    };
    initial.acceptRelaySource(cleanupUnknown);
    initial.close();
    const db = new Database(path);
    db.exec('DROP TABLE relay_references; ALTER TABLE media_relay_attempts DROP COLUMN delivery_mode; UPDATE group_settings SET max_file_size_mb=999, duplicate_window_hours=999;');
    db.prepare('INSERT INTO relay_sources VALUES(?,?,?)').run('group', 'source', JSON.stringify(source));
    const tables = ['group_settings', 'duplicate_urls', 'repost_history', 'bot_identity', 'media_relay_attempts', 'instagram_relay_items', 'relay_sources'];
    const before = Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    db.close();
    // The app and raw SQLite handle are closed: this is a quiesced same-instance pair.
    const snapshotRoot = join(dir, 'snapshot-root');
    mkdirSync(join(snapshotRoot, 'data'), { recursive: true });
    mkdirSync(join(snapshotRoot, 'app'), { recursive: true });
    copyFileSync(path, join(snapshotRoot, 'data', 'bot.db'));
    cpSync(authPath, join(snapshotRoot, 'app', '.wwebjs_auth'), { recursive: true });
    const snapshot = join(dir, 'paired-snapshot.tar.gz');
    execFileSync('tar', ['-C', snapshotRoot, '-czf', snapshot, 'data', 'app/.wwebjs_auth']);
    let reference;
    for (let open = 0; open < 3; open++) {
      const store = createStore(path);
      reference ??= store.getRelaySource('group', 'source')!.workReference;
      expect(store.getRelaySource('group', 'source')!.workReference).toBe(reference);
      expect(store.getRelaySource('group', 'source')).toMatchObject({ version: 1, cleanup: 'retained' });
      expect(store.getRelaySource('group', 'new-source')).toMatchObject({ version: 2,
        cleanup: { initial: 'link-only', intentRecorded: false, outcome: 'not-attempted', deferredReason: 'authority-unavailable' } });
      expect(store.getMediaDisposition(confirmed, 999999999, 0)).toBe('completed');
      expect(store.getMediaDisposition({ ...confirmed, messageId: 'later', identity: { platform: 'youtube', videoId: 'Another123_' } }, 999999999, 0)).toBe('held');
      expect(store.getMediaDisposition({ groupId: 'group', messageId: 'later', identity: { platform: 'instagram', postId: 'post', itemId: 'held-item' } }, 999999999, 0)).toBe('held');
      store.close();
      const check = new Database(path);
      for (const table of tables) {
        const priorRows = before[table] as Array<Record<string, unknown>>;
        const priorColumns = Object.keys(priorRows[0] ?? {});
        const currentRows = check.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Array<Record<string, unknown>>;
        expect(currentRows.map((row) => Object.fromEntries(priorColumns.map((column) => [column, row[column]]))))
          .toEqual(priorRows);
      }
      expect(check.prepare('SELECT confirmed_at_ms FROM media_relay_attempts WHERE message_id=?').get('unknown')).toEqual({ confirmed_at_ms: null });
      expect(check.prepare('SELECT delivery_mode FROM media_relay_attempts WHERE message_id=?').get('source')).toEqual({ delivery_mode: null });
      expect(check.prepare('SELECT delivery_mode FROM media_relay_attempts WHERE message_id=?').get('new-source')).toEqual({ delivery_mode: null });
      check.close();
    }

    const restored = join(dir, 'paired-restore');
    mkdirSync(restored, { recursive: true });
    execFileSync('tar', ['-xzf', snapshot, '-C', restored]);
    const restoredData = join(restored, 'data');
    const restoredAuth = join(restored, 'app', '.wwebjs_auth');
    let restoredReference: string | undefined;
    const unknownKey = { ...confirmed, messageId: 'unknown', identity: { platform: 'youtube' as const, videoId: 'Another123_' } };
    for (let reopen = 0; reopen < 3; reopen++) {
      const restoredStore = createStore(join(restoredData, 'bot.db'));
      const legacySource = restoredStore.getRelaySource('group', 'source')!;
      restoredReference ??= legacySource.workReference;
      expect(legacySource.workReference).toBe(restoredReference);
      expect(legacySource).toMatchObject({ version: 1, cleanup: 'retained' });
      expect(restoredStore.getRelaySource('group', 'new-source')).toMatchObject({ version: 2,
        cleanup: { initial: 'link-only', intentRecorded: false, outcome: 'not-attempted', deferredReason: 'authority-unavailable' } });
      expect(restoredStore.getRelaySource('group', 'cleanup-unknown')).toMatchObject({ version: 2,
        cleanup: { intentRecorded: true, outcome: 'unknown', noticeClaimed: false } });
      expect(restoredStore.getGroupSettings('group')).toEqual({
        groupId: 'group', enabled: true, maxFileSizeMb: 999, duplicateWindowHours: 999,
      });
      expect(restoredStore.getMediaAttempt(confirmed)).toMatchObject({ status: 'confirmed', sentMessageId: 'sent', ack: 1, confirmedAtMs: 2_000 });
      expect(restoredStore.getMediaDisposition(confirmed, 999_999_999, 0)).toBe('completed');
      expect(restoredStore.getMediaAttempt(unknownKey)).toMatchObject({ status: 'sending', sentMessageId: null, ack: null });
      expect(restoredStore.getMediaDisposition({ ...unknownKey, messageId: 'later' }, 999_999_999, 0)).toBe('held');
      expect(restoredStore.getInstagramItem({ groupId: 'group', messageId: 'legacy-unknown', postId: 'post', itemId: 'held-item' }))
        .toMatchObject({ status: 'sending' });
      expect(restoredStore.getInstagramItem(legacy)).toMatchObject({ status: 'confirmed', sentMessageId: 'legacy-sent', ack: 1 });
      expect(restoredStore.getMediaAttempt(currentKey)).toMatchObject({ status: 'confirmed', sentMessageId: 'new-sent', ack: 1 });
      expect(restoredStore.wasRecentlyPosted('group', 'old-hash', 1_500, 24)).toBe(true);
      expect(restoredStore.countReposts()).toBe(4);
      expect(readFileSync(join(restoredAuth, 'session', 'Default'), 'utf8')).toBe('SYNTHETIC-AUTH-STATE');
      restoredStore.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
