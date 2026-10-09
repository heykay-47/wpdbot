import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { execa } from 'execa';
import { candidateMediaIdentity, isYouTubeVideoId } from './mediaIdentity.js';
import { prepareMedia } from './mediaPreparation.js';
import { userError } from './errorReporter.js';

export type DownloaderRunner = (file: string, args: string[], timeoutMs?: number) => Promise<{ stdout: string }>;

export type DownloaderResult = { filePath: string; sizeBytes: number; tempDir: string; deliveryMode?: 'video' | 'document' };
export type YouTubeVideo = { id: string; download(maxFileSizeMb: number): Promise<DownloaderResult> };

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
  maxMediaSizeMb?: number;
};

export type Downloader = {
  download(url: string, maxFileSizeMb: number): Promise<DownloaderResult>;
  resolveYouTube(url: string): Promise<YouTubeVideo>;
  resolveInstagram(url: string): Promise<InstagramSource>;
};

type DownloaderOptions = {
  downloadDir: string;
  runner?: DownloaderRunner;
  options?: DownloadOptions;
};

const defaultRunner: DownloaderRunner = async (file, args, timeoutMs = 300_000) => execa(file, args, { timeout: timeoutMs, forceKillAfterDelay: 1000 });
const videoFormat = 'bv*[ext=mp4][vcodec^=avc1][width<=?720][fps<=?30]+ba[acodec^=mp4a]/bv*[ext=mp4][vcodec^=avc1][height<=?720][fps<=?30]+ba[acodec^=mp4a]/b[ext=mp4][vcodec^=avc1][width<=?720][fps<=?30]/b[ext=mp4][vcodec^=avc1][height<=?720][fps<=?30]/bv*[width<=?720]+ba/bv*[height<=?720]+ba/best[width<=?720]/best[height<=?720]';

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
    throw userError(`Video exceeds ${options.maxDurationSeconds} seconds`, 'duration_limit');
  }
}

export function createDownloader({ downloadDir, runner = defaultRunner, options = {} }: DownloaderOptions): Downloader {
  return {
    async resolveYouTube(url) {
      // Docker's yt-dlp config supplies the existing PO-token provider endpoint.
      const args = appendSharedArgs(['--no-playlist', '--dump-single-json', '--skip-download'], options);
      args.push(url);
      const { stdout } = await runner('yt-dlp', args);
      const metadata: unknown = JSON.parse(stdout.trim());
      if (!isRecord(metadata) || !isYouTubeVideoId(metadata.id)) {
        throw new Error('YouTube video identity is unavailable');
      }
      const candidate = candidateMediaIdentity(url);
      if (metadata.extractor_key !== 'Youtube' || (metadata._type !== undefined && metadata._type !== 'video')
        || !hasVideoFormats(metadata) || (candidate?.platform === 'youtube' && candidate.videoId !== metadata.id)) {
        throw new Error('YouTube video identity or metadata is unresolved');
      }
      return {
        id: metadata.id,
        download: (maxFileSizeMb) => downloadResolvedVideo(metadata, maxFileSizeMb, downloadDir, runner, options, 'YouTube'),
      };
    },

    async resolveInstagram(url) {
      const args = appendSharedArgs(['--ignore-config', '--no-playlist', '--dump-single-json', '--skip-download', '--ignore-no-formats-error'], options);
      args.push(url);
      const { stdout } = await runner('yt-dlp', args);
      const metadata: unknown = JSON.parse(stdout.trim());
      if (!isRecord(metadata) || typeof metadata.id !== 'string' || !metadata.id.trim()) {
        throw new Error('Instagram post identity is unavailable');
      }
      if (metadata.extractor_key !== 'Instagram') throw new Error('Instagram extractor identity is unavailable');
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
          if ((entry.extractor_key !== undefined && entry.extractor_key !== 'Instagram')
            || (entry._type !== undefined && entry._type !== 'video')) return { id, index, kind: 'unknown' };
          if (!id || identities.get(id) !== 1 || !hasVideoFormats(entry)) return { id, index, kind: 'unknown' };

          return {
            id,
            index,
            kind: 'video',
            download: (maxFileSizeMb) => downloadResolvedVideo(entry, maxFileSizeMb, downloadDir, runner, options, 'Instagram'),
          };
        }),
      };
    },

    async download(url, maxFileSizeMb) {
      maxFileSizeMb = Math.min(maxFileSizeMb, options.maxMediaSizeMb ?? 64);
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
          throw userError(`Downloaded file exceeds ${maxFileSizeMb} MB`, 'size_limit');
        }

        const prepared = await prepareMedia(filePath, maxFileSizeMb, runner, options.maxDurationSeconds);
        return { ...prepared, tempDir };
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

function hasVideoFormats(metadata: Record<string, unknown>): boolean {
  const formats = Array.isArray(metadata.formats) ? metadata.formats.filter(isRecord) : [metadata];
  return formats.some((format) => typeof format.url === 'string' && format.vcodec !== 'none'
    && (typeof format.vcodec === 'string' || /^(mp4|webm|mov|mkv|m4v)$/u.test(String(format.ext))));
}

async function downloadResolvedVideo(metadata: Record<string, unknown>, maxFileSizeMb: number, downloadDir: string, runner: DownloaderRunner, options: DownloadOptions, platform: string): Promise<DownloaderResult> {
  maxFileSizeMb = Math.min(maxFileSizeMb, options.maxMediaSizeMb ?? 64);
  if (options.maxDurationSeconds && typeof metadata.duration === 'number' && metadata.duration > options.maxDurationSeconds) {
    throw userError(`Video exceeds ${options.maxDurationSeconds} seconds`, 'duration_limit');
  }
  await mkdir(downloadDir, { recursive: true });
  const tempDir = await mkdtemp(join(downloadDir, 'download-'));

  try {
    const infoPath = join(tempDir, 'source.info.json');
    const info: Record<string, unknown> = { ...metadata, _type: 'video' };
    // yt-dlp can re-extract webpage_url after a load-info-json download fails.
    // A collection entry URL can name the whole post; any re-extraction can change identity.
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
    if (paths.length !== 1) throw new Error(`Expected exactly one ${platform} video output`);
    const filePath = await realpath(paths[0]);
    const localPath = relative(await realpath(tempDir), filePath);
    if (!localPath || localPath.startsWith('..') || isAbsolute(localPath)) throw new Error(`${platform} output is outside its download directory`);
    const file = await stat(filePath);
    if (!file.isFile() || !file.size) throw new Error(`${platform} video output is empty or unavailable`);
    if (file.size > maxFileSizeMb * 1024 * 1024) throw userError(`Downloaded file exceeds ${maxFileSizeMb} MB`, 'size_limit');
    await rm(infoPath, { force: true });
    const prepared = await prepareMedia(filePath, maxFileSizeMb, runner, options.maxDurationSeconds);
    return { ...prepared, tempDir };
  } catch (error) {
    await rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
    throw error;
  }
}
