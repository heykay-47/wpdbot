import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDownloader, type DownloaderRunner } from '../src/downloader';
import { videoProbeJson } from './fixtures/media';

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
  it('applies the operator ceiling and probes a frozen video before returning it', async () => {
    const root = createTempDir();
    const calls: string[] = [];
    const runner: DownloaderRunner = async (file, args) => {
      calls.push(file);
      if (file === 'ffprobe') return { stdout: JSON.stringify({ format: { format_name: 'mp4', duration: '10', tags: { major_brand: 'isom' } }, streams: [
        { codec_type: 'video', codec_name: 'h264', width: 640, height: 360, pix_fmt: 'yuv420p', avg_frame_rate: '25/1' },
      ] }) };
      if (args.includes('--dump-single-json')) return { stdout: JSON.stringify({ id: 'AbCdEf123_-', extractor_key: 'Youtube', formats: [{ url: 'https://media.example/video.mp4', ext: 'mp4' }] }) };
      expect(args[args.indexOf('--max-filesize') + 1]).toBe('1M');
      const path = join(dirname(args[args.indexOf('--load-info-json') + 1]), 'video.mp4');
      writeFileSync(path, 'video');
      return { stdout: path };
    };
    const video = await createDownloader({ downloadDir: root, runner, options: { maxMediaSizeMb: 1 } }).resolveYouTube('https://youtube.com/shorts/AbCdEf123_-');
    expect(await video.download(128)).toMatchObject({ deliveryMode: 'video', sizeBytes: 5 });
    expect(calls).toEqual(['yt-dlp', 'yt-dlp', 'ffprobe']);
  });
  it('resolves a YouTube video identity and downloads that frozen video rather than re-extracting the source URL', async () => {
    const root = createTempDir();
    let infoPath = '';
    const runner: DownloaderRunner = async (_file, args) => {
      if (_file === 'ffprobe') return { stdout: videoProbeJson };
      if (args.includes('--dump-single-json')) {
        expect(args).not.toContain('--ignore-config');
        return { stdout: JSON.stringify({
          id: 'AbCdEf123_-', extractor_key: 'Youtube', webpage_url: 'https://www.youtube.com/watch?v=AbCdEf123_-',
          original_url: 'https://m.youtube.com/shorts/AbCdEf123_-',
          formats: [{ url: 'https://media.example/youtube.mp4', ext: 'mp4' }],
        }) };
      }
      infoPath = args[args.indexOf('--load-info-json') + 1];
      const info = JSON.parse(readFileSync(infoPath, 'utf8'));
      expect(info.id).toBe('AbCdEf123_-');
      expect(info).not.toHaveProperty('webpage_url');
      expect(info).not.toHaveProperty('original_url');
      expect(info.formats[0].url).toBe('https://media.example/youtube.mp4');
      const path = join(dirname(infoPath), 'AbCdEf123_-.mp4');
      writeFileSync(path, 'youtube-video');
      return { stdout: path };
    };

    const video = await createDownloader({ downloadDir: root, runner }).resolveYouTube('https://m.youtube.com/shorts/AbCdEf123_-');
    expect(video.id).toBe('AbCdEf123_-');
    const download = await video.download(1);
    expect(readFileSync(download.filePath, 'utf8')).toBe('youtube-video');
    expect(existsSync(infoPath)).toBe(false);
  });

  it.each([
    { id: 'AbCdEf123_-', formats: [{ url: 'https://media.example/video.mp4', ext: 'mp4' }] },
    { id: 'AbCdEf123_-', extractor_key: 'Instagram', formats: [{ url: 'https://media.example/video.mp4', ext: 'mp4' }] },
    { id: 'Another123_', extractor_key: 'Youtube', formats: [{ url: 'https://media.example/video.mp4', ext: 'mp4' }] },
    { id: 'AbCdEf123_-', extractor_key: 'Youtube', _type: 'playlist', entries: [] },
    { id: 'AbCdEf123_-', extractor_key: 'Youtube', formats: [] },
    { id: 'AbCdEf123_-', extractor_key: 'Youtube', formats: [{ url: 'https://media.example/audio.mp4', ext: 'mp4', vcodec: 'none' }] },
    { extractor_key: 'Youtube', formats: [{ url: 'https://media.example/video.mp4', ext: 'mp4' }] },
  ])('rejects unverified or mismatched YouTube identity metadata %#', async (metadata) => {
    const runner: DownloaderRunner = async () => ({ stdout: JSON.stringify(metadata) });
    await expect(createDownloader({ downloadDir: createTempDir(), runner }).resolveYouTube('https://youtube.com/shorts/AbCdEf123_-')).rejects.toThrow();
  });

  it.each([undefined, 'Youtube', 'Generic'])('does not assign Instagram identities to unverified extractor metadata %s', async (extractor) => {
    const runner: DownloaderRunner = async () => ({ stdout: JSON.stringify({
      id: 'post-1', extractor_key: extractor, formats: [{ url: 'https://media.example/video.mp4', ext: 'mp4' }],
    }) });
    await expect(createDownloader({ downloadDir: createTempDir(), runner }).resolveInstagram('https://m.instagram.com/p/example/')).rejects.toThrow();
  });

  it('does not identify foreign-platform or unresolved collection entries as Instagram videos', async () => {
    const runner: DownloaderRunner = async () => ({ stdout: JSON.stringify({
      id: 'post-1', extractor_key: 'Instagram', _type: 'playlist', entries: [
        { id: 'foreign', extractor_key: 'Youtube', formats: [{ url: 'https://media.example/foreign.mp4', ext: 'mp4' }] },
        { id: 'nested', _type: 'playlist', formats: [{ url: 'https://media.example/nested.mp4', ext: 'mp4' }] },
        { id: 'unresolved', _type: 'url', formats: [{ url: 'https://media.example/unresolved.mp4', ext: 'mp4' }] },
      ],
    }) });
    const source = await createDownloader({ downloadDir: createTempDir(), runner }).resolveInstagram('https://instagram.com/p/example/');
    expect(source.items.map((item) => item.kind)).toEqual(['unknown', 'unknown', 'unknown']);
  });

  it('resolves every Instagram video in post order instead of only the last output', async () => {
    const runner: DownloaderRunner = async () => ({ stdout: JSON.stringify({
      extractor_key: 'Instagram',
      _type: 'playlist',
      id: 'post-1',
      entries: [
        { id: 'video-1', formats: [{ url: 'https://media.example/one.mp4', ext: 'mp4' }] },
        { id: 'photo-2', formats: [] },
        { id: 'video-3', formats: [{ url: 'https://media.example/three.mp4', ext: 'mp4' }] },
      ],
    }) });

    const source = await createDownloader({ downloadDir: createTempDir(), runner }).resolveInstagram('https://www.instagram.com/p/example/');

    expect(source.id).toBe('post-1');
    expect(source.totalItems).toBe(3);
    expect(source.items.map(({ id, index, kind }) => ({ id, index, kind }))).toEqual([
      { id: 'video-1', index: 1, kind: 'video' },
      { id: 'photo-2', index: 2, kind: 'unknown' },
      { id: 'video-3', index: 3, kind: 'video' },
    ]);
  });

  it('honors img_index using the original collection position including photos', async () => {
    const runner: DownloaderRunner = async () => ({ stdout: JSON.stringify({
      extractor_key: 'Instagram',
      _type: 'playlist', id: 'post-1', entries: [
        { id: 'video-1', formats: [{ url: 'https://media.example/one.mp4', ext: 'mp4' }] },
        { id: 'photo-2', formats: [] },
        { id: 'video-3', formats: [{ url: 'https://media.example/three.mp4', ext: 'mp4' }] },
      ],
    }) });
    const source = await createDownloader({ downloadDir: createTempDir(), runner }).resolveInstagram('https://www.instagram.com/p/example/?img_index=3');

    expect(source.items.map(({ id, index }) => ({ id, index }))).toEqual([{ id: 'video-3', index: 3 }]);
    expect(source.totalItems).toBe(3);
  });

  it('does not shift a selected item when yt-dlp omits an unresolved earlier entry', async () => {
    const runner: DownloaderRunner = async () => ({ stdout: JSON.stringify({
      extractor_key: 'Instagram',
      _type: 'playlist', id: 'post-1', n_entries: 3, entries: [
        { id: 'video-1', playlist_index: 1, formats: [{ url: 'https://media.example/one.mp4', ext: 'mp4' }] },
        { id: 'video-3', playlist_index: 3, formats: [{ url: 'https://media.example/three.mp4', ext: 'mp4' }] },
      ],
    }) });
    const source = await createDownloader({ downloadDir: createTempDir(), runner }).resolveInstagram('https://www.instagram.com/p/example/?img_index=2');

    expect(source.totalItems).toBe(3);
    expect(source.items.map(({ index, kind }) => ({ index, kind }))).toEqual([{ index: 2, kind: 'unknown' }]);
  });

  it('rejects incomplete collections whose original item positions are unknown instead of selecting a different video', async () => {
    const runner: DownloaderRunner = async () => ({ stdout: JSON.stringify({
      extractor_key: 'Instagram',
      _type: 'playlist', id: 'post-1', n_entries: 3, entries: [
        { id: 'video-1', formats: [{ url: 'https://media.example/one.mp4', ext: 'mp4' }] },
        { id: 'video-3', formats: [{ url: 'https://media.example/three.mp4', ext: 'mp4' }] },
      ],
    }) });

    await expect(createDownloader({ downloadDir: createTempDir(), runner }).resolveInstagram('https://www.instagram.com/p/example/?img_index=2')).rejects.toThrow('positions are unresolved');
  });

  it('does not conflate different collection entries with the same extracted identity', async () => {
    const runner: DownloaderRunner = async () => ({ stdout: JSON.stringify({
      extractor_key: 'Instagram',
      _type: 'playlist', id: 'post-1', entries: [
        { id: 'same-id', formats: [{ url: 'https://media.example/one.mp4', ext: 'mp4' }] },
        { id: 'same-id', formats: [{ url: 'https://media.example/two.mp4', ext: 'mp4' }] },
      ],
    }) });
    const source = await createDownloader({ downloadDir: createTempDir(), runner }).resolveInstagram('https://www.instagram.com/p/example/');

    expect(source.items.map((item) => item.kind)).toEqual(['unknown', 'unknown']);
  });

  it('downloads the frozen selected entry without a parent-post URL fallback', async () => {
    const root = createTempDir();
    let infoPath = '';
    const runner: DownloaderRunner = async (_file, args) => {
      if (_file === 'ffprobe') return { stdout: videoProbeJson };
      if (args.includes('--dump-single-json')) return { stdout: JSON.stringify({
        extractor_key: 'Instagram', _type: 'playlist', id: 'post-1', entries: [
          { id: 'video-1', webpage_url: 'https://www.instagram.com/p/example/', formats: [{ url: 'https://media.example/one.mp4', ext: 'mp4' }] },
          { id: 'video-2', webpage_url: 'https://www.instagram.com/p/example/', formats: [{ url: 'https://media.example/two.mp4', ext: 'mp4' }] },
        ],
      }) };
      infoPath = args[args.indexOf('--load-info-json') + 1];
      const info = JSON.parse(readFileSync(infoPath, 'utf8'));
      expect(info.id).toBe('video-2');
      expect(info).not.toHaveProperty('webpage_url');
      expect(info.formats[0].url).toBe('https://media.example/two.mp4');
      const filePath = join(dirname(infoPath), 'video-2.mp4');
      writeFileSync(filePath, 'video');
      return { stdout: `${filePath}\n` };
    };
    const source = await createDownloader({ downloadDir: root, runner }).resolveInstagram('https://www.instagram.com/p/example/?img_index=2');
    const item = source.items[0];
    expect(item.kind).toBe('video');
    if (item.kind !== 'video') throw new Error('Expected a video');

    const result = await item.download(1);

    expect(result.sizeBytes).toBe(5);
    expect(existsSync(infoPath)).toBe(false);
  });

  it.each(['0', '-1', '1.5', 'bogus', '4', '1&img_index=3', '9007199254740992'])('rejects invalid Instagram selection %s without a fallback', async (selection) => {
    const runner: DownloaderRunner = async () => ({ stdout: JSON.stringify({
      extractor_key: 'Instagram',
      _type: 'playlist', id: 'post-1', entries: [{ id: 'video-1', formats: [{ url: 'https://media.example/video.mp4', ext: 'mp4' }] }],
    }) });
    await expect(createDownloader({ downloadDir: createTempDir(), runner }).resolveInstagram(`https://www.instagram.com/p/example/?img_index=${selection}`)).rejects.toThrow('selection');
  });

  it('preserves unknown, image-only, and missing-identity entries without treating audio as video', async () => {
    const runner: DownloaderRunner = async () => ({ stdout: JSON.stringify({
      extractor_key: 'Instagram',
      _type: 'playlist', id: 'post-1', entries: [
        null,
        { formats: [{ url: 'https://media.example/no-id.mp4', ext: 'mp4' }] },
        { id: 'photo', formats: [] },
        { id: 'audio', formats: [{ url: 'https://media.example/audio.mp4', ext: 'mp4', vcodec: 'none' }] },
      ],
    }) });
    const source = await createDownloader({ downloadDir: createTempDir(), runner }).resolveInstagram('https://www.instagram.com/p/example/');

    expect(source.items.map((item) => item.kind)).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
    expect(source.totalItems).toBe(4);
  });

  it.each(['oversize', 'multiple', 'empty', 'outside'])('rejects an unsafe individual Instagram output: %s', async (mode) => {
    const root = createTempDir();
    let outputDir = '';
    const outsidePath = join(root, 'keep.mp4');
    writeFileSync(outsidePath, 'keep');
    const runner: DownloaderRunner = async (_file, args) => {
      if (args.includes('--dump-single-json')) return { stdout: JSON.stringify({ extractor_key: 'Instagram', id: 'video-1', formats: [{ url: 'https://media.example/one.mp4', ext: 'mp4' }] }) };
      outputDir = dirname(args[args.indexOf('--load-info-json') + 1]);
      const filePath = join(outputDir, 'video.mp4');
      writeFileSync(filePath, mode === 'oversize' ? Buffer.alloc(2 * 1024 * 1024) : mode === 'empty' ? '' : 'video');
      return { stdout: mode === 'outside' ? outsidePath : mode === 'multiple' ? `${filePath}\n${filePath}` : filePath };
    };
    const source = await createDownloader({ downloadDir: root, runner }).resolveInstagram('https://www.instagram.com/p/example/');
    const item = source.items[0];
    if (item.kind !== 'video') throw new Error('Expected a video');

    await expect(item.download(1)).rejects.toThrow();

    expect(existsSync(outputDir)).toBe(false);
    expect(readFileSync(outsidePath, 'utf8')).toBe('keep');
  });

  it('checks the duration of each Instagram video before downloading that item', async () => {
    const calls: Parameters<DownloaderRunner>[] = [];
    const runner: DownloaderRunner = async (...args) => {
      if (args[0] === 'ffprobe') return { stdout: videoProbeJson };
      calls.push(args);
      return { stdout: JSON.stringify({ extractor_key: 'Instagram', _type: 'playlist', id: 'post-1', entries: [
        { id: 'long-video', duration: 121, formats: [{ url: 'https://media.example/long.mp4', ext: 'mp4' }] },
        { id: 'short-video', duration: 5, formats: [{ url: 'https://media.example/short.mp4', ext: 'mp4' }] },
      ] }) };
    };
    const source = await createDownloader({ downloadDir: createTempDir(), runner, options: { maxDurationSeconds: 120 } }).resolveInstagram('https://www.instagram.com/p/example/');
    const item = source.items[0];
    if (item.kind !== 'video') throw new Error('Expected a video');

    await expect(item.download(1)).rejects.toThrow('Video exceeds 120 seconds');
    expect(calls).toHaveLength(1);
  });

  it('downloads to the configured directory and returns file size when within limit', async () => {
    const downloadDir = join(createTempDir(), 'downloads');
    let filePath = '';
    const calls: Parameters<DownloaderRunner>[] = [];
    const runner: DownloaderRunner = async (...args) => {
      if (args[0] === 'ffprobe') return { stdout: videoProbeJson };
      calls.push(args);
      const outputTemplate = args[1][args[1].indexOf('--output') + 1];
      filePath = join(dirname(outputTemplate), 'video.mp4');
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, Buffer.alloc(1024));
      return { stdout: `intermediate output\n${filePath}\n` };
    };

    const result = await createDownloader({ downloadDir, runner }).download('https://www.youtube.com/shorts/example', 1);

    expect(result).toEqual({ filePath, sizeBytes: 1024, tempDir: dirname(filePath), deliveryMode: 'video' });
    expect(calls).toEqual([
      [
        'yt-dlp',
        [
          '--no-playlist',
          '--format',
          expect.stringContaining('[width<=?720]'),
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
      if (_file === 'ffprobe') return { stdout: videoProbeJson };
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

  it('passes cookies and proxy options when configured', async () => {
    const downloadDir = join(createTempDir(), 'downloads');
    const calls: Parameters<DownloaderRunner>[] = [];
    const runner: DownloaderRunner = async (...args) => {
      if (args[0] === 'ffprobe') return { stdout: videoProbeJson };
      calls.push(args);
      const outputTemplate = args[1][args[1].indexOf('--output') + 1];
      const filePath = join(dirname(outputTemplate), 'video.mp4');
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, Buffer.alloc(1024));
      return { stdout: `${filePath}\n` };
    };

    await createDownloader({
      downloadDir,
      runner,
      options: { cookiesPath: '/run/secrets/cookies.txt', proxy: 'socks5://127.0.0.1:9050' },
    }).download('https://www.youtube.com/shorts/example', 1);

    expect(calls[0][1]).toContain('--cookies');
    expect(calls[0][1]).toContain('/run/secrets/cookies.txt');
    expect(calls[0][1]).toContain('--proxy');
    expect(calls[0][1]).toContain('socks5://127.0.0.1:9050');
  });

  it('rejects media when metadata duration exceeds max duration', async () => {
    const downloadDir = join(createTempDir(), 'downloads');
    const runner: DownloaderRunner = async (_file, args) => {
      if (args.includes('--dump-json')) return { stdout: '{"duration":121}\n' };
      throw new Error('download should not start');
    };

    await expect(
      createDownloader({ downloadDir, runner, options: { maxDurationSeconds: 120 } }).download(
        'https://www.youtube.com/shorts/example',
        1,
      ),
    ).rejects.toThrow('Video exceeds 120 seconds');
  });
});
