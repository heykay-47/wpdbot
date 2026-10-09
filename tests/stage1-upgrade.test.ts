import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createStore } from '../src/store';
import type { RelaySource } from '../src/relayState';

it('preserves the complete legacy/current evidence fixture through upgrade and two reopens', () => {
  const dir = mkdtempSync('/tmp/opencode/wpdbot-stage1-upgrade-');
  const path = join(dir, 'bot.db');
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
    initial.close();
    const db = new Database(path);
    db.exec('DROP TABLE relay_references; UPDATE group_settings SET max_file_size_mb=999, duplicate_window_hours=999;');
    db.prepare('INSERT INTO relay_sources VALUES(?,?,?)').run('group', 'source', JSON.stringify(source));
    const tables = ['group_settings', 'duplicate_urls', 'repost_history', 'bot_identity', 'media_relay_attempts', 'instagram_relay_items', 'relay_sources'];
    const before = Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    db.close();
    let reference;
    for (let open = 0; open < 3; open++) {
      const store = createStore(path);
      reference ??= store.getRelaySource('group', 'source')!.workReference;
      expect(store.getRelaySource('group', 'source')!.workReference).toBe(reference);
      expect(store.getMediaDisposition(confirmed, 999999999, 0)).toBe('completed');
      expect(store.getMediaDisposition({ ...confirmed, messageId: 'later', identity: { platform: 'youtube', videoId: 'Another123_' } }, 999999999, 0)).toBe('held');
      expect(store.getMediaDisposition({ groupId: 'group', messageId: 'later', identity: { platform: 'instagram', postId: 'post', itemId: 'held-item' } }, 999999999, 0)).toBe('held');
      store.close();
      const check = new Database(path);
      for (const table of tables) expect(check.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).toEqual(before[table]);
      expect(check.prepare('SELECT confirmed_at_ms FROM media_relay_attempts WHERE message_id=?').get('unknown')).toEqual({ confirmed_at_ms: null });
      check.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
