// Runs only in the disposable, network-disabled Docker qualification container.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createStore } from '/app/dist/store.js';
import { createHealthServer } from '/app/dist/health.js';

const dbPath = '/data/bot.db';
const authPath = '/app/.wwebjs_auth/session/Default/synthetic-auth';
const expectedPath = '/data/qualification-expected.json';
const confirmed = { groupId: 'synthetic-group', messageId: 'confirmed-source',
  identity: { platform: 'youtube', videoId: 'AbCdEf123_-' } };
const unknown = { ...confirmed, messageId: 'unknown-source',
  identity: { platform: 'youtube', videoId: 'Another123_' } };
const legacyUnknown = { groupId: 'synthetic-group', messageId: 'legacy-unknown', postId: 'post', itemId: 'held' };
const record = { groupId: 'synthetic-group', senderId: 'synthetic-sender',
  url: 'https://youtube.com/shorts/AbCdEf123_-', urlHash: 'synthetic-hash', createdAtMs: 2_000 };

function rows() {
  const db = new Database(dbPath);
  try {
    return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  } finally { db.close(); }
}

function seed() {
  assert.equal(process.getuid(), 10001);
  assert.match(readFileSync('/app/node_modules/better-sqlite3/build/better_sqlite3.target.mk', 'utf8'),
    /node-gyp\/24\.18\.0\/include\/node/, 'SQLite must use the unaffected target headers');
  console.log(`Runtime ${process.version}; SQLite compiled against Node 24.18.0 headers.`);
  const store = createStore(dbPath);
  store.setGroupEnabled('synthetic-group', true);
  store.setBotOwnerId('synthetic-owner');
  store.recordSuccessfulRepost(record);
  assert.equal(store.beginMediaRepost(confirmed, record, 24, undefined, 'video'), 'started');
  store.confirmMediaRepost(confirmed, { messageId: 'synthetic-repost', ack: 1 }, record);
  assert.equal(store.beginMediaRepost(unknown, { ...record, url: 'https://youtube.com/shorts/Another123_' }, 24), 'started');
  store.beginInstagramItem(legacyUnknown, 500);
  const source = {
    version: 1, groupId: 'synthetic-group', messageId: 'legacy-source',
    senderId: 'synthetic-sender', senderName: 'Synthetic', timestampMs: 100, acceptedAtMs: 200,
    contentHash: 'a'.repeat(64), status: 'settled', cleanup: 'retained',
    links: [{ url: record.url, platform: 'youtube', urlHash: record.urlHash, status: 'skipped', plan: null }],
  };
  store.acceptRelaySource(source);
  store.acceptRelaySource({ ...source, version: 2, messageId: 'cleanup-unknown',
    cleanup: { version: 1, initial: 'link-only', initialFingerprint: source.contentHash,
      disqualifications: [], intentRecorded: true, outcome: 'unknown', noticeClaimed: false } });
  assert.equal(store.claimRetryConfirmation('synthetic-used-confirmation'), true);
  const savedSource = store.getRelaySource('synthetic-group', 'legacy-source');
  store.close();
  const db = new Database(dbPath);
  db.exec('UPDATE group_settings SET max_file_size_mb=999, duplicate_window_hours=999');
  const insertPass = db.prepare('INSERT INTO retry_passes VALUES(?,?,?,?,?,?,?,?)');
  for (const state of ['completed', 'revoked']) {
    insertPass.run(`synthetic-${state}`, 'synthetic-group', 'legacy-source', 0, state,
      JSON.stringify(savedSource), JSON.stringify([{ linkIndex: 0, itemIndexes: [1] }]), 1_000);
  }
  db.close();
  mkdirSync('/app/.wwebjs_auth/session/Default', { recursive: true });
  writeFileSync(authPath, 'SYNTHETIC-AUTH-STATE', { mode: 0o600 });
  chmodSync(dbPath, 0o600);
  writeFileSync(expectedPath, JSON.stringify(rows()), { mode: 0o600 });
  writeFileSync('/app/.wwebjs_cache/regenerable', 'cache');
  writeFileSync('/tmp/wpdbot-downloads/regenerable', 'download');
}

function verify() {
  assert.equal(process.getuid(), 10001);
  const expected = JSON.parse(readFileSync(expectedPath, 'utf8'));
  for (let reopen = 0; reopen < 3; reopen++) {
    const store = createStore(dbPath);
    assert.deepEqual(store.getGroupSettings('synthetic-group'), {
      groupId: 'synthetic-group', enabled: true, maxFileSizeMb: 999, duplicateWindowHours: 999,
    });
    assert.equal(store.getMediaDisposition(confirmed, 999_999_999, 0), 'completed');
    assert.equal(store.getMediaDisposition({ ...unknown, messageId: 'later-source' }, 999_999_999, 0), 'held');
    assert.equal(store.getMediaDisposition({ ...unknown, messageId: 'later-source',
      identity: { platform: 'instagram', postId: 'post', itemId: 'held' } }, 999_999_999, 0), 'held');
    assert.equal(store.getMediaAttempt(confirmed).confirmedAtMs, 2_000);
    assert.equal(store.getMediaAttempt(confirmed).sentMessageId, 'synthetic-repost');
    assert.equal(store.getMediaAttempt(unknown).confirmedAtMs, null);
    assert.equal(store.getRelaySource('synthetic-group', 'legacy-source').cleanup, 'retained');
    assert.equal(store.getRelaySource('synthetic-group', 'cleanup-unknown').cleanup.intentRecorded, true);
    assert.equal(store.getRelaySource('synthetic-group', 'cleanup-unknown').cleanup.outcome, 'unknown');
    assert.equal(store.countReposts(), 2);
    assert.equal(store.claimRetryConfirmation('synthetic-used-confirmation'), false, 'Consumed retry messages stay replay-protected');
    store.close();
    assert.deepEqual(rows(), expected, 'All database rows, references, settings, history and evidence survive restore/reopens');
    assert.equal(readFileSync(authPath, 'utf8'), 'SYNTHETIC-AUTH-STATE');
    for (const path of [dbPath, authPath, '/data', '/app/.wwebjs_auth']) {
      assert.equal(statSync(path).uid, 10001, 'Restored volume ownership must allow the runtime user');
    }
    assert.equal(statSync(authPath).mode & 0o777, 0o600);
    assert.equal(statSync(dbPath).mode & 0o777, 0o600);
  }
}

switch (process.argv[2]) {
  case 'seed': seed(); break;
  case 'verify': verify(); break;
  case 'serve': {
    let store = createStore(dbPath);
    let authenticated = true;
    let ready = true;
    const health = createHealthServer(() => store.isOpen() && authenticated && ready);
    process.on('SIGUSR1', () => { ready = !ready; });
    process.on('SIGUSR2', () => { authenticated = !authenticated; });
    process.on('SIGWINCH', () => {
      if (store.isOpen()) store.close(); else store = createStore(dbPath);
    });
    const stop = async () => { await health.close(); if (store.isOpen()) store.close(); process.exit(0); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    await health.listen();
    break;
  }
  default: throw new Error('Expected seed, verify or serve');
}
