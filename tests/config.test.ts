import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('parses defaults and numeric limits', () => {
    const config = loadConfig({
      BOT_OWNER_ID: '919999999999@c.us',
      SQLITE_PATH: '/data/bot.db',
    });

    expect(config.ownerId).toBe('919999999999@c.us');
    expect(config.sqlitePath).toBe('/data/bot.db');
    expect(config.timezone).toBe('Asia/Kolkata');
    expect(config.maxFileSizeMb).toBe(64);
    expect(config.duplicateWindowHours).toBe(24);
    expect(config.downloadDir).toBe('/tmp/wpdbot-downloads');
  });

  it('rejects missing owner id', () => {
    expect(() => loadConfig({ SQLITE_PATH: '/data/bot.db' })).toThrow('BOT_OWNER_ID is required');
  });

  it('parses reliability defaults', () => {
    const config = loadConfig({ BOT_OWNER_ID: '919999999999@c.us', SQLITE_PATH: '/data/bot.db' });

    expect(config.maxDurationSeconds).toBeUndefined();
    expect(config.ytDlpCookiesPath).toBeUndefined();
    expect(config.ytDlpProxy).toBeUndefined();
    expect(config.concurrentDownloads).toBe(1);
  });

  it('parses reliability overrides', () => {
    const config = loadConfig({
      BOT_OWNER_ID: '919999999999@c.us',
      SQLITE_PATH: '/data/bot.db',
      MAX_DURATION_SECONDS: '120',
      YT_DLP_COOKIES_PATH: '/run/secrets/cookies.txt',
      YT_DLP_PROXY: 'socks5://127.0.0.1:9050',
      CONCURRENT_DOWNLOADS: '2',
    });

    expect(config.maxDurationSeconds).toBe(120);
    expect(config.ytDlpCookiesPath).toBe('/run/secrets/cookies.txt');
    expect(config.ytDlpProxy).toBe('socks5://127.0.0.1:9050');
    expect(config.concurrentDownloads).toBe(2);
  });
});
