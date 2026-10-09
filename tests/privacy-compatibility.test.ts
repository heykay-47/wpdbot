import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createStore } from '../src/store';
import type { RelaySource } from '../src/relayState';
import { formatGroupInspection, formatSourceInspection } from '../src/inspection';
import { acquireAuthLock } from '../src/authLock';

const source: RelaySource = {
  version: 1, groupId: 'private-group', messageId: 'private-source', senderId: 'private-sender', senderName: 'private-name',
  timestampMs: 100, acceptedAtMs: 200, contentHash: 'a'.repeat(64), status: 'settled', cleanup: 'retained',
  links: [{ platform: 'youtube', url: 'https://youtube.com/shorts/AbCdEf123_-', urlHash: 'private-hash', status: 'ready',
    plan: { parentId: 'AbCdEf123_-', totalItems: 1, items: [{ index: 1, kind: 'video', status: 'failed', identity: { platform: 'youtube', videoId: 'AbCdEf123_-' } }] } }],
};

it('upgrades legacy/current state and reopens twice without inventing evidence or touching unsupported rows', () => {
  const dir = mkdtempSync('/tmp/opencode/wpdbot-privacy-state-');
  const path = join(dir, 'state.db');
  try {
    const db = new Database(path);
    db.exec(`CREATE TABLE relay_sources(group_id TEXT, message_id TEXT, state_json TEXT, PRIMARY KEY(group_id,message_id));
      CREATE TABLE group_settings(group_id TEXT PRIMARY KEY, enabled INTEGER, max_file_size_mb INTEGER, duplicate_window_hours INTEGER);
      INSERT INTO group_settings VALUES ('private-group',1,999,999);`);
    const insert = db.prepare('INSERT INTO relay_sources VALUES(?,?,?)');
    insert.run(source.groupId, source.messageId, JSON.stringify(source));
    const unsupported = JSON.stringify({ ...source, messageId: 'future', version: 999 });
    insert.run(source.groupId, 'future', unsupported);
    insert.run(source.groupId, 'corrupt', '{private');
    db.close();
    let reference: string | undefined;
    for (let reopen = 0; reopen < 3; reopen++) {
      const store = createStore(path);
      try {
        const saved = store.getRelaySource(source.groupId, source.messageId)!;
        if (!reference) reference = saved.workReference;
        expect(saved).toEqual({ ...source, workReference: reference });
        expect(reference).toMatch(/^W-[A-F0-9]{32}$/u);
        expect(store.getGroupSettings(source.groupId)).toMatchObject({ enabled: true, maxFileSizeMb: 999, duplicateWindowHours: 999 });
        expect(store.listRelaySources()).toEqual([saved]);
        expect(formatGroupInspection(store, source.groupId)).toContain('1 sources');
        expect(formatGroupInspection(store, 'foreign-group')).not.toContain(reference);
        const text = formatSourceInspection(store, saved);
        expect(text).toContain('failed before send; cause unavailable');
        expect(text).not.toContain('private-');
        expect(text).not.toContain('https:');
        expect(store.countReposts()).toBe(0);
      } finally { store.close(); }
      const check = new Database(path);
      expect(check.prepare('SELECT state_json FROM relay_sources WHERE message_id=?').get('future')).toEqual({ state_json: unsupported });
      expect(check.prepare('SELECT state_json FROM relay_sources WHERE message_id=?').get('private-source')).toEqual({ state_json: JSON.stringify(source) });
      check.close();
    }
    const store = createStore(path);
    try {
      store.acceptRelaySource({ ...source, messageId: 'equivalent' });
      expect(store.getRelaySource(source.groupId, 'equivalent')!.workReference).not.toBe(reference);
      store.acceptRelaySource({ ...source, acceptedAtMs: 900 });
      expect(store.getRelaySource(source.groupId, source.messageId)!.workReference).toBe(reference);
    } finally { store.close(); }
  } finally { rmSync(dir, { force: true, recursive: true }); }
});

it('inspection gives pending intent priority over stale failed/ready snapshots, but preserves terminal skips', () => {
  const store = createStore(':memory:');
  try {
    store.acceptRelaySource(source);
    const saved = store.getRelaySource(source.groupId, source.messageId)!;
    store.beginMediaRepost({ groupId: source.groupId, messageId: source.messageId, identity: source.links[0].plan!.items[0].identity! },
      { groupId: source.groupId, senderId: source.senderId, url: source.links[0].url, urlHash: 'hash', createdAtMs: 300 }, 24);
    expect(formatSourceInspection(store, saved)).toContain('delivery unknown');
    expect(formatSourceInspection(store, saved)).not.toContain('failed before send');
    expect(formatGroupInspection(store, source.groupId)).toContain('delivery unknown');
    saved.links[0].plan!.items[0].status = 'skipped';
    expect(formatSourceInspection(store, saved)).toContain('skipped');
  } finally { store.close(); }
});

it('group inspection agrees with source inspection after positive evidence supersedes a failed snapshot', () => {
  const store = createStore(':memory:');
  try {
    store.acceptRelaySource(source);
    const saved = store.getRelaySource(source.groupId, source.messageId)!;
    const key = { groupId: source.groupId, messageId: source.messageId, identity: source.links[0].plan!.items[0].identity! };
    const record = { groupId: source.groupId, senderId: source.senderId, url: source.links[0].url, urlHash: 'hash', createdAtMs: 300 };
    store.beginMediaRepost(key, record, 24);
    store.confirmMediaRepost(key, { messageId: 'sent', ack: 1 }, { ...record, createdAtMs: 400 });
    expect(formatSourceInspection(store, saved)).toContain('confirmed');
    expect(formatGroupInspection(store, source.groupId)).toBe('Unfinished work in this group: 0 sources');
  } finally { store.close(); }
});

it('daemon and login cannot concurrently own one auth volume and releasing the lock preserves it', () => {
  const dir = mkdtempSync('/tmp/opencode/wpdbot-auth-lock-');
  try {
    const release = acquireAuthLock(dir);
    expect(() => acquireAuthLock(dir)).toThrow('already in use');
    release();
    const next = acquireAuthLock(dir); next();
  } finally { rmSync(dir, { force: true, recursive: true }); }
});
