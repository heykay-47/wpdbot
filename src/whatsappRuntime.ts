import { access, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

export type WhatsappRuntimePaths = {
  authDir: string;
  cacheDir: string;
  chromeProfileDir: string;
  chromeCacheDir: string;
};

export type WhatsappRuntimePathInput = Partial<WhatsappRuntimePaths>;

const chromiumLockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'] as const;

export function resolveWhatsappRuntimePaths(paths: WhatsappRuntimePathInput = {}): WhatsappRuntimePaths {
  const authEnv = process.env.WHATSAPP_AUTH_DIR?.trim();
  const cacheEnv = process.env.WHATSAPP_CACHE_DIR?.trim();
  const authDir = paths.authDir ?? (authEnv || '.wwebjs_auth');
  const cacheDir = paths.cacheDir ?? (cacheEnv || '.wwebjs_cache');

  return {
    authDir,
    cacheDir,
    chromeProfileDir: paths.chromeProfileDir ?? join(authDir, 'session'),
    chromeCacheDir: paths.chromeCacheDir ?? join(cacheDir, 'chrome-cache'),
  };
}

export async function prepareWhatsappRuntime(input: WhatsappRuntimePathInput = {}): Promise<WhatsappRuntimePaths> {
  const paths = resolveWhatsappRuntimePaths(input);
  await Promise.all([mkdir(paths.authDir, { recursive: true }), mkdir(paths.cacheDir, { recursive: true })]);
  await Promise.all([mkdir(paths.chromeProfileDir, { recursive: true }), mkdir(paths.chromeCacheDir, { recursive: true })]);

  const removed = await removeChromiumLocks([paths.chromeProfileDir, paths.chromeCacheDir]);
  if (removed.length > 0) console.log(`Removed stale Chromium profile locks: ${removed.join(', ')}`);

  return paths;
}

async function removeChromiumLocks(directories: string[]): Promise<string[]> {
  const removed: string[] = [];
  const uniqueDirectories = [...new Set(directories)];

  for (const directory of uniqueDirectories) {
    for (const lockFile of chromiumLockFiles) {
      const filePath = join(directory, lockFile);
      if (!(await exists(filePath))) continue;

      await rm(filePath, { force: true });
      removed.push(lockFile);
    }
  }

  return removed;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
