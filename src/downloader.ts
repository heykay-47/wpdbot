import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { execa } from 'execa';

export type DownloaderRunner = (file: string, args: string[]) => Promise<{ stdout: string }>;

export type DownloaderResult = { filePath: string; sizeBytes: number; tempDir: string };

export type InstagramItem = {
  id: string;
  index: number;
  kind: 'video';
  download(maxFileSizeMb: number): Promise<DownloaderResult>;
} | {
  id?: string;
  index: number;
  kind: 'image' | 'unknown';
};

export type InstagramSource = { id: string; totalItems: number; items: InstagramItem[] };

export type DownloadOptions = {
  cookiesPath?: string;
  proxy?: string;
  maxDurationSeconds?: number;
};

export type Downloader = {
  download(url: string, maxFileSizeMb: number): Promise<DownloaderResult>;
  resolveInstagram(url: string): Promise<InstagramSource>;
};

type DownloaderOptions = {
  downloadDir: string;
  runner?: DownloaderRunner;
  options?: DownloadOptions;
};

const defaultRunner: DownloaderRunner = async (file, args) => execa(file, args);
const videoFormat = 'bv*[ext=mp4][vcodec^=avc1][height<=1280]+ba[ext=m4a]/b[ext=mp4][vcodec^=avc1][height<=1280]/bv*[ext=mp4][height<=1280]+ba[ext=m4a]/b[ext=mp4][height<=1280]/best[height<=1280]/best';

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
    async resolveInstagram(url) {
      const args = appendSharedArgs(['--ignore-config', '--no-playlist', '--dump-single-json', '--skip-download', '--ignore-no-formats-error'], options);
      args.push(url);
      const { stdout } = await runner('yt-dlp', args);
      const metadata: unknown = JSON.parse(stdout.trim());
      if (!isRecord(metadata) || typeof metadata.id !== 'string' || !metadata.id.trim()) {
        throw new Error('Instagram post identity is unavailable');
      }
      if (metadata._type !== undefined && metadata._type !== 'video' && metadata._type !== 'playlist') {
        throw new Error('Instagram media metadata is unresolved');
      }
      const entries = metadata._type === 'playlist' ? metadata.entries : [metadata];
      if (!Array.isArray(entries) || !entries.length) throw new Error('Instagram media entries are unavailable');
      const indexedEntries = new Map<number, unknown>();
      const identities = new Map<string, number>();
      for (const [position, entry] of entries.entries()) {
        const index = isRecord(entry) && entry.playlist_index !== undefined ? entry.playlist_index : position + 1;
        if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 1 || indexedEntries.has(index)) {
          throw new Error('Instagram item positions are unresolved');
        }
        indexedEntries.set(index, entry);
        if (isRecord(entry) && typeof entry.id === 'string') identities.set(entry.id, (identities.get(entry.id) ?? 0) + 1);
      }
      const highestIndex = [...indexedEntries.keys()].reduce((highest, index) => Math.max(highest, index), entries.length);
      const totalItems = metadata.n_entries ?? metadata.playlist_count ?? highestIndex;
      if (typeof totalItems !== 'number' || !Number.isSafeInteger(totalItems) || totalItems < highestIndex) {
        throw new Error('Instagram collection size is unresolved');
      }
      if (totalItems > entries.length && entries.some((entry: unknown) => isRecord(entry) && entry.playlist_index === undefined)) {
        throw new Error('Instagram item positions are unresolved');
      }
      if (indexedEntries.size < totalItems) {
        let firstMissing = 1;
        while (indexedEntries.has(firstMissing)) firstMissing += 1;
        indexedEntries.set(firstMissing, null);
      }
      const selections = new URL(url).searchParams.getAll('img_index');
      let selectedIndex: number | undefined;
      if (selections.length) {
        selectedIndex = Number(selections[0]);
        if (selections.length !== 1 || !/^[1-9]\d*$/u.test(selections[0]) || !Number.isSafeInteger(selectedIndex) || selectedIndex > totalItems) {
          throw new Error('Instagram item selection is invalid or unavailable');
        }
      }

      return {
        id: metadata.id,
        totalItems,
        items: (selectedIndex === undefined
          ? [...indexedEntries.entries()].sort(([left], [right]) => left - right)
          : [[selectedIndex, indexedEntries.get(selectedIndex)] as const]).map(([index, entry]): InstagramItem => {
          if (!isRecord(entry)) return { index, kind: 'unknown' };
          const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id : undefined;
          const formats = Array.isArray(entry.formats) ? entry.formats.filter(isRecord) : [entry];
          const hasVideo = formats.some((format) => typeof format.url === 'string' && format.vcodec !== 'none'
            && (typeof format.vcodec === 'string' || /^(mp4|webm|mov|mkv|m4v)$/u.test(String(format.ext))));
          if (!id || identities.get(id) !== 1 || !hasVideo) return { id, index, kind: 'unknown' };

          return {
            id,
            index,
            kind: 'video',
            download: (maxFileSizeMb) => downloadInstagramItem(entry, maxFileSizeMb, downloadDir, runner, options),
          };
        }),
      };
    },

    async download(url, maxFileSizeMb) {
      await assertDurationAllowed(runner, url, options);
      await mkdir(downloadDir, { recursive: true });
      const tempDir = await mkdtemp(join(downloadDir, 'download-'));

      try {
        const args = appendSharedArgs([
          '--no-playlist',
          '--format',
          videoFormat,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function downloadInstagramItem(metadata: Record<string, unknown>, maxFileSizeMb: number, downloadDir: string, runner: DownloaderRunner, options: DownloadOptions): Promise<DownloaderResult> {
  if (options.maxDurationSeconds && typeof metadata.duration === 'number' && metadata.duration > options.maxDurationSeconds) {
    throw new Error(`Video exceeds ${options.maxDurationSeconds} seconds`);
  }
  await mkdir(downloadDir, { recursive: true });
  const tempDir = await mkdtemp(join(downloadDir, 'download-'));

  try {
    const infoPath = join(tempDir, 'source.info.json');
    const info: Record<string, unknown> = { ...metadata, _type: 'video' };
    // yt-dlp can re-extract webpage_url after a load-info-json download fails.
    // For a collection entry that URL can name the whole parent post.
    delete info.webpage_url;
    delete info.original_url;
    await writeFile(infoPath, JSON.stringify(info), { mode: 0o600 });
    const args = appendSharedArgs([
      '--ignore-config', '--no-playlist', '--load-info-json', infoPath,
      '--format', videoFormat, '--merge-output-format', 'mp4', '--max-filesize', `${maxFileSizeMb}M`,
      '--output', join(tempDir, '%(id)s.%(ext)s'), '--print', 'after_move:filepath',
    ], options);
    const { stdout } = await runner('yt-dlp', args);
    const paths = stdout.trim().split(/\r?\n/).filter(Boolean);
    if (paths.length !== 1) throw new Error('Expected exactly one Instagram video output');
    const filePath = await realpath(paths[0]);
    const localPath = relative(await realpath(tempDir), filePath);
    if (!localPath || localPath.startsWith('..') || isAbsolute(localPath)) throw new Error('Instagram output is outside its download directory');
    const file = await stat(filePath);
    if (!file.isFile() || !file.size) throw new Error('Instagram video output is empty or unavailable');
    if (file.size > maxFileSizeMb * 1024 * 1024) throw new Error(`Downloaded file exceeds ${maxFileSizeMb} MB`);
    await rm(infoPath, { force: true });
    return { filePath, sizeBytes: file.size, tempDir };
  } catch (error) {
    await rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
    throw error;
  }
}
