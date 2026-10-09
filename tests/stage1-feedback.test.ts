import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { handleIncomingMessage, recoverRelaySources } from '../src/relay';
import { createStore } from '../src/store';
import Database from 'better-sqlite3';
import { RelayLifecycle } from '../src/relayLifecycle';

const message = { id: 'source', groupId: 'group', senderId: 'sender', senderName: 'Name', timestampMs: 100, isGroup: true, fromMe: false,
  body: 'https://youtube.com/shorts/AbCdEf123_- https://youtube.com/shorts/Another123_ https://youtube.com/shorts/Third123456' };

it.each(['pre-send', 'unknown'])('mixed-source %s feedback includes protected successes and never leaks private data', async (failure) => {
  const root = mkdtempSync('/tmp/opencode/wpdbot-stage1-feedback-');
  const store = createStore(':memory:');
  const file = join(root, 'video.mp4'); writeFileSync(file, 'v');
  store.setGroupEnabled(message.groupId, true);
  const texts: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const whatsapp = { sendVideo: vi.fn(), deleteMessage: vi.fn(),
    sendText: vi.fn(async (_group: string, text: string) => { texts.push(text); }),
    sendVideoOnce: vi.fn(async (_group: string, _path: string, caption: string) => {
      if (failure === 'unknown' && caption.includes('Another123_')) throw new Error('PRIVATE-CANARY');
      return { messageId: caption.includes('Third123456') ? 'sent-C' : 'sent-A', ack: 1 };
    }) };
  const input = { message, store, whatsapp, timezone: 'UTC', nowMs: 200, cleanupPath: async () => undefined,
    logger: (entry: Record<string, unknown>) => { logs.push(entry); throw new Error('PRIVATE-REPORTER-CANARY'); },
    downloader: { download: vi.fn(), resolveInstagram: vi.fn(), resolveYouTube: async (url: string) => ({ id: url.split('/').at(-1)!,
      download: async () => {
        if (failure === 'pre-send' && url.includes('Another123_')) throw Object.assign(new Error('PRIVATE-DOWNLOADER-CANARY'), { statusCode: 429, exitCode: 1 });
        return { filePath: file, sizeBytes: 1 };
      } }) } };
  try {
    await handleIncomingMessage(input);
    expect(whatsapp.sendVideoOnce).toHaveBeenCalledTimes(failure === 'pre-send' ? 2 : 3);
    expect(store.countReposts()).toBe(2);
    expect(texts.at(-1)).toContain('Link 1, item 1 — confirmed');
    expect(texts.at(-1)).toContain('Link 3, item 1 — confirmed');
    expect(texts.at(-1)).toContain(failure === 'pre-send' ? 'failed before send' : 'delivery unknown');
    expect(texts.join('')).not.toMatch(/PRIVATE|https:|sender|group/u);
    expect(JSON.stringify(logs)).not.toMatch(/PRIVATE|https:|sender|group/u);
    if (failure === 'pre-send') expect(logs[0]).toMatchObject({ cause: 'rate_limited', httpStatus: 429, exitCode: 1 });
    if (failure === 'unknown') {
      const count = logs.length;
      await handleIncomingMessage(input);
      await handleIncomingMessage(input);
      expect(logs).toHaveLength(count);
      expect(whatsapp.sendVideoOnce).toHaveBeenCalledTimes(3);
    }
  } finally { store.close(); rmSync(root, { force: true, recursive: true }); }
});

it.each(['stale', 'missing', 'changed'])('records one bounded %s source-hold transition, not every recovery pass', async (mode) => {
  const store = createStore(':memory:');
  store.setGroupEnabled(message.groupId, true);
  const logger = vi.fn();
  const whatsapp = { sendVideo: vi.fn(), sendVideoOnce: vi.fn(), deleteMessage: vi.fn(), sendText: vi.fn(async () => undefined),
    lookupRepost: vi.fn(async () => null), getSourceMessage: vi.fn(async () => mode === 'missing' ? null : { ...message, body: `${message.body} changed` }) };
  const downloader = { download: vi.fn(), resolveYouTube: vi.fn(), resolveInstagram: vi.fn() };
  try {
    await handleIncomingMessage({ message, store, whatsapp, downloader, timezone: 'UTC', nowMs: 200, queue: { run: async () => undefined } });
    const input = { store, whatsapp, downloader, timezone: 'UTC', nowMs: mode === 'stale' ? 200 + 24 * 60 * 60 * 1000 + 1 : 300, logger };
    await recoverRelaySources(input);
    await recoverRelaySources(input);
    await recoverRelaySources(input);
    expect(logger).toHaveBeenCalledOnce();
    expect(logger).toHaveBeenCalledWith(expect.objectContaining({ stage: 'recovery', cause: mode === 'stale' ? 'age_held' : 'source_unavailable', reference: expect.stringMatching(/^W-[A-F0-9]{32}$/u) }));
    expect(whatsapp.sendVideoOnce).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.mock.calls)).not.toMatch(/https:|sender|group|changed/u);
  } finally { store.close(); }
});

it.each(['unsupported', 'corrupt'])('%s source redelivery remains isolated and cannot stop unrelated supported intake', async (kind) => {
  const root = mkdtempSync('/tmp/opencode/wpdbot-stage1-held-intake-');
  const path = join(root, 'bot.db');
  const store = createStore(path);
  const control = new RelayLifecycle();
  store.setGroupEnabled(message.groupId, true);
  const raw = kind === 'corrupt' ? '{PRIVATE-CORRUPT' : JSON.stringify({ version: 999, private: 'PRIVATE-FUTURE-STATE' });
  const db = new Database(path);
  db.prepare('INSERT INTO relay_sources VALUES(?,?,?)').run(message.groupId, message.id, raw);
  db.close();
  const filePath = join(root, 'video.mp4'); writeFileSync(filePath, 'v');
  const logger = vi.fn();
  const whatsapp = { sendVideo: vi.fn(), sendVideoOnce: vi.fn(async () => ({ messageId: 'sent', ack: 1 })), deleteMessage: vi.fn(), sendText: vi.fn(async () => undefined) };
  const downloader = { download: vi.fn(), resolveInstagram: vi.fn(), resolveYouTube: vi.fn(async () => ({ id: 'AbCdEf123_-', download: async () => ({ filePath, sizeBytes: 1 }) })) };
  try {
    await handleIncomingMessage({ message, store, control, logger, whatsapp, downloader, timezone: 'UTC', nowMs: 200 });
    expect(control.canSubmit()).toBe(true);
    expect(whatsapp.sendVideoOnce).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith(expect.objectContaining({ cause: 'unsupported_state' }));
    await handleIncomingMessage({ message: { ...message, id: 'unrelated', body: message.body.split(' ')[0] }, store, control, logger, whatsapp, downloader,
      timezone: 'UTC', nowMs: 300, cleanupPath: async () => undefined });
    expect(whatsapp.sendVideoOnce).toHaveBeenCalledOnce();
    expect(store.countReposts()).toBe(1);
    expect(control.canSubmit()).toBe(true);
    const check = new Database(path);
    expect(check.prepare('SELECT state_json FROM relay_sources WHERE message_id=?').get(message.id)).toEqual({ state_json: raw });
    expect(check.prepare('SELECT reference FROM relay_references WHERE message_id=?').get(message.id)).toBeUndefined();
    check.close();
    expect(JSON.stringify(logger.mock.calls)).not.toContain('PRIVATE');
  } finally { store.close(); rmSync(root, { force: true, recursive: true }); }
});
