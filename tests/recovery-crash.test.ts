import { fork } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { recoverRelaySources } from '../src/relay';
import { createStore, type Store } from '../src/store';

const roots: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores.length = 0;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

it.each(['accepted', 'plan', 'intent', 'evidence', 'confirmed'] as const)('recovers safely after actual process loss at the %s boundary with a mocked external sender', async (stage) => {
  const root = mkdtempSync(join(tmpdir(), 'wpdbot-crash-'));
  roots.push(root);
  const path = join(root, 'bot.sqlite');
  const child = fork(new URL('./fixtures/recovery-worker.ts', import.meta.url), [path, root, stage], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Worker did not reach checkpoint: ${stderr}`)), 10_000);
      child.once('message', () => { clearTimeout(timer); resolve(); });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`Worker exited before checkpoint: ${stderr}`)); });
    });
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
  const store = createStore(path);
  stores.push(store);
  const filePath = join(root, 'recovered.mp4');
  writeFileSync(filePath, 'synthetic video');
  const sendVideoOnce = vi.fn(async () => ({ messageId: 'recovered-repost', ack: 1 }));
  const lookupRepost = vi.fn(async () => null);
  await recoverRelaySources({ store, timezone: 'UTC', nowMs: 3_000, cleanupPath: async () => undefined,
    downloader: {
      download: vi.fn(), resolveInstagram: vi.fn(),
      resolveYouTube: async (url) => ({ id: url.split('/').at(-1)!, download: async () => ({ filePath, sizeBytes: 15 }) }),
    },
    whatsapp: {
      sendVideo: vi.fn(), deleteMessage: vi.fn(), sendText: vi.fn(async () => undefined), sendVideoOnce, lookupRepost,
      getSourceMessage: async () => ({ id: 'source-1', groupId: 'group@g.us', senderId: 'sender@c.us', senderName: 'Sender',
        body: 'https://youtube.com/shorts/AbCdEf123_- https://youtube.com/shorts/Another123_', timestampMs: 1_000, isGroup: true, fromMe: false }),
    },
  });
  expect(sendVideoOnce).toHaveBeenCalledTimes(stage === 'accepted' || stage === 'plan' ? 2 : 1);
  expect(store.countReposts()).toBe(stage === 'intent' || stage === 'evidence' ? 1 : 2);
  if (stage === 'evidence') expect(lookupRepost).toHaveBeenCalledWith('group@g.us', 'pending-1');
  if (stage === 'intent' || stage === 'evidence') expect(store.getMediaDisposition({ groupId: 'group@g.us', messageId: 'other-source',
    identity: { platform: 'youtube', videoId: 'AbCdEf123_-' } }, 999_999_999, 0)).toBe('held');
});

it.each(['SIGINT', 'SIGTERM'] as const)('handles %s gracefully during pre-send work while preserving its durable plan', async (signal) => {
  const root = mkdtempSync(join(tmpdir(), 'wpdbot-signal-'));
  roots.push(root);
  const path = join(root, 'bot.sqlite');
  const child = fork(new URL('./fixtures/recovery-worker.ts', import.meta.url), [path, root, 'signal'], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal }));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Signal worker did not reach checkpoint: ${stderr}`)), 10_000);
      child.once('message', () => { clearTimeout(timer); resolve(); });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`Signal worker exited before checkpoint: ${stderr}`)); });
    });
    child.kill(signal);
    expect(await exited).toEqual({ code: 0, signal: null });
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
  const store = createStore(path);
  stores.push(store);
  expect(store.countReposts()).toBe(0);
  expect(store.getRelaySource('group@g.us', 'source-1')?.links[0].plan?.items[0].status).toBe('ready');
});
