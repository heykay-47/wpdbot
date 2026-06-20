import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';

export type DownloaderRunner = (file: string, args: string[]) => Promise<{ stdout: string }>;

export type DownloaderResult = { filePath: string; sizeBytes: number; tempDir: string };

export type DownloadOptions = {
  cookiesPath?: string;
  proxy?: string;
  maxDurationSeconds?: number;
};

export type Downloader = {
  download(url: string, maxFileSizeMb: number): Promise<DownloaderResult>;
};

type DownloaderOptions = {
  downloadDir: string;
  runner?: DownloaderRunner;
  options?: DownloadOptions;
};

const defaultRunner: DownloaderRunner = async (file, args) => execa(file, args);

function appendSharedArgs(args: string[], options: DownloadOptions): string[] {
  if (options.cookiesPath) args.push('--cookies', options.cookiesPath);
  if (options.proxy) args.push('--proxy', options.proxy);
  return args;
}

async function assertDurationAllowed(runner: DownloaderRunner, url: string, options: DownloadOptions): Promise<void> {
  if (!options.maxDurationSeconds) return;

  const args = appendSharedArgs(['--no-playlist', '--dump-json'], options);
  args.push(url);
  const { stdout } = await runner('yt-dlp', args);
  const metadata = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) || '{}') as { duration?: number };
  if (typeof metadata.duration === 'number' && metadata.duration > options.maxDurationSeconds) {
    throw new Error(`Video exceeds ${options.maxDurationSeconds} seconds`);
  }
}

export function createDownloader({ downloadDir, runner = defaultRunner, options = {} }: DownloaderOptions): Downloader {
  return {
    async download(url, maxFileSizeMb) {
      await assertDurationAllowed(runner, url, options);
      await mkdir(downloadDir, { recursive: true });
      const tempDir = await mkdtemp(join(downloadDir, 'download-'));

      try {
        const args = appendSharedArgs([
          '--no-playlist',
          '--format',
          'bv*[ext=mp4][vcodec^=avc1][height<=1280]+ba[ext=m4a]/b[ext=mp4][vcodec^=avc1][height<=1280]/bv*[ext=mp4][height<=1280]+ba[ext=m4a]/b[ext=mp4][height<=1280]/best[height<=1280]/best',
          '--merge-output-format',
          'mp4',
          '--max-filesize',
          `${maxFileSizeMb}M`,
          '--output',
          join(tempDir, '%(title)s.%(ext)s'),
          '--print',
          'after_move:filepath',
        ], options);
        args.push(url);
        const { stdout } = await runner('yt-dlp', args);
        const filePath = stdout.trim().split(/\r?\n/).at(-1);
        if (!filePath) throw new Error('yt-dlp did not print downloaded file path');

        const { size } = await stat(filePath);
        if (size > maxFileSizeMb * 1024 * 1024) {
          await rm(filePath, { force: true }).catch(() => undefined);
          throw new Error(`Downloaded file exceeds ${maxFileSizeMb} MB`);
        }

        return { filePath, sizeBytes: size, tempDir };
      } catch (error) {
        await rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
        throw error;
      }
    },
  };
}
