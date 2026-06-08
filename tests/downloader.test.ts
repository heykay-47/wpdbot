import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDownloader, type DownloaderRunner } from '../src/downloader';

let tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wpdbot-downloader-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

describe('createDownloader', () => {
  it('downloads to the configured directory and returns file size when within limit', async () => {
    const downloadDir = join(createTempDir(), 'downloads');
    const filePath = join(downloadDir, 'video.mp4');
    const calls: Parameters<DownloaderRunner>[] = [];
    const runner: DownloaderRunner = async (...args) => {
      calls.push(args);
      mkdirSync(downloadDir, { recursive: true });
      writeFileSync(filePath, Buffer.alloc(1024));
      return { stdout: `intermediate output\n${filePath}\n` };
    };

    const result = await createDownloader({ downloadDir, runner }).download('https://youtu.be/example', 1);

    expect(result).toEqual({ filePath, sizeBytes: 1024 });
    expect(calls).toEqual([
      [
        'yt-dlp',
        [
          '--no-playlist',
          '--format',
          'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best',
          '--merge-output-format',
          'mp4',
          '--output',
          join(downloadDir, '%(title)s.%(ext)s'),
          '--print',
          'after_move:filepath',
          'https://youtu.be/example',
        ],
      ],
    ]);
  });

  it('rejects downloaded files larger than the configured limit', async () => {
    const downloadDir = join(createTempDir(), 'downloads');
    const filePath = join(downloadDir, 'large.mp4');
    const runner: DownloaderRunner = async () => {
      mkdirSync(downloadDir, { recursive: true });
      writeFileSync(filePath, Buffer.alloc(2 * 1024 * 1024));
      return { stdout: `${filePath}\n` };
    };

    await expect(createDownloader({ downloadDir, runner }).download('https://youtu.be/example', 1)).rejects.toThrow(
      'Downloaded file exceeds 1 MB',
    );
  });
});
