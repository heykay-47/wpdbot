import { appendFileSync } from 'node:fs';
import { relayContentHash } from '../../src/relay.js';
import { createStore } from '../../src/store.js';

const [path, marker, stage] = process.argv.slice(2);
const groupId = 'group@g.us';
const messageId = 'source-1';
const senderId = 'sender@c.us';
const url = 'https://youtube.com/shorts/AbCdEf123_-';
const body = url;
const identity = { platform: 'youtube' as const, videoId: 'AbCdEf123_-' };
const store = createStore(path);
store.setGroupEnabled(groupId, true);
store.acceptRelaySource({
  version: 2, groupId, messageId, senderId, senderName: 'Sender', timestampMs: 1_000,
  acceptedAtMs: 2_000, contentHash: relayContentHash(body), status: 'settled',
  cleanup: { version: 1, initial: 'link-only', initialFingerprint: relayContentHash(body),
    disqualifications: [], intentRecorded: false, outcome: 'not-attempted', noticeClaimed: false },
  links: [{ url, platform: 'youtube', urlHash: 'url-hash', status: 'ready', plan: {
    parentId: identity.videoId, totalItems: 1,
    items: [{ index: 1, kind: 'video', identity, status: 'confirmed' }],
  } }],
});
const key = { groupId, messageId, identity };
const record = { groupId, senderId, url, urlHash: 'url-hash', createdAtMs: 2_100 };
if (store.beginMediaRepost(key, record, 24, undefined, 'video') !== 'started') throw new Error('Synthetic video intent failed');
store.confirmMediaRepost(key, { messageId: 'repost-1', ack: 1 }, record);

const checkpoint = () => {
  process.send?.('checkpoint');
  return new Promise<never>(() => undefined);
};

if (stage === 'cleanup-pre-intent') await checkpoint();
else {
  const source = store.getRelaySource(groupId, messageId)!;
  if (!store.beginRelaySourceCleanup(source)) throw new Error('Synthetic cleanup intent failed');
  if (stage === 'cleanup-after-invocation') appendFileSync(marker, 'deleted\n');
  await checkpoint();
}
