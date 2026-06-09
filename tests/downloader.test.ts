import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
    let filePath = '';
    const calls: Parameters<DownloaderRunner>[] = [];
    const runner: DownloaderRunner = async (...args) => {
      calls.push(args);
      const outputTemplate = args[1][args[1].indexOf('--output') + 1];
      filePath = join(dirname(outputTemplate), 'video.mp4');
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, Buffer.alloc(1024));
      return { stdout: `intermediate output\n${filePath}\n` };
    };

    const result = await createDownloader({ downloadDir, runner }).download('https://www.youtube.com/shorts/example', 1);

    expect(result).toEqual({ filePath, sizeBytes: 1024 });
    expect(calls).toEqual([
      [
        'yt-dlp',
        [
          '--no-playlist',
          '--format',
          'bv*[ext=mp4][vcodec^=avc1][height<=1280]+ba[ext=m4a]/b[ext=mp4][vcodec^=avc1][height<=1280]/bv*[ext=mp4][height<=1280]+ba[ext=m4a]/b[ext=mp4][height<=1280]/best[height<=1280]/best',
          '--merge-output-format',
          'mp4',
          '--max-filesize',
          '1M',
          '--output',
          join(dirname(filePath), '%(title)s.%(ext)s'),
          '--print',
          'after_move:filepath',
          'https://www.youtube.com/shorts/example',
        ],
      ],
    ]);
    expect(dirname(filePath)).not.toBe(downloadDir);
  });

  it('uses a unique output directory for each download', async () => {
    const downloadDir = join(createTempDir(), 'downloads');
    const outputDirs: string[] = [];
    const runner: DownloaderRunner = async (_file, args) => {
      const outputTemplate = args[args.indexOf('--output') + 1];
      const outputDir = dirname(outputTemplate);
      const filePath = join(outputDir, 'video.mp4');
      outputDirs.push(outputDir);
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(filePath, Buffer.alloc(1024));
      return { stdout: `${filePath}\n` };
    };
    const downloader = createDownloader({ downloadDir, runner });

    await downloader.download('https://www.youtube.com/shorts/one', 1);
    await downloader.download('https://www.youtube.com/shorts/two', 1);

    expect(outputDirs).toHaveLength(2);
    expect(outputDirs[0]).not.toBe(outputDirs[1]);
    expect(outputDirs[0]).toContain(downloadDir);
    expect(outputDirs[1]).toContain(downloadDir);
  });

  it('rejects downloaded files larger than the configured limit', async () => {
    const downloadDir = join(createTempDir(), 'downloads');
    let filePath = '';
    let downloadSubdir = '';
    const runner: DownloaderRunner = async (_file, args) => {
      const outputTemplate = args[args.indexOf('--output') + 1];
      downloadSubdir = dirname(outputTemplate);
      filePath = join(downloadSubdir, 'large.mp4');
      mkdirSync(downloadSubdir, { recursive: true });
      writeFileSync(filePath, Buffer.alloc(2 * 1024 * 1024));
      return { stdout: `${filePath}\n` };
    };

    await expect(createDownloader({ downloadDir, runner }).download('https://www.youtube.com/shorts/example', 1)).rejects.toThrow(
      'Downloaded file exceeds 1 MB',
    );
    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(downloadSubdir)).toBe(false);
  });

  it('removes the download directory when the runner rejects', async () => {
    const downloadDir = join(createTempDir(), 'downloads');
    let downloadSubdir = '';
    const runner: DownloaderRunner = async (_file, args) => {
      const outputTemplate = args[args.indexOf('--output') + 1];
      downloadSubdir = dirname(outputTemplate);
      mkdirSync(downloadSubdir, { recursive: true });
      throw new Error('yt-dlp failed');
    };

    await expect(createDownloader({ downloadDir, runner }).download('https://www.youtube.com/shorts/example', 1)).rejects.toThrow(
      'yt-dlp failed',
    );
    expect(existsSync(downloadSubdir)).toBe(false);
  });

  it('removes the download directory when yt-dlp prints no file path', async () => {
    const downloadDir = join(createTempDir(), 'downloads');
    let downloadSubdir = '';
    const runner: DownloaderRunner = async (_file, args) => {
      const outputTemplate = args[args.indexOf('--output') + 1];
      downloadSubdir = dirname(outputTemplate);
      mkdirSync(downloadSubdir, { recursive: true });
      return { stdout: '\n' };
    };

    await expect(createDownloader({ downloadDir, runner }).download('https://www.youtube.com/shorts/example', 1)).rejects.toThrow(
      'yt-dlp did not print downloaded file path',
    );
    expect(existsSync(downloadSubdir)).toBe(false);
  });

  it('removes the download directory when the printed file path is missing', async () => {
    const downloadDir = join(createTempDir(), 'downloads');
    let downloadSubdir = '';
    const runner: DownloaderRunner = async (_file, args) => {
      const outputTemplate = args[args.indexOf('--output') + 1];
      downloadSubdir = dirname(outputTemplate);
      mkdirSync(downloadSubdir, { recursive: true });
      return { stdout: `${join(downloadSubdir, 'missing.mp4')}\n` };
    };

    await expect(createDownloader({ downloadDir, runner }).download('https://www.youtube.com/shorts/example', 1)).rejects.toThrow();
    expect(existsSync(downloadSubdir)).toBe(false);
  });
});
