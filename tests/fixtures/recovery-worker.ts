import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { executeTargetedRetry, handleIncomingMessage, relayContentHash } from '../../src/relay.js';
import { createStore } from '../../src/store.js';
import { RelayLifecycle } from '../../src/relayLifecycle.js';

const [path, root, stage] = process.argv.slice(2);
const store = createStore(path);
store.setGroupEnabled('group@g.us', true);
const control = new RelayLifecycle();
if (stage === 'signal') {
  const { installShutdownHandlers } = await import('../../src/index.js');
  installShutdownHandlers({ stop: async () => { await control.stop(); control.close(); } }, store);
}
const checkpoint = () => {
  process.send?.('checkpoint');
  return new Promise<never>(() => undefined);
};
if (stage.startsWith('retry-')) {
  const message = { id: 'source-1', groupId: 'group@g.us', senderId: 'sender@c.us', senderName: 'Sender',
    body: 'https://youtube.com/shorts/AbCdEf123_- https://youtube.com/shorts/Another123_',
    timestampMs: 1_000, isGroup: true, fromMe: false };
  store.acceptRelaySource({ version: 1, groupId: message.groupId, messageId: message.id, senderId: message.senderId,
    senderName: message.senderName, timestampMs: message.timestampMs, acceptedAtMs: 2_000,
    contentHash: relayContentHash(message.body), status: 'settled', cleanup: 'retained',
    links: message.body.split(' ').map((url) => ({ url, platform: 'youtube', urlHash: url, status: 'ready',
      plan: { parentId: url.split('/').at(-1)!, totalItems: 1,
        items: [{ index: 1, kind: 'video', identity: { platform: 'youtube', videoId: url.split('/').at(-1)! }, status: 'failed' }] } })) });
  const before = store.getRelaySource(message.groupId, message.id)!;
  const after = structuredClone(before);
  after.status = 'ready';
  for (const link of after.links) link.plan!.items[0].status = 'ready';
  const targets = [{ linkIndex: 0, itemIndexes: [1] }, { linkIndex: 1, itemIndexes: [1] }];
  const settingsRevision = store.getGroupSettingsRevision(message.groupId);
  if (store.admitRetryPass({ id: 'crash-pass', groupId: message.groupId, messageId: message.id,
    sourceBefore: before, sourceAfter: after, targets, settingsRevision, createdAtMs: 2_001 }) !== 'admitted') throw new Error('Synthetic admission failed');
  if (stage === 'retry-admitted') await checkpoint();
  await executeTargetedRetry({ message, store, control, timezone: 'UTC', nowMs: 2_002,
    retry: { passId: 'crash-pass', settingsRevision, requesterStillAuthorized: async () => true, sourceAndPlanStillMatch: async () => true },
    downloader: { download: async () => { throw new Error('Unused downloader'); }, resolveInstagram: async () => { throw new Error('Unused Instagram'); },
      resolveYouTube: async (url) => ({ id: url.split('/').at(-1)!, download: async () => {
        const filePath = join(root, 'retry.mp4');
        writeFileSync(filePath, 'synthetic video');
        return { filePath, sizeBytes: 15 };
      } }) },
    whatsapp: { sendVideo: async () => undefined, deleteMessage: async () => undefined, sendText: async () => undefined,
      sendVideoOnce: async (_group, _path, _caption, _mode, observe) => {
        if (stage === 'retry-evidence') observe?.({ messageId: 'retry-pending', ack: 0 });
        if (stage === 'retry-confirmed') observe?.({ messageId: 'retry-confirmed', ack: 1 });
        return checkpoint();
      } },
  }, message, targets);
  throw new Error('Synthetic retry failed to reach its checkpoint');
}
await handleIncomingMessage({
  message: { id: 'source-1', groupId: 'group@g.us', senderId: 'sender@c.us', senderName: 'Sender',
    body: 'https://youtube.com/shorts/AbCdEf123_- https://youtube.com/shorts/Another123_',
    timestampMs: 1_000, isGroup: true, fromMe: false },
  store, control, timezone: 'UTC', nowMs: 2_000,
  queue: { run: async (_key, task) => stage === 'accepted' ? checkpoint() : task() },
  downloader: {
    download: async () => { throw new Error('Unused legacy downloader'); },
    resolveInstagram: async () => { throw new Error('Unused Instagram fixture'); },
    resolveYouTube: async (url) => ({ id: url.split('/').at(-1)!, download: async () => {
      if (stage === 'plan' || stage === 'signal') return checkpoint();
      const filePath = join(root, 'video.mp4');
      writeFileSync(filePath, 'synthetic video');
      return { filePath, sizeBytes: 15 };
    } }),
  },
  whatsapp: {
    sendVideo: async () => undefined, deleteMessage: async () => undefined, sendText: async () => undefined,
    sendVideoOnce: async (_group, _path, _caption, _mode, observe) => {
      if (stage === 'evidence') observe?.({ messageId: 'pending-1', ack: 0 });
      if (stage === 'confirmed') observe?.({ messageId: 'repost-1', ack: 1 });
      return checkpoint();
    },
  },
});
