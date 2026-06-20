import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TempFileTracker } from '../src/tempFileTracker';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots) await rm(root, { force: true, recursive: true });
  roots.length = 0;
});

describe('TempFileTracker', () => {
  it('cleans registered files and directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wpdbot-tracker-'));
    roots.push(root);
    const file = join(root, 'video.whatsapp.mp4');
    const directory = join(root, 'download-abc');
    writeFileSync(file, 'video');
    mkdirSync(directory);
    writeFileSync(join(directory, 'video.mp4'), 'video');

    const tracker = new TempFileTracker();
    tracker.addFile(file);
    tracker.addDirectory(directory);
    await tracker.cleanup();

    expect(existsSync(file)).toBe(false);
    expect(existsSync(directory)).toBe(false);
  });

  it('tolerates missing paths', async () => {
    const tracker = new TempFileTracker();
    tracker.addFile('/tmp/wpdbot-missing-file');
    tracker.addDirectory('/tmp/wpdbot-missing-dir');

    await expect(tracker.cleanup()).resolves.toBeUndefined();
  });
});
