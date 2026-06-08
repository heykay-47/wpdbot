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
});
