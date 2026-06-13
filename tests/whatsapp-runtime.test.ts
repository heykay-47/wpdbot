import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareWhatsappRuntime, resolveWhatsappRuntimePaths } from '../src/whatsappRuntime';

const tempDirs: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wpdbot-runtime-'));
  tempDirs.push(root);
  return root;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
  tempDirs.length = 0;
  vi.restoreAllMocks();
});

describe('resolveWhatsappRuntimePaths', () => {
  it('derives Chrome profile and cache paths from auth and cache roots', () => {
    const paths = resolveWhatsappRuntimePaths({ authDir: '/auth', cacheDir: '/cache' });

    expect(paths).toEqual({
      authDir: '/auth',
      cacheDir: '/cache',
      chromeProfileDir: '/auth/session',
      chromeCacheDir: '/cache/chrome-cache',
    });
  });
});

describe('prepareWhatsappRuntime', () => {
  it('creates runtime directories and removes only Chromium singleton lock files', async () => {
    const root = tempRoot();
    const authDir = join(root, 'auth');
    const cacheDir = join(root, 'cache');
    const paths = resolveWhatsappRuntimePaths({ authDir, cacheDir });

    rmSync(paths.chromeProfileDir, { force: true, recursive: true });
    rmSync(paths.chromeCacheDir, { force: true, recursive: true });

    await prepareWhatsappRuntime(paths);
    writeFileSync(join(paths.chromeProfileDir, 'SingletonLock'), 'lock');
    writeFileSync(join(paths.chromeProfileDir, 'SingletonSocket'), 'socket');
    writeFileSync(join(paths.chromeProfileDir, 'SingletonCookie'), 'cookie');
    writeFileSync(join(paths.chromeProfileDir, 'Default'), 'profile-data');
    writeFileSync(join(paths.chromeCacheDir, 'CacheData'), 'cache-data');

    await prepareWhatsappRuntime(paths);

    expect(existsSync(paths.authDir)).toBe(true);
    expect(existsSync(paths.cacheDir)).toBe(true);
    expect(existsSync(paths.chromeProfileDir)).toBe(true);
    expect(existsSync(paths.chromeCacheDir)).toBe(true);
    expect(existsSync(join(paths.chromeProfileDir, 'SingletonLock'))).toBe(false);
    expect(existsSync(join(paths.chromeProfileDir, 'SingletonSocket'))).toBe(false);
    expect(existsSync(join(paths.chromeProfileDir, 'SingletonCookie'))).toBe(false);
    expect(existsSync(join(paths.chromeProfileDir, 'Default'))).toBe(true);
    expect(existsSync(join(paths.chromeCacheDir, 'CacheData'))).toBe(true);
  });

  it('does not recursively remove profile content or sibling files', async () => {
    const root = tempRoot();
    const paths = resolveWhatsappRuntimePaths({ authDir: join(root, 'auth'), cacheDir: join(root, 'cache') });
    const sibling = join(paths.authDir, 'session-backup');

    await prepareWhatsappRuntime(paths);
    writeFileSync(join(paths.chromeProfileDir, 'SingletonLock'), 'lock');
    writeFileSync(join(paths.chromeProfileDir, 'Preferences'), '{}');
    writeFileSync(sibling, 'keep');

    await prepareWhatsappRuntime(paths);

    expect(existsSync(join(paths.chromeProfileDir, 'SingletonLock'))).toBe(false);
    expect(existsSync(join(paths.chromeProfileDir, 'Preferences'))).toBe(true);
    expect(existsSync(sibling)).toBe(true);
  });

  it('logs removed lock files without logging profile contents', async () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const root = tempRoot();
    const paths = resolveWhatsappRuntimePaths({ authDir: join(root, 'auth'), cacheDir: join(root, 'cache') });

    await prepareWhatsappRuntime(paths);
    writeFileSync(join(paths.chromeProfileDir, 'SingletonLock'), 'lock');

    await prepareWhatsappRuntime(paths);

    expect(info).toHaveBeenCalledWith('Removed stale Chromium profile locks: SingletonLock');
  });
});
