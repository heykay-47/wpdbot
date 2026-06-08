import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';

export type DownloaderRunner = (file: string, args: string[]) => Promise<{ stdout: string }>;

export type Downloader = {
  download(url: string, maxFileSizeMb: number): Promise<{ filePath: string; sizeBytes: number }>;
};

type DownloaderOptions = {
  downloadDir: string;
  runner?: DownloaderRunner;
};

const defaultRunner: DownloaderRunner = async (file, args) => execa(file, args);

export function createDownloader({ downloadDir, runner = defaultRunner }: DownloaderOptions): Downloader {
  return {
    async download(url, maxFileSizeMb) {
      await mkdir(downloadDir, { recursive: true });

      const { stdout } = await runner('yt-dlp', [
        '--no-playlist',
        '--format',
        'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best',
        '--merge-output-format',
        'mp4',
        '--output',
        join(downloadDir, '%(title)s.%(ext)s'),
        '--print',
        'after_move:filepath',
        url,
      ]);
      const filePath = stdout.trim().split(/\r?\n/).at(-1);
      if (!filePath) throw new Error('yt-dlp did not print downloaded file path');

      const { size } = await stat(filePath);
      if (size > maxFileSizeMb * 1024 * 1024) {
        throw new Error(`Downloaded file exceeds ${maxFileSizeMb} MB`);
      }

      return { filePath, sizeBytes: size };
    },
  };
}
