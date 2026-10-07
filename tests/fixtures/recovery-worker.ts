import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleIncomingMessage } from '../../src/relay.js';
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
